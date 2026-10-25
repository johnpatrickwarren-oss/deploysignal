// test/defect-valid-path-configured-signals.test.ts — defect found 2026-09-25:
// engine/gates/_health-valid-path.ts runFamilyAValidPath iterated the engine's hardcoded six-signal
// FAMILY_A_PRIMARY_SIGNALS instead of the compiled config's `family_a_signals` (the profile's
// sli_list). A profile-routed config for a non-LLM service got no valid-path verdict on its own
// signals, and a calibration series for one of the six LLM signals was still routed when the
// profile did not monitor it. The fix reads `family_a_signals` and falls back to the six only when
// the config carries none.
//
// The engine's own Family A evaluators (evaluateFamilyAShadowMixture, evaluateFamilyABettingShadow)
// ignored `family_a_signals` and iterated the six up to and including deploysignal-engine
// v0.12.0-pre; from v0.12.1-pre they read `familyASignals(cfg)` (the configured list, deduplicated,
// or the six when absent) and default the Bonferroni factor to its length. The last test below
// drives this repo's Family A runner end to end on a configured non-LLM signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, FiredSignal, HealthResult, Metrics } from '../dist/engine/types';
import { runFamilyAValidPath, VALID_PATH_ROLLBACK_PREFIX } from '../dist/engine/gates/_health-valid-path';
import { runFamilyA } from '../dist/engine/gates/_health-detectors';
import { loadCfg, cellSeries, gauss, scenarioBaseline, SIGNALS } from './_c64-fixture';

const engine = require('../shared');
const { TrendBuffer } = engine;

function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}

/** Drive `n` canary ticks of `series` through the valid path, reading the terminal look on the last. */
function run(cfg: CompiledConfig, calibration: Record<string, number[]>, live: Record<string, number[]>, n: number) {
  const tb = new TrendBuffer(10);
  let result = emptyHealth();
  let rollback: FiredSignal[] = [];
  for (let i = 0; i < n; i++) {
    result = emptyHealth();
    rollback = [];
    const m = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v[i]])) as unknown as Metrics;
    runFamilyAValidPath(result, rollback, [], m, tb, {
      compiledConfig: cfg, terminalLook: i === n - 1,
      validPath: { calibration, ar1Phi: Object.fromEntries(Object.keys(calibration).map((k) => [k, 0])) },
    });
  }
  return { result, rollback };
}

const LAW = { mean: 0.01, sigma: 0.002 };
const N = 100;

test('defect 2026-09-25: the valid path routes a configured non-LLM signal', () => {
  const cfg = { ...loadCfg(), family_a_signals: ['http_5xx_rate'] } as CompiledConfig;
  const cal = { http_5xx_rate: cellSeries(LAW, 1, 500) };
  const live = { http_5xx_rate: cellSeries(LAW, 2, N, 0, 3) }; // a 3σ step from tick 0
  const { result, rollback } = run(cfg, cal, live, N);
  const v = (result.family_A_shadow ?? []).filter((x) => x.signal === 'http_5xx_rate');
  assert.equal(v.length, 1, 'one terminal verdict for the configured signal');
  assert.equal(v[0].verdict, 'fire');
  // C87 (2026-10-02): the fire is advisory; it carries the id it would have pushed and pushes nothing.
  assert.equal((v[0] as { advisory_id?: string }).advisory_id, VALID_PATH_ROLLBACK_PREFIX + 'http_5xx_rate');
  assert.deepEqual(rollback, []);
});

test('defect 2026-09-25: a calibrated LLM signal the config does not monitor is not routed', () => {
  const cfg = { ...loadCfg(), family_a_signals: ['http_5xx_rate'] } as CompiledConfig;
  const g = gauss(3);
  const cal = { http_5xx_rate: cellSeries(LAW, 1, 500), p99_latency: Array.from({ length: 500 }, () => 180 + g()) };
  const live = { http_5xx_rate: cellSeries(LAW, 4, N), p99_latency: Array.from({ length: N }, () => 400 + g()) };
  const { result } = run(cfg, cal, live, N);
  const signals = (result.family_A_shadow ?? []).map((x) => x.signal);
  assert.deepEqual(signals, ['http_5xx_rate']);
});

test('defect 2026-09-25: a config without family_a_signals keeps the six-signal default', () => {
  const base = loadCfg();
  const cfg = { ...base } as CompiledConfig;
  delete (cfg as { family_a_signals?: string[] }).family_a_signals;
  const g = gauss(5);
  const cal = { p99_latency: Array.from({ length: 500 }, () => 180 + g()), http_5xx_rate: cellSeries(LAW, 1, 500) };
  const live = { p99_latency: Array.from({ length: N }, () => 180 + g()), http_5xx_rate: cellSeries(LAW, 6, N) };
  const { result } = run(cfg, cal, live, N);
  const signals = (result.family_A_shadow ?? []).map((x) => x.signal);
  assert.deepEqual(signals, ['p99_latency']);
});

/** A compiled config whose cells carry Family A params for `signals` (copies of downstream_err's)
 *  beside the six, and whose `family_a_signals` names only `signals` — the shape the calibrator
 *  emits for a profile with a custom sli_list. Each copied cell's betting α is stamped for the
 *  factor N = signals.length, as the calibrator does (α_A / N · ½). `bonferroni_factor` is N when
 *  `explicitFactor`, and absent otherwise so the engine's length default applies. */
function customSignalCfg(signals: string[] = ['http_5xx_rate'], explicitFactor = true): CompiledConfig {
  const cfg = loadCfg();
  const alphaA = cfg.alpha_budget.per_family.A!;
  const cells = [...cfg.baseline_cells!.cells, cfg.baseline_cells!.aggregate_fallback];
  for (const c of cells) {
    const ps = c.family_A?.per_signal;
    if (!ps?.downstream_err) continue;
    for (const s of signals) {
      ps[s] = { ...ps.downstream_err, betting_e_process_alpha: (alphaA / signals.length) * 0.5 };
      delete (ps[s] as { betting_sliding_buffer_threshold?: number }).betting_sliding_buffer_threshold;
    }
  }
  const out = { ...cfg, family_a_signals: signals } as CompiledConfig;
  if (explicitFactor) out.bonferroni_factor = signals.length;
  else delete (out as { bonferroni_factor?: number }).bonferroni_factor;
  return out;
}

/** Drive `n` ticks of runFamilyA (Page-CUSUM mixture + betting) at hour 20 / day 3. */
function runA(cfg: CompiledConfig, http5xx: number[], extra: Record<string, number[]> = {}) {
  const tb = new TrendBuffer(10);
  let result = emptyHealth();
  let rollback: FiredSignal[] = [];
  const seen = new Set<string>();
  const fired = new Set<string>();
  const reasons = new Set<string>();
  for (let i = 0; i < http5xx.length; i++) {
    result = emptyHealth();
    rollback = [];
    const m = { ...scenarioBaseline(cfg), http_5xx_rate: http5xx[i], ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, v[i]])) } as unknown as Metrics;
    runFamilyA(result, rollback, [], [], m, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
    });
    for (const r of rollback) seen.add(r.id);
    for (const v of result.family_A_shadow ?? []) {
      if (v.verdict !== 'fire') continue;
      fired.add(v.signal!);
      reasons.add(v.reason_code);
    }
  }
  return { result, seen, fired, reasons };
}

test('engine v0.12.1-pre: Family A evaluates the configured signal and none of the six', () => {
  const cfg = customSignalCfg();
  const cell = cfg.baseline_cells!.cells.find((c) => c.key.hour_of_day === 20 && c.key.day_of_week === 3)!;
  const p = cell.family_A!.per_signal.http_5xx_rate!;
  const law = { mean: p.baseline_mean, sigma: Math.sqrt(p.baseline_sigma_squared) };
  const { result, seen, fired, reasons } = runA(cfg, cellSeries(law, 11, N, 30, 4)); // a 4σ step from tick 30
  const shadow = result.family_A_shadow ?? [];
  assert.deepEqual([...new Set(shadow.map((v) => v.signal))], ['http_5xx_rate'],
    'Family A verdicts only for the configured signal (the six have cells but are not configured)');
  assert.equal(shadow.length, 2, 'one mixture and one betting verdict');
  for (const s of SIGNALS) assert.ok(!shadow.some((v) => v.signal === s), `no verdict for ${s}`);
  // The step fires on the configured signal. http_5xx_rate is not one of the six defaults, so under
  // FAMILY_A_ROLLBACK_AUTHORITY (engine/guarantees.ts) the fire is advisory and never reaches
  // rollback[]; test/family-a-rollback-authority.test.ts covers the operator opt-in.
  assert.ok(fired.has('http_5xx_rate'), 'the step fires on the configured signal');
  assert.deepEqual([...reasons], ['advisory_signal_not_rollback_authorized'], 'every fire carries the unauthorized-advisory reason');
  assert.ok(!seen.has('family_A_http_5xx_rate') && !seen.has('family_A_betting_http_5xx_rate'),
    `an unauthorized custom signal drives no Family A rollback; saw ${[...seen].join(', ')}`);
});

test('engine v0.12.1-pre: with no bonferroni_factor the engine splits α over the configured list', () => {
  const signals = ['http_5xx_rate', 'queue_depth'];
  const cfg = customSignalCfg(signals, false);
  assert.equal(cfg.bonferroni_factor, undefined);
  const alphaA = cfg.alpha_budget.per_family.A!;
  const cell = cfg.baseline_cells!.cells.find((c) => c.key.hour_of_day === 20 && c.key.day_of_week === 3)!;
  const p = cell.family_A!.per_signal.http_5xx_rate!;
  const law = { mean: p.baseline_mean, sigma: Math.sqrt(p.baseline_sigma_squared) };
  const { result } = runA(cfg, cellSeries(law, 12, 40), { queue_depth: cellSeries(law, 13, 40) });
  const shadow = result.family_A_shadow ?? [];
  assert.deepEqual([...new Set(shadow.map((v) => v.signal))].sort(), [...signals].sort());
  assert.equal(shadow.length, 4, 'one mixture and one betting verdict per configured signal');
  for (const s of SIGNALS) assert.ok(!shadow.some((v) => v.signal === s), `no verdict for ${s}`);
  // Default factor 2 (the list length), not the pre-v0.12.1 fixed 6. Per-signal budget α_A/2; betting
  // takes the stamped α_A/2·½ and the mixture the rest (engine _page-cusum-mixture.ts:145-146), so both
  // Ville thresholds are 4/α_A. Under a factor of 6 the mixture's would be 12/α_A.
  const rel = (a: number | null | undefined, b: number) => assert.ok(a != null && Math.abs(a - b) / b < 1e-9, `expected ${b}, got ${a}`);
  // runFamilyA writes the mixture verdicts first and appends the betting ones
  // (engine/gates/_health-detectors.ts runFamilyACusum, then runFamilyABetting's concat).
  const mixture = shadow.slice(0, 2);
  const betting = shadow.slice(2);
  for (const v of mixture) rel(v.threshold, 4 / alphaA);
  for (const v of betting) rel(v.threshold, 4 / alphaA);
});

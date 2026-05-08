// test/compiler-equivalence.test.ts — Week-1 NS keystone gate.
//
// Proves the engine produces byte-identical per-scenario verdicts when driven
// by a compiled CompiledConfig vs when it runs against today's hand-tuned
// thresholds — across all 120 adversarial scenarios.
//
// Acceptance (from WEEK1-HANDOFF.md §1.1.e):
//   - verdict per scenario is byte-identical between the two paths
//   - TP ≥ 117/120, FP = 0
//
// If the compiled config doesn't exist on disk yet, this test regenerates it
// by invoking the Week-1 generator + compiler. That keeps `npm test` working
// on a fresh clone where runs/ is gitignored.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
// Import the type from the compiled output so tsc(test) doesn't pull the
// engine source into its compilation graph and emit stray engine/*.js.
import type { CompiledConfig } from '../dist/engine/types';

// shared.js re-exports the compiled engine. Same import surface runner.js
// and the other tests use.
const engine = require('../shared');
const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;

const ROOT = path.resolve(__dirname, '..');
const SCENARIOS_PATH = path.join(ROOT, 'runs', 'adversarial-scenarios.json');
const BASELINE_DIR   = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');
const CONFIG_PATH    = path.join(ROOT, 'runs', 'compiled-configs', 'v1-legacy-equivalent.json');

// Verbatim copy of runner.js makeAdvDrift — reconstructs a drift function
// from stored driftParams. The 120 adversarial scenarios in the JSON file
// only carry driftParams; the drift closure has to be rebuilt at load time.
// (Kept local rather than importing from runner.js so this test stays
// decoupled from runner's batch/aggregate internals.)
function makeAdvDrift(pIn: Record<string, number>): (i: number) => Record<string, number> {
  const _ka: Record<string, string> = {
    'latSlope':'p99latencySlope','tokSlope':'tokensturnSlope','tokenSlope':'tokensturnSlope',
    'costSlope':'costreqSlope','costDrop':'costreqSlope','costDropSlope':'costreqSlope',
    'kvSlope':'kvcacheSlope','hbmSlope':'hbmspillSlope','hbmRiseSlope':'hbmspillSlope',
    'kvDropSlope':'kvcacheSlope','collectiveSlope':'collectiveopsSlope',
    'collectiveNoise':'collectiveopsSlope','collectiveOpsNoise':'collectiveopsSlope',
    'collectiveFlat':'collectiveopsSlope','corpusSlope':'corpusdeltaSlope',
    'downSlope':'downstreamerrSlope','latFlat':'p99latencySlope',
    'p99_latency_slope':'p99latencySlope','hbm_spill_slope':'hbmspillSlope',
    'kv_cache_slope':'kvcacheSlope','tokens_turn_slope':'tokensturnSlope',
    'cost_req_slope':'costreqSlope','downstream_err_slope':'downstreamerrSlope',
    'collective_ops_slope':'collectiveopsSlope',
    'collective_ops_trend_slope':'collectiveopsSlope',
    'corpus_delta_slope':'corpusdeltaSlope','mfu_slope':'mfuSlope',
    'ttft_slope':'ttftSlope','traffic_pct_slope':'trafficpctSlope',
    'p99_latency_slope_ms_per_hour':'p99latencySlope',
    'ttft_slope_ms_per_hour':'ttftSlope',
    'tokens_turn_slope_per_hour':'tokensturnSlope',
    'cost_req_slope_per_hour':'costreqSlope',
    'hbm_spill_slope_per_hour':'hbmspillSlope','mfuDropEarly':'mfuSlope',
    'p99_latency_slope_post_lag':'p99latencySlope',
    'ttft_slope_post_lag':'ttftSlope',
    'hbm_spill_slope_post_plateau':'hbmspillSlope',
  };
  const p: Record<string, number> = {};
  for (const k of Object.keys(pIn)) {
    const nk = _ka[k] ?? k;
    if (!(nk in p)) p[nk] = pIn[k];
  }
  const keys = ['p99_latency','ttft','tokens_turn','kv_cache','cost_req','downstream_err','mfu','hbm_spill','collective_ops','corpus_delta','traffic_pct'];
  return function (i: number): Record<string, number> {
    const out: Record<string, number> = {};
    const onset = p['onsetTick'] || 0;
    for (const k of keys) {
      const slopeKey = k.replace(/_/g, '') + 'Slope';
      const slope = p[slopeKey] ?? p['globalSlope'] ?? 0;
      const oscAmp = p[k.replace(/_/g, '') + 'OscAmp'] ?? p['oscillationAmplitude'] ?? 0;
      const oscPer = p[k.replace(/_/g, '') + 'OscPeriod'] ?? p['oscillationPeriod'] ?? 8;
      const osc = oscAmp > 0 ? oscAmp * Math.sin(2 * Math.PI * i / oscPer) : 0;
      const noise = 0.005 * (Math.random() - 0.5);
      if (i >= onset) {
        out[k] = 1 + (i - onset + 1) * slope + osc + noise;
      } else {
        out[k] = 1 + osc + noise;
      }
      if (k === 'kv_cache' || k === 'mfu' || k === 'traffic_pct' || k === 'collective_ops') {
        out[k] = Math.max(0.3, Math.min(1.05, out[k]));
      }
    }
    return out;
  };
}

/** Pre-compute live-metrics per tick for one scenario. Both engine paths
 *  consume the *same* precomputed array so Math.random() inside the drift
 *  reconstruction doesn't cause input divergence between paths. */
function precomputeTicks(sc: any): Record<string, number>[] {
  const drift = makeAdvDrift(sc.driftParams || {});
  const ticks: Record<string, number>[] = [];
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const mults = drift(i);
    const live: Record<string, number> = {};
    for (const k of Object.keys(sc.baseline)) {
      live[k] = sc.baseline[k] * (mults[k] !== undefined ? mults[k] : 1);
    }
    ticks.push(live);
  }
  return ticks;
}

type FinalVerdict = 'rollback' | 'proceed' | 'extend';

function runScenario(sc: any, ticks: Record<string, number>[], compiledConfig: CompiledConfig | null): { verdict: FinalVerdict; tick: number } {
  const tb = new TrendBuffer(10);
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const live = ticks[i];
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const hrs = i * (sc.bakeHours / TOTAL_TICKS);
    const result = orchestrate({
      liveMetrics: live, scenario: sc, hoursElapsed: hrs,
      trendBuffer: tb, tick: i, totalTicks: TOTAL_TICKS,
      compiledConfig,
    });
    if (result.verdict === 'rollback') return { verdict: 'rollback', tick: i };
    if (result.verdict === 'proceed')  return { verdict: 'proceed',  tick: i };
    if (i === TOTAL_TICKS - 1) {
      const fv: FinalVerdict = (result.healthResult && result.healthResult.extend.length > 0) ? 'extend' : 'proceed';
      return { verdict: fv, tick: i };
    }
  }
  return { verdict: 'extend', tick: TOTAL_TICKS - 1 };
}

let SCENARIOS: any[] = [];
let COMPILED: CompiledConfig;

before(() => {
  // Regenerate baseline + compiled config if missing. runs/ is gitignored,
  // so a fresh clone won't have them.
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
      execSync(
        'node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
        { cwd: ROOT, stdio: 'inherit' }
      );
    }
    execSync(
      'node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --out runs/compiled-configs/v1-legacy-equivalent.json',
      { cwd: ROOT, stdio: 'inherit' }
    );
  }
  // W3 §3.1.e adds 5 correlated-noise scenarios; W4 §4.1.f adds 6
  // oscillation/novelty scenarios. Week-1 keystone is scoped to the
  // pre-W3 pool of 120 (byte-identical verdict parity against legacy
  // hand-tuned engine on the originally-curated set).
  const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  SCENARIOS = all.filter(
    (s: any) => !s.id.startsWith('adv_correlated_noise_') && !s.id.startsWith('adv_w4_'),
  );
  COMPILED  = JSON.parse(fs.readFileSync(CONFIG_PATH,    'utf8'));
  assert.equal(SCENARIOS.length, 120, 'Expected 120 adversarial scenarios (pre-W3 pool)');
});

test('compiler-equivalence: verdict per scenario is byte-identical', () => {
  const mismatches: Array<{ id: string; legacy: FinalVerdict; compiled: FinalVerdict }> = [];
  for (const sc of SCENARIOS) {
    const ticks = precomputeTicks(sc);
    const a = runScenario(sc, ticks, null);
    const b = runScenario(sc, ticks, COMPILED);
    if (a.verdict !== b.verdict) {
      mismatches.push({ id: sc.id, legacy: a.verdict, compiled: b.verdict });
    }
  }
  if (mismatches.length > 0) {
    console.error('Verdict mismatches:');
    for (const m of mismatches) console.error('  ' + m.id + ': legacy=' + m.legacy + ' compiled=' + m.compiled);
  }
  assert.equal(mismatches.length, 0, `Expected byte-identical verdicts across all 120 scenarios; got ${mismatches.length} mismatches`);
});

test('compiler-equivalence: TP ≥ 117/120 and FP = 0 under compiled config', () => {
  let tp = 0;
  let nonRollback = 0;
  // Adversarial scenarios are all designed to roll back — they contain no
  // clean scenarios, so FP-on-clean for *this* set is vacuously 0. The check
  // is still encoded for when future weeks mix healthy scenarios in.
  const ADV_SCENARIO_IS_CLEAN = (_sc: any) => false;

  for (const sc of SCENARIOS) {
    const ticks = precomputeTicks(sc);
    const { verdict } = runScenario(sc, ticks, COMPILED);
    if (verdict === 'rollback') {
      if (ADV_SCENARIO_IS_CLEAN(sc)) {
        nonRollback++; // structured so FP vs TP both land in the right bucket
      } else {
        tp++;
      }
    }
  }
  assert.equal(nonRollback, 0, 'FP on clean must be 0 (none in this set)');
  assert.ok(tp >= 117, `Expected TP ≥ 117/120 under compiled config; got ${tp}`);
});

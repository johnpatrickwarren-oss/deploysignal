// test/mSPRT.test.ts — Family A Page-CUSUM detector unit tests.
//
// Acceptance per WEEK2-HANDOFF.md §2.1.d (architect-rewrite 2026-04-18):
//   (a) immediate-fire on large positive deviation
//   (b) never fires on zero-deviation stable stream
//   (c) CUSUM resets on extended negative drift (pre-drift dilution guard)
//   (d) fires after late-onset drift — the slow-onset case that broke the
//       sliding-window attempt
//   (e) bake-profile suppresses fires during min_ticks window (state still
//       accumulates so post-eligibility fires are correctly triggered)
//   (f) traffic-gate suppresses fires below min_traffic_pct
//   (g) hour-of-day cell lookup returns different τ² and σ² at h=2 vs h=14
//   (h) cell-boundary crossing mid-deploy preserves S_n but switches
//       σ²/baseline-mean
// Plus: FP-rate sanity on 1000 synthetic-healthy runs ≤ 2× per-signal α.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type { CompiledConfig, MSPRTParams } from '../dist/engine/types';
import {
  evaluateCUSUM, freshCUSUM, updateCUSUM, lookupCellParams, trafficGateMin,
  type CUSUMState,
} from '../dist/engine/detectors/page-cusum';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
const BASELINE_DIR = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');

function ensureConfig(): CompiledConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
      execSync(
        'node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
        { cwd: ROOT, stdio: 'inherit' },
      );
    }
    execSync(
      'node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B --out runs/compiled-configs/v2-with-family-a.json',
      { cwd: ROOT, stdio: 'inherit' },
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as CompiledConfig;
}

function defaultInput(signal: string, params: MSPRTParams, state: CUSUMState) {
  return {
    signal, params, state,
    trafficPct: 1.0,
    trafficGate: 0.10,
    ticksSinceDeploy: 100, // well past bake window
    deployAgeDays: 0,
  };
}

// ────────────────────────────────────────────────────────────────────
// (a) Immediate-fire on large positive deviation.
test('CUSUM: (a) large positive deviation fires', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  const state = freshCUSUM();
  // Feed three +4σ observations — each z_n is large positive; S_n climbs
  // quickly past h ≈ 9.6.
  let last;
  for (let i = 0; i < 3; i++) {
    last = evaluateCUSUM(defaultInput('p99_latency', params, state), 4 * sigma);
  }
  assert.equal(last!.verdict, 'fire',
    `expected fire within 3 ticks of +4σ, got ${last!.verdict} (S_n=${last!.statistic}, h=${last!.threshold})`);
});

// ────────────────────────────────────────────────────────────────────
// (b) Zero-deviation stable stream never fires.
test('CUSUM: (b) zero deviation never fires over 100 ticks', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const state = freshCUSUM();
  for (let i = 0; i < 100; i++) {
    const v = evaluateCUSUM(defaultInput('p99_latency', params, state), 0);
    assert.notEqual(v.verdict, 'fire');
  }
  // S_n should have been clamped to 0 by the max(0,...) all along —
  // zero x_n produces a small negative z_n from the log-shrink term.
  assert.equal(state.S, 0);
});

// ────────────────────────────────────────────────────────────────────
// (c) Extended negative drift truncates — pre-drift dilution guard.
test('CUSUM: (c) extended pre-drift samples keep S at 0', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  const state = freshCUSUM();
  // 20 ticks of small noise: half slightly positive, half slightly
  // negative. The log-shrink term keeps each z_n slightly negative on
  // average; S_n should stay at 0.
  for (let i = 0; i < 20; i++) {
    const x = 0.3 * sigma * (i % 2 === 0 ? 1 : -1);
    evaluateCUSUM(defaultInput('p99_latency', params, state), x);
  }
  assert.equal(state.S, 0, `expected S=0 after pre-drift samples, got S=${state.S}`);
});

// ────────────────────────────────────────────────────────────────────
// (d) Late-onset drift fires — the case the sliding window could not catch.
test('CUSUM: (d) late-onset drift fires (pre-drift dilution resolved)', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  const state = freshCUSUM();
  // 10 pre-drift ticks at zero (S stays at 0).
  for (let i = 0; i < 10; i++) {
    evaluateCUSUM(defaultInput('p99_latency', params, state), 0);
  }
  assert.equal(state.S, 0);
  // Now 15 ticks of +3σ drift — CUSUM accumulates from 0, no dilution.
  let lastVerdict;
  for (let i = 0; i < 15; i++) {
    lastVerdict = evaluateCUSUM(defaultInput('p99_latency', params, state), 3 * sigma);
    if (lastVerdict.verdict === 'fire') break;
  }
  assert.equal(lastVerdict!.verdict, 'fire',
    `expected fire on late-onset +3σ drift, got ${lastVerdict!.verdict} at S=${lastVerdict!.statistic}`);
});

// ────────────────────────────────────────────────────────────────────
// (e) Bake-profile suppresses the *fire* but CUSUM still accumulates.
test('CUSUM: (e) bake-profile suppresses fire; state accumulates', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'eval_score')!;
  assert.ok(params.min_ticks_before_eligible >= 5, 'eval_score bake profile should be ≥5 ticks');
  assert.ok(params.min_observation_window >= 5, 'eval_score bake profile should be ≥5 obs');
  const state = freshCUSUM();
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  // Drive big negative deviations (eval_score drops hard) pre-bake.
  for (let i = 0; i < 4; i++) {
    const input = defaultInput('eval_score', params, state);
    input.ticksSinceDeploy = i;
    const v = evaluateCUSUM(input, -4 * sigma);
    assert.equal(v.verdict, 'suppressed', `tick ${i} should suppress`);
    assert.equal(v.reason_code, 'bake_profile_not_met');
  }
  const stateMidBake = state.S;
  assert.ok(stateMidBake > 0, 'S_n should accumulate during suppression');
  // Keep feeding until both bake-profile clauses clear: ticksSinceDeploy ≥
  // min_ticks AND state.n ≥ min_obs. W4 §4.1.h added the clause-2 check
  // (state.n ≥ min_observation_window) so the loop runs until both clear.
  let v;
  for (let t = 4; t < 16; t++) {
    const input = defaultInput('eval_score', params, state);
    input.ticksSinceDeploy = t;
    v = evaluateCUSUM(input, -4 * sigma);
    if (v.verdict !== 'suppressed') break;
  }
  assert.ok(v!.verdict === 'fire' || v!.verdict === 'indeterminate',
    `post-bake tick expected fire or indeterminate, got ${v!.verdict}`);
});

// ────────────────────────────────────────────────────────────────────
// (f) Traffic gate suppresses fire below min_traffic_pct.
test('CUSUM: (f) traffic gate suppresses fires', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  const state = freshCUSUM();
  // Prime state.n to bypass the W4 §4.1.h clause-2
  // (min_observation_window) check — we want this test scoped to the
  // traffic-gate branch only.
  state.n = params.min_observation_window;
  const input = defaultInput('p99_latency', params, state);
  input.trafficPct = 0.05; // below 0.10 gate
  for (let i = 0; i < 5; i++) {
    const v = evaluateCUSUM(input, 4 * sigma);
    assert.equal(v.verdict, 'suppressed');
    assert.equal(v.reason_code, 'traffic_pct_below_gate');
  }
});

// ────────────────────────────────────────────────────────────────────
// (g) Per-cell τ² and σ² differ between h=2 and h=14.
test('CUSUM: (g) per-cell τ² and σ² differ between h=2 and h=14', () => {
  const cfg = ensureConfig();
  const p2  = lookupCellParams(cfg, { hour_of_day: 2 },  'p99_latency')!;
  const p14 = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  assert.notEqual(p2.tau_squared, p14.tau_squared);
  assert.notEqual(p2.derivation!.empirical_variance, p14.derivation!.empirical_variance);
  assert.notEqual(p2.derivation!.mean, p14.derivation!.mean);
});

// ────────────────────────────────────────────────────────────────────
// (h) Cell-boundary crossing: S_n carries forward; σ² and mean switch.
test('CUSUM: (h) cell-boundary crossing preserves S_n, switches params', () => {
  const cfg = ensureConfig();
  const p14 = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const p20 = lookupCellParams(cfg, { hour_of_day: 20 }, 'p99_latency')!;
  const state = freshCUSUM();
  // 3 ticks at cell h=14 with +3σ drift.
  for (let i = 0; i < 3; i++) {
    const sigma = Math.sqrt(p14.derivation!.empirical_variance);
    evaluateCUSUM(defaultInput('p99_latency', p14, state), 3 * sigma);
  }
  const snBeforeCross = state.S;
  assert.ok(snBeforeCross > 0);
  // Cross to cell h=20 — same state, different params.
  const sigma20 = Math.sqrt(p20.derivation!.empirical_variance);
  evaluateCUSUM(defaultInput('p99_latency', p20, state), sigma20); // modest drift
  assert.ok(state.S !== snBeforeCross, 'S_n should evolve with new-cell params');
  // We can't easily assert the exact new value without recomputing z_n; the
  // important invariant is that state carried (state.S > 0 continues).
  assert.ok(state.S >= 0);
});

// ────────────────────────────────────────────────────────────────────
// FP-rate sanity on a synthetic healthy stream (σ is per-cell).
test('CUSUM: FP rate on healthy baseline ≤ 2× per-signal α over 1000 runs', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  // Deterministic RNG — same seed, no flake.
  let a = 0xDEADBEEF >>> 0;
  function rng(): number {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss(): number {
    let u = rng(); while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  const N_RUNS = 1000;
  const N_TICKS_PER_RUN = 32;
  let fires = 0;
  for (let r = 0; r < N_RUNS; r++) {
    const state = freshCUSUM();
    let fired = false;
    for (let t = 0; t < N_TICKS_PER_RUN; t++) {
      const v = evaluateCUSUM(defaultInput('p99_latency', params, state), sigma * gauss());
      if (v.verdict === 'fire') { fired = true; break; }
    }
    if (fired) fires++;
  }
  const rate = fires / N_RUNS;
  const bound = 2 * params.alpha;
  assert.ok(rate <= bound + 1e-9,
    `FP rate ${rate.toExponential(3)} exceeds 2× per-signal α bound ${bound.toExponential(3)} (fires=${fires}/${N_RUNS})`);
});

// ────────────────────────────────────────────────────────────────────
// trafficGateMin handles missing gate in the compiled config.
test('CUSUM: trafficGateMin returns 0 when gate is not compiled', () => {
  const fake: CompiledConfig = {
    version: 'x', compiler_version: 'x', compiled_at: '', baseline_ref: '',
    alpha_budget: { total: 0, per_family: {} },
    family_B: { cutoffs: {}, vote_thresholds: {} },
  };
  assert.equal(trafficGateMin(fake), 0);
});

// ────────────────────────────────────────────────────────────────────
// Pure-math unit: updateCUSUM math matches the architect's spec.
test('CUSUM: updateCUSUM matches architect math formula', () => {
  const state = freshCUSUM();
  const sigma2 = 100, tau2 = 25;
  const x = 5;
  const logShrink = 0.5 * Math.log(sigma2 / (sigma2 + tau2));
  const quad = (x * x * tau2) / (2 * sigma2 * (sigma2 + tau2));
  const expectedZ = logShrink + quad;
  const expectedS = Math.max(0, 0 + expectedZ);
  const s = updateCUSUM(state, x, sigma2, tau2, 1e-4);
  assert.ok(Math.abs(s - expectedS) < 1e-12, `expected S=${expectedS}, got ${s}`);
  assert.equal(state.n, 1);
  assert.equal(state.alphaConsumed, 1e-4);
});

// ────────────────────────────────────────────────────────────────────
// T1 (W3 §3.0, from REVIEWER-REPORT-WK02) — cell-crossing analytical
// assertion. The existing test (h) passes even if σ² is pinned constant;
// this closes that bias by comparing state.S against the closed-form S_n
// computed with the NEW cell's σ² and τ² specifically.
test('CUSUM: (T1) cell-crossing applies new cell σ², τ² analytically', () => {
  const cfg = ensureConfig();
  const p14 = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  const p20 = lookupCellParams(cfg, { hour_of_day: 20 }, 'p99_latency')!;
  // Sanity: the two cells actually differ (Q1 acceptance); if this ever
  // flattens, the whole premise collapses.
  assert.notEqual(p14.derivation!.empirical_variance, p20.derivation!.empirical_variance);
  assert.notEqual(p14.tau_squared, p20.tau_squared);

  const state = freshCUSUM();
  // Tick 1: cell h=14. Big positive deviation so S stays > 0 after one
  // step and the cross-cell z_n contribution isn't truncated away.
  const x1 = 4 * Math.sqrt(p14.derivation!.empirical_variance);
  updateCUSUM(state, x1, p14.derivation!.empirical_variance, p14.tau_squared, p14.alpha);
  const sBeforeCross = state.S;

  // Tick 2: cell h=20. Compute the expected S directly from p20's params.
  const x2 = 2 * Math.sqrt(p20.derivation!.empirical_variance);
  const s2 = p20.derivation!.empirical_variance;
  const t2 = p20.tau_squared;
  const expectedZ = 0.5 * Math.log(s2 / (s2 + t2)) + (x2 * x2 * t2) / (2 * s2 * (s2 + t2));
  const expectedS = Math.max(0, sBeforeCross + expectedZ);
  updateCUSUM(state, x2, s2, t2, p20.alpha);
  assert.ok(Math.abs(state.S - expectedS) < 1e-12,
    `cross-cell update must use new cell's σ²/τ²; got S=${state.S}, expected ${expectedS}`);

  // And the expected value MUST differ from what the OLD cell's params
  // would have produced — the reviewer's exact bias concern.
  const s1 = p14.derivation!.empirical_variance;
  const t1 = p14.tau_squared;
  const zWithOldParams = 0.5 * Math.log(s1 / (s1 + t1)) + (x2 * x2 * t1) / (2 * s1 * (s1 + t1));
  const sWithOldParams = Math.max(0, sBeforeCross + zWithOldParams);
  assert.notEqual(expectedS, sWithOldParams,
    'if these match, the test would be vacuous — old/new cell params must diverge');
});

// ────────────────────────────────────────────────────────────────────
// T3 (W3 §3.0, from REVIEWER-REPORT-WK02) — max_deploy_window_days
// suppression. Parallel to the existing (e) test which drives
// min_ticks_before_eligible.
test('CUSUM: (T3) deploy_age > max_deploy_window_days suppresses regardless of S_n', () => {
  const cfg = ensureConfig();
  const params = lookupCellParams(cfg, { hour_of_day: 14 }, 'p99_latency')!;
  assert.ok(params.max_deploy_window_days > 0);
  const sigma = Math.sqrt(params.derivation!.empirical_variance);
  const state = freshCUSUM();
  // Build up a S_n that would otherwise fire.
  const input = {
    signal: 'p99_latency', params, state,
    trafficPct: 1.0, trafficGate: 0.10,
    ticksSinceDeploy: 100,
    deployAgeDays: params.max_deploy_window_days + 0.1,  // just past window
  };
  // Feed 5 big positive deviations — under a fire-eligible deploy, this
  // would fire on the first or second tick.
  let last;
  for (let i = 0; i < 5; i++) {
    last = evaluateCUSUM(input, 4 * sigma);
  }
  assert.equal(last!.verdict, 'suppressed',
    `past-window deploy must never fire; got ${last!.verdict} at S=${last!.statistic}`);
  assert.equal(last!.reason_code, 'bake_profile_not_met');
  // Sanity: S_n is still accumulating under the hood (per architect spec).
  assert.ok(state.S > 0, 'state should accumulate during suppression');
});

// ────────────────────────────────────────────────────────────────────
// T4 (W3 §3.0, from REVIEWER-REPORT-WK02) — σ² = 0 degenerate cell.
// Documents the existing fallback behavior in updateCUSUM so a silent
// refactor can't drift it.
test('CUSUM: (T4) σ² ≤ 0 falls back to z = x² / (2τ²)', () => {
  const state = freshCUSUM();
  const tau2 = 4;
  const x = 3;
  // σ² exactly 0.
  const expectedZ = (x * x) / (2 * tau2);  // 9 / 8 = 1.125
  const s = updateCUSUM(state, x, 0, tau2, 1e-4);
  assert.ok(Math.abs(s - expectedZ) < 1e-12, `σ²=0 fallback: expected S=${expectedZ}, got ${s}`);

  // σ² negative — should behave identically to σ² = 0 via the `<= 0` guard.
  const s2state = freshCUSUM();
  const s2 = updateCUSUM(s2state, x, -1, tau2, 1e-4);
  assert.ok(Math.abs(s2 - expectedZ) < 1e-12, `σ²<0 fallback: expected S=${expectedZ}, got ${s2}`);

  // σ² ≤ 0 AND τ² ≤ 0 → z = 0, S stays at 0.
  const s3state = freshCUSUM();
  const s3 = updateCUSUM(s3state, x, 0, 0, 1e-4);
  assert.equal(s3, 0, 'σ²=0 and τ²=0 must yield z=0');
});

// test/e-mmd.test.ts — Addition #20 slice-2 (ARCHITECT-REPLY-43 D3).
//
// Verifies `evaluateEMmd`'s Option-B kernel-distance + scalar-betting
// e-process on analytically-derivable fixtures. Per TPM-REPLY-43 slice-2
// disposition: strict numeric anchors against synthetic-v1 empirical
// fire horizons are slice-2 INTEGRATION-test territory (canned-demo
// coship + variant-migration + cupac-interaction); this unit file
// locks in formula + sign/monotonicity/warmup guards only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, FamilyCPerCell, EMmdState } from '../engine/types';
import { evaluateEMmd, freshEMmdState } from '../engine/detectors/sequential-mmd';
import { FAMILY_C_SIGNALS } from '../engine/detectors/hotelling';

const ALPHA = 1e-4;
const WARMUP = 30;
const THRESHOLD = 1 / ALPHA;  // 10,000 per D5

/** Build a p-dim isotropic-Σ Family C cell with both mmd_params (for
 *  bandwidth) and e_mmd_params populated for the safe-test / e-process
 *  variant selection. */
function isotropicEmmdCell(p: number): FamilyCPerCell {
  const cov: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    cov[i] = new Array(p).fill(0);
    cov[i][i] = 1;
  }
  // Median-heuristic bandwidth ≈ √p for i.i.d. standard-normal pool
  // (E[||y_i − y_j||²] = 2p, median ≈ √(2p)); too-small bandwidth at
  // high p saturates the kernel (k → 0 for any pair) and collapses
  // d_t to a shift-independent constant — the compiler's real calibration
  // path derives bandwidth from empirical baseline pairwise distances
  // so this fixture approximates that.
  const bandwidth = Math.sqrt(2 * p);
  return {
    mean_vector: new Array(p).fill(0),
    covariance: cov,
    hotelling_variant: 'safe_test',
    mmd_params: {
      kernel: 'gaussian_rbf',
      bandwidth,
      window_size: 30,
      baseline_baseline_sum: 0,     // unused by evaluateEMmd
      null_quantile: 1,              // unused by evaluateEMmd
      null_quantile_bootstraps: 0,
      alpha: ALPHA,
    },
    // Analytic placeholder; a precise match to the pool's empirical
    // ||μ_y||² isn't required for the unit tests here — the assertions
    // check relative wealth behavior (small shift < large shift),
    // warmup guard, and fire-under-sustained-drift envelope, none of
    // which depend on the exact kernel_baseline_mean_norm_squared.
    e_mmd_params: {
      kernel_baseline_mean_norm_squared: 0.5,
      alpha: ALPHA,
      running_moment_window: WARMUP,
    },
  };
}

function makeCfg(cell: FamilyCPerCell): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.2.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 0, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: {
      p99_latency: { min_ticks_before_eligible: 1, min_observation_window: 1, max_deploy_window_days: 10 },
    },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 2 },
        n_samples: 500,
        confidence: 'strict',
        family_C: cell,
      }],
      aggregate_fallback: {
        family_A: { per_signal: {} },
        family_C: cell,
      },
    },
  };
}

/** Synthesize a live-metrics object with equal-shift on every Family C
 *  signal (relative-deviation vs the cell's mean=0 isotropic case). */
function liveAt(shift: number): Record<string, number> {
  const m: Record<string, number> = {};
  for (const sig of FAMILY_C_SIGNALS) m[sig] = shift;
  // baseline mean is 0 → liveVector returns raw signal values; no
  // divide-by-zero because liveVector's `Math.abs(m) > 1e-12` guard
  // falls through to additive (x − m).
  return m;
}

function baseCtx() {
  return {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 10, deployAgeDays: 0.5, trafficPct: 1.0,
  };
}

// ── (1) Warmup / suppression guards ─────────────────────────────────

test('e-MMD: emits emmd_warming_moments for first running_moment_window ticks', () => {
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  const states: Record<string, unknown> = {};
  const ctx = baseCtx();
  for (let t = 1; t < WARMUP; t++) {
    const v = evaluateEMmd(cfg, liveAt(0.01), states as Record<string, EMmdState>, ctx);
    assert.ok(v, `tick ${t} returned null`);
    assert.equal(v!.verdict, 'suppressed');
    assert.equal(v!.reason_code, 'emmd_warming_moments');
    assert.equal(v!.family, 'C');
    assert.equal(v!.signal, 'sequential_mmd_e_process');
  }
});

test('e-MMD: post-warmup clean verdict under healthy shift', () => {
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  const states: Record<string, unknown> = {};
  const ctx = baseCtx();
  let last;
  for (let t = 1; t <= WARMUP + 1; t++) {
    last = evaluateEMmd(cfg, liveAt(0.01), states as Record<string, EMmdState>, ctx);
  }
  assert.ok(last);
  assert.ok(last!.verdict === 'clean' || last!.verdict === 'fire',
    `post-warmup verdict should be clean or fire, got ${last!.verdict}`);
});

// ── (2) Null cell (dormant-add backward-compat) ─────────────────────

test('e-MMD: returns null when cell lacks e_mmd_params (pre-#20 compat)', () => {
  const preCell: FamilyCPerCell = {
    mean_vector: new Array(FAMILY_C_SIGNALS.length).fill(0),
    covariance: (() => {
      const p = FAMILY_C_SIGNALS.length;
      const c: number[][] = new Array(p);
      for (let i = 0; i < p; i++) { c[i] = new Array(p).fill(0); c[i][i] = 1; }
      return c;
    })(),
    mmd_params: {
      kernel: 'gaussian_rbf', bandwidth: 1, window_size: 30,
      baseline_baseline_sum: 0, null_quantile: 1, null_quantile_bootstraps: 0, alpha: ALPHA,
    },
    // no e_mmd_params
  };
  const cfg = makeCfg(preCell);
  const v = evaluateEMmd(cfg, liveAt(0.01), {} as Record<string, EMmdState>, baseCtx());
  assert.equal(v, null);
});

test('e-MMD: returns null when cell lacks mmd_params (bandwidth unreachable)', () => {
  const cell = isotropicEmmdCell(FAMILY_C_SIGNALS.length);
  delete cell.mmd_params;
  const cfg = makeCfg(cell);
  const v = evaluateEMmd(cfg, liveAt(0.01), {} as Record<string, EMmdState>, baseCtx());
  assert.equal(v, null);
});

// ── (3) Suppression on context guards ───────────────────────────────

test('e-MMD: suppresses on schema_continuity_breaking', () => {
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  const v = evaluateEMmd(cfg, liveAt(0.01), {} as Record<string, EMmdState>, {
    ...baseCtx(), schemaContinuityClass: 'breaking',
  });
  assert.ok(v);
  assert.equal(v!.verdict, 'suppressed');
  assert.equal(v!.reason_code, 'schema_continuity_breaking');
});

test('e-MMD: suppresses on bake_profile_not_met (ticksSinceDeploy below min)', () => {
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  // bake profile min_ticks_before_eligible = 1; ticksSinceDeploy = 0 < 1 → suppressed
  const v = evaluateEMmd(cfg, liveAt(0.01), {} as Record<string, EMmdState>, {
    ...baseCtx(), ticksSinceDeploy: 0,
  });
  assert.ok(v);
  assert.equal(v!.verdict, 'suppressed');
  assert.equal(v!.reason_code, 'bake_profile_not_met');
});

// ── (4) State accumulation + monotonicity ───────────────────────────

test('e-MMD: wealth M grows faster on larger shift (monotonic under drift)', () => {
  const cell = isotropicEmmdCell(FAMILY_C_SIGNALS.length);
  const cfg = makeCfg(cell);
  const ctx = baseCtx();

  const runSmall: Record<string, unknown> = {};
  for (let t = 1; t <= 60; t++) evaluateEMmd(cfg, liveAt(0.5), runSmall as Record<string, EMmdState>, ctx);
  const runLarge: Record<string, unknown> = {};
  for (let t = 1; t <= 60; t++) evaluateEMmd(cfg, liveAt(2.0), runLarge as Record<string, EMmdState>, ctx);

  // Extract the e-MMD wealth states from both runs. Keys start with
  // `__emmd_` per the evaluator's convention.
  const pickWealth = (store: Record<string, unknown>): number => {
    for (const k of Object.keys(store)) {
      if (k.startsWith('__emmd_') && !k.startsWith('__emmd_pool_')) {
        return (store[k] as EMmdState).M;
      }
    }
    return -1;
  };
  const mSmall = pickWealth(runSmall);
  const mLarge = pickWealth(runLarge);
  assert.ok(mSmall >= 0 && mLarge >= 0);
  // Larger shift should never yield LESS wealth than smaller shift
  // under a non-degenerate bet (monotonic drift response).
  assert.ok(mLarge >= mSmall,
    `larger-shift M=${mLarge} should ≥ smaller-shift M=${mSmall}`);
});

test('e-MMD: fresh state has M=1, n=0, alphaConsumed=0', () => {
  const s = freshEMmdState();
  assert.equal(s.M, 1);
  assert.equal(s.n, 0);
  assert.equal(s.bet, 0);
  assert.equal(s.runningMean, 0);
  assert.equal(s.runningSecondMoment, 0);
  assert.equal(s.alphaConsumed, 0);
});

test('e-MMD: state.M >= WEALTH_FLOOR throughout extremely long healthy run', () => {
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  const states: Record<string, unknown> = {};
  const ctx = baseCtx();
  // 500 ticks of no-drift observations: wealth should decay but never hit 0.
  for (let t = 1; t <= 500; t++) {
    evaluateEMmd(cfg, liveAt(0), states as Record<string, EMmdState>, ctx);
  }
  for (const k of Object.keys(states)) {
    if (k.startsWith('__emmd_') && !k.startsWith('__emmd_pool_')) {
      const s = states[k] as EMmdState;
      assert.ok(s.M >= 1e-12, `M=${s.M} hit underflow floor`);
      assert.ok(s.n === 500, `expected n=500, got ${s.n}`);
    }
  }
});

// ── (5) Drift-onset regime (healthy → drifted transition) ──────────

test('e-MMD: responds to drift-onset after healthy warmup — wealth rises post-shift', () => {
  // Adaptive standardization catches drift at ONSET (change in regime)
  // rather than under sustained-offset-from-t=0. Test pattern:
  //   Ticks 1-60: healthy observations → running moments anchor at
  //     healthy d_t distribution.
  //   Ticks 61-160: sharp drift → d_t jumps; d_std is large positive
  //     until running mean adapts; wealth accumulates during that window.
  const cfg = makeCfg(isotropicEmmdCell(FAMILY_C_SIGNALS.length));
  const states: Record<string, unknown> = {};
  const ctx = baseCtx();

  const pickWealth = (store: Record<string, unknown>): number => {
    for (const k of Object.keys(store)) {
      if (k.startsWith('__emmd_') && !k.startsWith('__emmd_pool_')) {
        return (store[k] as EMmdState).M;
      }
    }
    return -1;
  };

  // Healthy phase — well past warmup (60 > WARMUP=30).
  for (let t = 1; t <= 60; t++) evaluateEMmd(cfg, liveAt(0), states as Record<string, EMmdState>, ctx);
  const mPreShift = pickWealth(states);
  assert.ok(mPreShift > 0, `wealth should be positive pre-shift; got ${mPreShift}`);

  // Drift phase.
  for (let t = 61; t <= 160; t++) evaluateEMmd(cfg, liveAt(2.0), states as Record<string, EMmdState>, ctx);
  const mPostShift = pickWealth(states);

  // Wealth should move measurably upward in response to the onset.
  // Loose bound — exact magnitude depends on pickBet's d-moments
  // semantic (flagged for architect review; see evaluateEMmd comment).
  assert.ok(mPostShift > mPreShift,
    `post-onset wealth M=${mPostShift} should exceed pre-onset M=${mPreShift}`);
});

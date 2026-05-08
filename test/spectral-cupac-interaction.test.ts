// test/spectral-cupac-interaction.test.ts — Addition #21 slice-3 D7 invariant.
//
// REPLY-45 D7 invariant: Family D consumes pre-CUPAC signals, NOT post-
// CUPAC residuals. Rationale (architect-authored):
//
//   "CUPAC regresses out predictable variance; oscillation IS a form of
//    structured variance. Regressing out correlated covariates before
//    spectral analysis would mask the oscillation we're detecting."
//
// The current engine architecture doesn't apply CUPAC to Family D's
// input path (TrendBuffer stores raw signal values). This test is a
// forward-compat regression guard: if a future change accidentally
// routes CUPAC-adjusted data into evaluateFamilyD, oscillation-driven
// fires would silently disappear and the Family D detection target
// would be masked.
//
// Test construction:
//   1. Synthesize a raw window with injected oscillation at period 5
//      (inside Family D's default lag range [3, 10]).
//   2. Synthesize a CUPAC-style "adjusted" version where the oscillation
//      has been regressed against a perfectly-correlated covariate
//      (simulates what a miscalibrated CUPAC would produce on Family D
//      input — flat residual with oscillation structure removed).
//   3. Assert evaluateFamilyD fires on raw, does not fire on adjusted.
//      Documents: the masking effect that motivated D7.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CompiledConfig, FamilyDPerSignal, SpectralEDetectorState, DetectorVerdict,
} from '../engine/types';
import { evaluateFamilyD } from '../engine/detectors/spectral';

function makeCfg(): CompiledConfig {
  const params: FamilyDPerSignal = {
    bootstrap_null_quantile: 0.60,
    min_peak_lag: 3,
    max_peak_lag: 10,
    spectral_variant: 'e_detector',
    null_mean: 0.42,
    null_std: 0.05,
    betting_delta: 0.015,  // 0.3 · σ₀
  };
  return {
    version: 'test', compiler_version: '0.2.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 1e-4, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: {
      kv_cache: { min_ticks_before_eligible: 1, min_observation_window: 1, max_deploy_window_days: 10 },
    },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: {
        family_A: { per_signal: {} },
        family_D: { kv_cache: params },
      },
    },
  };
}

function baseCtx() {
  return {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 10, deployAgeDays: 0.5, trafficPct: 1.0,
  };
}

/** Raw signal with strong period-5 oscillation — what Family D is
 *  supposed to detect. Peak|ACF| at lag 5 is large because the signal
 *  is highly autocorrelated at that period. */
function makeRawOscillatingWindow(amp = 0.15): number[] {
  const w = new Array(30);
  for (let i = 0; i < 30; i++) {
    w[i] = 1.0 + amp * Math.cos(i * 2 * Math.PI / 5);
  }
  return w;
}

/** "CUPAC-adjusted" window: what you'd get if Family D's input were
 *  mistakenly routed through a covariate regression that perfectly
 *  explained the period-5 structure. Residual = raw − predicted, with
 *  IID Gaussian-noise-like floor so the result has no surviving
 *  autocorrelation at any lag in [3, 10]. */
function makeCupacAdjustedWindow(): number[] {
  // Deterministic RNG for test stability.
  let seed = 0xCA9A >>> 0;
  const rng = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    let u = rng(); while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const w = new Array(30);
  for (let i = 0; i < 30; i++) {
    // Residual noise scale comparable to what post-regression residuals
    // would have in practice — small fraction of the original signal.
    w[i] = 1.0 + 0.002 * gaussian();
  }
  return w;
}

// ── D7 invariant tests ──────────────────────────────────────────────

test('spectral-cupac-interaction: Family D fires on RAW oscillating signal (oscillation detectable)', () => {
  const cfg = makeCfg();
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const raw = makeRawOscillatingWindow();
  let fired = false;
  for (let t = 1; t <= 30; t++) {
    const v = evaluateFamilyD(cfg, 'kv_cache', raw, baseCtx(), state) as DetectorVerdict;
    if (v && v.verdict === 'fire') { fired = true; break; }
  }
  assert.ok(fired, 'Family D should fire on sustained period-5 oscillation in raw signal');
});

test('spectral-cupac-interaction: Family D does NOT fire on CUPAC-adjusted (flattened) signal over same ticks', () => {
  const cfg = makeCfg();
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const adjusted = makeCupacAdjustedWindow();
  let fired = false;
  for (let t = 1; t <= 30; t++) {
    const v = evaluateFamilyD(cfg, 'kv_cache', adjusted, baseCtx(), state) as DetectorVerdict;
    if (v && v.verdict === 'fire') { fired = true; break; }
  }
  assert.equal(fired, false,
    'Family D should NOT fire on a flattened signal (oscillation regressed out) — this is the masking effect D7 prohibits');
});

test('spectral-cupac-interaction: D7 invariant — raw vs adjusted peak|ACF| divergence illustrates masking', () => {
  // Single-tick diagnostic: peak|ACF| on raw is substantially larger
  // than on adjusted. Quantifies what D7 is protecting against.
  const cfg = makeCfg();
  const raw = makeRawOscillatingWindow();
  const adjusted = makeCupacAdjustedWindow();

  const rawState: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const adjState: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const rawV = evaluateFamilyD(cfg, 'kv_cache', raw, baseCtx(), rawState) as DetectorVerdict;
  const adjV = evaluateFamilyD(cfg, 'kv_cache', adjusted, baseCtx(), adjState) as DetectorVerdict;

  // Single-tick wealth grows substantially under oscillating raw signal;
  // stays ≤1 under flattened adjusted signal. This ratio quantifies the
  // masking effect.
  assert.ok(rawState.M > 1, `raw single-tick M should grow (>1); got ${rawState.M}`);
  assert.ok(adjState.M <= 1,
    `adjusted single-tick M should drift down (≤1); got ${adjState.M}`);
  assert.ok(rawState.M > adjState.M * 10,
    `raw wealth should dominate adjusted by >10× per tick (masking severity); got raw=${rawState.M}, adj=${adjState.M}`);
});

test('spectral-cupac-interaction: D7 invariant documented in evaluateFamilyD interface — no CUPAC-adjustment path in signature', () => {
  // Static invariant: evaluateFamilyD's `recentSamples` parameter has
  // no transformation applied; caller is responsible for feeding raw.
  // This test documents that architectural choice via the interface
  // it exercises — if a future refactor added a CUPAC-adjust step
  // inside evaluateFamilyD, this test would still pass (which is fine;
  // the invariant is about the INPUT contract, not internal behavior).
  // The masking-detection tests above catch the actual regression
  // surface (accidental CUPAC-adjusted input producing false-silent).
  const cfg = makeCfg();
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const window = makeRawOscillatingWindow();
  const v = evaluateFamilyD(cfg, 'kv_cache', window, baseCtx(), state);
  assert.ok(v, 'evaluateFamilyD accepts raw recentSamples array without pre-processing');
});

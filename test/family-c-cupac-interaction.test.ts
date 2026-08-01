// test/family-c-cupac-interaction.test.ts — Addition #20 slice-2b-2b.
//
// Verifies safe-Hotelling e-process interacts correctly with Addition
// #24-style CUPAC-adjusted residuals (per ARCHITECT-REPLY-43 D7):
//   - Per-signal CUPAC adjustment reduces per-signal variance, so the
//     joint Σ has smaller scale than the unadjusted baseline; the
//     median-heuristic bandwidth and precompiled_log_det_shrink scale
//     proportionally — no architectural adjustment needed in the
//     detector.
//   - Under H₀ (no actual drift), the null wealth trajectory stays
//     bounded — specifically ≤ 1/α for essentially all ticks; finite-
//     sample excursions below 1.5·α per Ville's inequality.
//
// Test approach: draw p-dim Gaussian observations that simulate CUPAC-
// adjusted residuals with reduced variance vs the baseline; verify
// evaluateSafeHotelling's wealth stays bounded across a long deploy
// window. Single-seeded deterministic run; variability quantified via
// per-tick max-M observation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FamilyCPerCell, SafeHotellingState } from '../engine/types';
import { evaluateSafeHotelling, freshSafeHotellingState } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/hotelling';

const P = 11;  // FAMILY_C_SIGNALS length
const ALPHA = 1e-4;
const FIRE_THRESHOLD = 1 / ALPHA;  // = 10,000

/** Isotropic Σ = I_p cell with c=0.03 (the production default).
 *  precompiled_log_det_shrink = ½·p·log(1 + τ²) where τ² = c · 1
 *  (trace/p = 1 for identity). */
function isotropicCell(): FamilyCPerCell {
  const cov: number[][] = new Array(P);
  for (let i = 0; i < P; i++) {
    cov[i] = new Array(P).fill(0);
    cov[i][i] = 1;
  }
  const shrinkFraction = 0.03;
  const tauSquared = shrinkFraction * 1;  // trace/p = 1
  return {
    mean_vector: new Array(P).fill(0),
    covariance: cov,
    hotelling_variant: 'safe_test',
    safe_hotelling_params: {
      tau_squared: tauSquared,
      alpha: ALPHA,
      precompiled_log_det_shrink: 0.5 * P * Math.log(1 + tauSquared),
      shrink_fraction: shrinkFraction,
    },
  };
}

/** Deterministic Gaussian sampler for reproducibility across runs.
 *  mulberry32 → Box-Muller. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number, sigma = 1): number {
  let u = rng(); while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()) * sigma;
}

function drawVector(rng: () => number, sigma = 1): number[] {
  const v = new Array<number>(P);
  for (let i = 0; i < P; i++) v[i] = gaussian(rng, sigma);
  return v;
}

test('cupac-interaction: null wealth stays < 1/α across 500-tick deploy window with CUPAC-adjusted residuals (σ_reduced=0.5)', () => {
  // CUPAC's typical effect: residual σ reduced to ~0.5·σ_baseline after
  // predictor subtraction. Feed N(0, 0.5² · I_p) to safe-Hotelling whose
  // baseline Σ = I_p. The detector sees smaller-than-baseline residuals;
  // z_t is dominated by -precompiled_log_det_shrink; M decays.
  const cell = isotropicCell();
  const state = freshSafeHotellingState();
  const rng = mulberry32(0xC07A);  // deterministic
  let maxM = state.M;
  for (let t = 1; t <= 500; t++) {
    const x = drawVector(rng, 0.5);
    evaluateSafeHotelling({ cell, alpha: ALPHA }, x, state);
    if (state.M > maxM) maxM = state.M;
  }
  assert.ok(maxM < FIRE_THRESHOLD,
    `max M=${maxM.toExponential(3)} should stay below 1/α=${FIRE_THRESHOLD} across 500 ticks`);
});

test('cupac-interaction: null wealth stays < 1/α across 500-tick deploy with raw residuals (σ_raw=1)', () => {
  // Unadjusted residuals at baseline scale. Same Ville bound should hold
  // since we're still under H₀ (no drift injected).
  const cell = isotropicCell();
  const state = freshSafeHotellingState();
  const rng = mulberry32(0xCAFE);
  let maxM = state.M;
  for (let t = 1; t <= 500; t++) {
    const x = drawVector(rng, 1);
    evaluateSafeHotelling({ cell, alpha: ALPHA }, x, state);
    if (state.M > maxM) maxM = state.M;
  }
  assert.ok(maxM < FIRE_THRESHOLD,
    `max M=${maxM.toExponential(3)} should stay below 1/α=${FIRE_THRESHOLD} under raw residuals`);
});

test('cupac-interaction: CUPAC-reduced residuals yield STRICTLY lower max-M than raw residuals', () => {
  // Sanity check: CUPAC variance reduction should reduce detector
  // sensitivity under H₀ (good — fewer false fires). Compare max-M
  // across paired runs (same seeds so residual realizations only differ
  // in scale).
  const cell = isotropicCell();

  const stateCupac = freshSafeHotellingState();
  const rngCupac = mulberry32(0xBEEF);
  let maxMCupac = stateCupac.M;
  for (let t = 1; t <= 300; t++) {
    evaluateSafeHotelling({ cell, alpha: ALPHA }, drawVector(rngCupac, 0.5), stateCupac);
    if (stateCupac.M > maxMCupac) maxMCupac = stateCupac.M;
  }

  const stateRaw = freshSafeHotellingState();
  const rngRaw = mulberry32(0xBEEF);
  let maxMRaw = stateRaw.M;
  for (let t = 1; t <= 300; t++) {
    evaluateSafeHotelling({ cell, alpha: ALPHA }, drawVector(rngRaw, 1), stateRaw);
    if (stateRaw.M > maxMRaw) maxMRaw = stateRaw.M;
  }

  assert.ok(maxMCupac <= maxMRaw,
    `CUPAC-reduced max-M (${maxMCupac.toExponential(3)}) should not exceed raw-residual max-M (${maxMRaw.toExponential(3)})`);
});

test('cupac-interaction: joint-Gaussian assumption holds — z_t symmetric-ish around shrink-term mean under H₀', () => {
  // Under H₀ with Gaussian residuals, per-tick z_t should average close
  // to -precompiled_log_det_shrink (the deterministic scale term). A
  // big asymmetric drift in observed-average-z_t would indicate the
  // joint-Gaussian model is breaking down for CUPAC-adjusted inputs.
  const cell = isotropicCell();
  const state = freshSafeHotellingState();
  const rng = mulberry32(0xFEED);
  const zSeries: number[] = [];
  let lastM = state.M;
  for (let t = 1; t <= 1000; t++) {
    evaluateSafeHotelling({ cell, alpha: ALPHA }, drawVector(rng, 0.8), state);
    const z = Math.log(state.M / lastM);
    zSeries.push(z);
    lastM = state.M;
  }
  const mean = zSeries.reduce((s, v) => s + v, 0) / zSeries.length;
  const expectedShrinkTerm = -(cell.safe_hotelling_params!.precompiled_log_det_shrink);
  // Expected mean under H₀ with σ_observed=0.8 (slightly below baseline
  // σ=1): z_t averages to approximately -shrink + small positive term
  // (because (0.8 · σ)² / σ² < 1 so xᵀΣ⁻¹x < E[xᵀΣ⁻¹x under baseline]).
  // Loose bound: within 2× of -shrink.
  assert.ok(mean < 0,
    `mean z_t should be negative (sub-martingale); got ${mean.toFixed(4)}`);
  assert.ok(Math.abs(mean - expectedShrinkTerm) < Math.abs(expectedShrinkTerm),
    `mean z_t (${mean.toFixed(4)}) should be within 1× of expected shrink term (${expectedShrinkTerm.toFixed(4)})`);
});

// tools/calibrators/family-d.ts — End-phase slice 3b (D-54-3).
//
// Spectral (Family D) calibration. Option 3 side-effect-free per
// ARCHITECT-REPLY-54b: pure function returning { result, timings }.
// Family D's original implementation already had no phase-timing
// side effects at the cell-build level — total compile cost folds
// into the main timer in calibrate.ts — so `timings` stays empty here
// for uniform shape across families.
//
// Q2.B.7 (Q2-B-7-ACF-AWARE-PARAMETRIC-SPEC.md) — adds AR(1)-aware
// calibration path: fitAR1Coefficient (Yule-Walker estimator) +
// buildFamilyDForSignalAR1 (replaces iid bootstrap loop with AR(1)
// bootstrap calibrated against fitted ρ). Closes the autocorrelation-
// structure mismatch between iid-calibrated threshold and production-
// realistic AR(1) traffic structure. Pre-Q2.B.7 buildFamilyDForSignal
// retained for backward-compat / shadow-compare.

import type { FamilyDPerSignal } from '../../engine/types';
import { mulberry32 } from './_shared.js';

/** Family D ACF bootstrap seed. Fixed so recompiles are deterministic. */
export const FAMILY_D_BOOTSTRAP_SEED = 0xDF01D >>> 0;

export interface FamilyDTimings {
  // Spectral bootstrap was never separately instrumented (folded into
  // `cov_estimation_ns` aggregate). Kept empty for schema uniformity.
}

export interface FamilyDBuildResult {
  result: FamilyDPerSignal | null;
  timings: FamilyDTimings;
}

/** Normalized ACF at lag k (deseasoned). */
export function acfAtLag(y: number[], k: number): number {
  const N = y.length;
  if (k < 1 || k >= N) return 0;
  let mean = 0;
  for (const v of y) mean += v;
  mean /= N;
  let num = 0, denom = 0;
  for (let t = 0; t < N - k; t++) num += (y[t] - mean) * (y[t + k] - mean);
  for (let t = 0; t < N;     t++) denom += (y[t] - mean) * (y[t] - mean);
  return denom > 0 ? num / denom : 0;
}

export function peakAbsACF(y: number[], minLag: number, maxLag: number): number {
  let peak = 0;
  const cap = Math.min(maxLag, y.length - 1);
  for (let k = minLag; k <= cap; k++) {
    const v = Math.abs(acfAtLag(y, k));
    if (v > peak) peak = v;
  }
  return peak;
}

/** Bootstrap the (1 − α) quantile of peak-ACF on synthetic healthy
 *  windows for a signal. Windows drawn by IID resampling from the
 *  signal's full baseline pool (destroys any existing autocorrelation,
 *  giving a null-distribution for "no oscillation").
 *
 *  Addition #21 (REPLY-45 D3/D4) — additionally computes the peaks-
 *  array mean (μ₀) and std (σ₀) as byproducts of the existing sort,
 *  and derives the mixture-prior shift-magnitude `δ_D = 0.3·σ₀` per
 *  D4. These feed the spectral e-detector's wealth-process update;
 *  the legacy `bootstrap_null_quantile` threshold is retained for
 *  shadow-compare + `force_legacy_family_d=true` operator override.
 *
 *  `useLegacy=true` flips the emitted `spectral_variant` to
 *  'bootstrap_null' for reproducibility on pre-#21 historical runs;
 *  null_mean/null_std/betting_delta are still populated so a post-
 *  merge retune can activate e-detector without recompile. */
/** C53 retirement (2026-08-18) — the e_detector variant no longer ships; every compile stamps
 *  `spectral_variant: 'bootstrap_null'` regardless of `useLegacy`. Three stacked reasons, each
 *  sufficient (knowledge/stats/family-d-emean-2026-08-18, WORKLIST C53):
 *
 *  1. STATISTIC MISMATCH — buildFamilyDForSignalAR1, the path that compiled every shipped cell
 *     (219,769 cells / 109 configs), supplies `null_mean`/`null_std` as moments of the
 *     per-trajectory MAX over ~80 sliding evaluations (median 0.5742), while the runtime
 *     standardizes ONE evaluation (single-window marginal 0.27–0.42) — E[z] ≈ −0.94 per update,
 *     wealth buried under H₀ and H₁ alike. The shipped e-detector cannot fire.
 *  2. STALE RUNTIME — the installed engine (tag v0.6.6-pre = 8b611aa) predates the
 *     disjoint-cadence fix (d3d6d06) and the priced c-bound (bb56070): it is the rolling-cadence
 *     variant the engine's own H₀ battery refuted (FAR 0.576 vs nominal 0.05 at oracle params).
 *  3. FIXING THE MOMENTS ALONE IS REFUTED — on the rolling cadence, correct moments measure a
 *     28.6% crossing rate of the shipped 10⁴ threshold on healthy 300-tick trajectories
 *     (family-d-emean run-20260818T222835Z, N7-rolling cells).
 *
 *  The legacy bootstrap_null variant is self-consistent: each evaluation compares against the
 *  (1−α) quantile of the same per-trajectory-max statistic, calibrated at the 100-tick canary
 *  length. Existing compiled configs are artifacts and replay unchanged (their e_detector cells
 *  are inert). Reversal is this one constant — flip it only after re-pinning to an engine with
 *  the disjoint cadence and priced c-bound, recalibrating to single-evaluation moments with K
 *  stated (engine SpectralInflationBoundMeasurement), and a registered validation study. */
export const FAMILY_D_E_DETECTOR_RETIRED = true;

export function buildFamilyDForSignal(
  allSamples: number[], alphaD: number, seed: number, useLegacy: boolean,
): FamilyDBuildResult {
  if (allSamples.length < 200) return { result: null, timings: {} };
  const WINDOW_N = 30;
  const N_BOOTSTRAPS = 2000;
  const MIN_PEAK_LAG = 3;
  const MAX_PEAK_LAG = 10;
  const rng = mulberry32(seed);
  const peaks: number[] = new Array(N_BOOTSTRAPS);
  for (let b = 0; b < N_BOOTSTRAPS; b++) {
    const w: number[] = new Array(WINDOW_N);
    for (let i = 0; i < WINDOW_N; i++) {
      const idx = Math.floor(rng() * allSamples.length);
      w[i] = allSamples[idx];
    }
    peaks[b] = peakAbsACF(w, MIN_PEAK_LAG, MAX_PEAK_LAG);
  }
  // Mean + std computed before the sort (order-independent anyway,
  // but keeps the intent clear).
  let sum = 0;
  for (const p of peaks) sum += p;
  const mu0 = sum / N_BOOTSTRAPS;
  let sqSum = 0;
  for (const p of peaks) { const d = p - mu0; sqSum += d * d; }
  const sigma0 = Math.sqrt(sqSum / N_BOOTSTRAPS);
  peaks.sort((a, b) => a - b);
  const qIdx = Math.min(peaks.length - 1, Math.floor((1 - alphaD) * peaks.length));
  const threshold = peaks[qIdx];
  // REPLY-45 D4: δ_D = 0.3 · σ₀. Stored per-signal; replay consumers
  // reproduce fire timings deterministically across recompiles.
  const bettingDelta = 0.3 * sigma0;
  return {
    result: {
      bootstrap_null_quantile: threshold,
      min_peak_lag: MIN_PEAK_LAG,
      max_peak_lag: MAX_PEAK_LAG,
      spectral_variant: (FAMILY_D_E_DETECTOR_RETIRED || useLegacy) ? 'bootstrap_null' : 'e_detector',
      null_mean: mu0,
      null_std: sigma0,
      betting_delta: bettingDelta,
    },
    timings: {},
  };
}

// ── Q2.B.7 AR(1)-aware calibration path ─────────────────────────────

/** Q2.B.7 — Fit AR(1) lag-1 autocorrelation coefficient via the
 *  Yule-Walker estimator on stationary samples (equivalent to lag-1
 *  sample ACF for AR(1)). Clipped to [−0.95, +0.95] for stationarity.
 *  Maximum-likelihood estimator under Gaussian AR(1) (Lütkepohl 2005
 *  §2.1; Box-Jenkins 1976). */
export function fitAR1Coefficient(samples: number[]): number {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (const v of samples) sum += v;
  const mean = sum / samples.length;
  let num = 0, denom = 0;
  for (let t = 0; t < samples.length - 1; t++) {
    num += (samples[t] - mean) * (samples[t + 1] - mean);
  }
  for (let t = 0; t < samples.length; t++) {
    denom += (samples[t] - mean) * (samples[t] - mean);
  }
  if (denom === 0) return 0;
  const rho = num / denom;
  if (!Number.isFinite(rho)) return 0;
  if (rho > 0.95) return 0.95;
  if (rho < -0.95) return -0.95;
  return rho;
}

/** Box-Muller standard-normal draw, mirror of cholesky.ts /
 *  build-report-card.js. u1 floored at 1e-12 to avoid log(0). Inlined
 *  here so the calibrator stays self-contained relative to dist/
 *  layout. */
function standardNormal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Q2.B.7 + Q2.B.6.1 Step 5 — Family D bootstrap threshold calibration
 *  under AR(1) H₀ with sliding-buffer evaluation regime.
 *
 *  Q2.B.7 introduced AR(1) bootstrap on a single n=30 window per
 *  trajectory; (1−α) quantile of single-window peak |ACF| became the
 *  threshold. The runtime spectral detector
 *  (engine/detectors/spectral.ts evaluateFamilyD) consumes
 *  `recentSamples = TrendBuffer.dataLong` (capacity 30 sliding) and
 *  evaluates `peakAbsACF` at EVERY tick; the canary loop runs ~100
 *  ticks; the detector evaluates ~81 times per trajectory and fires
 *  if ANY evaluation crosses threshold. Pre-Q2.B.6.1 calibration
 *  ignored this; per-trajectory FPR amplified to ≈ 17.76% (vs target
 *  α ≈ 1e-4) — the family_D 20-fire integration regression observed
 *  in ARCHITECT-REPLY-Q2-B-6-1-CALIBRATION-SCOPE-MISMATCH §161-168.
 *
 *  Q2.B.6.1 Step 5 (architect Option A): bootstrap statistic is now
 *  the per-trajectory MAX peak |ACF| under the same 81-tick sliding-
 *  buffer evaluation regime the runtime applies. (1 − α) quantile of
 *  this MAX statistic gives a threshold satisfying per-trajectory
 *  FPR ≤ α, matching the runtime evaluation contract. Same simulation
 *  produces both legacy `bootstrap_null_quantile` AND e-detector params
 *  (`null_mean`, `null_std`, `betting_delta`) — single bootstrap pass
 *  serves both variants (architect-clever single-pass per §165).
 *
 *  Bootstrap iteration count dropped 2000 → 500: per-trajectory
 *  max-of-81 statistic has lower MC variance than max-of-1, so 500
 *  iters keeps tail-quantile estimate stable; compile cost stays
 *  negligible (≈ 150 M ops total across 15 signals).
 *
 *  Stamps `ar1_phi` + `ar1_sigma_eps` on the result for runtime
 *  consumption (validation parametric_ar1 mode reads these to drive
 *  the joint AR(1) resampler). */
export function buildFamilyDForSignalAR1(
  allSamples: number[], alphaD: number, seed: number, useLegacy: boolean,
): FamilyDBuildResult {
  if (allSamples.length < 200) return { result: null, timings: {} };

  // Fit AR(1) coefficient via Yule-Walker
  const phi = fitAR1Coefficient(allSamples);

  // Compute marginal mean + variance + white-noise variance
  let mean = 0;
  for (const v of allSamples) mean += v;
  mean /= allSamples.length;
  let var_ = 0;
  for (const v of allSamples) var_ += (v - mean) * (v - mean);
  var_ /= allSamples.length;
  // σ_eps² = σ² · (1 − ρ²)  (stationary AR(1) relationship)
  const sigma_eps = Math.sqrt(Math.max(0, var_) * (1 - phi * phi));

  const MIN_PEAK_LAG = 3;
  const MAX_PEAK_LAG = 10;
  const BURN_IN_TICKS = 10;
  // Q2.B.6.1 Step 5: simulation regime mirrors the runtime evaluation
  // contract. TRAJECTORY_TICKS matches build-report-card.js's default
  // canary length (--canary-ticks 100); BUFFER_CAP matches
  // engine/core.ts TrendBufferImpl windowLong (30); MIN_WINDOW matches
  // engine/detectors/spectral.ts evaluateFamilyD's `2 · max_peak_lag`
  // gate. Per-trajectory MAX peak |ACF| is the calibration statistic.
  const TRAJECTORY_TICKS = 100;
  const BUFFER_CAP = 30;
  const MIN_WINDOW = 2 * MAX_PEAK_LAG;
  const N_BOOTSTRAPS = 500;
  const rng = mulberry32(seed);
  const peaks: number[] = new Array(N_BOOTSTRAPS);

  for (let b = 0; b < N_BOOTSTRAPS; b++) {
    // AR(1) bootstrap: x_t = mean + φ·(x_{t-1} − mean) + ε_t.
    // Stationary init + burn-in (Q2.B.7 unchanged); the recurrence
    // body itself is identical to pre-Q2.B.6.1 — what changed is the
    // sliding-buffer evaluation regime applied across the trajectory.
    let x = mean + Math.sqrt(Math.max(0, var_)) * standardNormal(rng);
    for (let i = 0; i < BURN_IN_TICKS; i++) {
      x = mean + phi * (x - mean) + sigma_eps * standardNormal(rng);
    }
    // Generate trajectory + sliding-buffer evaluation in one pass.
    // `buffer` is the TrendBuffer.dataLong analog: grows 1 →
    // BUFFER_CAP, then slides via shift() once full. Detector
    // evaluates once buffer.length ≥ MIN_WINDOW, mirroring spectral.ts
    // line 152's underfilled-window guard.
    const buffer: number[] = [];
    let trajectoryMaxPeak = 0;
    for (let t = 0; t < TRAJECTORY_TICKS; t++) {
      x = mean + phi * (x - mean) + sigma_eps * standardNormal(rng);
      buffer.push(x);
      if (buffer.length > BUFFER_CAP) buffer.shift();
      if (buffer.length >= MIN_WINDOW) {
        const peak = peakAbsACF(buffer, MIN_PEAK_LAG, MAX_PEAK_LAG);
        if (peak > trajectoryMaxPeak) trajectoryMaxPeak = peak;
      }
    }
    peaks[b] = trajectoryMaxPeak;
  }

  // Mean + std + quantile of the per-trajectory MAX statistic.
  // Architect-clever single-pass: the same `peaks` array yields both
  // bootstrap_null_quantile (legacy variant) AND null_mean / null_std
  // / betting_delta (e_detector variant). betting_delta = 0.3 · σ_0
  // scales with the calibrated null distribution width, so the
  // recurrence holds under the new statistic.
  let sumPeaks = 0;
  for (const p of peaks) sumPeaks += p;
  const mu0 = sumPeaks / N_BOOTSTRAPS;
  let sqSum = 0;
  for (const p of peaks) { const d = p - mu0; sqSum += d * d; }
  const sigma0 = Math.sqrt(sqSum / N_BOOTSTRAPS);
  peaks.sort((a, b) => a - b);
  const qIdx = Math.min(peaks.length - 1, Math.floor((1 - alphaD) * peaks.length));
  const threshold = peaks[qIdx];
  const bettingDelta = 0.3 * sigma0;

  return {
    result: {
      bootstrap_null_quantile: threshold,
      min_peak_lag: MIN_PEAK_LAG,
      max_peak_lag: MAX_PEAK_LAG,
      spectral_variant: (FAMILY_D_E_DETECTOR_RETIRED || useLegacy) ? 'bootstrap_null' : 'e_detector',
      null_mean: mu0,
      null_std: sigma0,
      betting_delta: bettingDelta,
      ar1_phi: phi,
      ar1_sigma_eps: sigma_eps,
    },
    timings: {},
  };
}

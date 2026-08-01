// engine/drift/baseline-drift-detector.ts — Baseline maintenance
// drift detector. Per ARCHITECT-REPLY-24 Item 1.
//
// Detects when the compiled baseline has drifted from recent live
// traffic — either because the service improved over time (trajectory
// is the new normal, old baseline is stale) or because a workload shift
// made the old calibration non-representative. Fires a recalibration
// recommendation, not a rollback; distinct from per-tick family detectors
// in three ways:
//
//   1. Scale. Operates on the ROLLING-WINDOW MEAN of recent samples,
//      not per-tick x_t. Sample-mean covariance shrinks by N (SEM
//      scaling) so drift catches small cumulative shifts that per-tick
//      Hotelling T² misses.
//   2. Semantics. "Baseline is stale" ≠ "deploy is bad." A rollback
//      gate would false-alarm on a trending-better service; the drift
//      detector recommends recalibration, preserving α integrity on
//      the next deploy cycle.
//   3. Cadence. Per-tick for the demo but production cadence is
//      recalibration-interval (weekly / monthly). α_drift = 1e-3 is
//      the per-recalibration-decision FP budget, symmetric to the
//      per-deploy α_total (REPLY-11).
//
// Math (architect-ruled, mirrors Family C's machinery):
//   μ_baseline = cell.family_C.mean_vector
//   Σ          = cell.family_C.covariance (Ledoit-Wolf shrunk)
//   μ_recent   = empirical mean of last N post-deploy samples,
//                N = min(tick_count, sampleWindowMax)
//   d²         = N · (μ_recent − μ_baseline)ᵀ · Σ⁻¹ · (μ_recent − μ_baseline)
//   threshold  = χ²(1 − α_drift, p) via Wilson-Hilferty, p = |signals|
//   Fire iff d² ≥ threshold.
//
// The √N scaling is the SEM transform: if each sample has covariance Σ,
// the sample mean has covariance Σ/N. Substituting Σ_se = Σ/N into the
// Mahalanobis formula yields d² = (Δμ)ᵀ(Σ/N)⁻¹(Δμ) = N·(Δμ)ᵀ Σ⁻¹ (Δμ).
//
// Reuses cholesky + forwardSolve from engine/detectors/_linalg.ts and
// chiSquareQuantile + FAMILY_C_SIGNALS from engine/detectors/hotelling.ts.

import type { CompiledConfig, FamilyCPerCell, BaselineCellEntry } from '../types';
import { cholesky, forwardSolve } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_linalg';
import { chiSquareQuantile, FAMILY_C_SIGNALS } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/hotelling';

/** Default per-recalibration-decision FP budget (REPLY-11 symmetric
 *  reasoning). */
export const DRIFT_ALPHA_DEFAULT = 1e-3;

/** Default rolling-window cap — recent samples beyond this are dropped
 *  from the sample mean. Picked by architect at 50 so the mean stays
 *  responsive to recent shifts. */
export const DRIFT_SAMPLE_WINDOW_MAX = 50;

export interface DriftInput {
  /** Last N post-deploy liveMetrics samples (ordered oldest → newest). */
  recentSamples: Array<Record<string, number | undefined>>;
  /** Cell context drift is evaluated against. */
  cell: { hour_of_day: number; day_of_week?: number };
  /** Optional overrides. */
  alphaDrift?: number;
  sampleWindowMax?: number;
}

export interface DriftOutput {
  drift_detected: boolean;
  mahalanobis_distance_squared: number;
  threshold: number;
  cell_key: { hour_of_day: number; day_of_week?: number };
  /** Single-cell for runway; array stays for multi-cell post-phase. */
  cells_affected: string[];
  recalibration_recommended: boolean;
  /** Actual sample count used (≤ sampleWindowMax, ≤ recentSamples.length). */
  n_samples_used: number;
  /** Populated when the detector suppressed instead of firing (e.g.,
   *  covariance not PD, cell missing). Null otherwise. */
  suppression_reason: string | null;
}

/** Look up the cell's Family C params (mean_vector + covariance).
 *  Falls back to aggregate_fallback when per-cell confidence is low. */
function lookupFamilyC(
  cfg: CompiledConfig,
  cell: { hour_of_day: number; day_of_week?: number },
): FamilyCPerCell | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  const match = bc.cells.find((c: BaselineCellEntry) => {
    if (c.key.hour_of_day !== cell.hour_of_day) return false;
    if (cell.day_of_week !== undefined && c.key.day_of_week !== undefined) {
      return c.key.day_of_week === cell.day_of_week;
    }
    return true;
  });
  if (match?.family_C) return match.family_C;
  return bc.aggregate_fallback?.family_C ?? null;
}

/** Format a cell key as "hour=H_day=D" for the cells_affected list. */
function cellKeyTag(cell: { hour_of_day: number; day_of_week?: number }): string {
  const h = 'hour=' + cell.hour_of_day;
  return cell.day_of_week !== undefined ? h + '_day=' + cell.day_of_week : h;
}

/** Compute sample mean of the drifting signals across `recentSamples`.
 *  Missing samples per signal are ignored; resulting mean is computed
 *  over however many present values are seen. */
function sampleMeans(
  samples: Array<Record<string, number | undefined>>,
  signals: readonly string[],
): { mean: number[]; n: number } {
  const p = signals.length;
  const sums = new Array<number>(p).fill(0);
  const counts = new Array<number>(p).fill(0);
  for (const s of samples) {
    for (let i = 0; i < p; i++) {
      const v = s[signals[i]];
      if (typeof v === 'number' && isFinite(v)) {
        sums[i] += v;
        counts[i] += 1;
      }
    }
  }
  // Use the MINIMUM count across signals for the effective N — the
  // SEM scaling is valid only when every signal has the same sample
  // size. If some signal is missing from some samples, the smallest
  // complete-data count is the honest N.
  let nMin = samples.length;
  const mean = new Array<number>(p).fill(0);
  for (let i = 0; i < p; i++) {
    const c = counts[i];
    if (c === 0) { mean[i] = 0; continue; }
    mean[i] = sums[i] / c;
    if (c < nMin) nMin = c;
  }
  return { mean, n: nMin };
}

/** Relative-deviation transform matching Family C's r = (x − μ) / μ.
 *  Falls back to additive (x − μ) when |μ| is below float precision. */
function relativeDeviationMean(recentMean: number[], baselineMean: number[]): number[] {
  const p = baselineMean.length;
  const r = new Array<number>(p);
  for (let i = 0; i < p; i++) {
    const b = baselineMean[i];
    r[i] = Math.abs(b) > 1e-12 ? (recentMean[i] - b) / b : (recentMean[i] - b);
  }
  return r;
}

/** Compute the drift detector's Mahalanobis distance squared, with SEM
 *  scaling d² = N · rᵀ Σ⁻¹ r via Cholesky. Returns null if Σ is not PSD. */
export function driftDistanceSquared(
  recentMean: number[],
  baselineMean: number[],
  covariance: number[][],
  n: number,
): number | null {
  if (n <= 0) return null;
  const r = relativeDeviationMean(recentMean, baselineMean);
  const L = cholesky(covariance);
  if (!L) return null;
  // y = L⁻¹ r ; d² = n · ||y||²
  const y = forwardSolve(L, r);
  let sum = 0;
  for (const v of y) sum += v * v;
  return n * sum;
}

/** Main entry: compute drift verdict for one cell. Returns null when
 *  the baseline cells block is missing entirely (detector inapplicable);
 *  returns a filled DriftOutput with suppression_reason set for
 *  recoverable misses (cell not found, covariance not PD, zero samples). */
export function evaluateBaselineDrift(
  cfg: CompiledConfig,
  input: DriftInput,
): DriftOutput | null {
  if (!cfg.baseline_cells) return null;
  const params = lookupFamilyC(cfg, input.cell);
  const cellTag = cellKeyTag(input.cell);
  const alpha = input.alphaDrift ?? DRIFT_ALPHA_DEFAULT;
  const maxN = input.sampleWindowMax ?? DRIFT_SAMPLE_WINDOW_MAX;

  // Threshold derivation — uses |FAMILY_C_SIGNALS| degrees of freedom
  // even when params is missing (for a stable "would have fired"
  // threshold value to report back).
  const p = FAMILY_C_SIGNALS.length;
  const threshold = chiSquareQuantile(1 - alpha, p);

  const base: DriftOutput = {
    drift_detected: false,
    mahalanobis_distance_squared: 0,
    threshold,
    cell_key: input.cell,
    cells_affected: [],
    recalibration_recommended: false,
    n_samples_used: 0,
    suppression_reason: null,
  };

  if (!params) {
    return Object.assign({}, base, { suppression_reason: 'cell_not_found' });
  }

  // Roll-window-cap the samples to the most recent maxN.
  const windowed = input.recentSamples.slice(Math.max(0, input.recentSamples.length - maxN));
  const { mean: recentMean, n } = sampleMeans(windowed, FAMILY_C_SIGNALS);
  if (n <= 0) {
    return Object.assign({}, base, { suppression_reason: 'no_samples' });
  }

  const d2 = driftDistanceSquared(recentMean, params.mean_vector, params.covariance, n);
  if (d2 === null) {
    return Object.assign({}, base, {
      n_samples_used: n,
      suppression_reason: 'covariance_not_pd',
    });
  }

  const fired = d2 >= threshold;
  return {
    drift_detected: fired,
    mahalanobis_distance_squared: d2,
    threshold,
    cell_key: input.cell,
    cells_affected: fired ? [cellTag] : [],
    recalibration_recommended: fired,
    n_samples_used: n,
    suppression_reason: null,
  };
}

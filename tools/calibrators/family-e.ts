// tools/calibrators/family-e.ts — End-phase slice 3c (D-54-3).
//
// Family E — conformal calibration (3 variants):
//   - unweighted: parametric Gaussian bootstrap of Mahalanobis norms.
//   - weighted: Addition #19 weighted-quantile variant (legacy path
//     retained for shadow-compare + `force_legacy_family_e`).
//   - weighted_e_value: Addition #22 default. REPLY-46b hedged-
//     indicator e-value betting form with reverse-cumulative weights
//     precomputed for O(log M) runtime lookup.
//
// Option 3 side-effect-free. The per-cell builders don't touch module-
// level timing state — the caller in tools/calibrate.ts wraps the
// whole Family E pipeline with `hrNow()` timing (conformal_
// calibration_ns) so returning `timings: {}` here keeps byte-identity
// with pre-3c. Slice-3b family-d uses the same convention.

import type {
  BaselineBundle, CompilerOptions, ConformalParams, FamilyCPerCell,
} from '../../engine/types';
import { mulberry32, gaussian, choleskyLocal } from './_shared.js';

// ── Constants ────────────────────────────────────────────────────

/** Number of parametric-bootstrap calibration samples per cell. Sized so
 *  the minimum observable p-value 1/(M+1) ≈ 5e-5 resolves α_family_E = 1e-4. */
export const FAMILY_E_CALIBRATION_SIZE = 20000;

/** Deterministic base seed for per-cell calibration bootstrap. */
export const FAMILY_E_BOOTSTRAP_SEED = 0xFA01E >>> 0;

/** REPLY-38 Cluster 2 gate (2) — ESS threshold. Below this the weighted
 *  quantile's MC variance at α=1e-4 exceeds the unweighted path. */
export const FAMILY_E_ESS_THRESHOLD = 0.9;

/** REPLY-38 Cluster 2 gate (1) — short-span baselines can't carry
 *  meaningful temporal signal for time-decay weighting. */
export const FAMILY_E_MIN_SPAN_DAYS = 7;

// ── Types ────────────────────────────────────────────────────────

// Post-CODE-COMPLETE Phase 2 — `FamilyEVariantSelector` type +
// `resolveFamilyEVariantSelector` function moved to
// tools/calibrators/effective-config.ts (shared module for config-
// resolution helpers). Facade re-exports below preserve backward-
// compat for consumers that imported either symbol from family-e
// directly. Locating the type in effective-config.ts also breaks the
// family-e ↔ effective-config import cycle cleanly.
export type { FamilyEVariantSelector } from './effective-config.js';
export { resolveFamilyEVariantSelector } from './effective-config.js';
import type { FamilyEVariantSelector } from './effective-config.js';

export interface FamilyETimings {
  // Family E's timing is captured at the call-site wrap in tools/
  // calibrate.ts (`conformal_calibration_ns`), matching pre-3c
  // behaviour. Kept empty for uniform shape across families.
}

export interface FamilyEBuildResult {
  result: ConformalParams | null;
  timings: FamilyETimings;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Addition #19 — compute the baseline's temporal span in days from a
 *  `BaselineBundle`. Assumes 1 tick = 1 hour (matches the synthetic
 *  generator's cadence). Uses the maximum-length run across signals as
 *  the span; returns 14 as a safe default if no tick series are present. */
export function computeBaselineSpanDays(bundle: BaselineBundle): number {
  let maxTicks = 0;
  for (const run of bundle.runs) {
    for (const sig of Object.keys(run.signal_series)) {
      const n = run.signal_series[sig].length;
      if (n > maxTicks) maxTicks = n;
    }
  }
  const HOURS_PER_DAY = 24;
  return maxTicks > 0 ? maxTicks / HOURS_PER_DAY : 14;
}

/** Deterministic per-cell seed for Family E calibration bootstrap so
 *  cells' calibration distributions vary independently. */
export function familyESeedForCell(key: Record<string, string | number>): number {
  let h = FAMILY_E_BOOTSTRAP_SEED;
  for (const [k, v] of Object.entries(key).sort()) {
    const s = `${k}=${v};`;
    for (let i = 0; i < s.length; i++) h = ((h + s.charCodeAt(i)) * 1103515245 + 12345) >>> 0;
  }
  return h >>> 0;
}

/** Closed-form expected ESS under uniform-age sample ages
 *  `a ~ Uniform[0, span]` with weight `w = exp(-λ·a)`:
 *    E[w]  = (1 − e^{−λs}) / (λs)
 *    E[w²] = (1 − e^{−2λs}) / (2λs)
 *    ESS   = M · E[w]² / E[w²]
 *          = M · 2·(1 − e^{−λs})² / (λs · (1 − e^{−2λs}))
 *  Degenerates to M when λs → 0 (uniform weights). */
export function expectedESSUnderUniformAge(lambda: number, spanDays: number, M: number): number {
  const ls = lambda * spanDays;
  if (ls <= 0) return M;
  const oneMinusExpLs = 1 - Math.exp(-ls);
  const oneMinusExp2Ls = 1 - Math.exp(-2 * ls);
  if (oneMinusExp2Ls <= 0) return M;
  return M * (2 * oneMinusExpLs * oneMinusExpLs) / (ls * oneMinusExp2Ls);
}

// (resolveFamilyEVariantSelector moved to effective-config.ts — see
//  the facade re-export at the top of this file.)

// ── Unweighted variant ───────────────────────────────────────────

/** Parametric Gaussian bootstrap of Mahalanobis norms. Pre-#19 default. */
export function buildFamilyEPerCellUnweighted(
  famC: FamilyCPerCell,
  seed: number,
): ConformalParams | null {
  const L = choleskyLocal(famC.covariance);
  if (!L) return null;
  const p = famC.mean_vector.length;
  const rng = mulberry32(seed);
  const M = FAMILY_E_CALIBRATION_SIZE;
  const scores: number[] = new Array(M);
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) {
      const w = gaussian(rng);
      sum += w * w;
    }
    scores[m] = Math.sqrt(sum);
  }
  scores.sort((a, b) => a - b);
  return {
    kind: 'unweighted',
    calibration_scores: scores,
    calibration_method: 'parametric_gaussian_bootstrap',
  };
}

// ── Weighted / weighted-e-value variants (unified entry) ─────────

/** Build Family E conformal calibration for a cell. Dispatches to
 *  unweighted / weighted / weighted_e_value per the variant selector
 *  + REPLY-38 Cluster 2 weighting-beneficial gate (span ≥ 7 days AND
 *  expected-ESS ≥ 0.9·M). Pure function; no module state. */
export function buildFamilyEPerCell(
  famC: FamilyCPerCell,
  seed: number,
  halflifeDays: number,
  baselineSpanDays: number,
  variant: FamilyEVariantSelector,
): ConformalParams | null {
  if (variant === 'force_unweighted') {
    return buildFamilyEPerCellUnweighted(famC, seed);
  }

  // REPLY-38 Cluster 2 — weighting-beneficial heuristic. 'force_
  // weighted_e_value' bypasses the ESS+span gate; 'auto' and
  // 'force_weighted' preserve the pre-R3 fallback to unweighted.
  if (variant !== 'force_weighted_e_value') {
    if (baselineSpanDays < FAMILY_E_MIN_SPAN_DAYS) {
      return buildFamilyEPerCellUnweighted(famC, seed);
    }
    const proposedHalflife = Math.min(baselineSpanDays / 2, 14);
    const proposedLambda = Math.log(2) / proposedHalflife;
    const expectedESS = expectedESSUnderUniformAge(
      proposedLambda, baselineSpanDays, FAMILY_E_CALIBRATION_SIZE,
    );
    if (expectedESS < FAMILY_E_ESS_THRESHOLD * FAMILY_E_CALIBRATION_SIZE) {
      return buildFamilyEPerCellUnweighted(famC, seed);
    }
  }

  const L = choleskyLocal(famC.covariance);
  if (!L) return null;
  const p = famC.mean_vector.length;
  const rng = mulberry32(seed);
  const M = FAMILY_E_CALIBRATION_SIZE;
  const scores: number[] = new Array(M);
  const weights: number[] = new Array(M);
  const lambda = Math.log(2) / halflifeDays;
  const span = baselineSpanDays > 0 ? baselineSpanDays : 1;
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) {
      const w = gaussian(rng);
      sum += w * w;
    }
    scores[m] = Math.sqrt(sum);
    const ageDays = rng() * span;
    weights[m] = Math.exp(-lambda * ageDays);
  }
  const idx = new Array(M);
  for (let i = 0; i < M; i++) idx[i] = i;
  idx.sort((a, b) => scores[a] - scores[b]);
  const sortedScores: number[] = new Array(M);
  const sortedWeights: number[] = new Array(M);
  let sumW = 0, sumWSq = 0;
  for (let k = 0; k < M; k++) {
    const i = idx[k];
    sortedScores[k] = scores[i];
    sortedWeights[k] = weights[i];
    sumW += weights[i];
    sumWSq += weights[i] * weights[i];
  }
  const ess = sumWSq > 0 ? (sumW * sumW) / sumWSq : M;
  if (ess < FAMILY_E_ESS_THRESHOLD * M) {
    console.warn(
      `[calibrate] Family E cell (seed=${seed}): ESS=${ess.toFixed(1)} < `
      + `${FAMILY_E_ESS_THRESHOLD}·M=${(FAMILY_E_ESS_THRESHOLD * M).toFixed(0)}; `
      + `half-life=${halflifeDays.toFixed(2)}d may be over-aggressive relative to baseline span=${span.toFixed(2)}d`,
    );
  }
  if (variant === 'force_weighted') {
    return {
      kind: 'weighted',
      scores: sortedScores,
      weights: sortedWeights,
      halflife_days: halflifeDays,
      effective_sample_size: ess,
      calibration_method: 'weighted_parametric_gaussian_bootstrap',
    };
  }
  // Addition #22 / REPLY-46b default — weighted-e-value with
  // reverse-cumulative weights for O(log M) runtime lookup.
  const cumulative_weights_above = new Array<number>(M);
  let runningTail = 0;
  for (let k = M - 1; k >= 0; k--) {
    runningTail += sortedWeights[k];
    cumulative_weights_above[k] = runningTail;
  }
  return {
    kind: 'weighted_e_value',
    scores: sortedScores,
    weights: sortedWeights,
    cumulative_weights_above,
    total_weight: sumW,
    halflife_days: halflifeDays,
    effective_sample_size: ess,
    calibration_method: 'weighted_parametric_gaussian_bootstrap_e_value',
  };
}

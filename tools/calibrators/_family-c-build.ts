// tools/calibrators/_family-c-build.ts — main per-cell Family C build
// entry point + its result/diagnostic/timing shapes + safe-Hotelling
// constants. Split from family-c.ts (End-phase slice 3c, D-54-3);
// computation preserved VERBATIM, with the formerly-monolithic
// buildFamilyCPerCell body decomposed into contiguous <100-line helpers
// (identical behavior). Re-exported through the family-c.ts facade so the
// public surface is unchanged.

import type {
  CompilerOptions, FamilyCPerCell, OutlierDetection,
} from '../../engine/types';
import { choleskyLocal } from './_shared.js';
import {
  generateBaselinePool, baselinePoolSeed,
} from '../../engine/detectors/sequential-mmd.js';
import {
  computeRffFeatureMap, applyRffFeatureMap, rffCellSeed, RFF_DEFAULT_DIM,
} from '../../engine/detectors/family-c-rff.js';
import {
  columnMean, relativeDeviations, ledoitWolfShrinkage, chiSqQuantile975,
  logDetLocal, mahalanobisSqFromL, isPSDWithTolerance,
  choleskyLowerTriangular, PSD_TOLERANCE, OFFDIAG_REL_TOLERANCE,
} from './_family-c-covariance.js';
import {
  FASTMCD_DEFAULT_ALPHA, D6B_LAMBDA_THRESHOLD, D6B_OUTLIER_FRACTION_THRESHOLD,
  buildFamilyCPerCellMCD, buildFamilyCPerCellMRCD,
} from './_family-c-mcd.js';
import { buildMMDParams, MMD_MIN_BASELINE_SAMPLES } from './_family-c-mmd.js';

// ── Safe-Hotelling precompute ───────────────────────────────────

/** Addition #20 (ARCHITECT-REPLY-43b) — default shrink fraction for the
 *  safe-Hotelling mixture-prior derivation `τ² = c · trace(Σ) / p`. */
export const FAMILY_C_DEFAULT_SHRINK_FRACTION = 0.03;

/** Q67 SPEC Phase-3.d.B § Q67.4-ter — canonical λ_max default per
 *  Shekhar-Ramdas-2023 `ONSstrategy(F, lambda_max=0.5)`. Architecturally
 *  fixed (NOT B-dependent — v2 amendment removed B). */
export const FAMILY_C_BETTING_LAMBDA_MAX = 0.5;

/** Q67 SPEC Phase-3.d.B — synthesized P-side baseline pool size for
 *  the canonical betting-e-process detector. Mirrors engine
 *  BASELINE_POOL_SIZE (sequential-mmd.ts) so the canonical and Option-B
 *  paths share an identical P-side reference under shadow-compare. */
export const FAMILY_C_BETTING_BASELINE_POOL_SIZE = 500;

// ── D6b diagnostic + timings shapes ─────────────────────────────

/** REPLY-50 Q2 diagnostic — per-cell λ + outlier-fraction record for
 *  every MCD-eligible cell. */
export interface D6bCellDiagnostic {
  lambda: number;
  outlier_fraction: number;
  n_rows: number;
  skipped: boolean;
}

export interface FamilyCTimings {
  /** Whole-call buildFamilyCPerCell cost (covers MCD + MRCD + LW + MMD
   *  params construction + safe-Hotelling + e-MMD). */
  cov_estimation_ns: bigint;
  /** Zoom-in on the MMD null-quantile bootstrap step. Sits inside
   *  cov_estimation_ns by construction (not additive). */
  mmd_bootstrap_ns: bigint;
  /** Count of cells where MMD null-quantile was deliberately skipped
   *  (post-Ville-full default — betting-e-process variant ignores it). */
  mmd_bootstrap_skipped_cells: number;
  /** Count of cells where D6b low-variance auto-skip demoted MCD to LW. */
  mcd_skipped_low_variance_cells: number;
}

export interface FamilyCDiagnostics {
  /** One entry per MCD-eligible cell; empty on MRCD/LW paths. */
  d6b_cells: D6bCellDiagnostic[];
}

export interface FamilyCBuildResult {
  result: FamilyCPerCell;
  timings: FamilyCTimings;
  diagnostics: FamilyCDiagnostics;
}

// ── Main entry helpers ──────────────────────────────────────────

/** Method routing — covariance_method_override / dimension / sample
 *  thresholds. Verbatim block from the original entry point. */
function chooseCovarianceMethod(
  p: number,
  n: number,
  opts: CompilerOptions,
): 'ledoit_wolf' | 'mcd' | 'mrcd' {
  const methodOverride = opts.covariance_method_override;
  if (methodOverride) return methodOverride;
  if (p > 20) return 'ledoit_wolf';
  if (n >= Math.max(5 * p, 200)) return 'mcd';
  return 'mrcd';
}

/** Ledoit-Wolf cell construction (the buildLWCell closure, lifted to a
 *  free function taking its captured `rows` explicitly). */
function buildLWCell(rows: number[][], skipReason?: 'low_variance'): FamilyCPerCell {
  const mean = columnMean(rows);
  const Z = relativeDeviations(rows, mean);
  const { cov, lambda } = ledoitWolfShrinkage(Z);
  const out: FamilyCPerCell = {
    mean_vector: mean,
    covariance: cov,
    covariance_shrinkage: lambda,
    covariance_method: 'ledoit_wolf',
  };
  if (skipReason) out.mcd_skip_reason = skipReason;
  return out;
}

/** MCD path including the D6b low-variance auto-skip diagnostic. Mutates
 *  `diagnostics` / `timings` exactly as the original inline block did and
 *  returns the chosen cell + outlier detection. */
function runMcdPath(
  rows: number[][],
  p: number,
  n: number,
  mcdAlpha: number,
  opts: CompilerOptions,
  diagnostics: FamilyCDiagnostics,
  timings: FamilyCTimings,
): { cell: FamilyCPerCell; outlier: OutlierDetection | null } {
  const methodOverride = opts.covariance_method_override;
  const lwCell = buildLWCell(rows);
  const lambda = lwCell.covariance_shrinkage ?? 1;
  let outlierFraction = 1;
  if (lambda < D6B_LAMBDA_THRESHOLD) {
    const L = choleskyLocal(lwCell.covariance);
    if (L) {
      const cutoff = chiSqQuantile975(p);
      const Z = relativeDeviations(rows, lwCell.mean_vector);
      const zeroOrigin = new Array<number>(p).fill(0);
      let outlierCount = 0;
      for (let i = 0; i < n; i++) {
        if (mahalanobisSqFromL(Z[i], zeroOrigin, L) > cutoff) outlierCount += 1;
      }
      outlierFraction = outlierCount / n;
    }
  }
  const d6bEnabled = opts.enable_d6b_mcd_skip !== false;
  const willSkip = d6bEnabled
    && !methodOverride
    && lambda < D6B_LAMBDA_THRESHOLD
    && outlierFraction < D6B_OUTLIER_FRACTION_THRESHOLD;
  diagnostics.d6b_cells.push({
    lambda, outlier_fraction: outlierFraction, n_rows: n, skipped: willSkip,
  });
  if (willSkip) {
    timings.mcd_skipped_low_variance_cells += 1;
    return { cell: { ...lwCell, mcd_skip_reason: 'low_variance' }, outlier: null };
  }
  const r = buildFamilyCPerCellMCD(rows, mcdAlpha);
  if (r) return { cell: r.cell, outlier: r.outlier };
  const fr = buildFamilyCPerCellMRCD(rows, mcdAlpha);
  return { cell: fr.cell, outlier: fr.outlier };
}

/** REPLY-38/REPLY-41 PSD + off-diagonal nondegeneracy gates. Returns the
 *  (possibly LW-fallback) cell + outlier; behavior verbatim. */
function applyCovarianceGates(
  cell: FamilyCPerCell,
  outlier: OutlierDetection | null,
  rows: number[][],
  p: number,
  n: number,
  key?: Record<string, string | number>,
): { cell: FamilyCPerCell; outlier: OutlierDetection | null } {
  // REPLY-38 Cluster 1 — PSD gate.
  if (cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd') {
    if (!isPSDWithTolerance(cell.covariance, PSD_TOLERANCE)) {
      const keyStr = key ? JSON.stringify(key) : '(aggregate)';
      console.warn(
        `[calibrate] ${cell.covariance_method} produced non-PSD covariance for cell ${keyStr}; `
        + `falling back to Ledoit-Wolf`,
      );
      cell = buildLWCell(rows);
      outlier = null;
    }
  }

  // REPLY-41 Option 2 — off-diagonal nondegeneracy gate.
  if (cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd') {
    let diagAbsSum = 0;
    for (let i = 0; i < p; i++) diagAbsSum += Math.abs(cell.covariance[i][i]);
    const meanDiag = diagAbsSum / p;
    const epsOffDiag = OFFDIAG_REL_TOLERANCE * meanDiag;
    let offDiagMax = 0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        if (i === j) continue;
        const v = Math.abs(cell.covariance[i][j]);
        if (v > offDiagMax) offDiagMax = v;
      }
    }
    if (offDiagMax < epsOffDiag && n >= p + 1) {
      const keyStr = key ? JSON.stringify(key) : '(aggregate)';
      console.warn(
        `[calibrate] ${cell.covariance_method} produced covariance with stripped `
        + `cross-correlations for cell ${keyStr} `
        + `(off_diag_max=${offDiagMax.toExponential(2)}, `
        + `diag_mean=${meanDiag.toExponential(2)}, n=${n}); `
        + `falling back to Ledoit-Wolf.`,
      );
      const lw = buildLWCell(rows);
      cell = { ...lw, covariance_method: 'ledoit_wolf_from_degenerate_mrcd' };
      outlier = null;
    }
  }
  return { cell, outlier };
}

/** Safe-Hotelling mixture-prior precompute (Addition #20). Stamps
 *  hotelling_variant + safe_hotelling_params on `cell` in place. */
function stampSafeHotellingParams(
  cell: FamilyCPerCell,
  opts: CompilerOptions,
  alphaMMD?: number,
): void {
  const pp = cell.covariance.length;
  const shrinkFraction = opts.family_c_shrink_fraction ?? FAMILY_C_DEFAULT_SHRINK_FRACTION;
  let traceSigma = 0;
  for (let i = 0; i < pp; i++) traceSigma += cell.covariance[i][i];
  const tauSquared = shrinkFraction * traceSigma / pp;
  const sigmaPlus: number[][] = new Array(pp);
  for (let i = 0; i < pp; i++) {
    sigmaPlus[i] = cell.covariance[i].slice();
    sigmaPlus[i][i] += tauSquared;
  }
  const logDetSigma = logDetLocal(cell.covariance);
  const logDetSigmaPlus = logDetLocal(sigmaPlus);
  if (logDetSigma !== null && logDetSigmaPlus !== null) {
    const alphaSafeHotelling = alphaMMD !== undefined ? alphaMMD : 1e-4;
    cell.hotelling_variant = 'safe_test';
    cell.safe_hotelling_params = {
      tau_squared: tauSquared,
      alpha: alphaSafeHotelling,
      precompiled_log_det_shrink: 0.5 * (logDetSigmaPlus - logDetSigma),
      shrink_fraction: shrinkFraction,
    };
  } else {
    cell.hotelling_variant = 'chi_square';
    cell.safe_hotelling_params = null;
  }
}

/** e-MMD + canonical betting-e-process (incl. Q72 RFF feature-map)
 *  precompute. Stamps e_mmd_params + betting_e_process_params on `cell`
 *  in place. Verbatim from the original `if (cell.mmd_params)` block. */
function stampEMmdAndBettingParams(
  cell: FamilyCPerCell,
  n: number,
  alphaMMD?: number,
  key?: Record<string, string | number>,
): void {
  if (!cell.mmd_params) {
    cell.e_mmd_params = null;
    cell.betting_e_process_params = null;
    return;
  }
  const m = n;
  const alphaEMmd = alphaMMD !== undefined ? alphaMMD : 1e-4;
  cell.e_mmd_params = {
    kernel_baseline_mean_norm_squared: (cell.mmd_params.baseline_baseline_sum + m) / (m * m),
    alpha: alphaEMmd,
    running_moment_window: 30,
  };
  // Q67 SPEC Phase-3.d.B § Q67.1 — canonical Shekhar-Ramdas-2023
  // betting-e-process per-cell hyperparameters. Bandwidth reuses the
  // already-derived median-heuristic value from cell.mmd_params (same
  // Gaussian RBF kernel; same per-cell baseline pairwise distances).
  // Canonical hyperparameters per § Q67.4-ter:
  //   lambda_max = 0.5         (canonical default; two-sided clamp)
  //   ons_initial_lambda = 0   (start with no bet)
  //   betting_strategy = 'ons' (canonical SLICE 1 pick; GRAPA/KT
  //                             tagged future Phase-3.d.B.b)
  //   baseline_sample_size = FAMILY_C_BETTING_BASELINE_POOL_SIZE
  //                          (matches engine BASELINE_POOL_SIZE = 500
  //                           so the synthesized P-side pool stays
  //                           identical between the canonical and
  //                           bootstrap-null detectors under shadow-
  //                           compare; § Q67.4-ter "Witness paired-
  //                           samples vs streaming adaptation")
  // Q72 SLICE 2 (Phase 3.A.4) — RFF feature-map stamping per cell.
  // Architect Phase 3.A pick: D = 256 default; runtime-side feature-
  // map regeneration (rff_seed in compiled config) avoids ~3 MB ω
  // matrix bloat per substrate. Calibrator computes μ_P^φ over the
  // SAME synthetic Cholesky·noise baseline pool the runtime generates
  // (same seed, same generator) so calibration-time and runtime-time
  // P-side reference agree exactly.
  const rffDim = RFF_DEFAULT_DIM;
  const rffSeed = rffCellSeed({
    hour_of_day: typeof key === 'object' && key && 'hour_of_day' in key
      ? (key as { hour_of_day: number }).hour_of_day : 0,
    day_of_week: typeof key === 'object' && key && 'day_of_week' in key
      ? (key as { day_of_week?: number }).day_of_week : undefined,
    tier: typeof key === 'object' && key && 'tenant_tier' in key
      ? (key as { tenant_tier?: string }).tenant_tier : undefined,
  });
  // Re-derive baseline pool deterministically (mirror runtime).
  const rffPool = generateBaselinePool(
    cell, FAMILY_C_BETTING_BASELINE_POOL_SIZE,
    baselinePoolSeed({
      hour_of_day: typeof key === 'object' && key && 'hour_of_day' in key
        ? (key as { hour_of_day: number }).hour_of_day : 0,
      day_of_week: typeof key === 'object' && key && 'day_of_week' in key
        ? (key as { day_of_week?: number }).day_of_week : undefined,
    }),
  );
  const fm = computeRffFeatureMap(
    rffSeed, rffDim, cell.mean_vector.length, cell.mmd_params.bandwidth,
  );
  // μ_P^φ = (1/N_P) Σ_i φ(X_{P,i}). Compute as Float64Array for bit-
  // stable summation; serialize to number[] for compiled config JSON.
  const muPhi = new Float64Array(rffDim);
  for (const x of rffPool) {
    const phi = applyRffFeatureMap(x, fm);
    for (let i = 0; i < rffDim; i++) muPhi[i] += phi[i];
  }
  const N_P = rffPool.length;
  const baseline_rff_mean = new Array<number>(rffDim);
  for (let i = 0; i < rffDim; i++) baseline_rff_mean[i] = muPhi[i] / N_P;

  cell.betting_e_process_params = {
    kernel_bandwidth_sigma: cell.mmd_params.bandwidth,
    lambda_max: FAMILY_C_BETTING_LAMBDA_MAX,
    betting_strategy: 'ons',
    ons_initial_lambda: 0,
    alpha: alphaEMmd,
    baseline_sample_size: FAMILY_C_BETTING_BASELINE_POOL_SIZE,
    // Q72 SLICE 2 RFF architectural-fix per Phase 3.A; retires the
    // Q67 § Q67.4-ter biased streaming kernel-of-empirical-mean
    // witness construction. Runtime regenerates ω + b deterministically
    // from rff_seed; baseline_rff_mean precomputed here so per-tick
    // cost stays O(D · d) instead of O(N_P · D · d).
    rff_seed: rffSeed,
    rff_dim: rffDim,
    baseline_rff_mean,
  };
}

// ── Main entry: per-cell Family C build ───────────────────────────

/** Build one FamilyCPerCell. Returns the cell alongside timings + D6b
 *  diagnostics so the caller can accumulate module-free aggregators.
 *
 *  See tools/calibrate.ts (pre-3c) for the architectural commentary that
 *  used to live on this function's doc string; kept terse here to keep
 *  the module scanner-friendly. */
export function buildFamilyCPerCell(
  rows: number[][],
  opts: CompilerOptions = {},
  key?: Record<string, string | number>,
  alphaMMD?: number,
): FamilyCBuildResult {
  const tCell = process.hrtime.bigint();
  const timings: FamilyCTimings = {
    cov_estimation_ns: 0n,
    mmd_bootstrap_ns: 0n,
    mmd_bootstrap_skipped_cells: 0,
    mcd_skipped_low_variance_cells: 0,
  };
  const diagnostics: FamilyCDiagnostics = { d6b_cells: [] };

  const p = rows[0].length;
  const n = rows.length;
  const mcdAlpha = opts.mcd_alpha ?? FASTMCD_DEFAULT_ALPHA;
  const useLegacyC = opts.force_legacy_family_c === true;
  const chosen = chooseCovarianceMethod(p, n, opts);

  let cell: FamilyCPerCell;
  let outlier: OutlierDetection | null = null;

  if (chosen === 'mcd') {
    const r = runMcdPath(rows, p, n, mcdAlpha, opts, diagnostics, timings);
    cell = r.cell; outlier = r.outlier;
  } else if (chosen === 'mrcd') {
    const r = buildFamilyCPerCellMRCD(rows, mcdAlpha);
    cell = r.cell; outlier = r.outlier;
  } else {
    cell = buildLWCell(rows);
  }

  ({ cell, outlier } = applyCovarianceGates(cell, outlier, rows, p, n, key));

  // D7: MMD precompute.
  if (
    (cell.covariance_method === 'mcd' || cell.covariance_method === 'mrcd')
    && key && alphaMMD !== undefined && n >= MMD_MIN_BASELINE_SAMPLES
  ) {
    const mmd = buildMMDParams(rows, alphaMMD, key, { skipBootstrap: !useLegacyC });
    cell.mmd_params = mmd.result ?? null;
    timings.mmd_bootstrap_ns += mmd.timings.mmd_bootstrap_ns;
    timings.mmd_bootstrap_skipped_cells += mmd.timings.mmd_bootstrap_skipped_cells;
  } else {
    cell.mmd_params = null;
  }
  cell.outlier_detection = outlier;

  // Addition #20 — variant defaults + e-process precomputes.
  // Q68 Phase-3.d.C consolidation: `mmd_variant` field retired from schema;
  // calibrator no longer stamps it (Family C MMD dispatch is unconditional
  // Ville-bounded variant via betting_e_process_params presence guard).
  if (useLegacyC) {
    cell.hotelling_variant = 'chi_square';
    cell.safe_hotelling_params = null;
    cell.e_mmd_params = null;
    cell.betting_e_process_params = null;
  } else {
    stampSafeHotellingParams(cell, opts, alphaMMD);
    stampEMmdAndBettingParams(cell, n, alphaMMD, key);

    // Per ARCHITECT-REPLY-52gi §TPM-ask-2 — emit Cholesky factor of the
    // per-cell covariance so validation resamplers can generate joint
    // Gaussian samples that preserve the calibrated multivariate
    // covariance structure (closes the parametric-resampler diagonal-Σ
    // bug surfaced by Step-6 wrapper-bypass diff).
    cell.cholesky_L = choleskyLowerTriangular(cell.covariance);
  }

  timings.cov_estimation_ns += process.hrtime.bigint() - tCell;
  return { result: cell, timings, diagnostics };
}

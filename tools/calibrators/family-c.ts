// tools/calibrators/family-c.ts — End-phase slice 3c (D-54-3).
//
// Per-cell Family C calibration (MCD / MRCD / Ledoit-Wolf routing +
// safe-Hotelling precompute + e-MMD precompute + D6b MCD-skip
// diagnostic). Option 3 side-effect-free pattern per ARCHITECT-
// REPLY-54b: pure function returning { result, timings, diagnostics };
// caller accumulates into aggregators local to tools/calibrate.ts
// compile() rather than module-level state.
//
// Anti-scope (REPLY-54b): no detector math changes. Croux-Haesbroeck
// c_α consistency correction is F1 (task #28), post-merge against
// this module.
//
// ── Facade ──────────────────────────────────────────────────────────
// This file was a 1372-line god-file; it has been decomposed into
// cohesive `_family-c-*.ts` submodules. The computation moved VERBATIM —
// no detector math changed. This facade re-exports the EXACT public
// surface so every name remains importable from `family-c` (and the
// committed `family-c.js`) as before. Submodules:
//   _family-c-covariance.ts — covariance / numerical / PSD-gate helpers
//   _family-c-mcd.ts        — FastMCD / MRCD / consistency correction
//   _family-c-mmd.ts        — sequential-MMD compile-time precompute
//   _family-c-hotelling.ts  — Q2.B.6.2 sliding-buffer recalibration
//   _family-c-build.ts      — main buildFamilyCPerCell + result shapes

export {
  // Covariance helpers
  columnMean, relativeDeviations, sampleCovariance, ledoitWolfShrinkage,
  applyAggregateShrinkage,
  // Numerical helpers
  chiSqQuantile975, logDetCholesky, logDetLocal, mahalanobisSqFromL,
  mahalanobis,
  // PSD / off-diagonal gates
  PSD_TOLERANCE, OFFDIAG_REL_TOLERANCE, isPSDWithTolerance,
} from './_family-c-covariance.js';

export {
  // FastMCD + MRCD constants
  FASTMCD_N_INITIAL_SUBSETS, FASTMCD_N_WARM_SUBSETS, FASTMCD_CSTEP_LIMIT,
  FASTMCD_TOP_N_FOR_FULL, FASTMCD_DEFAULT_ALPHA, FASTMCD_DEFAULT_SEED,
  D6B_LAMBDA_THRESHOLD, D6B_OUTLIER_FRACTION_THRESHOLD,
  // FastMCD + MRCD functions
  cStep, initialSubsetEstimate, computeLWWarmSeed, fastMCD, mcdReweight,
  consistencyCorrectionFactor, buildFamilyCPerCellMCD,
  buildFamilyCPerCellMRCD, initialFallbackMCD,
} from './_family-c-mcd.js';
export type { FastMCDResult, FastMCDWarmSeed } from './_family-c-mcd.js';

export {
  // Sequential MMD precompute
  medianPairwiseDistance, rbfKernel, mmdBaselineBaselineSum,
  mmdBootstrapNullQuantile, mmdSeedForCell, buildMMDParams,
  MMD_BOOTSTRAP_SEED_BASE, MMD_WINDOW_SIZE, MMD_BOOTSTRAP_N,
  MMD_MIN_BASELINE_SAMPLES,
} from './_family-c-mmd.js';
export type { MMDParamsBuildResult } from './_family-c-mmd.js';

export {
  FAMILY_C_HOTELLING_BOOTSTRAP_SEED,
  bootstrapHotellingSlidingBufferThreshold,
} from './_family-c-hotelling.js';

export {
  // Safe-Hotelling precompute constants
  FAMILY_C_DEFAULT_SHRINK_FRACTION, FAMILY_C_BETTING_LAMBDA_MAX,
  FAMILY_C_BETTING_BASELINE_POOL_SIZE,
  // Main entry
  buildFamilyCPerCell,
} from './_family-c-build.js';
export type {
  D6bCellDiagnostic, FamilyCTimings, FamilyCDiagnostics, FamilyCBuildResult,
} from './_family-c-build.js';

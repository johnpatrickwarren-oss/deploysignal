"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFamilyCPerCell = exports.FAMILY_C_BETTING_BASELINE_POOL_SIZE = exports.FAMILY_C_BETTING_LAMBDA_MAX = exports.FAMILY_C_DEFAULT_SHRINK_FRACTION = exports.bootstrapHotellingSlidingBufferThreshold = exports.FAMILY_C_HOTELLING_BOOTSTRAP_SEED = exports.MMD_MIN_BASELINE_SAMPLES = exports.MMD_BOOTSTRAP_N = exports.MMD_WINDOW_SIZE = exports.MMD_BOOTSTRAP_SEED_BASE = exports.buildMMDParams = exports.mmdSeedForCell = exports.mmdBootstrapNullQuantile = exports.mmdBaselineBaselineSum = exports.rbfKernel = exports.medianPairwiseDistance = exports.initialFallbackMCD = exports.buildFamilyCPerCellMRCD = exports.buildFamilyCPerCellMCD = exports.consistencyCorrectionFactor = exports.mcdReweight = exports.fastMCD = exports.computeLWWarmSeed = exports.initialSubsetEstimate = exports.cStep = exports.D6B_OUTLIER_FRACTION_THRESHOLD = exports.D6B_LAMBDA_THRESHOLD = exports.FASTMCD_DEFAULT_SEED = exports.FASTMCD_DEFAULT_ALPHA = exports.FASTMCD_TOP_N_FOR_FULL = exports.FASTMCD_CSTEP_LIMIT = exports.FASTMCD_N_WARM_SUBSETS = exports.FASTMCD_N_INITIAL_SUBSETS = exports.isPSDWithTolerance = exports.OFFDIAG_REL_TOLERANCE = exports.PSD_TOLERANCE = exports.mahalanobis = exports.mahalanobisSqFromL = exports.logDetLocal = exports.logDetCholesky = exports.chiSqQuantile975 = exports.applyAggregateShrinkage = exports.ledoitWolfShrinkage = exports.sampleCovariance = exports.relativeDeviations = exports.columnMean = void 0;
var _family_c_covariance_js_1 = require("./_family-c-covariance.js");
// Covariance helpers
Object.defineProperty(exports, "columnMean", { enumerable: true, get: function () { return _family_c_covariance_js_1.columnMean; } });
Object.defineProperty(exports, "relativeDeviations", { enumerable: true, get: function () { return _family_c_covariance_js_1.relativeDeviations; } });
Object.defineProperty(exports, "sampleCovariance", { enumerable: true, get: function () { return _family_c_covariance_js_1.sampleCovariance; } });
Object.defineProperty(exports, "ledoitWolfShrinkage", { enumerable: true, get: function () { return _family_c_covariance_js_1.ledoitWolfShrinkage; } });
Object.defineProperty(exports, "applyAggregateShrinkage", { enumerable: true, get: function () { return _family_c_covariance_js_1.applyAggregateShrinkage; } });
// Numerical helpers
Object.defineProperty(exports, "chiSqQuantile975", { enumerable: true, get: function () { return _family_c_covariance_js_1.chiSqQuantile975; } });
Object.defineProperty(exports, "logDetCholesky", { enumerable: true, get: function () { return _family_c_covariance_js_1.logDetCholesky; } });
Object.defineProperty(exports, "logDetLocal", { enumerable: true, get: function () { return _family_c_covariance_js_1.logDetLocal; } });
Object.defineProperty(exports, "mahalanobisSqFromL", { enumerable: true, get: function () { return _family_c_covariance_js_1.mahalanobisSqFromL; } });
Object.defineProperty(exports, "mahalanobis", { enumerable: true, get: function () { return _family_c_covariance_js_1.mahalanobis; } });
// PSD / off-diagonal gates
Object.defineProperty(exports, "PSD_TOLERANCE", { enumerable: true, get: function () { return _family_c_covariance_js_1.PSD_TOLERANCE; } });
Object.defineProperty(exports, "OFFDIAG_REL_TOLERANCE", { enumerable: true, get: function () { return _family_c_covariance_js_1.OFFDIAG_REL_TOLERANCE; } });
Object.defineProperty(exports, "isPSDWithTolerance", { enumerable: true, get: function () { return _family_c_covariance_js_1.isPSDWithTolerance; } });
var _family_c_mcd_js_1 = require("./_family-c-mcd.js");
// FastMCD + MRCD constants
Object.defineProperty(exports, "FASTMCD_N_INITIAL_SUBSETS", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_N_INITIAL_SUBSETS; } });
Object.defineProperty(exports, "FASTMCD_N_WARM_SUBSETS", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_N_WARM_SUBSETS; } });
Object.defineProperty(exports, "FASTMCD_CSTEP_LIMIT", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_CSTEP_LIMIT; } });
Object.defineProperty(exports, "FASTMCD_TOP_N_FOR_FULL", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_TOP_N_FOR_FULL; } });
Object.defineProperty(exports, "FASTMCD_DEFAULT_ALPHA", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_DEFAULT_ALPHA; } });
Object.defineProperty(exports, "FASTMCD_DEFAULT_SEED", { enumerable: true, get: function () { return _family_c_mcd_js_1.FASTMCD_DEFAULT_SEED; } });
Object.defineProperty(exports, "D6B_LAMBDA_THRESHOLD", { enumerable: true, get: function () { return _family_c_mcd_js_1.D6B_LAMBDA_THRESHOLD; } });
Object.defineProperty(exports, "D6B_OUTLIER_FRACTION_THRESHOLD", { enumerable: true, get: function () { return _family_c_mcd_js_1.D6B_OUTLIER_FRACTION_THRESHOLD; } });
// FastMCD + MRCD functions
Object.defineProperty(exports, "cStep", { enumerable: true, get: function () { return _family_c_mcd_js_1.cStep; } });
Object.defineProperty(exports, "initialSubsetEstimate", { enumerable: true, get: function () { return _family_c_mcd_js_1.initialSubsetEstimate; } });
Object.defineProperty(exports, "computeLWWarmSeed", { enumerable: true, get: function () { return _family_c_mcd_js_1.computeLWWarmSeed; } });
Object.defineProperty(exports, "fastMCD", { enumerable: true, get: function () { return _family_c_mcd_js_1.fastMCD; } });
Object.defineProperty(exports, "mcdReweight", { enumerable: true, get: function () { return _family_c_mcd_js_1.mcdReweight; } });
Object.defineProperty(exports, "consistencyCorrectionFactor", { enumerable: true, get: function () { return _family_c_mcd_js_1.consistencyCorrectionFactor; } });
Object.defineProperty(exports, "buildFamilyCPerCellMCD", { enumerable: true, get: function () { return _family_c_mcd_js_1.buildFamilyCPerCellMCD; } });
Object.defineProperty(exports, "buildFamilyCPerCellMRCD", { enumerable: true, get: function () { return _family_c_mcd_js_1.buildFamilyCPerCellMRCD; } });
Object.defineProperty(exports, "initialFallbackMCD", { enumerable: true, get: function () { return _family_c_mcd_js_1.initialFallbackMCD; } });
var _family_c_mmd_js_1 = require("./_family-c-mmd.js");
// Sequential MMD precompute
Object.defineProperty(exports, "medianPairwiseDistance", { enumerable: true, get: function () { return _family_c_mmd_js_1.medianPairwiseDistance; } });
Object.defineProperty(exports, "rbfKernel", { enumerable: true, get: function () { return _family_c_mmd_js_1.rbfKernel; } });
Object.defineProperty(exports, "mmdBaselineBaselineSum", { enumerable: true, get: function () { return _family_c_mmd_js_1.mmdBaselineBaselineSum; } });
Object.defineProperty(exports, "mmdBootstrapNullQuantile", { enumerable: true, get: function () { return _family_c_mmd_js_1.mmdBootstrapNullQuantile; } });
Object.defineProperty(exports, "mmdSeedForCell", { enumerable: true, get: function () { return _family_c_mmd_js_1.mmdSeedForCell; } });
Object.defineProperty(exports, "buildMMDParams", { enumerable: true, get: function () { return _family_c_mmd_js_1.buildMMDParams; } });
Object.defineProperty(exports, "MMD_BOOTSTRAP_SEED_BASE", { enumerable: true, get: function () { return _family_c_mmd_js_1.MMD_BOOTSTRAP_SEED_BASE; } });
Object.defineProperty(exports, "MMD_WINDOW_SIZE", { enumerable: true, get: function () { return _family_c_mmd_js_1.MMD_WINDOW_SIZE; } });
Object.defineProperty(exports, "MMD_BOOTSTRAP_N", { enumerable: true, get: function () { return _family_c_mmd_js_1.MMD_BOOTSTRAP_N; } });
Object.defineProperty(exports, "MMD_MIN_BASELINE_SAMPLES", { enumerable: true, get: function () { return _family_c_mmd_js_1.MMD_MIN_BASELINE_SAMPLES; } });
var _family_c_hotelling_js_1 = require("./_family-c-hotelling.js");
Object.defineProperty(exports, "FAMILY_C_HOTELLING_BOOTSTRAP_SEED", { enumerable: true, get: function () { return _family_c_hotelling_js_1.FAMILY_C_HOTELLING_BOOTSTRAP_SEED; } });
Object.defineProperty(exports, "bootstrapHotellingSlidingBufferThreshold", { enumerable: true, get: function () { return _family_c_hotelling_js_1.bootstrapHotellingSlidingBufferThreshold; } });
var _family_c_build_js_1 = require("./_family-c-build.js");
// Safe-Hotelling precompute constants
Object.defineProperty(exports, "FAMILY_C_DEFAULT_SHRINK_FRACTION", { enumerable: true, get: function () { return _family_c_build_js_1.FAMILY_C_DEFAULT_SHRINK_FRACTION; } });
Object.defineProperty(exports, "FAMILY_C_BETTING_LAMBDA_MAX", { enumerable: true, get: function () { return _family_c_build_js_1.FAMILY_C_BETTING_LAMBDA_MAX; } });
Object.defineProperty(exports, "FAMILY_C_BETTING_BASELINE_POOL_SIZE", { enumerable: true, get: function () { return _family_c_build_js_1.FAMILY_C_BETTING_BASELINE_POOL_SIZE; } });
// Main entry
Object.defineProperty(exports, "buildFamilyCPerCell", { enumerable: true, get: function () { return _family_c_build_js_1.buildFamilyCPerCell; } });

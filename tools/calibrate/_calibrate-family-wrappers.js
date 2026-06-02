"use strict";
// tools/calibrate/_calibrate-family-wrappers.ts — thin wrappers around the
// pure per-family calibrators (family-a/c/d/e) that thread the compile-local
// aggregator's timing accumulators. Extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file (D-54-3 god-file decomposition). No numeric or
// behavioral change.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFamilyCPerCell = buildFamilyCPerCell;
exports.buildFamilyAPerSignal = buildFamilyAPerSignal;
exports.buildFamilyDForSignal = buildFamilyDForSignal;
// D-54-3 slice 3c — Family C (MCD / MRCD / Ledoit-Wolf routing +
// safe-Hotelling + e-MMD + D6b diagnostic) extracted to
// tools/calibrators/family-c.ts (Option 3 side-effect-free).
const family_c_js_1 = require("../calibrators/family-c.js");
// D-54-3 slice 3b — buildFamilyAPerSignal extracted to
// tools/calibrators/family-a.ts (Option 3 side-effect-free).
const family_a_js_1 = require("../calibrators/family-a.js");
// D-54-3 slice 3b — Family D extracted to tools/calibrators/family-d.ts.
const family_d_js_1 = require("../calibrators/family-d.js");
/** D-54-3 slice 3c/3d — wrapper around the pure Family C calibrator.
 *  When `agg` is provided, timings + D6b diagnostics accumulate into
 *  the compile-local aggregator; when omitted (test-harness inline
 *  usage), the wrapper returns a bare cell with timings discarded.
 *  Slice-3d removed the module-level aggregator state. */
function buildFamilyCPerCell(rows, opts = {}, key, alphaMMD, agg) {
    const { result, timings, diagnostics } = (0, family_c_js_1.buildFamilyCPerCell)(rows, opts, key, alphaMMD);
    if (agg) {
        agg.timings.cov_estimation_ns += timings.cov_estimation_ns;
        agg.timings.mmd_bootstrap_ns += timings.mmd_bootstrap_ns;
        agg.timings.mmd_bootstrap_skipped_cells += timings.mmd_bootstrap_skipped_cells;
        agg.timings.mcd_skipped_low_variance_cells += timings.mcd_skipped_low_variance_cells;
        for (const d of diagnostics.d6b_cells)
            agg.d6b_cells.push(d);
    }
    return result;
}
/** D-54-3 slice 3b/3d — wrapper around pure extracted function.
 *  Delegates to tools/calibrators/family-a.ts. When `agg` is passed,
 *  timings accumulate into the compile-local aggregator; when omitted
 *  (test-harness inline usage), the wrapper returns a bare cell and
 *  timings are discarded. Slice-3d removed the module-level
 *  `_phaseTimings`; callers thread state explicitly now. */
function buildFamilyAPerSignal(samples, agg, signalClass = 'gaussian_like') {
    const { result, timings } = (0, family_a_js_1.buildFamilyAPerSignal)(samples, signalClass);
    if (agg)
        agg.timings.tau2_fit_ns += timings.tau2_fit_ns;
    return result;
}
/** D-54-3 slice 3b — wrapper around pure extracted function.
 *
 *  Q2.B.7 — routes to AR(1)-aware bootstrap path (buildFamilyDForSignalAR1)
 *  by default. Stamps `ar1_phi` + `ar1_sigma_eps` per signal so the
 *  parametric_ar1 resampler in tools/build-report-card.js can drive
 *  AR(1)-aware H₀ generation. Pre-Q2.B.7 iid bootstrap path retained
 *  in the calibrator module (buildFamilyDForSignal) for shadow-compare
 *  + force_legacy_family_d operator override. */
function buildFamilyDForSignal(allSamples, alphaD, seed, useLegacy) {
    const { result } = (0, family_d_js_1.buildFamilyDForSignalAR1)(allSamples, alphaD, seed, useLegacy);
    return result;
}

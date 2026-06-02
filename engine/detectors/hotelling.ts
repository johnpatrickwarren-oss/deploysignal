// engine/detectors/hotelling.ts — Family C: Hotelling T² multivariate drift.
//
// FACADE. The implementation was split out of this file (was 527 lines, a
// god-file with a >100-line evaluateFamilyC) into cohesive `_hotelling-*`
// submodules. This file re-exports the EXACT public surface so existing
// imports from `engine/detectors/hotelling` are unchanged. No behavior
// change — the submodules hold the verbatim logic.
//
// Per WEEK3-HANDOFF.md §3.1.d (architect-spec). The per-cell covariance
// and mean vector land in `baseline_cells.cells[key].family_C`; Page-CUSUM
// is the scalar per-signal test, Hotelling T² is the multivariate joint
// test. Family C catches correlated drifts that individual-signal CUSUMs
// miss because each component is under its own δ_min — the motivating
// case for the family.
//
// Statistic: T² = r^T Σ⁻¹ r where r = (x − μ) ./ μ. Threshold: χ²(1 − α, p)
// via Wilson-Hilferty. Suppression on Cholesky failure (singular Σ).
// See the submodules for the full derivations and inline auditor notes:
//   - _hotelling-math.ts     — χ² quantile + T² quadratic form
//   - _hotelling-lookup.ts   — FAMILY_C_SIGNALS, param/cell lookup, bake gate
//   - _hotelling-dispatch.ts — D-54-2 variant dispatch map
//   - _hotelling-safe.ts     — Addition #20 safe-Hotelling e-process
//   - _hotelling-eval.ts     — evaluateFamilyC entry point

export { chiSquareQuantile, hotellingT2 } from './_hotelling-math';
export { FAMILY_C_SIGNALS, lookupFamilyCParams } from './_hotelling-lookup';
export {
  _HOTELLING_EVALUATORS_FOR_TEST, _hotellingVariantForDispatch,
} from './_hotelling-dispatch';
export { freshSafeHotellingState, evaluateSafeHotelling } from './_hotelling-safe';
export { evaluateFamilyC } from './_hotelling-eval';

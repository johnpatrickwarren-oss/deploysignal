// engine/per-detector-resampler-mode.ts — Topic 58 per-detector
// resampler-mode dispatch.
//
// FACADE. The implementation was split out of this former god-file
// (674 lines) into cohesive sibling `_per-detector-resampler-*.ts`
// modules (types / tables / counts / merge / acceptance), each under
// 500 lines with no function over 100 lines. Behavior and the public
// import surface are unchanged: every name previously exported from
// `engine/per-detector-resampler-mode` is re-exported VERBATIM below.
//
// Per Q2.B.6.4 P4-β.7 ADR (declined-feature disposition; per-detector
// iid_bootstrap pool committed) + Q58 amended spec (post-Step-0
// architect amendment; ARCHITECT-REPLY-Q58-STEP-0-COVERAGE-GAP-
// DISPOSITION). Resolves the Family E weighted-conformal Mahalanobis
// novelty detection methodology-vs-detector-design alignment by
// running TWO FPR-sweep passes (empirical + parametric); each detector
// family's firing count is attributed only from its design-intent
// methodology-aligned pass.
//
// Anti-scope (Memorial F ADR-anti-scope-preservation sub-rule):
//  1. NO Family E aggregate-only Mahalanobis (per-cell-preferred per
//     engine/detectors/conformal.ts:137; preserved).
//  2. NO change to Family E calibration_scores source (aggregate per
//     ARCHITECT-REPLY-16 Q2; preserved).
//  3. NO touch to engine/detectors/* runtime code.
//  4. NO refactor of TrendBuffer or orchestrator dispatch.
//  5. NO per-detector row-pool data structure (this file replaces the
//     earlier per-detector-pool-sizes.ts + iid-bootstrap-pool.ts
//     module-pair conceptualization).

export type {
  DetectorFamily,
  ResamplerMode,
  ResamplerMode3Way,
  PerDetectorPoolFiringId,
  PerDetectorIidBootstrapPool,
  FprSweepResultLike,
  CompiledConfigVariantHints,
} from './_per-detector-resampler-types';

export {
  PER_DETECTOR_FAMILIES,
  PER_DETECTOR_RESAMPLER_MODE,
  COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY,
  PER_DETECTOR_RESAMPLER_MODE_3WAY,
  PER_DETECTOR_ALPHA_BUDGETS,
} from './_per-detector-resampler-tables';

export {
  resolveHotellingVariant,
  extractPerDetectorCounts,
} from './_per-detector-resampler-counts';

export {
  mergePerDetectorAcrossPasses,
  mergePerDetectorAcrossThreePasses,
  buildAllThreeModePoolsPerDetector,
} from './_per-detector-resampler-merge';

export {
  checkPerDetectorAcceptance,
  wilsonUpperBound,
  summarizePerDetectorAcrossSeeds,
} from './_per-detector-resampler-acceptance';

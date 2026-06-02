// engine/_per-detector-resampler-merge.ts — Topic 58 per-detector
// cross-pass merge / pool-block emission. Split out VERBATIM from the
// former per-detector-resampler-mode.ts god-file (merge logic).
// Re-exported through the per-detector-resampler-mode facade; import
// surface unchanged.

import type {
  DetectorFamily,
  ResamplerMode,
  ResamplerMode3Way,
  PerDetectorIidBootstrapPool,
  FprSweepResultLike,
  CompiledConfigVariantHints,
} from './_per-detector-resampler-types';
import {
  PER_DETECTOR_FAMILIES,
  PER_DETECTOR_RESAMPLER_MODE,
  COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY,
  PER_DETECTOR_RESAMPLER_MODE_3WAY,
} from './_per-detector-resampler-tables';
import { extractPerDetectorCounts } from './_per-detector-resampler-counts';

/** Merge per-detector firing-counts across the empirical + parametric
 *  passes, attributing each detector only to ITS methodology-aligned
 *  pass per `PER_DETECTOR_RESAMPLER_MODE`. Returns one
 *  `PerDetectorIidBootstrapPool` block per detector family. */
export function mergePerDetectorAcrossPasses(
  empirical: FprSweepResultLike,
  parametric: FprSweepResultLike,
  cfg: CompiledConfigVariantHints,
): Record<DetectorFamily, PerDetectorIidBootstrapPool> {
  const out: Partial<Record<DetectorFamily, PerDetectorIidBootstrapPool>> = {};
  for (const family of PER_DETECTOR_FAMILIES) {
    const mode = PER_DETECTOR_RESAMPLER_MODE[family];
    const source = mode === 'empirical' ? empirical : parametric;
    const { count, ids } = extractPerDetectorCounts(source, family, cfg, mode);
    const trajectories = source.healthy_window_count;
    out[family] = {
      pool_id: family,
      methodology_source: mode,
      compile_source_fields: COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY[family],
      trajectories_per_pass: trajectories,
      firing_count: count,
      firing_ids: ids,
      fpr_per_131: trajectories > 0 ? count / trajectories : 0,
    };
  }
  return out as Record<DetectorFamily, PerDetectorIidBootstrapPool>;
}

/** Three-pass merge: each detector attributed only to its mode-
 *  aligned pass per `PER_DETECTOR_RESAMPLER_MODE_3WAY`. Returns one
 *  `PerDetectorIidBootstrapPool` block per detector family with the
 *  `methodology_source` field re-typed as `ResamplerMode3Way`
 *  (extends `ResamplerMode` superset). */
export function mergePerDetectorAcrossThreePasses(
  iidBootstrap: FprSweepResultLike,
  parametricGaussian: FprSweepResultLike,
  parametricAr1: FprSweepResultLike,
  cfg: CompiledConfigVariantHints,
): Record<DetectorFamily, PerDetectorIidBootstrapPool> {
  const passByMode: Record<ResamplerMode3Way, FprSweepResultLike> = {
    iid_bootstrap: iidBootstrap,
    parametric_gaussian: parametricGaussian,
    parametric_ar1: parametricAr1,
  };
  const out: Partial<Record<DetectorFamily, PerDetectorIidBootstrapPool>> = {};
  for (const family of PER_DETECTOR_FAMILIES) {
    const mode3 = PER_DETECTOR_RESAMPLER_MODE_3WAY[family];
    const source = passByMode[mode3];
    // Re-use existing 2-way extractPerDetectorCounts; pass 'parametric'
    // for any non-iid mode (the disambiguation logic only cares about
    // empirical vs parametric for firing-ID stub generation; the 3-way
    // distinction lives in the methodology_source override below).
    const mode2: ResamplerMode = mode3 === 'iid_bootstrap' ? 'empirical' : 'parametric';
    const { count, ids } = extractPerDetectorCounts(source, family, cfg, mode2);
    // Override methodology_source on each firing-ID to the 3-way
    // value for accurate schema reporting at the per-firing level.
    for (const id of ids) {
      id.methodology_source = mode3;
    }
    const trajectories = source.healthy_window_count;
    out[family] = {
      pool_id: family,
      methodology_source: mode3,
      compile_source_fields: COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY[family],
      trajectories_per_pass: trajectories,
      firing_count: count,
      firing_ids: ids,
      fpr_per_131: trajectories > 0 ? count / trajectories : 0,
    };
  }
  return out as Record<DetectorFamily, PerDetectorIidBootstrapPool>;
}

/** Q66 Phase-3.d.A close item (h) schema bump 2.2.0 → 2.3.0 — emit
 *  ALL three mode pools per detector (iid_bootstrap + parametric_gaussian
 *  + parametric_ar1) instead of only the design-intent-mode pool. Each
 *  pool block has the same shape as the existing single-mode
 *  PerDetectorIidBootstrapPool; consumers can evaluate halt criterion
 *  (a) per mode by reading the appropriate field on the per-detector
 *  block in build-report-card.js output. Per architect Ask 2 disposition
 *  2026-05-05 refined-Option-(i) bundled pick.
 *
 *  Backward-compat: existing `iid_bootstrap_pool` field on each detector
 *  block continues to emit design-intent-mode pool (per
 *  `mergePerDetectorAcrossThreePasses`); this new function provides
 *  per-mode visibility ALONGSIDE that, not instead. */
export function buildAllThreeModePoolsPerDetector(
  iidBootstrap: FprSweepResultLike,
  parametricGaussian: FprSweepResultLike,
  parametricAr1: FprSweepResultLike,
  cfg: CompiledConfigVariantHints,
): Record<DetectorFamily, Record<ResamplerMode3Way, PerDetectorIidBootstrapPool>> {
  const passByMode: Record<ResamplerMode3Way, FprSweepResultLike> = {
    iid_bootstrap: iidBootstrap,
    parametric_gaussian: parametricGaussian,
    parametric_ar1: parametricAr1,
  };
  const out: Partial<Record<DetectorFamily, Record<ResamplerMode3Way, PerDetectorIidBootstrapPool>>> = {};
  for (const family of PER_DETECTOR_FAMILIES) {
    const perMode: Partial<Record<ResamplerMode3Way, PerDetectorIidBootstrapPool>> = {};
    for (const mode of ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as const) {
      const source = passByMode[mode];
      const mode2: ResamplerMode = mode === 'iid_bootstrap' ? 'empirical' : 'parametric';
      const { count, ids } = extractPerDetectorCounts(source, family, cfg, mode2);
      for (const id of ids) {
        id.methodology_source = mode;
      }
      const trajectories = source.healthy_window_count;
      perMode[mode] = {
        pool_id: family,
        methodology_source: mode,
        compile_source_fields: COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY[family],
        trajectories_per_pass: trajectories,
        firing_count: count,
        firing_ids: ids,
        fpr_per_131: trajectories > 0 ? count / trajectories : 0,
      };
    }
    out[family] = perMode as Record<ResamplerMode3Way, PerDetectorIidBootstrapPool>;
  }
  return out as Record<DetectorFamily, Record<ResamplerMode3Way, PerDetectorIidBootstrapPool>>;
}

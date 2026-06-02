// tools/_per-tick-detector-trace-mapping.ts — Q63 SPEC-3 implementation.
//
// HealthResult → per-(tick × detector) record mapping. Extracted from
// tools/per-tick-detector-trace.ts during a mechanical god-file split.
// The original ~160-line mapHealthResultToDetectorRecords is decomposed
// here into one <100-line dispatcher plus per-family helpers; each
// per-family block is moved VERBATIM (identical behavior + emission order).

import type {
  DetectorFamily,
  PerTickRecord,
  DetectorVerdictLite,
  HealthResultLite,
} from './_per-tick-detector-trace-types.js';

interface MapCtx {
  tick: number;
  timestampOffsetMs: number;
  cellKey: PerTickRecord['cell_lookup']['requested_key'];
  liveMetrics: Record<string, number>;
  selectedDetectors: ReadonlyArray<DetectorFamily>;
}

type BaseRecordFn = (
  detector: DetectorFamily,
  objectPath: string,
  verdict: DetectorVerdictLite | null,
  extras?: { detector_variant?: string; signal?: string; firing_id?: string },
) => PerTickRecord;

function makeBaseRecord(ctx: MapCtx): BaseRecordFn {
  return (detector, objectPath, verdict, extras = {}): PerTickRecord => ({
    tick: ctx.tick,
    timestamp_offset_ms: ctx.timestampOffsetMs,
    detector,
    detector_variant: extras.detector_variant,
    cell_lookup: {
      requested_key: ctx.cellKey,
      resolved_key: ctx.cellKey, // existing orchestrator return doesn't disambiguate per_cell vs aggregate; populated as best-effort
      resolution_path: verdict ? 'per_cell' : 'no_match',
    },
    compile_source: { object_path: objectPath },
    per_detector_input: { live_metrics: ctx.liveMetrics },
    per_detector_computation: {
      statistic_value: verdict?.statistic ?? null,
      threshold: verdict?.threshold ?? null,
    },
    firing_decision: verdict
      ? (verdict.verdict === 'fire' ? 'fire'
        : verdict.verdict === 'suppressed' ? 'suppressed'
        : verdict.verdict === 'indeterminate' ? 'indeterminate' : 'clean')
      : 'no_data',
    firing_id: extras.firing_id,
    signal: extras.signal ?? verdict?.signal,
  });
}

// family_A_page_cusum — surfaces per-signal in family_A_shadow[].
function mapFamilyAPageCusum(
  out: PerTickRecord[], hr: HealthResultLite, baseRecord: BaseRecordFn,
): void {
  const shadows = hr.family_A_shadow ?? [];
  if (shadows.length === 0) {
    out.push(baseRecord('family_A_page_cusum',
      'baseline_cells.cells[].family_A.per_signal[].{baseline_mean,baseline_sigma_squared,tau_squared,delta_min}',
      null));
  } else {
    for (const v of shadows) {
      out.push(baseRecord('family_A_page_cusum',
        `baseline_cells.cells[].family_A.per_signal[${v.signal ?? '?'}].page_cusum`,
        v, { signal: v.signal, firing_id: v.verdict === 'fire' ? `family_A_page_cusum_${v.signal ?? 'unknown'}` : undefined }));
    }
  }
}

// family_A_betting — Q58 Step-4 split alongside page_cusum on Family A signals.
// Existing DetectorVerdict path doesn't disambiguate; surface the same shadows tagged as betting variant.
function mapFamilyABetting(
  out: PerTickRecord[], hr: HealthResultLite, baseRecord: BaseRecordFn,
): void {
  const shadows = hr.family_A_shadow ?? [];
  if (shadows.length === 0) {
    out.push(baseRecord('family_A_betting',
      'baseline_cells.cells[].family_A.per_signal[].betting_sliding_buffer_threshold',
      null));
  } else {
    for (const v of shadows) {
      out.push(baseRecord('family_A_betting',
        `baseline_cells.cells[].family_A.per_signal[${v.signal ?? '?'}].betting_e_process`,
        v, { signal: v.signal, detector_variant: 'betting', firing_id: v.verdict === 'fire' ? `family_A_betting_${v.signal ?? 'unknown'}` : undefined }));
    }
  }
}

// family_C_* + mmd_* — all surface via the family_C verdict surfaces.
function mapFamilyCAndMmd(
  out: PerTickRecord[], hr: HealthResultLite, wanted: Set<DetectorFamily>, baseRecord: BaseRecordFn,
): void {
  // family_C_safe_test — Hotelling T².
  if (wanted.has('family_C_safe_test')) {
    out.push(baseRecord('family_C_safe_test',
      'baseline_cells.cells[].family_C.{mean_vector,covariance,cholesky_L}',
      hr.family_C_verdict ?? null,
      { detector_variant: 'hotelling_t2', firing_id: hr.family_C_verdict?.verdict === 'fire' ? 'family_C' : undefined }));
  }

  // family_C_chi_square — variant of Hotelling χ² threshold (same source object).
  if (wanted.has('family_C_chi_square')) {
    out.push(baseRecord('family_C_chi_square',
      'baseline_cells.cells[].family_C.chi_square_threshold',
      hr.family_C_verdict ?? null,
      { detector_variant: 'chi_square', firing_id: hr.family_C_verdict?.verdict === 'fire' ? 'family_C_chi_square' : undefined }));
  }

  // mmd_betting + mmd_bootstrap_null — both surface via family_C_mmd_verdict.
  if (wanted.has('mmd_betting')) {
    out.push(baseRecord('mmd_betting',
      'baseline_cells.cells[].family_C.mmd_params.e_mmd_params',
      hr.family_C_mmd_verdict ?? null,
      { detector_variant: 'betting', firing_id: hr.family_C_mmd_verdict?.verdict === 'fire' ? 'family_C_mmd' : undefined }));
  }
  if (wanted.has('mmd_bootstrap_null')) {
    out.push(baseRecord('mmd_bootstrap_null',
      'baseline_cells.cells[].family_C.mmd_params.{null_quantile,bandwidth}',
      hr.family_C_mmd_verdict ?? null,
      { detector_variant: 'bootstrap_null', firing_id: hr.family_C_mmd_verdict?.verdict === 'fire' ? 'family_C_mmd_bootstrap' : undefined }));
  }
}

// family_D_spectral + family_D_kv_cache — split family_D_shadow by signal.
function mapFamilyD(
  out: PerTickRecord[], hr: HealthResultLite, wanted: Set<DetectorFamily>, baseRecord: BaseRecordFn,
): void {
  const fD = hr.family_D_shadow ?? [];
  if (wanted.has('family_D_kv_cache')) {
    const v = fD.find((x) => x.signal === 'kv_cache');
    out.push(baseRecord('family_D_kv_cache',
      'baseline_cells.cells[].family_D[kv_cache].{ar1_phi,peak_acf_threshold}',
      v ?? null,
      { signal: 'kv_cache', firing_id: v?.verdict === 'fire' ? 'family_D_kv_cache' : undefined }));
  }
  if (wanted.has('family_D_spectral')) {
    const nonKv = fD.filter((x) => x.signal !== 'kv_cache');
    if (nonKv.length === 0) {
      out.push(baseRecord('family_D_spectral',
        'baseline_cells.cells[].family_D[non-kv-cache signals].{ar1_phi,peak_acf_threshold}',
        null));
    } else {
      for (const v of nonKv) {
        out.push(baseRecord('family_D_spectral',
          `baseline_cells.cells[].family_D[${v.signal ?? '?'}].{ar1_phi,peak_acf_threshold}`,
          v, { signal: v.signal, firing_id: v.verdict === 'fire' ? `family_D_${v.signal ?? 'unknown'}` : undefined }));
      }
    }
  }
}

// family_B_pattern_match — surfaced via rollback[] entries with id starting family_b_.
function mapFamilyBPatternMatch(
  out: PerTickRecord[], hr: HealthResultLite, baseRecord: BaseRecordFn,
): void {
  const familyBFires = (hr.rollback ?? []).filter((r) => r.id?.startsWith('family_b_'));
  if (familyBFires.length === 0) {
    out.push(baseRecord('family_B_pattern_match',
      'family_B.{cutoffs,vote_thresholds}',
      null));
  } else {
    for (const r of familyBFires) {
      out.push({
        ...baseRecord('family_B_pattern_match',
          `family_B.cutoffs.${r.id}`,
          { verdict: 'fire', statistic: null, threshold: null, family: 'B' } as DetectorVerdictLite,
          { firing_id: r.id }),
      });
    }
  }
}

export function mapHealthResultToDetectorRecords(
  hr: HealthResultLite | null | undefined,
  ctx: MapCtx,
): PerTickRecord[] {
  if (!hr) return [];
  const out: PerTickRecord[] = [];
  const wanted = new Set(ctx.selectedDetectors);
  const baseRecord = makeBaseRecord(ctx);

  if (wanted.has('family_A_page_cusum')) mapFamilyAPageCusum(out, hr, baseRecord);
  if (wanted.has('family_A_betting')) mapFamilyABetting(out, hr, baseRecord);
  mapFamilyCAndMmd(out, hr, wanted, baseRecord);
  mapFamilyD(out, hr, wanted, baseRecord);
  if (wanted.has('family_E_conformal')) {
    out.push(baseRecord('family_E_conformal',
      'baseline_cells.cells[].family_E.{conformal_calibration,mahalanobis_quantile}',
      hr.family_E_verdict ?? null,
      { firing_id: hr.family_E_verdict?.verdict === 'fire' ? 'family_E' : undefined }));
  }
  if (wanted.has('family_B_pattern_match')) mapFamilyBPatternMatch(out, hr, baseRecord);

  return out;
}

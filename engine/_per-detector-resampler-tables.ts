// engine/_per-detector-resampler-tables.ts — Topic 58 per-detector
// resampler-mode dispatch tables / constants. Split out VERBATIM from
// the former per-detector-resampler-mode.ts god-file (tables group).
// Re-exported through the per-detector-resampler-mode facade; import
// surface unchanged.

import type { DetectorFamily, ResamplerMode, ResamplerMode3Way } from './_per-detector-resampler-types';

/** Enumerated detector-family list. Source-of-truth ordering for
 *  iteration in `mergePerDetectorAcrossPasses` and report-card
 *  emission loops. */
export const PER_DETECTOR_FAMILIES: readonly DetectorFamily[] = [
  'family_A_betting',
  'family_A_page_cusum',
  'family_C_safe_test',
  'family_C_chi_square',
  'family_D_spectral',
  'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting',
  'mmd_bootstrap_null',
  'family_B_pattern_match',
];

/** Per-detector resampler-mode dispatch table per Q58 amended spec
 *  § Q58.2 + detector-family enumeration table. Each detector
 *  evaluated against the methodology surface IT WAS CALIBRATED FOR
 *  (Q2.B.6.4 P4-β.7 ADR methodology-vs-detector-design alignment).
 *
 *  Parametric pass services 6 pools — calibrated against parametric
 *  H₀ surfaces (Cholesky-correct Σ_C draws + per-cell Mahalanobis +
 *  Q3 Ville-clean betting + parametric MMD nulls).
 *
 *  Empirical pass services 4 pools — calibrated against raw distribution
 *  shape (CUSUM raw-distribution + peak-ACF raw temporal structure +
 *  structural ratio observed). */
export const PER_DETECTOR_RESAMPLER_MODE: Record<DetectorFamily, ResamplerMode> = {
  // Parametric pass (6 detectors):
  family_A_betting:    'parametric',  // Q3 Ville-clean H₀ test design intent.
  family_C_safe_test:  'parametric',  // Cholesky-correct + non-diagonal Σ_C.
  family_C_chi_square: 'parametric',  // Cholesky-correct.
  family_E_conformal:  'parametric',  // Q2.B.6.4 ADR original motivation.
  mmd_betting:         'parametric',  // Cholesky-correct + e_mmd_params.
  mmd_bootstrap_null:  'parametric',  // null_quantile + bandwidth parametric.

  // Empirical pass (4 detectors):
  family_A_page_cusum: 'empirical',  // CUSUM raw-distribution calibration.
  family_D_spectral:   'empirical',  // Peak-ACF raw temporal structure.
  family_D_kv_cache:   'empirical',  // Same peak-ACF rationale.
  family_B_pattern_match: 'empirical',  // Structural ratios over raw observed.
};

/** Compile-output fields read by each detector's runtime evaluator.
 *  Per Q58 amended spec § Q58.3 + Step-0 Gap 4 disposition (6 missing
 *  fields added across pools).
 *
 *  P3.3 sub-pattern (compile-time-substrate-with-runtime-multiple-
 *  read-paths) anchored: each entry mirrors the actual read paths in
 *  engine/detectors/* runtime code. Mac-Claude-2 grep at Step Q58.0
 *  surfaced 6 missing fields; architect amended; this enumeration
 *  closes the gap. */
export const COMPILE_SOURCE_FIELDS_BY_DETECTOR_FAMILY: Record<DetectorFamily, readonly string[]> = {
  family_A_betting: [
    'family_A.per_signal[sig].baseline_mean_raw',
    'family_A.per_signal[sig].baseline_sigma_squared_raw',
    'family_A.per_signal[sig].betting_e_process_alpha',
    'family_A.per_signal[sig].betting_sliding_buffer_threshold',  // Q2.B.6.3
    'family_A.per_signal[sig].signal_class',                       // Q2.A
  ],
  family_A_page_cusum: [
    'family_A.per_signal[sig].baseline_mean',
    'family_A.per_signal[sig].baseline_sigma_squared',
    'family_A.per_signal[sig].tau_squared',
    'family_A.per_signal[sig].delta_min',
    'family_A.per_signal[sig].signal_class',                       // Q2.A
  ],
  family_C_safe_test: [
    'family_C.mean_vector',
    'family_C.covariance',
    'family_C.cholesky_L',
    'family_C.safe_hotelling_params',
    'family_C.sliding_buffer_threshold',                           // Q2.B.6.2
    'family_C.mmd_params',                                          // alpha-halving (Step-0 Gap 4)
    'family_C.hotelling_variant',                                   // dispatch (Step-0 Gap 4)
  ],
  family_C_chi_square: [
    'family_C.mean_vector',
    'family_C.covariance',
    'family_C.cholesky_L',
    'family_C.hotelling_sliding_buffer_threshold',                 // Q2.B.6.2
    'family_C.hotelling_variant',                                   // dispatch (Step-0 Gap 4)
  ],
  family_D_spectral: [
    'family_D[sig].ar1_phi',
    'family_D[sig].ar1_sigma_eps',
    'family_D[sig].null_mean',
    'family_D[sig].null_std',
    'family_D[sig].betting_delta',
    'family_D[sig].cholesky_L_eps',                                // Q2.B.6.1
    'family_D[sig].spectral_variant',                              // dispatch (Step-0 Gap 4)
  ],
  family_D_kv_cache: [
    // Inherits family_D_spectral; signal-scoped to kv_cache.
    'family_D.kv_cache.ar1_phi',
    'family_D.kv_cache.ar1_sigma_eps',
    'family_D.kv_cache.null_mean',
    'family_D.kv_cache.null_std',
    'family_D.kv_cache.betting_delta',
    'family_D.kv_cache.cholesky_L_eps',
    'family_D.kv_cache.spectral_variant',                          // dispatch (Step-0 Gap 4)
  ],
  family_E_conformal: [
    // Aggregate calibration scores (per ARCHITECT-REPLY-16 Q2;
    // anti-scope per Q2.B.6.4 ADR — DO NOT change source from aggregate).
    'aggregate_fallback.family_E.calibration_scores',
    'aggregate_fallback.family_E.threshold',
    'aggregate_fallback.family_E.weight_decay_params',
    // Per-cell-preferred Mahalanobis source (Step-0 Gap 4 + Gap 3
    // amendment; per engine/detectors/conformal.ts:137; ANTI-SCOPE
    // per Q2.B.6.4 ADR — DO NOT make Family E aggregate-only).
    'cells[*].family_C.mean_vector',
    'cells[*].family_C.covariance',
    'cells[*].family_C.cholesky_L',
    'aggregate_fallback.family_C.mean_vector',  // fallback when per-cell unavailable
    'aggregate_fallback.family_C.covariance',
    'aggregate_fallback.family_C.cholesky_L',
  ],
  mmd_betting: [
    'family_C.mean_vector',     // Step-0 Gap 4
    'family_C.covariance',      // Step-0 Gap 4
    'family_C.cholesky_L',      // Step-0 Gap 4
    'family_C.e_mmd_params',
    'family_C.betting_e_process_params',  // Q67 v2 canonical params
  ],
  mmd_bootstrap_null: [
    'family_C.mmd_params.bandwidth',
    'family_C.mmd_params.baseline_baseline_sum',
    'family_C.mmd_params.null_quantile',
    'family_C.mmd_params.null_quantile_bootstraps',
    'family_C.mean_vector',     // for centering (Step-0 Gap 4)
  ],
  family_B_pattern_match: [
    'family_B.patterns[name].threshold',
    'family_B.patterns[name].ratio_definition',
  ],
};

/** Per-detector 3-way resampler-mode dispatch table per Q58 Step-4
 *  amendment. Each detector evaluated against the methodology
 *  surface IT WAS CALIBRATED FOR (Q2.B.6.4 P4-β.7 ADR
 *  methodology-vs-detector-design alignment). 3-way granularity
 *  resolves the parametric_gaussian-vs-parametric_ar1 trade-off
 *  surfaced empirically at Step-Q58.4. */
export const PER_DETECTOR_RESAMPLER_MODE_3WAY: Record<DetectorFamily, ResamplerMode3Way> = {
  // iid_bootstrap pass (2 detectors) — calibrated against raw
  // empirical distribution shape.
  family_A_page_cusum:    'iid_bootstrap',  // CUSUM raw-distribution calibration.
  family_B_pattern_match: 'iid_bootstrap',  // Structural ratios over raw observed.

  // parametric_gaussian pass (5 detectors) — Cholesky-correct joint
  // Gaussian draws from cell.family_C.{mean_vector, cholesky_L}.
  family_A_betting:    'parametric_gaussian',  // Q3 Ville-clean H₀ design intent.
  family_C_safe_test:  'parametric_gaussian',  // Cholesky-correct + non-diagonal Σ_C.
  family_C_chi_square: 'parametric_gaussian',  // Cholesky-correct.
  mmd_betting:         'parametric_gaussian',  // Cholesky-correct + e_mmd_params.
  mmd_bootstrap_null:  'parametric_gaussian',  // null_quantile + bandwidth parametric.

  // parametric_ar1 pass (3 detectors) — preserves AR(1) temporal
  // correlation that calibration was tuned against. CHANGE from
  // Step-0 spec: family_E + family_D moved here from parametric.
  family_D_spectral:  'parametric_ar1',  // Peak-ACF ↔ AR(1) temporal structure.
  family_D_kv_cache:  'parametric_ar1',  // Same peak-ACF rationale; high-ρ kv_cache.
  family_E_conformal: 'parametric_ar1',  // Conformal Mahalanobis ↔ Q2.B.7 AR(1)-aware.
};

/** Per-detector α budgets for Step-4 acceptance check (mean ≤ α × N
 *  × marginMultiplier). Step-4 amendment per spec § Q58.4 acceptance.
 *  Family B is non-α-consuming (structural pattern match); auto-pass
 *  via `checkPerDetectorAcceptance`. */
export const PER_DETECTOR_ALPHA_BUDGETS: Record<DetectorFamily, number> = {
  family_A_betting:    2e-4,  // α_A_betting union over 6 signals (Bonferroni)
  family_A_page_cusum: 1e-4,  // α_A_page_cusum classical-epoch
  family_C_safe_test:  2e-4,  // α_C
  family_C_chi_square: 2e-4,  // α_C (variant share)
  family_D_spectral:   1e-4,  // α_D
  family_D_kv_cache:   1e-4,  // α_D (signal share)
  family_E_conformal:  1e-4,  // α_E
  mmd_betting:         1e-4,  // α_mmd
  mmd_bootstrap_null:  1e-4,  // α_mmd (variant share)
  family_B_pattern_match: 0,  // non-α-consuming structural
};

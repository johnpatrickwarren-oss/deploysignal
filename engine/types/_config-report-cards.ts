// engine/types/_config-report-cards.ts — Topic 60 per-profile validation
// report-card types and the per-(substrate × scenario × seed) sweep
// checkpoint. Split out of the engine/types/config.ts god-file; re-exported
// verbatim from there to preserve the facade export surface.

import type { BaselineProvenance } from './_config-compiled';

// ── Topic 60 Slice 1 — per-profile validation report-card types ───
//
// Q60 introduces per-profile report-card emission for cross-substrate
// shadow-compare validation. Schema additions are at REPORT-CARD
// level (NOT compile-output level); runtime detectors unchanged.
// Schema bumps from 2.1.0 (post-Q59) to 2.2.0; backward-compat
// preserved (existing 2.0.0/2.1.0 consumers ignore new blocks).

/** Detector family identifier — duplicates the union from
 *  `engine/per-detector-resampler-mode.ts` to avoid a config-layer
 *  import dependency on validation-methodology code. Keep in sync
 *  if the detector family enumeration changes. */
export type Q60DetectorFamily =
  | 'family_A_betting' | 'family_A_page_cusum'
  | 'family_C_safe_test' | 'family_C_chi_square'
  | 'family_D_spectral' | 'family_D_kv_cache'
  | 'family_E_conformal'
  | 'mmd_betting' | 'mmd_bootstrap_null'
  | 'family_B_pattern_match';

/** Per-profile report-card metadata block (Q60 schema 2.2.0).
 *  Stamped on every report card emitted by run-shadow-compare to
 *  identify which substrate × scenario × compiled-config tuple
 *  produced the metrics. */
export interface ProfileReportCardBlock {
  /** Source identifier of the dataset; either a real-trace
   *  provenance value or 'synthetic_v1' for the production
   *  validation substrate. */
  dataset: BaselineProvenance | 'synthetic_v1';
  /** Postmortem scenario id (e.g.,
   *  'openai_routing_error_ramp_2024_12_11'). */
  scenario: string;
  /** Provenance stamp from the substrate's CompiledConfig (matches
   *  `dataset` in the canonical case; preserved separately so a
   *  scenario-specific overlay or mixed substrate can be stamped
   *  honestly). */
  baseline_provenance: BaselineProvenance;
  /** Compiled-config artifact version (e.g., 'v8a-real-burstgpt-v1'
   *  or 'v5-sequential-e-process'). */
  compiled_config_version: string;
}

/** Cross-substrate shadow-compare delta block (Q60 schema 2.2.0).
 *  Populated only when the report card was emitted by
 *  `tools/run-shadow-compare.ts` against a reference substrate. */
export interface ShadowCompareBlock {
  /** Reference substrate ID compared against (typically
   *  'synthetic_v1'). */
  reference_substrate: string;
  /** Per-detector ΔTPR (test substrate − reference substrate). */
  delta_TPR_per_detector: Record<Q60DetectorFamily, number>;
  /** Per-detector ΔFPR (test substrate − reference substrate). */
  delta_FPR_per_detector: Record<Q60DetectorFamily, number>;
  /** Per-detector Δ median TTD in ticks (test − reference). */
  delta_median_TTD_per_detector: Record<Q60DetectorFamily, number>;
  /** Acceptance gate names → pass/fail (per Q60 § Q60.7
   *  acceptance criteria 11-13). */
  acceptance_gates_passed: Record<string, boolean>;
  /** Q62 Phase 4 H1a+H1b additive — count of detectors exempted from
   *  cross-substrate ΔFPR acceptance bound. Optional for backward-
   *  compat with pre-amendment consumers. */
  exempted_detector_count?: number;
  /** Q62 Phase 4 H1a+H1b additive — per-exempted-detector metadata
   *  with reason text + observed ΔFPR for diagnostic visibility. */
  exempted_detector_metadata?: Record<string, {
    detector: Q60DetectorFamily;
    reason: string;
    observed_delta_FPR: number;
  }>;
}

/** Per-(substrate × scenario × seed) checkpoint file emitted at
 *  `runs/validation-reports/profile-report-cards/checkpoints/
 *  <substrate>--<scenario>--<seed>.json`. V2 architect-required
 *  addition: incremental emission discipline at run-shadow-compare
 *  scaffolding for mid-sweep crash recoverability (B4 Mac mini
 *  compute-target operational pattern dependency).
 *
 *  Resume semantic: on resume, scan checkpoints; resume from last
 *  incomplete (status !== 'completed'); skip completed. Final
 *  shadow-compare diff aggregation reads completed checkpoints;
 *  warns/aborts on incomplete. Discipline applies regardless of
 *  compute target (B1/B2/B3 also benefit from incremental emission). */
export interface SweepCheckpoint {
  /** Substrate identifier (e.g., 'real_burstgpt' or 'synthetic_v1'). */
  substrate: string;
  /** Scenario identifier (e.g.,
   *  'openai_routing_error_ramp_2024_12_11'). */
  scenario: string;
  /** Seed used for the trial run. */
  seed: number;
  /** Lifecycle status of the (substrate × scenario × seed) trial. */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Unix epoch ms when the trial started. */
  start_timestamp: number;
  /** Unix epoch ms when the trial completed (or failed); absent
   *  while `status === 'pending' | 'in_progress'`. */
  end_timestamp?: number;
  /** Per-detector firing-counts for the trial (status='completed'). */
  per_detector_firing_counts?: Record<Q60DetectorFamily, number>;
  /** Per-detector firing-IDs (e.g., '<scenario>:<tick>') for
   *  attribution-discipline auditing (status='completed'). */
  per_detector_firing_ids?: Record<Q60DetectorFamily, string[]>;
  /** Q60 Phase-3.d.1 (D) — per-detector exemption mapping populated
   *  when substrate's signal coverage doesn't include detector's
   *  required signals. Exempted detectors are skipped from FPR-sweep
   *  evaluation; acceptance gates skip exempted (substrate × detector)
   *  triples per Q60 spec § Acceptance criterion 8 amendment. */
  detector_exemptions?: Partial<Record<Q60DetectorFamily, string>>;
  /** Error message populated on `status === 'failed'`. */
  error?: string;
}

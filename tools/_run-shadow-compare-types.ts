// tools/_run-shadow-compare-types.ts — shared types + constants for the
// Q60 Slice 1 shadow-compare orchestrator (extracted verbatim from
// tools/run-shadow-compare.ts during a behavior-preserving module split).

import type {
  Q60DetectorFamily,
  ProfileReportCardBlock,
  ShadowCompareBlock,
} from '../engine/types/config.js';

// ── Constants ────────────────────────────────────────────────────

/** 10-detector enumeration (matches engine/per-detector-resampler-
 *  mode.ts PER_DETECTOR_FAMILIES; duplicated here to avoid pulling
 *  in the full module dependency at orchestrator layer). */
export const Q60_DETECTOR_FAMILIES: readonly Q60DetectorFamily[] = [
  'family_A_betting', 'family_A_page_cusum',
  'family_C_safe_test', 'family_C_chi_square',
  'family_D_spectral', 'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting', 'mmd_bootstrap_null',
  'family_B_pattern_match',
];

/** Per-detector α budgets (mirrors engine/per-detector-resampler-
 *  mode.ts PER_DETECTOR_ALPHA_BUDGETS). */
export const Q60_ALPHA_BUDGETS: Record<Q60DetectorFamily, number> = {
  family_A_betting: 2e-4,
  family_A_page_cusum: 1e-4,
  family_C_safe_test: 2e-4,
  family_C_chi_square: 2e-4,
  family_D_spectral: 1e-4,
  family_D_kv_cache: 1e-4,
  family_E_conformal: 1e-4,
  mmd_betting: 1e-4,
  mmd_bootstrap_null: 1e-4,
  family_B_pattern_match: 0,
};

export const DEFAULT_HEALTHY_WINDOWS = 131;

/** Family A signals (mirror of FAMILY_A_SIGNALS in tools/calibrate.ts;
 *  duplicated here to avoid pulling in the calibrator at orchestrator
 *  layer). */
export const FAMILY_A_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

/** Family C joint vector signals (mirror of FAMILY_C_SIGNALS in
 *  tools/calibrate.ts). */
export const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
] as const;

export type SweepMode = 'iid_bootstrap' | 'parametric_gaussian' | 'parametric_ar1';

// ── Substrate + scenario types ───────────────────────────────────

export interface SubstrateRef {
  name: string;            // e.g., 'synthetic_v1' | 'real_burstgpt'
  baselineDir: string;     // path to baseline bundle directory
  compiledConfig: string;  // path to compiled config JSON
}

export interface ShadowCompareOpts {
  substrates: SubstrateRef[];
  scenarios: string[];      // postmortem profile names
  seeds: number[];          // typically 8 seeds
  outputDir: string;        // 'runs/validation-reports/profile-report-cards/'
  /** When set, dry-run mode skips the actual build-report-card
   *  invocations + emits stub checkpoints (used by tests + smoke
   *  testing the orchestrator without ~5-15h compute). */
  dryRun?: boolean;
  healthyWindows?: number;  // default 131
}

export interface PerProfileReportCard {
  profile: ProfileReportCardBlock;
  per_detector_firing_counts_mean: Record<Q60DetectorFamily, number>;
  per_detector_firing_counts_per_seed: Record<Q60DetectorFamily, number[]>;
  per_detector_fpr_mean: Record<Q60DetectorFamily, number>;
  shadow_compare?: ShadowCompareBlock;
}

export interface ShadowCompareReport {
  per_profile_report_cards: Record<string, PerProfileReportCard>;
  cross_substrate_diff_path: string;
  acceptance_gates: Record<string, boolean>;
  pitch_summary_path: string;
}

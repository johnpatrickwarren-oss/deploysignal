// tools/_run-nab-validation-types.ts — Q64 SPEC-4 NAB validation public types.
//
// Extracted VERBATIM from tools/run-nab-validation.ts. Re-exported from
// tools/run-nab-validation.ts to preserve the original import surface.

// ── Public types ─────────────────────────────────────────────────

/** Detector family identifier (subset of full DetectorFamily enum;
 *  Q64 evaluates Family A + Family D primary per § Q64.1).
 *
 *  Q69.D (2026-08-18, applied at the v0.6.7-pre re-pin): the classical
 *  'family_A_page_cusum' arm is retired with the classical detector itself
 *  (engine validation/nab/RERUN-2026-08-18-PREREGISTRATION.md § 3). This
 *  Q64-era copy carries no mixture branch, so best-of-A here is betting
 *  only; the engine's own NAB tool runs the full Ville pair. */
export type NABDetectorFamily =
  | 'family_A_betting'
  | 'family_D_spectral';

export type NABSubBenchmark =
  | 'realKnownCause'
  | 'realAWSCloudwatch'
  | 'artificialNoAnomaly'
  | 'artificialWithAnomaly';

/** Per-tick firing decision captured from detector dispatch. */
export interface DetectorFiringDecision {
  tick: number;
  fire: boolean;
  /** Q64 Phase 4 STUB resolution: per-detector statistic at evaluation
   *  tick (CUSUM S_n; betting wealth M_t; spectral peak |ACF|).
   *  Optional — captured for diagnostic memo emission, not for NAB
   *  scoring (NAB scores depend on `fire` + tick alignment with
   *  annotation windows). */
  statistic_value?: number;
  /** Per-detector threshold (architect-disposed sliding-buffer
   *  threshold or per-cell threshold). Optional. */
  threshold?: number;
}

/** NAB anomaly annotation window (per Numenta labels/combined_windows.json). */
export interface NABDatasetAnnotation {
  anomaly_window_start: number;  // tick index
  anomaly_window_end: number;
}

export interface NABDatasetScore {
  dataset_path: string;
  n_ticks: number;
  n_anomaly_windows: number;
  standard_profile_score: number;
  reward_low_fp_score: number;
  reward_low_fn_score: number;
}

export interface NABValidationOpts {
  /** Path to NAB repository checkout (numenta/NAB GitHub clone). */
  nabRepoPath: string;
  /** Subset of NAB sub-benchmarks. Default: 4 architect-picked. */
  nabSubBenchmarks?: NABSubBenchmark[];
  /** DeploySignal compiled config path (substrate for detector calibration). */
  compiledConfig: string;
  /** Detector families. Default (Q69.D): family_A_betting + family_D_spectral. */
  detectors?: NABDetectorFamily[];
  /** Output validation report path. */
  outputPath: string;
  /** Optional NAB labels path override. Default: <nabRepoPath>/labels/combined_windows.json. */
  labelsPath?: string;
  /** Q64 Phase 4 architect-disposed calibration signal (default
   *  'p99_latency' heavy_tail signal class). Detector dispatch sources
   *  v5 substrate's family_A.per_signal[calibrationSignal] +
   *  family_D[calibrationSignal] for NAB scoring. */
  calibrationSignal?: string;
}

export interface NABValidationReport {
  per_family_scores: Record<NABDetectorFamily, {
    standard_profile_score: number;
    reward_low_fp_score: number;
    reward_low_fn_score: number;
    per_dataset_breakdown: Record<string, NABDatasetScore>;
  }>;
  acceptance_results: {
    family_A_passes: boolean;     // any family_A_* >= 50
    family_D_passes: boolean;     // family_D_spectral >= 40
    combined_acceptance: boolean;
  };
  metadata: {
    nab_repo_version: string;
    deploysignal_compiled_config_version: string;
    tool_version: string;
    sub_benchmarks_evaluated: NABSubBenchmark[];
    detectors_evaluated: NABDetectorFamily[];
  };
}

export const DEFAULT_SUB_BENCHMARKS: NABSubBenchmark[] = [
  'realKnownCause',
  'realAWSCloudwatch',
  'artificialNoAnomaly',
  'artificialWithAnomaly',
];

export const DEFAULT_DETECTORS: NABDetectorFamily[] = [
  'family_A_betting',
  'family_D_spectral',
];

export const TOOL_VERSION = 'Q64 SPEC-4 v1.0';

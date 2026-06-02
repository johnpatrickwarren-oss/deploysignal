// tools/_per-tick-detector-trace-types.ts — Q63 SPEC-3 implementation.
//
// Shared types + detector enumeration for the per-tick detector trace
// tool primitive. Extracted verbatim from tools/per-tick-detector-trace.ts
// during a mechanical god-file split (no behavior change).

// ── Public types ─────────────────────────────────────────────────

export type DetectorFamily =
  | 'family_A_betting' | 'family_A_page_cusum'
  | 'family_C_safe_test' | 'family_C_chi_square'
  | 'family_D_spectral' | 'family_D_kv_cache'
  | 'family_E_conformal'
  | 'mmd_betting' | 'mmd_bootstrap_null'
  | 'family_B_pattern_match';

export interface PerTickDetectorTraceOpts {
  /** Compiled config substrate path. */
  substrate: string;
  /** Demo scenario name (looks up demos/scripts/<name>.json) OR
   *  absolute path to demo JSON. */
  scenario: string;
  /** Tick range to trace. Format: 'all' | 'N:M' (inclusive) | 'N,M,P,…'. */
  ticks: string;
  /** Detector subset to trace. 'all' | comma-separated DetectorFamily. */
  detectors: string;
  /** Diagnostic memo emission path. */
  outputPath: string;
  /** Optional override (skips file read; used by tests). */
  compiledConfigOverride?: unknown;
  /** Optional override (skips demo JSON read; used by tests). */
  scenarioOverride?: DemoScenario;
}

export interface PerTickRecord {
  tick: number;
  timestamp_offset_ms?: number;
  detector: DetectorFamily;
  detector_variant?: string;
  cell_lookup: {
    requested_key: { hour_of_day?: number; day_of_week?: number; tenant_tier?: string };
    resolved_key: { hour_of_day?: number; day_of_week?: number; tenant_tier?: string } | null;
    resolution_path: 'per_cell' | 'aggregate_fallback' | 'sliding_buffer' | 'no_match';
  };
  compile_source: {
    object_path: string;
    object_subset?: unknown;
  };
  per_detector_input: {
    live_metrics: Record<string, number>;
    trend_buffer_state?: unknown;
  };
  per_detector_computation: {
    statistic_value: number | null;
    threshold: number | null;
    intermediate_state?: Record<string, unknown>;
  };
  firing_decision: 'fire' | 'clean' | 'suppressed' | 'no_data' | 'indeterminate';
  firing_id?: string;
  signal?: string;
}

export interface PerTickTraceSummary {
  total_ticks_traced: number;
  total_detectors_traced: number;
  total_firings: number;
  per_detector_firing_counts: Record<string, number>;
}

export interface PerTickDetectorTraceReport {
  per_tick_records: PerTickRecord[];
  summary: PerTickTraceSummary;
  first_divergence_tick: number | null;
  first_divergence_detector: DetectorFamily | null;
  diagnostic_memo_path: string;
}

export interface DemoScenario {
  id?: string;
  name?: string;
  baseline_ref?: string;
  baseline?: Record<string, number>;
  total_ticks: number;
  currentHourOfDay?: number;
  currentDayOfWeek?: number;
  bakeHours?: number;
  cadence_ms?: number;
  ticks: Array<{ metrics: Record<string, number>; pause_beat?: boolean }>;
}

// ── Detector enumeration ─────────────────────────────────────────

export const ALL_DETECTORS: readonly DetectorFamily[] = [
  'family_A_betting', 'family_A_page_cusum',
  'family_C_safe_test', 'family_C_chi_square',
  'family_D_spectral', 'family_D_kv_cache',
  'family_E_conformal',
  'mmd_betting', 'mmd_bootstrap_null',
  'family_B_pattern_match',
];

// ── Detector mapping support types ───────────────────────────────

export interface DetectorVerdictLite {
  verdict: 'fire' | 'indeterminate' | 'clean' | 'suppressed';
  statistic: number | null;
  threshold: number | null;
  signal?: string;
  reason_code?: string;
  family: 'A' | 'B' | 'C' | 'D' | 'E';
}

export interface HealthResultLite {
  rollback?: Array<{ id?: string }>;
  suppressed?: string[];
  family_A_shadow?: DetectorVerdictLite[];
  family_C_verdict?: DetectorVerdictLite;
  family_C_mmd_verdict?: DetectorVerdictLite;
  family_D_shadow?: DetectorVerdictLite[];
  family_E_verdict?: DetectorVerdictLite;
}

// engine/types/metrics.ts — Live signal values, baseline, flags, trend
// buffer contract, multi-scale snapshots.

import type { BettingEProcessState } from './families/a';
import type { MixtureSupermartingaleState } from '../detectors/family-a-mixture-supermartingale';
import type { SafeHotellingState, EMmdState } from './families/c';
import type { SpectralEDetectorState } from './families/d';
import type { ConformalEValueState } from './families/e';

// ── Metrics + baseline ────────────────────────────────────────────

/**
 * Live signal values for the current tick. Keys mirror baseline keys.
 * Quality fields (eval_score, refusal_rate, output_len_p50, tool_success_rate)
 * are optional — scenarios without quality metrics omit them.
 */
export interface Metrics {
  p99_latency: number;
  ttft: number;
  tokens_turn: number;
  kv_cache: number;
  cost_req: number;
  downstream_err: number;
  mfu: number;
  hbm_spill: number;
  collective_ops: number;
  corpus_delta: number;
  traffic_pct: number;
  eval_score?: number;
  refusal_rate?: number;
  output_len_p50?: number;
  tool_success_rate?: number;
  [key: string]: number | undefined;
}

/** Reference signal values for comparison. Same shape as Metrics. */
export type Baseline = Metrics;

// ── Flags ─────────────────────────────────────────────────────────

/**
 * Boolean signal flags from upstream systems (security scans, contract
 * tests, provenance checks). Driven by the change-management surface.
 */
export interface Flags {
  security?: boolean;
  artifact_content?: boolean;
  artifact_severity?: 'critical' | 'high' | 'medium' | 'low';
  provenance?: boolean;
  contract?: boolean;
  toolchain?: boolean;
  approval?: boolean;
  zeta?: boolean;
  [key: string]: boolean | string | undefined;
}

// ── Trend ─────────────────────────────────────────────────────────

/**
 * Result of TrendBuffer.get(key). Computed from up to `windowSize` recent
 * observations. `insufficient: true` means n < 4 — callers must short-circuit.
 */
export interface TrendSnapshot {
  slope: number;
  slopeNorm: number;
  stable: boolean;
  cv: number;
  mean: number;
  roc: number;
  min: number;
  max: number;
  range: number;
  n: number;
  insufficient: boolean;
  /** Populated by audit._finalize via trendStrength(t, 'rise'); 0 elsewhere. */
  trendStrength?: number;
}

/** TrendBuffer instance contract — see engine/core.ts.
 *
 * Week-1 addition: the buffer keeps three parallel ring buffers (short/medium/long).
 * `data` is the medium view (length `window`, default 10) and is the view existing
 * detectors read via `get()`. `snapshot()` returns the multi-scale summary — not
 * consumed by any detector in Week 1. */
export interface TrendBufferI {
  window: number;
  windowShort: number;
  windowLong: number;
  data: { [key: string]: number[] };
  dataShort: { [key: string]: number[] };
  dataLong: { [key: string]: number[] };
  /** Week 2: Page-CUSUM state per Family A signal. Persists across ticks
   *  for the lifetime of a deploy — the orchestrator caller owns the
   *  TrendBuffer per-deploy, so clearing on deploy boundary happens via
   *  the caller's new TrendBuffer() allocation or an explicit reset(). */
  cusumStates: { [signal: string]: { S: number; n: number; alphaConsumed: number } };
  /** Addition #18 — Sequential MMD per-deploy state. Used by the second
   *  Family C detector (`engine/detectors/sequential-mmd.ts`). Keyed
   *  with `__mmd` for the window + cached baseline-pool entries. The
   *  detector writes lazily; old TrendBuffer instances without this
   *  field degrade gracefully (detector allocates its own state). */
  mmdStates?: Record<string, unknown>;
  /** Addition #17 — per-(deploy, signal) betting e-process wealth +
   *  moment state. Co-shipped alongside Page-CUSUM under Family A with
   *  a 50/50 α-split. Consumer: `engine/detectors/betting-e-process.ts`.
   *  Optional so pre-#17 TrendBuffer instances degrade gracefully
   *  (detector lazy-initializes the map when missing). */
  bettingStates?: { [signal: string]: BettingEProcessState };
  /** Q66 Phase-3.d.A close (item g) — per-(deploy, signal) state for
   *  the Family A Howard-Ramdas-2021 mixture-supermartingale Page-CUSUM
   *  variant. Optional so pre-Phase-3.d.A TrendBuffer instances degrade
   *  gracefully (detector lazy-initializes the map when missing). */
  mixtureSupermartingaleStates?: { [signal: string]: MixtureSupermartingaleState };
  /** Addition #20 — per-(deploy, cell) safe-Hotelling e-process state
   *  keyed by `__sh_<tier>_<hour>_<day>`. Consumer:
   *  `engine/detectors/hotelling.ts` evaluateFamilyC (safe_test dispatch
   *  branch). Optional + lazy-initialized so pre-#20 TrendBuffers degrade
   *  gracefully (detector's chi_square fallback path needs no state). */
  safeHotellingStates?: Record<string, SafeHotellingState>;
  /** Addition #20 — per-(deploy, cell) e-MMD betting-e-process state
   *  keyed by `__emmd_<tier>_<hour>_<day>`. Consumer:
   *  `engine/detectors/sequential-mmd.ts` evaluateEMmd. Optional + lazy-
   *  initialized so pre-#20 TrendBuffers degrade gracefully. */
  eMmdStates?: Record<string, unknown>;
  /** Q67 SPEC Phase-3.d.B — per-(deploy, cell) canonical Shekhar-Ramdas-2023
   *  betting-e-process state keyed by `__fc_betting_<tier>_<hour>_<day>`.
   *  Consumer: `engine/detectors/family-c-betting-e-process.ts`
   *  evaluateFamilyCBettingEProcess. Optional + lazy-initialized so
   *  pre-Q67 TrendBuffers degrade gracefully (detector returns null on
   *  cells without `betting_e_process_params`). */
  familyCBettingStates?: Record<string, unknown>;
  /** Addition #21 — per-(deploy, signal) spectral e-detector wealth
   *  state keyed by signal name (e.g. `kv_cache`). Consumer:
   *  `engine/detectors/spectral.ts` evaluateFamilyD (e_detector dispatch
   *  branch). Optional + lazy-initialized so pre-#21 TrendBuffers degrade
   *  gracefully (legacy bootstrap-null path is stateless). */
  spectralEDetectorStates?: Record<string, SpectralEDetectorState>;
  /** Addition #22 — per-(deploy, cell) weighted-conformal e-value
   *  wealth state keyed by cell identifier. Consumer:
   *  `engine/detectors/conformal.ts` evaluateFamilyE (weighted_e_value
   *  dispatch branch). Optional + lazy-initialized so pre-#22
   *  TrendBuffers degrade gracefully (legacy unweighted/weighted
   *  conformal paths are stateless). */
  conformalEValueStates?: Record<string, ConformalEValueState>;
  push(key: string, value: number): void;
  get(key: string): TrendSnapshot;
  snapshot(key: string): SignalSnapshot;
  reset(): void;
}

export interface TrendBufferOpts {
  short?: number;
  long?: number;
}

// ── Multi-scale summaries ────────────────────────────────────────

/** Summary of one window of one signal's recent history. */
export interface WindowSummary {
  n: number;
  mean: number;
  std: number;
  slopeNorm: number;
  cv: number;
  trendStrength: number;
}

/** Multi-scale snapshot for one signal. `medium` mirrors the legacy
 * TrendBuffer view; short/long are new in Week 1. */
export interface SignalSnapshot {
  signal: string;
  short: WindowSummary;
  medium: WindowSummary;
  long: WindowSummary;
}

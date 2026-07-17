// tools/_comparator-baseline-types.ts — shared types for the
// comparator-baseline evaluation harness (WS6.2). Mirrors the frozen
// runs/comparator-baseline/ENDPOINTS.md JSON block (EndpointsSpec) plus
// the per-arm result / window-provenance shapes consumed by Tasks 3-8,
// and typed surfaces for the untyped `_build-report-card-*.js` modules
// this harness require()s at runtime (allowJs is off, so those modules
// are accessed through the interfaces below rather than direct typed
// imports — per §0 of the implementation plan, they are required()
// verbatim and never modified/refactored in this PR).

import type { SignalClass } from '../engine/signal-classes';

// ── Per-arm results / window provenance ──────────────────────────────

/** A single arm's result for one evaluated window. `firstFireTick` is the
 *  earliest tick (within the trajectory) at which the arm fired, or
 *  `null` if it never fired. `firingSignals` lists every signal that
 *  contributed to a fire (order not significant).
 *
 *  `fireTicks` (reviewer finding I1) is every tick (ascending, deduped)
 *  at which the arm fired — not just the first. A single global
 *  `firstFireTick` is too lossy for the frozen endpoints: `false_rollbacks`
 *  needs "fired anywhere, any tick" (still exactly `firstFireTick !== null`),
 *  but the eval-injected split's escape ("no fire at t in
 *  [injection_tick, injection_tick + canary window)") and delay ("first
 *  fire at-or-after injection_tick - bake window") endpoints both need to
 *  distinguish a pre-injection false fire from a post-injection detection
 *  — impossible from `firstFireTick` alone if the arm ever fired before
 *  injection. Populated for the comparator arms (threshold, canary, and
 *  their OR-combination) built in this harness. Portfolio arms
 *  (portfolio_alpha / portfolio_combined) only have a single first-fire
 *  tick available from `runGateOverTrajectory` (the frozen report-card
 *  module isn't re-run per-tick to recover a full firing history), so
 *  their `fireTicks` is the degenerate `[firstFireTick]` / `[]` — richer
 *  per-family firing detail for portfolio arms lives in
 *  `perFamilyFirstFireTick` below instead. */
export interface ArmResult {
  armId: string;
  firstFireTick: number | null;
  firingSignals: string[];
  fireTicks: number[];
  /** Portfolio arms only (portfolio_alpha / portfolio_combined): the raw
   *  per-family first-fire tick data from `runGateOverTrajectory`,
   *  preserved so a downstream consumer can apply the D1 post-injection
   *  exclusion rule (per family: a fire counts only if that family's
   *  first-ever fire tick is >= injection_tick — runProfileSweep's rule)
   *  for the eval-injected split, without the driver needing to know
   *  whether a given window is healthy or injected. `false_rollbacks`
   *  (healthy split) needs "fired anywhere, any tick" — that's exactly
   *  `firstFireTick !== null` above; `escaped_regressions` (injected
   *  split) needs the D1-filtered per-family view here instead. */
  perFamilyFirstFireTick?: Record<string, number | null>;
}

/** hour_of_day / day_of_week cell key, as carried on generated
 *  trajectories (`traj.cell_key`) and compiled-config cell records. */
export interface HourDayCellKey {
  hour_of_day: number;
  day_of_week: number;
}

/** Recorded provenance for one window in the evaluation plan — which
 *  split it belongs to, the seed/index that produced it, and (for
 *  injected windows) which regression profile and repeat it is. Used by
 *  the no-leakage test (tuning-seed stream ∩ eval-seed streams = ∅). */
export interface WindowProvenance {
  split: 'tuning' | 'eval_healthy' | 'eval_injected';
  seed: number;
  window_index: number;
  cell_key: HourDayCellKey;
  profile_id?: string;
  repeat?: number;
  /** injection_tick / bake_hours are constant across an entire plan
   *  (sourced from EndpointsSpec.frozen_params at buildWindowPlan time)
   *  but carried per-entry so `materializeWindow(entry, baseline,
   *  compiledConfig)` stays a pure 3-argument function of the entry
   *  (Task 5 §2 spec) without a 4th `endpoints` parameter. */
  injection_tick: number;
  bake_hours: number;
}

/** One entry in the full evaluation plan built by `buildWindowPlan`: the
 *  window's provenance plus its already-generated (pre-injection,
 *  pre-freeze) healthy trajectory. Trajectories for the shared-RNG-stream
 *  splits (`eval_healthy`, `tuning`) are generated eagerly, in the exact
 *  iteration order of the single `mulberry32` instance driving that
 *  split, so the plan itself — not a later lazy materialization step —
 *  is what has to replicate `runFprSweep`'s RNG consumption order
 *  byte-for-byte. `materializeWindow` (Task 5) turns this into the final
 *  {traj, controlTraj, scenario} without needing any further RNG-order
 *  coordination. */
export interface WindowPlanEntry {
  provenance: WindowProvenance;
  trajectory: Trajectory;
}

// ── EndpointsSpec — mirror of the frozen ENDPOINTS.md JSON block ────

export interface ThresholdGridSpec {
  k: number[];
  m: number[];
  selection_rule: string;
}

export interface CanaryGridSpec {
  alpha_c: number[];
  W: number[];
  selection_rule: string;
}

export interface CombinedGridSpec {
  escalation_rule: string;
}

export interface TuningGrids {
  threshold: ThresholdGridSpec;
  canary: CanaryGridSpec;
  combined: CombinedGridSpec;
  tuning_fp_budget: number;
}

export interface DirectionTable {
  up_bad: string[];
  down_bad: string[];
  two_sided: string[];
}

/** Mirrors ENDPOINTS.md's `frozen_params` object exactly. */
export interface FrozenParams {
  eval_seed: number;
  tuning_seed: number;
  healthy_windows: number;
  tuning_windows: number;
  canary_ticks: number;
  injection_tick: number;
  repeats_per_profile: number;
  bake_hours: number;
  resampler: 'iid_bootstrap' | 'parametric_gaussian';
  look_schedule: number[];
  grids: TuningGrids;
  direction_table: DirectionTable;
}

/** Mirrors the full fenced JSON block frozen in ENDPOINTS.md. The
 *  harness loads this at runtime, hard-fails on CLI/frozen_params
 *  disagreement (absent --allow-nonregistered-params), and stamps
 *  `endpoints_version` + a SHA-256 of the JSON block into every report. */
export interface EndpointsSpec {
  endpoints_version: string;
  primary_metrics: string[];
  secondary_metrics: string[];
  arms: string[];
  frozen_params: FrozenParams;
}

// ── Typed surfaces for the require()d report-card modules ───────────

/** Per-signal family_A stats entry. `signal_class` (Q2.A) is the class
 *  this signal's `baseline_mean`/`baseline_sigma_squared` were calibrated
 *  in — TRANSFORMED space when set to anything other than
 *  'gaussian_like'. Optional because pre-Q2.A compiled configs predate
 *  the field entirely (see `../engine/detectors/betting-e-process.ts`'s
 *  runtime resolution comment: absence here means raw-space calibration,
 *  not "assume gaussian_like via DEFAULT_SIGNAL_CLASSES"). */
export interface CompiledCellFamilyAStats {
  family_A?: {
    per_signal?: Record<
      string,
      { baseline_mean: number; baseline_sigma_squared: number; signal_class?: SignalClass }
    >;
  };
}

export interface CompiledCell extends CompiledCellFamilyAStats {
  key: HourDayCellKey & { tenant_tier?: string };
  n_samples: number;
  confidence?: unknown;
  family_C?: unknown;
}

export interface CompiledConfig {
  baseline_cells: {
    dimensions: string[];
    cells: CompiledCell[];
    aggregate_fallback: CompiledCellFamilyAStats;
  };
  /** Q2.A per-deploy signal-class overrides (compile-time). Runtime
   *  resolution order (mirrored by the threshold arm — see
   *  `_comparator-baseline-threshold.ts`'s `resolveMeanSigma`):
   *  `per_signal[<s>].signal_class ?? signal_classes?.[<s>] ??
   *  'gaussian_like'`. */
  signal_classes?: Record<string, SignalClass>;
  [key: string]: unknown;
}

export interface BaselineRun {
  hour_of_day?: number[];
  day_of_week?: number[];
  signal_series: Record<string, number[]>;
}

export interface Baseline {
  manifest: { signals: string[]; [key: string]: unknown };
  runs: BaselineRun[];
  signalMeans: Record<string, number>;
}

export interface SignalSeries {
  [signal: string]: number[];
}

export interface Trajectory {
  signal_series: SignalSeries;
  cell_key: HourDayCellKey;
}

export interface Scenario {
  id: string;
  name: string;
  riskLevel: string;
  bakeHours: number;
  author: string;
  changeType: string;
  timeWindow: string;
  flags: Record<string, boolean>;
  baseline: Record<string, number>;
}

export interface GateOverTrajectoryResult {
  verdict: 'extend' | 'proceed' | 'rollback';
  firstFireTick: number | null;
  firingFamily: string | null;
  firingSignal: string | null;
  firingFamilies: string[];
  perFamilyFirstFireTick: Record<string, number | null>;
  perFamilyFirstSignal: Record<string, string | null>;
  firingDetectorIds: string[];
}

/** Typed surface for `require('./_build-report-card-io')`. */
export interface ReportCardIoModule {
  parseArgs(argv: string[]): Record<string, unknown>;
  mulberry32(seed: number): () => number;
  loadBaseline(dir: string): Baseline;
  ensureCompiledConfig(
    baselineDir: string,
    compiledPath: string | undefined,
    repoRoot: string
  ): { cfg: CompiledConfig; path: string };
}

/** Typed surface for `require('./_build-report-card-cell')`. */
export interface ReportCardCellModule {
  collectCellRows(baseline: Baseline, hourOfDay: number, dayOfWeek: number): Record<string, number>[];
  listPopulatedCells(baseline: Baseline, minSamples: number): (HourDayCellKey & { n_samples: number })[];
  cellMeanFromRows(rows: Record<string, number>[], signals: string[]): Record<string, number>;
  lookupCell(compiledConfig: CompiledConfig, cellKey: HourDayCellKey): CompiledCell | null;
}

/** Typed surface for `require('./_build-report-card-windows')`. */
export interface ReportCardWindowsModule {
  bootstrapHealthyWindow(
    baseline: Baseline,
    cellKey: HourDayCellKey,
    windowLength: number,
    rng: () => number
  ): Trajectory;
  parametricGaussianWindow(
    baseline: Baseline,
    cellKey: HourDayCellKey,
    windowLength: number,
    rng: () => number,
    compiledConfig: CompiledConfig
  ): Trajectory;
  generateHealthyWindow(
    mode: 'iid_bootstrap' | 'parametric_gaussian',
    baseline: Baseline,
    cellKey: HourDayCellKey,
    windowLength: number,
    rng: () => number,
    compiledConfig: CompiledConfig
  ): Trajectory;
}

/** Typed surface for `require('./_build-report-card-gate')`. */
export interface ReportCardGateModule {
  buildScenario(cellMean: Record<string, number>, bakeHours: number): Scenario;
  runGateOverTrajectory(
    traj: Trajectory,
    scenario: Scenario,
    compiledConfig: CompiledConfig,
    canaryTicks: number,
    bakeHours: number
  ): GateOverTrajectoryResult;
  ALPHA_SPENDING_FAMILIES: string[];
  classifyFiringId(
    id: string | null | undefined,
    cellKey: HourDayCellKey,
    compiledConfig: CompiledConfig
  ): 'ville' | 'classical' | 'family_b' | 'unknown';
  ALPHA_VILLE: number;
  ALPHA_CLASSICAL: number;
}

/** Bundle of the four typed report-card module surfaces used by the
 *  Task 5 driver's `require()` call sites. */
export interface ReportCardModules {
  io: ReportCardIoModule;
  cell: ReportCardCellModule;
  windows: ReportCardWindowsModule;
  gate: ReportCardGateModule;
}

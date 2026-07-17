// tools/_comparator-baseline-types.ts — shared types for the
// comparator-baseline evaluation harness (WS6.2). Mirrors the frozen
// runs/comparator-baseline/ENDPOINTS.md JSON block (EndpointsSpec) plus
// the per-arm result / window-provenance shapes consumed by Tasks 3-8,
// and typed surfaces for the untyped `_build-report-card-*.js` modules
// this harness require()s at runtime (allowJs is off, so those modules
// are accessed through the interfaces below rather than direct typed
// imports — per §0 of the implementation plan, they are required()
// verbatim and never modified/refactored in this PR).

// ── Per-arm results / window provenance ──────────────────────────────

/** A single arm's result for one evaluated window. `firstFireTick` is the
 *  earliest tick (within the trajectory) at which the arm fired, or
 *  `null` if it never fired. `firingSignals` lists every signal that
 *  contributed to a fire (order not significant). */
export interface ArmResult {
  armId: string;
  firstFireTick: number | null;
  firingSignals: string[];
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

export interface CompiledCellFamilyAStats {
  family_A?: {
    per_signal?: Record<string, { baseline_mean: number; baseline_sigma_squared: number }>;
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

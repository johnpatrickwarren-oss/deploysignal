// tools/calibrate/_calibrate-types.ts — shared type/interface definitions
// for the NS calibration compiler. Extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file (D-54-3 god-file decomposition). No behavior
// change; pure type surface.

import type {
  CompilerOptions, TenantTier, FamilyCPerCell,
} from '../../engine/types';
import type {
  D6bCellDiagnostic as _D6bCellDiagnosticFromFamilyC,
  FamilyCTimings as _FamilyCTimings,
  FamilyCDiagnostics as _FamilyCDiagnostics,
} from '../calibrators/family-c.js';
import type { CellDimensionDeficiencyMode } from '../profile-loader.js';

export interface PhaseTimingsNs {
  l0_prep_ns: bigint;
  cov_estimation_ns: bigint;
  mmd_bootstrap_ns: bigint;
  conformal_calibration_ns: bigint;
  tau2_fit_ns: bigint;
  worker_pool_overhead_ns: bigint;
  mcd_skipped_low_variance_cells: number;
  mmd_bootstrap_skipped_cells: number;
}

// REPLY-50 Q2 diagnostic — records (λ, outlier_fraction) pairs for
// every MCD-path cell so operators can surface actual D6b hit-rate
// distribution when the architect-projected 30% rate doesn't
// materialize empirically. Type definition lives in
// tools/calibrators/family-c.ts; re-aliased locally so BuildCellReply
// + callsite grep keep the pre-slice-3c name.
export type D6bCellDiagnostic = _D6bCellDiagnosticFromFamilyC;

/** Compile-local aggregator — slice-3d Option-3 completion. Replaces
 *  pre-3d module-level `_phaseTimings` + `_d6bDiagnostics`. One
 *  instance per `main()` invocation. Worker replies unpack into the
 *  main-thread instance after each cell completes; serial-path calls
 *  do the same unpack inline. */
export interface CompileAggregator {
  timings: PhaseTimingsNs;
  d6b_cells: D6bCellDiagnostic[];
}

export interface Args {
  baseline: string;
  alpha: number;
  out: string;
  /** Comma-separated families to emit. Default 'B' (Week-1 behavior). */
  families: string[];
  /** Addition #18 (ARCHITECT-REPLY-33 D2) — operator override for the
   *  per-cell covariance estimator. Absent → compiler picks per sample-
   *  size rule. Present → every cell uses the specified method. */
  covariance_method_override?: 'ledoit_wolf' | 'mcd' | 'mrcd';
  /** FastMCD trimming target α. Default 0.75 → h = ⌈0.75·n⌉, 25 %
   *  breakdown. Accepts values in [0.5, 1]. */
  mcd_alpha?: number;
  /** Addition #19 — operator override for the Family E time-decay
   *  half-life (days). Absent → compiler auto-derives from the
   *  baseline's temporal span. */
  family_e_halflife_days?: number;
  /** Addition #20 (ARCHITECT-REPLY-43 D6) — force legacy Family C
   *  variants (`chi_square` + `bootstrap_null`). Flag presence without
   *  a value (`--force_legacy_family_c`) sets to true; explicit
   *  `--force_legacy_family_c false` leaves at default. */
  force_legacy_family_c?: boolean;
  /** Addition #20 (ARCHITECT-REPLY-43b) — shrink fraction c for the
   *  safe-Hotelling mixture-prior τ² = c · trace(Σ) / p. Default 0.03. */
  family_c_shrink_fraction?: number;
  /** Addition #21 (ARCHITECT-REPLY-45 D2) — force legacy Family D
   *  variant (`bootstrap_null`). Flag presence without a value sets
   *  to true; explicit `--force_legacy_family_d false` leaves at default. */
  force_legacy_family_d?: boolean;
  /** Addition #22 (ARCHITECT-REPLY-46 D2) — force legacy Family E
   *  variant (`weighted` quantile from #19). Flag presence without a
   *  value sets to true; explicit `--force_legacy_family_e false`
   *  leaves at default.
   *
   *  @deprecated ARCHITECT-REPLY-53 R3 — use
   *  `--family_E_variant_selector` instead. Schema-migrated at the
   *  compiler layer for one COMPILER_VERSION cycle. */
  force_legacy_family_e?: boolean;
  /** ARCHITECT-REPLY-53 R3 — unified Family E variant selector. See
   *  `CompilerOptions.family_E_variant_selector` for semantics. */
  family_E_variant_selector?:
    'auto' | 'force_weighted' | 'force_weighted_e_value' | 'force_unweighted';
  /** Addition #28 (REPLY-51 D6) — reference workload profile. Format
   *  `<id>@<semver>`. Absent → legacy compile path (hardcoded α + bake
   *  defaults); byte-identical to pre-#28 output. */
  profile_ref?: string;
  /** Addition #28 (REPLY-51 D8) — customer override YAML file path.
   *  Only meaningful with `profile_ref`; ignored otherwise. */
  customer_override_ref?: string;
  /** REPLY-50 slice-2 D2 — disable worker_threads pool; force serial
   *  in-process buildFamilyCPerCell calls. For shadow-compare +
   *  byte-identity parity tests. Default enabled (pool auto-spawns
   *  when cpu_count > 2). */
  disable_worker_pool?: boolean;
  /** REPLY-51b R4-2 — cell-dimension deficiency mode CLI override
   *  (matches CompilerOptions.cell_dimension_deficiency_mode). */
  cell_dimension_deficiency_mode?: CellDimensionDeficiencyMode;
  /** Q57 (Q57-DEMO-BASELINE-REFRESH-SPEC.md §Contract surfaces) —
   *  demo baseline file path(s) carrying `aggregate_fallback_patch`
   *  overrides. Comma-separated for multiple files. When set, the
   *  compiler reads each file, extracts `aggregate_fallback_patch`,
   *  and applies overrides to BOTH (a) `baselineCells.aggregate_fallback`
   *  per spec literal pseudo-code AND (b) the matching `cells[].
   *  tier='aggregate'` cell scoped by `cell_patch.target_cell` so the
   *  runtime consumption path (page-cusum.ts:lookupCellParams resolves
   *  to cells[].tier='aggregate' for tenantId-less queries) sees the
   *  patched values. P3.3 spot-check finding documented in commit. */
  demo_baseline_patch?: string;
  /** R2 Task 3 (recalibrate refresh) — appended to the compiler-derived
   *  `version` string as `` `${derivedVersion}+${suffix}` `` when
   *  present. Rationale: `CompiledConfig.version` is otherwise a fixed
   *  enum string (`v4-fusion-novelty` …) — successive refreshes would
   *  collide in `promotion_history` and break `rollbackTo` version
   *  lookup. Absent → unchanged version string (determinism guard). */
  version_suffix?: string;
}

export interface CellSamples2D {
  hour: number;
  /** Day-of-week index 0..6 when `cell_dim='hour_of_day_x_day_of_week'`;
   *  -1 when collapsing across days (1-D legacy collection). */
  day: number;
  /** Addition #23 — tenant tier bucket; 'aggregate' for pre-#23 bundles
   *  (no tenant_id). */
  tier: TenantTier;
  /** signal → list of values observed at this (hour, day, tier) cell. */
  perSignal: Record<string, number[]>;
}

/** Per-cell multi-signal row collection. Each row is one observation
 *  across all Family C signals at that cell. Rows are what the Hotelling
 *  T² covariance is computed over — the per-signal `cells[*].perSignal[*]`
 *  store loses the row alignment needed for covariance. */
export interface FamilyCRowsPerCell {
  hour: number;
  day: number;
  tier: TenantTier;
  rows: number[][];
}

export interface BuildCellTask {
  id: number;
  rows: number[][];
  opts: CompilerOptions;
  key: Record<string, string | number>;
  alphaMMD?: number;
}

/** Slice-3d worker-dispatch contract. Pre-3d emitted separate
 *  `cell` + `timingsDelta` + `d6bDelta` fields (module-state snapshot
 *  pathway). Post-3d returns the structured FamilyCBuildResult
 *  directly: { result, timings, diagnostics } matches the pure
 *  family-c.ts return shape and unpacks identically on both serial
 *  and worker paths. */
export interface BuildCellReply {
  id: number;
  result?: {
    result: FamilyCPerCell;
    timings: _FamilyCTimings;
    diagnostics: _FamilyCDiagnostics;
  };
  error?: string;
}

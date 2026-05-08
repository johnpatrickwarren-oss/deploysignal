// engine/types/config.ts — CompiledConfig, CompilerOptions, baseline
// bundle shapes, workload-profile types, tenant-tier configuration,
// compile-phase instrumentation.

import type { CellKey } from './primitives';
import type { ConfiguredAgent } from './agent';
import type { FamilyAPerSignalParams } from './families/a';
import type { FamilyCPerCell } from './families/c';
import type { FamilyDPerSignal } from './families/d';
import type { ConformalParams } from './families/e';

// ── Misc shared constants type ────────────────────────────────────

export interface WarmupConfig {
  triggeredBy: string[];
  windowHours: { critical: number; high: number; medium: number; low: number };
  graceWindowHours: number;
  absoluteBypass: { [signalId: string]: number };
  suppressedSignals: string[];
}

export interface FpClassifierConfig {
  capacityEarlyRollbackMinTick: number;
}

// ── North-Star runway types ──────────────────────────────────────
// Week-1 NS foundations. No runtime consumers yet this week — the compiler
// (tools/calibrate.ts) emits CompiledConfig, the generator (tools/gen-synthetic-
// baseline.ts) emits BaselineBundle, and the compiler-equivalence gate
// (test/compiler-equivalence.test.js) wires both in. Detectors still read the
// medium TrendBuffer view during Week 1; multi-scale detector rewiring lands
// in later weeks.

/** Addition #23 — coarse tenant-traffic tier bucket used as a cell-matrix
 *  dimension. Assigned at compile time from per-tenant traffic fraction
 *  over the baseline window (defaults: ≥0.50 'dominant', ≥0.10 'large',
 *  ≥0.01 'medium', <0.01 'small'). `'aggregate'` is the backward-compat
 *  tier emitted on pre-#23 (no-tenant-id) bundles so existing cell
 *  lookups continue to match. `string` escape allows operator-custom
 *  tier labels via `CompilerOptions.tenant_tier_config.manual_overrides`. */
export type TenantTier =
  | 'dominant'
  | 'large'
  | 'medium'
  | 'small'
  | 'aggregate'
  | string;

/** Addition #23 — compiler-time tenant-tier configuration. Boundaries are
 *  traffic-fraction cutoffs (each tier label ≥ its cutoff); defaults are
 *  D1 architect values. `manual_overrides` is an escape hatch for
 *  platforms with known-VIP tenants that should be treated as 'large'
 *  even at low traffic fraction. */
export interface TenantTierConfig {
  boundaries: {
    dominant: number;
    large: number;
    medium: number;
  };
  manual_overrides?: Record<string, TenantTier>;
}

/** Versioned detector configuration emitted by tools/calibrate.ts.
 *
 * Week 3 schema refactor (ARCHITECT-REPLY-09.md Q1): cell-segmented
 * baselines live under `baseline_cells`; Family B stays flat; Family C
 * scaffolds into the same cell blocks. The Week-2 `family_A` top-level
 * block is retired — its data moved under `baseline_cells.cells[key].family_A`. */
export interface CompiledConfig {
  version: string;
  compiler_version: string;
  compiled_at: string;
  baseline_ref: string;
  alpha_budget: {
    total: number;
    per_family: Record<string, number>;
  };
  /** Family-A-specific; preserved from W2 for audit provenance. */
  bonferroni_factor?: number;
  /** Family B structural-signatures config. REPLY-51b R4-4 relaxed
   *  this from required → optional per strict-additive schema change
   *  (matches REPLY-43 D5 family_C precedent; no COMPILER_VERSION
   *  bump). Absent when profile's `structural_detectors.enabled` is
   *  false (generic-microservice@1.0.0 pattern); legacy + streaming
   *  compiles continue to emit it. Runtime consumers MUST null-check
   *  (`if (!config.family_B) return`) before accessing cutoffs. */
  family_B?: {
    cutoffs: Record<string, number>;
    vote_thresholds: Record<string, number>;
  };
  /** Week 3: unified cell-segmented baselines. Absent for W1 legacy
   *  configs; present when Families A/C are compiled. Detectors read
   *  `baseline_cells.cells[key].family_A` and `.family_C`; fall back to
   *  `aggregate_fallback` when a cell's `confidence ∈ {aggregate, none}`. */
  baseline_cells?: BaselineCellsConfig;
  /** Week 3 (Addition #4): signal-level bake profile, keyed by signal id.
   *  Applies to Families A, C, D, E; Family B has its own warmup config. */
  bake_profiles?: Record<string, BakeProfile>;
  /** PM-critique item 4: detectors suppress fires when live traffic_pct
   *  is below this threshold. Optional — absence means no gate. */
  traffic_pct_gate?: { min_traffic_pct_for_fire: number };
  /** Addition #23 — runtime lookup table from `tenant_id` to `TenantTier`.
   *  Populated by the compiler when the baseline bundle carries
   *  `tenant_id` on its runs; absent for pre-#23 (no-tenant) bundles
   *  (runtime treats every request as `'aggregate'` tier). */
  tenant_tier_map?: Record<string, TenantTier>;
  /** Addition #23 — the boundaries + overrides the compiler used to
   *  bucket tenants. Carried on the config so audit provenance can hash
   *  it (`tenant_tier_config_hash`) and operators can verify the tiering
   *  rule didn't change silently between deploys. */
  tenant_tier_config?: TenantTierConfig;
  /** REPLY-50 D7 — compile-phase instrumentation. Optional for
   *  backward-compat with pre-streamlining configs that lack the
   *  field. Diagnostic-only (not load-bearing on correctness). */
  compile_phases?: CompilePhases;
  /** Addition #28 (ARCHITECT-REPLY-51 D6) — reference workload
   *  profile used to parameterize this compile. Format
   *  `<id>@<semver>`, e.g., `llm-inference-streaming@1.0.0`. Absent
   *  on legacy (pre-#28) compiles + compiles run without
   *  `CompilerOptions.profile_ref`. Audit reproducibility: given the
   *  profile_ref + customer_override_ref, an operator can look up
   *  the exact profile version via git history of the `profiles/`
   *  directory and re-derive the effective_config. */
  profile_ref?: string;
  /** Addition #28 (REPLY-51 D8) — customer override reference when
   *  an override layer composes on top of the base profile. Format
   *  `<customer_id>@<semver>`. Absent when no override was applied. */
  customer_override_ref?: string;
  /** REPLY-51b R4-3 — G1 policy-profile defaults sourced from the
   *  active profile's `policy_defaults` YAML block. Optional for
   *  backward-compat; legacy (pre-#51b) compiles omit the field.
   *  engine/gates/policy.ts reads with fallback to hardcoded. */
  policy_defaults?: {
    reversibility_threshold_minutes: number;
    auto_rollback_enabled: boolean;
    default_risk_tier: 'low' | 'medium' | 'high';
  };
  /** REPLY-51b v2 R4-1 — Family A monitored-signal inventory per
   *  Phase 4 compile-time shape resolution. Profile-routed compiles
   *  emit the effective `sli_list` signal array; legacy compiles
   *  omit the field. Runtime detectors (page-cusum, betting-e-
   *  process) read with fallback to hardcoded `FAMILY_A_PRIMARY_
   *  SIGNALS` when absent. Under A3, runtime operates on compiled
   *  shape; no per-tick signal projection. */
  family_a_signals?: string[];
  /** REPLY-51b v2 R4-1 — Family C/E joint-vector signal inventory.
   *  Profile-routed compiles emit the effective `joint_vector.
   *  signals` array; legacy compiles omit. Runtime detectors
   *  (hotelling, sequential-mmd, conformal) read with fallback to
   *  hardcoded `FAMILY_C_SIGNALS`. Compiled covariance matrix +
   *  mean_vector dimensions match this inventory's length. */
  family_c_signals?: string[];
  /** REPLY-51b R4-2 — compile-time warnings accumulated during
   *  dispatch (e.g., `CELL_DIM_BASELINE_DEFICIENCY` when profile
   *  requests a cell dimension the baseline lacks). Programmatic
   *  inspection channel; stderr emission is unconditional. Absent
   *  when the compile produced no warnings. */
  compile_warnings?: Warning[];
  /** REPLY-52 D3 — baseline-provenance tag. Populated by ingestion
   *  tooling (`tools/ingest-real-trace.ts`) when a real-data bundle
   *  was compiled; absent on pre-#52 synthetic-only bundles. v1
   *  string enum; v2 may evolve to a discriminated-union form with
   *  per-source metadata for mixed-baseline attribution. */
  baseline_provenance?: BaselineProvenance;
  /** Consolidated activation slice — runtime pass-through of the
   *  compile-time `CompilerOptions.agent` flag. Compiler copies this
   *  field forward so the orchestrator can gate agent invocation
   *  without re-reading CompilerOptions. Absent → agent disabled
   *  (byte-identical pre-#27 behavior). */
  agent?: ConfiguredAgent;

  /** Q2.A — per-signal class declarations driving compile-time
   *  transform + runtime dispatch. Operators can override defaults via
   *  CompilerOptions.signal_classes; absence here = lookup in
   *  DEFAULT_SIGNAL_CLASSES; absence in defaults = 'gaussian_like'.
   *  Compiler emits this field whenever any signal got a non-default
   *  classification or when emit-on-default mode is on. Absent on
   *  pre-Q2.A configs; runtime detector defaults to gaussian_like. */
  signal_classes?: Record<string, import('../signal-classes').SignalClass>;
  /** Q61 SPEC-1 — per-decision audit emission from the 10-decision
   *  baseline curation pipeline (`tools/curate-baseline-pipeline.ts`).
   *  SLICE 1 emits D1-D4; SLICE 2 emits D5-D7; SLICE 3 emits D8-D10.
   *  Sparse object during pipeline-phasing transition (only the
   *  implemented slices' decisions populated). Optional + additive;
   *  pre-Q61 consumers ignore the field. */
  baseline_curation_pipeline_diagnostics?: Partial<Record<BaselineCurationDecisionId, BaselineCurationDecision>>;
}

/** Q61 SPEC-1 — 10-decision baseline curation pipeline canonical
 *  decision identifier. SLICE 1 ships D1-D4; SLICE 2 ships D5-D7;
 *  SLICE 3 ships D8-D10. */
export type BaselineCurationDecisionId =
  | 'D1' | 'D2' | 'D3' | 'D4'
  | 'D5' | 'D6' | 'D7'
  | 'D8' | 'D9' | 'D10';

/** Q61 SPEC-1 — per-decision audit-emission record. Each decision in
 *  the baseline curation pipeline emits one of these, capturing the
 *  decision's inputs (upstream decisions + compile state), output,
 *  decision rule (architect prior-spec citation), verification
 *  (audit-emitted boolean + diagnostic path), and source-memorialization
 *  (architect-prior-spec reference). Audit trail enables Reviewer
 *  cross-references + future spec-drafting layer-attribution. */
export interface BaselineCurationDecision {
  /** Canonical decision identifier (D1-D10). */
  decision_id: BaselineCurationDecisionId;
  /** Human-readable decision name (e.g., 'Per-cell μ aggregation'). */
  decision_name: string;
  /** Decision inputs: upstream-decision dependencies (null for
   *  foundational decisions D1+D3) + opaque compile-state reference. */
  inputs: {
    upstream_decisions?: BaselineCurationDecisionId[];
    /** Opaque compile-state reference; downstream consumers shouldn't
     *  parse — exists for audit-trail traceability only. */
    compile_state_ref: string;
  };
  /** Opaque output reference. The actual numeric outputs (per-cell μ
   *  arrays, Σ matrices, sliding-buffer thresholds) live on existing
   *  CompiledConfig fields; this field captures the audit summary
   *  (e.g., {n_cells, n_signals} for D1) — NOT a duplicate of the
   *  existing CompiledConfig payload. */
  output_summary: Record<string, number | string | boolean>;
  /** Brief rule citation (architect-prior-spec memory). */
  decision_rule: string;
  /** Audit-emission verification: confirms the decision's diagnostic
   *  was emitted at the expected path. */
  verification: {
    audit_emitted: boolean;
    diagnostic_path: string;
  };
  /** Architect prior-spec citation (e.g., 'ARCHITECT-REPLY-Q2-B-4-…'). */
  source_memorialization: string;
}

/** REPLY-51b R4-2 — fast-path metadata read from the baseline bundle
 *  manifest without materializing samples. Consumed by the profile-
 *  dispatch layer to reconcile profile-requested cell dimensions
 *  against what the baseline actually supports (three-case per
 *  REPLY-51a D4). */
export interface BundleMetadata {
  /** Which cell-matrix dimensions the baseline carries enough
   *  metadata to emit along. hour_of_day is always true for any
   *  well-formed bundle (cell_dim !== null). day_of_week true when
   *  cell_dim === 'hour_of_day_x_day_of_week'. tenant_tier true
   *  when manifest.tenants > 1 (or bundle carries per-run tenant_id).
   *  workload_class + region currently always false (no manifest
   *  support; post-phase additions). */
  available_dimensions: {
    hour_of_day: boolean;
    day_of_week: boolean;
    workload_class: boolean;
    tenant_tier: boolean;
    region: boolean;
  };
  /** Total sample count (for diagnostic + audit); sum of
   *  n_runs × ticks_per_run from the manifest. */
  sample_count: number;
  /** Temporal span in days covered by the bundle. When not
   *  explicitly stamped on the manifest, defaults to 0 (reader
   *  treats 0 as "unknown"). */
  temporal_span_days: number;
  /** Matches manifest.version / bundle.version (e.g., `'synthetic-v1'`). */
  source_id: string;
  /** Bundle-generator version stamp for audit provenance.
   *  Defaults to `source_id` when the manifest doesn't expose a
   *  distinct ingestion-tool version. */
  ingestion_version: string;
}

// ── REPLY-52 regression-profile types ────────────────────────────────
//
// Hand-curated regression profiles per §D4 — used by
// tools/inject-regression.ts to mutate baseline sample series at a
// chosen T_inject tick for shadow-compare validation. v1 profiles
// derived from public postmortems; no ML inference on postmortem
// narratives per architect anti-scope.

/** Delta-scale discriminator per REPLY-52 D4 architect refinement.
 *  Profile authors declare intent explicitly; no default. */
export type RegressionDeltaKind =
  | 'absolute'
  | 'relative_to_baseline_sigma'
  | 'relative_to_baseline_mean';

export interface RegressionInjectionPoint {
  /** Ticks after T_inject at which this delta activates. Step-
   *  function semantic: latest applicable offset wins. */
  tick_offset: number;
  signal: string;
  delta_kind: RegressionDeltaKind;
  /** Signed magnitude. Units depend on `delta_kind`. */
  delta: number;
}

export interface RegressionProfile {
  id: string;
  source: string;
  duration_minutes: number;
  affected_signals: string[];
  injection_points: RegressionInjectionPoint[];
  expected_detection: {
    family: 'A' | 'B' | 'C' | 'D' | 'E';
    signal?: string;
    notes?: string;
  };
}

/** REPLY-52 D3 — baseline-provenance discriminator. v1 string enum;
 *  v2 (for follow-on) may evolve to discriminated-union with per-source
 *  metadata. Absent on pre-#52 configs (backward-compat). */
export type BaselineProvenance =
  | 'synthetic'
  | 'real_burstgpt'
  | 'real_azure_llm_inference'
  | 'real_mooncake'
  | 'grounded_synthetic'
  | 'mixed'
  // Q62 Slice 2 H1 (HF-only narrowing). Per ARCHITECT-REPLY-Q62-PHASE-
  // 1-2-LS-1-SCHEMA-DRIFT-DISPOSITION § Ask 1 (H1 PICKED): real_alpaserve
  // + real_deepspeed_fastgen DROPPED post-LS-1 schema-drift CRITICAL on
  // both datasets (BERT-era simulator replay; no public trace artifacts
  // respectively). Tagged Phase-3.d Slice 2.b future cycle.
  | 'real_huggingface_lmsys_arena';

/** REPLY-51b R4-2 — compile-time warning payload. Lightweight
 *  structured log for operator visibility + programmatic
 *  inspection. Emits to stderr + accumulates on
 *  `CompiledConfig.compile_warnings`. */
export interface Warning {
  /** Short machine-readable tag. Canonical codes:
   *    'CELL_DIM_BASELINE_DEFICIENCY' — profile enables a cell
   *      dimension the baseline bundle doesn't carry metadata
   *      for; dimension collapses per `cell_dimension_deficiency_
   *      mode`. */
  code: 'CELL_DIM_BASELINE_DEFICIENCY' | string;
  /** Human-readable message (rendered to stderr). */
  message: string;
  /** Structured payload for programmatic consumers. */
  context: Record<string, unknown>;
}

/** REPLY-50 D7 — per-phase wall-clock timings (milliseconds) collected
 *  during compile. `cov_estimation_ms` is the H1+H2 dominant cost
 *  (FastMCD per-cell + global aggregateFamilyC). Residual between the
 *  sum of per-phase counts and `total_ms` captures overhead not
 *  attributed to a specific phase (e.g., worker-pool setup, JSON
 *  serialization). All fields in milliseconds, rounded to int. */
export interface CompilePhases {
  l0_prep_ms: number;
  cov_estimation_ms: number;
  mmd_bootstrap_ms: number;
  conformal_calibration_ms: number;
  tau2_fit_ms: number;
  /** Time spent in worker_threads overhead (pool setup, serialization,
   *  aggregation). Zero when worker pool is disabled or pool size = 1
   *  (serial fallback). Populated by slice-2 work; field is present
   *  from slice-1 so the schema is stable. */
  worker_pool_overhead_ms: number;
  total_ms: number;
  /** REPLY-50 D6b — count of cells where MCD was skipped in favor of
   *  Ledoit-Wolf due to low-variance / low-outlier diagnosis. Useful
   *  for regression tracking of the D6b hit rate (Q2 watchpoint). */
  mcd_skipped_low_variance_cells?: number;
  /** REPLY-50 D4 — count of cells where MMD bootstrap was skipped
   *  because `mmd_variant === 'betting_e_process'`. Expected ≈ total
   *  cells on post-Ville-full compiles. */
  mmd_bootstrap_skipped_cells?: number;
}

/** Healthy-baseline input to the compiler. `signal_series` is a per-signal
 * array of tick values, all arrays the same length within a run.
 *
 * Week 2: adds optional `cell_dim` and per-run `hour_of_day[]` so the
 * compiler can slice the baseline by context cell. `cell_dim` is absent on
 * Week-1 bundles; consumers must treat absence as "no cell structure". */
export interface BaselineBundle {
  version: string;
  generated_at: string;
  seed: number;
  /** Week 2 PM-critique item 2: 'hour_of_day'. W3 ARCHITECT-REPLY-09.md:
   *  extends to 'hour_of_day_x_day_of_week'. When 2-D, each run carries a
   *  `day_of_week[]` array alongside `hour_of_day[]`. */
  cell_dim?: 'hour_of_day' | 'hour_of_day_x_day_of_week';
  runs: Array<{
    tenant_id?: string;
    signal_series: Record<string, number[]>;
    /** Hour-of-day label per tick (0..23). Present iff `cell_dim` is set. */
    hour_of_day?: number[];
    /** Day-of-week label per tick (0..6, Sun=0). Present iff
     *  `cell_dim === 'hour_of_day_x_day_of_week'`. */
    day_of_week?: number[];
  }>;
}

// ── Baseline cells + detector types ──────────────────────────────
// Week 2 scaffolded Family A on a flat `family_A.cells[hour]` map;
// Week 3 (ARCHITECT-REPLY-09.md Q1) migrates that into a unified
// `baseline_cells` matrix and adds Family C per-cell covariance.

/** One cell in the `baseline_cells.cells` array. */
export interface BaselineCellEntry {
  key: CellKey;
  n_samples: number;
  confidence: 'strict' | 'pooled' | 'aggregate' | 'none';
  /** Populated iff `confidence === 'pooled'`; lists the adjacent cells
   *  whose samples were combined to hit `min_samples_pooled`. */
  pooled_from?: CellKey[];
  /** True when pooling inflated the effective variance; Reviewer X4
   *  signals this so L3 fusion can widen thresholds conservatively. */
  variance_inflated?: boolean;
  family_A?: { per_signal: Record<string, FamilyAPerSignalParams> };
  family_C?: FamilyCPerCell;
  /** Week 4: per-cell conformal calibration for Family E novelty detection. */
  family_E?: ConformalParams;
  /** Week 4: per-cell spectral null distribution for Family D ACF peaks.
   *  Keyed by signal because ACF is per-signal. */
  family_D?: Record<string, FamilyDPerSignal>;
}

export interface BaselineCellsConfig {
  dimensions: Array<'hour_of_day' | 'day_of_week' | 'workload_class' | 'tenant_slice' | 'tenant_tier' | 'region'>;
  cells: BaselineCellEntry[];
  aggregate_fallback: {
    family_A?: { per_signal: Record<string, FamilyAPerSignalParams> };
    family_C?: FamilyCPerCell;
    family_E?: ConformalParams;
    family_D?: Record<string, FamilyDPerSignal>;
  };
}

/** Signal-level bake profile per Addition #4. Not cell-varying — all cells
 *  for a given signal share the same profile; diurnal time-to-stability
 *  variation is encoded in per-cell `baseline_sigma_squared` instead. */
export interface BakeProfile {
  min_ticks_before_eligible: number;
  min_observation_window: number;
  max_deploy_window_days: number;
}

/** Addition #18 — compiler-side options consumed by `tools/calibrate.ts`
 *  when deriving `FamilyCPerCell`. Not part of the runtime surface; the
 *  engine does not read this at evaluation time. */
export interface CompilerOptions {
  /** Addition #18 D2 — operator override for the per-cell covariance
   *  estimator choice. When absent the compiler follows the sample-size
   *  rule (MCD for n ≥ 2p+1 and p ≤ 20, MRCD for n < 2p+1 and p ≤ 20,
   *  Ledoit-Wolf for p > 20). When present, every cell gets the
   *  specified method regardless of sample size. */
  covariance_method_override?: 'ledoit_wolf' | 'mcd' | 'mrcd';
  /** Addition #18 — FastMCD trimming target `α` (fraction of samples in
   *  the core subset `h = ⌈α·n⌉`). Must satisfy 0.5 ≤ α ≤ 1. Default
   *  0.75 gives a 25 % breakdown point. */
  mcd_alpha?: number;
  /** Addition #19 (ARCHITECT-REPLY-35 D3) — operator override for the
   *  Family E time-decay half-life (days). Absent → compiler auto-derives
   *  as `min(baseline_age_span_days / 2, 14)`. Present → every cell uses
   *  the specified half-life regardless of baseline span. `λ = log(2) /
   *  halflife_days` drives the exponential-decay weights attached to the
   *  parametric-bootstrap calibration scores. */
  family_e_halflife_days?: number;
  /** Addition #20 (ARCHITECT-REPLY-43 D6) — operator escape hatch that
   *  forces legacy Family C variants (`chi_square` + `bootstrap_null`)
   *  even on post-#20 compiler runs. Used for shadow-compare + audit-
   *  trail reproducibility on historical pre-#20 runs. Absent or false
   *  → compiler emits new defaults (`safe_test` + `betting_e_process`).
   *  Legacy detector paths remain in the runtime per D6 anti-scope;
   *  this flag just pins the compiler-emitted variant. */
  force_legacy_family_c?: boolean;
  /** Addition #20 (ARCHITECT-REPLY-43b — revised from original D4) —
   *  shrink fraction `c` driving the safe-Hotelling mixture-prior
   *  derivation `τ² = c · trace(Σ) / p`. Default 0.03 matches chi_square
   *  fire-timing parity on 2σ joint drift. Scale-invariant: the knob
   *  is dimensionless rather than in relative-deviation-magnitude
   *  units, so operator intuition about c transfers across baselines
   *  with different covariance scales. Higher c → stronger mixture
   *  prior → slower fire under drift; lower c → weaker prior → faster
   *  fire but higher false-positive risk near H₀. */
  family_c_shrink_fraction?: number;
  /** Addition #21 (ARCHITECT-REPLY-45 D2) — operator escape hatch that
   *  forces legacy Family D variant (`bootstrap_null`) even on post-#21
   *  compiler runs. Used for shadow-compare + audit-trail reproducibility
   *  on historical pre-#21 runs. Absent or false → compiler emits new
   *  default (`e_detector`). Legacy detector path remains in the runtime
   *  per D6 anti-scope; this flag just pins the compiler-emitted variant. */
  force_legacy_family_d?: boolean;
  /** Addition #22 (ARCHITECT-REPLY-46 D2) — operator escape hatch that
   *  forces legacy Family E variant (`weighted` quantile from #19) even
   *  on post-#22 compiler runs. Used for shadow-compare + audit-trail
   *  reproducibility on historical pre-#22 runs. Absent or false →
   *  compiler emits new default (`weighted_e_value`). Legacy detector
   *  paths remain in the runtime; this flag just pins the compiler-
   *  emitted variant.
   *
   *  @deprecated ARCHITECT-REPLY-53 R3 — superseded by
   *  `family_E_variant_selector`. Retained for backward-compat one
   *  COMPILER_VERSION cycle (through 0.3.x; removal planned at 0.4.0).
   *  Schema-migration: `true → 'force_weighted'`, `false → 'auto'`.
   *  When both fields are present, `family_E_variant_selector` wins. */
  force_legacy_family_e?: boolean;
  /** ARCHITECT-REPLY-53 R3 — unified Family E variant selector
   *  (promotes the pre-R3 internal conditional to a visible operator
   *  surface). Hybrid pattern: A/C/D remain boolean (`force_legacy_
   *  family_{a,c,d}`) since they have binary choices; E carries three
   *  kinds with a conditional gate between them, so the selector is
   *  the natural fit.
   *
   *  Selector semantics:
   *    - `'auto'` (default) — REPLY-38 D3 ESS+span gate applied
   *      verbatim. Pass → `kind:'weighted_e_value'` (REPLY-46b
   *      hedged-indicator e-value). Fail → `kind:'unweighted'`
   *      (pre-#19 parametric bootstrap).
   *    - `'force_weighted'` — preserves the ESS+span gate, but emits
   *      the pre-#22 `kind:'weighted'` (weighted quantile from #19)
   *      when the gate passes. Byte-identical to the deprecated
   *      `force_legacy_family_e: true` path.
   *    - `'force_weighted_e_value'` — bypasses the ESS+span gate;
   *      always emits `kind:'weighted_e_value'`. Used for shadow-
   *      compare when operator wants the e-value variant on a
   *      baseline that `'auto'` would route to unweighted.
   *    - `'force_unweighted'` — bypasses the gate; always emits
   *      `kind:'unweighted'`. Used for shadow-compare against the
   *      pre-#19 path.
   *
   *  Absent + `force_legacy_family_e` absent → `'auto'` (byte-
   *  identical to pre-R3 default compile). */
  family_E_variant_selector?:
    'auto' | 'force_weighted' | 'force_weighted_e_value' | 'force_unweighted';
  /** Addition #25 (ARCHITECT-REPLY-47 D2) — L3b VerdictGroup time-window
   *  length in seconds. Default 300 (5 min) ≈ one canary at 5s tick
   *  cadence (60 ticks). Groups close when a post-window verdict
   *  arrives OR on terminal verdict. Per-cell override is v2 scope. */
  verdict_group_window_seconds?: number;
  /** Addition #25 (ARCHITECT-REPLY-47 D5) — grace window for late-
   *  arriving verdicts (seconds). A verdict arriving after the
   *  containing group closed but within `grace_seconds` attaches to
   *  the prior group via `late_arrival_verdicts[]` and triggers a
   *  `verdict_group_updated` event. Default 300 (5 min) — covers
   *  max natural detector latency (Family D 30-sample window
   *  ≈ 2.5 min + settle + network lag). */
  verdict_group_grace_seconds?: number;
  /** Addition #25 (ARCHITECT-REPLY-47 D8) — saturation count for the
   *  group-confidence score `min(1, k / saturation)` where `k` is the
   *  count of distinct firing families in the group. Default 3
   *  (single-family fire → 0.33, two families → 0.67, three+ → 1.0). */
  verdict_group_confidence_saturation?: number;
  /** REPLY-50 D6b — low-variance MCD-skip. Compiler runs an LW
   *  pre-check diagnostic on MCD-routed cells and skips MCD in favor
   *  of LW when (λ < 0.1) AND (outlier-fraction under Σ_LW < 0.05).
   *  Default `true` post-slice-2 (Q2 distribution review confirmed
   *  aggregate cell activates cleanly). Explicit `false` restores
   *  slice-1 default-off behavior for byte-identical shadow-compare
   *  against pre-streamlining main. */
  enable_d6b_mcd_skip?: boolean;
  /** Addition #26 (ARCHITECT-REPLY-48 D2) — customer-configured pointer
   *  to a TopologySource. Absent → enrichment path is skipped entirely
   *  and no VerdictGroupWithTopology is emitted (pure-dormant default
   *  per acceptance criteria). */
  topology_ref?: ConfiguredTopologyRef;
  /** Addition #26 (REPLY-48 D4/P1) — window around a VerdictGroup's
   *  `[window_start_ts, window_end_ts]` inside which candidate events
   *  are eligible for temporal-overlap scoring. Default 300 s
   *  (symmetric with VerdictGroup window per D2 alignment). */
  topology_correlation_window_seconds?: number;
  /** Addition #26 (REPLY-48 D4/P1) — BFS hop-count cutoff from the
   *  group's deploy-service node. Default 3 ("beyond 3-hop, correlation
   *  is noise"). Candidates at distance > cutoff are dropped. */
  topology_max_hop_distance?: number;
  /** REPLY-51b R4-2 — cell-dimension baseline-deficiency mode.
   *  Controls compile behavior when the active profile enables a
   *  `cell_dimensions.*` axis the baseline bundle doesn't carry
   *  metadata for:
   *    'warn' (default): emit a Warning (stderr + `compile_warnings[]`),
   *      fall back to disabling the dimension for this compile.
   *    'error': throw a compile-time error; operator must realign
   *      profile vs baseline.
   *    'silent': collapse the dimension without any warning surface.
   *  Legacy (pre-#51b) compiles are unaffected — cell dimensions are
   *  driven off bundle metadata alone when no profile is active. */
  cell_dimension_deficiency_mode?: 'warn' | 'error' | 'silent';
  /** Addition #27 (ARCHITECT-REPLY-49) — agentic rollback proposer.
   *  Absent OR `enabled: false` → agent path never invoked (byte-
   *  identical behavior to pre-#27 compile + runtime). When enabled,
   *  orchestrator fires AgentProposer post-VerdictGroup-close. */
  agent?: ConfiguredAgent;

  /** Q2.A — operator-supplied per-signal class overrides. Compiler
   *  resolution: `cfg.signal_classes[signal] ?? DEFAULT_SIGNAL_CLASSES[signal]
   *  ?? 'gaussian_like'`. Override semantics: apply user overrides as-is
   *  (don't fail compile on `p99_latency: 'heavy_tail'` etc. — operators
   *  may have domain knowledge architect-defaults don't). Compiler emits
   *  resolved classes onto CompiledConfig.signal_classes for runtime
   *  consumption. Absent → all signals resolve via DEFAULT_SIGNAL_CLASSES. */
  signal_classes?: Record<string, import('../signal-classes').SignalClass>;
}

/** Compiler-configured pointer to a customer-hosted topology source.
 *  D2 — DS stays orchestrator-and-topology-source-agnostic; topology
 *  data lives on the customer side, DS queries via URI with an
 *  in-memory TTL cache. */
export interface ConfiguredTopologyRef {
  /** Matches a registered TopologySource.id (v1: 'otel_service_graph_v1'). */
  source_id: string;
  /** Customer-hosted endpoint URI. */
  uri: string;
  /** Fetch timeout in milliseconds. Default 5000 per D2. */
  fetch_timeout_ms?: number;
  /** In-memory snapshot cache TTL in seconds. Default 60 per D2. */
  cache_ttl_seconds?: number;
}

/** Addition #23 — resolve a request's tenant_id to a tenant_tier using
 *  the compiled config's `tenant_tier_map`. Returns `'aggregate'` when
 *  no tenant_id is supplied, when the map is absent (pre-#23 configs),
 *  or when the tenant is unknown to the map — matches runtime fallback
 *  semantics in the detector cell-lookup path. */
export function resolveTenantTier(
  cfg: { tenant_tier_map?: Record<string, TenantTier> } | null | undefined,
  tenantId: string | undefined | null,
): TenantTier {
  if (!tenantId || !cfg?.tenant_tier_map) return 'aggregate';
  return cfg.tenant_tier_map[tenantId] ?? 'aggregate';
}

// ── Addition #28 (ARCHITECT-REPLY-51) — Reference workload profiles ──
//
// YAML-backed template library that parameterizes CompiledConfig
// inputs by workload class. Pre-#3-M0 role: profile IS the Tier 1 +
// Tier 2 defaults surface. Post-M0 role: profile becomes a seed
// catalog for the Metric Registry.
//
// These types mirror the loader-side shapes in `tools/profile-loader.ts`.
// Engine-side code stays runtime-agnostic about profile content; the
// audit surface is `CompiledConfig.profile_ref` + `customer_override_ref`
// (both strings). Consumers that want structured access (e.g., an
// audit-viewer that renders the resolved profile) can reload via
// `loadProfile(profile_ref)` at read time.

export interface WorkloadProfileSliEntry {
  signal: string;
  direction_of_better: 'higher' | 'lower';
  /** Detection magnitude in relative-deviation units. `δ_min` name
   *  preserved from ARCHITECT-REPLY-51 D3 literal spec. */
  δ_min: number;
}

export interface WorkloadProfileBakeEntry {
  signal: string;
  min_ticks_before_eligible: number;
  min_observation_window: number;
  max_deploy_window_days: number;
}

/** Schema-validated reference profile per REPLY-51 D3. See
 *  `profiles/schema/profile.schema.json` for the authoritative
 *  contract. Fields mirror the YAML-side shape 1:1. */
export interface WorkloadProfile {
  id: string;
  version: string;
  extends: string | null;
  description: string;
  sli_list: WorkloadProfileSliEntry[];
  structural_detectors: {
    enabled: boolean;
    dependencies: Array<{ detector_id: string; required_for: string[] }>;
  };
  joint_vector: {
    signals: string[];
    include_in_family_c: boolean;
    include_in_family_e: boolean;
  };
  alpha_allocation: {
    per_family: { A: number; B: number; C: number; D: number; E: number };
    total: number;
  };
  cell_dimensions: {
    hour_of_day: boolean;
    day_of_week: boolean;
    workload_class: boolean;
    tenant_tier: boolean;
    region: boolean;
  };
  bake_profiles: WorkloadProfileBakeEntry[];
  policy_defaults: {
    reversibility_threshold_minutes: number;
    auto_rollback_enabled: boolean;
    default_risk_tier: 'low' | 'medium' | 'high';
  };
}

/** Customer-side override layer per REPLY-51 D8. `overrides` is a
 *  partial `WorkloadProfile` shape; the loader enforces that every
 *  leaf key exists in the base profile schema (no new fields). */
export interface CustomerOverride {
  /** `<profile_id>@<semver>` reference to the base profile. */
  base_profile: string;
  customer_id: string;
  overrides: Partial<WorkloadProfile>;
}

/** Composition output: `deepMerge(profile, override.overrides)` with
 *  provenance refs attached for downstream audit. Carries the full
 *  resolved profile shape plus the two ref strings that land on
 *  `CompiledConfig`. */
export interface EffectiveConfig extends WorkloadProfile {
  profile_ref: string;
  customer_override_ref: string | null;
}

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

// engine/types/_config-compiled.ts — CompiledConfig (the versioned detector
// configuration emitted by tools/calibrate.ts) plus its directly-owned
// satellite types (warmup, fp-classifier, compile-phase instrumentation,
// warnings, baseline provenance, baseline-curation diagnostics). Split out of
// the engine/types/config.ts god-file; re-exported verbatim from there to
// preserve the facade export surface.

import type { ConfiguredAgent } from './agent';
import type { TenantTier, TenantTierConfig } from './_config-tenant';
import type { BaselineCellsConfig, BakeProfile } from './_config-baseline-bundle';

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

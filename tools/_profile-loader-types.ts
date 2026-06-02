// tools/_profile-loader-types.ts — split out of tools/profile-loader.ts.
//
// Pure type/interface declarations for the profile loader. No runtime
// imports back into the loader modules, so this file sits at the base
// of the dependency graph (cycle-free).
//
// Profile shapes are mirrored in `engine/types.ts` as the single
// source of truth for audit consumers; the facade re-exports them
// via `type` so callers can import from either place without
// duplication.

import type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  WorkloadProfileSliEntry, WorkloadProfileBakeEntry,
} from '../engine/types';
export type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  WorkloadProfileSliEntry, WorkloadProfileBakeEntry,
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
}

export type CompileFamilyLetter = 'A' | 'B' | 'C' | 'D' | 'E';

export interface CompileDefaultsBakeEntry {
  min_ticks_before_eligible: number;
  min_observation_window: number;
  max_deploy_window_days: number;
}

export interface CompileDefaults {
  /** Family A monitored signals driving buildFamilyAPerSignal. */
  family_a_signals: string[];
  /** Family C/E joint-vector composition. */
  family_c_signals: string[];
  /** Per-family enable gates post-REPLY-51a D5. Family-disable →
   *  corresponding buildFamilyXPerCell call is skipped entirely;
   *  CompiledConfig's per-family field stays absent. */
  family_enabled: Record<CompileFamilyLetter, boolean>;
  /** Cell-matrix dimension gates post-REPLY-51a D4. `false` collapses
   *  the corresponding axis; `true` + baseline metadata present emits
   *  cells along that axis. */
  cell_dimensions: {
    hour_of_day: boolean;
    day_of_week: boolean;
    workload_class: boolean;
    tenant_tier: boolean;
    region: boolean;
  };
  /** α budget total + per-family. When profile is supplied, values
   *  come from effective.alpha_allocation.*; legacy path falls back
   *  to fraction-based computation in calibrate.ts. */
  alpha: {
    total: number;
    per_family: Record<CompileFamilyLetter, number>;
    /** True when values came from the legacy fraction-based compute;
     *  caller uses this to preserve the FP-residual path for family B
     *  (byte-identity invariant). */
    from_legacy_fractions: boolean;
  };
  /** Per-signal bake-profile overrides merged into the legacy
   *  BAKE_PROFILE map. Empty record on legacy path. */
  bake_profile_overrides: Record<string, CompileDefaultsBakeEntry>;
  /** Populated when the active profile carries policy_defaults.
   *  engine/gates/policy.ts consumes this at runtime. Absent on
   *  legacy / profile-less compiles. */
  policy_defaults?: {
    reversibility_threshold_minutes: number;
    auto_rollback_enabled: boolean;
    default_risk_tier: 'low' | 'medium' | 'high';
  };
  /** Provenance pair — emitted on the final CompiledConfig. */
  profile_ref: string | null;
  customer_override_ref: string | null;
}

export interface LegacyCompileDefaults {
  family_a_signals: string[];
  family_c_signals: string[];
  family_a_alpha_fraction: number;
  family_c_alpha_fraction: number;
  family_d_alpha_fraction: number;
  family_e_alpha_fraction: number;
  alpha_total: number;
  /** Family enable hints from CLI `--families` parsing. Profile
   *  field-gates override these at dispatch time. */
  family_enabled_from_cli: Record<CompileFamilyLetter, boolean>;
  /** Cell-dimension flags derived from the baseline bundle (e.g.
   *  `hour_of_day` always true; `day_of_week` true when bundle is
   *  2-D; `tenant_tier` true when bundle carries tenant_id). */
  cell_dimensions_from_bundle: CompileDefaults['cell_dimensions'];
}

export type CellDimensionDeficiencyMode = 'warn' | 'error' | 'silent';

export interface ReconciledCellDimensions {
  cell_dimensions: CompileDefaults['cell_dimensions'];
  warnings: import('../engine/types').Warning[];
}

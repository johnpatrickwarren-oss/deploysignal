// engine/types/_config-profiles.ts — Addition #28 reference-workload-profile
// types (YAML-backed template library), customer overrides, and the composed
// effective config. Split out of the engine/types/config.ts god-file;
// re-exported verbatim from there to preserve the facade export surface.

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

/** Defect 2026-09-25 — a profile's sli_list as read by the runtime: per signal, the direction of
 *  better and δ_min (relative detection magnitude). Emitted on CompileDefaults and CompiledConfig
 *  as `sli_meta` for profile-routed compiles; legacy compiles carry none. */
export interface SliMetaEntry {
  direction_of_better: 'higher' | 'lower';
  delta_min: number;
}
export type SliMeta = Record<string, SliMetaEntry>;

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
  /** Addition #29 / Q29 — Anvil profile-level defaults for chaos runs.
   *  Optional; absent → adapter must supply full ExpectedFailurePattern
   *  per experiment. Present → adapter may supply partial overrides;
   *  unspecified fields fall back to these defaults. */
  expected_failure_pattern_defaults?: {
    default_suppress_families?: Array<'A' | 'B' | 'C' | 'D' | 'E'>;
    default_recovery_seconds?: number;
    default_magnitude_unit?: 'relative_fraction' | 'absolute' | 'sigma';
  };
  /** C81 (Part 2) — the control arm: per signal, which live metric keys are canary units and
   *  which are their concurrent control twins (matched pairs), plus a control-vs-control cohort
   *  believed null for the Mode gate. Optional; absent → no control arm, byte-identical gate.
   *  Passed through to `CompiledConfig.control_arm` by the compiler; the runtime gate is
   *  engine/gates/_health-contrast.ts (ADVISORY, engine ADR 0032). */
  control_arm?: ControlArmProfile;
  /** Plan B (engine ADR 0036) — the randomized twin: the canary against a concurrent control arm on
   *  the old version under randomized per-request routing. Optional; absent → no twin path. A
   *  profile that declares it runs ONLY the twin path (engine/gates/_health-twin.ts): no Family
   *  A–E and no structural rules. ADVISORY (engine/guarantees.ts TWIN_ARM_AUTHORITY). */
  twin_arm?: TwinArmProfile;
  /** Signals outside the engine's six Family A defaults whose plug-in fires may reach rollback[]
   *  (engine/guarantees.ts FAMILY_A_ROLLBACK_AUTHORITY). An operator decision that accepts the
   *  plug-ins' `validUnderEstimatedBaseline: false` envelope for these signals. Each entry must be
   *  in sli_list (tools/_profile-loader-loading.ts checkSliList). Optional; absent → a custom
   *  signal's Family A fires are advisory. */
  family_a_rollback_signals?: string[];
}

/** Plan B — one twin metric, the engine's TwinMetricSpec in profile form. `rate`: the tolerance is
 *  an excess odds ratio; `sign`: an excess probability over ½. */
export interface TwinArmMetricProfile {
  id: string;
  kind: 'rate' | 'sign';
  worse: 'higher' | 'lower';
  tolerance: number;
}

/** Plan B — the `twin_arm` profile block (profiles/schema/profile.schema.json), field for field the
 *  HTTP contract's `twin_arm` (service/gate-http/README.md "Twin mode"). */
export interface TwinArmProfile {
  /** routing share of the canary within the experiment, w_c / (w_c + w_k). */
  canary_weight: number;
  alpha_rollback: number;
  alpha_proceed: number;
  alpha_srm: number;
  max_ticks: number;
  /** opt in to `rate` metrics at canary_weight ≠ 0.5 (engine ADR 0036: only where an A/A run at
   *  that split shows no arm-level effect). */
  allow_unequal_rate_split?: boolean;
  metrics: TwinArmMetricProfile[];
}

/** C81 — one matched pair: a canary unit and its concurrent control twin, both live metric keys
 *  (e.g. `p99_latency@canary-a`, `p99_latency@control-a`). */
export interface ControlArmPair { signal: string; canary: string; control: string }
/** C81 — one control-vs-control pair believed null (the calibration monitor's input). */
export interface ControlArmCohortPair { signal: string; a: string; b: string }
/** C81 — the `control_arm` profile block (profiles/schema/profile.schema.json). */
export interface ControlArmProfile {
  /** the healthy contrast fit window the caller supplies, in ticks: the regime of the engine's
   *  contrast envelope, and the numerator of the fit ratio the gate is judged on. */
  fit_ticks: number;
  pairs: ControlArmPair[];
  control_cohort: ControlArmCohortPair[];
  /** the ONE e-BH budget across pairs × signals; default engine/guarantees.ts CONTRAST_ARM_Q. */
  q?: number;
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

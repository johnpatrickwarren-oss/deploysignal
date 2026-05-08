// tools/calibrators/effective-config.ts — Post-CODE-COMPLETE Phase 2.
//
// Source-of-truth for profile-effective-config materialization + Family E
// variant-selector resolution. Slice 3d landed this module as a facade
// (re-exports from profile-loader.ts + family-e.ts); this phase moves
// the function bodies here per the ARCHITECT-REPLY-54 D-54-3 original
// spec ("move from wherever it lives"). Facade re-exports stay in the
// original locations for backward-compat.
//
// Pure config resolution; no timing state; no detector math. Byte-
// identical compile output on synthetic-v1 + the 7 canned demos
// (verified against pre-move SHA256 b9610941…).

import type {
  CompilerOptions, EffectiveConfig,
} from '../../engine/types';
import type {
  CompileDefaults,
  CompileDefaultsBakeEntry,
  CompileFamilyLetter,
  LegacyCompileDefaults,
} from '../profile-loader.js';

// ── Family E variant selector ─────────────────────────────────────

/** The 4-state variant enum governing Family E conformal calibration:
 *
 *    'auto'                   → default; ESS+span gate picks
 *                               weighted_e_value on long-span baselines,
 *                               falls through to unweighted otherwise
 *    'force_weighted'         → Addition #19 weighted-quantile variant
 *                               (legacy; retained for shadow-compare +
 *                               force_legacy_family_e reproducibility)
 *    'force_weighted_e_value' → REPLY-46b hedged-indicator e-value
 *                               variant unconditionally, bypassing gate
 *    'force_unweighted'       → Pre-#19 parametric-Gaussian-bootstrap
 *                               variant unconditionally
 *
 *  Lives in effective-config.ts so the selector type + its resolver +
 *  its schema-migration (legacy `force_legacy_family_e` boolean) share
 *  a module and don't introduce a family-e → effective-config cycle. */
export type FamilyEVariantSelector =
  | 'auto'
  | 'force_weighted'
  | 'force_weighted_e_value'
  | 'force_unweighted';

/** ARCHITECT-REPLY-53 R3 — resolve effective Family E selector from
 *  CompilerOptions. New `family_E_variant_selector` wins when present;
 *  otherwise schema-migrate the deprecated `force_legacy_family_e`
 *  boolean (true → 'force_weighted', false → 'auto'); otherwise
 *  default to 'auto'. */
export function resolveFamilyEVariantSelector(
  opts: Pick<CompilerOptions, 'family_E_variant_selector' | 'force_legacy_family_e'>,
): FamilyEVariantSelector {
  if (opts.family_E_variant_selector !== undefined) return opts.family_E_variant_selector;
  if (opts.force_legacy_family_e === true)  return 'force_weighted';
  if (opts.force_legacy_family_e === false) return 'auto';
  return 'auto';
}

// ── Effective compile defaults ────────────────────────────────────

/** Field-by-field materialization of `CompileDefaults` from either an
 *  effective profile+override (Addition #28) or legacy hardcoded
 *  defaults. Legacy path guarantees CompiledConfig output stays byte-
 *  identical to pre-#28 main — the D3 backward-compat anchor.
 *
 *  Profile-driven path dispatches:
 *    - Scalars: effective-config value wins when present.
 *    - Arrays: whole-replace from profile (`sli_list`, `joint_vector`).
 *    - Objects: profile-specified sub-fields override; unspecified
 *      sub-fields fall through to legacy defaults. */
export function effectiveOrDefaults(
  effective: EffectiveConfig | null,
  legacy: LegacyCompileDefaults,
): CompileDefaults {
  // Legacy path — no profile_ref; every field falls through to
  // hardcoded defaults. CompiledConfig stays byte-identical to
  // pre-#28 main (the D3 backward-compat anchor).
  if (effective === null) {
    return {
      family_a_signals: legacy.family_a_signals.slice(),
      family_c_signals: legacy.family_c_signals.slice(),
      family_enabled: { ...legacy.family_enabled_from_cli },
      cell_dimensions: { ...legacy.cell_dimensions_from_bundle },
      alpha: _legacyAlpha(legacy),
      bake_profile_overrides: {},
      profile_ref: null,
      customer_override_ref: null,
    };
  }

  // Profile path — field-by-field materialization.
  const slis = effective.sli_list.map((e) => e.signal);
  // Family enables: CLI `--families` intersected with profile-driven
  // gates. CLI omission drops a family; profile-false drops a family
  // (D5). Both must pass for the family to emit.
  const famEnabled: Record<CompileFamilyLetter, boolean> = {
    A: legacy.family_enabled_from_cli.A,
    B: legacy.family_enabled_from_cli.B && effective.structural_detectors.enabled,
    C: legacy.family_enabled_from_cli.C && effective.joint_vector.include_in_family_c,
    D: legacy.family_enabled_from_cli.D,
    E: legacy.family_enabled_from_cli.E && effective.joint_vector.include_in_family_e,
  };
  // D5 schema-level invariant: at least one family must be enabled
  // post-dispatch. All-disabled → compile-time error via caller.
  return {
    family_a_signals: slis,
    family_c_signals: effective.joint_vector.signals.slice(),
    family_enabled: famEnabled,
    cell_dimensions: { ...effective.cell_dimensions },
    alpha: {
      total: effective.alpha_allocation.total,
      per_family: { ...effective.alpha_allocation.per_family },
      from_legacy_fractions: false,
    },
    bake_profile_overrides: _bakeOverridesFromProfile(effective.bake_profiles),
    policy_defaults: effective.policy_defaults,
    profile_ref: effective.profile_ref,
    customer_override_ref: effective.customer_override_ref,
  };
}

/** Legacy α derivation — CLI fraction × total, with B absorbing
 *  residual. Byte-identity requires this exact FP order (the
 *  subtraction aB = total - aA - aC - aD - aE preserves the
 *  pre-#28 rounding trail). */
function _legacyAlpha(legacy: LegacyCompileDefaults): CompileDefaults['alpha'] {
  const enabled = legacy.family_enabled_from_cli;
  const total = legacy.alpha_total;
  let aA = 0, aC = 0, aD = 0, aE = 0;
  if (enabled.A) {
    aA = total * legacy.family_a_alpha_fraction;
    if (enabled.C) aC = total * legacy.family_c_alpha_fraction;
    if (enabled.D) aD = total * legacy.family_d_alpha_fraction;
    if (enabled.E) aE = total * legacy.family_e_alpha_fraction;
  }
  // B absorbs residual; byte-identity requires this exact FP path.
  const aB = enabled.A ? (total - aA - aC - aD - aE) : total;
  return {
    total,
    per_family: { A: aA, B: aB, C: aC, D: aD, E: aE },
    from_legacy_fractions: true,
  };
}

/** Flatten profile-driven bake-profile entries into the
 *  per-signal override map consumed by the compiler's bake-profile
 *  builder (tools/calibrators/bake-profiles.ts). */
function _bakeOverridesFromProfile(
  entries: EffectiveConfig['bake_profiles'],
): Record<string, CompileDefaultsBakeEntry> {
  const out: Record<string, CompileDefaultsBakeEntry> = {};
  for (const e of entries) {
    out[e.signal] = {
      min_ticks_before_eligible: e.min_ticks_before_eligible,
      min_observation_window: e.min_observation_window,
      max_deploy_window_days: e.max_deploy_window_days,
    };
  }
  return out;
}

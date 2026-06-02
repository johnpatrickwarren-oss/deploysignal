// tools/profile-loader.ts — Addition #28 profile library loader (facade).
//
// Per ARCHITECT-REPLY-51 D1 (YAML + JSON Schema), D4 (inheritance +
// field-level override), D5 (semver), D8 (separate override layer).
//
// Loader API:
//   loadProfile(profile_ref)        → WorkloadProfile (fully inherited)
//   loadCustomerOverride(ref)       → CustomerOverride | null
//   resolveEffectiveConfig(p, o)    → EffectiveConfig (profile + override)
//   validateAgainstSchema(value, s) → ValidationResult
//
// Slice-1 scope: pure loader + validator + merge semantics + unit
// coverage. Integration into tools/calibrate.ts (CompilerOptions +
// CompiledConfig.profile_ref emission) is slice-2.
//
// This file is a facade. The implementation was split (behavior-
// preserving, verbatim moves) into cohesive sibling modules:
//   _profile-loader-types.ts   — type/interface declarations.
//   _profile-loader-schema.ts  — schema loading + the subset validator.
//   _profile-loader-loading.ts — profile/override loading + resolution.
// Every previously-importable name is re-exported below so callers can
// keep importing from `tools/profile-loader` unchanged.

// ── Types (re-exported via `type` for erasure-safe imports) ───────────
export type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  WorkloadProfileSliEntry, WorkloadProfileBakeEntry,
  ValidationResult,
  CompileFamilyLetter, CompileDefaultsBakeEntry, CompileDefaults,
  LegacyCompileDefaults,
  CellDimensionDeficiencyMode, ReconciledCellDimensions,
} from './_profile-loader-types.js';

// ── Schema validator ──────────────────────────────────────────────────
export { validateAgainstSchema } from './_profile-loader-schema.js';

// ── Profile loading + override resolution + reconciliation ────────────
export {
  parseProfileRef, loadProfile, mergeProfileFields,
  loadCustomerOverride, resolveEffectiveConfig, reconcileCellDimensions,
} from './_profile-loader-loading.js';

// ── REPLY-51a dynamic-routing dispatch layer ────────────────────────
//
// `effectiveOrDefaults` materializes compile-time input values from an
// optional `EffectiveConfig`. Post-CODE-COMPLETE Phase 2 moved the body
// to tools/calibrators/effective-config.ts (original ARCHITECT-REPLY-54
// D-54-3 home). This facade re-export preserves backward-compat for any
// consumers importing `effectiveOrDefaults` from profile-loader.
export { effectiveOrDefaults } from './calibrators/effective-config.js';

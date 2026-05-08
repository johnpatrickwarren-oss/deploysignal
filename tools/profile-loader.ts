// tools/profile-loader.ts — Addition #28 profile library loader.
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
// Security posture: js-yaml 4.x default `yaml.load()` uses CORE_SCHEMA
// which is safe — no `!!js/function` or arbitrary constructor
// resolution. Prototype pollution CVEs predate 4.0 and do not apply.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// Profile shapes are mirrored in `engine/types.ts` as the single
// source of truth for audit consumers; this loader re-exports them
// via `type` so callers can import from either place without
// duplication.
import type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  WorkloadProfileSliEntry, WorkloadProfileBakeEntry,
  BundleMetadata, Warning,
} from '../engine/types';
export type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  WorkloadProfileSliEntry, WorkloadProfileBakeEntry,
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Schema loading ────────────────────────────────────────────────────

// JSON Schema path resolved relative to the compiled `.js` location.
// Dev invocations (ts-node / tsc output) and CI both resolve the same
// `profiles/schema/*.json` via repo-root walk.
const REPO_ROOT = findRepoRoot();
const PROFILES_DIR = path.join(REPO_ROOT, 'profiles');
const SCHEMA_DIR = path.join(PROFILES_DIR, 'schema');

function findRepoRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found (no package.json ancestor)');
}

interface SchemaNode {
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

let _profileSchemaCache: SchemaNode | null = null;
function profileSchema(): SchemaNode {
  if (!_profileSchemaCache) {
    const text = fs.readFileSync(path.join(SCHEMA_DIR, 'profile.schema.json'), 'utf8');
    _profileSchemaCache = JSON.parse(text) as SchemaNode;
  }
  return _profileSchemaCache;
}

let _overrideSchemaCache: SchemaNode | null = null;
function overrideSchema(): SchemaNode {
  if (!_overrideSchemaCache) {
    const text = fs.readFileSync(path.join(SCHEMA_DIR, 'customer-override.schema.json'), 'utf8');
    _overrideSchemaCache = JSON.parse(text) as SchemaNode;
  }
  return _overrideSchemaCache;
}

// ── Hand-rolled JSON Schema subset validator ──────────────────────────
//
// Covers the subset of Draft-07 the profile/override schemas use:
// type, enum, pattern, required, additionalProperties (bool and
// schema), properties, items, minLength, minimum, exclusiveMinimum.
// Avoids pulling ajv as a second runtime dep — scope per brief's
// "schema validation path already precedented" framing.

export function validateAgainstSchema(
  value: unknown, schema: SchemaNode, path_: string = '$',
): ValidationResult {
  const errors: string[] = [];
  _walk(value, schema, path_, errors);
  return { valid: errors.length === 0, errors };
}

function _walk(value: unknown, schema: SchemaNode, p: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => _typeMatch(value, t))) {
      errors.push(`${p}: expected type ${types.join(' | ')}, got ${_typeOf(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
    errors.push(`${p}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${p}: string "${value}" does not match pattern /${schema.pattern}/`);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${p}: string shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${p}: number ${value} < minimum ${schema.minimum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${p}: number ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      _walk(value[i], schema.items, `${p}[${i}]`, errors);
    }
  }
  if (_typeMatch(value, 'object') && value !== null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in obj)) errors.push(`${p}: missing required property "${req}"`);
      }
    }
    if (schema.properties) {
      for (const k of keys) {
        const subSchema = schema.properties[k];
        if (subSchema) _walk(obj[k], subSchema, `${p}.${k}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of keys) {
        if (!allowed.has(k)) errors.push(`${p}: additional property "${k}" not permitted`);
      }
    }
  }
}

function _typeMatch(value: unknown, t: string): boolean {
  switch (t) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return false;
  }
}

function _typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ── Profile loading + inheritance resolution ─────────────────────────

/** Parse `<id>@<semver>` profile_ref. Rejects malformed input with a
 *  descriptive error — caller catches + surfaces. */
export function parseProfileRef(ref: string): { id: string; version: string } {
  const m = /^([a-z][a-z0-9-]*[a-z0-9])@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(ref);
  if (!m) throw new Error(`invalid profile_ref "${ref}": expected "<id>@<major>.<minor>.<patch>"`);
  return { id: m[1], version: m[2] };
}

/** Read + parse a single profile YAML without full-schema validation.
 *  Child profiles that inherit missing fields via `extends` would fail
 *  the full schema at this stage — validation happens post-merge in
 *  `loadProfile` instead. Structural-shape validation (additional-
 *  properties, enum values on present fields) is still enforced here
 *  via a partial-schema pass so typos in child-local fields surface
 *  with a meaningful line instead of a post-merge cascade. */
function readProfileFile(profileId: string): Partial<WorkloadProfile> {
  const file = path.join(PROFILES_DIR, `${profileId}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`profile "${profileId}" not found at ${file}`);
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) as unknown;
  const partialResult = validateAgainstSchema(raw, profileSchemaWithoutRequired());
  if (!partialResult.valid) {
    throw new Error(
      `profile "${profileId}" failed structural validation:\n  ${partialResult.errors.join('\n  ')}`,
    );
  }
  const parsed = raw as Partial<WorkloadProfile>;
  if (parsed.id !== profileId) {
    throw new Error(`profile file ${file} has id="${parsed.id}"; expected "${profileId}"`);
  }
  return parsed;
}

let _profileSchemaNoRequiredCache: SchemaNode | null = null;
function profileSchemaWithoutRequired(): SchemaNode {
  if (!_profileSchemaNoRequiredCache) {
    // Deep-clone the schema with `required` stripped at every level.
    _profileSchemaNoRequiredCache = _stripRequired(JSON.parse(JSON.stringify(profileSchema()))) as SchemaNode;
  }
  return _profileSchemaNoRequiredCache;
}

function _stripRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(_stripRequired);
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (k === 'required') continue;
      out[k] = _stripRequired(obj[k]);
    }
    return out;
  }
  return node;
}

/** Resolve an extends chain, detecting cycles, and validate the
 *  fully-resolved profile against the full schema (required-fields
 *  check fires post-merge so children can inherit fields without
 *  restating them). */
export function loadProfile(profile_ref: string): WorkloadProfile {
  const { id, version } = parseProfileRef(profile_ref);
  const chain: Array<Partial<WorkloadProfile>> = [];
  const visited = new Set<string>();
  let currentId: string | null = id;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(
        `circular inheritance detected in extends chain: ${[...visited, currentId].join(' → ')}`,
      );
    }
    visited.add(currentId);
    const p = readProfileFile(currentId);
    chain.push(p);
    currentId = p.extends ?? null;
  }
  // chain[0] is the leaf (the requested profile); chain[N-1] is the
  // root. Merge from root → leaf so leaf overrides win.
  let merged: Partial<WorkloadProfile> = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) {
    merged = _deepMerge(merged, chain[i]) as Partial<WorkloadProfile>;
  }
  // Post-merge full validation: required fields must all be present
  // by this point (from the chain root or overridden along the way).
  const fullResult = validateAgainstSchema(merged, profileSchema());
  if (!fullResult.valid) {
    throw new Error(
      `resolved profile "${id}" failed full schema validation:\n  ${fullResult.errors.join('\n  ')}`,
    );
  }
  const finalProfile = merged as WorkloadProfile;
  // Architect Q1 lean: error on version mismatch; force explicit.
  if (finalProfile.version !== version) {
    throw new Error(
      `profile "${id}" version mismatch: file declares "${finalProfile.version}", ref requested "${version}"`,
    );
  }
  // Cross-field invariant: alpha_allocation.total = sum(per_family).
  // Applied here (post-merge) so overrides that touch one side are
  // consistent with the other.
  const sum = finalProfile.alpha_allocation.per_family.A
    + finalProfile.alpha_allocation.per_family.B
    + finalProfile.alpha_allocation.per_family.C
    + finalProfile.alpha_allocation.per_family.D
    + finalProfile.alpha_allocation.per_family.E;
  if (Math.abs(sum - finalProfile.alpha_allocation.total) > 1e-12) {
    throw new Error(
      `resolved profile "${id}" alpha_allocation.total (${finalProfile.alpha_allocation.total}) `
      + `does not equal per_family sum (${sum})`,
    );
  }
  return finalProfile;
}

/** D4 field-level merge. Scalars → child replaces. Arrays → child
 *  replaces entirely (no append; D4 explicit anti-append). Objects →
 *  deep merge with child precedence. Null on child → disables parent
 *  field (child field becomes null in output). */
export function mergeProfileFields(
  parent: WorkloadProfile, child: WorkloadProfile,
): WorkloadProfile {
  return _deepMerge(parent, child) as WorkloadProfile;
}

function _deepMerge(parent: unknown, child: unknown): unknown {
  if (child === null) return null;
  if (child === undefined) return parent;
  if (Array.isArray(child)) return child.slice();
  if (typeof child === 'object' && typeof parent === 'object' && parent !== null && !Array.isArray(parent)) {
    const pObj = parent as Record<string, unknown>;
    const cObj = child as Record<string, unknown>;
    const out: Record<string, unknown> = { ...pObj };
    for (const k of Object.keys(cObj)) {
      if (k in pObj) out[k] = _deepMerge(pObj[k], cObj[k]);
      else out[k] = cObj[k];
    }
    return out;
  }
  return child;
}

// ── Customer override loading + effective config resolution ──────────

export function loadCustomerOverride(overrideFilePath: string): CustomerOverride {
  if (!fs.existsSync(overrideFilePath)) {
    throw new Error(`customer override not found at ${overrideFilePath}`);
  }
  const raw = yaml.load(fs.readFileSync(overrideFilePath, 'utf8')) as unknown;
  const structResult = validateAgainstSchema(raw, overrideSchema());
  if (!structResult.valid) {
    throw new Error(
      `customer override ${overrideFilePath} failed schema validation:\n  ${structResult.errors.join('\n  ')}`,
    );
  }
  return raw as CustomerOverride;
}

/** D8 override resolution: `effective = deepMerge(profile, override.overrides)`
 *  with enforced invariant: override cannot introduce fields absent from
 *  the base profile schema. `null` leaves disable base-profile fields. */
export function resolveEffectiveConfig(
  profile: WorkloadProfile,
  override: CustomerOverride | null,
): EffectiveConfig {
  const profile_ref = `${profile.id}@${profile.version}`;
  if (!override) {
    return { ...profile, profile_ref, customer_override_ref: null };
  }
  _assertOverrideFieldsInSchema(override.overrides, profileSchema(), '$.overrides');
  const merged = _deepMerge(profile, override.overrides) as WorkloadProfile;
  // Re-validate post-merge: overrides may have introduced invalid
  // values (e.g., negative δ_min) even if fields exist in schema.
  const postResult = validateAgainstSchema(merged, profileSchema());
  if (!postResult.valid) {
    throw new Error(
      `effective_config (${profile.id} + ${override.customer_id}) failed schema validation:\n  `
      + postResult.errors.join('\n  '),
    );
  }
  return {
    ...merged,
    profile_ref,
    customer_override_ref: `${override.customer_id}@${extractCustomerVersion(override) ?? '1.0.0'}`,
  };
}

// ── REPLY-51a dynamic-routing dispatch layer ────────────────────────
//
// `effectiveOrDefaults` materializes compile-time input values from an
// optional `EffectiveConfig`. When the effective config is `null` (legacy
// compile path without `profile_ref`) every field falls through to
// `legacyDefaults`. When supplied, the effective config's field values
// drive the compile — enabling per-profile customization of signal
// inventory, cell-matrix dimensions, family-disable gates, α allocation,
// bake profiles, and policy defaults.
//
// Merge semantics (REPLY-51 D4 propagated to dispatch):
//   - Scalars: effective-config value wins when present.
//   - Arrays: replace entirely (profile's sli_list / joint_vector.signals
//     are authoritative; no append/merge with legacy arrays).
//   - Objects: profile-specified sub-fields override; unspecified
//     sub-fields fall through to legacy.
//
// `streaming@1.0.0` encodes hardcoded legacy defaults faithfully, so
// dispatch through the helper produces byte-identical output to the
// legacy path (PRIMARY REGRESSION GATE per REPLY-51a §D6).

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

// Post-CODE-COMPLETE Phase 2 — effectiveOrDefaults function body moved
// to tools/calibrators/effective-config.ts (original ARCHITECT-REPLY-54
// D-54-3 home). Facade re-export below preserves backward-compat for
// any consumers importing `effectiveOrDefaults` from profile-loader.
export { effectiveOrDefaults } from './calibrators/effective-config.js';

function extractCustomerVersion(override: CustomerOverride): string | null {
  // Customer overrides may or may not carry a `version` field today
  // (v1 schema doesn't require it). Reserve the ref-format slot for
  // when v2 adds mandatory override versioning; until then default
  // to "1.0.0" per architect Q2 lean.
  const v = (override as unknown as { version?: string }).version;
  return v ?? null;
}

function _assertOverrideFieldsInSchema(
  value: unknown, schema: SchemaNode, p: string,
): void {
  if (!_typeMatch(value, 'object') || value === null) return;
  const obj = value as Record<string, unknown>;
  const props = schema.properties ?? {};
  for (const k of Object.keys(obj)) {
    if (!(k in props)) {
      throw new Error(
        `override introduces field "${p}.${k}" not present in base profile schema (D8 forbids)`,
      );
    }
    const sub = props[k];
    // Recurse into nested objects only; arrays are whole-replace per D4
    // so we don't descend into them to enforce schema-presence.
    if (sub.type === 'object' && _typeMatch(obj[k], 'object') && obj[k] !== null) {
      _assertOverrideFieldsInSchema(obj[k], sub, `${p}.${k}`);
    }
  }
}

// ── REPLY-51b R4-2 cell-dimension reconciliation ─────────────────────
//
// Three-case reconciliation between the profile's requested cell
// dimensions and what the baseline bundle actually supports per its
// metadata (REPLY-51a D4):
//
//   (a) profile enables + baseline supports → emit the dimension.
//   (b) profile disables → collapse along the dimension (regardless
//       of baseline support; profile is authoritative for opting out).
//   (c) profile enables + baseline lacks → fall back to disabled for
//       this compile + emit a Warning with code
//       `CELL_DIM_BASELINE_DEFICIENCY`. The `mode` arg controls
//       Warning vs compile-time Error vs silent-collapse per the
//       CompilerOptions.cell_dimension_deficiency_mode contract.
//
// Returns the reconciled `CompileDefaults['cell_dimensions']` shape
// plus any Warnings accumulated. Caller emits to stderr + attaches
// to CompiledConfig.compile_warnings.

export type CellDimensionDeficiencyMode = 'warn' | 'error' | 'silent';

export interface ReconciledCellDimensions {
  cell_dimensions: CompileDefaults['cell_dimensions'];
  warnings: Warning[];
}

const DIM_NAMES = [
  'hour_of_day', 'day_of_week', 'workload_class', 'tenant_tier', 'region',
] as const;

export function reconcileCellDimensions(
  profileDims: CompileDefaults['cell_dimensions'],
  bundleAvailable: BundleMetadata['available_dimensions'],
  mode: CellDimensionDeficiencyMode = 'warn',
): ReconciledCellDimensions {
  const reconciled: CompileDefaults['cell_dimensions'] = {
    hour_of_day: false,
    day_of_week: false,
    workload_class: false,
    tenant_tier: false,
    region: false,
  };
  const warnings: Warning[] = [];
  for (const dim of DIM_NAMES) {
    const wanted = profileDims[dim];
    const supported = bundleAvailable[dim];
    if (!wanted) {
      // Case (b): profile disables → always collapse.
      reconciled[dim] = false;
      continue;
    }
    if (supported) {
      // Case (a): profile enables + baseline supports → emit.
      reconciled[dim] = true;
      continue;
    }
    // Case (c): profile enables + baseline lacks → deficiency.
    if (mode === 'error') {
      throw new Error(
        `CELL_DIM_BASELINE_DEFICIENCY: profile enables cell_dimensions.${dim} `
        + `but the baseline bundle lacks metadata for it. Align profile or `
        + `baseline, or downgrade cell_dimension_deficiency_mode to 'warn'/'silent'.`,
      );
    }
    reconciled[dim] = false;
    if (mode === 'warn') {
      warnings.push({
        code: 'CELL_DIM_BASELINE_DEFICIENCY',
        message:
          `Profile requires cell_dimensions.${dim} but the baseline bundle `
          + `lacks metadata for it. Dimension disabled for this compile; `
          + `realign the profile or recompile against a baseline that carries `
          + `${dim} data.`,
        context: {
          dimension: dim,
          profile_requested: true,
          baseline_supports: false,
          mode,
        },
      });
    }
    // 'silent' → no warning surfaced; deliberate operator opt-out.
  }
  return { cell_dimensions: reconciled, warnings };
}

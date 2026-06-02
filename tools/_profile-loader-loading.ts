// tools/_profile-loader-loading.ts — split out of tools/profile-loader.ts.
//
// Per ARCHITECT-REPLY-51 D1 (YAML + JSON Schema), D4 (inheritance +
// field-level override), D5 (semver), D8 (separate override layer).
//
// Profile loading + inheritance resolution, customer override loading,
// effective-config resolution, and cell-dimension reconciliation. Depends
// on the schema + type modules only (cycle-free).
//
// Security posture: js-yaml 4.x default `yaml.load()` uses CORE_SCHEMA
// which is safe — no `!!js/function` or arbitrary constructor
// resolution. Prototype pollution CVEs predate 4.0 and do not apply.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import type {
  WorkloadProfile, CustomerOverride, EffectiveConfig,
  SchemaNode, CompileDefaults, CellDimensionDeficiencyMode,
  ReconciledCellDimensions,
} from './_profile-loader-types.js';
import type { BundleMetadata, Warning } from '../engine/types';
import {
  PROFILES_DIR, profileSchema, overrideSchema, validateAgainstSchema,
  profileSchemaWithoutRequired, _typeMatch,
} from './_profile-loader-schema.js';

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

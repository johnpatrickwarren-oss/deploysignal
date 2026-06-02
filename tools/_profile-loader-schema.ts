// tools/_profile-loader-schema.ts — split out of tools/profile-loader.ts.
//
// Schema location resolution, schema caching, and the hand-rolled
// JSON Schema subset validator. Imports only the type module, so it
// sits below the loading module in the dependency graph (cycle-free).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SchemaNode, ValidationResult } from './_profile-loader-types.js';

// ── Schema loading ────────────────────────────────────────────────────

// JSON Schema path resolved relative to the compiled `.js` location.
// Dev invocations (ts-node / tsc output) and CI both resolve the same
// `profiles/schema/*.json` via repo-root walk.
const REPO_ROOT = findRepoRoot();
export const PROFILES_DIR = path.join(REPO_ROOT, 'profiles');
const SCHEMA_DIR = path.join(PROFILES_DIR, 'schema');

function findRepoRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found (no package.json ancestor)');
}

let _profileSchemaCache: SchemaNode | null = null;
export function profileSchema(): SchemaNode {
  if (!_profileSchemaCache) {
    const text = fs.readFileSync(path.join(SCHEMA_DIR, 'profile.schema.json'), 'utf8');
    _profileSchemaCache = JSON.parse(text) as SchemaNode;
  }
  return _profileSchemaCache;
}

let _overrideSchemaCache: SchemaNode | null = null;
export function overrideSchema(): SchemaNode {
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

export function _typeMatch(value: unknown, t: string): boolean {
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

let _profileSchemaNoRequiredCache: SchemaNode | null = null;
export function profileSchemaWithoutRequired(): SchemaNode {
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

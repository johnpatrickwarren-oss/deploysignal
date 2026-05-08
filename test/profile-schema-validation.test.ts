// test/profile-schema-validation.test.ts — Addition #28 slice-1.
//
// Per REPLY-51 §Tests:
//   - Each v1 profile validates against schema.
//   - Invalid profiles (missing required fields, wrong types, cyclic
//     extends, schema-unknown extras) fail with specific errors.
//
// Loads every `profiles/*.yaml` present at test time — new profile
// additions auto-exercise without test churn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  loadProfile, parseProfileRef, validateAgainstSchema,
} from '../tools/profile-loader';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(REPO_ROOT, 'profiles');
const SCHEMA_PATH = path.join(PROFILES_DIR, 'schema', 'profile.schema.json');

function listProfileFiles(): string[] {
  return fs.readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => path.join(PROFILES_DIR, f));
}

function loadProfileSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

test('v1 profile set: every profiles/*.yaml loads + resolves + validates via loadProfile', () => {
  // Full schema validation happens post-inheritance-merge so children
  // can inherit required fields without restating. A profile file in
  // isolation may legally omit fields; the resolved profile must not.
  const files = listProfileFiles();
  assert.ok(files.length >= 3, `expected ≥3 v1 profiles, found ${files.length}`);
  for (const file of files) {
    const raw = yaml.load(fs.readFileSync(file, 'utf8')) as { id: string; version: string };
    const ref = `${raw.id}@${raw.version}`;
    assert.doesNotThrow(
      () => loadProfile(ref),
      `${path.basename(file)} failed loadProfile (post-merge full schema)`,
    );
  }
});

test('parseProfileRef: rejects malformed refs', () => {
  assert.throws(() => parseProfileRef('no-version'), /invalid profile_ref/);
  assert.throws(() => parseProfileRef('bad@1.0'), /invalid profile_ref/);
  assert.throws(() => parseProfileRef('Bad-Case@1.0.0'), /invalid profile_ref/);
  assert.throws(() => parseProfileRef('@1.0.0'), /invalid profile_ref/);
  // Valid forms.
  assert.deepEqual(parseProfileRef('llm-inference-streaming@1.0.0'),
    { id: 'llm-inference-streaming', version: '1.0.0' });
  assert.deepEqual(parseProfileRef('generic-microservice@2.11.3'),
    { id: 'generic-microservice', version: '2.11.3' });
});

test('loadProfile: requested version must match file version (Q1 strict policy)', () => {
  assert.throws(
    () => loadProfile('llm-inference-streaming@9.9.9'),
    /version mismatch.*requested "9\.9\.9"/,
  );
});

test('loadProfile: unknown profile id → descriptive error', () => {
  assert.throws(
    () => loadProfile('nonexistent-profile@1.0.0'),
    /not found at/,
  );
});

test('schema: missing required field → validation error names the field', () => {
  const schema = loadProfileSchema();
  const incomplete = {
    id: 'test',
    version: '1.0.0',
    extends: null,
    description: 'incomplete',
    // sli_list missing
    structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: {
      per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3,
    },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  };
  const result = validateAgainstSchema(incomplete, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('sli_list')),
    `expected error to mention sli_list, got: ${result.errors.join(', ')}`);
});

test('schema: wrong type on alpha_allocation.per_family.A → type error', () => {
  const schema = loadProfileSchema();
  const bad = {
    id: 'test', version: '1.0.0', extends: null, description: 'bad',
    sli_list: [], structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: {
      per_family: { A: 'not-a-number', B: 0, C: 0, D: 0, E: 0 }, total: 1e-3,
    },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  };
  const result = validateAgainstSchema(bad, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('per_family.A')),
    `expected error to pinpoint per_family.A, got: ${result.errors.join(', ')}`);
});

test('schema: additionalProperties=false rejects unknown field', () => {
  const schema = loadProfileSchema();
  const withExtra = {
    id: 'test', version: '1.0.0', extends: null, description: 'extra',
    sli_list: [], structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: { per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3 },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
    unknown_field: 'should-reject',
  };
  const result = validateAgainstSchema(withExtra, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown_field')),
    `expected error on unknown_field, got: ${result.errors.join(', ')}`);
});

test('schema: direction_of_better enum rejects invalid value', () => {
  const schema = loadProfileSchema();
  const badDirection = {
    id: 'test', version: '1.0.0', extends: null, description: 'bad-enum',
    sli_list: [{ signal: 'x', direction_of_better: 'sideways', δ_min: 0.01 }],
    structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: { per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3 },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  };
  const result = validateAgainstSchema(badDirection, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('direction_of_better')),
    `expected error on direction_of_better enum, got: ${result.errors.join(', ')}`);
});

test('schema: semver pattern rejects malformed version string', () => {
  const schema = loadProfileSchema();
  const bad = {
    id: 'test', version: '1.0', extends: null, description: 'bad-ver',
    sli_list: [], structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: { per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3 },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  };
  const result = validateAgainstSchema(bad, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('pattern') && e.includes('version')),
    `expected pattern error on version, got: ${result.errors.join(', ')}`);
});

test('v1 profiles load cleanly via loadProfile (full inheritance resolved)', () => {
  for (const ref of [
    'llm-inference-streaming@1.0.0',
    'llm-inference-batch@1.0.0',
    'generic-microservice@1.0.0',
  ]) {
    const profile = loadProfile(ref);
    assert.equal(profile.version, '1.0.0');
    assert.ok(profile.sli_list.length > 0 || ref.startsWith('generic'),
      `${ref}: sli_list should be non-empty for LLM profiles`);
    // Cross-field invariant: alpha_allocation.total = sum(per_family).
    const sum = profile.alpha_allocation.per_family.A
      + profile.alpha_allocation.per_family.B
      + profile.alpha_allocation.per_family.C
      + profile.alpha_allocation.per_family.D
      + profile.alpha_allocation.per_family.E;
    assert.ok(Math.abs(sum - profile.alpha_allocation.total) < 1e-12,
      `${ref}: alpha sum ${sum} ≠ total ${profile.alpha_allocation.total}`);
  }
});

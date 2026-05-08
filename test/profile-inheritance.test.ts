// test/profile-inheritance.test.ts — Addition #28 slice-1.
//
// Per REPLY-51 §Tests for inheritance:
//   - llm-inference-batch extends llm-inference-streaming: inherited
//     fields present; override fields match batch's declared values;
//     excluded signals (TTFT) absent from the resolved sli_list.
//   - Deep-merge semantics: object fields merge; array fields replace
//     entirely per D4.
//   - Circular inheritance: A extends B extends A → validation error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  loadProfile, mergeProfileFields,
} from '../tools/profile-loader';
import type { WorkloadProfile } from '../tools/profile-loader';

test('inheritance: llm-inference-batch inherits streaming defaults', () => {
  const batch = loadProfile('llm-inference-batch@1.0.0');
  const streaming = loadProfile('llm-inference-streaming@1.0.0');

  // Inherited-unchanged: structural_detectors not overridden in batch.
  assert.deepEqual(batch.structural_detectors, streaming.structural_detectors);

  // Inherited-unchanged: cell_dimensions not overridden.
  assert.deepEqual(batch.cell_dimensions, streaming.cell_dimensions);

  // REPLY-51b v2 R4-1 — batch profile overrides joint_vector.signals
  // to exclude TTFT (10-dim multivariate vs streaming's 11-dim) per
  // §D7(a). Assert the inherited include_in_family_c/e flags unchanged
  // but signals differs by the TTFT removal.
  assert.equal(batch.joint_vector.include_in_family_c, streaming.joint_vector.include_in_family_c);
  assert.equal(batch.joint_vector.include_in_family_e, streaming.joint_vector.include_in_family_e);
  assert.ok(!batch.joint_vector.signals.includes('ttft'),
    'batch joint_vector must exclude TTFT');
  assert.ok(streaming.joint_vector.signals.includes('ttft'),
    'streaming joint_vector must include TTFT (regression anchor)');
  assert.equal(batch.joint_vector.signals.length, streaming.joint_vector.signals.length - 1,
    'batch excludes exactly one signal (TTFT)');
});

test('inheritance: batch overrides alpha_allocation per-family.A / .C', () => {
  const batch = loadProfile('llm-inference-batch@1.0.0');
  assert.equal(batch.alpha_allocation.per_family.A, 5e-4,
    'batch: A reallocated to 5e-4 (+1e-4 vs streaming)');
  assert.equal(batch.alpha_allocation.per_family.C, 1e-4,
    'batch: C halved to 1e-4 (−1e-4 vs streaming)');
  // Total must still sum.
  const sum = batch.alpha_allocation.per_family.A
    + batch.alpha_allocation.per_family.B
    + batch.alpha_allocation.per_family.C
    + batch.alpha_allocation.per_family.D
    + batch.alpha_allocation.per_family.E;
  assert.ok(Math.abs(sum - batch.alpha_allocation.total) < 1e-12);
});

test('inheritance: D4 array-replace — TTFT absent from batch sli_list', () => {
  const batch = loadProfile('llm-inference-batch@1.0.0');
  const streaming = loadProfile('llm-inference-streaming@1.0.0');

  // Streaming has TTFT explicitly; batch's override array excludes it.
  const streamingSignals = streaming.sli_list.map((e) => e.signal);
  const batchSignals = batch.sli_list.map((e) => e.signal);
  assert.ok(streamingSignals.includes('ttft'), 'streaming must include ttft');
  assert.ok(!batchSignals.includes('ttft'),
    `batch must exclude ttft (D4 array-replace); got sli_list signals=${batchSignals.join(',')}`);

  // Batch's p99_latency δ_min = 0.02 (wider), cost_req δ_min = 0.005 (tighter).
  const p99Batch = batch.sli_list.find((e) => e.signal === 'p99_latency');
  const costBatch = batch.sli_list.find((e) => e.signal === 'cost_req');
  assert.ok(p99Batch);
  assert.ok(costBatch);
  assert.equal(p99Batch!.δ_min, 0.02);
  assert.equal(costBatch!.δ_min, 0.005);
});

test('inheritance: D4 array-replace — bake_profiles child array replaces parent entirely', () => {
  const batch = loadProfile('llm-inference-batch@1.0.0');
  // Batch's bake_profiles declares 5 entries explicitly (not 13 like streaming);
  // D4 replaces the whole array, so batch has exactly 5.
  assert.equal(batch.bake_profiles.length, 5,
    `batch bake_profiles must replace-not-append; got ${batch.bake_profiles.length} entries`);
  const signals = batch.bake_profiles.map((e) => e.signal);
  // Signals NOT in batch's declared bake_profiles must be absent.
  for (const excluded of ['ttft', 'tokens_turn', 'mfu', 'hbm_spill']) {
    assert.ok(!signals.includes(excluded),
      `batch bake_profiles should exclude ${excluded} (array-replace); got ${signals.join(',')}`);
  }
});

test('inheritance: deep-merge — object fields merge with child precedence', () => {
  // Parent object with nested scalars + child overrides a subset.
  const parent: WorkloadProfile = {
    id: 'parent', version: '1.0.0', extends: null, description: 'p',
    sli_list: [],
    structural_detectors: { enabled: false, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: true, include_in_family_e: false },
    alpha_allocation: {
      per_family: { A: 1e-4, B: 1e-4, C: 1e-4, D: 1e-4, E: 1e-4 },
      total: 5e-4,
    },
    cell_dimensions: {
      hour_of_day: true, day_of_week: true, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30,
      auto_rollback_enabled: true,
      default_risk_tier: 'low',
    },
  };
  const child: WorkloadProfile = {
    ...parent,
    id: 'child',
    // Partial override: only flip joint_vector.include_in_family_e.
    joint_vector: { ...parent.joint_vector, include_in_family_e: true },
    // Partial override: bump per_family.A but keep B,C,D,E parent values.
    alpha_allocation: {
      ...parent.alpha_allocation,
      per_family: { ...parent.alpha_allocation.per_family, A: 2e-4 },
    },
  };
  const merged = mergeProfileFields(parent, child);
  assert.equal(merged.joint_vector.include_in_family_c, true,
    'inherited from parent');
  assert.equal(merged.joint_vector.include_in_family_e, true,
    'overridden by child');
  assert.equal(merged.alpha_allocation.per_family.A, 2e-4);
  assert.equal(merged.alpha_allocation.per_family.B, 1e-4);
});

test('inheritance: null on child disables parent field (D4 null-semantic)', () => {
  // Test via a synthetic parent → child where child sets structural_detectors to null.
  // Note: schema validation rejects null on non-nullable fields, so this
  // test exercises the _deepMerge function's null semantics directly.
  // Real profiles use null sparingly; override layer (slice-2 test) is
  // the primary consumer of the null-disables-field pattern.
  const parent = { a: { x: 1, y: 2 }, b: 5 };
  const child = { a: null, b: 10 };
  // mergeProfileFields with arbitrary shapes via the exported function.
  // (Cast for test-only structural probe.)
  const merged = mergeProfileFields(
    parent as unknown as WorkloadProfile,
    child as unknown as WorkloadProfile,
  ) as unknown as { a: unknown; b: number };
  assert.equal(merged.a, null, 'null on child disables parent.a entirely');
  assert.equal(merged.b, 10, 'scalar override replaces parent value');
});

test('inheritance: circular extends → load-time error', (t) => {
  // Materialize two synthetic profiles in a tempdir with a cycle.
  // Then point the loader at the tempdir via a module-injection would
  // require loader refactoring; instead test the cycle detection path
  // synthetically by constructing an abuse case that walks the logic.
  //
  // Slice-1 approach: the loader walks `extends` via visited-set
  // already. Verify via a small synthetic setup: write three cyclic
  // profile YAMLs into profiles/ under a `_test-cycle-*.yaml` prefix
  // (ignored by v1 validator test via filename), call loadProfile,
  // expect throw, then clean up.
  const repoRoot = path.resolve(__dirname, '..');
  const profilesDir = path.join(repoRoot, 'profiles');
  const fA = path.join(profilesDir, 'test-cycle-a.yaml');
  const fB = path.join(profilesDir, 'test-cycle-b.yaml');
  const templ = (id: string, ext: string): string => yaml.dump({
    id, version: '1.0.0', extends: ext, description: `cycle test ${id}`,
    sli_list: [{ signal: 'x', direction_of_better: 'lower', δ_min: 0.01 }],
    structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: { per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3 },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30, auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  });
  fs.writeFileSync(fA, templ('test-cycle-a', 'test-cycle-b'));
  fs.writeFileSync(fB, templ('test-cycle-b', 'test-cycle-a'));
  t.after(() => { fs.unlinkSync(fA); fs.unlinkSync(fB); });

  assert.throws(
    () => loadProfile('test-cycle-a@1.0.0'),
    /circular inheritance detected/,
  );
});

test('inheritance: unknown parent profile id → descriptive error', () => {
  // Fresh synthetic profile extending a nonexistent parent.
  const repoRoot = path.resolve(__dirname, '..');
  const profilesDir = path.join(repoRoot, 'profiles');
  const f = path.join(profilesDir, 'test-missing-parent.yaml');
  const content = yaml.dump({
    id: 'test-missing-parent', version: '1.0.0',
    extends: 'nonexistent-parent',
    description: 'references a parent that does not exist',
    sli_list: [{ signal: 'x', direction_of_better: 'lower', δ_min: 0.01 }],
    structural_detectors: { enabled: true, dependencies: [] },
    joint_vector: { signals: [], include_in_family_c: false, include_in_family_e: false },
    alpha_allocation: { per_family: { A: 1e-3, B: 0, C: 0, D: 0, E: 0 }, total: 1e-3 },
    cell_dimensions: {
      hour_of_day: true, day_of_week: false, workload_class: false,
      tenant_tier: false, region: false,
    },
    bake_profiles: [],
    policy_defaults: {
      reversibility_threshold_minutes: 30, auto_rollback_enabled: true,
      default_risk_tier: 'medium',
    },
  });
  fs.writeFileSync(f, content);
  try {
    assert.throws(
      () => loadProfile('test-missing-parent@1.0.0'),
      /nonexistent-parent.*not found/,
    );
  } finally {
    fs.unlinkSync(f);
  }
});

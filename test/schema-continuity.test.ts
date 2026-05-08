// test/schema-continuity.test.ts — Addition #8 L0 extension unit tests.
//
// Acceptance per WEEK4-HANDOFF.md §4.1.e: exercise all four continuity
// classes (continuous / extended / breaking / observability_stack) and
// the per-family suppression behavior per class.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashSchema, classifyContinuity, makeContinuityRecord,
  familiesToSuppress, shouldSuppress, MIN_REBASELINE_SAMPLES,
} from '../dist/engine/l0/schema-continuity';
import type { SchemaDescriptor } from '../dist/engine/l0/schema-continuity';

function baseDesc(): SchemaDescriptor {
  return {
    signal_name: 'p99_latency',
    unit: 'ms',
    semantic_type: 'latency_quantile',
    granularity: 'per_tick',
    label_keys: ['route', 'method'],
    quantile_list: [0.5, 0.95, 0.99],
  };
}

// ────────────────────────────────────────────────────────────────────
// Hash determinism.
test('schema: hash is deterministic on identical descriptors', () => {
  const a = baseDesc();
  const b = baseDesc();
  assert.equal(hashSchema(a), hashSchema(b));
});

test('schema: hash is invariant under label_keys ordering', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), label_keys: ['method', 'route'] };
  assert.equal(hashSchema(a), hashSchema(b));
});

test('schema: hash differs when unit changes', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), unit: 'us' };
  assert.notEqual(hashSchema(a), hashSchema(b));
});

// ────────────────────────────────────────────────────────────────────
// Continuity classification — all four classes.
test('schema: identical descriptors → continuous', () => {
  const a = baseDesc(), b = baseDesc();
  assert.equal(classifyContinuity(a, b), 'continuous');
});

test('schema: added label_key → extended', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), label_keys: ['route', 'method', 'tenant'] };
  assert.equal(classifyContinuity(a, b), 'extended');
});

test('schema: unit change → breaking', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), unit: 'us' };
  assert.equal(classifyContinuity(a, b), 'breaking');
});

test('schema: quantile list change → breaking', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), quantile_list: [0.5, 0.9, 0.99] };
  assert.equal(classifyContinuity(a, b), 'breaking');
});

test('schema: removed label_key → breaking', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), label_keys: ['route'] };  // removed 'method'
  assert.equal(classifyContinuity(a, b), 'breaking');
});

test('schema: granularity change → breaking', () => {
  const a = baseDesc();
  const b = { ...baseDesc(), granularity: 'per_request' };
  assert.equal(classifyContinuity(a, b), 'breaking');
});

test('schema: observability_stack deploy → observability_stack class', () => {
  const a = baseDesc(), b = baseDesc();
  assert.equal(
    classifyContinuity(a, b, { observabilityStackDeploy: true }),
    'observability_stack',
  );
});

// ────────────────────────────────────────────────────────────────────
// makeContinuityRecord bundles hash + class + baseline ref.
test('schema: makeContinuityRecord emits hash, class, and baseline_ref', () => {
  const a = baseDesc(), b = baseDesc();
  const r = makeContinuityRecord(a, b, 'synthetic-v1@seed=42');
  assert.equal(r.schema_continuity, 'continuous');
  assert.equal(r.schema_baseline_ref, 'synthetic-v1@seed=42');
  assert.equal(r.schema_hash, hashSchema(b));
});

// ────────────────────────────────────────────────────────────────────
// Per-family suppression per Addition #8 table.
test('schema: continuous → no family suppresses', () => {
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as const) {
    assert.equal(shouldSuppress('continuous', fam), false);
  }
});

test('schema: extended → no family suppresses (rebaseline picks up new dim)', () => {
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as const) {
    assert.equal(shouldSuppress('extended', fam), false);
  }
});

test('schema: breaking → A/C/D/E suppress, B runs on unaffected signals', () => {
  assert.equal(shouldSuppress('breaking', 'A'), true);
  assert.equal(shouldSuppress('breaking', 'C'), true);
  assert.equal(shouldSuppress('breaking', 'D'), true);
  assert.equal(shouldSuppress('breaking', 'E'), true);
  // Family B runs on unaffected signals — per-signal B suppression is
  // handled upstream (signal-level class drives per-signal detector
  // behavior). At the family-level decision, B does not globally suppress.
  assert.equal(shouldSuppress('breaking', 'B'), false);
});

test('schema: observability_stack → all families suppress', () => {
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as const) {
    assert.equal(shouldSuppress('observability_stack', fam), true);
  }
  assert.equal(familiesToSuppress('observability_stack'), '*');
});

// ────────────────────────────────────────────────────────────────────
// Constants surfaced to callers.
test('schema: MIN_REBASELINE_SAMPLES default is 500 per Addition #8', () => {
  assert.equal(MIN_REBASELINE_SAMPLES, 500);
});

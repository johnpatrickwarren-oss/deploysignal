// test/verdict-grouper-root-cause.test.ts — Addition #25 slice-1.
//
// Covers D7 root-cause selection (earliest-firing by tick; tie-break by
// highest total_alpha_spent) and D8 confidence saturation
// (min(1, k / K_saturation) where k = distinct firing families).
//
// Per REPLY-47 §P5 anchors: K_saturation = 3 → 1 family = 0.333,
// 2 families ≈ 0.667, 3+ families = 1.0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FusedVerdict } from '../engine/types';
import { VerdictGrouper } from '../engine/verdict-groups';

function makeVerdict(
  overrides: Partial<FusedVerdict> = {},
): FusedVerdict {
  return {
    verdict: 'proceed',
    firing_families: [],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 0,
    fusion_topology: 'portfolio',
    tick: 0,
    deploy_ref: 'd-1',
    ...overrides,
  };
}

test('root-cause: single earliest-firing verdict becomes root_cause', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 0 }), 0);
  grouper.ingest(makeVerdict({ tick: 5 }), 25);
  // Single fire at tick 10 — this is the root cause.
  const fireV = makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'], total_alpha_spent: 3e-5 });
  grouper.ingest(fireV, 50);
  grouper.ingest(makeVerdict({ tick: 15 }), 75);
  const closed = grouper.ingest(makeVerdict({ tick: 20 }), 100, { terminal: true }).closed!;

  assert.ok(closed.root_cause);
  assert.equal(closed.root_cause!.tick, 10);
  assert.equal(closed.root_cause!.firing_families.length, 1);
  assert.equal(closed.root_cause!.firing_families[0], 'A');
  assert.equal(closed.firing_verdicts.length, 1);
});

test('root-cause: multi-tick firing picks earliest tick, not highest α', () => {
  const grouper = new VerdictGrouper();
  // Tick 20 fires with HIGHER α; tick 10 fires earlier. Earliest wins.
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'], total_alpha_spent: 1e-5 }), 50);
  grouper.ingest(makeVerdict({ tick: 20, verdict: 'rollback', firing_families: ['C'], total_alpha_spent: 1e-4 }), 100);
  const closed = grouper.ingest(makeVerdict({ tick: 25 }), 125, { terminal: true }).closed!;

  assert.equal(closed.root_cause!.tick, 10,
    'earliest-firing tick wins even though later tick has 10× α spend');
  assert.equal(closed.firing_verdicts.length, 2);
});

test('root-cause: tie on first-fire tick broken by max total_alpha_spent', () => {
  // Same-tick ties can't occur for a single deploy via normal fusion
  // (one FusedVerdict per tick per deploy). This test exercises the
  // defensive tie-break path by ingesting two distinct firing verdicts
  // that both carry tick=10.
  const grouper = new VerdictGrouper();
  // Ingest via different deploy_refs would split groups; we need same
  // deploy. We simulate by feeding two firing verdicts at the same
  // tick but different ts (group keying allows multiple verdicts at
  // the same tick within one group for this test).
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'], total_alpha_spent: 3e-5 }), 50);
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['C'], total_alpha_spent: 1e-4 }), 51);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.equal(closed.root_cause!.tick, 10);
  assert.equal(closed.root_cause!.total_alpha_spent, 1e-4,
    'tie-break picks the verdict with higher total_alpha_spent');
  assert.equal(closed.root_cause!.firing_families[0], 'C');
});

test('root-cause: all-silent group — root_cause is null, confidence is 0', () => {
  const grouper = new VerdictGrouper();
  for (let tick = 0; tick < 10; tick++) {
    grouper.ingest(makeVerdict({ tick, verdict: 'proceed' }), tick * 5);
  }
  const closed = grouper.flush(100)[0];

  assert.equal(closed.root_cause, null);
  assert.equal(closed.confidence, 0);
  assert.equal(closed.firing_verdicts.length, 0);
  assert.equal(closed.verdicts.length, 10);
});

test('confidence: single family → 1/3 (K_saturation = 3 default)', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'] }), 50);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.ok(Math.abs(closed.confidence - 1 / 3) < 1e-10);
});

test('confidence: two distinct families → 2/3', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'] }), 50);
  grouper.ingest(makeVerdict({ tick: 12, verdict: 'rollback', firing_families: ['C'] }), 60);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.ok(Math.abs(closed.confidence - 2 / 3) < 1e-10);
});

test('confidence: three families saturate to 1.0', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'] }), 50);
  grouper.ingest(makeVerdict({ tick: 12, verdict: 'rollback', firing_families: ['C'] }), 60);
  grouper.ingest(makeVerdict({ tick: 14, verdict: 'rollback', firing_families: ['D'] }), 70);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.equal(closed.confidence, 1.0);
});

test('confidence: four firing families stay capped at 1.0 (saturation)', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A', 'B'] }), 50);
  grouper.ingest(makeVerdict({ tick: 12, verdict: 'rollback', firing_families: ['C', 'D'] }), 60);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.equal(closed.confidence, 1.0);
});

test('confidence: duplicate family fires count as one (distinct-family set)', () => {
  const grouper = new VerdictGrouper();
  // Family A fires across three separate ticks — should still be k=1.
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'] }), 50);
  grouper.ingest(makeVerdict({ tick: 12, verdict: 'rollback', firing_families: ['A'] }), 60);
  grouper.ingest(makeVerdict({ tick: 14, verdict: 'rollback', firing_families: ['A'] }), 70);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.ok(Math.abs(closed.confidence - 1 / 3) < 1e-10,
    'three fires of the same family count as k=1 family');
  assert.equal(closed.firing_verdicts.length, 3);
});

test('confidence: custom K_saturation overrides default 3', () => {
  const grouper = new VerdictGrouper({ confidence_saturation: 5 });
  grouper.ingest(makeVerdict({ tick: 10, verdict: 'rollback', firing_families: ['A'] }), 50);
  grouper.ingest(makeVerdict({ tick: 12, verdict: 'rollback', firing_families: ['C'] }), 60);
  const closed = grouper.ingest(makeVerdict({ tick: 15 }), 75, { terminal: true }).closed!;

  assert.ok(Math.abs(closed.confidence - 2 / 5) < 1e-10);
});

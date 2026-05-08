// test/topology-overlay-snapshot-hash.test.ts — Addition #26 slice-1.
//
// Covers REPLY-48 D6 snapshot-hash determinism requirements:
//   - Same snapshot → same hash across runs.
//   - Adding one edge → hash differs.
//   - Removing one node → hash differs.
//   - Node/edge input order doesn't matter (hash is sort-invariant
//     because it sorts internally before hashing).
//
// Determinism is the archaeological-render requirement: a VerdictGroup-
// WithTopology emitted today must carry a hash that a viewer can
// recompute identically from the same snapshot months later.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TopologyEdge, TopologyNode, TopologySnapshot } from '../engine/types';
import { StaticTopologySource, computeSnapshotHash } from '../engine/topology-overlay';

function node(id: string): TopologyNode {
  return { id, service_name: id, kind: 'service' };
}

function edge(from: string, to: string): TopologyEdge {
  return { from, to, relationship: 'calls' };
}

function snap(
  nodes: TopologyNode[], edges: TopologyEdge[], fetched_at_ts = 1000,
): TopologySnapshot {
  return {
    nodes, edges, fetched_at_ts,
    source_id: 'static_topology_source',
    source_version: 'test-1',
  };
}

test('snapshot-hash: same snapshot → same hash (determinism)', () => {
  const s1 = snap(
    [node('A'), node('B'), node('C')],
    [edge('A', 'B'), edge('B', 'C')],
  );
  const s2 = snap(
    [node('A'), node('B'), node('C')],
    [edge('A', 'B'), edge('B', 'C')],
  );
  const h1 = computeSnapshotHash(s1);
  const h2 = computeSnapshotHash(s2);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('snapshot-hash: fetched_at_ts does not affect hash (audit stability)', () => {
  const nodes = [node('A'), node('B')];
  const edges = [edge('A', 'B')];
  const h1 = computeSnapshotHash(snap(nodes, edges, 1000));
  const h2 = computeSnapshotHash(snap(nodes, edges, 99_999));
  assert.equal(h1, h2,
    'fetched_at_ts is excluded from hash so identical topologies snapshotted at different times share a hash');
});

test('snapshot-hash: adding one edge changes the hash', () => {
  const baseNodes = [node('A'), node('B'), node('C')];
  const h1 = computeSnapshotHash(snap(baseNodes, [edge('A', 'B')]));
  const h2 = computeSnapshotHash(snap(baseNodes, [edge('A', 'B'), edge('B', 'C')]));
  assert.notEqual(h1, h2);
});

test('snapshot-hash: removing one node changes the hash', () => {
  const edges = [edge('A', 'B')];
  const h1 = computeSnapshotHash(snap([node('A'), node('B'), node('C')], edges));
  const h2 = computeSnapshotHash(snap([node('A'), node('B')], edges));
  assert.notEqual(h1, h2);
});

test('snapshot-hash: node ordering is sort-invariant', () => {
  const edges = [edge('A', 'B'), edge('B', 'C')];
  const h1 = computeSnapshotHash(snap([node('A'), node('B'), node('C')], edges));
  const h2 = computeSnapshotHash(snap([node('C'), node('A'), node('B')], edges));
  const h3 = computeSnapshotHash(snap([node('B'), node('C'), node('A')], edges));
  assert.equal(h1, h2);
  assert.equal(h1, h3);
});

test('snapshot-hash: edge ordering is sort-invariant', () => {
  const nodes = [node('A'), node('B'), node('C')];
  const h1 = computeSnapshotHash(snap(nodes, [edge('A', 'B'), edge('B', 'C'), edge('A', 'C')]));
  const h2 = computeSnapshotHash(snap(nodes, [edge('B', 'C'), edge('A', 'C'), edge('A', 'B')]));
  assert.equal(h1, h2);
});

test('snapshot-hash: directionality matters (A→B and B→A hash differently)', () => {
  const nodes = [node('A'), node('B')];
  const h1 = computeSnapshotHash(snap(nodes, [edge('A', 'B')]));
  const h2 = computeSnapshotHash(snap(nodes, [edge('B', 'A')]));
  assert.notEqual(h1, h2,
    'sort key is (from, to, relationship) so direction is preserved');
});

test('snapshot-hash: relationship change flips the hash (calls vs reads)', () => {
  const nodes = [node('A'), node('B')];
  const h1 = computeSnapshotHash(snap(nodes,
    [{ from: 'A', to: 'B', relationship: 'calls' }]));
  const h2 = computeSnapshotHash(snap(nodes,
    [{ from: 'A', to: 'B', relationship: 'reads' }]));
  assert.notEqual(h1, h2);
});

test('snapshot-hash: StaticTopologySource delegates to computeSnapshotHash', () => {
  const s = snap(
    [node('A'), node('B')],
    [edge('A', 'B')],
  );
  const source = new StaticTopologySource(s);
  assert.equal(source.snapshotHash(s), computeSnapshotHash(s));
});

test('snapshot-hash: empty snapshot hashes deterministically', () => {
  const h1 = computeSnapshotHash(snap([], []));
  const h2 = computeSnapshotHash(snap([], []));
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

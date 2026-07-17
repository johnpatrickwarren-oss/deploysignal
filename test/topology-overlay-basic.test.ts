// test/topology-overlay-basic.test.ts — Addition #26 slice-1.
//
// Covers REPLY-48 slice-1 test targets:
//   - BFS from the deploy-service node discovers 1-hop / 2-hop / 3-hop
//     neighbors correctly.
//   - topology_max_hop_distance cutoff drops beyond-cap candidates.
//   - Candidate ordering (overlap desc, distance asc, node_id lex asc).
//   - Zero-overlap events dropped; unknown node_id events ignored;
//     empty events yields empty candidates.
//
// Test graph (10 nodes, 15 undirected edges for BFS purposes):
//
//     K ── I ── D ── B ── A ── G ── H ── J
//          │    │    │    │    │    │
//          └── E    C ───┘    (C─H via H)
//          │    │
//          K    F ── J
//
// Hop distance from A (start):
//   0: A
//   1: B, C, G
//   2: D, E, F, H  (B-C cross-edge does not change hop)
//   3: I, J        (via D/E for I; via F/H for J)
//   4: K           (beyond default max_hop_distance=3; excluded)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FusedVerdict, TopologyCandidateEvent, TopologyEdge, TopologyNode,
  TopologySnapshot, VerdictGroup,
} from '../engine/types';
import { StaticTopologySource, TopologyEnricher } from '../engine/topology-overlay';

function node(id: string, kind: TopologyNode['kind'] = 'service'): TopologyNode {
  return { id, service_name: id, kind };
}

function edge(from: string, to: string): TopologyEdge {
  return { from, to, relationship: 'calls' };
}

function makeSnapshot(): TopologySnapshot {
  const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map((s) => node(s));
  const edges: TopologyEdge[] = [
    edge('A', 'B'), edge('A', 'C'), edge('A', 'G'),
    edge('B', 'D'), edge('B', 'E'), edge('B', 'C'),
    edge('C', 'F'), edge('C', 'H'),
    edge('G', 'H'),
    edge('D', 'I'), edge('E', 'I'),
    edge('F', 'J'), edge('H', 'J'),
    edge('I', 'K'), edge('J', 'K'),
  ];
  return {
    nodes, edges,
    fetched_at_ts: 1000,
    source_id: 'static_topology_source',
    source_version: 'test-1',
  };
}

function makeGroup(
  deploy_id: string,
  window_start_ts: number,
  window_end_ts: number,
): VerdictGroup {
  const verdict: FusedVerdict = {
    verdict: 'rollback', firing_families: ['A'],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 1e-4, fusion_topology: 'portfolio',
    tick: 0, deploy_ref: deploy_id,
    verdict_rationale: 'Rollback triggered: Family A fired.',
    evidence_outlook: [],
  };
  return {
    group_id: `group-${deploy_id}-${window_start_ts}`,
    deploy_id,
    window_start_ts, window_end_ts,
    verdicts: [verdict], firing_verdicts: [verdict],
    root_cause: verdict, confidence: 1 / 3,
    late_arrival_verdicts: [], closed: true, closed_at_ts: window_end_ts,
  };
}

function deployEvent(node_id: string, event_ts: number, id = `ev-${node_id}`): TopologyCandidateEvent {
  return { node_id, event_type: 'deploy', event_id: id, event_ts };
}

test('topology-overlay-basic: BFS finds 1-hop / 2-hop / 3-hop neighbors within default max_hop=3', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source });
  const group = makeGroup('A', 100, 400);
  // Place an in-window deploy event on every node.
  const events: TopologyCandidateEvent[] = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']
    .map((id) => deployEvent(id, 200));

  const result = await enricher.enrich(group, events);

  assert.equal(result.enrichment_error, null);
  assert.equal(result.group_id, group.group_id);
  assert.equal(typeof result.topology_snapshot_hash, 'string');

  const byNode = new Map(result.candidates.map((c) => [c.node_id, c.topology_distance]));
  // 1-hop neighbors.
  assert.equal(byNode.get('B'), 1);
  assert.equal(byNode.get('C'), 1);
  assert.equal(byNode.get('G'), 1);
  // 2-hop neighbors.
  assert.equal(byNode.get('D'), 2);
  assert.equal(byNode.get('E'), 2);
  assert.equal(byNode.get('F'), 2);
  assert.equal(byNode.get('H'), 2);
  // 3-hop neighbors.
  assert.equal(byNode.get('I'), 3);
  assert.equal(byNode.get('J'), 3);
  // K is hop 4 → beyond default cutoff, excluded.
  assert.equal(byNode.has('K'), false);
});

test('topology-overlay-basic: max_hop_distance=1 restricts to direct neighbors only', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source, max_hop_distance: 1 });
  const group = makeGroup('A', 100, 400);
  const events = ['B', 'C', 'D', 'E', 'G', 'I'].map((id) => deployEvent(id, 200));

  const result = await enricher.enrich(group, events);
  const ids = new Set(result.candidates.map((c) => c.node_id));
  assert.deepEqual(ids, new Set(['B', 'C', 'G']));
});

test('topology-overlay-basic: candidates ordered by (overlap desc, distance asc, node_id asc)', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source });
  const group = makeGroup('A', 100, 400);
  // Mix of overlap ratios + hop distances to exercise all three sort keys.
  const events: TopologyCandidateEvent[] = [
    // B: 1-hop, partial interval overlap 0.5.
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B',
      event_ts: 250, event_window_start_ts: 200, event_window_end_ts: 400 },
    // C: 1-hop, full-window interval overlap 1.0 → highest rank.
    { node_id: 'C', event_type: 'deploy', event_id: 'ev-C',
      event_ts: 250, event_window_start_ts: 100, event_window_end_ts: 400 },
    // D: 2-hop, interval overlap 0.5 — same overlap as B; B wins on distance.
    { node_id: 'D', event_type: 'deploy', event_id: 'ev-D',
      event_ts: 250, event_window_start_ts: 200, event_window_end_ts: 400 },
    // G: 1-hop, point-event inside window, overlap 1.0 — tied with C on
    // overlap and distance; node_id 'C' < 'G' wins lex tie-break.
    deployEvent('G', 200),
  ];

  const result = await enricher.enrich(group, events);
  const ids = result.candidates.map((c) => c.node_id);
  assert.deepEqual(ids, ['C', 'G', 'B', 'D']);
});

test('topology-overlay-basic: zero-overlap events dropped, unknown nodes ignored', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source, correlation_window_seconds: 100 });
  const group = makeGroup('A', 100, 400);
  const events: TopologyCandidateEvent[] = [
    deployEvent('B', 200),        // in-window → kept
    deployEvent('C', 10000),      // way outside correlation buffer → dropped
    deployEvent('NOT-A-NODE', 200), // unknown node_id → dropped
  ];

  const result = await enricher.enrich(group, events);
  const ids = result.candidates.map((c) => c.node_id);
  assert.deepEqual(ids, ['B']);
});

test('topology-overlay-basic: empty events list yields empty candidates list + clean hash', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source });
  const group = makeGroup('A', 100, 400);

  const result = await enricher.enrich(group);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.enrichment_error, null);
  assert.equal(typeof result.topology_snapshot_hash, 'string');
  assert.equal((result.topology_snapshot_hash as string).length, 64);
});

test('topology-overlay-basic: deploy_id unresolvable in snapshot → enrichment_error set, empty candidates', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source });
  const group = makeGroup('no-such-service', 100, 400);

  const result = await enricher.enrich(group, [deployEvent('B', 200)]);
  assert.equal(result.enrichment_error, 'DEPLOY_NODE_NOT_IN_TOPOLOGY');
  assert.deepEqual(result.candidates, []);
  // Hash still computed — snapshot succeeded even though resolver failed.
  assert.equal(typeof result.topology_snapshot_hash, 'string');
});

test('topology-overlay-basic: interval event uses IoU; point event uses proximity decay', async () => {
  const source = new StaticTopologySource(makeSnapshot());
  const enricher = new TopologyEnricher({ source, correlation_window_seconds: 100 });
  const group = makeGroup('A', 100, 400);
  const events: TopologyCandidateEvent[] = [
    // Interval [200, 300]: intersection=100, union=300 → IoU ≈ 0.333.
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B',
      event_ts: 250, event_window_start_ts: 200, event_window_end_ts: 300 },
    // Point event just outside window by 50s; decay: 1 - 50/100 = 0.5.
    deployEvent('C', 450),
  ];

  const result = await enricher.enrich(group, events);
  const byId = new Map(result.candidates.map((c) => [c.node_id, c.temporal_overlap_ratio]));
  assert.ok(byId.has('B') && Math.abs((byId.get('B') as number) - 1 / 3) < 1e-9);
  assert.ok(byId.has('C') && Math.abs((byId.get('C') as number) - 0.5) < 1e-9);
  // C's overlap 0.5 > B's 0.333 → C ranks first.
  assert.equal(result.candidates[0].node_id, 'C');
  assert.equal(result.candidates[1].node_id, 'B');
});

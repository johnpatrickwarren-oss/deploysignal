// test/topology-overlay-temporal.test.ts — Addition #26 slice-2.
//
// Focused coverage for REPLY-48 D4 ranking semantics + P5 §Test case 2
// / §Test case 3 (temporal overlap vs topology distance precedence).
//
//   - temporal_overlap_ratio desc is the PRIMARY sort key.
//   - topology_distance asc is the SECONDARY sort key (tie-breaks equal
//     overlaps).
//   - A candidate at hop 1 with overlap 0.8 ranks HIGHER than a
//     candidate at hop 2 with overlap 0.9? NO — overlap dominates.
//     This test anchors the P5 claim that overlap-desc wins ties.
//   - Zero-overlap candidates dropped.
//   - Candidate beyond correlation_window_seconds: temporal_overlap
//     decays to zero → dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FusedVerdict, TopologyCandidateEvent, TopologyEdge, TopologyNode,
  TopologySnapshot, VerdictGroup,
} from '../engine/types';
import { StaticTopologySource, TopologyEnricher } from '../engine/topology-overlay';

function node(id: string): TopologyNode {
  return { id, service_name: id, kind: 'service' };
}

function edge(from: string, to: string): TopologyEdge {
  return { from, to, relationship: 'calls' };
}

function snapshot(): TopologySnapshot {
  return {
    nodes: ['A', 'B', 'C', 'D'].map(node),
    edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')],
    fetched_at_ts: 1000,
    source_id: 'static_topology_source',
    source_version: 'test-1',
  };
}

function group(window_start_ts: number, window_end_ts: number): VerdictGroup {
  const v: FusedVerdict = {
    verdict: 'rollback', firing_families: ['A'],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 1e-4, fusion_topology: 'portfolio',
    tick: 0, deploy_ref: 'A',
    verdict_rationale: 'Rollback triggered: Family A fired.',
    evidence_outlook: [],
  };
  return {
    group_id: `group-A-${window_start_ts}`, deploy_id: 'A',
    window_start_ts, window_end_ts,
    verdicts: [v], firing_verdicts: [v], root_cause: v,
    confidence: 1 / 3, late_arrival_verdicts: [],
    closed: true, closed_at_ts: window_end_ts,
  };
}

test('temporal: higher overlap outranks lower overlap even at a closer hop', async () => {
  // P5 anchor (corrected): the brief describes overlap-desc as the
  // primary key. A 1-hop candidate with overlap 0.5 should rank
  // BELOW a 2-hop candidate with overlap 1.0 because overlap wins.
  const enricher = new TopologyEnricher({ source: new StaticTopologySource(snapshot()) });
  const events: TopologyCandidateEvent[] = [
    // B: 1-hop; partial interval [200, 400] against group [100, 400]
    // → IoU = 200 / 300 = 0.667.
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B',
      event_ts: 250, event_window_start_ts: 200, event_window_end_ts: 400 },
    // C: 2-hop; full-window interval [100, 400] → IoU = 1.0.
    { node_id: 'C', event_type: 'deploy', event_id: 'ev-C',
      event_ts: 250, event_window_start_ts: 100, event_window_end_ts: 400 },
  ];
  const result = await enricher.enrich(group(100, 400), events);
  assert.equal(result.candidates[0].node_id, 'C',
    'overlap=1.0 at hop 2 outranks overlap≈0.667 at hop 1');
  assert.equal(result.candidates[1].node_id, 'B');
});

test('temporal: equal overlap broken by topology_distance asc', async () => {
  const enricher = new TopologyEnricher({ source: new StaticTopologySource(snapshot()) });
  const events: TopologyCandidateEvent[] = [
    // Both in-window point events → overlap=1.0 each.
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B', event_ts: 200 },
    { node_id: 'C', event_type: 'deploy', event_id: 'ev-C', event_ts: 200 },
    { node_id: 'D', event_type: 'deploy', event_id: 'ev-D', event_ts: 200 },
  ];
  const result = await enricher.enrich(group(100, 400), events);
  const hops = result.candidates.map((c) => c.topology_distance);
  assert.deepEqual(hops, [1, 2, 3],
    'overlap tie → distance asc ordering');
});

test('temporal: zero-overlap candidate dropped from list', async () => {
  const enricher = new TopologyEnricher({
    source: new StaticTopologySource(snapshot()), correlation_window_seconds: 50,
  });
  const events: TopologyCandidateEvent[] = [
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B', event_ts: 200 }, // in-window → kept
    { node_id: 'C', event_type: 'deploy', event_id: 'ev-C', event_ts: 10000 }, // far outside → dropped
  ];
  const result = await enricher.enrich(group(100, 400), events);
  const ids = result.candidates.map((c) => c.node_id);
  assert.deepEqual(ids, ['B']);
});

test('temporal: candidate beyond correlation window decays to zero → dropped', async () => {
  const enricher = new TopologyEnricher({
    source: new StaticTopologySource(snapshot()), correlation_window_seconds: 100,
  });
  const g = group(100, 400);
  const events: TopologyCandidateEvent[] = [
    // Just inside buffer (50s past group_end): decay = 1 - 50/100 = 0.5 → kept.
    { node_id: 'B', event_type: 'deploy', event_id: 'close', event_ts: 450 },
    // Exactly at buffer edge: decay = 1 - 100/100 = 0 → dropped.
    { node_id: 'C', event_type: 'deploy', event_id: 'boundary', event_ts: 500 },
    // Just past buffer: decay forced to 0 → dropped.
    { node_id: 'D', event_type: 'deploy', event_id: 'past', event_ts: 501 },
  ];
  const result = await enricher.enrich(g, events);
  const ids = result.candidates.map((c) => c.node_id);
  assert.deepEqual(ids, ['B']);
});

test('temporal: interval event contained in group window yields IoU < 1 (brief P5 anchor)', async () => {
  // P5 Test case 2 pseudo: service-B interval [120, 180] vs group
  // [100, 400] → intersection=60, union=300, IoU=0.2.
  const enricher = new TopologyEnricher({ source: new StaticTopologySource(snapshot()) });
  const events: TopologyCandidateEvent[] = [
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B',
      event_ts: 150, event_window_start_ts: 120, event_window_end_ts: 180 },
  ];
  const result = await enricher.enrich(group(100, 400), events);
  assert.equal(result.candidates.length, 1);
  assert.ok(Math.abs(result.candidates[0].temporal_overlap_ratio - 0.2) < 1e-9,
    `expected IoU = 60/300 = 0.2; got ${result.candidates[0].temporal_overlap_ratio}`);
});

test('temporal: same-node interval + point events both considered, stronger overlap wins', async () => {
  // Two events on same node — both contribute candidates (each becomes
  // its own candidate row). Sort is stable on node_id so both land.
  const enricher = new TopologyEnricher({ source: new StaticTopologySource(snapshot()) });
  const events: TopologyCandidateEvent[] = [
    { node_id: 'B', event_type: 'deploy', event_id: 'ev-B-point', event_ts: 200 },
    { node_id: 'B', event_type: 'alert',  event_id: 'ev-B-interval',
      event_ts: 250, event_window_start_ts: 200, event_window_end_ts: 300 },
  ];
  const result = await enricher.enrich(group(100, 400), events);
  assert.equal(result.candidates.length, 2);
  // Both are node B; point-event has overlap 1.0, interval has 100/300≈0.333.
  assert.equal(result.candidates[0].candidate_event_id, 'ev-B-point');
  assert.equal(result.candidates[1].candidate_event_id, 'ev-B-interval');
});

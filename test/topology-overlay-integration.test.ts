// test/topology-overlay-integration.test.ts — Addition #26 slice-2.
//
// Harness-level end-to-end wiring: VerdictGroup → TopologyEnricher.enrich
// → projectToAuditEvent → TopologyAuditEmitter. The path that the
// orchestrator will execute once Addition #25 slice-2 lands its
// VerdictGrouper orchestrator hook.
//
// This test explicitly does NOT touch engine/orchestrator.ts — that
// wiring is blocked on #25 slice-2 and lives in a follow-up combined
// slice. The contract surfaces exercised here (audit event shape +
// emitter interface + projection helper) are ready for drop-in.
//
// Demo-tenant-skew synthetic topology fixture per brief §Acceptance:
// 5 nodes (checkout → orders → catalog + checkout → payments → bank),
// one in-window deploy on orders (hop 1 from checkout) and one
// in-window alert on payments (hop 1 alternate path) — enrichment
// should produce 2 ranked candidates.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FusedVerdict, TopologyCandidateEvent, TopologyEdge, TopologyNode,
  TopologySnapshot, VerdictGroup,
} from '../engine/types';
import {
  StaticTopologySource, TopologyEnricher,
  InMemoryTopologyAuditEmitter, projectToAuditEvent,
} from '../engine/topology-overlay';

function node(id: string, service_name = id): TopologyNode {
  return { id, service_name, kind: 'service' };
}

function edge(from: string, to: string): TopologyEdge {
  return { from, to, relationship: 'calls' };
}

function tenantSkewTopology(): TopologySnapshot {
  return {
    nodes: [
      node('checkout'), node('orders'), node('catalog'),
      node('payments'), node('bank'),
    ],
    edges: [
      edge('checkout', 'orders'), edge('orders', 'catalog'),
      edge('checkout', 'payments'), edge('payments', 'bank'),
    ],
    fetched_at_ts: 1000,
    source_id: 'static_topology_source',
    source_version: 'demo-tenant-skew-v1',
  };
}

function fusedVerdict(tick: number, firing: FusedVerdict['firing_families'] = []): FusedVerdict {
  return {
    verdict: firing.length > 0 ? 'rollback' : 'proceed', firing_families: firing,
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: firing.length > 0 ? 1e-4 : 0,
    fusion_topology: 'portfolio', tick, deploy_ref: 'checkout',
    verdict_rationale: firing.length > 0
      ? 'Rollback triggered: Family A fired.'
      : 'Proceed: observation window closed with no rollback signals across all families.',
    evidence_outlook: [],
  };
}

function group(): VerdictGroup {
  const firing = fusedVerdict(5, ['A']);
  return {
    group_id: 'group-checkout-100', deploy_id: 'checkout',
    window_start_ts: 100, window_end_ts: 400,
    verdicts: [fusedVerdict(0), firing, fusedVerdict(10)],
    firing_verdicts: [firing], root_cause: firing, confidence: 1 / 3,
    late_arrival_verdicts: [], closed: true, closed_at_ts: 400,
  };
}

test('integration: enricher → projectToAuditEvent → emitter produces ranked audit event', async () => {
  const source = new StaticTopologySource(tenantSkewTopology());
  const enricher = new TopologyEnricher({ source, now: () => 9999 });
  const emitter = new InMemoryTopologyAuditEmitter();

  const events: TopologyCandidateEvent[] = [
    // Deploy on orders (1-hop from checkout), overlap=1.0.
    { node_id: 'orders', event_type: 'deploy', event_id: 'deploy-orders-42', event_ts: 150 },
    // Alert on payments (1-hop alt path), overlap=1.0.
    { node_id: 'payments', event_type: 'alert', event_id: 'alert-payments-7', event_ts: 300 },
    // Catalog event (2-hop), in window → overlap=1.0.
    { node_id: 'catalog', event_type: 'incident', event_id: 'incident-catalog-1', event_ts: 200 },
  ];

  const enriched = await enricher.enrich(group(), events);
  emitter.emit(projectToAuditEvent(enriched));

  // Verify enrichment pass shape.
  assert.equal(enriched.group_id, 'group-checkout-100');
  assert.equal(enriched.enrichment_error, null);
  assert.equal(enriched.enriched_at_ts, 9999);
  assert.equal(enriched.candidates.length, 3);

  // Ranking: all overlap=1.0 → distance asc → orders(1) & payments(1)
  // before catalog(2); node-id tiebreak orders<payments.
  const ids = enriched.candidates.map((c) => c.node_id);
  assert.deepEqual(ids, ['orders', 'payments', 'catalog']);
  assert.equal(enriched.candidates[0].topology_distance, 1);
  assert.equal(enriched.candidates[2].topology_distance, 2);

  // Verify audit event.
  assert.equal(emitter.events.length, 1);
  const ev = emitter.events[0];
  assert.equal(ev.type, 'verdict_group_enriched_with_topology');
  assert.equal(ev.group_id, 'group-checkout-100');
  assert.equal(ev.topology_source_id, 'static_topology_source');
  assert.equal(typeof ev.topology_snapshot_hash, 'string');
  assert.equal((ev.topology_snapshot_hash as string).length, 64);
  assert.equal(ev.n_candidates, 3);
  assert.equal(ev.top_candidate?.node_id, 'orders');
  assert.equal(ev.top_candidate?.correlational_not_causal, true);
  assert.equal(ev.enrichment_error, null);
});

test('integration: empty candidates → top_candidate null + n_candidates 0', async () => {
  const source = new StaticTopologySource(tenantSkewTopology());
  const enricher = new TopologyEnricher({ source });
  const emitter = new InMemoryTopologyAuditEmitter();

  const enriched = await enricher.enrich(group(), []); // no events
  emitter.emit(projectToAuditEvent(enriched));

  const ev = emitter.events[0];
  assert.equal(ev.n_candidates, 0);
  assert.equal(ev.top_candidate, null);
  assert.equal(ev.enrichment_error, null);
  // Hash still present (snapshot fetched cleanly).
  assert.equal(typeof ev.topology_snapshot_hash, 'string');
});

test('integration: degraded enrichment (unresolved deploy) surfaces through audit event', async () => {
  const source = new StaticTopologySource(tenantSkewTopology());
  const enricher = new TopologyEnricher({ source });
  const emitter = new InMemoryTopologyAuditEmitter();

  const g = group();
  g.deploy_id = 'not-in-topology';
  const enriched = await enricher.enrich(g);
  emitter.emit(projectToAuditEvent(enriched));

  const ev = emitter.events[0];
  assert.equal(ev.enrichment_error, 'DEPLOY_NODE_NOT_IN_TOPOLOGY');
  assert.equal(ev.n_candidates, 0);
  assert.equal(ev.top_candidate, null);
  // Hash still present: snapshot fetched, only resolver failed.
  assert.equal(typeof ev.topology_snapshot_hash, 'string');
});

test('integration: enrichment is not blocking — Promise settles without any sync side-effects', async () => {
  // Demonstrates the non-blocking semantics: synchronous callers can
  // fire-and-forget enrichment without awaiting. The test enqueues
  // enrichment and checks that between enqueue and settle, no event
  // is emitted; settle writes the event exactly once.
  const source = new StaticTopologySource(tenantSkewTopology());
  const enricher = new TopologyEnricher({ source });
  const emitter = new InMemoryTopologyAuditEmitter();

  const promise = enricher.enrich(group()).then((r) => emitter.emit(projectToAuditEvent(r)));
  assert.equal(emitter.events.length, 0, 'no synchronous emission');
  await promise;
  assert.equal(emitter.events.length, 1, 'event emitted after promise settles');
});

test('integration: VerdictGroup schema unchanged by enrichment (strict-additive anchor)', async () => {
  const source = new StaticTopologySource(tenantSkewTopology());
  const enricher = new TopologyEnricher({ source });

  const g = group();
  const snapshot = JSON.stringify(g);
  await enricher.enrich(g, [
    { node_id: 'orders', event_type: 'deploy', event_id: 'd1', event_ts: 150 },
  ]);
  assert.equal(JSON.stringify(g), snapshot,
    'enrichment must not mutate the VerdictGroup (D5 anchor)');
});

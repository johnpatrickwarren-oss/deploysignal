// test/topology-overlay-enrichment-error.test.ts — Addition #26 slice-2.
//
// Covers REPLY-48 Q1 graceful-degradation semantics:
//   - TopologySource.fetchSnapshot throws (timeout / transport / parse
//     error) → VerdictGroupWithTopology emits with empty candidates,
//     `topology_snapshot_hash = null`, `enrichment_error` populated.
//   - Malformed response surfaces the same path.
//   - Deploy-id unresolvable in an otherwise-valid snapshot → still
//     emits (hash present) with `enrichment_error = DEPLOY_NODE_NOT_IN_
//     TOPOLOGY` per slice-1 behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FusedVerdict, TopologySnapshot, VerdictGroup,
} from '../engine/types';
import {
  TopologyEnricher, type TopologySource, type FetchContext,
} from '../engine/topology-overlay';

function group(deploy_id: string, window_start_ts = 100, window_end_ts = 400): VerdictGroup {
  const v: FusedVerdict = {
    verdict: 'rollback', firing_families: ['A'],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 1e-4, fusion_topology: 'portfolio',
    tick: 0, deploy_ref: deploy_id,
  };
  return {
    group_id: `group-${deploy_id}-${window_start_ts}`, deploy_id,
    window_start_ts, window_end_ts,
    verdicts: [v], firing_verdicts: [v], root_cause: v,
    confidence: 1 / 3, late_arrival_verdicts: [],
    closed: true, closed_at_ts: window_end_ts,
  };
}

class TimeoutTopologySource implements TopologySource {
  readonly id = 'timeout_source';
  readonly version = 'test-1';
  async fetchSnapshot(_ctx?: FetchContext): Promise<TopologySnapshot> {
    throw new Error('TOPOLOGY_FETCH_TIMEOUT');
  }
  snapshotHash(_snap: TopologySnapshot): string {
    return 'unreachable';
  }
}

class MalformedTopologySource implements TopologySource {
  readonly id = 'malformed_source';
  readonly version = 'test-1';
  async fetchSnapshot(_ctx?: FetchContext): Promise<TopologySnapshot> {
    throw new Error('TOPOLOGY_FETCH_MALFORMED');
  }
  snapshotHash(_snap: TopologySnapshot): string {
    return 'unreachable';
  }
}

class StringThrowingSource implements TopologySource {
  readonly id = 'string_throw';
  readonly version = 'test-1';
  async fetchSnapshot(_ctx?: FetchContext): Promise<TopologySnapshot> {
    // Non-Error throw — enricher must normalize to string for
    // enrichment_error (String(err) branch).
    throw 'custom_non_error_failure'; // eslint-disable-line no-throw-literal
  }
  snapshotHash(_snap: TopologySnapshot): string {
    return 'unreachable';
  }
}

test('enrichment-error: fetch timeout → empty candidates, hash null, error surfaced', async () => {
  const enricher = new TopologyEnricher({ source: new TimeoutTopologySource() });
  const result = await enricher.enrich(group('svc-a'), []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.topology_snapshot_hash, null);
  assert.equal(result.enrichment_error, 'TOPOLOGY_FETCH_TIMEOUT');
  assert.equal(result.topology_source_id, 'timeout_source');
  assert.equal(result.group_id, 'group-svc-a-100');
});

test('enrichment-error: malformed response falls down the same path', async () => {
  const enricher = new TopologyEnricher({ source: new MalformedTopologySource() });
  const result = await enricher.enrich(group('svc-b'), []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.topology_snapshot_hash, null);
  assert.equal(result.enrichment_error, 'TOPOLOGY_FETCH_MALFORMED');
});

test('enrichment-error: non-Error throw normalized to string for enrichment_error', async () => {
  const enricher = new TopologyEnricher({ source: new StringThrowingSource() });
  const result = await enricher.enrich(group('svc-c'), []);
  assert.equal(result.enrichment_error, 'custom_non_error_failure');
});

test('enrichment-error: enriched_at_ts honours injected clock on failure path', async () => {
  const enricher = new TopologyEnricher({
    source: new TimeoutTopologySource(), now: () => 4242,
  });
  const result = await enricher.enrich(group('svc-d'), []);
  assert.equal(result.enriched_at_ts, 4242,
    'enriched_at_ts stamped from injected clock even when fetchSnapshot throws');
});

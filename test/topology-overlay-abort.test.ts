// test/topology-overlay-abort.test.ts — Remediation L7 regression guard.
//
// TopologyEnricher.enrich previously called source.fetchSnapshot() with no
// FetchContext, so the interface's AbortSignal support was unreachable:
// no timeout or orchestrator-shutdown signal could ever propagate to a
// real source. enrich now accepts an optional FetchContext and threads it
// through verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TopologyEnricher } = require('../dist/engine/topology-overlay');

const SNAPSHOT = {
  nodes: [{ id: 'svc-a', service_name: 'svc-a', metadata: { deploy_id: 'deploy-1' } }],
  edges: [],
  fetched_at_ts: 1000,
  source_id: 'recording_source',
  source_version: 'test-1',
};

const GROUP = {
  group_id: 'g1',
  deploy_id: 'deploy-1',
  window_start_ts: 1000,
  window_end_ts: 2000,
};

function makeRecordingSource() {
  const seen: unknown[] = [];
  return {
    seen,
    id: 'recording_source',
    version: 'test-1',
    async fetchSnapshot(ctx?: { signal?: AbortSignal }) {
      seen.push(ctx);
      if (ctx?.signal?.aborted) throw new Error('TOPOLOGY_FETCH_ABORTED');
      return SNAPSHOT;
    },
    snapshotHash() { return 'hash'; },
  };
}

test('enrich threads the caller FetchContext through to the topology source', async () => {
  const source = makeRecordingSource();
  const enricher = new TopologyEnricher({ source, now: () => 5000 });
  const ac = new AbortController();
  const ctx = { signal: ac.signal };

  const result = await enricher.enrich(GROUP, [], ctx);
  assert.equal(result.enrichment_error, null);
  assert.equal(source.seen.length, 1);
  assert.strictEqual(source.seen[0], ctx, 'the exact FetchContext object must reach the source');
});

test('an already-aborted signal degrades gracefully to enrichment_error', async () => {
  const source = makeRecordingSource();
  const enricher = new TopologyEnricher({ source, now: () => 5000 });
  const ac = new AbortController();
  ac.abort();

  const result = await enricher.enrich(GROUP, [], { signal: ac.signal });
  assert.equal(result.enrichment_error, 'TOPOLOGY_FETCH_ABORTED');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.topology_snapshot_hash, null);
});

test('enrich without a FetchContext stays backward compatible', async () => {
  const source = makeRecordingSource();
  const enricher = new TopologyEnricher({ source, now: () => 5000 });
  const result = await enricher.enrich(GROUP);
  assert.equal(result.enrichment_error, null);
  assert.equal(source.seen[0], undefined);
});

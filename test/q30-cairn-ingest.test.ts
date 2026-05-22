// test/q30-cairn-ingest.test.ts — Q30 / Addition #30 ingest helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidatesFromDsAudit,
  candidatesFromTesseraFeed,
  candidatesFromAnvilExperiments,
  candidatesFromExternalEvents,
} from '../dist/engine/cairn/ingest';

test('Q30 / AC-3 — candidatesFromDsAudit: well-formed record → deploy candidate with metadata', () => {
  const rs = [{
    deploy_id: 'd1', ts: 1700000000, verdict: 'extend' as const,
    alpha_consumed: 0.0009, alpha_budget: 0.001, config_version: 'vTest',
  }];
  const out = candidatesFromDsAudit(rs);
  assert.equal(out.length, 1);
  assert.equal(out[0].cause_kind, 'deploy');
  assert.equal(out[0].cause_id, 'deploy:d1');
  assert.equal(out[0].timestamp_unix, 1700000000);
  assert.equal(out[0].metadata?.ds_verdict, 'extend');
  assert.ok(Math.abs((out[0].metadata?.ds_alpha_consumed_ratio ?? 0) - 0.9) < 1e-9);
  assert.equal(out[0].evidence_ref, 'ds-audit:d1@1700000000#vTest');
});

test('Q30 / AC-3 — candidatesFromDsAudit: missing required fields → skipped (not thrown)', () => {
  const out = candidatesFromDsAudit([
    { deploy_id: 'ok', ts: 1700000000 },
    { /* no deploy_id */ ts: 1700000000 },
    { deploy_id: 'no-ts' /* no ts */ },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].cause_id, 'deploy:ok');
});

test('Q30 / AC-3 — candidatesFromTesseraFeed: well-formed payload → shard_event candidate', () => {
  const out = candidatesFromTesseraFeed([{
    group_id: 'g1', shard_id: 'shard-04', event_ts: 1700000000, verdict: 'rollback',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].cause_kind, 'shard_event');
  assert.equal(out[0].cause_id, 'tessera-shard:shard-04:g1');
  assert.equal(out[0].evidence_ref, 'tessera-verdict-group:g1');
});

test('Q30 / AC-3 — candidatesFromAnvilExperiments: every experiment becomes a chaos candidate', () => {
  const out = candidatesFromAnvilExperiments([
    { experiment_id: 'exp1', fault_start_unix: 1700000000, kind: 'network_delay', recovery_seconds: 60 },
    { experiment_id: 'exp2', fault_start_unix: 1700001000, kind: 'pod_kill' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].cause_kind, 'chaos_experiment');
  assert.equal(out[0].cause_id, 'chaos:exp1');
  assert.equal(out[0].metadata?.expected_failure_kind, 'network_delay');
});

test('Q30 / AC-3 — candidatesFromExternalEvents: distinct kinds preserved per event', () => {
  const out = candidatesFromExternalEvents([
    { event_id: 'e1', timestamp_unix: 1700000000, event_kind: 'env_change', description: 'restart', source: 'infra' },
    { event_id: 'e2', timestamp_unix: 1700001000, event_kind: 'dependency_change' },
    { event_id: 'e3', timestamp_unix: 1700002000, event_kind: 'generic' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].cause_kind, 'env_change');
  assert.equal(out[1].cause_kind, 'dependency_change');
  assert.equal(out[2].cause_kind, 'generic');
  assert.equal(out[0].evidence_ref, 'infra:e1');
  // No source → defaults to "external"
  assert.equal(out[1].evidence_ref, 'external:e2');
});

// test/session-store.test.ts — Task 3 (WS4 session-durability-argo plan):
// file-backed SessionStore. Store layout mirrors Addition #15 §B
// conventions (schema_version:'1' in every JSON file, atomic
// tmp+fs.renameSync writes, append-only JSONL for verdict history).
//
// hasTick/getStoredTickResponse idempotency is derived from the durable
// verdicts.jsonl, not a separate idempotency file that could drift — the
// re-open test below proves that by discarding the first instance's
// in-memory tick cache and reading a fresh SessionStore off the same
// on-disk dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore } from '../service/session/session-store';
import { SessionStoreSchemaError } from '../service/session/types';
import type { BeginSessionInput, VerdictHistoryEntry } from '../service/session/types';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-session-store-'));
}

function beginInput(overrides: Partial<BeginSessionInput> = {}): BeginSessionInput {
  const deployRef = overrides.deploy_ref ?? 'deploy-ref-1';
  const begunRequestTs = overrides.begun_request_ts ?? 1_700_000_000;
  return {
    session_id: overrides.session_id ?? `sess-${deployRef}-${begunRequestTs}`,
    service_id: overrides.service_id ?? 'svc-a',
    deploy_id: overrides.deploy_id ?? deployRef,
    deploy_ref: deployRef,
    mode: overrides.mode ?? 'enforce',
    fail_policy: overrides.fail_policy ?? 'fail_closed',
    active_calibration_version: overrides.active_calibration_version ?? 'v1',
    compiled_config_path: overrides.compiled_config_path ?? null,
    baseline_ref: overrides.baseline_ref ?? null,
    total_ticks: overrides.total_ticks ?? 60,
    begun_request_ts: begunRequestTs,
    begun_at: overrides.begun_at ?? new Date(begunRequestTs * 1000).toISOString(),
    deployment: overrides.deployment ?? {
      phase: 'baking', start_time_ms: begunRequestTs * 1000, cloud: 'primary',
    },
    scenario: overrides.scenario ?? {
      risk_level: 'medium', change_type: 'serving_code', author: 'human', time_window: 'ok',
      flags: {}, baseline: { p99_latency: 185 },
    },
  };
}

test('beginSession + getSession round-trip; index lookup by deploy_ref', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const input = beginInput();
  const rec = store.beginSession(input);
  assert.equal(rec.status, 'active');
  assert.equal(rec.tick, 0);
  assert.equal(rec.ended_at, null);
  assert.equal(rec.void_reason, null);
  assert.equal(rec.last_tick_at, null);
  assert.equal(rec.last_verdict, null);
  assert.equal(rec.schema_version, '1');

  const fetched = store.getSession(rec.session_id);
  assert.deepEqual(fetched, rec);

  const byRef = store.getSessionByDeployRef(input.deploy_ref);
  assert.deepEqual(byRef, rec);

  assert.equal(store.getSessionByDeployRef('nonexistent-ref'), null);
  assert.equal(store.getSession('nonexistent-id'), null);
});

test('updateSession is atomic and preserves unrelated fields', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const rec = store.beginSession(beginInput());

  const updated = store.updateSession(rec.session_id, { tick: 3, last_tick_at: '2026-01-01T00:00:00.000Z' });
  assert.equal(updated.tick, 3);
  assert.equal(updated.last_tick_at, '2026-01-01T00:00:00.000Z');
  assert.equal(updated.service_id, rec.service_id);
  assert.deepEqual(updated.scenario, rec.scenario);
  assert.equal(updated.session_id, rec.session_id);

  const reread = store.getSession(rec.session_id);
  assert.deepEqual(reread, updated);
});

test('appendVerdict + readVerdictHistory round-trip', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const rec = store.beginSession(beginInput());

  const entries: VerdictHistoryEntry[] = [0, 1, 2].map((tick) => ({
    session_id: rec.session_id,
    tick,
    emitted_at_ts: 1_700_000_100 + tick * 30,
    verdict: 'extend',
    verdict_code: -1,
    alpha_consumed: 0.0001 * tick,
    fires: [],
    shadow: false,
    recorded_at: new Date().toISOString(),
  }));
  for (const e of entries) store.appendVerdict(e);

  const history = store.readVerdictHistory(rec.session_id);
  assert.deepEqual(history, entries);
  assert.deepEqual(store.readVerdictHistory('no-such-session'), []);
});

test('hasTick/getStoredTickResponse idempotency is durable across a fresh store re-open', () => {
  const root = tmpRoot();
  const store1 = SessionStore.init(root, 'svc-a');
  const rec = store1.beginSession(beginInput());
  const entry: VerdictHistoryEntry = {
    session_id: rec.session_id,
    tick: 0,
    emitted_at_ts: 1_700_000_200,
    verdict: 'proceed',
    verdict_code: 0,
    alpha_consumed: 0.0001,
    fires: [],
    shadow: false,
    recorded_at: new Date().toISOString(),
  };
  store1.appendVerdict(entry);
  assert.equal(store1.hasTick(rec.session_id, 1_700_000_200), true);
  assert.equal(store1.hasTick(rec.session_id, 999), false);

  // Re-open from disk: a fresh instance shares no in-memory state with
  // store1 — this is the durability proof, not a cache-hit coincidence.
  const store2 = SessionStore.init(root, 'svc-a');
  assert.equal(store2.hasTick(rec.session_id, 1_700_000_200), true);
  assert.deepEqual(store2.getStoredTickResponse(rec.session_id, 1_700_000_200), entry);
  assert.equal(store2.getStoredTickResponse(rec.session_id, 999), null);
});

test('finishSession is idempotent', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const rec = store.beginSession(beginInput());

  const finished1 = store.finishSession(rec.session_id, 'total_ticks_reached');
  assert.equal(finished1.status, 'finished');
  assert.ok(finished1.ended_at);

  const finished2 = store.finishSession(rec.session_id, 'total_ticks_reached');
  assert.deepEqual(finished2, finished1);
});

test('voidAllActive voids only active sessions and sets void_reason', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const active = store.beginSession(beginInput({ deploy_ref: 'ref-active' }));
  const toFinish = store.beginSession(
    beginInput({ deploy_ref: 'ref-finished', begun_request_ts: 1_700_000_050 }),
  );
  store.finishSession(toFinish.session_id);

  const voided = store.voidAllActive('service_restart');
  assert.equal(voided.length, 1);
  assert.equal(voided[0].session_id, active.session_id);
  assert.equal(voided[0].void_reason, 'service_restart');
  assert.equal(voided[0].status, 'void');

  const stillFinished = store.getSession(toFinish.session_id)!;
  assert.equal(stillFinished.status, 'finished');
  assert.equal(stillFinished.void_reason, null);
});

test('stateGateContext reflects active/void/finished sessions', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const rec = store.beginSession(beginInput());

  assert.deepEqual(store.stateGateContext(rec.session_id), {
    session_status: 'active', void_reason: null, deployment_phase: 'baking',
  });

  store.voidSession(rec.session_id, 'session_ttl_expired');
  assert.deepEqual(store.stateGateContext(rec.session_id), {
    session_status: 'void', void_reason: 'session_ttl_expired', deployment_phase: 'baking',
  });

  const rec2 = store.beginSession(beginInput({ deploy_ref: 'ref-2', begun_request_ts: 1_700_000_099 }));
  store.finishSession(rec2.session_id);
  assert.deepEqual(store.stateGateContext(rec2.session_id), {
    session_status: 'finished', void_reason: null, deployment_phase: 'baking',
  });
});

test('wrong schema_version on a session record throws a typed error', () => {
  const root = tmpRoot();
  const store = SessionStore.init(root, 'svc-a');
  const rec = store.beginSession(beginInput());

  const sessionPath = path.join(root, 'svc-a', 'sessions', `${rec.session_id}.json`);
  const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  raw.schema_version = '99';
  fs.writeFileSync(sessionPath, JSON.stringify(raw));

  assert.throws(() => store.getSession(rec.session_id), SessionStoreSchemaError);
});

test('wrong schema_version on store-meta.json throws on init', () => {
  const root = tmpRoot();
  SessionStore.init(root, 'svc-a');
  const metaPath = path.join(root, 'svc-a', 'store-meta.json');
  const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  raw.schema_version = '2';
  fs.writeFileSync(metaPath, JSON.stringify(raw));

  assert.throws(() => SessionStore.init(root, 'svc-a'), SessionStoreSchemaError);
});

test('recordDeployment/updatePhase persist across a fresh re-open', () => {
  const root = tmpRoot();
  const store1 = SessionStore.init(root, 'svc-a');
  const rec = store1.beginSession(beginInput());

  store1.recordDeployment(rec.session_id, { cloud: 'secondary' });
  store1.updatePhase(rec.session_id, 'promoted');

  const store2 = SessionStore.init(root, 'svc-a');
  const reread = store2.getSession(rec.session_id)!;
  assert.equal(reread.deployment.cloud, 'secondary');
  assert.equal(reread.deployment.phase, 'promoted');
  assert.equal(reread.deployment.start_time_ms, rec.deployment.start_time_ms);
});

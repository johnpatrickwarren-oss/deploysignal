// test/gate-session-runtime.test.ts — Task 6 (WS4 session-durability-argo
// plan): GateSessionRuntime — begin/tick/finish/void orchestration over
// Tasks 2-5 (SessionStore, JsonlLifecycleEventEmitter,
// resolveActiveCalibration, G3 StateGateContext wiring).
//
// Also covers the Tasks 3-5 review "Important finding" folded into this
// task: SessionStore's index.json is read-modify-write, safe only under a
// single writer. GateSessionRuntime acquires a store-root pid lockfile in
// its constructor (stale lock from a dead pid reclaimed; live pid ->
// typed error) and releases it on close().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SessionStore } from '../service/session/session-store';
import { JsonlLifecycleEventEmitter } from '../service/session/jsonl-lifecycle-emitter';
import {
  GateSessionRuntime, GateRuntimeLockError, GateSessionNotFoundError, VERDICT_CODE,
} from '../service/gate-http/_gate-session-runtime';
import type {
  GateRuntimeConfig, BeginSessionRequest, TickRequest,
} from '../service/gate-http/_gate-session-runtime';

const { createAuditWriter } = require('../dist/engine/_audit-writer');

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASELINE: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function degradedMetrics(): Record<string, number> {
  return {
    ...BASELINE,
    p99_latency: BASELINE.p99_latency * 2.5,
    ttft: BASELINE.ttft * 2.2,
    downstream_err: BASELINE.downstream_err * 6,
  };
}

interface Harness {
  storeDir: string;
  baselineHistoryDir: string;
  store: SessionStore;
  emitter: JsonlLifecycleEventEmitter;
  auditWriter: ReturnType<typeof createAuditWriter>;
  runtime: GateSessionRuntime;
}

function makeHarness(overrides: Partial<GateRuntimeConfig> = {}): Harness {
  const storeDir = tmpRoot('ds-gate-runtime-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-runtime-baseline-');
  const serviceId = overrides.serviceId ?? 'svc-a';
  const store = SessionStore.init(storeDir, serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter({ dir: path.join(storeDir, serviceId, 'audit'), service: serviceId });
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir, serviceId,
    mode: 'enforce', failPolicy: 'fail_closed',
    totalTicksDefault: 8, sessionTtlSeconds: 3600,
    ...overrides,
  };
  const runtime = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  return {
    storeDir, baselineHistoryDir, store, emitter, auditWriter, runtime,
  };
}

function beginReq(overrides: Partial<BeginSessionRequest> = {}): BeginSessionRequest {
  return {
    deploy_ref: 'deploy-ref-1',
    requested_at_ts: 1_700_000_000,
    scenario: { baseline: BASELINE },
    ...overrides,
  };
}

function tickReq(emittedAtTs: number, metrics: Record<string, number> = BASELINE): TickRequest {
  return { emitted_at_ts: emittedAtTs, metrics };
}

// ────────────────────────────────────────────────────────────────────
// Happy path.
// ────────────────────────────────────────────────────────────────────

test('happy 3-tick path: begin + 3 clean ticks -> proceed, session finished', () => {
  const h = makeHarness({ totalTicksDefault: 3 });
  const { record } = h.runtime.begin(beginReq());
  assert.equal(record.status, 'active');
  assert.equal(record.total_ticks, 3);

  let last;
  for (let i = 0; i < 3; i++) {
    last = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30));
    assert.equal(last.replayed, false);
  }
  assert.ok(last);
  assert.equal(last!.verdict, 'proceed');
  assert.equal(last!.verdict_code, VERDICT_CODE.proceed);
  assert.equal(last!.session_status, 'finished');

  const finalRec = h.store.getSession(record.session_id)!;
  assert.equal(finalRec.status, 'finished');
  assert.equal(finalRec.tick, 3);
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Idempotency.
// ────────────────────────────────────────────────────────────────────

test('duplicate tick replays the stored result: does not advance tick or spend alpha twice', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const { record } = h.runtime.begin(beginReq());

  const first = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(first.replayed, false);
  const afterFirst = h.store.getSession(record.session_id)!;
  assert.equal(afterFirst.tick, 1);
  assert.equal(h.store.readVerdictHistory(record.session_id).length, 1);

  const replay = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(replay.replayed, true);
  assert.equal(replay.verdict, first.verdict);
  assert.equal(replay.verdict_code, first.verdict_code);
  assert.equal(replay.alpha_consumed, first.alpha_consumed);
  assert.deepEqual(replay.fires, first.fires);

  const afterReplay = h.store.getSession(record.session_id)!;
  assert.equal(afterReplay.tick, 1, 'tick counter must not advance on replay');
  assert.equal(h.store.readVerdictHistory(record.session_id).length, 1, 'no second history entry written');
  h.runtime.close();
});

test('begin idempotency: same deploy_ref twice returns the same session, created:false', () => {
  const h = makeHarness();
  const r1 = h.runtime.begin(beginReq());
  assert.equal(r1.created, true);
  const r2 = h.runtime.begin(beginReq());
  assert.equal(r2.created, false);
  assert.equal(r2.record.session_id, r1.record.session_id);
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Restart / declare-void-and-restart (OQ-1).
// ────────────────────────────────────────────────────────────────────

test('restart: sweepOnBoot voids active sessions; a further tick is rejected via G3; a fresh deploy_ref works', () => {
  const storeDir = tmpRoot('ds-gate-runtime-restart-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-runtime-restart-baseline-');
  const serviceId = 'svc-a';
  const store = SessionStore.init(storeDir, serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter(null);
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir, serviceId,
    mode: 'enforce', failPolicy: 'fail_closed',
    totalTicksDefault: 8, sessionTtlSeconds: 3600,
  };

  const runtime1 = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  const { record } = runtime1.begin(beginReq());
  runtime1.ingestTick(record.session_id, tickReq(1_700_000_000));
  runtime1.ingestTick(record.session_id, tickReq(1_700_000_030));
  const preRestart = store.getSession(record.session_id)!;
  assert.equal(preRestart.status, 'active');
  assert.equal(preRestart.tick, 2);
  runtime1.close(); // release the store-root lock — simulates a graceful stop

  const runtime2 = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  const voided = runtime2.sweepOnBoot();
  assert.equal(voided.length, 1);
  assert.equal(voided[0].session_id, record.session_id);
  assert.equal(voided[0].void_reason, 'service_restart');

  const stragglerResult = runtime2.ingestTick(record.session_id, tickReq(1_700_000_060));
  assert.equal(stragglerResult.shortCircuit, 'state');
  assert.equal(stragglerResult.verdict, 'extend');
  assert.equal(stragglerResult.session_status, 'void');

  const { record: freshRecord, created } = runtime2.begin(beginReq({ deploy_ref: 'deploy-ref-2', requested_at_ts: 1_700_000_100 }));
  assert.equal(created, true);
  assert.notEqual(freshRecord.session_id, record.session_id);
  const freshTick = runtime2.ingestTick(freshRecord.session_id, tickReq(1_700_000_100));
  assert.equal(freshTick.shortCircuit, null);

  runtime2.close();
});

// ────────────────────────────────────────────────────────────────────
// Rollback -> phase transition + finish.
// ────────────────────────────────────────────────────────────────────

test('rollback verdict transitions deployment phase to rolled_back and finishes the session', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const { record } = h.runtime.begin(beginReq());

  let result;
  for (let i = 0; i < 4; i++) {
    const metrics = i >= 2 ? degradedMetrics() : BASELINE;
    result = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, metrics));
  }
  assert.equal(result!.verdict, 'rollback');
  assert.equal(result!.verdict_code, VERDICT_CODE.rollback);
  assert.ok(result!.fires.length > 0);

  const finalRec = h.store.getSession(record.session_id)!;
  assert.equal(finalRec.deployment.phase, 'rolled_back');
  assert.equal(finalRec.status, 'finished');
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Fail policy on an evaluate() throw.
// ────────────────────────────────────────────────────────────────────

test('fail_closed: evaluate() throw -> extend/-1, session stays alive, error durable', () => {
  const h = makeHarness({ failPolicy: 'fail_closed' });
  const { record } = h.runtime.begin(beginReq());
  h.runtime.setEvaluateFnForTest(() => { throw new Error('injected engine failure'); });

  const result = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(result.verdict, 'extend');
  assert.equal(result.verdict_code, -1);
  assert.equal(result.error, 'injected engine failure');
  assert.equal(result.session_status, 'active');

  const history = h.store.readVerdictHistory(record.session_id);
  assert.equal(history.length, 1);
  assert.equal(history[0].error, 'injected engine failure');
  h.runtime.close();
});

test('fail_open: evaluate() throw -> proceed/0/degraded, session stays alive, error durable', () => {
  const h = makeHarness({ failPolicy: 'fail_open' });
  const { record } = h.runtime.begin(beginReq());
  h.runtime.setEvaluateFnForTest(() => { throw new Error('injected engine failure'); });

  const result = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(result.verdict, 'proceed');
  assert.equal(result.verdict_code, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.error, 'injected engine failure');

  const history = h.store.readVerdictHistory(record.session_id);
  assert.equal(history[0].degraded, true);
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Shadow mode.
// ────────────────────────────────────────────────────────────────────

test('shadow mode: real verdict recorded (shadow:true); verdictFor masks to proceed with shadow_verdict_code', () => {
  const h = makeHarness({ mode: 'shadow', totalTicksDefault: 8 });
  const { record } = h.runtime.begin(beginReq());

  let last;
  for (let i = 0; i < 4; i++) {
    const metrics = i >= 2 ? degradedMetrics() : BASELINE;
    last = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000 + i * 30, metrics));
  }
  assert.equal(last!.shadow, true);
  assert.equal(last!.verdict, 'rollback', 'the real verdict is still computed + recorded');

  const resp = h.runtime.verdictFor('deploy-ref-1')!;
  assert.equal(resp.verdict_code, 0);
  assert.equal(resp.verdict, 'proceed');
  assert.equal(resp.shadow_verdict_code, VERDICT_CODE.rollback);

  const history = h.store.readVerdictHistory(record.session_id);
  assert.ok(history.every((e) => e.shadow === true));
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// verdictFor() — no ticks yet, and unknown deploy_ref.
// ────────────────────────────────────────────────────────────────────

test('verdictFor: no ticks yet returns extend/-1/tick:0; unknown deploy_ref returns null', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  h.runtime.begin(beginReq());
  const resp = h.runtime.verdictFor('deploy-ref-1')!;
  assert.equal(resp.verdict_code, -1);
  assert.equal(resp.verdict, 'extend');
  assert.equal(resp.tick, 0);
  assert.equal(resp.total_ticks, 8);

  assert.equal(h.runtime.verdictFor('nonexistent-ref'), null);
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// TTL sweep.
// ────────────────────────────────────────────────────────────────────

test('sweepExpired voids an idle session past sessionTtlSeconds with session_ttl_expired', () => {
  const h = makeHarness({ sessionTtlSeconds: 60 });
  const { record } = h.runtime.begin(beginReq({ requested_at_ts: 1_700_000_000 }));

  h.runtime.sweepExpired(1_700_000_030); // within TTL
  assert.equal(h.store.getSession(record.session_id)!.status, 'active');

  h.runtime.sweepExpired(1_700_000_200); // past TTL
  const rec = h.store.getSession(record.session_id)!;
  assert.equal(rec.status, 'void');
  assert.equal(rec.void_reason, 'session_ttl_expired');
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Unknown session.
// ────────────────────────────────────────────────────────────────────

test('ingestTick on an unknown session_id throws GateSessionNotFoundError', () => {
  const h = makeHarness();
  assert.throws(() => h.runtime.ingestTick('no-such-session', tickReq(1_700_000_000)), GateSessionNotFoundError);
  h.runtime.close();
});

// ────────────────────────────────────────────────────────────────────
// Store-root single-writer lockfile (Tasks 3-5 review finding, folded
// into Task 6).
// ────────────────────────────────────────────────────────────────────

test('constructor throws GateRuntimeLockError when a live pid already holds the store lock', () => {
  const storeDir = tmpRoot('ds-gate-runtime-lock-live-');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.gate-runtime.lock'), JSON.stringify({ pid: process.pid }));

  const store = SessionStore.init(storeDir, 'svc-a');
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, 'svc-a', 'events.jsonl'));
  const auditWriter = createAuditWriter(null);
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir: tmpRoot('ds-gate-runtime-lock-baseline-'), serviceId: 'svc-a',
    mode: 'enforce', failPolicy: 'fail_closed', totalTicksDefault: 8, sessionTtlSeconds: 3600,
  };
  assert.throws(() => new GateSessionRuntime(cfg, store, emitter, auditWriter), GateRuntimeLockError);
});

test('constructor reclaims a stale lock left by a dead pid, and close() releases it', () => {
  const storeDir = tmpRoot('ds-gate-runtime-lock-stale-');
  fs.mkdirSync(storeDir, { recursive: true });

  // A guaranteed-dead pid: spawnSync blocks until the child has already
  // exited, so its pid is reliably no-longer-alive by the time we use it.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid!;
  assert.ok(deadPid > 0);

  const lockPath = path.join(storeDir, '.gate-runtime.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid }));

  const store = SessionStore.init(storeDir, 'svc-a');
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, 'svc-a', 'events.jsonl'));
  const auditWriter = createAuditWriter(null);
  const cfg: GateRuntimeConfig = {
    storeDir, baselineHistoryDir: tmpRoot('ds-gate-runtime-lock-baseline2-'), serviceId: 'svc-a',
    mode: 'enforce', failPolicy: 'fail_closed', totalTicksDefault: 8, sessionTtlSeconds: 3600,
  };
  const runtime = new GateSessionRuntime(cfg, store, emitter, auditWriter);
  const reclaimed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(reclaimed.pid, process.pid);

  runtime.close();
  assert.equal(fs.existsSync(lockPath), false, 'close() removes the lockfile it owns');
});

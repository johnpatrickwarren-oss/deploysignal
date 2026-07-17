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

  // m2 (final-review): a replay must not touch detector/trendBuffer
  // accumulator state either. Snapshot the full in-memory runtime state
  // (Maps included — VerdictGrouper's openByDeploy/recentlyClosed —
  // via the test-only seam) immediately before the replayed call, and
  // again immediately after, then compare.
  const stateBeforeReplay = h.runtime.getRuntimeStateSnapshotForTest(record.session_id);
  assert.ok(stateBeforeReplay, 'runtime state must exist after a real (non-replay) tick');

  const replay = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(replay.replayed, true);
  assert.equal(replay.verdict, first.verdict);
  assert.equal(replay.verdict_code, first.verdict_code);
  assert.equal(replay.alpha_consumed, first.alpha_consumed);
  assert.deepEqual(replay.fires, first.fires);

  const stateAfterReplay = h.runtime.getRuntimeStateSnapshotForTest(record.session_id);
  assert.deepEqual(
    stateAfterReplay, stateBeforeReplay,
    'replay must not mutate any accumulator (trendBuffer/cusum/betting/mixture-supermartingale/verdictGrouper state)',
  );

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

// M1 (final-review blocker): a retried POST /v1/sessions that computes
// the SAME sess-${deploy_ref}-${ts} id as a now-dead (void/finished)
// session must never overwrite that record in place — doing so would
// destroy its void_reason/last_verdict audit trail and resurrect the
// dead session's <id>.verdicts.jsonl idempotency keys under the new
// session, so a genuinely fresh tick at a colliding emitted_at_ts would
// wrongly come back replayed:true with a stale, never-evaluated verdict.
test('M1: begin() colliding with a dead session\'s id mints a NEW session_id; old record + old idempotency history stay intact; a fresh tick at a colliding ts is EVALUATED not replayed', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const collidingTs = 1_700_000_000;
  const staleTickTs = 1_700_000_030;

  const { record: original } = h.runtime.begin(beginReq({ requested_at_ts: collidingTs }));
  h.runtime.ingestTick(original.session_id, tickReq(staleTickTs));
  assert.equal(h.store.getSession(original.session_id)!.tick, 1);

  // The session goes dead (e.g. a service_restart sweep), and a retried
  // begin computes the exact same deploy_ref + requested_at_ts as the
  // original — the id-collision scenario M1 covers.
  h.store.voidSession(original.session_id, 'service_restart');
  const voidedBeforeRetry = h.store.getSession(original.session_id)!;
  assert.equal(voidedBeforeRetry.status, 'void');
  assert.equal(voidedBeforeRetry.void_reason, 'service_restart');
  const oldHistoryLenBeforeRetry = h.store.readVerdictHistory(original.session_id).length;
  assert.equal(oldHistoryLenBeforeRetry, 1);

  const { record: retried, created } = h.runtime.begin(beginReq({ requested_at_ts: collidingTs }));
  assert.equal(created, true);
  assert.notEqual(retried.session_id, original.session_id, 'a NEW session_id must be minted, never overwriting the dead record');
  assert.equal(retried.session_id, `${original.session_id}-r2`, 'deterministic attempt-counter suffix');

  // (a) old record intact, void_reason preserved, old idempotency
  // history (verdicts.jsonl) untouched.
  const oldStillThere = h.store.getSession(original.session_id)!;
  assert.deepEqual(oldStillThere, voidedBeforeRetry, 'the dead record must be byte-identical after the colliding begin()');
  assert.equal(h.store.readVerdictHistory(original.session_id).length, oldHistoryLenBeforeRetry);

  // (b) a fresh tick on the NEW session at a timestamp that collided
  // with the OLD session's history must be EVALUATED, not replayed —
  // the new session id has its own, empty idempotency state because it
  // maps to a distinct <id>.verdicts.jsonl file.
  const freshTick = h.runtime.ingestTick(retried.session_id, tickReq(staleTickTs));
  assert.equal(freshTick.replayed, false, 'must be evaluated, not replayed from the dead session\'s history');
  assert.equal(h.store.getSession(retried.session_id)!.tick, 1);
  assert.equal(h.store.readVerdictHistory(retried.session_id).length, 1);
  // The old session's history is still exactly what it was — no
  // cross-session bleed-through in either direction.
  assert.equal(h.store.readVerdictHistory(original.session_id).length, oldHistoryLenBeforeRetry);

  h.runtime.close();
});

// m5 (final-review): a tick that reaches ingestTick() for a session
// already dead (void/finished) at entry can only get there via G3's
// deny short-circuit on a direct runtime call (the HTTP layer
// pre-checks status and returns 409 before calling the runtime at all —
// see _gate-handlers.ts handleTick). Durable state must stay
// byte-identical: no new verdict-history line, no tick/last_verdict
// bump, on the dead record.
test('m5: a G3-denied tick against an already-dead session does not persist — no history line, no tick/last_verdict bump', () => {
  const h = makeHarness({ totalTicksDefault: 8 });
  const { record } = h.runtime.begin(beginReq());
  h.runtime.ingestTick(record.session_id, tickReq(1_700_000_000));
  assert.equal(h.store.getSession(record.session_id)!.tick, 1);

  h.store.voidSession(record.session_id, 'manual_test_void');
  const beforeDenied = h.store.getSession(record.session_id)!;
  const historyLenBefore = h.store.readVerdictHistory(record.session_id).length;

  const denied = h.runtime.ingestTick(record.session_id, tickReq(1_700_000_030));
  assert.equal(denied.shortCircuit, 'state');
  assert.equal(denied.session_status, 'void');

  const afterDenied = h.store.getSession(record.session_id)!;
  assert.deepEqual(afterDenied, beforeDenied, 'a G3-denied tick must not mutate the dead record at all (no tick/last_verdict/phase change)');
  assert.equal(h.store.readVerdictHistory(record.session_id).length, historyLenBefore, 'no new verdict-history line written for a denied tick');

  h.runtime.close();
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

// m1 (final-review): shadow must mask void too — per OQ-7 "a shadow
// gate must never block", a voided SHADOW session's verdictFor() must
// still return verdict_code 0/proceed, with the fail-policy-derived
// "real" (would-be enforce-mode) code in shadow_verdict_code, and the
// void surfaced via the error/degraded field. Precedence: shadow always
// wins the top-level verdict_code, even over a void session.
test('verdictFor: a void SHADOW session never blocks (verdict_code 0); real code lands in shadow_verdict_code; void still surfaced', () => {
  const closed = makeHarness({ mode: 'shadow', failPolicy: 'fail_closed', totalTicksDefault: 8 });
  const { record: closedRecord } = closed.runtime.begin(beginReq());
  closed.runtime.ingestTick(closedRecord.session_id, tickReq(1_700_000_000));
  closed.store.voidSession(closedRecord.session_id, 'session_ttl_expired');

  const closedResp = closed.runtime.verdictFor('deploy-ref-1')!;
  assert.equal(closedResp.verdict_code, 0, 'a shadow gate must never block, even when the session is void');
  assert.equal(closedResp.verdict, 'proceed');
  assert.equal(closedResp.shadow_verdict_code, VERDICT_CODE.extend, 'the real fail_closed-void code (-1) is preserved in shadow_verdict_code');
  assert.equal(closedResp.error, 'session_void: session_ttl_expired', 'void is surfaced via the error field');
  closed.runtime.close();

  const open = makeHarness({ mode: 'shadow', failPolicy: 'fail_open', totalTicksDefault: 8 });
  const { record: openRecord } = open.runtime.begin(beginReq());
  open.runtime.ingestTick(openRecord.session_id, tickReq(1_700_000_000));
  open.store.voidSession(openRecord.session_id, 'session_ttl_expired');

  const openResp = open.runtime.verdictFor('deploy-ref-1')!;
  assert.equal(openResp.verdict_code, 0);
  assert.equal(openResp.verdict, 'proceed');
  assert.equal(openResp.shadow_verdict_code, VERDICT_CODE.proceed, 'fail_open-void real code is already 0');
  assert.equal(openResp.degraded, true, 'void is surfaced via degraded even though shadow always returns 0');
  open.runtime.close();
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

// test/twin-gate-http.test.ts — Plan B Task 4: the gate service's twin mode, the shared HTTP
// contract (engine ADR 0036 sessions for Plan C's CodeDeploy hook and sources).
//
//   POST /v1/sessions {"mode":"twin","twin_arm":{…}} -> 201 {"session_id","mode":"twin"}; no
//     scenario.baseline.
//   POST /v1/sessions/{id}/ticks {canary_requests, control_requests, observations} -> 200
//     {verdict, engine_verdict, authority, tick, srm_e, metrics[], ticks_to_detect?}.
//   verdict: rollback->rollback, proceed->proceed, extend->extend, inconclusive->hold,
//     invalid_experiment->halt.
// Persistence follows the existing session runtime: a durable SessionRecord (with twin_arm) and a
// per-tick verdict history; the gate state in memory; void on restart (OQ-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TWIN_PROFILE, twinTicks, toSnake } from './_twin-fixture';
import { gateConfig, start, stop, req, twinBody, type Started } from './_twin-http-harness';

const TICK_KEYS = ['authority', 'engine_verdict', 'metrics', 'srm_e', 'tick', 'verdict'];
const METRIC_KEYS = ['id', 'missing', 'proceed_e', 'proceed_threshold', 'rollback_e', 'rollback_threshold', 'skipped', 'ties', 'used'];

async function begin(s: Started, body: Record<string, unknown> = twinBody()): Promise<string> {
  const r = await req(s.baseUrl, 'POST', '/v1/sessions', body);
  assert.equal(r.status, 201, r.raw);
  return r.json.session_id;
}

test('twin: session create needs no scenario.baseline and returns exactly {session_id, mode}', async () => {
  const s = await start();
  try {
    const r = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody());
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(Object.keys(r.json).sort(), ['mode', 'session_id']);
    assert.equal(r.json.mode, 'twin');
    const rec = s.handle.store.getSession(r.json.session_id)!;
    assert.deepEqual(rec.twin_arm, TWIN_PROFILE);
    assert.equal(rec.mode, 'shadow', 'a twin record is shadow: GET /v1/verdict never blocks');
    assert.equal(rec.total_ticks, TWIN_PROFILE.max_ticks);
    assert.equal(rec.status, 'active');
  } finally { await stop(s); }
});

test('twin: session create refuses a malformed or engine-refused twin_arm with 400', async () => {
  const s = await start();
  try {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ mode: 'twin' }, /twin_arm/],
      [twinBody({ ...TWIN_PROFILE, metrics: [] }), /metrics/],
      [twinBody({ ...TWIN_PROFILE, canary_weight: 0.3 }), /equal routing weights/],
      [twinBody({ ...TWIN_PROFILE, max_ticks: 1.5 }), /max_ticks/],
      [twinBody({ ...TWIN_PROFILE, metrics: [{ id: 'x', kind: 'ratio', worse: 'higher', tolerance: 0.1 }] }), /kind/],
      [twinBody({ ...TWIN_PROFILE, extra: 1 }), /extra/],
      [twinBody(TWIN_PROFILE as never, { deploy_ref: '../x' }), /deploy_ref/],
    ];
    for (const [body, re] of bad) {
      const r = await req(s.baseUrl, 'POST', '/v1/sessions', body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} -> ${r.raw}`);
      assert.match(r.json.error, re);
    }
  } finally { await stop(s); }
});

test('twin: a regressed canary ticks to rollback with the contract body, then the session is finished', async () => {
  const s = await start();
  try {
    const id = await begin(s);
    const next = twinTicks(11, { canaryOdds: 3, latencyShift: 2 });
    let last: any;
    for (let t = 0; t < 60; t++) {
      const r = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(next()));
      assert.equal(r.status, 200, r.raw);
      last = r.json;
      const keys = Object.keys(last).filter((k) => k !== 'ticks_to_detect').sort();
      assert.deepEqual(keys, TICK_KEYS);
      assert.equal(last.authority, 'advisory');
      assert.deepEqual(Object.keys(last.metrics[0]).sort(), METRIC_KEYS);
      assert.equal(last.tick, t + 1);
      if (last.engine_verdict !== 'extend') break;
      assert.equal(last.verdict, 'extend');
    }
    assert.equal(last.engine_verdict, 'rollback');
    assert.equal(last.verdict, 'rollback');
    assert.ok(typeof last.ticks_to_detect === 'number' && last.ticks_to_detect > 0);
    const rec = s.handle.store.getSession(id)!;
    assert.equal(rec.status, 'finished');
    assert.notEqual(rec.deployment.phase, 'rolled_back', 'an advisory rollback never marks the deploy rolled back');
    assert.equal(rec.last_verdict!.verdict, 'rollback');
    assert.equal(rec.last_verdict!.engine_verdict, 'rollback');
    assert.equal(s.handle.store.readVerdictHistory(id).length, last.tick);
    const after = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(next()));
    assert.equal(after.status, 409);
    assert.equal(after.json.status, 'finished');
    assert.equal(after.json.last_verdict.verdict, 'rollback');
  } finally { await stop(s); }
});

test('twin: inconclusive at max_ticks maps to hold; a canary with no traffic maps to halt', async () => {
  const s = await start();
  try {
    const id = await begin(s, twinBody({ ...TWIN_PROFILE, max_ticks: 3 }));
    const next = twinTicks(3);
    let r: any;
    for (let t = 0; t < 3; t++) r = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(next()));
    assert.equal(r.json.engine_verdict, 'inconclusive');
    assert.equal(r.json.verdict, 'hold');

    const id2 = await begin(s, twinBody(TWIN_PROFILE as never, { deploy_ref: 'srm-case' }));
    let v: any;
    for (let t = 0; t < 60; t++) {
      v = (await req(s.baseUrl, 'POST', `/v1/sessions/${id2}/ticks`, { canary_requests: 0, control_requests: 1000, observations: {} })).json;
      if (v.engine_verdict !== 'extend') break;
    }
    assert.equal(v.engine_verdict, 'invalid_experiment');
    assert.equal(v.verdict, 'halt');
    assert.ok(v.srm_e >= 1 / TWIN_PROFILE.alpha_srm);
  } finally { await stop(s); }
});

test('twin: tick validation — unknown metric, wrong kind, non-integer counts, negative requests are 400 and change nothing', async () => {
  const s = await start();
  try {
    const id = await begin(s);
    const good = toSnake(twinTicks(4)());
    const bad: Array<[unknown, RegExp]> = [
      [{ ...good, observations: { ...good.observations, nope: { canary: 1, control: 2 } } }, /unknown metric/],
      [{ ...good, observations: { ...good.observations, http_5xx: { canary: 1, control: 2 } } }, /http_5xx/],
      [{ ...good, observations: { ...good.observations, p99_latency_ms: { canary_events: 1, canary_total: 2, control_events: 1, control_total: 2 } } }, /p99_latency_ms/],
      [{ ...good, observations: { ...good.observations, http_5xx: { canary_events: 1.5, canary_total: 10, control_events: 1, control_total: 10 } } }, /integer/],
      [{ ...good, canary_requests: -1 }, /canary_requests/],
      [{ ...good, observations: undefined }, /observations/],
    ];
    for (const [body, re] of bad) {
      const r = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, body);
      assert.equal(r.status, 400, r.raw);
      assert.match(r.json.error, re);
    }
    assert.equal(s.handle.store.getSession(id)!.tick, 0);
    const ok = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, good);
    assert.equal(ok.json.tick, 1);
  } finally { await stop(s); }
});

test('twin: a metric missing while the canary takes traffic is counted, and a sign value of null is missing', async () => {
  const s = await start();
  try {
    const id = await begin(s);
    const t = toSnake(twinTicks(8)());
    delete (t.observations as Record<string, unknown>).success;
    (t.observations as Record<string, unknown>).p99_latency_ms = { canary: null, control: 200 };
    const r = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, t);
    assert.equal(r.status, 200, r.raw);
    const by = Object.fromEntries(r.json.metrics.map((m: any) => [m.id, m]));
    assert.equal(by.success.missing, 1);
    assert.equal(by.p99_latency_ms.missing, 1);
    assert.equal(by.http_5xx.missing, 0);
  } finally { await stop(s); }
});

test('twin: a tick with emitted_at_ts is idempotent — a retry replays the stored body and does not advance the gate', async () => {
  const s = await start();
  try {
    const id = await begin(s);
    const body = { ...toSnake(twinTicks(6)()), emitted_at_ts: 1_800_000_000 };
    const a = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, body);
    const b = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, body);
    assert.equal(a.status, 200);
    assert.deepEqual(b.json, a.json);
    assert.equal(s.handle.store.getSession(id)!.tick, 1);
    assert.equal(s.handle.store.readVerdictHistory(id).length, 1);
  } finally { await stop(s); }
});

test('twin: the same deploy_ref while active returns the same session (200); a different twin_arm is 409', async () => {
  const s = await start();
  try {
    const id = await begin(s, twinBody(TWIN_PROFILE as never, { deploy_ref: 'rev-7' }));
    const again = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody(TWIN_PROFILE as never, { deploy_ref: 'rev-7' }));
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { session_id: id, mode: 'twin' });
    const clash = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody({ ...TWIN_PROFILE, max_ticks: 7 }, { deploy_ref: 'rev-7' }));
    assert.equal(clash.status, 409);
  } finally { await stop(s); }
});

test('twin: a restart voids the active twin session (OQ-1), like every other session', async () => {
  const cfg = gateConfig();
  const s = await start(cfg);
  const id = await begin(s);
  await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(twinTicks(2)()));
  await stop(s);
  const s2 = await start(cfg);
  try {
    const rec = s2.handle.store.getSession(id)!;
    assert.equal(rec.status, 'void');
    assert.equal(rec.void_reason, 'service_restart');
    const r = await req(s2.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(twinTicks(2)()));
    assert.equal(r.status, 409);
  } finally { await stop(s2); }
});

test('twin: GET /v1/sessions/{id} shows the twin record and the verdict history tail', async () => {
  const s = await start();
  try {
    const id = await begin(s);
    await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(twinTicks(2)()));
    const r = await req(s.baseUrl, 'GET', `/v1/sessions/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.twin_arm, TWIN_PROFILE);
    assert.equal(r.json.verdict_history_tail.length, 1);
    assert.equal(r.json.verdict_history_tail[0].twin.authority, 'advisory');
  } finally { await stop(s); }
});

test('twin: a twin tick to an unknown session is 404', async () => {
  const s = await start();
  try {
    const r = await req(s.baseUrl, 'POST', '/v1/sessions/sess-nope-1/ticks', toSnake(twinTicks(1)()));
    assert.equal(r.status, 404);
  } finally { await stop(s); }
});

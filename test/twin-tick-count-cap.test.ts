// test/twin-tick-count-cap.test.ts — review finding on Plan B: per-tick rate counts had no upper
// bound. The pinned engine's Fisher noncentral mean is O(N) in time and memory inside the request
// thread (about 2 s per call at 1e7 events; a fatal heap OOM at 4e8 on a 1 GB heap). A source that
// sends cumulative Prometheus counters instead of per-tick deltas reaches that range, and a crashed
// gate voids every active session on restart (sweepOnBoot), enforce-mode sessions included.
//
// The service now refuses any per-tick count above DS_GATE_TWIN_MAX_TICK_COUNT (default 1e7) with
// a 400, before the engine sees it, and leaves the session's gate state untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFromEnv, GateConfigError, DEFAULT_TWIN_MAX_TICK_COUNT } from '../service/gate-http/_gate-config';
import { parseTwinTick } from '../service/gate-http/_gate-twin';
import { TWIN_PROFILE } from './_twin-fixture';
import { gateConfig, start, stop, req, twinBody } from './_twin-http-harness';

function tick(n: number, requests = 1000): Record<string, unknown> {
  return {
    canary_requests: requests, control_requests: requests,
    observations: {
      http_5xx: { canary_events: 1, canary_total: n, control_events: 1, control_total: n },
      success: { canary_events: 990, canary_total: 1000, control_events: 990, control_total: 1000 },
      p99_latency_ms: { canary: 120, control: 118 },
    },
  };
}

test('cap: default is 1e7, configurable by env, and a non-positive or non-integer value is refused at startup', () => {
  assert.equal(DEFAULT_TWIN_MAX_TICK_COUNT, 1e7);
  assert.equal(loadConfigFromEnv({}).twinMaxTickCount, 1e7);
  assert.equal(loadConfigFromEnv({ DS_GATE_TWIN_MAX_TICK_COUNT: '5000' }).twinMaxTickCount, 5000);
  assert.equal(loadConfigFromEnv({ DS_GATE_TWIN_MAX_TICK_COUNT: '2e6' }).twinMaxTickCount, 2e6);
  for (const v of ['0', '-5', '1.5', 'abc']) {
    assert.throws(() => loadConfigFromEnv({ DS_GATE_TWIN_MAX_TICK_COUNT: v }), GateConfigError, v);
  }
});

test('cap: parseTwinTick refuses any rate count or request count above the cap, accepts the cap itself', () => {
  assert.doesNotThrow(() => parseTwinTick(TWIN_PROFILE, tick(1e7)));
  assert.throws(() => parseTwinTick(TWIN_PROFILE, tick(1e7 + 1)), /observations\.http_5xx\.canary_total .*exceeds the per-tick cap 10000000/);
  assert.throws(() => parseTwinTick(TWIN_PROFILE, tick(1000, 4e8)), /canary_requests .*exceeds the per-tick cap/);
  assert.throws(() => parseTwinTick(TWIN_PROFILE, tick(1e300)), /exceeds the per-tick cap/);
  assert.throws(() => parseTwinTick(TWIN_PROFILE, tick(5001), 5000), /exceeds the per-tick cap 5000/);
});

test('cap: over-cap tick is a fast 400 over HTTP and the session keeps ticking', async () => {
  const s = await start(gateConfig({ twinMaxTickCount: 5000 }));
  try {
    const b = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody());
    assert.equal(b.status, 201, b.raw);
    const id = b.json.session_id;
    const t0 = Date.now();
    const r = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, tick(4e8));
    assert.equal(r.status, 400, r.raw);
    assert.match(r.json.error, /exceeds the per-tick cap 5000/);
    assert.ok(Date.now() - t0 < 1000, 'refused before the engine runs');
    const ok = await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, tick(1000));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.json.tick, 1, 'the refused tick did not advance the session');
  } finally { await stop(s); }
});

// test/gate-http-server.test.ts — Task 7 (WS4 session-durability-argo
// plan): the gate HTTP verdict service. Real http.request() calls
// against a server bound to port 0 (ephemeral), closed in `finally`.
// Also covers Task 8's YAML-contract test (the AnalysisTemplate must
// stay in lockstep with the live GET /v1/verdict response shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as yaml from 'js-yaml';

import { createGateServer } from '../service/gate-http/server';
import type { GateServerHandle } from '../service/gate-http/server';
import type { GateHttpConfig } from '../service/gate-http/_gate-config';

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Unlike the Task 6 runtime-level tests (which call sweepExpired()
// explicitly with a caller-controlled nowTs), the HTTP router calls
// sweepExpired(Date.now() / 1000) on every /v1/* request — so fixture
// timestamps here must be anchored near real wall-clock time, not the
// arbitrary historical constants (`1_700_000_000`) the rest of the repo's
// tests use, or the TTL sweep would immediately void a freshly begun
// session on the very next request.
const NOW = Math.floor(Date.now() / 1000);

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

interface Started {
  handle: GateServerHandle;
  baseUrl: string;
  cfg: GateHttpConfig;
}

async function start(overrides: Partial<GateHttpConfig> = {}): Promise<Started> {
  const storeDir = tmpRoot('ds-gate-http-store-');
  const baselineHistoryDir = tmpRoot('ds-gate-http-baseline-');
  const serviceId = overrides.serviceId ?? 'svc-a';
  const cfg: GateHttpConfig = {
    port: 0, bind: '127.0.0.1', sharedSecret: null,
    storeDir, baselineHistoryDir, serviceId,
    failPolicy: 'fail_closed', mode: 'enforce',
    totalTicksDefault: 8, sessionTtlSeconds: 3600, requestTimeoutMs: 4000,
    auditDir: path.join(storeDir, serviceId, 'audit'),
    ...overrides,
  };
  const handle = createGateServer(cfg);
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  const port = (handle.server.address() as AddressInfo).port;
  return { handle, baseUrl: `http://127.0.0.1:${port}`, cfg };
}

async function stop(s: Started): Promise<void> {
  await s.handle.close();
}

interface Resp { status: number; json: any; raw: string }

/** m4 test helper: sends a GET request line over a raw TCP socket,
 *  bypassing http.request()'s own URL parsing/normalization — a
 *  compliant client (Node's http.request(urlString, ...), browsers,
 *  curl) collapses a percent-encoded dot-segment (`%2E%2E`) before the
 *  request ever leaves the client, so exercising the server's own
 *  defense against that payload requires writing the request target
 *  onto the wire verbatim. */
function rawGet(port: number, requestTarget: string): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    socket.on('end', () => {
      const statusLine = data.split('\r\n')[0];
      const m = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
      resolve({ status: m ? Number(m[1]) : -1, raw: data });
    });
    socket.on('error', reject);
  });
}

function req(
  baseUrl: string, method: string, urlPath: string,
  opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody !== undefined ? opts.rawBody : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request(baseUrl + urlPath, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode!, json, raw });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

function beginBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deploy_ref: 'deploy-ref-1',
    requested_at_ts: NOW,
    scenario: { baseline: BASELINE },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Endpoint happy paths.
// ────────────────────────────────────────────────────────────────────

test('POST /v1/sessions -> 201 new session; GET /v1/sessions/{id} -> full record', async () => {
  const s = await start();
  try {
    const begin = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    assert.equal(begin.status, 201);
    assert.equal(begin.json.status, 'active');
    assert.equal(begin.json.config_source, 'legacy');
    assert.ok(begin.json.session_id);

    const again = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    assert.equal(again.status, 200, 'idempotent by deploy_ref while active');
    assert.equal(again.json.session_id, begin.json.session_id);

    const got = await req(s.baseUrl, 'GET', `/v1/sessions/${begin.json.session_id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.session_id, begin.json.session_id);
    assert.ok(Array.isArray(got.json.verdict_history_tail));
  } finally { await stop(s); }
});

test('POST /v1/sessions/{id}/ticks -> 200; GET /v1/verdict/{deploy_ref} reflects it; finish -> 200', async () => {
  const s = await start({ totalTicksDefault: 8 });
  try {
    const begin = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;

    const tick = await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
      body: { emitted_at_ts: NOW, metrics: BASELINE },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.json.replayed, false);
    assert.equal(tick.json.tick, 0);

    const verdict = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(verdict.status, 200);
    assert.equal(verdict.json.tick, 1);

    const finish = await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/finish`, { body: { reason: 'manual' } });
    assert.equal(finish.status, 200);
    assert.equal(finish.json.status, 'finished');

    const finishAgain = await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/finish`, {});
    assert.equal(finishAgain.status, 200, 'idempotent finish');
  } finally { await stop(s); }
});

test('GET /healthz -> 200 {ok, service_id, mode, fail_policy}', async () => {
  const s = await start({ serviceId: 'svc-health', mode: 'shadow', failPolicy: 'fail_open' });
  try {
    const r = await req(s.baseUrl, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, service_id: 'svc-health', mode: 'shadow', fail_policy: 'fail_open' });
  } finally { await stop(s); }
});

test('GET /readyz -> 200 healthy; 503 when store dir is unwritable', async () => {
  const s = await start();
  try {
    const healthy = await req(s.baseUrl, 'GET', '/readyz');
    assert.equal(healthy.status, 200);
    assert.equal(healthy.json.ok, true);
    assert.equal(healthy.json.store_writable, true);
    assert.equal(healthy.json.audit_writer.healthy, true);
    assert.equal(healthy.json.config_source, 'legacy');

    fs.chmodSync(s.cfg.storeDir, 0o500);
    try {
      const unwritable = await req(s.baseUrl, 'GET', '/readyz');
      assert.equal(unwritable.status, 503);
      assert.equal(unwritable.json.store_writable, false);
    } finally {
      fs.chmodSync(s.cfg.storeDir, 0o700);
    }
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// Error paths.
// ────────────────────────────────────────────────────────────────────

test('unknown route -> 404', async () => {
  const s = await start();
  try {
    const r = await req(s.baseUrl, 'GET', '/v1/nope');
    assert.equal(r.status, 404);
  } finally { await stop(s); }
});

test('body > 200KB -> 413', async () => {
  const s = await start();
  try {
    const huge = JSON.stringify({ deploy_ref: 'x', requested_at_ts: 1, scenario: { baseline: {}, pad: 'a'.repeat(250_000) } });
    const r = await req(s.baseUrl, 'POST', '/v1/sessions', { rawBody: huge });
    assert.equal(r.status, 413);
  } finally { await stop(s); }
});

test('unknown session_id -> 404 on ticks/get/finish', async () => {
  const s = await start();
  try {
    const t = await req(s.baseUrl, 'POST', '/v1/sessions/nope/ticks', { body: { emitted_at_ts: 1, metrics: {} } });
    assert.equal(t.status, 404);
    const g = await req(s.baseUrl, 'GET', '/v1/sessions/nope');
    assert.equal(g.status, 404);
    const f = await req(s.baseUrl, 'POST', '/v1/sessions/nope/finish', {});
    assert.equal(f.status, 404);
  } finally { await stop(s); }
});

test('unknown deploy_ref on GET /v1/verdict -> 404', async () => {
  const s = await start();
  try {
    const r = await req(s.baseUrl, 'GET', '/v1/verdict/nope');
    assert.equal(r.status, 404);
  } finally { await stop(s); }
});

test('400 on missing required fields', async () => {
  const s = await start();
  try {
    const noDeployRef = await req(s.baseUrl, 'POST', '/v1/sessions', { body: { requested_at_ts: 1, scenario: { baseline: {} } } });
    assert.equal(noDeployRef.status, 400);
    const noBaseline = await req(s.baseUrl, 'POST', '/v1/sessions', { body: { deploy_ref: 'd', requested_at_ts: 1 } });
    assert.equal(noBaseline.status, 400);
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// m4 (final-review): deploy_ref/session_id charset validation at the
// router/handler boundary. Both flow into SessionStore filenames
// (session_id directly; deploy_ref via the `sess-${deploy_ref}-${ts}`
// convention) — reject anything outside [A-Za-z0-9._-] with 400,
// including path-traversal attempts (%2F, literal/encoded "..").
// ────────────────────────────────────────────────────────────────────

test('m4: session_id path segment containing an encoded slash (%2F) is rejected 400 before reaching the store', async () => {
  const s = await start();
  try {
    const onTicks = await req(s.baseUrl, 'POST', '/v1/sessions/foo%2F..%2Fetc%2Fpasswd/ticks', {
      body: { emitted_at_ts: NOW, metrics: BASELINE },
    });
    assert.equal(onTicks.status, 400);
    assert.match(onTicks.json.error, /invalid session_id/);

    const onGet = await req(s.baseUrl, 'GET', '/v1/sessions/foo%2Fbar');
    assert.equal(onGet.status, 400);

    const onFinish = await req(s.baseUrl, 'POST', '/v1/sessions/foo%2Fbar/finish', {});
    assert.equal(onFinish.status, 400);
  } finally { await stop(s); }
});

test('m4: session_id path segment that decodes to a literal ".." is rejected 400 (encoded dot-segment guard)', async () => {
  const s = await start();
  try {
    // Node's own http.request(urlString, ...) — like browsers and curl —
    // normalizes a percent-encoded dot-segment (%2E%2E -> "..") and
    // collapses it before the request ever leaves the client, so this
    // exact payload can only reach our server verbatim over a raw
    // socket (a client that does NOT normalize). That is exactly the
    // server-side defense this guard needs to prove.
    const port = (s.handle.server.address() as AddressInfo).port;
    const r = await rawGet(port, '/v1/sessions/%2E%2E');
    assert.equal(r.status, 400);
    assert.match(r.raw, /invalid session_id/);
  } finally { await stop(s); }
});

test('m4: GET /v1/verdict/{deploy_ref} with an encoded slash is rejected 400', async () => {
  const s = await start();
  try {
    const r = await req(s.baseUrl, 'GET', '/v1/verdict/..%2F..%2Fetc%2Fpasswd');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid deploy_ref/);
  } finally { await stop(s); }
});

test('m4: deploy_ref outside the safe identifier charset is rejected 400 on POST /v1/sessions (body field, traversal guard)', async () => {
  const s = await start();
  try {
    const withSlash = await req(s.baseUrl, 'POST', '/v1/sessions', {
      body: { deploy_ref: '../../etc/passwd', requested_at_ts: NOW, scenario: { baseline: BASELINE } },
    });
    assert.equal(withSlash.status, 400);
    assert.match(withSlash.json.error, /deploy_ref/);

    const literalDotDot = await req(s.baseUrl, 'POST', '/v1/sessions', {
      body: { deploy_ref: '..', requested_at_ts: NOW, scenario: { baseline: BASELINE } },
    });
    assert.equal(literalDotDot.status, 400);

    // A charset-safe deploy_ref (hyphens/dots/underscores) still works —
    // the guard rejects only unsafe characters, not the whole convention.
    const ok = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody({ deploy_ref: 'svc.a_b-1' }) });
    assert.equal(ok.status, 201);
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// Shared secret.
// ────────────────────────────────────────────────────────────────────

test('shared secret: 401 without header, 200 with; healthz/readyz exempt', async () => {
  const s = await start({ sharedSecret: 's3cr3t' });
  try {
    const noToken = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(noToken.status, 401);
    const wrongToken = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1', { headers: { 'x-ds-gate-token': 'nope' } });
    assert.equal(wrongToken.status, 401);
    const rightToken = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1', { headers: { 'x-ds-gate-token': 's3cr3t' } });
    assert.equal(rightToken.status, 404, 'authenticated through to the real 404 for an unknown deploy_ref');

    const health = await req(s.baseUrl, 'GET', '/healthz');
    assert.equal(health.status, 200, 'healthz exempt from the token check');
    const ready = await req(s.baseUrl, 'GET', '/readyz');
    assert.equal(ready.status, 200, 'readyz exempt from the token check');
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// Tick idempotency over HTTP.
// ────────────────────────────────────────────────────────────────────

test('tick idempotency over HTTP: two identical POSTs -> identical bodies, second replayed:true', async () => {
  const s = await start();
  try {
    const begin = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;
    const tickBody = { emitted_at_ts: NOW, metrics: BASELINE };

    const first = await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, { body: tickBody });
    const second = await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, { body: tickBody });

    assert.equal(first.json.replayed, false);
    assert.equal(second.json.replayed, true);
    const { replayed: r1, ...firstRest } = first.json;
    const { replayed: r2, ...secondRest } = second.json;
    assert.deepEqual(firstRest, secondRest);
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// GET verdict spec shape.
// ────────────────────────────────────────────────────────────────────

test('GET /v1/verdict/{deploy_ref} returns exactly the seven spec keys', async () => {
  const s = await start();
  try {
    await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const r = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), [
      'alpha_consumed', 'config_version', 'fires', 'tick', 'total_ticks', 'verdict', 'verdict_code',
    ]);
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// Verdict-code mapping.
// ────────────────────────────────────────────────────────────────────

test('verdict-code mapping: proceed/rollback/extend -> 0/1/-1', async () => {
  const clean = await start({ totalTicksDefault: 3 });
  try {
    const begin = await req(clean.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;
    let last;
    for (let i = 0; i < 3; i++) {
      last = await req(clean.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
        body: { emitted_at_ts: NOW + i * 30, metrics: BASELINE },
      });
    }
    assert.equal(last!.json.verdict, 'proceed');
    assert.equal(last!.json.verdict_code, 0);
  } finally { await stop(clean); }

  const bad = await start({ totalTicksDefault: 8 });
  try {
    const begin = await req(bad.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;
    let last;
    for (let i = 0; i < 4; i++) {
      const metrics = i >= 2 ? degradedMetrics() : BASELINE;
      last = await req(bad.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
        body: { emitted_at_ts: NOW + i * 30, metrics },
      });
    }
    assert.equal(last!.json.verdict, 'rollback');
    assert.equal(last!.json.verdict_code, 1);
  } finally { await stop(bad); }

  const voided = await start({ totalTicksDefault: 8 });
  try {
    const begin = await req(voided.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;
    voided.handle.runtime.sweepOnBoot(); // void the just-begun session
    const straggler = await req(voided.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
      body: { emitted_at_ts: NOW, metrics: BASELINE },
    });
    assert.equal(straggler.status, 409, 'HTTP layer pre-checks status before calling the runtime');
  } finally { await stop(voided); }
});

// ────────────────────────────────────────────────────────────────────
// Fail-policy on an evaluation throw.
// ────────────────────────────────────────────────────────────────────

test('fail_closed vs fail_open on an injected evaluation error: both 200, differing verdict_code', async () => {
  const closed = await start({ failPolicy: 'fail_closed' });
  try {
    const begin = await req(closed.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    closed.handle.runtime.setEvaluateFnForTest(() => { throw new Error('injected'); });
    const r = await req(closed.baseUrl, 'POST', `/v1/sessions/${begin.json.session_id}/ticks`, {
      body: { emitted_at_ts: NOW, metrics: BASELINE },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict_code, -1);
  } finally { await stop(closed); }

  const open = await start({ failPolicy: 'fail_open' });
  try {
    const begin = await req(open.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    open.handle.runtime.setEvaluateFnForTest(() => { throw new Error('injected'); });
    const r = await req(open.baseUrl, 'POST', `/v1/sessions/${begin.json.session_id}/ticks`, {
      body: { emitted_at_ts: NOW, metrics: BASELINE },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict_code, 0);
    assert.equal(r.json.degraded, true);
  } finally { await stop(open); }
});

// ────────────────────────────────────────────────────────────────────
// Shadow mode over HTTP.
// ────────────────────────────────────────────────────────────────────

test('shadow mode: GET verdict masks to proceed/0 with shadow_verdict_code; store history carries shadow:true', async () => {
  const s = await start({ mode: 'shadow', totalTicksDefault: 8 });
  try {
    const begin = await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const sessionId = begin.json.session_id;
    for (let i = 0; i < 4; i++) {
      const metrics = i >= 2 ? degradedMetrics() : BASELINE;
      await req(s.baseUrl, 'POST', `/v1/sessions/${sessionId}/ticks`, {
        body: { emitted_at_ts: NOW + i * 30, metrics },
      });
    }
    const verdict = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(verdict.json.verdict_code, 0);
    assert.equal(verdict.json.verdict, 'proceed');
    assert.equal(verdict.json.shadow_verdict_code, 1);

    const history = s.handle.store.readVerdictHistory(sessionId);
    assert.ok(history.every((e) => e.shadow === true));
    assert.ok(history.some((e) => e.verdict === 'rollback'));
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// m3 (final-review): GET /v1/verdict on a void session, at the HTTP
// layer — unlike POST .../ticks (which the router pre-checks and
// 409s), GET /v1/verdict has no "unknown status" rejection: it always
// answers 200 with a fail-policy-shaped body (runtime.verdictFor()).
// ────────────────────────────────────────────────────────────────────

test('GET /v1/verdict on a void session: fail_closed -> 200 verdict_code -1 + error; fail_open -> 200 verdict_code 0 + degraded', async () => {
  const closed = await start({ failPolicy: 'fail_closed' });
  try {
    await req(closed.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    closed.handle.runtime.sweepOnBoot(); // void the just-begun active session
    const r = await req(closed.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict_code, -1);
    assert.equal(r.json.verdict, 'extend');
    assert.match(r.json.error, /^session_void: service_restart$/);
    assert.equal(r.json.degraded, undefined);
  } finally { await stop(closed); }

  const open = await start({ failPolicy: 'fail_open' });
  try {
    await req(open.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    open.handle.runtime.sweepOnBoot();
    const r = await req(open.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(r.status, 200);
    assert.equal(r.json.verdict_code, 0);
    assert.equal(r.json.verdict, 'proceed');
    assert.equal(r.json.degraded, true);
    assert.equal(r.json.error, undefined);
  } finally { await stop(open); }
});

// ────────────────────────────────────────────────────────────────────
// Request timeout config plumbed.
// ────────────────────────────────────────────────────────────────────

test('server.requestTimeout reflects DS_GATE_REQUEST_TIMEOUT_MS', async () => {
  const s = await start({ requestTimeoutMs: 4000 });
  try {
    assert.equal(s.handle.server.requestTimeout, 4000);
  } finally { await stop(s); }
});

// ────────────────────────────────────────────────────────────────────
// Task 8 — Argo AnalysisTemplate YAML contract.
// ────────────────────────────────────────────────────────────────────

test('argo/analysis-template.yaml: jsonPath and conditions match the live GET /v1/verdict response', async () => {
  const templatePath = path.resolve(__dirname, '..', 'service', 'gate-http', 'argo', 'analysis-template.yaml');
  const doc = yaml.load(fs.readFileSync(templatePath, 'utf8')) as any;

  assert.equal(doc.kind, 'AnalysisTemplate');
  const metric = doc.spec.metrics[0];
  assert.equal(metric.provider.web.method, 'GET');
  assert.match(metric.provider.web.url, /\/v1\/verdict\/\{\{args\.deploy-ref\}\}$/);

  // jsonPath references a key actually present in a live response.
  const jsonPathMatch = String(metric.provider.web.jsonPath).match(/\{\$\.(\w+)\}/);
  assert.ok(jsonPathMatch, 'jsonPath is a {$.<key>} JSONPath expression');
  const referencedKey = jsonPathMatch![1];

  const s = await start();
  try {
    await req(s.baseUrl, 'POST', '/v1/sessions', { body: beginBody() });
    const verdict = await req(s.baseUrl, 'GET', '/v1/verdict/deploy-ref-1');
    assert.equal(verdict.status, 200);
    assert.ok(
      Object.prototype.hasOwnProperty.call(verdict.json, referencedKey),
      `jsonPath key "${referencedKey}" must be present on a live GET /v1/verdict response`,
    );

    // success/failure/inconclusive conditions reference codes the
    // service can actually emit (VERDICT_CODE: proceed=0, rollback=1,
    // extend=-1 — service/gate-http/_gate-session-runtime.ts).
    const emittableCodes = new Set([0, 1, -1]);
    for (const cond of [metric.successCondition, metric.failureCondition, metric.inconclusiveCondition]) {
      const codeMatch = String(cond).match(/result == (-?\d+)/);
      assert.ok(codeMatch, `condition "${cond}" is a "result == <code>" expression`);
      assert.ok(emittableCodes.has(Number(codeMatch![1])), `condition "${cond}" references an emittable verdict_code`);
    }
    // The three conditions are mutually exclusive and jointly cover the mapping.
    const codes = [metric.successCondition, metric.failureCondition, metric.inconclusiveCondition]
      .map((c) => Number(String(c).match(/result == (-?\d+)/)![1]));
    assert.deepEqual(new Set(codes), emittableCodes);
  } finally { await stop(s); }
});

// test/codedeploy-after-allow-traffic.test.ts — Plan C task 4: the CodeDeploy ECS blue/green
// AfterAllowTraffic hook and the twin-gate contract client, with fakes for the CodeDeploy
// client, the gate, the metric source and the clock. No AWS or gate call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PutLifecycleEventHookExecutionStatusCommand } from '@aws-sdk/client-codedeploy';

import { createAfterAllowTrafficHandler } from '../integrations/codedeploy/after-allow-traffic';
import type { AfterAllowTrafficDeps, CodeDeployLike, TwinGateLike } from '../integrations/codedeploy/after-allow-traffic';
import { TwinGateClient } from '../integrations/codedeploy/twin-gate-client';
import type { GateFetchLike } from '../integrations/codedeploy/twin-gate-client';
import type { MetricSource } from '../service/sources/metric-source';
import type {
  TwinArmBody, TwinEngineVerdict, TwinGateVerdict, TwinTickBody, TwinTickResponse,
} from '../service/sources/twin-contract';

const TWIN_ARM: TwinArmBody = {
  canary_weight: 0.5, alpha_rollback: 0.05, alpha_proceed: 0.05, alpha_srm: 0.001, max_ticks: 5,
  metrics: [{ id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.1 }],
};
const EVENT = { DeploymentId: 'd-ABC123', LifecycleEventHookExecutionId: 'hook-exec-1' };
const TICK_BODY: TwinTickBody = {
  canary_requests: 100, control_requests: 100,
  observations: { http_5xx: { canary_events: 1, canary_total: 100, control_events: 1, control_total: 100 } },
};
const ENGINE: Record<TwinGateVerdict, TwinEngineVerdict> = {
  rollback: 'rollback', proceed: 'proceed', extend: 'extend', hold: 'inconclusive', halt: 'invalid_experiment',
};

function response(verdict: TwinGateVerdict, tick: number, authority = 'advisory'): TwinTickResponse {
  return { verdict, engine_verdict: ENGINE[verdict], authority, tick, srm_e: 1, metrics: [] };
}

interface Harness {
  deps: AfterAllowTrafficDeps;
  puts: PutLifecycleEventHookExecutionStatusCommand[];
  windows: Array<[number, number, number]>; // [start, end, fetchedAt]
  opened: TwinArmBody[];
  ticks: TwinTickBody[];
  logs: Array<Record<string, unknown>>;
}

function harness(verdicts: TwinGateVerdict[], opts: Partial<AfterAllowTrafficDeps> & {
  authority?: string; openError?: Error; sourceErrorAt?: number;
} = {}): Harness {
  let now = 1_000_000_123; // not on a tick boundary
  const h: Harness = { deps: undefined as unknown as AfterAllowTrafficDeps, puts: [], windows: [], opened: [], ticks: [], logs: [] };
  const codedeploy: CodeDeployLike = {
    async send(cmd) { h.puts.push(cmd); return { $metadata: {}, lifecycleEventHookExecutionId: cmd.input.lifecycleEventHookExecutionId }; },
  };
  const gate: TwinGateLike = {
    async openSession(arm) {
      if (opts.openError) throw opts.openError;
      h.opened.push(arm);
      return { session_id: 'sess-1', mode: 'twin' };
    },
    async tick(sessionId, body) {
      assert.equal(sessionId, 'sess-1');
      h.ticks.push(body);
      const v = verdicts[h.ticks.length - 1] ?? 'extend';
      return response(v, h.ticks.length, opts.authority);
    },
  };
  const source: MetricSource = {
    async fetchTick(start, end) {
      if (opts.sourceErrorAt === h.windows.length) throw new Error('metrics backend down');
      h.windows.push([start, end, now]);
      return TICK_BODY;
    },
  };
  h.deps = {
    codedeploy, gate, source, twinArm: TWIN_ARM, tickMs: 60_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    log: (entry) => { h.logs.push(entry); },
    ...opts,
  };
  return h;
}

function putStatus(h: Harness): string | undefined {
  assert.equal(h.puts.length, 1, 'PutLifecycleEventHookExecutionStatus is called exactly once');
  assert.equal(h.puts[0].input.deploymentId, EVENT.DeploymentId);
  assert.equal(h.puts[0].input.lifecycleEventHookExecutionId, EVENT.LifecycleEventHookExecutionId);
  return h.puts[0].input.status;
}

for (const v of ['rollback', 'halt', 'hold', 'proceed'] as const) {
  test(`advisory (default): a ${v} verdict reports Succeeded and logs the verdict`, async () => {
    const h = harness([v]);
    const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
    assert.equal(putStatus(h), 'Succeeded');
    assert.equal(out.verdict, v);
    assert.equal(out.status, 'Succeeded');
    const final = h.logs.find((l) => l.event === 'twin_gate_final');
    assert.equal(final?.verdict, v);
    assert.equal(final?.authority, 'advisory');
  });
}

test('opens a twin session with the configured twin arm', async () => {
  const h = harness(['proceed']);
  await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.deepEqual(h.opened, [TWIN_ARM]);
});

test('extend keeps ticking over contiguous tick-aligned windows, fetched after window end + settle', async () => {
  const h = harness(['extend', 'extend', 'rollback'], { settleMs: 90_000 });
  const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.equal(h.ticks.length, 3);
  assert.equal(out.ticks, 3);
  const [first] = h.windows;
  assert.equal(first[0] % 60_000, 0);
  assert.ok(first[0] >= 1_000_000_123, 'first window starts after the hook began');
  for (let i = 0; i < h.windows.length; i++) {
    const [s, e, at] = h.windows[i];
    assert.equal(e - s, 60_000);
    assert.ok(at >= e + 90_000, 'fetched no earlier than window end + settleMs');
    if (i > 0) assert.equal(s, h.windows[i - 1][1]);
  }
  assert.deepEqual(h.ticks[0], TICK_BODY);
});

test('max_ticks reached while the gate says extend ends as hold, Succeeded under advisory', async () => {
  const h = harness([]);
  const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.equal(h.ticks.length, TWIN_ARM.max_ticks);
  assert.equal(out.verdict, 'hold');
  assert.equal(putStatus(h), 'Succeeded');
});

test('the Lambda deadline stops ticking early (hold) and still reports', async () => {
  const h = harness([], { settleMs: 0 });
  let remaining = 200_000;
  const out = await createAfterAllowTrafficHandler(h.deps)(EVENT, {
    getRemainingTimeInMillis: () => { remaining -= 60_000; return remaining; },
  });
  assert.ok(h.ticks.length < TWIN_ARM.max_ticks);
  assert.equal(out.verdict, 'hold');
  assert.equal(putStatus(h), 'Succeeded');
});

test('a gate error reports Succeeded under advisory, with the error logged', async () => {
  const h = harness([], { openError: new Error('ECONNREFUSED') });
  const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.equal(out.verdict, 'error');
  assert.equal(putStatus(h), 'Succeeded');
  assert.match(String(h.logs.find((l) => l.event === 'twin_gate_error')?.error), /ECONNREFUSED/);
});

test('a metric-source error mid-run reports Succeeded under advisory', async () => {
  const h = harness(['extend', 'extend'], { sourceErrorAt: 1 });
  const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.equal(out.verdict, 'error');
  assert.equal(putStatus(h), 'Succeeded');
});

test('enforce: true while the gate answers authority "advisory" still reports Succeeded', async () => {
  for (const v of ['rollback', 'halt', 'hold'] as const) {
    const h = harness([v], { enforce: true });
    const out = await createAfterAllowTrafficHandler(h.deps)(EVENT);
    assert.equal(putStatus(h), 'Succeeded', v);
    assert.match(out.reason, /advisory/);
  }
});

test('enforce: true with a non-advisory authority maps rollback/halt/hold to Failed and proceed to Succeeded', async () => {
  const expected: Record<string, string> = { rollback: 'Failed', halt: 'Failed', hold: 'Failed', proceed: 'Succeeded' };
  for (const [v, status] of Object.entries(expected)) {
    const h = harness([v as TwinGateVerdict], { enforce: true, authority: 'enforcing' });
    await createAfterAllowTrafficHandler(h.deps)(EVENT);
    assert.equal(putStatus(h), status, v);
  }
});

test('enforce: true with an error before any gate response reports Succeeded (authority never seen)', async () => {
  const h = harness([], { enforce: true, openError: new Error('down') });
  await createAfterAllowTrafficHandler(h.deps)(EVENT);
  assert.equal(putStatus(h), 'Succeeded');
});

test('a failing PutLifecycleEventHookExecutionStatus call propagates (CodeDeploy then times the hook out)', async () => {
  const h = harness(['proceed']);
  h.deps.codedeploy = { async send() { throw new Error('AccessDenied'); } };
  await assert.rejects(() => createAfterAllowTrafficHandler(h.deps)(EVENT), /AccessDenied/);
});

test('refuses a non-positive tickMs at construction', () => {
  const h = harness([]);
  assert.throws(() => createAfterAllowTrafficHandler({ ...h.deps, tickMs: 0 }), /tickMs/);
});

// ── TwinGateClient ────────────────────────────────────────────────────────────

function recordingFetch(status: number, json: unknown): { fetch: GateFetchLike; calls: Array<{ url: string; init: Parameters<GateFetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<GateFetchLike>[1] }> = [];
  const fetch: GateFetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetch, calls };
}

test('TwinGateClient.openSession POSTs {mode:"twin", twin_arm} to /v1/sessions with the gate token and expects 201', async () => {
  const { fetch, calls } = recordingFetch(201, { session_id: 's-9', mode: 'twin' });
  const c = new TwinGateClient({ baseUrl: 'http://gate:8080/', fetch, token: 'sekrit' });
  assert.deepEqual(await c.openSession(TWIN_ARM), { session_id: 's-9', mode: 'twin' });
  assert.equal(calls[0].url, 'http://gate:8080/v1/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-ds-gate-token'], 'sekrit');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mode: 'twin', twin_arm: TWIN_ARM });
});

test('TwinGateClient.tick POSTs the tick body to /v1/sessions/{id}/ticks (id encoded) and expects 200', async () => {
  const { fetch, calls } = recordingFetch(200, response('extend', 1));
  const c = new TwinGateClient({ baseUrl: 'http://gate:8080', fetch });
  const r = await c.tick('a/b', TICK_BODY);
  assert.equal(r.verdict, 'extend');
  assert.equal(calls[0].url, 'http://gate:8080/v1/sessions/a%2Fb/ticks');
  assert.equal('x-ds-gate-token' in calls[0].init.headers, false);
  assert.deepEqual(JSON.parse(calls[0].init.body), TICK_BODY);
});

test('TwinGateClient refuses a tick body the engine would refuse, before sending it', async () => {
  const { fetch, calls } = recordingFetch(200, {});
  const c = new TwinGateClient({ baseUrl: 'http://gate:8080', fetch });
  await assert.rejects(() => c.tick('s', { ...TICK_BODY, canary_requests: 1.5 }), /canary_requests/);
  assert.equal(calls.length, 0);
});

test('TwinGateClient throws on an unexpected status with the gate error text', async () => {
  const { fetch } = recordingFetch(400, { error: 'twin_arm.metrics required' });
  const c = new TwinGateClient({ baseUrl: 'http://gate:8080', fetch });
  await assert.rejects(() => c.openSession(TWIN_ARM), /400.*twin_arm\.metrics required/);
  const ok200 = recordingFetch(200, { session_id: 'x', mode: 'twin' });
  await assert.rejects(() => new TwinGateClient({ baseUrl: 'http://g', fetch: ok200.fetch }).openSession(TWIN_ARM), /200/);
});

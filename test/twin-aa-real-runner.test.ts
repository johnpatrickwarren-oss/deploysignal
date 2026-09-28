// studies/twin-aa-real (PREREGISTRATION.md §§3, 7): the T3 runner, against injected fake
// CloudWatch and gate clients and a fake clock. No test here makes a network call: the CloudWatch
// client is a stub object, the gate is a stub fetch, and time only moves when the runner sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const STUDY = path.join(__dirname, '..', 'studies', 'twin-aa-real');
const RUNNER = path.join(STUDY, 'harness', 'run-real.mjs');
const load = (): Promise<any> => import(RUNNER);

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0); // a minute boundary

const CFG = {
  study_id: '2026-10-twin-aa-real',
  lane: 0,
  region: 'eu-west-1',
  load_balancer: 'app/t3-alb/50dc6c495c0c9188',
  target_groups: { canary: 'targetgroup/t3-canary-new/aaaa1111', control: 'targetgroup/t3-baseline-old/bbbb2222' },
  tasks_per_arm: 4,
  gate: { base_url: 'http://127.0.0.1:8790', token_env: 'DS_GATE_SHARED_SECRET' },
};

interface Tick { rc: [number, number]; e5: [number, number]; p99: [number[], number[]] }
const DEFAULT_TICK: Tick = { rc: [1200, 1190], e5: [6, 5], p99: [[0.41], [0.40]] };

/** A CloudWatchLike whose answer depends on the window; `fail(windowStartMs)` throws for that window. */
function fakeCloudWatch(opts: { tick?: (ws: number) => Tick; fail?: (ws: number) => boolean; failName?: string; status?: (ws: number) => string | undefined; healthFail?: boolean } = {}) {
  const sent: any[] = [];
  const client = {
    async send(cmd: any): Promise<any> {
      sent.push(cmd);
      const input = cmd.input;
      const ws = input.StartTime.getTime();
      const ids: string[] = input.MetricDataQueries.map((q: any) => q.Id);
      if (ids.some((id) => id.startsWith('hh_'))) {
        if (opts.healthFail) throw new Error('health throttled');
        return { $metadata: {}, MetricDataResults: ids.map((Id) => ({ Id, StatusCode: 'Complete', Values: [Id.startsWith('hh_') ? 4 : 0] })) };
      }
      if (opts.fail?.(ws)) { const e = new Error(opts.failName ?? 'ThrottlingException: Rate exceeded'); e.name = opts.failName ?? 'ThrottlingException'; throw e; }
      const st = opts.status?.(ws);
      if (st) return { $metadata: {}, MetricDataResults: ids.map((Id) => ({ Id, StatusCode: st, Values: [] })) };
      const t = (opts.tick ?? (() => DEFAULT_TICK))(ws);
      const v: Record<string, number[]> = {
        rc_canary: [t.rc[0]], rc_control: [t.rc[1]], e5_canary: [t.e5[0]], e5_control: [t.e5[1]],
        p99_canary: t.p99[0], p99_control: t.p99[1],
      };
      return { $metadata: {}, MetricDataResults: ids.map((Id) => ({ Id, StatusCode: 'Complete', Values: v[Id] ?? [] })) };
    },
  };
  return { client, sent };
}

/** A gate fetch stub. `verdict(ref, tick)` picks the response verdict; `status` can force an HTTP code. */
function fakeGate(opts: {
  verdict?: (ref: string, tick: number) => string;
  authority?: string;
  tickStatus?: (ref: string, tick: number) => number;
  createStatus?: number;
} = {}) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const ticks = new Map<string, number>();
  const maxTicks = new Map<string, number>();
  const fetch = async (url: string, init: any): Promise<any> => {
    const json = (status: number, j: unknown) => ({ ok: status < 300, status, json: async () => j });
    if (url.endsWith('/healthz')) { calls.push({ url, body: null, headers: init?.headers ?? {} }); return json(200, { ok: true, service_id: 'svc', mode: 'enforce' }); }
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith('/v1/sessions')) {
      maxTicks.set(body.deploy_ref, body.twin_arm.max_ticks);
      return json(opts.createStatus ?? 201, { session_id: `sid-${body.deploy_ref}`, mode: 'twin' });
    }
    const ref = decodeURIComponent(url.split('/v1/sessions/')[1].split('/')[0]).replace(/^sid-/, '');
    const n = (ticks.get(ref) ?? 0) + 1;
    ticks.set(ref, n);
    const st = opts.tickStatus?.(ref, n) ?? 200;
    if (st !== 200) return json(st, { error: 'boom' });
    let verdict = opts.verdict?.(ref, n) ?? 'extend';
    if (verdict === 'extend' && n >= (maxTicks.get(ref) ?? Infinity)) verdict = 'hold';
    return json(200, {
      verdict, engine_verdict: verdict === 'hold' ? 'inconclusive' : verdict, authority: opts.authority ?? 'advisory',
      tick: n, srm_e: 1, metrics: [{ id: 'http_5xx', rollback_e: 1, rollback_threshold: 40, proceed_e: 1, proceed_threshold: 1e12, used: n, skipped: 0, ties: 0, missing: 0 }],
    });
  };
  return { fetch, calls, ticks };
}

function fakeClock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}

async function run(extra: Record<string, unknown> = {}, cw = fakeCloudWatch(), gate = fakeGate(), clock = fakeClock(T0 + 12_345)) {
  const { runOne } = await load();
  const record = await runOne({ cfg: CFG, cell: 'AA', run: 7, armReadyMs: T0, cloudwatch: cw.client, fetch: gate.fetch, now: clock.now, sleep: clock.sleep, log: () => {}, env: { DS_GATE_SHARED_SECRET: 's3cret' }, ...extra });
  return { record, cw, gate, clock };
}

test('registered constants: tick 60 s, settle 180 s, W 15, T 60, and the twin_arm of §3.3', async () => {
  const { REGISTERED, twinArm } = await load();
  assert.equal(REGISTERED.tickMs, 60_000);
  assert.equal(REGISTERED.settleMs, 180_000);
  assert.equal(REGISTERED.warmupTicks, 15);
  assert.equal(REGISTERED.scoredTicks, 60);
  assert.equal(REGISTERED.fetchAttempts, 3);
  assert.equal(REGISTERED.fetchRetryMs, 20_000);
  assert.equal(REGISTERED.stallBoundMs, 300_000);
  assert.deepEqual(twinArm(60), {
    canary_weight: 0.5, alpha_rollback: 0.05, alpha_proceed: 1e-12, alpha_srm: 0.001, max_ticks: 60,
    metrics: [
      { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 },
      { id: 'p99_latency', kind: 'sign', worse: 'higher', tolerance: 0.15 },
    ],
  });
  assert.equal('allow_unequal_rate_split' in twinArm(60), false);
});

test('validateConfig: the example config is refused on its placeholders; a filled one passes', async () => {
  const { validateConfig } = await load();
  const example = JSON.parse(fs.readFileSync(path.join(STUDY, 'config.example.json'), 'utf8'));
  assert.throws(() => validateConfig(example), /placeholder/);
  assert.doesNotThrow(() => validateConfig(CFG));
  assert.throws(() => validateConfig({ ...CFG, target_groups: { canary: 'tg-1', control: CFG.target_groups.control } }), /target_groups\.canary/);
  assert.throws(() => validateConfig({ ...CFG, target_groups: { canary: CFG.target_groups.control, control: CFG.target_groups.control } }), /differ/);
  assert.throws(() => validateConfig({ ...CFG, load_balancer: 'arn:aws:elasticloadbalancing:x' }), /load_balancer/);
  assert.throws(() => validateConfig({ ...CFG, tasks_per_arm: 1 }), /tasks_per_arm/);
  assert.throws(() => validateConfig({ ...CFG, lane: 4 }), /lane/);
  assert.throws(() => validateConfig({ ...CFG, study_id: 'other' }), /study_id/);
});

test('the example config holds placeholders only: no ARN, account id or real dimension value', async () => {
  const raw = fs.readFileSync(path.join(STUDY, 'config.example.json'), 'utf8');
  assert.doesNotMatch(raw, /arn:aws/);
  assert.doesNotMatch(raw, /\d{12}/);
  const cfg = JSON.parse(raw);
  for (const v of [cfg.region, cfg.load_balancer, cfg.target_groups.canary, cfg.target_groups.control]) assert.match(v, /REPLACE_ME/);
});

test('firstWindowStart rounds up to the next UTC minute and keeps an exact boundary', async () => {
  const { firstWindowStart } = await load();
  assert.equal(firstWindowStart(T0), T0);
  assert.equal(firstWindowStart(T0 + 1), T0 + 60_000);
  assert.equal(firstWindowStart(T0 + 59_999), T0 + 60_000);
});

test('an A/A run: two sessions, W0 fed 75 windows, scored fed windows 15..74, each fetched 180 s after it closes', async () => {
  const { record, cw, gate, clock } = await run();
  assert.deepEqual(record.gate_healthz, { ok: true, service_id: 'svc', mode: 'enforce' });
  assert.equal(record.arm_ready_ms, T0);
  const creates = gate.calls.filter((c) => c.url.endsWith('/v1/sessions'));
  assert.deepEqual(creates.map((c) => c.body.deploy_ref), ['t3-AA-l0-r7', 't3-AA-l0-r7-w0']);
  assert.deepEqual(creates.map((c) => c.body.twin_arm.max_ticks), [60, 75]);
  assert.ok(creates.every((c) => c.body.mode === 'twin'));
  assert.equal(creates[0].headers['x-ds-gate-token'], 's3cret');
  assert.ok(gate.calls[0].url.endsWith('/healthz'), 'the gate /healthz body is read first (Amendment 1 (i))');
  assert.equal(gate.ticks.get('t3-AA-l0-r7-w0'), 75);
  assert.equal(gate.ticks.get('t3-AA-l0-r7'), 60);

  const start = T0 + 60_000;
  assert.equal(record.first_window_start_ms, start);
  assert.equal(record.windows.length, 75);
  const scoredTicks = gate.calls.filter((c) => c.url.includes('/sid-t3-AA-l0-r7/ticks'));
  assert.equal(scoredTicks[0].body.emitted_at_ts, (start + 16 * 60_000) / 1000, 'first scored tick is window 15, keyed by its end');
  assert.deepEqual(scoredTicks[0].body.observations.http_5xx, { canary_events: 6, canary_total: 1200, control_events: 5, control_total: 1190 });
  assert.deepEqual(scoredTicks[0].body.observations.p99_latency, { canary: 0.41, control: 0.40 });

  const tickCmds = cw.sent.filter((c: any) => c.input.MetricDataQueries.some((q: any) => q.Id === 'rc_canary'));
  assert.equal(tickCmds.length, 75);
  assert.equal(tickCmds[0].input.StartTime.getTime(), start);
  assert.equal(tickCmds[0].input.EndTime.getTime(), start + 60_000);
  const q = Object.fromEntries(tickCmds[0].input.MetricDataQueries.map((m: any) => [m.Id, m.MetricStat]));
  assert.equal(q.rc_canary.Period, 60);
  assert.deepEqual(q.rc_canary.Metric.Dimensions, [
    { Name: 'TargetGroup', Value: CFG.target_groups.canary }, { Name: 'LoadBalancer', Value: CFG.load_balancer },
  ]);
  assert.equal(clock.sleeps[0], start + 60_000 + 180_000 - (T0 + 12_345), 'first fetch waits for window end + settle');
  assert.ok(record.windows.every((w: any) => w.lag_ms === 0));

  assert.equal(record.scored.verdict, 'hold');
  assert.equal(record.scored.ticks, 60);
  assert.equal(record.w0.verdict, 'hold');
  assert.equal(record.complete, true);
  const { voidReasons } = await load();
  assert.deepEqual(voidReasons(record), []);
});

test('health metrics are fetched per window (HealthyHostCount Minimum, UnHealthyHostCount Maximum) and a health failure is not fatal', async () => {
  const { record, cw } = await run();
  const hcmd = cw.sent.find((c: any) => c.input.MetricDataQueries.some((q: any) => q.Id === 'hh_canary'));
  const q = Object.fromEntries(hcmd.input.MetricDataQueries.map((m: any) => [m.Id, m.MetricStat]));
  assert.equal(q.hh_canary.Metric.MetricName, 'HealthyHostCount');
  assert.equal(q.hh_canary.Stat, 'Minimum');
  assert.equal(q.uh_control.Metric.MetricName, 'UnHealthyHostCount');
  assert.equal(q.uh_control.Stat, 'Maximum');
  assert.deepEqual(record.windows[0].health, { healthy_min: { canary: 4, control: 4 }, unhealthy_max: { canary: 0, control: 0 } });

  const failing = await run({}, fakeCloudWatch({ healthFail: true }));
  assert.equal(failing.record.complete, true);
  assert.match(failing.record.windows[0].health.error, /health throttled/);
  const { voidReasons } = await load();
  assert.deepEqual(voidReasons(failing.record), []);
});

test('after a scored rollback the scored session gets no more ticks, the W0 session runs on, and the run is not void', async () => {
  const gate = fakeGate({ verdict: (ref, n) => (ref === 't3-AA-l0-r7' && n === 20 ? 'rollback' : 'extend') });
  const { record } = await run({}, fakeCloudWatch(), gate);
  assert.equal(gate.ticks.get('t3-AA-l0-r7'), 20);
  assert.equal(gate.ticks.get('t3-AA-l0-r7-w0'), 75);
  assert.equal(record.scored.verdict, 'rollback');
  assert.equal(record.scored.ticks, 20);
  const { voidReasons } = await load();
  assert.deepEqual(voidReasons(record), []);
});

test('a gate response with an authority other than advisory stops the run under a distinct authority flag (Amendment 1 (f))', async () => {
  const gate = fakeGate({ authority: 'enforce' });
  const { record } = await run({}, fakeCloudWatch(), gate);
  assert.deepEqual(record.authority, { violation: true, stated: 'enforce', window: 0 });
  assert.equal(record.runner_error, undefined);
  assert.equal(record.complete, false);
  assert.equal(gate.ticks.get('t3-AA-l0-r7-w0'), 1, 'stops at the first such response');
  const { voidReasons } = await load();
  const reasons = voidReasons(record);
  assert.match(reasons[0], /^AUTHORITY .*enforce.*NOT EXECUTABLE/);
  assert.ok(!reasons.some((r: string) => /^V5/.test(r)));
});

test('a window whose fetch fails 3 times, 20 s apart, ends the run void under V3', async () => {
  const bad = T0 + 60_000 + 30 * 60_000; // window 30
  const cw = fakeCloudWatch({ fail: (ws) => ws === bad });
  const clock = fakeClock(T0 + 12_345);
  const { record } = await run({}, cw, fakeGate(), clock);
  const tries = cw.sent.filter((c: any) => c.input.StartTime.getTime() === bad && c.input.MetricDataQueries.some((q: any) => q.Id === 'rc_canary'));
  assert.equal(tries.length, 3);
  assert.equal(record.windows.length, 31);
  assert.equal(record.windows[30].fetch_failed, true);
  assert.equal(record.windows[30].attempts.length, 3);
  assert.ok(clock.sleeps.filter((s) => s === 20_000).length >= 2);
  assert.equal(record.complete, false);
  const { voidReasons } = await load();
  assert.ok(voidReasons(record).some((r: string) => /^V3/.test(r)));
});

test('a fetch that fails once and then succeeds is kept, with its attempts recorded', async () => {
  const bad = T0 + 60_000 + 3 * 60_000;
  let n = 0;
  const cw = fakeCloudWatch({ fail: (ws) => ws === bad && n++ === 0 });
  const { record } = await run({}, cw);
  assert.equal(record.windows[3].attempts.length, 2);
  assert.match(record.windows[3].attempts[0].error, /Throttling/);
  assert.equal(record.complete, true);
});

test('a non-2xx gate tick response ends the run void under V5', async () => {
  const gate = fakeGate({ tickStatus: (ref, n) => (ref === 't3-AA-l0-r7-w0' && n === 5 ? 500 : 200) });
  const { record } = await run({}, fakeCloudWatch(), gate);
  assert.match(record.gate_error, /HTTP 500/);
  assert.equal(record.complete, false);
  const { voidReasons } = await load();
  assert.ok(voidReasons(record).some((r: string) => /^V5 .*HTTP 500/.test(r)));
});

test('the window in flight when a gate error stops the run is still handed to onWindow', async () => {
  const seen: number[] = [];
  const gate = fakeGate({ tickStatus: (ref, n) => (ref === 't3-AA-l0-r7-w0' && n === 5 ? 500 : 200) });
  await run({ onWindow: (w: any) => seen.push(w.k) }, fakeCloudWatch(), gate);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test('a session create that is not 201 (e.g. an active session with the same deploy_ref) is a gate error', async () => {
  const { record } = await run({}, fakeCloudWatch(), fakeGate({ createStatus: 200 }));
  assert.match(record.gate_error, /HTTP 200/);
  assert.equal(record.windows.length, 0);
});

test('V1 metric gap: a scored tick with zero requests in an arm or no p99 voids the run; the same gap in warm-up does not', async () => {
  const { voidReasons } = await load();
  const start = T0 + 60_000;
  const gapAt = (k: number, t: Tick) => fakeCloudWatch({ tick: (ws) => ((ws - start) / 60_000 === k ? t : DEFAULT_TICK) });
  const zero = await run({}, gapAt(40, { ...DEFAULT_TICK, rc: [0, 1190], e5: [0, 5] }));
  assert.ok(voidReasons(zero.record).some((r: string) => /^V1 .*window 40/.test(r)));
  const noP99 = await run({}, gapAt(40, { ...DEFAULT_TICK, p99: [[], [0.4]] }));
  assert.ok(voidReasons(noP99.record).some((r: string) => /^V1 .*window 40.*p99_latency/.test(r)));
  const warm = await run({}, gapAt(3, { ...DEFAULT_TICK, p99: [[], [0.4]] }));
  assert.deepEqual(voidReasons(warm.record), []);
});

test('V2: a scored sample-ratio halt voids the run', async () => {
  const gate = fakeGate({ verdict: (ref, n) => (ref === 't3-AA-l0-r7' && n === 9 ? 'halt' : 'extend') });
  const { record } = await run({}, fakeCloudWatch(), gate);
  assert.equal(record.scored.verdict, 'halt');
  const { voidReasons } = await load();
  assert.ok(voidReasons(record).some((r: string) => /^V2/.test(r)));
});

test('V4 traffic floor: fewer than 500 requests in an arm on a scored tick, or under 2 5xx per scored tick on average', async () => {
  const { voidReasons } = await load();
  const start = T0 + 60_000;
  const low = await run({}, fakeCloudWatch({ tick: (ws) => ((ws - start) / 60_000 === 50 ? { ...DEFAULT_TICK, rc: [1200, 499] } : DEFAULT_TICK) }));
  assert.ok(voidReasons(low.record).some((r: string) => /^V4 .*window 50/.test(r)));
  const exactly = await run({}, fakeCloudWatch({ tick: (ws) => ((ws - start) / 60_000 === 50 ? { ...DEFAULT_TICK, rc: [500, 500] } : DEFAULT_TICK) }));
  assert.deepEqual(voidReasons(exactly.record), []);
  const quiet = await run({}, fakeCloudWatch({ tick: () => ({ ...DEFAULT_TICK, e5: [1, 0] }) }));
  assert.ok(voidReasons(quiet.record).some((r: string) => /^V4 .*5xx/.test(r)));
  const two = await run({}, fakeCloudWatch({ tick: () => ({ ...DEFAULT_TICK, e5: [1, 1] }) }));
  assert.deepEqual(voidReasons(two.record), []);
});

test('V5 stall: a window fetched more than 300 s after window end + settle voids the run', async () => {
  const { voidReasons } = await load();
  const clock = fakeClock(T0 + 12_345);
  let calls = 0;
  const cw = fakeCloudWatch();
  const send = cw.client.send;
  cw.client.send = async (cmd: any) => {
    if (cmd.input.MetricDataQueries.some((q: any) => q.Id === 'rc_canary') && ++calls === 10) clock.advance(301_000);
    return send(cmd);
  };
  const { record } = await run({}, cw, fakeGate(), clock);
  assert.ok(record.windows.some((w: any) => w.lag_ms > 300_000));
  assert.ok(voidReasons(record).some((r: string) => /^V5 .*stall/.test(r)));
});

test('onWindow receives each window once, with the raw GetMetricData response beside the transformed body (Amendment 1 (h))', async () => {
  const seen: any[] = [];
  const { record } = await run({ onWindow: (w: any) => seen.push(w) });
  assert.equal(seen.length, 75);
  assert.deepEqual(seen.map((w) => w.k), Array.from({ length: 75 }, (_, i) => i));
  const raw = seen[0].raw;
  assert.equal(raw.length, 1);
  const byId = Object.fromEntries(raw[0].MetricDataResults.map((r: any) => [r.Id, r.Values]));
  assert.deepEqual(byId.rc_canary, [1200]);
  assert.deepEqual(byId.p99_control, [0.40]);
  assert.equal(seen[0].body.canary_requests, 1200);
  assert.equal(record.windows.length, 75);
});

test('the run log carries progress only: no verdict, e-value or session response reaches stdout (Amendment 1 (h))', async () => {
  const logs: any[] = [];
  const gate = fakeGate({ verdict: (ref, n) => (ref === 't3-AA-l0-r7' && n === 20 ? 'rollback' : 'extend') });
  await run({ log: (e: any) => logs.push(e) }, fakeCloudWatch(), gate);
  assert.ok(logs.length >= 75);
  const text = JSON.stringify(logs);
  assert.doesNotMatch(text, /rollback|extend|hold|halt|proceed|verdict|_e"/);
  assert.deepEqual(Object.keys(logs[logs.length - 1]).sort(), ['event', 'of', 'ref', 'window']);
});

test('arm-ready is bounded: more than 300 s before the runner starts, or more than 60 s after, is refused (Amendment 1 (g)1)', async () => {
  const { runOne } = await load();
  const clock = fakeClock(T0 + 1_000_000);
  const base = { cfg: CFG, cell: 'AA', run: 1, cloudwatch: fakeCloudWatch().client, fetch: fakeGate().fetch, now: clock.now, sleep: clock.sleep };
  await assert.rejects(runOne({ ...base, armReadyMs: T0 + 1_000_000 - 300_001 }), /arm-ready/);
  await assert.rejects(runOne({ ...base, armReadyMs: T0 + 1_000_000 + 60_001 }), /arm-ready/);
  await assert.rejects(runOne({ ...base, armReadyMs: undefined }), /arm-ready/);
  const ok = await runOne({ ...base, armReadyMs: T0 + 1_000_000 - 300_000 });
  assert.equal(ok.complete, true);
});

test('V3 (Amendment 1 (e)): an authorization error voids the window at once, without retry', async () => {
  const { voidReasons } = await load();
  const bad = T0 + 60_000 + 5 * 60_000;
  for (const failName of ['AccessDeniedException', 'ExpiredTokenException', 'UnrecognizedClientException']) {
    const cw = fakeCloudWatch({ fail: (ws) => ws === bad, failName });
    const { record } = await run({}, cw);
    assert.equal(record.windows[5].attempts.length, 1, failName);
    assert.equal(record.windows[5].fetch_failed, true);
    assert.ok(voidReasons(record).some((r: string) => /^V3 .*authorization/.test(r)), failName);
  }
  const forbidden = await run({}, fakeCloudWatch({ status: (ws) => (ws === bad ? 'Forbidden' : undefined) }));
  assert.equal(forbidden.record.windows[5].attempts.length, 1);
  assert.ok(voidReasons(forbidden.record).some((r: string) => /^V3 .*authorization/.test(r)));
});

test('V3 (Amendment 1 (e)): a query status InternalError is transient and retried; success on a retry is kept', async () => {
  const bad = T0 + 60_000 + 5 * 60_000;
  let n = 0;
  const { record } = await run({}, fakeCloudWatch({ status: (ws) => (ws === bad && n++ < 2 ? 'InternalError' : undefined) }));
  assert.equal(record.windows[5].attempts.length, 3);
  assert.equal(record.complete, true);
  const { voidReasons } = await load();
  assert.deepEqual(voidReasons(record), []);
});

test('countsForE2 (Amendment 1 (a)): executable rollbacks, void runs where either session rolled back, and every abort', async () => {
  const { countsForE2 } = await load();
  const s = (o: any) => ({ scored: { verdict: 'hold' }, w0: { verdict: 'hold' }, void_reasons: [], operator_abort: false, ...o });
  assert.equal(countsForE2(s({})), false);
  assert.equal(countsForE2(s({ scored: { verdict: 'rollback' } })), true);
  assert.equal(countsForE2(s({ w0: { verdict: 'rollback' } })), false, 'W0 alone counts only in a void run');
  assert.equal(countsForE2(s({ w0: { verdict: 'rollback' }, void_reasons: ['V1 x'] })), true);
  assert.equal(countsForE2(s({ scored: { verdict: 'rollback' }, void_reasons: ['V4 x'] })), true);
  assert.equal(countsForE2(s({ operator_abort: true, void_reasons: ['V5 aborted by operator'] })), true);
});

test('summaryOf keeps the run-level fields and void reasons and drops the per-window lines', async () => {
  const { summaryOf } = await load();
  const { record } = await run();
  const sum = summaryOf(record, { repo_sha: 'abc' });
  assert.equal(sum.windows, undefined);
  assert.equal(sum.window_count, 75);
  assert.deepEqual(sum.void_reasons, []);
  assert.equal(sum.counts_for_e2, false);
  assert.deepEqual(sum.manifest, { repo_sha: 'abc' });
  assert.equal(sum.scored.verdict, 'hold');
});

test('disallowedDirt (Amendment 1 (i)): any modified tracked file blocks a run except the regenerated calibrate constants', async () => {
  const { disallowedDirt } = await load();
  assert.deepEqual(disallowedDirt(''), []);
  assert.deepEqual(disallowedDirt(' M tools/calibrate/_calibrate-constants.js\n'), []);
  assert.deepEqual(disallowedDirt(' M tools/calibrate/_calibrate-constants.js\n M studies/twin-aa-real/harness/run-real.mjs\n'),
    ['studies/twin-aa-real/harness/run-real.mjs']);
  assert.deepEqual(disallowedDirt('A  service/x.ts\n'), ['service/x.ts']);
});

test('claimOutputPaths: a .jsonl and a .summary.json per run, and a run index already recorded in ANY lane is refused', async () => {
  const { claimOutputPaths } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-t3-out-'));
  const p = claimOutputPaths(dir, 'AA', 0, 7, '20261005T120000Z');
  assert.equal(path.basename(p.jsonl), 'AA-l0-r7-20261005T120000Z.jsonl');
  assert.equal(path.basename(p.summary), 'AA-l0-r7-20261005T120000Z.summary.json');
  fs.writeFileSync(p.jsonl, '');
  assert.throws(() => claimOutputPaths(dir, 'AA', 0, 7, '20261005T130000Z'), /already recorded/);
  assert.throws(() => claimOutputPaths(dir, 'AA', 2, 7, '20261005T130000Z'), /already recorded/, 'global across lanes');
  assert.doesNotThrow(() => claimOutputPaths(dir, 'AA', 1, 17, '20261005T130000Z'));
  assert.doesNotThrow(() => claimOutputPaths(dir, 'AB-5xx', 0, 7, '20261005T130000Z'));
  assert.throws(() => claimOutputPaths(dir, 'AB-x', 0, 1, 'z'), /cell/);
});

test('appendOnlyWriter: files are created exclusively, the jsonl only grows, the summary is written once', async () => {
  const { claimOutputPaths, appendOnlyWriter } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-t3-out-'));
  const p = claimOutputPaths(dir, 'AA', 0, 3, 'Z');
  const w = appendOnlyWriter(p);
  w.line({ type: 'run', run: 3 });
  w.line({ type: 'window', k: 0 });
  const lines = fs.readFileSync(p.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ type: 'run', run: 3 }, { type: 'window', k: 0 }]);
  w.summary({ ok: 1 });
  assert.throws(() => w.summary({ ok: 2 }), /once/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.summary, 'utf8')), { ok: 1 });
  fs.writeFileSync(path.join(dir, 'AA-l0-r4-Z.jsonl'), 'x');
  assert.throws(() => appendOnlyWriter({ jsonl: path.join(dir, 'AA-l0-r4-Z.jsonl'), summary: path.join(dir, 'y.json') }), /EEXIST/);
});

test('the runner imports no AWS client other than CloudWatch (observe-only)', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const clients = [...src.matchAll(/@aws-sdk\/(client-[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(clients.length > 0);
  assert.deepEqual([...new Set(clients)], ['client-cloudwatch']);
  assert.doesNotMatch(src, /PutLifecycleEventHookExecutionStatus|ModifyRule|ModifyListener|StartExperiment|UpdateService/);
});

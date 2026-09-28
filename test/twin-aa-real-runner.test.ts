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
function fakeCloudWatch(opts: { tick?: (ws: number) => Tick; fail?: (ws: number) => boolean; healthFail?: boolean } = {}) {
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
      if (opts.fail?.(ws)) throw new Error('ThrottlingException');
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
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const json = (status: number, j: unknown) => ({ ok: status < 300, status, json: async () => j });
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
  const record = await runOne({ cfg: CFG, cell: 'AA', run: 7, cloudwatch: cw.client, fetch: gate.fetch, now: clock.now, sleep: clock.sleep, log: () => {}, env: { DS_GATE_SHARED_SECRET: 's3cret' }, ...extra });
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
  const creates = gate.calls.filter((c) => c.url.endsWith('/v1/sessions'));
  assert.deepEqual(creates.map((c) => c.body.deploy_ref), ['t3-AA-l0-r7', 't3-AA-l0-r7-w0']);
  assert.deepEqual(creates.map((c) => c.body.twin_arm.max_ticks), [60, 75]);
  assert.ok(creates.every((c) => c.body.mode === 'twin'));
  assert.equal(gate.calls[0].headers['x-ds-gate-token'], 's3cret');
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

test('a gate response with an authority other than advisory aborts the run (observe-only)', async () => {
  const gate = fakeGate({ authority: 'enforce' });
  const { record } = await run({}, fakeCloudWatch(), gate);
  assert.match(record.runner_error, /authority/);
  assert.equal(record.complete, false);
  assert.equal(gate.ticks.get('t3-AA-l0-r7-w0'), 1, 'stops at the first such response');
  const { voidReasons } = await load();
  assert.ok(voidReasons(record).some((r: string) => /^V5/.test(r)));
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

test('onProgress receives the record after each window, so an interrupted run leaves its ticks on disk', async () => {
  const seen: number[] = [];
  const { record } = await run({ onProgress: (r: any) => seen.push(r.windows.length) });
  assert.equal(seen.length, 76, 'once after the sessions open, then once per window');
  assert.equal(seen[0], 0);
  assert.equal(seen[75], 75);
  assert.equal(record.windows.length, 75);
});

test('outputPath refuses to overwrite a run already recorded for the same cell, lane and run index', async () => {
  const { claimOutputPath } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-t3-out-'));
  const p = claimOutputPath(dir, 'AA', 0, 7, '20261005T120000Z');
  assert.equal(path.basename(p), 'AA-l0-r7-20261005T120000Z.json');
  fs.writeFileSync(p, '{}');
  assert.throws(() => claimOutputPath(dir, 'AA', 0, 7, '20261005T130000Z'), /already recorded/);
  assert.doesNotThrow(() => claimOutputPath(dir, 'AA', 1, 7, '20261005T130000Z'));
  assert.throws(() => claimOutputPath(dir, 'AB-x', 0, 1, 'z'), /cell/);
});

test('the runner imports no AWS client other than CloudWatch (observe-only)', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const clients = [...src.matchAll(/@aws-sdk\/(client-[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(clients.length > 0);
  assert.deepEqual([...new Set(clients)], ['client-cloudwatch']);
  assert.doesNotMatch(src, /PutLifecycleEventHookExecutionStatus|ModifyRule|ModifyListener|StartExperiment|UpdateService/);
});

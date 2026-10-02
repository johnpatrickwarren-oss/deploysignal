// studies/twin-fault-shapes/harness/run-real.mjs — one run of the T3 real-service A/A
// 2026-10-twin-fault-shapes: the second study's runner (studies/twin-aa-real-2/harness/run-real.mjs) with the
// study id and the cell list changed (AB-lat30, AB-5xx-1.5, AB-reset); the margin, tasks_per_arm 4 and every
// other line are the second study's, which is itself the first study's runner (studies/twin-aa-real/harness/run-real.mjs) with the
// registered deltas only — study id, the p99 sign metric's margin { relative: 0.10 }, tasks_per_arm 4,
// AA cell only. Everything else is byte-identical; diff the two files to see.
// (PREREGISTRATION.md §§3, 7). Observe-only: it reads ALB metrics from CloudWatch through the
// existing twin source (service/sources/cloudwatch.ts) and posts ticks to the gate's twin HTTP API.
// It never calls CodeDeploy, ECS, ELBv2 or FIS, and aborts if the gate states an authority other
// than "advisory".
//
//   node studies/twin-fault-shapes/harness/run-real.mjs --config <cfg.json> --cell AA --run <k>
//       one run, started by the operator at arm-ready (OPERATOR.md). Writes
//       studies/twin-fault-shapes/results/runs/<cell>-l<lane>-r<k>-<UTC>.json and refuses a run index
//       already recorded for that cell and lane.
//   node studies/twin-fault-shapes/harness/run-real.mjs --config <cfg.json> --check-config
//       validates the config and exits; no AWS call, no gate call.
//
// Run from the repo root after `npm run build && npx tsc -p tsconfig.test.json` (the sources are
// compiled TypeScript). AWS credentials come from the default provider chain; nothing here
// configures them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The compiled source requires the CommonJS build of the SDK; commands and client come from the
// same build so a real CloudWatchClient accepts them.
const { GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { CloudWatchTwinSource } = require('../../../service/sources/cloudwatch.js');
const { assertTwinTickBody } = require('../../../service/sources/twin-contract.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDY = path.resolve(HERE, '..');
const REPO = path.resolve(STUDY, '..', '..');

/** PREREGISTRATION.md §§3–5, 7. Not configurable: a change is an amendment. */
export const REGISTERED = Object.freeze({
  studyId: '2026-10-twin-fault-shapes',
  tickMs: 60_000,
  settleMs: 180_000,
  warmupTicks: 15,
  scoredTicks: 60,
  fetchAttempts: 3,
  fetchRetryMs: 20_000,
  callTimeoutMs: 30_000,
  stallBoundMs: 300_000,
  armReadyMaxLagMs: 300_000,
  armReadyMaxLeadMs: 60_000,
  minArmRequests: 500,
  minMean5xxPerTick: 2,
  cells: Object.freeze(['AB-lat30', 'AB-5xx-1.5', 'AB-reset', 'AB-reset-nr']),
  lanes: 4,
});
export const RATE_ID = 'http_5xx';
export const SIGN_ID = 'p99_latency';
// Amendment 2 (2026-10-twin-fault-shapes): the fourth cell declares a third metric counting requests the
// target never answered: RequestCount − (target 2xx + 3xx + 4xx + 5xx), per arm.
export const NR_ID = 'no_response';
export const NR_CELL = 'AB-reset-nr';

export function twinArm(maxTicks, cell) {
  return {
    canary_weight: 0.5, alpha_rollback: 0.05, alpha_proceed: 1e-12, alpha_srm: 0.001, max_ticks: maxTicks,
    metrics: [
      { id: RATE_ID, kind: 'rate', worse: 'higher', tolerance: 0.2 },
      // 2026-10-twin-aa-real-2 §1.3: the margin (engine ADR 0037) — a tick is worse only beyond +10%
      { id: SIGN_ID, kind: 'sign', worse: 'higher', tolerance: 0.15, margin: { relative: 0.10 } },
      ...(cell === NR_CELL ? [{ id: NR_ID, kind: 'rate', worse: 'higher', tolerance: 0.2 }] : []),
    ],
  };
}

/** Amendment 2: the status-class sums the twin source does not fetch (2XX, 3XX, 4XX), per arm, for one window. */
function noResponseQueries(cfg, periodS) {
  const out = [];
  for (const arm of ['canary', 'control']) {
    const dims = [{ Name: 'TargetGroup', Value: cfg.target_groups[arm] }, { Name: 'LoadBalancer', Value: cfg.load_balancer }];
    for (const cls of ['2XX', '3XX', '4XX']) {
      out.push({ Id: `t${cls[0]}_${arm}`, ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: `HTTPCode_Target_${cls}_Count`, Dimensions: dims }, Period: periodS, Stat: 'Sum' } });
    }
  }
  return out;
}

/** events = RequestCount − (2xx + 3xx + 4xx + 5xx), clamped to [0, total]; RequestCount and the 5xx sum are the tick body's own. */
export function noResponseObservation(body, sums) {
  const arm = (a) => {
    const total = body[`${a}_requests`];
    const t5 = body.observations[RATE_ID][`${a}_events`];
    const answered = Math.round(sums[`t2_${a}`] + sums[`t3_${a}`] + sums[`t4_${a}`]) + t5;
    return { events: Math.min(total, Math.max(0, total - answered)), total };
  };
  const c = arm('canary'), k = arm('control');
  return { canary_events: c.events, canary_total: c.total, control_events: k.events, control_total: k.total };
}

/** One further GetMetricData for the window, with the registered retries; null observation = fetch failure (V3). */
export async function fetchNoResponse(cloudwatch, cfg, ws, we, body, now, sleep) {
  const record = { attempts: [] };
  for (let attempt = 1; attempt <= REGISTERED.fetchAttempts; attempt++) {
    try {
      const out = await bounded('no_response GetMetricData', REGISTERED.callTimeoutMs, (signal) => cloudwatch.send(
        new GetMetricDataCommand({ MetricDataQueries: noResponseQueries(cfg, REGISTERED.tickMs / 1000), StartTime: new Date(ws), EndTime: new Date(we) }),
        { abortSignal: signal }));
      const results = out.MetricDataResults ?? [];
      const sums = Object.fromEntries(results.map((r) => [r.Id, (r.Values ?? []).reduce((a, b) => a + b, 0)]));
      for (const id of ['t2_canary', 't3_canary', 't4_canary', 't2_control', 't3_control', 't4_control']) if (!(id in sums)) sums[id] = 0;
      record.attempts.push({ at_ms: now(), ok: true });
      record.raw = { MetricDataResults: results, NextToken: out.NextToken ?? null };
      record.sums = sums;
      return { record, observation: noResponseObservation(body, sums) };
    } catch (e) {
      const auth = isAuthError(e);
      record.attempts.push({ at_ms: now(), error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), auth });
      if (auth) { record.auth_failed = true; break; }
      if (attempt < REGISTERED.fetchAttempts) await sleep(REGISTERED.fetchRetryMs);
    }
  }
  return { record, observation: null };
}

const PLACEHOLDER = /REPLACE_ME|<[^>]*>/;

function placeholders(v, at, out) {
  if (typeof v === 'string' && PLACEHOLDER.test(v)) out.push(at);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) placeholders(x, `${at}.${k}`, out);
  return out;
}

/** Throws on a config the runner must not start with. Account-specific values only. */
export function validateConfig(cfg) {
  const ph = placeholders(cfg, 'config', []);
  if (ph.length) throw new Error(`config: ${ph.join(', ')} still a placeholder`);
  const need = (ok, msg) => { if (!ok) throw new Error(`config: ${msg}`); };
  need(cfg.study_id === REGISTERED.studyId, `study_id must be "${REGISTERED.studyId}"`);
  need(Number.isInteger(cfg.lane) && cfg.lane >= 0 && cfg.lane < REGISTERED.lanes, `lane must be an integer 0..${REGISTERED.lanes - 1}`);
  need(typeof cfg.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(cfg.region), 'region must be an AWS region name, e.g. eu-west-1');
  need(typeof cfg.load_balancer === 'string' && /^app\/[^/]+\/[0-9a-f]+$/.test(cfg.load_balancer),
    'load_balancer must be the LoadBalancer dimension value app/<name>/<id>');
  for (const arm of ['canary', 'control']) {
    const tg = cfg.target_groups?.[arm];
    need(typeof tg === 'string' && /^targetgroup\/[^/]+\/[0-9a-f]+$/.test(tg),
      `target_groups.${arm} must be the TargetGroup dimension value targetgroup/<name>/<id>`);
  }
  need(cfg.target_groups.canary !== cfg.target_groups.control, 'target_groups.canary and .control must differ');
  need(Number.isInteger(cfg.alb_idle_timeout_s) && cfg.alb_idle_timeout_s >= 1 && cfg.alb_idle_timeout_s <= 4000,
    'alb_idle_timeout_s must be the ALB idle timeout in whole seconds, 1..4000 (Amendment 2 (a))');
  need(cfg.tasks_per_arm === 4, 'tasks_per_arm must be 4 (2026-10-twin-aa-real-2 §1.2, R5 as amended)');
  need(typeof cfg.gate?.base_url === 'string' && /^https?:\/\//.test(cfg.gate.base_url), 'gate.base_url must be an http(s) URL');
  need(cfg.gate.token_env === undefined || cfg.gate.token_env === null || typeof cfg.gate.token_env === 'string',
    'gate.token_env must be an environment variable name or null');
}

/** Amendment 1 (g)1: the runner starts at most 300 s after arm-ready (and at most 60 s before it). */
export function checkArmReady(armReadyMs, nowMs) {
  if (!Number.isFinite(armReadyMs)) throw new Error('arm-ready time is required (Amendment 1 (g)1)');
  if (nowMs - armReadyMs > REGISTERED.armReadyMaxLagMs || armReadyMs - nowMs > REGISTERED.armReadyMaxLeadMs) {
    throw new Error(`arm-ready ${new Date(armReadyMs).toISOString()} is outside [start - 300 s, start + 60 s] (Amendment 1 (g)1)`);
  }
}

export function firstWindowStart(nowMs) {
  return Math.ceil(nowMs / REGISTERED.tickMs) * REGISTERED.tickMs;
}

/** Race `call` against `ms`, aborting its signal on timeout. */
async function bounded(label, ms, call) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(`${label}: timed out after ${ms} ms`); ac.abort(e); reject(e); }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => call(ac.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class GateError extends Error {}
class AuthorityError extends Error {
  constructor(stated, window) { super(`gate stated authority "${stated}"; this study is observe-only`); this.stated = stated; this.window = window; }
}

/** Amendment 1 (e): authorization failures void the window without retry. */
const AUTH_ERROR_NAMES = new Set([
  'AccessDeniedException', 'AccessDenied', 'UnrecognizedClientException', 'InvalidClientTokenId',
  'ExpiredTokenException', 'ExpiredToken',
]);
export function isAuthError(e) {
  return AUTH_ERROR_NAMES.has(e?.name) || /returned Forbidden/.test(e?.message ?? '');
}

function gateClient(baseUrl, fetchFn, token) {
  const base = baseUrl.replace(/\/+$/, '');
  async function post(p, body, expect) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-ds-gate-token'] = token;
    const res = await bounded(`gate ${p}`, REGISTERED.callTimeoutMs,
      (signal) => fetchFn(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body), signal }));
    const json = await res.json().catch(() => ({}));
    if (res.status !== expect) {
      throw new GateError(`gate ${p}: HTTP ${res.status} (expected ${expect})${json?.error ? `: ${json.error}` : ''}`);
    }
    return json;
  }
  return {
    healthz: async () => {
      const res = await bounded('gate /healthz', REGISTERED.callTimeoutMs,
        (signal) => fetchFn(`${base}/healthz`, { method: 'GET', headers: {}, signal }));
      return res.json().catch(() => null);
    },
    open: async (deployRef, arm) => (await post('/v1/sessions', { mode: 'twin', deploy_ref: deployRef, twin_arm: arm }, 201)).session_id,
    tick: (sessionId, body) => post(`/v1/sessions/${encodeURIComponent(sessionId)}/ticks`, body, 200),
  };
}

/** Per-window diagnostics: arm health (§3.1) and the stall-burst measurements of Amendment 2 (a). */
function diagnosticsQueries(cfg) {
  const out = [];
  const add = (id, name, stat, dims) => out.push({
    Id: id, ReturnData: true,
    MetricStat: { Metric: { Namespace: 'AWS/ApplicationELB', MetricName: name, Dimensions: dims }, Period: REGISTERED.tickMs / 1000, Stat: stat },
  });
  for (const arm of ['canary', 'control']) {
    const dims = [{ Name: 'TargetGroup', Value: cfg.target_groups[arm] }, { Name: 'LoadBalancer', Value: cfg.load_balancer }];
    add(`hh_${arm}`, 'HealthyHostCount', 'Minimum', dims);
    add(`uh_${arm}`, 'UnHealthyHostCount', 'Maximum', dims);
    add(`mx_${arm}`, 'TargetResponseTime', 'Maximum', dims);
    add(`pq_${arm}`, 'TargetResponseTime', 'p99', dims);
    add(`t5_${arm}`, 'HTTPCode_Target_5XX_Count', 'Sum', dims);
    add(`ce_${arm}`, 'TargetConnectionErrorCount', 'Sum', dims);
  }
  // ALB publishes ELB-generated 5xx per load balancer only; these include prod-old's traffic.
  const lb = [{ Name: 'LoadBalancer', Value: cfg.load_balancer }];
  add('elb5_lb', 'HTTPCode_ELB_5XX_Count', 'Sum', lb);
  add('elb504_lb', 'HTTPCode_ELB_504_Count', 'Sum', lb);
  return out;
}

/**
 * Report-only diagnostics for one window; an error is recorded, never fatal. Latency with no
 * datapoint is null; a count with no datapoint is 0 (ALB publishes no zero counts), and the raw
 * response is kept beside the transformed values.
 */
async function fetchDiagnostics(cloudwatch, cfg, ws, we) {
  try {
    const out = await bounded('diagnostics GetMetricData', REGISTERED.callTimeoutMs, (signal) => cloudwatch.send(
      new GetMetricDataCommand({ MetricDataQueries: diagnosticsQueries(cfg), StartTime: new Date(ws), EndTime: new Date(we) }),
      { abortSignal: signal }));
    const results = out.MetricDataResults ?? [];
    const v = Object.fromEntries(results.map((r) => [r.Id, r.Values ?? []]));
    const pick = (id, f) => (v[id]?.length ? f(...v[id]) : null);
    const sum = (id) => (v[id] ?? []).reduce((a, b) => a + b, 0);
    const arms = (f) => ({ canary: f('canary'), control: f('control') });
    return {
      health: {
        healthy_min: arms((a) => pick(`hh_${a}`, Math.min)),
        unhealthy_max: arms((a) => pick(`uh_${a}`, Math.max)),
      },
      stall: {
        max_latency_s: arms((a) => pick(`mx_${a}`, Math.max)),
        p99_latency_s: arms((a) => (v[`pq_${a}`]?.length === 1 ? v[`pq_${a}`][0] : null)),
        target_5xx: arms((a) => sum(`t5_${a}`)),
        connection_errors: arms((a) => sum(`ce_${a}`)),
        elb_5xx_lb: sum('elb5_lb'),
        elb_504_lb: sum('elb504_lb'),
      },
      raw: { MetricDataResults: results, NextToken: out.NextToken ?? null },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { health: { error }, stall: { error }, raw: null };
  }
}

/** Wraps the client to keep every raw GetMetricData response of one attempt. */
function recordingClient(cloudwatch, sink) {
  return {
    async send(cmd, opts) {
      const out = await cloudwatch.send(cmd, opts);
      sink.push({ MetricDataResults: out.MetricDataResults ?? [], NextToken: out.NextToken ?? null });
      return out;
    },
  };
}

async function fetchWindow(cloudwatch, cfg, ws, we, entry, now, sleep) {
  for (let attempt = 1; attempt <= REGISTERED.fetchAttempts; attempt++) {
    const raw = [];
    const source = new CloudWatchTwinSource({
      client: recordingClient(cloudwatch, raw), loadBalancer: cfg.load_balancer, targetGroups: cfg.target_groups,
      errorRateId: RATE_ID, latencyP99Id: SIGN_ID, canaryWeight: 0.5,
    });
    try {
      const body = await bounded('source fetchTick', REGISTERED.callTimeoutMs, (signal) => source.fetchTick(ws, we, signal));
      entry.attempts.push({ at_ms: now(), ok: true });
      entry.raw = raw;
      return body;
    } catch (e) {
      const auth = isAuthError(e);
      entry.attempts.push({ at_ms: now(), error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), auth, raw });
      if (auth) { entry.auth_failed = true; return null; }
      if (attempt < REGISTERED.fetchAttempts) await sleep(REGISTERED.fetchRetryMs);
    }
  }
  return null;
}

/**
 * One run: two twin sessions (scored, and the report-only W0), W + T windows, each fetched once
 * `settleMs` after it closes. Returns the run record; errors are recorded on it, not thrown.
 */
export async function runOne({
  cfg, cell, run, armReadyMs, cloudwatch, fetch: fetchFn, now = Date.now, sleep, log = () => {}, env = {}, onWindow = () => {}, onRecord = () => {},
}) {
  validateConfig(cfg);
  if (!REGISTERED.cells.includes(cell)) throw new Error(`cell must be one of ${REGISTERED.cells.join(', ')}`);
  if (!Number.isInteger(run) || run < 0) throw new Error('run must be a non-negative integer');
  const t0 = now();
  checkArmReady(armReadyMs, t0);
  const { warmupTicks: W, scoredTicks: T, tickMs, settleMs } = REGISTERED;
  const ref = `t3-${cell}-l${cfg.lane}-r${run}`;
  const token = cfg.gate.token_env ? env[cfg.gate.token_env] : undefined;
  const gate = gateClient(cfg.gate.base_url, fetchFn, token);
  const record = {
    study_id: REGISTERED.studyId, cell, lane: cfg.lane, run, deploy_ref: ref, registered: REGISTERED,
    twin_arm: { scored: twinArm(T, cell), w0: twinArm(W + T, cell) },
    alb_idle_timeout_s: cfg.alb_idle_timeout_s, arm_ready_ms: armReadyMs, started_at_ms: t0, first_window_start_ms: null, gate_healthz: null, windows: [],
    scored: { session_id: null, verdict: null, ticks: 0, window: null },
    w0: { session_id: null, verdict: null, ticks: 0, window: null },
    complete: false, authority: { violation: false, stated: null, window: null },
  };
  onRecord(record);
  const flushed = new Set();
  const flush = (entry) => { if (!flushed.has(entry.k)) { flushed.add(entry.k); onWindow(entry); } };
  const feed = async (arm, entry, body) => {
    const res = await gate.tick(record[arm].session_id, body);
    entry[arm] = res;
    Object.assign(record[arm], { verdict: res.verdict, ticks: res.tick, window: entry.k });
    if (res.authority !== 'advisory') throw new AuthorityError(res.authority, entry.k);
    return res.verdict === 'extend';
  };
  try {
    record.gate_healthz = await gate.healthz();
    record.scored.session_id = await gate.open(ref, record.twin_arm.scored);
    record.w0.session_id = await gate.open(`${ref}-w0`, record.twin_arm.w0);
    const start = firstWindowStart(now());
    record.first_window_start_ms = start;
    let scoredLive = true;
    let w0Live = true;
    let failed = false;
    for (let k = 0; k < W + T && (scoredLive || w0Live); k++) {
      const ws = start + k * tickMs;
      const we = ws + tickMs;
      const due = we + settleMs;
      if (now() < due) await sleep(due - now());
      const entry = { k, window_start_ms: ws, window_end_ms: we, attempts: [] };
      record.windows.push(entry);
      const body = await fetchWindow(cloudwatch, cfg, ws, we, entry, now, sleep);
      entry.lag_ms = now() - due;
      if (body === null) { entry.fetch_failed = true; failed = true; flush(entry); break; }
      if (cell === NR_CELL) {
        const nr = await fetchNoResponse(cloudwatch, cfg, ws, we, body, now, sleep);
        entry.no_response = nr.record;
        if (nr.observation === null) { entry.fetch_failed = true; failed = true; flush(entry); break; }
        body.observations[NR_ID] = nr.observation;
      }
      entry.body = body;
      const diag = await fetchDiagnostics(cloudwatch, cfg, ws, we);
      entry.health = diag.health;
      entry.stall = diag.stall;
      entry.diagnostics_raw = diag.raw;
      assertTwinTickBody(body);
      const tickBody = { ...body, emitted_at_ts: we / 1000 };
      if (w0Live) w0Live = await feed('w0', entry, tickBody);
      if (k >= W && scoredLive) { entry.scored_tick = true; scoredLive = await feed('scored', entry, tickBody); }
      flush(entry);
      log({ event: 't3_progress', ref, window: k + 1, of: W + T });
    }
    record.complete = !failed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof AuthorityError) {
      record.authority = { violation: true, stated: e.stated, window: e.window };
    } else if (e instanceof GateError) record.gate_error = msg;
    else record.runner_error = msg;
    const last = record.windows[record.windows.length - 1];
    if (last) flush(last); // the window in flight when the run stopped still reaches the file
    log({ event: 't3_error', ref, error: e instanceof AuthorityError ? 'authority violation (see files)' : msg });
  }
  record.ended_at_ms = now();
  return record;
}

/** The mechanical void rules V1–V5 (PREREGISTRATION.md §7). V6 and V7 need AWS event evidence. */
export function voidReasons(record) {
  const out = [];
  if (record.authority?.violation) {
    out.push(`AUTHORITY gate stated "${record.authority.stated}" at window ${record.authority.window}; study NOT EXECUTABLE from this run on`);
  }
  if (record.operator_abort) out.push('V5 aborted by operator');
  if (record.gate_error) out.push(`V5 gate error: ${record.gate_error}`);
  if (record.runner_error) out.push(`V5 runner error: ${record.runner_error}`);
  for (const w of record.windows) {
    if (w.fetch_failed) {
      out.push(w.auth_failed
        ? `V3 authorization failure for window ${w.k} (no retry): ${w.attempts[w.attempts.length - 1].error}`
        : `V3 fetch failed for window ${w.k} after ${w.attempts.length} attempts`);
    }
    if (w.lag_ms > REGISTERED.stallBoundMs) {
      out.push(`V5 stall: window ${w.k} fetched ${w.lag_ms} ms after window end + settle (bound ${REGISTERED.stallBoundMs} ms)`);
    }
  }
  if (!record.complete && out.length === 0) out.push('V5 run incomplete');
  if (record.scored.verdict === 'halt') out.push(`V2 sample-ratio halt at scored tick ${record.scored.ticks}`);
  const scored = record.windows.filter((w) => w.scored_tick);
  let events = 0;
  for (const w of scored) {
    const b = w.body;
    if (b.canary_requests === 0 || b.control_requests === 0) {
      out.push(`V1 metric gap: window ${w.k} has ${b.canary_requests} canary and ${b.control_requests} control requests`);
    }
    for (const id of [RATE_ID, SIGN_ID]) {
      if (!b.observations[id]) out.push(`V1 metric gap: window ${w.k} has no ${id} observation`);
    }
    if (Math.min(b.canary_requests, b.control_requests) < REGISTERED.minArmRequests) {
      out.push(`V4 traffic floor: window ${w.k} has ${Math.min(b.canary_requests, b.control_requests)} requests in an arm (< ${REGISTERED.minArmRequests})`);
    }
    const r = b.observations[RATE_ID];
    if (r) events += r.canary_events + r.control_events;
  }
  if (scored.length > 0 && events / scored.length < REGISTERED.minMean5xxPerTick) {
    out.push(`V4 traffic floor: ${(events / scored.length).toFixed(3)} target 5xx per scored tick (< ${REGISTERED.minMean5xxPerTick})`);
  }
  return out;
}

/** Amendment 1 (a): does this run add to E2's count? */
export function countsForE2(summary) {
  if (summary.operator_abort) return true;
  if (summary.scored?.verdict === 'rollback') return true;
  return summary.void_reasons.length > 0 && summary.w0?.verdict === 'rollback';
}

/** The once-written summary: every run-level field, no per-window lines. */
export function summaryOf(record, manifest) {
  const { windows, ...rest } = record;
  const void_reasons = voidReasons(record);
  const s = { ...rest, window_count: windows.length, manifest, void_reasons };
  s.counts_for_e2 = countsForE2(s);
  return s;
}

/** The run's two output files; refuses a (cell, run index) already recorded in any lane. */
export function claimOutputPaths(dir, cell, lane, run, stamp) {
  if (!REGISTERED.cells.includes(cell)) throw new Error(`cell must be one of ${REGISTERED.cells.join(', ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const taken = new RegExp(`^${cell.replace('-', '\\-')}-l\\d+-r${run}-`);
  const prior = fs.readdirSync(dir).filter((f) => taken.test(f));
  if (prior.length) throw new Error(`${cell} run ${run} already recorded (${prior.join(', ')}); a new run takes the next index`);
  const base = path.join(dir, `${cell}-l${lane}-r${run}-${stamp}`);
  return { jsonl: `${base}.jsonl`, summary: `${base}.summary.json` };
}

/** Exclusive-create files: the jsonl is only appended to, the summary written once. */
export function appendOnlyWriter(paths) {
  const fd = fs.openSync(paths.jsonl, 'wx');
  let summarized = false;
  return {
    line(obj) { fs.writeSync(fd, JSON.stringify(obj) + '\n'); },
    summary(obj) {
      if (summarized) throw new Error('summary is written once');
      summarized = true;
      fs.writeFileSync(paths.summary, JSON.stringify(obj, null, 1) + '\n', { flag: 'wx' });
      fs.closeSync(fd);
    },
  };
}

/** Amendment 1 (i): the only modified tracked file tolerated is the build-regenerated constants. */
const TOLERATED_DIRT = new Set(['tools/calibrate/_calibrate-constants.js']);
export function disallowedDirt(porcelain) {
  return porcelain.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim()).filter((p) => !TOLERATED_DIRT.has(p));
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function git(...a) {
  try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }); } catch { return null; }
}

function provenance(cfgRaw) {
  let engine = null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
    const e = lock.packages?.['node_modules/@johnpatrickwarren-oss/deploysignal-engine'];
    engine = e ? { version: e.version, resolved: e.resolved } : null;
  } catch { /* recorded as null */ }
  const tolerated = [...TOLERATED_DIRT].map((p) => ({
    path: p, diff_sha256: crypto.createHash('sha256').update(git('diff', '--', p) ?? '').digest('hex'),
  }));
  return {
    repo_sha: git('rev-parse', 'HEAD')?.trim() ?? null, tolerated_dirt: tolerated,
    node: process.version, platform: `${process.platform} ${process.arch}`, engine,
    config_sha256: crypto.createHash('sha256').update(cfgRaw).digest('hex'),
  };
}

export async function main(argv) {
  const cfgPath = arg(argv, '--config');
  if (!cfgPath) throw new Error('--config <path> is required');
  const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(cfgRaw);
  validateConfig(cfg);
  if (argv.includes('--check-config')) {
    console.log(`config ok: lane ${cfg.lane}, region ${cfg.region}, canary ${cfg.target_groups.canary}, control ${cfg.target_groups.control}`);
    return 0;
  }
  const porcelain = git('status', '--porcelain', '--untracked-files=no');
  if (porcelain === null) throw new Error('cannot read git status; refusing to run (Amendment 1 (i))');
  const dirt = disallowedDirt(porcelain);
  if (dirt.length) throw new Error(`modified tracked files: ${dirt.join(', ')}; commit or restore them first (Amendment 1 (i))`);
  const cell = arg(argv, '--cell');
  const run = Number(arg(argv, '--run'));
  if (!Number.isInteger(run) || run < 0) throw new Error('--run <k> must be a non-negative integer');
  const armReadyMs = Date.parse(arg(argv, '--arm-ready') ?? '');
  if (!Number.isFinite(armReadyMs)) throw new Error('--arm-ready <ISO-8601 time> is required (Amendment 1 (g)1)');
  checkArmReady(armReadyMs, Date.now()); // before any file is created, so a refused start burns no run index
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const paths = claimOutputPaths(arg(argv, '--out') ?? path.join(STUDY, 'results', 'runs'), cell, cfg.lane, run, stamp);
  const manifest = { command: ['node', ...argv].join(' '), ...provenance(cfgRaw) };
  const writer = appendOnlyWriter(paths);
  writer.line({ type: 'run', study_id: REGISTERED.studyId, cell, lane: cfg.lane, run, arm_ready_ms: armReadyMs,
    alb_idle_timeout_s: cfg.alb_idle_timeout_s, manifest });
  let current = null;
  const onSigint = () => {
    if (current) writer.summary(summaryOf({ ...current, operator_abort: true, ended_at_ms: Date.now() }, manifest));
    console.error(`aborted; partial record in ${paths.jsonl}`);
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
  // `current` is the live record object; onWindow appends each finished window as one line.
  const pending = runOne({
    cfg, cell, run, armReadyMs, cloudwatch: new CloudWatchClient({ region: cfg.region }), fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (e) => console.log(JSON.stringify(e)), env: process.env,
    onWindow: (w) => writer.line({ type: 'window', ...w }),
    onRecord: (r) => { current = r; },
  });
  const record = await pending;
  process.off('SIGINT', onSigint);
  writer.summary(summaryOf(record, manifest));
  console.log(`wrote ${paths.jsonl} and ${paths.summary}`);
  return record.gate_error || record.runner_error || record.authority.violation ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}

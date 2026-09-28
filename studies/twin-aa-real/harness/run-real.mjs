// studies/twin-aa-real/harness/run-real.mjs — one run of the T3 real-service A/A
// (PREREGISTRATION.md §§3, 7). Observe-only: it reads ALB metrics from CloudWatch through the
// existing twin source (service/sources/cloudwatch.ts) and posts ticks to the gate's twin HTTP API.
// It never calls CodeDeploy, ECS, ELBv2 or FIS, and aborts if the gate states an authority other
// than "advisory".
//
//   node studies/twin-aa-real/harness/run-real.mjs --config <cfg.json> --cell AA --run <k>
//       one run, started by the operator at arm-ready (OPERATOR.md). Writes
//       studies/twin-aa-real/results/runs/<cell>-l<lane>-r<k>-<UTC>.json and refuses a run index
//       already recorded for that cell and lane.
//   node studies/twin-aa-real/harness/run-real.mjs --config <cfg.json> --check-config
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
  studyId: '2026-10-twin-aa-real',
  tickMs: 60_000,
  settleMs: 180_000,
  warmupTicks: 15,
  scoredTicks: 60,
  fetchAttempts: 3,
  fetchRetryMs: 20_000,
  callTimeoutMs: 30_000,
  stallBoundMs: 300_000,
  minArmRequests: 500,
  minMean5xxPerTick: 2,
  cells: Object.freeze(['AA', 'AB-5xx', 'AB-lat']),
  lanes: 4,
});
export const RATE_ID = 'http_5xx';
export const SIGN_ID = 'p99_latency';

export function twinArm(maxTicks) {
  return {
    canary_weight: 0.5, alpha_rollback: 0.05, alpha_proceed: 1e-12, alpha_srm: 0.001, max_ticks: maxTicks,
    metrics: [
      { id: RATE_ID, kind: 'rate', worse: 'higher', tolerance: 0.2 },
      { id: SIGN_ID, kind: 'sign', worse: 'higher', tolerance: 0.15 },
    ],
  };
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
  need(Number.isInteger(cfg.tasks_per_arm) && cfg.tasks_per_arm >= 2, 'tasks_per_arm must be an integer >= 2 (R5)');
  need(typeof cfg.gate?.base_url === 'string' && /^https?:\/\//.test(cfg.gate.base_url), 'gate.base_url must be an http(s) URL');
  need(cfg.gate.token_env === undefined || cfg.gate.token_env === null || typeof cfg.gate.token_env === 'string',
    'gate.token_env must be an environment variable name or null');
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
class AuthorityError extends Error {}

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
    open: async (deployRef, arm) => (await post('/v1/sessions', { mode: 'twin', deploy_ref: deployRef, twin_arm: arm }, 201)).session_id,
    tick: (sessionId, body) => post(`/v1/sessions/${encodeURIComponent(sessionId)}/ticks`, body, 200),
  };
}

function healthQueries(cfg) {
  const out = [];
  for (const arm of ['canary', 'control']) {
    for (const [id, name, stat] of [[`hh_${arm}`, 'HealthyHostCount', 'Minimum'], [`uh_${arm}`, 'UnHealthyHostCount', 'Maximum']]) {
      out.push({
        Id: id, ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApplicationELB', MetricName: name,
            Dimensions: [{ Name: 'TargetGroup', Value: cfg.target_groups[arm] }, { Name: 'LoadBalancer', Value: cfg.load_balancer }],
          },
          Period: REGISTERED.tickMs / 1000, Stat: stat,
        },
      });
    }
  }
  return out;
}

/** Report-only arm health for one window (§3.1); an error is recorded, never fatal. */
async function fetchHealth(cloudwatch, cfg, ws, we) {
  try {
    const out = await bounded('health GetMetricData', REGISTERED.callTimeoutMs, (signal) => cloudwatch.send(
      new GetMetricDataCommand({ MetricDataQueries: healthQueries(cfg), StartTime: new Date(ws), EndTime: new Date(we) }),
      { abortSignal: signal }));
    const v = Object.fromEntries((out.MetricDataResults ?? []).map((r) => [r.Id, r.Values ?? []]));
    const pick = (id, f) => (v[id]?.length ? f(...v[id]) : null);
    return {
      healthy_min: { canary: pick('hh_canary', Math.min), control: pick('hh_control', Math.min) },
      unhealthy_max: { canary: pick('uh_canary', Math.max), control: pick('uh_control', Math.max) },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchWindow(source, ws, we, entry, now, sleep) {
  for (let attempt = 1; attempt <= REGISTERED.fetchAttempts; attempt++) {
    try {
      const body = await bounded('source fetchTick', REGISTERED.callTimeoutMs, (signal) => source.fetchTick(ws, we, signal));
      entry.attempts.push({ at_ms: now(), ok: true });
      return body;
    } catch (e) {
      entry.attempts.push({ at_ms: now(), error: e instanceof Error ? e.message : String(e) });
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
  cfg, cell, run, cloudwatch, fetch: fetchFn, now = Date.now, sleep, log = () => {}, env = {}, onProgress = () => {},
}) {
  validateConfig(cfg);
  if (!REGISTERED.cells.includes(cell)) throw new Error(`cell must be one of ${REGISTERED.cells.join(', ')}`);
  if (!Number.isInteger(run) || run < 0) throw new Error('run must be a non-negative integer');
  const { warmupTicks: W, scoredTicks: T, tickMs, settleMs } = REGISTERED;
  const ref = `t3-${cell}-l${cfg.lane}-r${run}`;
  const token = cfg.gate.token_env ? env[cfg.gate.token_env] : undefined;
  const gate = gateClient(cfg.gate.base_url, fetchFn, token);
  const source = new CloudWatchTwinSource({
    client: cloudwatch, loadBalancer: cfg.load_balancer, targetGroups: cfg.target_groups,
    errorRateId: RATE_ID, latencyP99Id: SIGN_ID, canaryWeight: 0.5,
  });
  const record = {
    study_id: REGISTERED.studyId, cell, lane: cfg.lane, run, deploy_ref: ref, registered: REGISTERED,
    twin_arm: { scored: twinArm(T), w0: twinArm(W + T) },
    started_at_ms: now(), first_window_start_ms: null, windows: [],
    scored: { session_id: null, verdict: null, ticks: 0, window: null },
    w0: { session_id: null, verdict: null, ticks: 0, window: null },
    complete: false,
  };
  const feed = async (arm, entry, body) => {
    const res = await gate.tick(record[arm].session_id, body);
    entry[arm] = res;
    Object.assign(record[arm], { verdict: res.verdict, ticks: res.tick, window: entry.k });
    if (res.authority !== 'advisory') throw new AuthorityError(`gate stated authority "${res.authority}"; this study is observe-only`);
    return res.verdict === 'extend';
  };
  try {
    record.scored.session_id = await gate.open(ref, record.twin_arm.scored);
    record.w0.session_id = await gate.open(`${ref}-w0`, record.twin_arm.w0);
    const start = firstWindowStart(now());
    record.first_window_start_ms = start;
    onProgress(record);
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
      const body = await fetchWindow(source, ws, we, entry, now, sleep);
      entry.lag_ms = now() - due;
      if (body === null) { entry.fetch_failed = true; failed = true; break; }
      entry.body = body;
      entry.health = await fetchHealth(cloudwatch, cfg, ws, we);
      assertTwinTickBody(body);
      const tickBody = { ...body, emitted_at_ts: we / 1000 };
      if (w0Live) w0Live = await feed('w0', entry, tickBody);
      if (k >= W && scoredLive) { entry.scored_tick = true; scoredLive = await feed('scored', entry, tickBody); }
      log({ event: 't3_tick', ref, k, lag_ms: entry.lag_ms, w0: entry.w0?.verdict ?? null, scored: entry.scored?.verdict ?? null });
      onProgress(record);
    }
    record.complete = !failed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof GateError) record.gate_error = msg;
    else record.runner_error = msg;
    log({ event: 't3_error', ref, error: msg });
  }
  record.ended_at_ms = now();
  return record;
}

/** The mechanical void rules V1–V5 (PREREGISTRATION.md §7). V6 and V7 need AWS event evidence. */
export function voidReasons(record) {
  const out = [];
  if (record.gate_error) out.push(`V5 gate error: ${record.gate_error}`);
  if (record.runner_error) out.push(`V5 runner error: ${record.runner_error}`);
  for (const w of record.windows) {
    if (w.fetch_failed) out.push(`V3 fetch failed for window ${w.k} after ${w.attempts.length} attempts`);
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

/** The run's output file; refuses a (cell, lane, run) already recorded in `dir`. */
export function claimOutputPath(dir, cell, lane, run, stamp) {
  if (!REGISTERED.cells.includes(cell)) throw new Error(`cell must be one of ${REGISTERED.cells.join(', ')}`);
  const prefix = `${cell}-l${lane}-r${run}-`;
  fs.mkdirSync(dir, { recursive: true });
  const prior = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  if (prior.length) throw new Error(`run ${prefix.slice(0, -1)} already recorded (${prior.join(', ')}); a new run takes the next index`);
  return path.join(dir, `${prefix}${stamp}.json`);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function provenance(cfgRaw) {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return null; } };
  let engine = null;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
    const e = lock.packages?.['node_modules/@johnpatrickwarren-oss/deploysignal-engine'];
    engine = e ? { version: e.version, resolved: e.resolved } : null;
  } catch { /* recorded as null */ }
  return {
    repo_sha: git('rev-parse', 'HEAD'), repo_dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
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
  const cell = arg(argv, '--cell');
  const run = Number(arg(argv, '--run'));
  if (!Number.isInteger(run) || run < 0) throw new Error('--run <k> must be a non-negative integer');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const out = claimOutputPath(arg(argv, '--out') ?? path.join(STUDY, 'results', 'runs'), cell, cfg.lane, run, stamp);
  const manifest = { command: ['node', ...argv].join(' '), ...provenance(cfgRaw) };
  // The file is created once (wx) and rewritten after every window, so an interrupted run keeps
  // its ticks; an operator abort (SIGINT) is recorded as a runner error (V5).
  let created = false;
  const save = (r) => {
    const body = JSON.stringify({ ...r, manifest, void_reasons: voidReasons(r) }, null, 1) + '\n';
    fs.writeFileSync(out, body, { flag: created ? 'w' : 'wx' });
    created = true;
  };
  let last = null;
  process.once('SIGINT', () => {
    if (last) save({ ...last, runner_error: 'aborted by operator (SIGINT)', ended_at_ms: Date.now() });
    console.error(`aborted; partial record in ${out}`);
    process.exit(130);
  });
  const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
  const record = await runOne({
    cfg, cell, run, cloudwatch: new CloudWatchClient({ region: cfg.region }), fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (e) => console.log(JSON.stringify(e)), env: process.env,
    onProgress: (r) => { last = r; save(r); },
  });
  save(record);
  record.void_reasons = voidReasons(record);
  console.log(`wrote ${out}`);
  console.log(`scored: ${record.scored.verdict} at tick ${record.scored.ticks}; W0: ${record.w0.verdict} at tick ${record.w0.ticks}`);
  console.log(record.void_reasons.length ? `VOID (mechanical): ${record.void_reasons.join('; ')}` : 'mechanical void rules V1-V5: none apply');
  return record.gate_error || record.runner_error ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}

// studies/twin-aa-local/harness/run.mjs — the load generator and gate client, and the process
// supervisor (PREREGISTRATION.md §1, §3). Starts the gate once; per cell starts the two service
// processes (same file) and the router, warms up, runs R gate sessions of up to T count-based ticks
// of n requests, and stops every process it started.
//
//   caffeinate -dims node studies/twin-aa-local/harness/run.mjs --mode full --seed-offset 1000000
//       writes studies/twin-aa-local/results/run-<UTC>/ (refuses an existing directory); run 2 under
//       Amendment 1 (seed offset 1000000; offset 0, the default, reproduces run 1's seeds). Records
//       each scored tick's wall duration (`ms`), the run's start and end, and power-log.txt (the
//       `pmset -g log` lines between them) for the Amendment 1 (c) void rule.
//   node studies/twin-aa-local/harness/run.mjs --mode smoke --out <dir outside the repo>
//       the §6 instrument checks; not a result
//
// Run from the repo root after `npm run build && npx tsc -p tsconfig.test.json`.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './_keyed.mjs';
import { powerLogWindow } from '../analysis/executability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDY = path.resolve(HERE, '..');
const REPO = path.resolve(STUDY, '..', '..');
const PORTS = { gate: 18290, router: 18200, control: 18201, canary: 18202 };
const S0 = 20260926;
const CONCURRENCY = 128;
const WARMUP = 2000;
let SEED_OFFSET = 0; // Amendment 1 (a); set from --seed-offset in main()

const RATE = { id: 'http_5xx', kind: 'rate', worse: 'higher', tolerance: 0.2 };
const SIGN = { id: 'p99_latency_ms', kind: 'sign', worse: 'higher', tolerance: 0.15 };

// §3, in registered order; i is the seed index.
const FULL_CELLS = [
  { i: 1, name: 'AA-w0.5', w: 0.5, metrics: [RATE, SIGN], flags: [], R: 100, T: 100, n: 500 },
  { i: 2, name: 'AA-w0.1', w: 0.1, metrics: [RATE], allowUnequal: true, flags: [], R: 100, T: 100, n: 500 },
  { i: 3, name: 'AB-rate-x2', w: 0.5, metrics: [RATE, SIGN], flags: ['--fault-5xx-mult', '2'], R: 40, T: 100, n: 500 },
  { i: 4, name: 'AB-lat-x1.2', w: 0.5, metrics: [RATE, SIGN], flags: ['--fault-latency-mult', '1.2'], R: 40, T: 100, n: 500 },
];
// §6 smoke: (i) a gross 5xx fault fires; (ii) an A/A run of 20 ticks stays extend. Seeds 91, 92.
const SMOKE_CELLS = [
  { i: 91, name: 'smoke-fire-x5', w: 0.5, metrics: [RATE, SIGN], flags: ['--fault-5xx-mult', '5'], R: 2, T: 100, n: 500 },
  { i: 92, name: 'smoke-aa-20', w: 0.5, metrics: [RATE, SIGN], flags: [], R: 2, T: 20, n: 500 },
];

// ── failure accounting (harness-discipline rule 2: no bare catch) ───────────────────────────
const failures = { count: 0, first: [] };
function fail(cell, msg) {
  failures.count += 1;
  if (cell) cell.failures += 1;
  if (failures.first.length < 50) failures.first.push(`${cell ? cell.name : '-'}: ${msg}`);
}

// ── processes ───────────────────────────────────────────────────────────────────────────────
const children = new Set();

function startProcess(label, args, opts, readyRe, stream) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${label} did not start: ${buf}`)), 15_000);
    const onData = (d) => {
      buf += d.toString();
      if (readyRe.test(buf)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child[stream].on('data', onData);
    child[stream === 'stdout' ? 'stderr' : 'stdout'].on('data', (d) => { buf += d.toString(); });
    child.on('exit', (code, sig) => {
      children.delete(child);
      child.exited = { code, sig };
      clearTimeout(timer);
      if (!child.expectedExit) reject(new Error(`${label} exited (${code}, ${sig}): ${buf.slice(-500)}`));
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exited) return;
  child.expectedExit = true;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 3000);
  await gone;
  clearTimeout(t);
}

function killAllSync() {
  for (const c of children) {
    c.expectedExit = true;
    try { c.kill('SIGKILL'); } catch (e) { process.stderr.write(`kill failed: ${e.message}\n`); }
  }
}
process.on('exit', killAllSync);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAllSync(); process.exit(130); });

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────
const loadAgent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
const ctlAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function httpJson(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, agent: ctlAgent,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { reject(new Error(`bad JSON from ${p}: ${s.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function oneRequest(run, tick, idx) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORTS.router, path: '/r', method: 'GET', agent: loadAgent,
      headers: { 'x-aa-run': String(run), 'x-aa-tick': String(tick), 'x-aa-idx': String(idx) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (e) => resolve(`error:${e.message}`));
    req.end();
  });
}

/** n requests with CONCURRENCY in flight; returns the statuses that were neither 200 nor 5xx. */
async function issueTick(run, tick, n) {
  let next = 0;
  const odd = [];
  const worker = async () => {
    while (next < n) {
      const idx = next++;
      const st = await oneRequest(run, tick, idx);
      if (!(st === 200 || (typeof st === 'number' && st >= 500))) odd.push(st);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));
  return odd;
}

// ── one cell ────────────────────────────────────────────────────────────────────────────────
function twinArm(cell) {
  return {
    canary_weight: cell.w, alpha_rollback: 0.05, alpha_proceed: 1e-12, alpha_srm: 0.001, max_ticks: cell.T,
    ...(cell.allowUnequal ? { allow_unequal_rate_split: true } : {}),
    metrics: cell.metrics,
  };
}

function tickBody(cell, run, tick, agg) {
  const c = agg.canary;
  const k = agg.control;
  const observations = {
    http_5xx: { canary_events: c.e5xx, canary_total: c.requests, control_events: k.e5xx, control_total: k.requests },
  };
  if (cell.metrics.some((m) => m.id === SIGN.id)) observations[SIGN.id] = { canary: c.p99, control: k.p99 };
  return {
    emitted_at_ts: 1.8e9 + 1e6 * cell.i + 1e3 * run + tick,
    canary_requests: c.requests, control_requests: k.requests, observations,
  };
}

async function runOne(cell, run) {
  const created = await httpJson(PORTS.gate, 'POST', '/v1/sessions', {
    mode: 'twin', twin_arm: twinArm(cell), deploy_ref: `aa-${cell.name}-r${run}`, requested_at_ts: 1.8e9 + 1e6 * cell.i + 1e3 * run,
  });
  if (created.status !== 201) {
    fail(cell, `run ${run}: create ${created.status} ${JSON.stringify(created.body)}`);
    return null;
  }
  const sid = created.body.session_id;
  const ticks = [];
  let ticksToDetect = null;
  let verdict = 'extend';
  for (let t = 0; t < cell.T && verdict === 'extend'; t++) {
    const tickStart = process.hrtime.bigint();
    const odd = await issueTick(run, t, cell.n);
    if (odd.length > 0) fail(cell, `run ${run} tick ${t}: ${odd.length} lost/odd responses (${odd[0]})`);
    const agg = (await httpJson(PORTS.router, 'GET', `/agg?run=${run}&tick=${t}`)).body;
    if (agg.canary.requests + agg.control.requests !== cell.n) {
      fail(cell, `run ${run} tick ${t}: router counted ${agg.canary.requests + agg.control.requests} of ${cell.n}`);
    }
    const r = await httpJson(PORTS.gate, 'POST', `/v1/sessions/${encodeURIComponent(sid)}/ticks`, tickBody(cell, run, t, agg));
    if (r.status !== 200) {
      fail(cell, `run ${run} tick ${t}: gate ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      break;
    }
    if (r.body.authority !== 'advisory') fail(cell, `run ${run} tick ${t}: authority ${r.body.authority}`);
    if (ticksToDetect === null && r.body.ticks_to_detect !== undefined) ticksToDetect = r.body.ticks_to_detect;
    verdict = r.body.engine_verdict;
    const ms = Math.round(Number(process.hrtime.bigint() - tickStart) / 1e5) / 10; // first request to gate response
    ticks.push({
      t, ms, nc: agg.canary.requests, nk: agg.control.requests, ec: agg.canary.e5xx, ek: agg.control.e5xx,
      uc: agg.canary.upstream_errors, uk: agg.control.upstream_errors, p99c: agg.canary.p99, p99k: agg.control.p99,
      mc: agg.canary.requests ? agg.canary.latency_sum / agg.canary.requests : null,
      mk: agg.control.requests ? agg.control.latency_sum / agg.control.requests : null,
      v: r.body.engine_verdict, srm: r.body.srm_e,
      m: r.body.metrics.map((x) => [x.id, x.rollback_e, x.rollback_threshold, x.proceed_e, x.used, x.skipped, x.ties, x.missing]),
    });
  }
  return { run, session_id: sid, verdict, ticks_to_detect: ticksToDetect, ticks };
}

async function runCell(cell, gate) {
  const base = S0 + SEED_OFFSET + 7919 * cell.i;
  const seeds = { router: base, control: base + 1, canary: base + 2 };
  const svc = path.join(HERE, 'service.mjs');
  const control = await startProcess('control', [svc, '--port', String(PORTS.control), '--seed', String(seeds.control)], {}, /listening/, 'stdout');
  const canary = await startProcess('canary', [svc, '--port', String(PORTS.canary), '--seed', String(seeds.canary), ...cell.flags], {}, /listening/, 'stdout');
  const router = await startProcess('router', [path.join(HERE, 'router.mjs'), '--port', String(PORTS.router),
    '--control-port', String(PORTS.control), '--canary-port', String(PORTS.canary), '--w', String(cell.w), '--seed', String(seeds.router)], {}, /listening/, 'stdout');
  const out = { name: cell.name, w: cell.w, R: cell.R, T: cell.T, n: cell.n, flags: cell.flags, twin_arm: twinArm(cell), seeds, runs: [] };
  cell.failures = 0;
  const t0 = process.hrtime.bigint();
  let requests = 0;
  try {
    const wOdd = await issueTick(-1, 0, WARMUP);
    if (wOdd.length > 0) fail(cell, `warm-up: ${wOdd.length} lost/odd responses`);
    await httpJson(PORTS.router, 'GET', '/agg?run=-1&tick=0');
    for (let r = 0; r < cell.R; r++) {
      if (gate.exited) { fail(cell, 'gate process exited'); break; }
      const res = await runOne(cell, r);
      if (res) {
        out.runs.push(res);
        requests += res.ticks.length * cell.n;
      }
      process.stderr.write(`${cell.name} run ${r}: ${res ? `${res.verdict} @${res.ticks.length}` : 'FAILED'}\n`);
    }
  } finally {
    for (const c of [router, canary, control]) {
      if (c.exited && !c.expectedExit) fail(cell, `a cell process exited during the cell (${JSON.stringify(c.exited)})`);
      await stopProcess(c);
    }
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  out.harness_failures = cell.failures;
  out.wall_seconds = Math.round(secs);
  out.requests = requests;
  out.requests_per_second = Math.round(requests / secs);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
function gitSha(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}

function listenersOnPorts() {
  const busy = [];
  for (const p of Object.values(PORTS)) {
    try {
      execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'pipe' });
      busy.push(p);
    } catch (e) {
      if (e.status !== 1) throw e; // lsof exits 1 when nothing listens
    }
  }
  return busy;
}

/** The first line of `pmset -g batt` ("Now drawing from 'AC Power'"), recorded, not scored. */
function powerSource() {
  try {
    return execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch (e) {
    return `unavailable: ${e.message}`;
  }
}

/** Amendment 1 (c): the `pmset -g log` lines between start and end. A missing log voids the run. */
function savePowerLog(outDir, startedMs, endedMs, manifest) {
  let text;
  try {
    text = execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    manifest.power_log_error = e.message;
    process.stderr.write(`power log unavailable: ${e.message}\n`);
    return;
  }
  fs.writeFileSync(path.join(outDir, 'power-log.txt'), powerLogWindow(text, startedMs, endedMs));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  if (mode !== 'full' && mode !== 'smoke') throw new Error('--mode full|smoke');
  SEED_OFFSET = args['seed-offset'] === undefined ? 0 : Number(args['seed-offset']);
  if (!Number.isSafeInteger(SEED_OFFSET) || SEED_OFFSET < 0) throw new Error('--seed-offset must be a non-negative integer');
  const busy = listenersOnPorts();
  if (busy.length) throw new Error(`ports already in use: ${busy.join(', ')}`);

  let outDir;
  if (mode === 'full') {
    const id = `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    outDir = path.join(STUDY, 'results', id);
    if (fs.existsSync(outDir)) throw new Error(`refusing existing ${outDir}`);
  } else {
    if (!args.out) throw new Error('--out required in smoke mode');
    outDir = path.resolve(args.out);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-aa-gate-'));
  const gate = await startProcess('gate', [path.join(REPO, 'service', 'gate-http', 'server.js')], {
    cwd: REPO,
    env: { ...process.env, DS_GATE_PORT: String(PORTS.gate), DS_GATE_STORE_DIR: store, DS_GATE_BASELINE_HISTORY_DIR: path.join(store, 'bh'), DS_GATE_SERVICE_ID: 'twin-aa-local' },
  }, /listening/, 'stderr');

  const cells = mode === 'full' ? FULL_CELLS : SMOKE_CELLS;
  const manifest = {
    study: '2026-09-twin-aa-local', mode, repo_head: gitSha(['rev-parse', 'HEAD']), branch: gitSha(['branch', '--show-current']),
    tracked_changes: gitSha(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean),
    engine: JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json'), 'utf8')).version,
    engine_resolved: JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages['node_modules/@johnpatrickwarren-oss/deploysignal-engine'].resolved,
    node: process.version, platform: `${process.platform} ${os.release()}`, cpus: os.cpus().length,
    seed_scheme: 'router = 20260926 + seed_offset + 7919 i, control = +1, canary = +2; draws keyed on (seed, run, tick, idx, stream)',
    amendment: 1, seed_offset: SEED_OFFSET,
    concurrency: CONCURRENCY, warmup_requests: WARMUP, ports: PORTS,
    command: `node ${path.relative(REPO, fileURLToPath(import.meta.url))} ${process.argv.slice(2).join(' ')}`,
  };
  const startedMs = Date.now(); // wall clock for the power-log window only; no draw depends on it
  manifest.started_at = new Date(startedMs).toISOString();
  manifest.power_source_at_start = powerSource();
  const t0 = process.hrtime.bigint();
  const summary = [];
  try {
    for (const cell of cells) {
      const res = await runCell(cell, gate);
      fs.writeFileSync(path.join(outDir, `cell-${cell.name}.json`), JSON.stringify(res));
      summary.push({ name: res.name, runs: res.runs.length, harness_failures: res.harness_failures, wall_seconds: res.wall_seconds, requests_per_second: res.requests_per_second });
    }
  } finally {
    if (gate.exited && !gate.expectedExit) fail(null, `gate exited during the run (${JSON.stringify(gate.exited)})`);
    await stopProcess(gate);
    fs.rmSync(store, { recursive: true, force: true });
    loadAgent.destroy();
    ctlAgent.destroy();
  }
  manifest.wall_seconds = Math.round(Number(process.hrtime.bigint() - t0) / 1e9);
  const endedMs = Date.now();
  manifest.ended_at = new Date(endedMs).toISOString();
  manifest.power_source_at_end = powerSource();
  savePowerLog(outDir, startedMs, endedMs, manifest);
  manifest.cells = summary;
  manifest.harness_failures = failures;
  manifest.listeners_left = listenersOnPorts();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`done: ${outDir}\nharness failures: ${failures.count}\nlisteners left on harness ports: ${manifest.listeners_left.length}\n`);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack}\nharness failures so far: ${failures.count}\n`);
  killAllSync();
  process.exit(1);
});

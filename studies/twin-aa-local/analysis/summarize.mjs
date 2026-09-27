// studies/twin-aa-local/analysis/summarize.mjs — scores a run against PREREGISTRATION.md §2, §4, §5.
// Written before the run; reads only the run directory. Run from the command line it also writes
// <run-dir>/endpoints.json (check_report.mjs imports compute/renderTables and writes nothing).
//
//   node studies/twin-aa-local/analysis/summarize.mjs <run-dir>   -> <run-dir>/endpoints.json, tables on stdout

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHA = 0.05;
const REGISTERED = [
  { name: 'AA-w0.5', kind: 'AA', R: 100 },
  { name: 'AA-w0.1', kind: 'AA', R: 100 },
  { name: 'AB-rate-x2', kind: 'AB', R: 40 },
  { name: 'AB-lat-x1.2', kind: 'AB', R: 40 },
];
const SIGN_ID = 'p99_latency_ms';

const f4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? '–' : x.toFixed(4));
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Deployed-configuration replay at alpha_proceed 0.05 (PREREGISTRATION.md §1). */
function deployedVerdict(run) {
  for (const t of run.ticks) {
    if (t.srm >= 1000) return 'invalid_experiment';
    if (t.m.some((x) => x[1] >= x[2])) return 'rollback';
    if (t.m.every((x) => x[3] >= 20)) return 'proceed';
  }
  return 'no_terminal_by_T';
}

function signDiagnostics(runs) {
  let worse = 0;
  let n = 0;
  let logSum = 0;
  let pairs = 0;
  const seqs = [];
  for (const r of runs) {
    const seq = [];
    for (const t of r.ticks) {
      if (t.p99c === null || t.p99k === null || t.p99c === t.p99k) continue;
      const s = t.p99c > t.p99k ? 1 : 0;
      worse += s;
      n += 1;
      logSum += Math.log(t.p99c / t.p99k);
      pairs += 1;
      seq.push(s);
    }
    seqs.push(seq);
  }
  if (n === 0) return null;
  const p = worse / n;
  let num = 0;
  let den = 0;
  for (const seq of seqs) {
    for (let i = 0; i < seq.length; i++) {
      den += (seq[i] - p) ** 2;
      if (i > 0) num += (seq[i] - p) * (seq[i - 1] - p);
    }
  }
  return { ticks: n, frac_canary_worse: p, se: Math.sqrt(p * (1 - p) / n), lag1_autocorr: den > 0 ? num / den : null, mean_log_ratio: logSum / pairs };
}

function cellSummary(reg, raw) {
  const runs = raw ? raw.runs : [];
  const R = runs.length;
  const rolled = runs.filter((r) => r.verdict === 'rollback');
  const k = rolled.length;
  const rate = R ? k / R : null;
  const se = R ? Math.sqrt(rate * (1 - rate) / R) : null;
  const perMetric = {};
  for (const r of rolled) {
    for (const x of r.ticks[r.ticks.length - 1].m) if (x[1] >= x[2]) perMetric[x[0]] = (perMetric[x[0]] ?? 0) + 1;
  }
  let nc = 0; let nk = 0; let ec = 0; let ek = 0; let up = 0;
  for (const r of runs) for (const t of r.ticks) { nc += t.nc; nk += t.nk; ec += t.ec; ek += t.ek; up += t.uc + t.uk; }
  const deployed = {};
  for (const r of runs) { const v = deployedVerdict(r); deployed[v] = (deployed[v] ?? 0) + 1; }
  const B = ALPHA + 2.58 * Math.sqrt(ALPHA * (1 - ALPHA) / reg.R);
  const failures = raw ? raw.harness_failures : null;
  const executable = raw !== null && failures === 0 && R === reg.R;
  return {
    name: reg.name, kind: reg.kind, registered_R: reg.R, runs: R, rollbacks: k, rate, se, bar: reg.kind === 'AA' ? B : null,
    median_rollback_tick: median(rolled.map((r) => r.ticks.length)),
    median_ticks_to_detect: median(runs.map((r) => r.ticks_to_detect).filter((x) => x !== null)),
    rollbacks_by_metric: perMetric,
    invalid_experiment: runs.filter((r) => r.verdict === 'invalid_experiment').length,
    inconclusive: runs.filter((r) => r.verdict === 'inconclusive').length,
    harness_failures: failures, upstream_errors: up, executable,
    canary_share_requests: nc + nk ? nc / (nc + nk) : null,
    canary_share_5xx: ec + ek ? ec / (ec + ek) : null,
    deployed_replay: deployed,
    sign: raw && raw.twin_arm.metrics.some((m) => m.id === SIGN_ID) ? signDiagnostics(runs) : null,
    wall_seconds: raw ? raw.wall_seconds : null, requests_per_second: raw ? raw.requests_per_second : null,
  };
}

function held(b) { return b ? 'HELD' : 'NOT HELD'; }

export function compute(runDir) {
  const cells = {};
  for (const reg of REGISTERED) {
    const p = path.join(runDir, `cell-${reg.name}.json`);
    cells[reg.name] = cellSummary(reg, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  const aa5 = cells['AA-w0.5'];
  const aa1 = cells['AA-w0.1'];
  const abr = cells['AB-rate-x2'];
  const abl = cells['AB-lat-x1.2'];
  const ex = (c) => c.executable;
  const endpoints = {
    E1: ex(aa5) ? aa5.rate <= aa5.bar : 'NOT EXECUTABLE',
    E2: ex(aa1) ? aa1.rate <= aa1.bar : 'NOT EXECUTABLE',
    E3: ex(aa5) && ex(aa1) ? aa5.invalid_experiment <= 1 && aa1.invalid_experiment <= 1 : 'NOT EXECUTABLE',
    E4: ex(abr) ? abr.rate >= 0.8 : 'NOT EXECUTABLE',
    E5: ex(abl) ? abl.rate >= 0.8 : 'NOT EXECUTABLE',
    E6: Object.values(cells).every((c) => c.harness_failures === 0 && c.upstream_errors === 0),
  };
  const inRange = (x, lo, hi) => x !== null && x >= lo && x <= hi;
  const predictions = {
    P1: aa5.rate !== null && aa5.rate <= aa5.bar,
    P2: aa1.rate !== null && aa1.rate <= aa1.bar,
    P3: aa5.invalid_experiment === 0 && aa1.invalid_experiment === 0,
    P4: abr.rate !== null && abr.rate >= 0.9 && inRange(abr.median_rollback_tick, 15, 45),
    P5: abl.rate !== null && abl.rate >= 0.9 && inRange(abl.median_rollback_tick, 8, 40),
    P6: endpoints.E6,
    P7: aa5.sign !== null && Math.abs(aa5.sign.frac_canary_worse - 0.5) <= 3 * aa5.sign.se,
  };
  const all = Object.values(endpoints).every((v) => v === true);
  return { cells, endpoints, predictions, ship_rule_met: all && Object.values(cells).every(ex) };
}

export function renderTables(res) {
  const L = [];
  L.push('| cell | runs | rollbacks | rate | SE | bar | median tick | invalid | inconclusive | harness failures | upstream errors |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of Object.values(res.cells)) {
    L.push(`| ${c.name} | ${c.runs} | ${c.rollbacks} | ${f4(c.rate)} | ${f4(c.se)} | ${c.bar === null ? '–' : f4(c.bar)} | ${c.median_rollback_tick ?? '–'} | ${c.invalid_experiment} | ${c.inconclusive} | ${c.harness_failures} | ${c.upstream_errors} |`);
  }
  L.push('');
  L.push('| endpoint | result |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(res.endpoints)) L.push(`| ${k} | ${v === true ? 'MET' : v === false ? 'NOT MET' : v} |`);
  L.push('');
  L.push('| prediction | scored |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(res.predictions)) L.push(`| ${k} | ${held(v)} |`);
  L.push('');
  L.push('| cell | rollbacks by metric | canary share (requests) | canary share (5xx) | deployed replay at alpha_proceed 0.05 | median ticks_to_detect |');
  L.push('|---|---|---|---|---|---|');
  for (const c of Object.values(res.cells)) {
    const by = Object.entries(c.rollbacks_by_metric).map(([k, v]) => `${k} ${v}`).join(', ') || '–';
    const dep = Object.entries(c.deployed_replay).sort().map(([k, v]) => `${k} ${v}`).join(', ');
    L.push(`| ${c.name} | ${by} | ${f4(c.canary_share_requests)} | ${f4(c.canary_share_5xx)} | ${dep} | ${c.median_ticks_to_detect ?? '–'} |`);
  }
  L.push('');
  L.push('| cell | sign ticks | fraction canary p99 worse | SE | lag-1 autocorrelation | mean log(canary p99 / control p99) |');
  L.push('|---|---|---|---|---|---|');
  for (const c of Object.values(res.cells)) {
    if (!c.sign) continue;
    L.push(`| ${c.name} | ${c.sign.ticks} | ${f4(c.sign.frac_canary_worse)} | ${f4(c.sign.se)} | ${f4(c.sign.lag1_autocorr)} | ${f4(c.sign.mean_log_ratio)} |`);
  }
  L.push('');
  L.push(`Ship rule (§7): ${res.ship_rule_met ? 'MET' : 'NOT MET'}`);
  return L.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2]);
  const res = compute(dir);
  fs.writeFileSync(path.join(dir, 'endpoints.json'), `${JSON.stringify(res, null, 2)}\n`);
  process.stdout.write(`${renderTables(res)}\n`);
}

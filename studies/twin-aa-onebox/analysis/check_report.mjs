// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const flat = report.replace(/\s+/g, ' ');
const has = (s) => flat.includes(s);
const dirs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('exactly one analysis dir', dirs.length === 1 && dirs[0] === 'run-20261010T020414Z' && has(dirs[0]));
const R = join(STUDY, 'results', dirs[0]);
const E = JSON.parse(readFileSync(join(R, 'endpoints.json'), 'utf8'));
const runs = JSON.parse(readFileSync(join(R, 'runs.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(R, 'manifest.json'), 'utf8'));
const replay = JSON.parse(readFileSync(join(R, 'replay.json'), 'utf8'));
const files = readdirSync(join(STUDY, 'results', 'runs'));
const byRun = [...runs].sort((a, b) => a.run - b.run);
check('200 summaries, 200 jsonl, 200 runs, indices 264–463', files.filter((f) => f.endsWith('.summary.json')).length === 200 && files.filter((f) => f.endsWith('.jsonl')).length === 200 && runs.length === 200 && byRun[0].run === 264 && byRun[199].run === 463 && has('264–463'));
check('first arm-ready, last runner exit', runs.map((r) => r.arm_ready).sort()[0] === '2026-10-03T02:48:39Z' && runs.map((r) => r.runner_exit).sort().pop() === '2026-10-05T23:18:43Z' && has('2026-10-03 02:48:39Z') && has('2026-10-05 23:18:43Z'));
check('pin: every run from aae042d on engine 0.13.0-pre de25786', M.runner_repo_shas.length === 1 && M.runner_repo_shas[0].startsWith('aae042d') && M.engines.length === 1 && M.engines[0].version === '0.13.0-pre' && M.engines[0].resolved.endsWith('de25786c0a6b15935aa9416b04359f6a3e309106') && has('aae042d') && has('de25786c'));
check('analysis committed before run 0, unmodified', M.committed_before_run_0 === true && M.analysis_tracked_changes.length === 0);
// endpoints recomputed from runs.json
const ex = runs.filter((r) => r.executable);
for (const [st, key] of [['S', 'O1'], ['X', 'O2']]) {
  const e = ex.filter((r) => r.stratum === st);
  const rb = e.filter((r) => r.scored.verdict === 'rollback');
  check(`${key} recomputed: 0 of 100`, e.length === 100 && rb.length === 0 && E[key].verdict === 'PASS' && runs.filter((r) => r.stratum === st).length === 100);
}
check('O1/O2 quoted with upper bound 0.030', has('**O1 (same AZ): PASS**, 0 of 100') && has('**O2 (across AZs): PASS**, 0 of 100') && has('upper bound is **0.030**') && Math.abs(1 - Math.pow(0.05, 1 / 100) - 0.0295) < 5e-4);
check('O3 0 of 200', E.O3.verdict === 'PASS' && JSON.stringify(E.O3).includes('200') && has('**O3: PASS** (0 sample-ratio halts in 200 attempts)'));
check('O4 S 0 X 0', JSON.stringify(E.O4).includes('PASS') && !JSON.stringify(E.O4).includes('FAIL') && has('| S 0, X 0 |'));
check('every run holds 60 ticks; W0 holds 75', runs.every((r) => r.scored.verdict === 'hold' && r.scored.ticks === 60 && r.w0.verdict === 'hold' && r.w0.ticks === 75));
check('no void, no fires, no authority violation, no deploy failure', ex.length === 200 && runs.every((r) => r.void_reasons.length === 0 && r.fired.length === 0 && !r.authority_violation) && E.authority_violations === 0 && E.deploy_failures.length === 0 && E.v10_void_runs.length === 0 && E.rate_detector_fires === 0);
check('V10: every run in its lane\'s AZs', runs.every((r) => r.baseline_az.length === 1 && r.canary_az.length === 1 && r.baseline_az[0] === E.placement[r.lane].baseline && r.canary_az[0] === E.placement[r.lane].canary));
// per-lane table
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const [l, st, az, ratio] of [[0, 'S', '1a / 1a', '1.002'], [1, 'S', '1b / 1b', '0.999'], [2, 'X', '1a / 1b', '1.003'], [3, 'X', '1b / 1a', '0.997']]) {
  const e = ex.filter((r) => r.lane === l);
  const got = med(e.map((r) => r.median_p99_s.canary / r.median_p99_s.control)).toFixed(3);
  check(`lane ${l} row`, e.length === 50 && got === ratio && has(`| ${l} | ${st} | ${az} | 50 | 0 | ${ratio} |`));
}
// V8 scale and p99 ranges
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rng = (st) => { const c = ex.filter((r) => r.stratum === st).map((r) => r.median_p99_s.control * 1000); return [q(c, 0), q(c, 0.5), q(c, 0.999)].map((x) => x.toFixed(1)); };
const [s0, s5, s9] = rng('S'), [x0, x5, x9] = rng('X');
check('control p99 ranges', `${s0}–${s9}` === '75.3–78.0' && `${x0}–${x9}` === '74.9–78.4' && s5 === '76.3' && x5 === '76.4' && has('75.3–78.0 ms in S and 74.9–78.4 ms in X') && has('(medians 76.3 and 76.4)'));
// CloudTrail evidence
const evidence = JSON.parse(readFileSync(join(STUDY, 'results', 'evidence', 'cloudtrail-write-events.json'), 'utf8'));
const ev = evidence.events.map((e) => ({ ...e, ms: Date.parse(e.t) }));
check('CloudTrail evidence: 2,641 events, window, no account id', evidence.count === 2641 && evidence.start === '2026-10-03T02:30:00Z' && evidence.end === '2026-10-06T00:30:00Z' && has('2,641 write events') && !JSON.stringify(evidence).includes('556890483612'));
check('V6/V7 evaluated on 200, flagged none', E.v67.evaluated_runs === 200 && E.v67.flagged_runs.length === 0 && runs.every((r) => r.v67.evaluated && r.v67.events_inside.length === 0));
check('four identities, laptop user only before run 0', new Set(ev.map((e) => e.identity.replace(/\/[^/]+$/, ''))).size === 4 && ev.filter((e) => /:user\//.test(e.identity)).every((e) => e.ms < Date.parse('2026-10-03T02:48:39Z')));
const unassigned = runs.filter((r) => r.v67.unassigned_inside.length > 0);
check('149 runs with lane-less events', unassigned.length === 149 && E.v67.unassigned_inside_runs.length === 149 && has('149 of the 200 runs'));
// the round spreads: 23 s to 6.5 min
const spreads = []; for (let i = 0; i + 3 < byRun.length; i += 4) { const t = byRun.slice(i, i + 4).map((r) => Date.parse(r.arm_ready)); spreads.push((Math.max(...t) - Math.min(...t)) / 1000); }
check('round spread 23 s to 6.5 min', Math.min(...spreads) === 23 && (Math.max(...spreads) / 60).toFixed(1) === '6.5' && has('within 23 s to 6.5 min'));
// driver scale events and the TaskCreated accounting
const scales = []; const regBefore = [];
for (const f of readdirSync(join(STUDY, 'results', 'operator', 'runs')).filter((x) => x.endsWith('.ndjson'))) {
  const lane = Number(/-l(\d)-/.exec(f)[1]); let s = null, a = null;
  for (const l of readFileSync(join(STUDY, 'results', 'operator', 'runs', f), 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue; const j = JSON.parse(l);
    if (j.event === 'scale') { s = Date.parse(j.t); scales.push({ lane, ms: s }); }
    if (j.event === 'arm_ready') a = Date.parse(j.t);
  }
  regBefore.push(ev.filter((e) => e.name === 'RegisterTargets' && e.lane === lane && e.ms >= s && e.ms <= a).length);
}
const tc = ev.filter((e) => e.name === 'TaskCreated'); const run0 = Date.parse('2026-10-03T02:47:49Z');
const pre = tc.filter((t) => t.ms < run0);
check('407 TaskCreated = 4 pre-flight + 400 + 3', tc.length === 407 && pre.length === 4 && scales.length === 200 && has('407 `TaskCreated`'));
check('every TaskCreated after run 0 follows a scale by ≤ 120 s', tc.filter((t) => t.ms >= run0).every((t) => scales.some((s) => t.ms >= s.ms && t.ms - s.ms <= 120e3)));
check('exactly two RegisterTargets per run before arm-ready', regBefore.length === 200 && regBefore.every((n) => n === 2));
check('the two placed extras at 15:48:49Z and 17:12:54Z', ['d391173d', '5735dc4a'].every((id) => tc.some((t) => t.id.startsWith(id))) && has('runs 372 (15:48:49Z)') && has('377 (17:12:54Z)'));
// traffic and e-values from the stored tick bodies
for (const st of ['S', 'X']) {
  let evn = 0, tot = 0, maxRate = 0, maxSign = 0, req = { canary: 0, control: 0 }, five = { canary: 0, control: 0 }; const e = ex.filter((r) => r.stratum === st);
  for (const r of e) {
    for (const k of ['canary', 'control']) { req[k] += r.mean_requests[k]; five[k] += r.mean_5xx[k]; }
    const lines = readFileSync(join(STUDY, 'results', 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick);
    for (const w of lines) {
      const h = w.body.observations.http_5xx; evn += h.canary_events + h.control_events; tot += h.canary_total + h.control_total;
      for (const m of w.scored.metrics ?? []) { if (m.id === 'http_5xx') maxRate = Math.max(maxRate, m.rollback_e); else maxSign = Math.max(maxSign, m.rollback_e); }
    }
  }
  const want = st === 'S' ? { n: '73,197 of 14,640,972', rate: '1.02', srm: '1.058' } : { n: '73,224 of 14,642,515', rate: '1.01', srm: '1.095' };
  check(`${st} pooled 5xx`, `${evn.toLocaleString('en-US')} of ${tot.toLocaleString('en-US')}` === want.n && (evn / tot).toFixed(4) === '0.0050' && has(`${st} ${want.n}`));
  check(`${st} e-values`, maxRate.toFixed(2) === want.rate && maxSign.toFixed(2) === '1.00' && Math.max(...e.map((r) => r.final_srm_e)).toFixed(3) === want.srm);
  check(`${st} 1,220 requests, 6.10 / 6.10`, Math.round(req.canary / 100) === 1220 && Math.round(req.control / 100) === 1220 && (five.canary / 100).toFixed(2) === '6.10' && (five.control / 100).toFixed(2) === '6.10');
}
check('e-values and traffic quoted', has('1.02 (S) and 1.01 (X) for `http_5xx` and 1.00 for `p99_latency`') && has('1.058 (S) and 1.095 (X)') && has('1,220 requests per arm per tick') && has('6.10 / 6.10'));
// shares
for (const st of ['S', 'X']) {
  const e = ex.filter((r) => r.stratum === st); const sh = e.map((r) => r.p99_canary_worse_share), sm = e.map((r) => r.p99_canary_worse_share_margin);
  const want = st === 'S' ? '0.333–0.633' : '0.300–0.650';
  check(`${st} shares`, `${q(sh, 0).toFixed(3)}–${q(sh, 0.999).toFixed(3)}` === want && q(sh, 0.5).toFixed(3) === '0.500' && q(sm, 0).toFixed(3) === '0.000' && q(sm, 0.5).toFixed(3) === '0.050' && q(sm, 0.999).toFixed(3) === '0.117');
}
check('shares quoted', has('0.333–0.633 in S and 0.300–0.650 in X') && has('0.000–0.117 per run in both strata (median 0.050)'));
// registered replay
const m0 = replay.margins['0'], m5 = replay.margins['0.05'], m10 = replay.margins['0.1'];
check('replay: S 0 / X 1 at margin 0 (run 348 lane 2 tick 27); 0 at 0.05 and 0.10', replay.registered_report_only === true && replay.reproduces_as_run === true && replay.engine === '0.13.0-pre' && replay.runs === 200
  && m0.S.rollbacks === 0 && m0.X.rollbacks === 1 && m0.X.rollback_runs[0].run === 348 && m0.X.rollback_runs[0].lane === 2 && m0.X.rollback_runs[0].tick === 27
  && m5.S.rollbacks + m5.X.rollbacks === 0 && m10.S.rollbacks + m10.X.rollbacks === 0 && has('run 348, lane 2, tick 27') && has('**0 in S and 1 in X**'));
// watcher
const watch = readFileSync(join(STUDY, 'results', 'operator', 'onebox-watch.log'), 'utf8').split('\n').filter((l) => / S summaries=/.test(l));
check('watcher: 0 rollbacks at every tally', watch.length > 0 && watch.every((l) => /S summaries=\d+ rollbacks=0 \| X summaries=\d+ rollbacks=0/.test(l)));
for (const s of ['R1 held', 'R2 held', 'R3 NOT held', 'R4 held', 'R5 held', '0 false rollbacks in 344 real A/A runs', 'The margin is insurance here']) check(`quotes ${s}`, has(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${dirs[0]})`);

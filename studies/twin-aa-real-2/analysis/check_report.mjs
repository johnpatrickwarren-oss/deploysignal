// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const dirs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('exactly one analysis dir', dirs.length === 1 && dirs[0] === 'run-20261002T011901Z' && report.includes(dirs[0]));
const R = join(STUDY, 'results', dirs[0]);
const E = JSON.parse(readFileSync(join(R, 'endpoints.json'), 'utf8'));
const runs = JSON.parse(readFileSync(join(R, 'runs.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(R, 'manifest.json'), 'utf8'));
const replay = JSON.parse(readFileSync(join(R, 'replay-posthoc.json'), 'utf8'));
const files = readdirSync(join(STUDY, 'results', 'runs'));
check('100 summaries, 100 jsonl, 100 runs, indices 83–182', files.filter((f) => f.endsWith('.summary.json')).length === 100 && files.filter((f) => f.endsWith('.jsonl')).length === 100 && runs.length === 100 && runs[0].run === 83 && runs[99].run === 182 && report.includes('83–182'));
check('pin: every run from ded4d27 on engine 0.13.0-pre de25786', M.runner_repo_shas.length === 1 && M.runner_repo_shas[0].startsWith('ded4d27') && M.engines.length === 1 && M.engines[0].version === '0.13.0-pre' && M.engines[0].resolved.endsWith('de25786c0a6b15935aa9416b04359f6a3e309106') && report.includes('ded4d27') && report.includes('de25786c'));
check('analysis script unmodified at run time and committed before run 0', M.committed_before_run_0 === true && M.analysis_tracked_changes.length === 0);
// endpoints recomputed from runs.json
const exec = runs.filter((r) => r.executable); const rb = exec.filter((r) => r.scored.verdict === 'rollback');
check('E1 recomputed: 0 of 100, upper bound 0.030', exec.length === 100 && rb.length === 0 && E.E1.rollbacks === 0 && E.E1.executable === 100 && E.E1.verdict === 'PASS' && Math.abs(E.E1.cp_upper95 - 0.0295) < 6e-4 && E.stop_rule_tripped === false && report.includes('E1: PASS') && report.includes('0.030'));
check('E2, E3', E.E2.count === 0 && E.E2.verdict === 'PASS' && E.E3.halts === 0 && E.E3.attempted === 100 && E.E3.verdict === 'PASS' && runs.every((r) => r.scored.verdict === 'hold' && r.scored.ticks === 60) && report.includes('E2: PASS') && report.includes('E3: PASS'));
check('void rules: none (V1–V5, V8), V6/V7 flag none on 100', E.void === 0 && runs.every((r) => r.void_reasons.length === 0 && r.v8_out_of_scale_control_p99.length === 0) && E.v67.evaluated_runs === 100 && E.v67.flagged_runs.length === 0 && E.authority_violations === 0 && E.any_unhealthy_target_runs.length === 0);
// the one unattributed ECS TaskCreated (lane 0's scale-up for run 167, 66 s after its `scale`), inside runs 165 and 166 on other lanes
const un = E.v67.unassigned_inside_runs;
check('one unassigned TaskCreated, in runs 165 and 166, explained in the report', un.length === 2 && un.map((u) => u.run).join(',') === '165,166' && un.every((u) => u.events.length === 1 && u.events[0].name === 'TaskCreated' && u.events[0].id === '6f67c459-d095-4a58-941d-721f8c612733')
  && runs.find((r) => r.run === 165).lane === 2 && runs.find((r) => r.run === 166).lane === 3 && runs.find((r) => r.run === 167).lane === 0 && runs.find((r) => r.run === 167).arm_ready === '2026-10-01T19:42:55Z'
  && report.includes('19:42:31Z') && report.includes('runs 165 (lane 2) and 166 (lane 3)') && report.includes('66 s earlier'));
check('W0 holds in all 100', runs.every((r) => r.w0.verdict === 'hold' && r.w0.ticks === 75) && E.P4.w0_rollbacks === 0);
check('per lane 25/25/0/25', E.per_lane.every((l) => l.attempts === 25 && l.executable === 25 && l.rollbacks === 0 && l.holds === 25) && (report.match(/\| \d \| 25 \| 25 \| 0 \| 25 \|/g) ?? []).length === 4);
const evidence = JSON.parse(readFileSync(join(STUDY, 'results', 'evidence', 'cloudtrail-write-events.json'), 'utf8'));
check('CloudTrail evidence: 2,046 events, no account id', evidence.count === 2046 && report.includes('2,046 write events') && !JSON.stringify(evidence).includes('556890483612'));
// descriptives
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const share = exec.map((r) => r.p99_canary_worse_share), shareM = exec.map((r) => r.p99_canary_worse_share_margin_0_10), cp = exec.map((r) => r.median_control_p99_s * 1000);
check('unmargined share 0.350–0.650, median 0.500', Math.abs(q(share, 0) - 0.35) < 5e-4 && Math.abs(q(share, 0.5) - 0.5) < 5e-4 && Math.abs(q(share, 0.999) - 0.65) < 5e-4 && report.includes('0.350 to 0.650, median 0.500'));
check('margined share 0.000–0.100, median 0.050', q(shareM, 0) === 0 && Math.abs(q(shareM, 0.5) - 0.05) < 5e-4 && Math.abs(q(shareM, 0.999) - 0.1) < 5e-4 && report.includes('0.000–0.100 per run (median 0.050)'));
check('control p99 75.4–78.2 ms, median 76.3', q(cp, 0).toFixed(1) === '75.4' && q(cp, 0.5).toFixed(1) === '76.3' && q(cp, 0.999).toFixed(1) === '78.2' && report.includes('75.4–78.2 ms') && report.includes('median 76.3'));
// traffic, pooled 5xx and the largest e-values, from the stored tick bodies
let ev = 0, tot = 0, maxRate = 0, maxSign = 0;
for (const r of exec) {
  const lines = readFileSync(join(STUDY, 'results', 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick);
  for (const w of lines) {
    const h = w.body.observations.http_5xx; ev += h.canary_events + h.control_events; tot += h.canary_total + h.control_total;
    for (const m of w.scored.metrics ?? []) { if (m.id === 'http_5xx') maxRate = Math.max(maxRate, m.rollback_e); else maxSign = Math.max(maxSign, m.rollback_e); }
  }
}
check('pooled 5xx 0.0050 over 73,177 / 14,637,652', ev === 73177 && tot === 14637652 && (ev / tot).toFixed(4) === '0.0050' && report.includes('73,177 of 14,637,652'));
check('largest e-values 1.13 (rate), 1.00 (sign)', maxRate.toFixed(2) === '1.13' && maxSign.toFixed(2) === '1.00' && report.includes('1.13 for `http_5xx` and 1.00 for `p99_latency`'));
const meanReq = (k) => Math.round(exec.reduce((a, r) => a + r.mean_requests[k], 0) / exec.length);
const mean5 = (k) => (exec.reduce((a, r) => a + r.mean_5xx[k], 0) / exec.length).toFixed(2);
check('1,220 requests per arm; 6.10 / 6.09 5xx per tick', meanReq('canary') === 1220 && meanReq('control') === 1220 && mean5('canary') === '6.10' && mean5('control') === '6.09' && report.includes('1,220 requests per arm per tick') && report.includes('6.10 / 6.09'));
// post-hoc replay
check('replay: 1 / 0 / 0 rollbacks at margins 0 / 0.05 / 0.10; run 128 tick 27', replay.post_hoc === true && replay.reproduces_as_run === true && replay.engine === '0.13.0-pre' && replay.margins['0'].rollbacks === 1 && replay.margins['0'].rollback_runs[0].run === 128 && replay.margins['0'].rollback_runs[0].tick === 27 && replay.margins['0.05'].rollbacks === 0 && replay.margins['0.1'].rollbacks === 0 && report.includes('run 128, tick 27'));
for (const s of ['P1 held', 'P2 held', 'P3 held', 'P4 NOT held', 'P5 held', 'necessary and not sufficient', '0 false rollbacks in 144 real A/A runs']) check(`quotes ${s}`, report.includes(s));
check('quotes the margin was nearly idle here', /the\s+margin was nearly idle here/.test(report));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${dirs[0]})`);

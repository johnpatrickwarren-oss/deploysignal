// analysis/check_report.mjs — machine-checks REPORT.md against the four cells' artifacts. Exit 1 on drift.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const RES = join(STUDY, 'results');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
const CELLS = {
  'AB-lat30': { dir: 'ablat30-20261002T042957Z', attempts: 20, executable: 20, rollbacks: 20, median: 11, ticks: [11, 11], verdict: 'PASS', fired: 'twin_sign_p99_latency', p99: [99.3, 76.5], ms: [1, 1, 1], e5: [6.11, 6.15], req: [1220, 1220], elb: 0, srm: [0.99, 1.01], evidence: 448, repo: '163308f', unassigned: [191], flagged: [] },
  'AB-5xx-1.5': { dir: 'ab5xx15-20261002T133656Z', attempts: 20, executable: 20, rollbacks: 20, median: 40, ticks: [38, 42], verdict: 'PASS', fired: 'twin_rate_http_5xx', p99: [76.6, 76.1], ms: [0, 0.05, 0.15], e5: [9.17, 6.09], req: [1220, 1220], elb: 0, srm: [0.98, 1.05], evidence: 426, repo: '163308f', unassigned: [203, 204, 205, 206, 207, 212, 213, 214], flagged: [] },
  'AB-reset': { dir: 'abreset-20261002T204510Z', attempts: 20, executable: 20, rollbacks: 0, median: null, ticks: [null, null], verdict: 'reported, no bar', fired: null, p99: [76.7, 76.2], ms: [0, 0.05, 0.083], e5: [6.11, 6.11], req: [1219, 1221], elb: 6.09, srm: [0.97, 1.08], evidence: 415, repo: '163308f', unassigned: [], flagged: [] },
  'AB-reset-nr': { dir: 'abresetnr-20261003T001454Z', attempts: 21, executable: 20, rollbacks: 20, median: 12, ticks: [11, 12], verdict: 'PASS', fired: 'twin_rate_no_response', p99: [76.8, 76.9], ms: [0, 0, 0.167], e5: [6.13, 6.07], req: [1222, 1215], elb: 6.08, srm: [0.99, 1.05], evidence: 430, repo: 'b1b1ac3', unassigned: [], flagged: [260], nr: [6.08, 0] },
};
const near = (a, b, tol = 5e-3) => a != null && b != null && Math.abs(a - b) <= tol;
const dirs = readdirSync(RES).filter((d) => /^(ablat30|ab5xx15|abreset|abresetnr)-\d{8}T\d{6}Z$/.test(d)).sort();
check('exactly four analysis dirs', dirs.length === 4 && Object.values(CELLS).every((c) => dirs.includes(c.dir) && report.includes(c.dir)));
let halts = 0, attempts = 0;
for (const [cell, X] of Object.entries(CELLS)) {
  const E = JSON.parse(readFileSync(join(RES, X.dir, 'endpoints.json'), 'utf8'));
  const runs = JSON.parse(readFileSync(join(RES, X.dir, 'runs.json'), 'utf8'));
  const M = JSON.parse(readFileSync(join(RES, X.dir, 'manifest.json'), 'utf8'));
  halts += E.halts; attempts += E.attempts;
  const exec = runs.filter((r) => r.executable); const rb = exec.filter((r) => r.scored.verdict === 'rollback');
  const ticks = rb.map((r) => r.scored.ticks).sort((a, b) => a - b);
  check(`${cell}: counts`, E.cell === cell && E.attempts === X.attempts && E.executable === X.executable && exec.length === X.executable && rb.length === X.rollbacks && E.power.rollbacks === X.rollbacks && E.verdict === X.verdict && E.halts === 0 && E.authority_violations === 0 && M.analysis_tracked_changes.every((l) => /results\/operator\/cell-revisions\.json$/.test(l))); // the V9 record is appended to before each cell's run 0
  check(`${cell}: ticks`, (X.median === null ? E.power.median_rollback_tick === null && ticks.length === 0 : E.power.median_rollback_tick === X.median && ticks[0] === X.ticks[0] && ticks[ticks.length - 1] === X.ticks[1]));
  check(`${cell}: fired`, X.fired === null ? Object.keys(E.fired_by_detector).length === 0 : (E.fired_by_detector[X.fired] === X.rollbacks && Object.keys(E.fired_by_detector).length === 1 && rb.every((r) => r.fired.length === 1 && r.fired[0] === X.fired)));
  const d = E.descriptives;
  check(`${cell}: descriptives`, near(d.median_p99_ms.canary, X.p99[0], 0.051) && near(d.median_p99_ms.control, X.p99[1], 0.051) && near(d.margined_share.min, X.ms[0], 5e-4) && near(d.margined_share.median, X.ms[1], 5e-4) && near(d.margined_share.max, X.ms[2], 5e-4) && near(d.mean_5xx_per_tick.canary, X.e5[0]) && near(d.mean_5xx_per_tick.control, X.e5[1]) && Math.round(d.mean_requests_per_tick.canary) === X.req[0] && Math.round(d.mean_requests_per_tick.control) === X.req[1] && near(d.mean_elb_5xx_lb_per_tick, X.elb) && near(d.final_srm_e.min, X.srm[0]) && near(d.final_srm_e.max, X.srm[1]));
  if (X.nr) check(`${cell}: unanswered requests`, near(d.mean_no_response_per_tick.canary, X.nr[0]) && near(d.mean_no_response_per_tick.control, X.nr[1]) && report.includes('6.08 / 0.00'));
  check(`${cell}: pin, V9, V6/V7`, E.repo_shas.length === 1 && E.repo_shas[0].startsWith(X.repo) && E.engines.length === 1 && E.engines[0].version === '0.13.0-pre' && runs.every((r) => !r.void_reasons.some((v) => v.startsWith('V9') || v.startsWith('V8'))) && E.v67.evaluated_runs === runs.length && E.v67.flagged_runs.join(',') === X.flagged.join(',') && E.v67.unassigned_inside_runs.join(',') === X.unassigned.join(','));
  const ev = JSON.parse(readFileSync(join(RES, 'evidence', `cloudtrail-write-events-${cell.toLowerCase().replace(/[^a-z0-9]/g, '')}.json`), 'utf8'));
  check(`${cell}: evidence ${X.evidence}, no account id`, ev.count === X.evidence && !JSON.stringify(ev).includes('556890483612'));
  const summaries = readdirSync(join(RES, 'runs')).filter((f) => f.startsWith(`${cell}-l`) && f.endsWith('.summary.json'));
  check(`${cell}: ${X.attempts} summaries on disk`, summaries.length === X.attempts);
}
check('F4: 0 halts over 81 attempts', halts === 0 && attempts === 81 && report.includes('0 of 81 attempts'));
// run 260: void by the committed rule, its own verdict reported; run 263 the replacement
const nr = JSON.parse(readFileSync(join(RES, CELLS['AB-reset-nr'].dir, 'runs.json'), 'utf8'));
const r260 = nr.find((r) => r.run === 260), r263 = nr.find((r) => r.run === 263);
check('run 260 void (TaskCreated 22:57:39Z), rollback at 11 reported; run 263 executable rollback at 12', r260.lane === 1 && !r260.executable && r260.void_reasons.length === 1 && /^V6\/V7 .*TaskCreated@2026-10-02T15:57:39-07:00/.test(r260.void_reasons[0]) && r260.scored.verdict === 'rollback' && r260.scored.ticks === 11 && r260.arm_ready === '2026-10-02T22:57:36Z' && r263.lane === 1 && r263.executable && r263.scored.verdict === 'rollback' && r263.scored.ticks === 12 && report.includes('22:57:39Z') && report.includes('run 263 replaced it'));
const rev = JSON.parse(readFileSync(join(RES, 'operator', 'cell-revisions.json'), 'utf8'));
check('cell revisions recorded for all four cells', ['AB-lat30', 'AB-5xx-1.5', 'AB-reset', 'AB-reset-nr'].every((c) => rev[c] && Object.keys(rev[c]).length === 4) && rev['AB-reset']['0'] === rev['AB-reset-nr']['0']);
for (const s of ['F1: PASS', 'F2: PASS', 'F5: PASS', '0/20', 'Q2\'s power range (0.6–0.9) was too low (1.0)', 'planned 26', 'observed 25–26', 'evenly spaced per process', 'has not run in an A/A']) check(`quotes ${s}`, report.includes(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('check_report: all checks passed (four cells)');

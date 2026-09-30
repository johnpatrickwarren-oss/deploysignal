// analysis/check_report.mjs — machine-checks REPORT.md against the run artifacts. Exit 1 on drift.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const report = readFileSync(join(STUDY, 'REPORT.md'), 'utf8');
const dirs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('run-')).sort();
let failed = 0; const check = (n, ok) => { if (!ok) { console.error(`FAIL ${n}`); failed++; } };
check('exactly one analysis dir', dirs.length === 1 && dirs[0] === 'run-20260929T200357Z' && report.includes(dirs[0]));
const R = join(STUDY, 'results', dirs[0]);
const E = JSON.parse(readFileSync(join(R, 'endpoints.json'), 'utf8'));
const runs = JSON.parse(readFileSync(join(R, 'runs.json'), 'utf8'));
const M = JSON.parse(readFileSync(join(R, 'manifest.json'), 'utf8'));
const summaries = readdirSync(join(STUDY, 'results', 'runs')).filter((f) => f.startsWith('AA-') && f.endsWith('.summary.json'));
check('44 AA summaries, 44 runs, 44 jsonl', summaries.length === 44 && runs.length === 44 && readdirSync(join(STUDY, 'results', 'runs')).filter((f) => f.startsWith('AA-') && f.endsWith('.jsonl')).length === 44);
// AB-5xx cell (§5 E4, P6), analysed by the same script with --cell AB-5xx into results/ab5xx-<UTC>/
const abDirs = readdirSync(join(STUDY, 'results')).filter((d) => d.startsWith('ab5xx-')).sort();
check('exactly one AB-5xx analysis dir', abDirs.length === 1 && abDirs[0] === 'ab5xx-20260930T031426Z' && report.includes(abDirs[0]));
const AB = JSON.parse(readFileSync(join(STUDY, 'results', abDirs[0], 'endpoints.json'), 'utf8'));
const abRuns = JSON.parse(readFileSync(join(STUDY, 'results', abDirs[0], 'runs.json'), 'utf8'));
const abSummaries = readdirSync(join(STUDY, 'results', 'runs')).filter((f) => f.startsWith('AB-5xx-') && f.endsWith('.summary.json'));
check('AB-5xx: 20 attempts, 20 executable, 20 rollbacks', abSummaries.length === 20 && abRuns.length === 20 && AB.attempts === 20 && AB.executable === 20 && AB.void === 0 && AB.E4.rollbacks === 20 && AB.E4.executable === 20 && AB.E4.verdict === 'PASS' && AB.E3.halts === 0 && report.includes('E4: PASS') && report.includes('20 of 20'));
const abTicks = abRuns.filter((r) => r.executable && r.scored.verdict === 'rollback').map((r) => r.scored.ticks).sort((a, b) => a - b);
check('AB-5xx: median tick 25, P6 held', AB.E4.median_rollback_tick === 25 && abTicks[Math.floor(abTicks.length / 2)] === 25 && AB.P6.held === true && abTicks.join(',') === '11,11,13,14,25,25,25,25,25,25,25,25,26,26,26,26,26,26,26,26' && report.includes('median rollback tick 25'));
check('AB-5xx: rate fired in 16, sign first in 4 (68, 74, 75, 80)', AB.E4.fired_rate === 16 && AB.E4.fired_sign_only.map((x) => x.run).join(',') === '68,74,75,80' && abRuns.filter((r) => r.fired.includes('twin_rate_http_5xx')).length === 16 && report.includes('16 of 20') && /68, 74, 75 and\s+80/.test(report));
check('AB-5xx: 5xx per tick 12.21 / 6.1, V6/V7 clean, no authority violation', AB.mean_5xx_per_tick.canary === 12.21 && AB.mean_5xx_per_tick.control === 6.1 && AB.v67.evaluated_runs === 20 && AB.v67.flagged_runs.length === 0 && AB.authority_violations === 0 && abRuns.every((r) => r.repo_sha.startsWith('61794dc') && r.engine.version === '0.12.2-pre') && report.includes('12.21') && report.includes('6.10'));
const abEvidence = JSON.parse(readFileSync(join(STUDY, 'results', 'evidence', 'cloudtrail-write-events-ab5xx.json'), 'utf8'));
check('AB-5xx evidence: 318 events, four identities, no account id', abEvidence.count === 318 && report.includes('318 write events') && !JSON.stringify(abEvidence).includes('556890483612'));
check('runner commit and engine', M.runner_repo_shas.length === 1 && M.runner_repo_shas[0].startsWith('61794dc') && M.engines.length === 1 && M.engines[0].version === '0.12.2-pre' && M.engines[0].resolved.endsWith('0434afcdc7a4716788dc81427295c6c4cd14e019') && report.includes('61794dc') && report.includes('v0.12.2-pre'));
check('attempts', E.attempts === 63 && E.deploy_failures === 17 && E.interrupted_attempts.length === 2 && E.runs_with_runner === 44 && report.includes('0 of 63') && report.includes('deploy failures 17'));
// E1 recomputed from runs.json, not from endpoints.json
const exec = runs.filter((r) => r.executable); const rb = exec.filter((r) => r.scored.verdict === 'rollback');
check('E1 recomputed', exec.length === 44 && rb.length === 12 && E.E1.rollbacks === 12 && E.E1.executable === 44 && E.E1.verdict === 'FAIL' && Math.abs(E.E1.rate - 0.2727) < 5e-5 && Math.abs(E.E1.cp_lower95 - 0.166) < 5e-4 && Math.abs(E.E1.cp_upper95 - 0.404) < 5e-4 && E.stop_rule_tripped === true);
check('E2, E3', E.E2.count === 12 && E.E2.verdict === 'FAIL' && runs.filter((r) => r.counts_for_e2).length === 12 && E.E3.halts === 0 && E.E3.verdict === 'PASS' && runs.every((r) => r.scored.verdict !== 'halt'));
check('void / authority / health', E.void === 0 && runs.every((r) => r.void_reasons.length === 0) && E.authority_violations === 0 && E.any_unhealthy_target_runs.length === 0);
check('V6/V7', E.v67.evaluated_runs === 44 && E.v67.flagged_runs.length === 0 && E.v67.unassigned_inside_runs.length === 0 && runs.every((r) => r.v67.evaluated && r.v67.events_inside.length === 0));
const evidence = JSON.parse(readFileSync(join(STUDY, 'results', 'evidence', 'cloudtrail-write-events.json'), 'utf8'));
const idents = new Set(evidence.events.map((e) => e.identity.replace(/\/i-.*$/, '').replace(/\/ecs-.*$/, '')));
check('CloudTrail evidence', evidence.count === 757 && report.includes('757 write events') && idents.size === 3 && [...idents].every((i) => /twin-aa-operator-instance|AWSServiceRoleForECS|ecs\.amazonaws\.com/.test(i)) && !JSON.stringify(evidence).includes('556890483612'));
check('predictions', E.P1.held === false && E.P2.held === false && E.P3.held === true && E.P4.held === false && E.P4.w0_rollbacks === 14 && runs.filter((r) => r.w0.verdict === 'rollback').length === 14 && report.includes('14 of 44'));
const expectLane = { 0: [18, 11, 3, 8], 1: [16, 11, 4, 7], 2: [15, 11, 3, 8], 3: [14, 11, 2, 9] };
for (const l of E.per_lane) { const [a, x, r, h] = expectLane[l.lane]; check(`lane ${l.lane}`, l.attempts === a && l.executable === x && l.rollbacks === r && l.holds === h && report.includes(`| ${l.lane} | ${a} | ${x} | ${r} | ${h} |`)); }
const expectRb = { 26: [3, 19, 32, 0.842], 29: [1, 11, 13, 1.0], 32: [3, 13, 27, 0.923], 35: [2, 11, 21, 1.0], 39: [0, 14, 13, 0.929], 44: [1, 13, 22, 0.923], 45: [2, 33, 32, 0.758], 47: [1, 13, 17, 0.923], 54: [1, 48, 62, 0.729], 57: [2, 11, 16, 1.0], 59: [0, 31, 41, 0.774], 62: [0, 23, 16, 0.826] };
check('rollback set', rb.map((r) => r.run).join(',') === Object.keys(expectRb).join(','));
for (const r of rb) { const [lane, st, wt, share] = expectRb[r.run]; check(`rollback ${r.run}`, r.lane === lane && r.scored.ticks === st && r.w0.ticks === wt && Math.abs(r.p99_canary_worse_share - share) < 5e-4 && r.fired.length === 1 && r.fired[0] === 'twin_sign_p99_latency' && report.includes(`| ${r.run} | ${lane} | ${st} | ${wt} |`)); }
check('fired by detector', Object.keys(E.fired_by_detector).length === 1 && E.fired_by_detector.twin_sign_p99_latency === 12);
const ticks = rb.map((r) => r.scored.ticks).sort((a, b) => a - b);
check('median rollback tick 14, range 11–48', ticks[Math.floor(ticks.length / 2)] === 14 && ticks[0] === 11 && ticks[ticks.length - 1] === 48 && report.includes('Median scored rollback tick 14 (range 11–48)'));
const holds = exec.filter((r) => r.scored.verdict === 'hold').map((r) => r.p99_canary_worse_share).sort((a, b) => a - b);
check('hold shares', holds.length === 32 && holds.filter((s) => s <= 0.2).length === 10 && holds[0] === 0 && Math.abs(holds[Math.floor(holds.length / 2)] - 0.300) < 5e-4 && Math.abs(holds[holds.length - 1] - 0.683) < 5e-4 && Math.min(...rb.map((r) => r.p99_canary_worse_share)) > 0.728 && report.includes('0–68% (median 0.300)') && report.includes('in 10 holds'));
// traffic and the pooled 5xx rate, recomputed from the stored tick bodies
let ev = 0, tot = 0, reqC = 0, reqK = 0, n = 0;
for (const r of exec) {
  const lines = readFileSync(join(STUDY, 'results', 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick);
  for (const w of lines) { const h = w.body.observations.http_5xx; ev += h.canary_events + h.control_events; tot += h.canary_total + h.control_total; reqC += w.body.canary_requests; reqK += w.body.control_requests; n++; }
}
check('pooled 5xx 0.0050 over 26,304 / 5,259,682', ev === 26304 && tot === 5259682 && (ev / tot).toFixed(4) === '0.0050' && report.includes('26,304 of 5,259,682') && report.includes('**0.0050**'));
// the report's per-arm figure is the mean over runs of each run's mean over the ticks its scored session used (runs.json)
const meanOf = (k) => Math.round(exec.reduce((a, r) => a + r.mean_requests[k], 0) / exec.length);
check('requests per minute per arm', meanOf('canary') === 1217 && meanOf('control') === 1218 && Math.round(reqC / n) >= 1200 && Math.round(reqK / n) >= 1200 && report.includes('canary 1,217, control 1,218'));
// the margin scan quoted in §3
const MARGINS = [0, 0.05, 0.1, 0.25, 0.5, 1.0]; const counts = MARGINS.map(() => 0);
for (const r of exec) {
  const lines = readFileSync(join(STUDY, 'results', 'runs', r.file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window' && l.scored_tick).slice(0, r.scored.ticks);
  const p = lines.map((w) => w.body.observations.p99_latency);
  MARGINS.forEach((m, i) => { if (p.filter((o) => o.canary > o.control * (1 + m)).length / p.length >= 0.65) counts[i]++; });
}
check('margin scan 15/8/6/3/1/0', counts.join('/') === '15/8/6/3/1/0' && report.includes('15 at m = 0, 8 at 0.05, 6 at 0.10, 3 at 0.25, 1 at 0.50 and\n0 at 1.00'));
for (const s of ['E1: FAIL', 'E2: FAIL', 'E3: PASS', '12 of 44', '0.2727', '0.166–0.404', 'P1 not held, P2 not held, P3 held', 'Stopped by the registered rule', '18:47:54Z', 'twin-contrast.ts:154-155', 'rotate-arms.sh:91']) check(`quotes ${s}`, report.includes(s));
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`check_report: all checks passed (${dirs[0]})`);

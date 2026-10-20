// analysis/analyze.mjs — endpoint table for 2026-10-twin-aa-noresponse (PREREGISTRATION.md §§1–5).
// Committed BEFORE run 0. The onebox study's analysis (studies/twin-aa-onebox/analysis/analyze.mjs) with one
// cell and its endpoints N1–N4, V9 on both arms, and the no_response readouts.
//
//   node studies/twin-aa-noresponse/analysis/analyze.mjs
//
// Reads, never writes, the run artifacts:
//   results/runs/AA-nr-l<lane>-r<k>-<UTC>.{summary.json,jsonl}   the runner's files
//   results/operator/runs/AA-nr-l<lane>-r<k>.ndjson               the driver's log per attempt (tasks' AZs and revisions)
//   results/operator/cell-revisions.json                          { "AA-nr": { "<lane>": "<shared task-definition family:revision>" } },
//                                                                 written before run 0 (V9)
//   results/evidence/cloudtrail-write-events.json                 cloudtrail-evidence.mjs output over the cell (V6/V7)
// and writes results/run-<UTC>/ (manifest.json, endpoints.json, runs.json, REPORT-TABLE.md), refusing an
// existing directory. Verdicts as registered; no bare catch (a malformed artifact throws).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const RES = join(STUDY, 'results');
export const CELL = 'AA-nr';
// §1.3, §2: 100 executable, B = 0.1062 → at most 10 of 100, stop at 11, 150 attempts cap; N4's base-rate band
export const REG = { R: 100, B: 0.1062, max_rollbacks: 10, stop_after_rollbacks: 11, attempt_cap: 150, n2_max_halts: 2, n4_lo: 3, n4_hi: 12, offset_excess: 10, margin: 0.10, v8_lo_s: 0.020, v8_hi_s: 0.400 };
// inherited from the onebox study's §1.2; strata are report-only here (§1.3)
export const PLACEMENT = {
  0: { stratum: 'S', baseline: 'us-east-1a', canary: 'us-east-1a' },
  1: { stratum: 'S', baseline: 'us-east-1b', canary: 'us-east-1b' },
  2: { stratum: 'X', baseline: 'us-east-1a', canary: 'us-east-1b' },
  3: { stratum: 'X', baseline: 'us-east-1b', canary: 'us-east-1a' },
};
const NR_DETECTOR = 'twin_rate_no_response';
const toMs = (t) => { const ms = Date.parse(t); if (Number.isNaN(ms)) throw new Error(`bad time ${t}`); return ms; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const range = (xs) => (xs.length ? { min: Math.min(...xs), median: median(xs), max: Math.max(...xs) } : { min: null, median: null, max: null });

/** N4 (§2): the median over executable runs of the per-run mean unanswered requests per scored tick, in each arm, lies in [lo, hi]. */
export function n4Verdict(perRunMeans, lo = REG.n4_lo, hi = REG.n4_hi) {
  const c = median(perRunMeans.map((x) => x.canary)), k = median(perRunMeans.map((x) => x.control));
  const ok = c !== null && k !== null && c >= lo && c <= hi && k >= lo && k <= hi;
  return { median_canary: c, median_control: k, verdict: ok ? 'PASS' : 'FAIL (NOT EXECUTABLE for its purpose)' };
}

function main() {
  // ---------- artifacts ----------
  const prefix = `${CELL}-l`;
  const runFiles = readdirSync(join(RES, 'runs')).filter((f) => f.startsWith(prefix) && f.endsWith('.summary.json')).sort();
  const driver = new Map();
  for (const f of readdirSync(join(RES, 'operator', 'runs')).filter((x) => x.startsWith(prefix) && x.endsWith('.ndjson'))) {
    const lines = readFileSync(join(RES, 'operator', 'runs', f), 'utf8').split('\n').filter(Boolean).map((l) => (/^[[{]/.test(l) ? JSON.parse(l) : { raw: l }));
    const m = /^AA-nr-l(\d)-r(\d+)\.ndjson$/.exec(f); if (!m) throw new Error(`driver file name ${f}`);
    const ev = (name) => lines.find((l) => !Array.isArray(l) && l.event === name);
    driver.set(Number(m[2]), {
      file: f, lane: Number(m[1]), run: Number(m[2]), arm_ready: ev('arm_ready')?.t ?? null, runner_start: ev('runner_start')?.t ?? null,
      runner_exit: ev('runner_exit')?.t ?? null, runner_exit_code: ev('runner_exit')?.exit ?? null, deploy_failure: ev('deploy_failure') ?? null,
      tasks: lines.filter((l) => !Array.isArray(l) && l.service && Array.isArray(l.tasks)).map((l) => ({ service: l.service, tasks: l.tasks.map((t) => ({ az: t.az, td: (t.td ?? '').replace(/^.*task-definition\//, ''), status: t.status })) })),
    });
  }
  const revPath = join(RES, 'operator', 'cell-revisions.json');
  const revisions = existsSync(revPath) ? JSON.parse(readFileSync(revPath, 'utf8'))[CELL] ?? null : null;
  const evidencePath = join(RES, 'evidence', 'cloudtrail-write-events.json');
  const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;

  // ---------- per run ----------
  const runs = [];
  for (const file of runFiles) {
    const s = JSON.parse(readFileSync(join(RES, 'runs', file), 'utf8'));
    const d = driver.get(s.run) ?? null;
    const place = PLACEMENT[s.lane]; if (!place) throw new Error(`lane ${s.lane}`);
    const windows = readFileSync(join(RES, 'runs', file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window');
    const scored = windows.filter((w) => w.scored_tick);
    const last = scored[scored.length - 1];
    const p99 = scored.map((w) => w.body?.observations?.p99_latency).filter((o) => o && typeof o.canary === 'number' && typeof o.control === 'number');
    const bodies = scored.map((w) => w.body).filter(Boolean);
    const nr = bodies.map((b) => b.observations?.no_response).filter(Boolean);
    if (nr.length !== bodies.length) throw new Error(`${file}: ${bodies.length - nr.length} scored tick(s) without a no_response observation`);
    const v8 = p99.filter((o) => o.control < REG.v8_lo_s || o.control > REG.v8_hi_s).map((o) => o.control);
    const armReady = d?.arm_ready ?? new Date(s.arm_ready_ms).toISOString();
    const runEnd = d?.runner_exit ?? new Date(s.ended_at_ms).toISOString();
    const t0 = toMs(armReady), t1 = toMs(runEnd);
    // V6/V7 as the onebox study's Amendment 3: only events naming the lane decide; lane-less events are listed
    let v67 = { evaluated: false, events_inside: [], unassigned_inside: [] };
    if (evidence) {
      const inside = evidence.events.filter((e) => { const t = toMs(e.t); return t > t0 && t < t1; });
      v67 = { evaluated: toMs(evidence.start) <= t0 && toMs(evidence.end) >= t1,
        events_inside: inside.filter((e) => e.lane === s.lane).map((e) => ({ t: e.t, name: e.name, id: e.id, identity: e.identity })),
        unassigned_inside: inside.filter((e) => e.lane === null).map((e) => ({ t: e.t, name: e.name, id: e.id })) };
    }
    const tasksOf = (svc) => (d?.tasks ?? []).filter((x) => x.service === svc).flatMap((x) => x.tasks);
    const base = tasksOf('baseline-old'), can = tasksOf('canary-new');
    const baseAz = base.map((t) => t.az), canAz = can.map((t) => t.az);
    const tds = [...new Set([...base, ...can].map((t) => t.td))];
    const void_reasons = [...s.void_reasons];
    if (v8.length) void_reasons.push(`V8 latency scale: ${v8.length} scored tick(s) with control p99 outside 20–400 ms (first ${v8[0]} s)`);
    if (v67.evaluated && v67.events_inside.length) void_reasons.push(`V6/V7 write event on the lane's resources inside the run: ${v67.events_inside.map((e) => `${e.name}@${e.t}`).join(', ')}`);
    if (baseAz.length !== 1 || canAz.length !== 1 || baseAz[0] !== place.baseline || canAz[0] !== place.canary) {
      void_reasons.push(`V10 placement: baseline [${baseAz.join(',') || 'unrecorded'}] canary [${canAz.join(',') || 'unrecorded'}], registered ${place.baseline} / ${place.canary}`);
    }
    // V9 (§5): both arms on the shared revision recorded for this lane before run 0
    const expected = revisions?.[String(s.lane)] ?? null;
    if (!expected) void_reasons.push('V9 not evaluable: no recorded revision for this lane (results/operator/cell-revisions.json)');
    else if (tds.length !== 1 || tds[0] !== expected) void_reasons.push(`V9 arm revision(s) ${tds.join('|') || 'unrecorded'} are not the cell's ${expected}`);
    const nrE = scored.map((w) => (w.scored?.metrics ?? []).find((m) => m.id === 'no_response')?.rollback_e).filter((x) => typeof x === 'number');
    runs.push({
      run: s.run, lane: s.lane, stratum: place.stratum, file, arm_ready: armReady, runner_exit: runEnd, runner_exit_code: d?.runner_exit_code ?? null,
      complete: s.complete, operator_abort: !!s.operator_abort, void_reasons, runner_void_reasons: s.void_reasons,
      executable: s.complete === true && void_reasons.length === 0 && !s.operator_abort,
      scored: { verdict: s.scored?.verdict, ticks: s.scored?.ticks }, w0: { verdict: s.w0?.verdict, ticks: s.w0?.ticks },
      fired: last ? (last.scored?.metrics ?? []).filter((m) => m.rollback_e >= m.rollback_threshold).map((m) => m.detector_id) : [],
      authority_violation: s.authority?.violation ?? null, repo_sha: s.manifest?.repo_sha, engine: s.manifest?.engine, config_sha256: s.manifest?.config_sha256,
      baseline_az: baseAz, canary_az: canAz, task_definitions: tds, v67,
      mean_no_response: { canary: mean(nr.map((o) => o.canary_events)), control: mean(nr.map((o) => o.control_events)) },
      no_response_zero_both_share: nr.length ? nr.filter((o) => o.canary_events === 0 && o.control_events === 0).length / nr.length : null,
      no_response_control_excess_ticks: nr.filter((o) => o.control_events - o.canary_events > REG.offset_excess).length,
      no_response_canary_excess_ticks: nr.filter((o) => o.canary_events - o.control_events > REG.offset_excess).length,
      no_response_max_rollback_e: nrE.length ? Math.max(...nrE) : null,
      p99_canary_worse_share_margin: p99.length ? p99.filter((o) => o.canary > o.control * (1 + REG.margin)).length / p99.length : null,
      median_p99_s: { canary: median(p99.map((o) => o.canary)), control: median(p99.map((o) => o.control)) },
      mean_requests: { canary: mean(bodies.map((b) => b.canary_requests)), control: mean(bodies.map((b) => b.control_requests)) },
      mean_5xx: { canary: mean(bodies.map((b) => b.observations?.http_5xx?.canary_events ?? 0)), control: mean(bodies.map((b) => b.observations?.http_5xx?.control_events ?? 0)) },
      final_srm_e: last?.scored?.srm_e ?? null,
    });
  }
  runs.sort((a, b) => a.run - b.run);

  // ---------- endpoints ----------
  const attempts = [...driver.values()];
  const exec = runs.filter((r) => r.executable); const rb = exec.filter((r) => r.scored.verdict === 'rollback');
  const stopped = rb.length >= REG.stop_after_rollbacks;
  const sens = runs.filter((r) => r.scored.verdict === 'rollback' || (!r.executable && r.w0.verdict === 'rollback') || r.operator_abort).length;
  const halts = runs.filter((r) => r.scored.verdict === 'halt');
  const n4 = n4Verdict(exec.map((r) => r.mean_no_response));
  const n1Verdict = stopped ? 'FAIL' : exec.length >= REG.R ? (rb.length <= REG.max_rollbacks ? 'PASS' : 'FAIL') : attempts.length >= REG.attempt_cap ? 'NOT EXECUTABLE (150 attempts without 100 executable)' : 'NOT SCORED (cell incomplete)';
  const stratum = (name) => { const rs = exec.filter((r) => r.stratum === name); return { executable: rs.length, rollbacks: rs.filter((r) => r.scored.verdict === 'rollback').length }; };
  const E = {
    registered: REG, placement: PLACEMENT, cell: CELL,
    attempts: attempts.length, deploy_failures: attempts.filter((a) => a.deploy_failure && !a.runner_start).map((a) => a.run), summaries: runs.length,
    N1: { executable: exec.length, rollbacks: rb.length, rate: exec.length ? rb.length / exec.length : null, stop_rule_tripped: stopped, verdict: n1Verdict,
      void_runs: runs.filter((r) => !r.executable).map((r) => ({ run: r.run, reasons: r.void_reasons })),
      rollbacks_by_run: rb.map((r) => ({ run: r.run, lane: r.lane, tick: r.scored.ticks, fired: r.fired })),
      fired_by_detector: rb.reduce((m, r) => { for (const x of r.fired) m[x] = (m[x] ?? 0) + 1; return m; }, {}) },
    N2: { halts: halts.length, attempted: attempts.length, verdict: halts.length <= REG.n2_max_halts ? 'PASS' : 'FAIL' },
    N3: { count: sens, verdict: sens > REG.max_rollbacks ? 'FAIL' : stopped || exec.length >= REG.R ? 'PASS' : 'NOT SCORED' },
    N4: n4,
    report_only: {
      no_response_detector_fires: runs.filter((r) => r.fired.includes(NR_DETECTOR)).length,
      rate_5xx_detector_fires: runs.filter((r) => r.fired.includes('twin_rate_http_5xx')).length,
      unanswered_per_tick: { canary: range(exec.map((r) => r.mean_no_response.canary)), control: range(exec.map((r) => r.mean_no_response.control)) },
      zero_both_share: range(exec.map((r) => r.no_response_zero_both_share)),
      control_excess_ticks: exec.reduce((a, r) => a + r.no_response_control_excess_ticks, 0),
      canary_excess_ticks: exec.reduce((a, r) => a + r.no_response_canary_excess_ticks, 0),
      no_response_max_rollback_e: range(exec.map((r) => r.no_response_max_rollback_e).filter((x) => x !== null)),
      strata: { S: stratum('S'), X: stratum('X') },
      w0_rollbacks: runs.filter((r) => r.w0.verdict === 'rollback').length,
      margined_share: range(exec.map((r) => r.p99_canary_worse_share_margin)),
      median_control_p99_ms: range(exec.map((r) => r.median_p99_s.control * 1000)),
    },
    authority_violations: runs.filter((r) => r.authority_violation).length,
    v10_void_runs: runs.filter((r) => r.void_reasons.some((x) => x.startsWith('V10'))).map((r) => r.run),
    v9_void_runs: runs.filter((r) => r.void_reasons.some((x) => x.startsWith('V9'))).map((r) => r.run),
    v67: { evaluated_runs: runs.filter((r) => r.v67.evaluated).length, flagged_runs: runs.filter((r) => r.v67.events_inside.length).map((r) => r.run), unassigned_inside_runs: runs.filter((r) => r.v67.unassigned_inside.length).map((r) => r.run) },
    repo_shas: [...new Set(runs.map((r) => r.repo_sha))], engines: [...new Set(runs.map((r) => JSON.stringify(r.engine)))].map((x) => JSON.parse(x)),
  };

  // ---------- write ----------
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const OUT = join(RES, `run-${stamp}`);
  if (existsSync(OUT)) throw new Error(`${OUT} exists`);
  mkdirSync(OUT);
  const git = (c) => execSync(c, { cwd: STUDY, encoding: 'utf8' }).trim();
  const manifest = { study_id: '2026-10-twin-aa-noresponse', generated_at: new Date().toISOString(), analysis_repo_head: git('git rev-parse HEAD'),
    analysis_tracked_changes: git('git status --porcelain --untracked-files=no -- .').split('\n').filter(Boolean), committed_before_run_0: true,
    inputs: { summaries: runFiles.length, driver_logs: driver.size, revisions: revisions, evidence: evidence ? { count: evidence.count, start: evidence.start, end: evidence.end } : null },
    runner_repo_shas: E.repo_shas, engines: E.engines };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(E, null, 1) + '\n');
  writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 1) + '\n');
  const f = (x, n = 3) => (x == null ? '—' : x.toFixed(n));
  const rr = (o, n = 2) => `${f(o.min, n)}/${f(o.median, n)}/${f(o.max, n)}`;
  const R = E.report_only;
  const table = [
    `# Endpoint table — 2026-10-twin-aa-noresponse (generated ${manifest.generated_at})`, '',
    '| Endpoint | Registered | Observed | Verdict |', '|---|---|---|---|',
    `| N1 false rollback | ≤ ${REG.max_rollbacks} of ${REG.R} executable; stop at ${REG.stop_after_rollbacks} | ${E.N1.rollbacks}/${E.N1.executable} = ${f(E.N1.rate)} | ${E.N1.verdict} |`,
    `| N2 sample-ratio halts | ≤ ${REG.n2_max_halts} of attempted | ${E.N2.halts} of ${E.N2.attempted} | ${E.N2.verdict} |`,
    `| N3 sensitivity count | ≤ ${REG.max_rollbacks} | ${E.N3.count} | ${E.N3.verdict} |`,
    `| N4 base rate delivered | median unanswered per tick in [${REG.n4_lo}, ${REG.n4_hi}] per arm | canary ${f(E.N4.median_canary, 2)}, control ${f(E.N4.median_control, 2)} | ${E.N4.verdict} |`, '',
    `Attempts ${E.attempts}, executable ${E.N1.executable}, void ${E.N1.void_runs.length}; fired ${JSON.stringify(E.N1.fired_by_detector)}; rollbacks ${E.N1.rollbacks_by_run.map((r) => `${r.run}(l${r.lane})@${r.tick}`).join(', ') || 'none'}.`,
    `no_response: detector fires ${R.no_response_detector_fires}; unanswered per tick min/median/max canary ${rr(R.unanswered_per_tick.canary)} control ${rr(R.unanswered_per_tick.control)}; share of ticks with zero in both arms ${rr(R.zero_both_share, 3)}; ticks with control − canary > ${REG.offset_excess}: ${R.control_excess_ticks}, canary − control > ${REG.offset_excess}: ${R.canary_excess_ticks}; max rollback e per run ${rr(R.no_response_max_rollback_e)}.`,
    `Strata (report-only): S ${R.strata.S.rollbacks}/${R.strata.S.executable}, X ${R.strata.X.rollbacks}/${R.strata.X.executable}. W0 rollbacks ${R.w0_rollbacks}. 5xx rate detector fires ${R.rate_5xx_detector_fires}. Beyond-margin p99 share ${rr(R.margined_share, 3)}; median control p99 ms ${rr(R.median_control_p99_ms, 1)}.`,
    `Authority violations ${E.authority_violations}. V9 void ${E.v9_void_runs.join(', ') || 'none'}. V10 void ${E.v10_void_runs.join(', ') || 'none'}. V6/V7 evaluated on ${E.v67.evaluated_runs} of ${E.summaries}; flagged ${E.v67.flagged_runs.join(', ') || 'none'}; unassigned inside ${E.v67.unassigned_inside_runs.length} run(s).`,
  ];
  writeFileSync(join(OUT, 'REPORT-TABLE.md'), table.join('\n') + '\n');
  console.log(table.join('\n'));
  console.log(`\nwritten: ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

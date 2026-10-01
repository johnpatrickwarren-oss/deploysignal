// analysis/analyze.mjs — endpoint table for 2026-10-twin-fault-shapes (PREREGISTRATION.md §2, §5).
// Committed BEFORE run 0. One invocation per cell:
//
//   node studies/twin-fault-shapes/analysis/analyze.mjs --cell AB-lat30|AB-5xx-1.5|AB-reset
//
// Reads, never writes, the run artifacts:
//   results/runs/<cell>-l<lane>-r<k>-<UTC>.{summary.json,jsonl}   the runner's files
//   results/operator/runs/<cell>-l<lane>-r<k>.ndjson               the driver's log per attempt
//   results/operator/cell-revisions.json                           { "<cell>": { "<lane>": "<canary task-definition family:revision>" } },
//                                                                  written before the cell's run 0 (V9)
//   results/evidence/cloudtrail-write-events-<cellslug>.json       cloudtrail-evidence.mjs output over the cell (V6/V7)
// and writes results/<cellslug>-<UTC>/ (manifest.json, endpoints.json, runs.json, REPORT-TABLE.md), refusing
// an existing directory. Verdicts as registered; no bare catch (a malformed artifact throws).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const RES = join(STUDY, 'results');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] ?? true]] : a), []));
const CELL = args.cell;
// §2 — registered bars. power = executable runs whose scored session ends rollback, of R = 20; cell stops at 30 attempts.
const BARS = { 'AB-lat30': { endpoint: 'F1', min_rollbacks: 16 }, 'AB-5xx-1.5': { endpoint: 'F2', min_rollbacks: 10 }, 'AB-reset': { endpoint: 'F3', min_rollbacks: null } };
if (!BARS[CELL]) { console.error(`--cell must be one of ${Object.keys(BARS).join(', ')}`); process.exit(2); }
const REG = { R: 20, attempt_cap: 30, margin: 0.10, v8_lo_s: 0.020, v8_hi_s: 0.400, f4_max_halts: 2, planner_ticks_5xx_1_5: 44 };
const slug = CELL.toLowerCase().replace(/[^a-z0-9]/g, '');
const toMs = (t) => { const ms = Date.parse(t); if (Number.isNaN(ms)) throw new Error(`bad time ${t}`); return ms; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---------- artifacts ----------
const runFiles = readdirSync(join(RES, 'runs')).filter((f) => f.startsWith(`${CELL}-l`) && f.endsWith('.summary.json')).sort();
const driverFiles = readdirSync(join(RES, 'operator', 'runs')).filter((f) => f.startsWith(`${CELL}-l`) && f.endsWith('.ndjson')).sort();
const driver = new Map(); const allScales = [];
for (const f of readdirSync(join(RES, 'operator', 'runs')).filter((x) => x.endsWith('.ndjson'))) {
  const lines = readFileSync(join(RES, 'operator', 'runs', f), 'utf8').split('\n').filter(Boolean).map((l) => (/^[[{]/.test(l) ? JSON.parse(l) : { raw: l }));
  const m = /^(.+)-l(\d)-r(\d+)\.ndjson$/.exec(f); if (!m) throw new Error(`driver file name ${f}`);
  const ev = (name) => lines.find((l) => !Array.isArray(l) && l.event === name);
  if (ev('scale')) allScales.push({ lane: Number(m[2]), t: toMs(ev('scale').t) });
  if (m[1] !== CELL) continue;
  driver.set(Number(m[3]), {
    file: f, lane: Number(m[2]), run: Number(m[3]), arm_ready: ev('arm_ready')?.t ?? null, runner_start: ev('runner_start')?.t ?? null,
    runner_exit: ev('runner_exit')?.t ?? null, runner_exit_code: ev('runner_exit')?.exit ?? null, deploy_failure: ev('deploy_failure') ?? null,
    tasks: lines.filter((l) => !Array.isArray(l) && l.service && Array.isArray(l.tasks)).map((l) => ({ service: l.service, tasks: l.tasks.map((t) => ({ az: t.az, td: (t.td ?? '').replace(/^.*task-definition\//, ''), status: t.status })) })),
  });
}
const revPath = join(RES, 'operator', 'cell-revisions.json');
const revisions = existsSync(revPath) ? JSON.parse(readFileSync(revPath, 'utf8'))[CELL] ?? null : null;
const evidencePath = join(RES, 'evidence', `cloudtrail-write-events-${slug}.json`);
const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;

// ---------- per run ----------
const runs = [];
for (const file of runFiles) {
  const s = JSON.parse(readFileSync(join(RES, 'runs', file), 'utf8'));
  const d = driver.get(s.run) ?? null;
  const windows = readFileSync(join(RES, 'runs', file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'window');
  const scored = windows.filter((w) => w.scored_tick);
  const last = scored[scored.length - 1];
  const p99 = scored.map((w) => w.body?.observations?.p99_latency).filter((o) => o && typeof o.canary === 'number' && typeof o.control === 'number');
  const bodies = scored.map((w) => w.body).filter(Boolean);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const v8 = p99.filter((o) => o.control < REG.v8_lo_s || o.control > REG.v8_hi_s).map((o) => o.control);
  const armReady = d?.arm_ready ?? new Date(s.arm_ready_ms).toISOString();
  const runEnd = d?.runner_exit ?? new Date(s.ended_at_ms).toISOString();
  const t0 = toMs(armReady), t1 = toMs(runEnd);
  // V6/V7: a write event on this lane's resources strictly inside (arm-ready, runner-exit); ECS TaskCreated events
  // name no lane and are attributed to the lane whose driver logged the nearest preceding `scale` within 60 s
  let v67 = { evaluated: false, events_inside: [], unassigned_inside: [] };
  if (evidence) {
    const attribute = (e) => { const t = toMs(e.t); const hit = allScales.filter((x) => t >= x.t && t - x.t <= 60_000).sort((a, b) => b.t - a.t); return hit.length ? hit[0].lane : null; };
    const inside = evidence.events.filter((e) => { const t = toMs(e.t); return t > t0 && t < t1; }).map((e) => ({ ...e, lane_final: e.lane ?? attribute(e) }));
    v67 = { evaluated: toMs(evidence.start) <= t0 && toMs(evidence.end) >= t1,
      events_inside: inside.filter((e) => e.lane_final === s.lane).map((e) => ({ t: e.t, name: e.name, id: e.id, identity: e.identity })),
      unassigned_inside: inside.filter((e) => e.lane_final === null).map((e) => ({ t: e.t, name: e.name, id: e.id })) };
  }
  // V9: the canary's tasks must be on the revision recorded for this cell and lane before the cell's run 0
  const canaryTds = [...new Set((d?.tasks ?? []).filter((x) => x.service === 'canary-new').flatMap((x) => x.tasks.map((t) => t.td)))];
  const controlTds = [...new Set((d?.tasks ?? []).filter((x) => x.service === 'baseline-old').flatMap((x) => x.tasks.map((t) => t.td)))];
  const expected = revisions ? revisions[String(s.lane)] ?? null : null;
  const void_reasons = [...s.void_reasons];
  if (v8.length) void_reasons.push(`V8 latency scale: ${v8.length} scored tick(s) with control p99 outside 20–400 ms (first ${v8[0]} s)`);
  if (v67.evaluated && v67.events_inside.length) void_reasons.push(`V6/V7 write event on the lane's resources inside the run: ${v67.events_inside.map((e) => `${e.name}@${e.t}`).join(', ')}`);
  if (!expected) void_reasons.push('V9 not evaluable: no recorded canary revision for this cell and lane (results/operator/cell-revisions.json)');
  else if (canaryTds.length !== 1 || canaryTds[0] !== expected) void_reasons.push(`V9 canary revision ${canaryTds.join('|') || 'unrecorded'} is not the cell's ${expected}`);
  const fired = last ? (last.scored?.metrics ?? []).filter((m) => m.rollback_e >= m.rollback_threshold).map((m) => m.detector_id) : [];
  runs.push({
    run: s.run, lane: s.lane, file, arm_ready: armReady, runner_exit: runEnd, runner_exit_code: d?.runner_exit_code ?? null,
    complete: s.complete, operator_abort: !!s.operator_abort, void_reasons, executable: s.complete === true && void_reasons.length === 0 && !s.operator_abort,
    scored: { verdict: s.scored?.verdict, ticks: s.scored?.ticks }, w0: { verdict: s.w0?.verdict, ticks: s.w0?.ticks }, fired,
    authority_violation: s.authority?.violation ?? null, repo_sha: s.manifest?.repo_sha, engine: s.manifest?.engine, config_sha256: s.manifest?.config_sha256,
    canary_tds: canaryTds, control_tds: controlTds, v67,
    p99_canary_worse_share: p99.length ? p99.filter((o) => o.canary > o.control).length / p99.length : null,
    p99_canary_worse_share_margin: p99.length ? p99.filter((o) => o.canary > o.control * (1 + REG.margin)).length / p99.length : null,
    median_p99_s: { canary: median(p99.map((o) => o.canary)), control: median(p99.map((o) => o.control)) },
    mean_requests: { canary: mean(bodies.map((b) => b.canary_requests)), control: mean(bodies.map((b) => b.control_requests)) },
    mean_5xx: { canary: mean(bodies.map((b) => b.observations?.http_5xx?.canary_events ?? 0)), control: mean(bodies.map((b) => b.observations?.http_5xx?.control_events ?? 0)) },
    mean_elb_5xx_lb_per_tick: mean(scored.map((w) => w.stall?.elb_5xx_lb ?? 0)),
    final_srm_e: last?.scored?.srm_e ?? null, final_e: Object.fromEntries((last?.scored?.metrics ?? []).map((m) => [m.id, m.rollback_e])),
  });
}
runs.sort((a, b) => a.run - b.run);

// ---------- endpoints ----------
const attempts = [...driver.values()];
const exec = runs.filter((r) => r.executable);
const rb = exec.filter((r) => r.scored.verdict === 'rollback');
const halts = runs.filter((r) => r.scored.verdict === 'halt');
const bar = BARS[CELL];
const ticks = rb.map((r) => r.scored.ticks).sort((a, b) => a - b);
const E = {
  cell: CELL, registered: { ...REG, ...bar },
  attempts: attempts.length, deploy_failures: attempts.filter((a) => a.deploy_failure && !a.runner_start).map((a) => a.run), runs_with_runner: attempts.filter((a) => a.runner_start).length,
  summaries: runs.length, executable: exec.length, void_runs: runs.filter((r) => !r.executable).map((r) => ({ run: r.run, reasons: r.void_reasons })),
  power: { rollbacks: rb.length, executable: exec.length, rate: exec.length ? rb.length / exec.length : null, median_rollback_tick: median(ticks), rollback_ticks: ticks,
    non_rollback: exec.filter((r) => r.scored.verdict !== 'rollback').map((r) => ({ run: r.run, verdict: r.scored.verdict, ticks: r.scored.ticks })) },
  verdict: bar.min_rollbacks === null ? 'reported, no bar' : exec.length >= REG.R ? (rb.length >= bar.min_rollbacks ? 'PASS' : 'FAIL') : attempts.length >= REG.attempt_cap ? 'NOT EXECUTABLE (30 attempts without 20 executable)' : 'NOT SCORED (cell incomplete)',
  fired_by_detector: rb.reduce((m, r) => { for (const d of r.fired) m[d] = (m[d] ?? 0) + 1; return m; }, {}),
  rollbacks_by_run: rb.map((r) => ({ run: r.run, lane: r.lane, tick: r.scored.ticks, fired: r.fired })),
  halts: halts.length, F4_cell: halts.length <= REG.f4_max_halts ? 'within bar (study-level F4 sums the cells)' : 'exceeds 2',
  descriptives: {
    median_p99_ms: { canary: median(exec.map((r) => r.median_p99_s.canary * 1000)), control: median(exec.map((r) => r.median_p99_s.control * 1000)) },
    margined_share: { min: exec.length ? Math.min(...exec.map((r) => r.p99_canary_worse_share_margin)) : null, median: median(exec.map((r) => r.p99_canary_worse_share_margin)), max: exec.length ? Math.max(...exec.map((r) => r.p99_canary_worse_share_margin)) : null },
    mean_5xx_per_tick: { canary: exec.length ? exec.reduce((a, r) => a + r.mean_5xx.canary, 0) / exec.length : null, control: exec.length ? exec.reduce((a, r) => a + r.mean_5xx.control, 0) / exec.length : null },
    mean_requests_per_tick: { canary: exec.length ? exec.reduce((a, r) => a + r.mean_requests.canary, 0) / exec.length : null, control: exec.length ? exec.reduce((a, r) => a + r.mean_requests.control, 0) / exec.length : null },
    mean_elb_5xx_lb_per_tick: exec.length ? exec.reduce((a, r) => a + r.mean_elb_5xx_lb_per_tick, 0) / exec.length : null,
    final_srm_e: { min: exec.length ? Math.min(...exec.map((r) => r.final_srm_e)) : null, max: exec.length ? Math.max(...exec.map((r) => r.final_srm_e)) : null },
  },
  authority_violations: runs.filter((r) => r.authority_violation).length,
  v67: { evaluated_runs: runs.filter((r) => r.v67.evaluated).length, flagged_runs: runs.filter((r) => r.v67.events_inside.length).map((r) => r.run), unassigned_inside_runs: runs.filter((r) => r.v67.unassigned_inside.length).map((r) => r.run) },
  repo_shas: [...new Set(runs.map((r) => r.repo_sha))], engines: [...new Set(runs.map((r) => JSON.stringify(r.engine)))].map((x) => JSON.parse(x)),
  canary_tds: [...new Set(runs.flatMap((r) => r.canary_tds))], control_tds: [...new Set(runs.flatMap((r) => r.control_tds))],
};

// ---------- write ----------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const OUT = join(RES, `${slug}-${stamp}`);
if (existsSync(OUT)) throw new Error(`${OUT} exists`);
mkdirSync(OUT);
const git = (c) => execSync(c, { cwd: STUDY, encoding: 'utf8' }).trim();
const manifest = { study_id: '2026-10-twin-fault-shapes', cell: CELL, generated_at: new Date().toISOString(), analysis_repo_head: git('git rev-parse HEAD'),
  analysis_tracked_changes: git('git status --porcelain --untracked-files=no -- .').split('\n').filter(Boolean),
  inputs: { summaries: runFiles.length, driver_logs: driverFiles.length, revisions, evidence: evidence ? { count: evidence.count, start: evidence.start, end: evidence.end } : null } };
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(E, null, 1) + '\n');
writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 1) + '\n');
const f = (x, n = 3) => (x == null ? '—' : x.toFixed(n));
const table = [
  `# ${CELL} — endpoint table (generated ${manifest.generated_at})`, '',
  `| ${bar.endpoint} power | ${bar.min_rollbacks === null ? 'no bar (reported)' : `≥ ${bar.min_rollbacks} of ${REG.R} executable roll back`} | ${rb.length}/${exec.length} = ${f(E.power.rate)}, median rollback tick ${E.power.median_rollback_tick ?? '—'} (ticks ${ticks.join(', ') || 'none'}) | ${E.verdict} |`, '',
  `Attempts ${E.attempts} (deploy failures ${E.deploy_failures.join(', ') || 'none'}); summaries ${E.summaries}; executable ${E.executable}; void ${E.void_runs.length}${E.void_runs.length ? ` (${E.void_runs.map((v) => `${v.run}: ${v.reasons[0]}`).join('; ')})` : ''}; halts ${E.halts}; authority violations ${E.authority_violations}.`,
  `Fired by detector: ${JSON.stringify(E.fired_by_detector)}. Non-rollback: ${E.power.non_rollback.map((x) => `${x.run}:${x.verdict}@${x.ticks}`).join(', ') || 'none'}.`,
  `Median p99 (ms) canary ${f(E.descriptives.median_p99_ms.canary, 1)} / control ${f(E.descriptives.median_p99_ms.control, 1)}; share of scored ticks with canary p99 > control × 1.10: min ${f(E.descriptives.margined_share.min)}, median ${f(E.descriptives.margined_share.median)}, max ${f(E.descriptives.margined_share.max)}.`,
  `Mean per tick: target 5xx canary ${f(E.descriptives.mean_5xx_per_tick.canary, 2)} / control ${f(E.descriptives.mean_5xx_per_tick.control, 2)}; requests canary ${f(E.descriptives.mean_requests_per_tick.canary, 0)} / control ${f(E.descriptives.mean_requests_per_tick.control, 0)}; ELB-generated 5xx on the lane's load balancer ${f(E.descriptives.mean_elb_5xx_lb_per_tick, 2)}; final sample-ratio e-value ${f(E.descriptives.final_srm_e.min, 2)}–${f(E.descriptives.final_srm_e.max, 2)}.`,
  `V6/V7 evaluated on ${E.v67.evaluated_runs} of ${E.summaries}; flagged ${E.v67.flagged_runs.join(', ') || 'none'}. Canary revisions ${E.canary_tds.join(', ') || '—'}; control ${E.control_tds.join(', ') || '—'}.`,
];
writeFileSync(join(OUT, 'REPORT-TABLE.md'), table.join('\n') + '\n');
console.log(table.join('\n'));
console.log(`\nwritten: ${OUT}`);

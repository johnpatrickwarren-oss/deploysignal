// analysis/analyze.mjs — endpoint table for 2026-10-twin-aa-onebox (PREREGISTRATION.md §2, §5, Amendment 1).
// Committed BEFORE run 0.
//
//   node studies/twin-aa-onebox/analysis/analyze.mjs
//
// Reads, never writes, the run artifacts:
//   results/runs/AA-l<lane>-r<k>-<UTC>.{summary.json,jsonl}    the runner's files
//   results/operator/runs/AA-l<lane>-r<k>.ndjson                the driver's log per attempt (tasks' AZs for V10)
//   results/evidence/cloudtrail-write-events.json               cloudtrail-evidence.mjs output over the cell (V6/V7)
// and writes results/run-<UTC>/ (manifest.json, endpoints.json, runs.json, REPORT-TABLE.md), refusing an
// existing directory. Verdicts as registered; no bare catch (a malformed artifact throws).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const RES = join(STUDY, 'results');
// Amendment 1: 100 executable per stratum, B = 0.1062 → at most 10 of 100, a stratum stops at 11, 150 attempts cap
const REG = { R: 100, B: 0.1062, max_rollbacks: 10, stop_after_rollbacks: 11, attempt_cap: 150, o3_max_halts: 2, margin: 0.10, v8_lo_s: 0.020, v8_hi_s: 0.400 };
// §1.2: where each onebox sits, fixed per lane; S = same AZ, X = across AZs
const PLACEMENT = {
  0: { stratum: 'S', baseline: 'us-east-1a', canary: 'us-east-1a' },
  1: { stratum: 'S', baseline: 'us-east-1b', canary: 'us-east-1b' },
  2: { stratum: 'X', baseline: 'us-east-1a', canary: 'us-east-1b' },
  3: { stratum: 'X', baseline: 'us-east-1b', canary: 'us-east-1a' },
};
const toMs = (t) => { const ms = Date.parse(t); if (Number.isNaN(ms)) throw new Error(`bad time ${t}`); return ms; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------- artifacts ----------
const runFiles = readdirSync(join(RES, 'runs')).filter((f) => f.startsWith('AA-l') && f.endsWith('.summary.json')).sort();
const driver = new Map(); const allScales = [];
for (const f of readdirSync(join(RES, 'operator', 'runs')).filter((x) => x.endsWith('.ndjson'))) {
  const lines = readFileSync(join(RES, 'operator', 'runs', f), 'utf8').split('\n').filter(Boolean).map((l) => (/^[[{]/.test(l) ? JSON.parse(l) : { raw: l }));
  const m = /^(.+)-l(\d)-r(\d+)\.ndjson$/.exec(f); if (!m) throw new Error(`driver file name ${f}`);
  const ev = (name) => lines.find((l) => !Array.isArray(l) && l.event === name);
  if (ev('scale')) allScales.push({ lane: Number(m[2]), t: toMs(ev('scale').t) });
  driver.set(Number(m[3]), {
    file: f, lane: Number(m[2]), run: Number(m[3]), arm_ready: ev('arm_ready')?.t ?? null, runner_start: ev('runner_start')?.t ?? null,
    runner_exit: ev('runner_exit')?.t ?? null, runner_exit_code: ev('runner_exit')?.exit ?? null, deploy_failure: ev('deploy_failure') ?? null,
    tasks: lines.filter((l) => !Array.isArray(l) && l.service && Array.isArray(l.tasks)).map((l) => ({ service: l.service, tasks: l.tasks.map((t) => ({ az: t.az, td: (t.td ?? '').replace(/^.*task-definition\//, ''), status: t.status })) })),
  });
}
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
  const v8 = p99.filter((o) => o.control < REG.v8_lo_s || o.control > REG.v8_hi_s).map((o) => o.control);
  const armReady = d?.arm_ready ?? new Date(s.arm_ready_ms).toISOString();
  const runEnd = d?.runner_exit ?? new Date(s.ended_at_ms).toISOString();
  const t0 = toMs(armReady), t1 = toMs(runEnd);
  // V6/V7: a write event on this lane's resources strictly inside (arm-ready, runner-exit). ECS TaskCreated events name
  // no lane; they go to the lane whose driver logged the nearest preceding `scale` within 120 s (the second study's
  // 60 s window left one late task launch unattributed; 120 s is still shorter than the gap between a lane's runs)
  let v67 = { evaluated: false, events_inside: [], unassigned_inside: [] };
  if (evidence) {
    const attribute = (e) => { const t = toMs(e.t); const hit = allScales.filter((x) => t >= x.t && t - x.t <= 120_000).sort((a, b) => b.t - a.t); return hit.length ? hit[0].lane : null; };
    const inside = evidence.events.filter((e) => { const t = toMs(e.t); return t > t0 && t < t1; }).map((e) => ({ ...e, lane_final: e.lane ?? attribute(e) }));
    v67 = { evaluated: toMs(evidence.start) <= t0 && toMs(evidence.end) >= t1,
      events_inside: inside.filter((e) => e.lane_final === s.lane).map((e) => ({ t: e.t, name: e.name, id: e.id, identity: e.identity })),
      unassigned_inside: inside.filter((e) => e.lane_final === null).map((e) => ({ t: e.t, name: e.name, id: e.id })) };
  }
  // V10: one task per arm, each in its lane's registered AZ, as the driver's task record shows after the runner exits
  const azOf = (svc) => (d?.tasks ?? []).filter((x) => x.service === svc).flatMap((x) => x.tasks.map((t) => t.az));
  const baseAz = azOf('baseline-old'), canAz = azOf('canary-new');
  const void_reasons = [...s.void_reasons];
  if (v8.length) void_reasons.push(`V8 latency scale: ${v8.length} scored tick(s) with control p99 outside 20–400 ms (first ${v8[0]} s)`);
  if (v67.evaluated && v67.events_inside.length) void_reasons.push(`V6/V7 write event on the lane's resources inside the run: ${v67.events_inside.map((e) => `${e.name}@${e.t}`).join(', ')}`);
  if (baseAz.length !== 1 || canAz.length !== 1 || baseAz[0] !== place.baseline || canAz[0] !== place.canary) {
    void_reasons.push(`V10 placement: baseline [${baseAz.join(',') || 'unrecorded'}] canary [${canAz.join(',') || 'unrecorded'}], registered ${place.baseline} / ${place.canary}`);
  }
  runs.push({
    run: s.run, lane: s.lane, stratum: place.stratum, file, arm_ready: armReady, runner_exit: runEnd, runner_exit_code: d?.runner_exit_code ?? null,
    complete: s.complete, operator_abort: !!s.operator_abort, void_reasons, runner_void_reasons: s.void_reasons,
    executable: s.complete === true && void_reasons.length === 0 && !s.operator_abort,
    scored: { verdict: s.scored?.verdict, ticks: s.scored?.ticks }, w0: { verdict: s.w0?.verdict, ticks: s.w0?.ticks },
    fired: last ? (last.scored?.metrics ?? []).filter((m) => m.rollback_e >= m.rollback_threshold).map((m) => m.detector_id) : [],
    authority_violation: s.authority?.violation ?? null, repo_sha: s.manifest?.repo_sha, engine: s.manifest?.engine, config_sha256: s.manifest?.config_sha256,
    baseline_az: baseAz, canary_az: canAz, v67,
    p99_canary_worse_share: p99.length ? p99.filter((o) => o.canary > o.control).length / p99.length : null,
    p99_canary_worse_share_margin: p99.length ? p99.filter((o) => o.canary > o.control * (1 + REG.margin)).length / p99.length : null,
    median_p99_s: { canary: median(p99.map((o) => o.canary)), control: median(p99.map((o) => o.control)) },
    mean_requests: { canary: mean(bodies.map((b) => b.canary_requests)), control: mean(bodies.map((b) => b.control_requests)) },
    mean_5xx: { canary: mean(bodies.map((b) => b.observations?.http_5xx?.canary_events ?? 0)), control: mean(bodies.map((b) => b.observations?.http_5xx?.control_events ?? 0)) },
    final_srm_e: last?.scored?.srm_e ?? null,
  });
}
runs.sort((a, b) => a.run - b.run);

// ---------- endpoints, per stratum ----------
const attempts = [...driver.values()];
const stratum = (name) => {
  const lanes = Object.entries(PLACEMENT).filter(([, p]) => p.stratum === name).map(([l]) => Number(l));
  const rs = runs.filter((r) => r.stratum === name);
  const exec = rs.filter((r) => r.executable); const rb = exec.filter((r) => r.scored.verdict === 'rollback');
  const sens = rs.filter((r) => r.scored.verdict === 'rollback' || (!r.executable && r.w0.verdict === 'rollback') || r.operator_abort).length;
  const stopped = rb.length >= REG.stop_after_rollbacks;
  const att = attempts.filter((a) => lanes.includes(a.lane)).length;
  const ratio = exec.map((r) => r.median_p99_s.canary / r.median_p99_s.control);
  return {
    stratum: name, lanes, attempts: att, summaries: rs.length, executable: exec.length, void_runs: rs.filter((r) => !r.executable).map((r) => ({ run: r.run, reasons: r.void_reasons })),
    rollbacks: rb.length, rate: exec.length ? rb.length / exec.length : null, stop_rule_tripped: stopped,
    verdict: stopped ? 'FAIL' : exec.length >= REG.R ? (rb.length <= REG.max_rollbacks ? 'PASS' : 'FAIL') : att >= REG.attempt_cap ? 'NOT EXECUTABLE (150 attempts without 100 executable)' : 'NOT SCORED (stratum incomplete)',
    sensitivity_count: sens, sensitivity_verdict: sens > REG.max_rollbacks ? 'FAIL' : stopped || exec.length >= REG.R ? 'PASS' : 'NOT SCORED',
    rollbacks_by_run: rb.map((r) => ({ run: r.run, lane: r.lane, tick: r.scored.ticks, fired: r.fired })),
    fired_by_detector: rb.reduce((m, r) => { for (const d of r.fired) m[d] = (m[d] ?? 0) + 1; return m; }, {}),
    per_lane: lanes.map((l) => { const ex = exec.filter((r) => r.lane === l); return { lane: l, executable: ex.length, rollbacks: ex.filter((r) => r.scored.verdict === 'rollback').length, w0_rollbacks: ex.filter((r) => r.w0.verdict === 'rollback').length, median_p99_ratio: median(ex.map((r) => r.median_p99_s.canary / r.median_p99_s.control)) }; }),
    w0_rollbacks: rs.filter((r) => r.w0.verdict === 'rollback').length,
    descriptives: {
      unmargined_share: { min: exec.length ? Math.min(...exec.map((r) => r.p99_canary_worse_share)) : null, median: median(exec.map((r) => r.p99_canary_worse_share)), max: exec.length ? Math.max(...exec.map((r) => r.p99_canary_worse_share)) : null },
      margined_share: { min: exec.length ? Math.min(...exec.map((r) => r.p99_canary_worse_share_margin)) : null, median: median(exec.map((r) => r.p99_canary_worse_share_margin)), max: exec.length ? Math.max(...exec.map((r) => r.p99_canary_worse_share_margin)) : null },
      median_p99_ms: { canary: median(exec.map((r) => r.median_p99_s.canary * 1000)), control: median(exec.map((r) => r.median_p99_s.control * 1000)) },
      p99_ratio: { min: ratio.length ? Math.min(...ratio) : null, median: median(ratio), max: ratio.length ? Math.max(...ratio) : null },
    },
  };
};
const S = stratum('S'), X = stratum('X');
const halts = runs.filter((r) => r.scored.verdict === 'halt');
const E = {
  registered: REG, placement: PLACEMENT,
  attempts: attempts.length, deploy_failures: attempts.filter((a) => a.deploy_failure && !a.runner_start).map((a) => a.run), summaries: runs.length,
  O1: { ...S, endpoint: 'O1 same AZ' }, O2: { ...X, endpoint: 'O2 across AZs' },
  O3: { halts: halts.length, attempted: attempts.length, verdict: halts.length <= REG.o3_max_halts ? 'PASS' : 'FAIL' },
  O4: { S: { count: S.sensitivity_count, verdict: S.sensitivity_verdict }, X: { count: X.sensitivity_count, verdict: X.sensitivity_verdict } },
  rate_detector_fires: runs.filter((r) => r.fired.includes('twin_rate_http_5xx')).length,
  authority_violations: runs.filter((r) => r.authority_violation).length,
  v10_void_runs: runs.filter((r) => r.void_reasons.some((x) => x.startsWith('V10'))).map((r) => r.run),
  v67: { evaluated_runs: runs.filter((r) => r.v67.evaluated).length, flagged_runs: runs.filter((r) => r.v67.events_inside.length).map((r) => r.run), unassigned_inside_runs: runs.filter((r) => r.v67.unassigned_inside.length).map((r) => r.run) },
  repo_shas: [...new Set(runs.map((r) => r.repo_sha))], engines: [...new Set(runs.map((r) => JSON.stringify(r.engine)))].map((x) => JSON.parse(x)),
};

// ---------- write ----------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const OUT = join(RES, `run-${stamp}`);
if (existsSync(OUT)) throw new Error(`${OUT} exists`);
mkdirSync(OUT);
const git = (c) => execSync(c, { cwd: STUDY, encoding: 'utf8' }).trim();
const manifest = { study_id: '2026-10-twin-aa-onebox', generated_at: new Date().toISOString(), analysis_repo_head: git('git rev-parse HEAD'),
  analysis_tracked_changes: git('git status --porcelain --untracked-files=no -- .').split('\n').filter(Boolean), committed_before_run_0: true,
  inputs: { summaries: runFiles.length, driver_logs: driver.size, evidence: evidence ? { count: evidence.count, start: evidence.start, end: evidence.end } : null },
  runner_repo_shas: E.repo_shas, engines: E.engines };
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(E, null, 1) + '\n');
writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 1) + '\n');
const f = (x, n = 3) => (x == null ? '—' : x.toFixed(n));
const row = (o) => `| ${o.endpoint} | ≤ ${REG.max_rollbacks} of ${REG.R} executable; stop at ${REG.stop_after_rollbacks} | ${o.rollbacks}/${o.executable} = ${f(o.rate)} | ${o.verdict} |`;
const desc = (o) => `${o.stratum}: attempts ${o.attempts}, executable ${o.executable}, void ${o.void_runs.length}, W0 rollbacks ${o.w0_rollbacks}; fired ${JSON.stringify(o.fired_by_detector)}; rollbacks ${o.rollbacks_by_run.map((r) => `${r.run}(l${r.lane})@${r.tick}`).join(', ') || 'none'}; per lane ${o.per_lane.map((l) => `l${l.lane} ${l.rollbacks}/${l.executable} ratio ${f(l.median_p99_ratio)}`).join(', ')}; unmargined share ${f(o.descriptives.unmargined_share.min)}/${f(o.descriptives.unmargined_share.median)}/${f(o.descriptives.unmargined_share.max)}; beyond-margin share ${f(o.descriptives.margined_share.min)}/${f(o.descriptives.margined_share.median)}/${f(o.descriptives.margined_share.max)}; median p99 ms canary ${f(o.descriptives.median_p99_ms.canary, 1)} control ${f(o.descriptives.median_p99_ms.control, 1)}; p99 ratio min/median/max ${f(o.descriptives.p99_ratio.min)}/${f(o.descriptives.p99_ratio.median)}/${f(o.descriptives.p99_ratio.max)}.`;
const table = [
  `# Endpoint table — 2026-10-twin-aa-onebox (generated ${manifest.generated_at})`, '',
  '| Endpoint | Registered | Observed | Verdict |', '|---|---|---|---|', row(E.O1), row(E.O2),
  `| O3 sample-ratio halts | ≤ ${REG.o3_max_halts} of attempted | ${E.O3.halts} of ${E.O3.attempted} | ${E.O3.verdict} |`,
  `| O4 sensitivity count | ≤ ${REG.max_rollbacks} per stratum | S ${E.O4.S.count}, X ${E.O4.X.count} | S ${E.O4.S.verdict}, X ${E.O4.X.verdict} |`, '',
  desc(E.O1), '', desc(E.O2), '',
  `Rate detector fires ${E.rate_detector_fires}. Authority violations ${E.authority_violations}. V10 void runs ${E.v10_void_runs.join(', ') || 'none'}. V6/V7 evaluated on ${E.v67.evaluated_runs} of ${E.summaries}; flagged ${E.v67.flagged_runs.join(', ') || 'none'}; unassigned inside ${E.v67.unassigned_inside_runs.join(', ') || 'none'}.`,
];
writeFileSync(join(OUT, 'REPORT-TABLE.md'), table.join('\n') + '\n');
console.log(table.join('\n'));
console.log(`\nwritten: ${OUT}`);

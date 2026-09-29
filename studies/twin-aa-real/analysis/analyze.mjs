// analysis/analyze.mjs — endpoint table for 2026-10-twin-aa-real (PREREGISTRATION.md §5, §7, §8).
//
// Reads, never writes, the run artifacts:
//   results/runs/<cell>-l<lane>-r<k>-<UTC>.summary.json   the runner's once-written summary per run
//   results/runs/<cell>-l<lane>-r<k>-<UTC>.jsonl           its per-window lines (verdict ticks, bodies)
//   results/operator/runs/<cell>-l<lane>-r<k>.ndjson       the driver's log per attempt (arm-ready, exit, stop)
//   results/evidence/cloudtrail-write-events.json          cloudtrail-evidence.mjs output (V6/V7)
// and writes one summary directory results/run-<UTC>/ (manifest.json, endpoints.json, runs.json,
// REPORT-TABLE.md), refusing an existing one. Verdicts are computed as registered; nothing here
// reads a bar from anywhere but the registration's numbers below. No bare catch: a malformed
// artifact throws and the script exits non-zero.
//
// Deviation, stated: §8 asks for this script to be committed before the first run it summarizes.
// It was written after the AA cell stopped (2026-09-29 18:47Z). Every number it computes is a
// count over fields the runner and the driver wrote before it existed; the report says so.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const RES = join(STUDY, 'results');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] ?? true]] : a), []));
const CELL = args.cell ?? 'AA';

// §5 — registered bars (α 0.05, R 100, B = α + 2.58·SE₀ = 0.1062 → at most 10 of 100)
const REG = { alpha: 0.05, R: 100, B: 0.1062, e1_max_rollbacks: 10, e2_max: 10, e3_max_halts: 2, stop_after_rollbacks: 11, attempt_cap: 150 };

// ---------- artifacts ----------
const runFiles = readdirSync(join(RES, 'runs')).filter((f) => f.startsWith(`${CELL}-`) && f.endsWith('.summary.json')).sort();
const summaries = runFiles.map((f) => ({ file: f, s: JSON.parse(readFileSync(join(RES, 'runs', f), 'utf8')) }));
const driverFiles = readdirSync(join(RES, 'operator', 'runs')).filter((f) => f.startsWith(`${CELL}-`) && f.endsWith('.ndjson')).sort();
const driver = new Map();
for (const f of driverFiles) {
  // a driver log may carry the rotate script's stderr (plain text, e.g. the IAM denials of attempts 0–18): kept, not parsed
  const lines = readFileSync(join(RES, 'operator', 'runs', f), 'utf8').split('\n').filter(Boolean).map((l) => (/^[[{]/.test(l) ? JSON.parse(l) : { raw: l }));
  const m = /^(\w+)-l(\d)-r(\d+)\.ndjson$/.exec(f); if (!m) throw new Error(`driver file name ${f}`);
  const ev = (name) => lines.find((l) => !Array.isArray(l) && l.event === name);
  driver.set(Number(m[3]), {
    file: f, lane: Number(m[2]), run: Number(m[3]),
    attempt: ev('attempt')?.t ?? null, arm_ready: ev('arm_ready')?.t ?? null, runner_start: ev('runner_start')?.t ?? null,
    runner_exit: ev('runner_exit')?.t ?? null, runner_exit_code: ev('runner_exit')?.exit ?? null, stop: ev('stop')?.t ?? null,
    deploy_failure: ev('deploy_failure') ?? null, run_closed: ev('run_closed')?.t ?? null,
    scale: ev('scale')?.t ?? null,
    tasks: lines.filter((l) => !Array.isArray(l) && l.service && Array.isArray(l.tasks)).map((l) => ({ service: l.service, tasks: l.tasks.map((t) => ({ az: t.az, td: (t.td ?? '').replace(/\d{12}/g, '<acct>'), status: t.status })) })),
    driver_events: lines.filter(Array.isArray).flat().map((e) => ({ t: e.t, name: e.name, id: e.id })),
  });
}
const evidencePath = join(RES, 'evidence', 'cloudtrail-write-events.json');
const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
const toMs = (t) => { const ms = Date.parse(t); if (Number.isNaN(ms)) throw new Error(`bad time ${t}`); return ms; };

// ---------- per run ----------
function lastScoredLine(file) {
  const lines = readFileSync(join(RES, 'runs', file.replace('.summary.json', '.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const windows = lines.filter((l) => l.type === 'window');
  const scored = windows.filter((w) => w.scored_tick);
  const last = scored[scored.length - 1];
  // direction of the p99 difference over the scored ticks the scored session saw (post-hoc descriptive)
  const seen = scored.slice(0, last?.scored?.tick ?? scored.length);
  const p99 = seen.map((w) => w.body?.observations?.p99_latency).filter((o) => o && typeof o.canary === 'number' && typeof o.control === 'number');
  const worse = p99.filter((o) => o.canary > o.control).length; const ties = p99.filter((o) => o.canary === o.control).length;
  const req = seen.map((w) => w.body).filter(Boolean);
  const health = windows.map((w) => w.health).filter(Boolean);
  const replaced = health.some((h) => (h.unhealthy_max?.canary ?? 0) > 0 || (h.unhealthy_max?.control ?? 0) > 0 || (h.healthy_min?.canary ?? 2) < 2 || (h.healthy_min?.control ?? 2) < 2);
  return {
    windows: windows.length, scored_windows: scored.length,
    final: last ? { tick: last.scored?.tick, verdict: last.scored?.verdict, srm_e: last.scored?.srm_e, metrics: (last.scored?.metrics ?? []).map((m) => ({ id: m.id, detector_id: m.detector_id, rollback_e: m.rollback_e, rollback_threshold: m.rollback_threshold, used: m.used, ties: m.ties, missing: m.missing })) } : null,
    fired: last ? (last.scored?.metrics ?? []).filter((m) => m.rollback_e >= m.rollback_threshold).map((m) => m.detector_id) : [],
    p99_canary_worse_share: p99.length ? worse / p99.length : null, p99_ties: ties, p99_ticks: p99.length,
    mean_requests: req.length ? { canary: Math.round(req.reduce((a, b) => a + b.canary_requests, 0) / req.length), control: Math.round(req.reduce((a, b) => a + b.control_requests, 0) / req.length) } : null,
    mean_5xx: req.length ? { canary: +(req.reduce((a, b) => a + (b.observations?.http_5xx?.canary_events ?? 0), 0) / req.length).toFixed(2), control: +(req.reduce((a, b) => a + (b.observations?.http_5xx?.control_events ?? 0), 0) / req.length).toFixed(2) } : null,
    any_unhealthy_target: replaced,
  };
}

const runs = [];
for (const { file, s } of summaries) {
  const d = driver.get(s.run) ?? null;
  const armReady = d?.arm_ready ?? new Date(s.arm_ready_ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runEnd = d?.runner_exit ?? new Date(s.ended_at_ms).toISOString();
  const t0 = toMs(armReady), t1 = toMs(runEnd);
  // V6/V7 from the CloudTrail file: any write event on THIS lane's resources strictly inside (arm-ready, runner-exit)
  let v67 = { evaluated: false, events_inside: [], unassigned_inside: [] };
  if (evidence) {
    const covered = toMs(evidence.start) <= t0 && toMs(evidence.end) >= t1;
    const inside = evidence.events.filter((e) => { const t = toMs(e.t); return t > t0 && t < t1; });
    // ECS-emitted TaskCreated events name no lane in their record; attribute each to the lane whose driver
    // logged a `scale` within 60 s before it (arm scale-up creates tasks). Unattributable ones are listed.
    const scales = [...driver.values()].filter((a) => a.scale).map((a) => ({ lane: a.lane, t: toMs(a.scale) }));
    const attribute = (e) => { const t = toMs(e.t); const hit = scales.filter((x) => t >= x.t && t - x.t <= 60_000).sort((a, b) => b.t - a.t); return hit.length ? hit[0].lane : null; };
    const unassigned = inside.filter((e) => e.lane === null).map((e) => ({ t: e.t, name: e.name, id: e.id, attributed_lane: attribute(e) }));
    v67 = {
      evaluated: covered, coverage: [evidence.start, evidence.end],
      events_inside: [...inside.filter((e) => e.lane === s.lane).map((e) => ({ t: e.t, name: e.name, id: e.id, identity: e.identity })),
        ...unassigned.filter((e) => e.attributed_lane === s.lane).map((e) => ({ t: e.t, name: e.name, id: e.id, identity: 'attributed by scale time' }))],
      unassigned_inside: unassigned.filter((e) => e.attributed_lane === null),
      other_lane_inside: unassigned.filter((e) => e.attributed_lane !== null && e.attributed_lane !== s.lane).length + inside.filter((e) => e.lane !== null && e.lane !== s.lane).length,
    };
  }
  const x = lastScoredLine(file);
  const void_reasons = [...s.void_reasons];
  if (v67.evaluated && v67.events_inside.length) void_reasons.push(`V6/V7 write event on the lane's resources inside the run: ${v67.events_inside.map((e) => `${e.name}@${e.t}`).join(', ')}`);
  const executable = s.complete === true && void_reasons.length === 0 && !s.operator_abort;
  runs.push({
    run: s.run, lane: s.lane, file, deploy_ref: s.deploy_ref, arm_ready: armReady, runner_start: d?.runner_start ?? null, runner_exit: runEnd, runner_exit_code: d?.runner_exit_code ?? null,
    complete: s.complete, operator_abort: !!s.operator_abort, void_reasons, executable,
    counts_for_e2: s.counts_for_e2 === true || (executable && s.scored?.verdict === 'rollback'),
    scored: { verdict: s.scored?.verdict, ticks: s.scored?.ticks }, w0: { verdict: s.w0?.verdict, ticks: s.w0?.ticks },
    authority_violation: s.authority?.violation ?? null, gate_healthz: s.gate_healthz ?? null,
    repo_sha: s.manifest?.repo_sha, engine: s.manifest?.engine, node: s.manifest?.node, config_sha256: s.manifest?.config_sha256,
    tasks: d?.tasks ?? [], v67, ...x,
  });
}
runs.sort((a, b) => a.run - b.run);

// ---------- attempts, deploy failures ----------
const attempts = [...driver.values()].sort((a, b) => a.run - b.run);
const deployFailures = attempts.filter((a) => a.deploy_failure && !a.runner_start);
// an attempt whose driver was killed between `attempt` and `deploy_failure` (the first start, 05:47Z) has neither a runner nor a failure line
const interrupted = attempts.filter((a) => !a.deploy_failure && !a.runner_start);
const withRunner = attempts.filter((a) => a.runner_start);
const missingSummary = withRunner.filter((a) => !runs.find((r) => r.run === a.run)).map((a) => a.run);

// ---------- endpoints (§5) ----------
const exec = runs.filter((r) => r.executable);
const rb = exec.filter((r) => r.scored.verdict === 'rollback');
const halts = runs.filter((r) => r.scored.verdict === 'halt');
const e2count = runs.filter((r) => r.counts_for_e2).length;
const w0rb = runs.filter((r) => r.w0.verdict === 'rollback');
const cp = (k, n, side) => { // Clopper–Pearson one-sided 95% bound by bisection on the binomial tail
  const lnC = (n, k) => { let r = 0; for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i); return r; };
  const tailGe = (p, k) => { let s = 0; for (let j = k; j <= n; j++) s += Math.exp(lnC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); return s; };
  const tailLe = (p, k) => { let s = 0; for (let j = 0; j <= k; j++) s += Math.exp(lnC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); return s; };
  let lo = 1e-9, hi = 1 - 1e-9;
  for (let i = 0; i < 80; i++) { const p = (lo + hi) / 2; const ok = side === 'lower' ? tailGe(p, k) < 0.05 : tailLe(p, k) < 0.05; if (side === 'lower') { if (ok) lo = p; else hi = p; } else { if (ok) hi = p; else lo = p; } }
  return side === 'lower' ? lo : hi;
};
const stopped = rb.length >= REG.stop_after_rollbacks;
const E = {
  registered: REG,
  attempts: attempts.length, deploy_failures: deployFailures.length, deploy_failure_runs: deployFailures.map((a) => a.run), interrupted_attempts: interrupted.map((a) => a.run), runs_with_runner: withRunner.length, summaries: runs.length, missing_summary: missingSummary,
  executable: exec.length, void: runs.filter((r) => !r.executable).length, void_runs: runs.filter((r) => !r.executable).map((r) => ({ run: r.run, reasons: r.void_reasons })),
  stop_rule_tripped: stopped,
  E1: { rollbacks: rb.length, executable: exec.length, rate: exec.length ? rb.length / exec.length : null, cp_lower95: exec.length ? cp(rb.length, exec.length, 'lower') : null, cp_upper95: exec.length ? cp(rb.length, exec.length, 'upper') : null,
    verdict: stopped ? 'FAIL' : exec.length >= REG.R ? (rb.length <= REG.e1_max_rollbacks ? 'PASS' : 'FAIL') : 'NOT SCORED (cell incomplete, not stopped by rule)', rollback_runs: rb.map((r) => r.run) },
  E2: { count: e2count, verdict: e2count > REG.e2_max ? 'FAIL' : stopped || exec.length >= REG.R ? 'PASS' : 'NOT SCORED' },
  E3: { halts: halts.length, attempted: attempts.length, verdict: halts.length <= REG.e3_max_halts ? 'PASS' : 'FAIL' },
  P1: { registered: 'E1 holds; point figure 0–6 rollbacks in 100', held: !stopped && rb.length <= REG.e1_max_rollbacks },
  P2: { registered: 'E2 holds with at most 1 void run ending in rollback', held: e2count <= REG.e2_max, void_rollbacks: runs.filter((r) => !r.executable && r.w0.verdict === 'rollback').length },
  P3: { registered: 'E3 holds with 0 halts', held: halts.length === 0 },
  P4: { registered: 'W0 rollbacks at most 10 in 100', w0_rollbacks: w0rb.length, held: w0rb.length <= REG.e1_max_rollbacks },
  per_lane: [0, 1, 2, 3].map((l) => { const ex = exec.filter((r) => r.lane === l); return { lane: l, attempts: attempts.filter((a) => a.lane === l).length, executable: ex.length, rollbacks: ex.filter((r) => r.scored.verdict === 'rollback').length, holds: ex.filter((r) => r.scored.verdict === 'hold').length }; }),
  rollback_ticks: rb.map((r) => ({ run: r.run, lane: r.lane, scored_tick: r.scored.ticks, w0_tick: r.w0.ticks, fired: r.fired, p99_canary_worse_share: r.p99_canary_worse_share })),
  fired_by_detector: rb.reduce((m, r) => { for (const d of r.fired) m[d] = (m[d] ?? 0) + 1; return m; }, {}),
  hold_p99_worse_shares: exec.filter((r) => r.scored.verdict === 'hold').map((r) => r.p99_canary_worse_share),
  authority_violations: runs.filter((r) => r.authority_violation).length,
  any_unhealthy_target_runs: runs.filter((r) => r.any_unhealthy_target).map((r) => r.run),
  v67: { evaluated_runs: runs.filter((r) => r.v67.evaluated).length, flagged_runs: runs.filter((r) => r.v67.events_inside.length).map((r) => r.run), unassigned_inside_runs: runs.filter((r) => r.v67.unassigned_inside.length).map((r) => ({ run: r.run, events: r.v67.unassigned_inside })) },
  repo_shas: [...new Set(runs.map((r) => r.repo_sha))], engines: [...new Set(runs.map((r) => JSON.stringify(r.engine)))].map((s) => JSON.parse(s)), config_sha256_by_lane: Object.fromEntries([0, 1, 2, 3].map((l) => [l, [...new Set(runs.filter((r) => r.lane === l).map((r) => r.config_sha256))]])),
};

// ---------- write ----------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const OUT = join(RES, `run-${stamp}`);
if (existsSync(OUT)) throw new Error(`${OUT} exists`);
mkdirSync(OUT);
const git = (c) => execSync(c, { cwd: STUDY, encoding: 'utf8' }).trim();
const manifest = { study_id: '2026-10-twin-aa-real', cell: CELL, generated_at: new Date().toISOString(), analysis_repo_head: git('git rev-parse HEAD'), analysis_tracked_changes: git('git status --porcelain --untracked-files=no -- .').split('\n').filter(Boolean),
  inputs: { summaries: runFiles.length, driver_logs: driverFiles.length, evidence: evidence ? { count: evidence.count, start: evidence.start, end: evidence.end, generated_at: evidence.generated_at } : null },
  runner_repo_shas: E.repo_shas, engines: E.engines, deviation: 'analysis script written after the runs (PREREGISTRATION.md §8 asks for it before the first run it summarizes)' };
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(E, null, 1) + '\n');
writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 1) + '\n');
const f3 = (x) => (x == null ? '—' : x.toFixed(3));
const table = [
  `# Endpoint table — ${CELL} cell (generated ${manifest.generated_at})`, '',
  '| Endpoint | Registered | Observed | Verdict |', '|---|---|---|---|',
  `| E1 false rollback | ≤ ${REG.e1_max_rollbacks} of ${REG.R} executable (B ${REG.B}); stop at ${REG.stop_after_rollbacks} | ${E.E1.rollbacks}/${E.E1.executable} = ${f3(E.E1.rate)} (95% one-sided bounds ${f3(E.E1.cp_lower95)}–${f3(E.E1.cp_upper95)}) | ${E.E1.verdict} |`,
  `| E2 sensitivity count | ≤ ${REG.e2_max} | ${E.E2.count} | ${E.E2.verdict} |`,
  `| E3 sample-ratio halts | ≤ ${REG.e3_max_halts} of attempted | ${E.E3.halts} of ${E.E3.attempted} | ${E.E3.verdict} |`, '',
  `Attempts ${E.attempts}: deploy failures ${E.deploy_failures} (runs ${E.deploy_failure_runs.join(', ') || 'none'}), attempts interrupted before arm-ready ${E.interrupted_attempts.length} (runs ${E.interrupted_attempts.join(', ') || 'none'}), runs with a runner ${E.runs_with_runner}; summaries ${E.summaries}; executable ${E.executable}; void ${E.void}; stop rule tripped: ${E.stop_rule_tripped}.`, '',
  `Post-hoc, no verdict — share of scored ticks with canary p99 above control p99, over the ticks the scored session used: holds (n ${E.hold_p99_worse_shares.length}) min ${f3(Math.min(...E.hold_p99_worse_shares))}, median ${f3([...E.hold_p99_worse_shares].sort((a, b) => a - b)[Math.floor(E.hold_p99_worse_shares.length / 2)] ?? null)}, max ${f3(Math.max(...E.hold_p99_worse_shares))}; rollbacks min ${f3(Math.min(...E.rollback_ticks.map((r) => r.p99_canary_worse_share)))}, max ${f3(Math.max(...E.rollback_ticks.map((r) => r.p99_canary_worse_share)))}. Fired by detector: ${JSON.stringify(E.fired_by_detector)}.`, '',
  '| Lane | Attempts | Executable | Rollback | Hold |', '|---|---|---|---|---|',
  ...E.per_lane.map((l) => `| ${l.lane} | ${l.attempts} | ${l.executable} | ${l.rollbacks} | ${l.holds} |`), '',
  '| Rollback run | Lane | Scored tick | W0 tick | Fired | p99 canary-worse share |', '|---|---|---|---|---|---|',
  ...E.rollback_ticks.map((r) => `| ${r.run} | ${r.lane} | ${r.scored_tick} | ${r.w0_tick} | ${r.fired.join(', ')} | ${f3(r.p99_canary_worse_share)} |`), '',
  `Predictions: P1 ${E.P1.held ? 'held' : 'NOT held'}; P2 ${E.P2.held ? 'held' : 'NOT held'}; P3 ${E.P3.held ? 'held' : 'NOT held'}; P4 ${E.P4.held ? 'held' : 'NOT held'} (W0 rollbacks ${E.P4.w0_rollbacks}).`,
  `V6/V7: evaluated on ${E.v67.evaluated_runs} of ${E.summaries} runs; flagged ${E.v67.flagged_runs.length ? E.v67.flagged_runs.join(', ') : 'none'}. Authority violations ${E.authority_violations}. Runs with any unhealthy target ${E.any_unhealthy_target_runs.length ? E.any_unhealthy_target_runs.join(', ') : 'none'}.`,
];
writeFileSync(join(OUT, 'REPORT-TABLE.md'), table.join('\n') + '\n');
console.log(table.join('\n'));
console.log(`\nwritten: ${OUT}`);

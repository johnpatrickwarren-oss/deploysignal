// studies/twin-two-sample-replay/harness/run.mjs — study 2026-10-twin-two-sample-replay. Registered in ../PREREGISTRATION.md
// (ffbcb7c) before this file existed. Replays the engine's two-sample kind (ENGINE_DIST, module pinned by hash) over the
// stored twin runs' scored ticks: coordinates [5xx rate, p99 ms] per arm.
//   ENGINE_DIST=<engine dist> ONEBOX_RUNS=<dir of onebox run files, optional> node studies/twin-two-sample-replay/harness/run.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)); const STUDY = join(HERE, '..'); const REPO = join(STUDY, '..', '..');
const ENGINE = process.env.ENGINE_DIST ?? join(REPO, '..', 'deploysignal-engine', 'dist');
const MODULE_SHA256 = '01afa96cbe0f9e7dbfb113f1f249e32ca7e8d54c1ed5d0ef606e936dc6eeb357';
const hash = createHash('sha256').update(readFileSync(join(ENGINE, 'detectors', 'twin-two-sample.js'))).digest('hex');
if (hash !== MODULE_SHA256) throw new Error(`NOT EXECUTABLE: twin-two-sample.js sha256 ${hash} is not the pinned ${MODULE_SHA256}`);
const ts = require(join(ENGINE, 'detectors', 'twin-two-sample.js'));
const ALPHA = 0.05;
const ARMS = {
  'TS-m': { id: 'joint', alpha: ALPHA, window: 200, localWindow: 20, coordinates: [{ id: 'http_5xx', margin: { relative: 0.2 } }, { id: 'p99_latency', margin: { relative: 0.10 } }] },
  'TS-0': { id: 'joint', alpha: ALPHA, window: 200, localWindow: 20, coordinates: [{ id: 'http_5xx' }, { id: 'p99_latency' }] },
};
// §1 sources: each study's committed runs dir; onebox from ONEBOX_RUNS when given (closed runs only)
const SOURCES = [
  { study: 'twin-aa-real', cell: 'AA', dir: join(REPO, 'studies', 'twin-aa-real', 'results', 'runs'), prefix: 'AA-', tasks: 2, bar: 0.1062, permetric: '12/44' },
  { study: 'twin-aa-real-2', cell: 'AA', dir: join(REPO, 'studies', 'twin-aa-real-2', 'results', 'runs'), prefix: 'AA-', tasks: 4, bar: 0.1062, permetric: '0/100' },
  ...(process.env.ONEBOX_RUNS ? [{ study: 'twin-aa-onebox', cell: 'AA', dir: process.env.ONEBOX_RUNS, prefix: 'AA-', tasks: 1, bar: 0.1062, permetric: 'running' }] : []),
  ...['AB-lat30', 'AB-5xx-1.5', 'AB-reset', 'AB-reset-nr'].map((c) => ({ study: 'twin-fault-shapes', cell: c, dir: join(REPO, 'studies', 'twin-fault-shapes', 'results', 'runs'), prefix: c + '-', tasks: 4, bar: null, permetric: { 'AB-lat30': '20/20 @11', 'AB-5xx-1.5': '20/20 @40', 'AB-reset': '0/20', 'AB-reset-nr': '20/20 @12 (no_response)' }[c] })),
];
const counters = { exceptions: 0 }; const exceptionLog = [];
function replayRun(file, spec) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const windows = lines.filter((l) => l.type === 'window' && l.scored_tick === true);
  let st = ts.initTwinTwoSample(spec); let fire = null; let k = 0;
  for (const w of windows) {
    k++;
    const o = w.body?.observations ?? {}; const e = o.http_5xx ?? {}; const p = o.p99_latency ?? {};
    const x = [e.canary_total > 0 ? e.canary_events / e.canary_total : NaN, Number.isFinite(p.canary) ? p.canary * 1000 : NaN];
    const y = [e.control_total > 0 ? e.control_events / e.control_total : NaN, Number.isFinite(p.control) ? p.control * 1000 : NaN];
    const s = ts.stepTwinTwoSample(spec, st, x, y); st = s.state;
    if (s.fire) { fire = k; break; }
  }
  return { scored_ticks: windows.length, fire_tick: fire, outcome: fire === null ? 'hold' : 'rollback', missing: st.missing };
}
const results = []; const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const out = join(STUDY, 'results', `run-${stamp}`); if (existsSync(out)) throw new Error('refusing to overwrite');
for (const src of SOURCES) {
  const files = readdirSync(src.dir).filter((f) => f.startsWith(src.prefix) && f.endsWith('.jsonl') && !f.includes('summary')).sort();
  for (const f of files) {
    const base = f.replace(/-\d{8}T\d{6}Z\.jsonl$/, ''); const summ = readdirSync(src.dir).find((g) => g.startsWith(base + '-') && g.endsWith('.summary.json'));
    let voidReasons = [], scoredVerdict = null, scoredTicks = null, fired = [];
    if (summ) { const S = JSON.parse(readFileSync(join(src.dir, summ), 'utf8')); voidReasons = S.void_reasons ?? []; scoredVerdict = S.scored?.verdict ?? null; scoredTicks = S.scored?.ticks ?? null; fired = S.scored?.fired ?? []; }
    const m = /-l(\d)-r(\d+)-/.exec(f); const lane = m ? Number(m[1]) : null, run = m ? Number(m[2]) : null;
    for (const [arm, spec] of Object.entries(ARMS)) {
      let r = null;
      try { r = replayRun(join(src.dir, f), spec); } catch (e) { counters.exceptions++; exceptionLog.push({ file: f, arm, error: String(e?.message).slice(0, 300) }); }
      results.push({ study: src.study, cell: src.cell, tasks: src.tasks, file: f, lane, run, arm, executable: voidReasons.length === 0, void_reasons: voidReasons, permetric_verdict: scoredVerdict, permetric_ticks: scoredTicks, permetric_fired: fired, ...(r ?? { outcome: 'exception' }) });
    }
  }
}
// endpoints
const upper95 = (k, n) => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const p = (lo + hi) / 2; let cdf = 0; for (let j = 0; j <= k; j++) cdf += Math.exp(lgC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); if (cdf > 0.05) lo = p; else hi = p; } return hi; };
function lgC(n, k) { return lg(n + 1) - lg(k + 1) - lg(n - k + 1); }
function lg(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const E = {};
for (const src of SOURCES) for (const arm of Object.keys(ARMS)) {
  const rows = results.filter((r) => r.study === src.study && r.cell === src.cell && r.arm === arm && r.executable && r.outcome !== 'exception');
  const rb = rows.filter((r) => r.outcome === 'rollback');
  E[`${src.study}/${src.cell}/${arm}`] = { study: src.study, cell: src.cell, arm, tasks: src.tasks, runs: rows.length, rollbacks: rb.length, rate: rows.length ? rb.length / rows.length : null, upper95: rows.length ? upper95(rb.length, rows.length) : null, median_tick: med(rb.map((r) => r.fire_tick)), bar: src.bar, verdict: src.bar === null ? 'reported' : (rows.length ? (rb.length / rows.length <= src.bar ? 'PASS' : 'FAIL') : 'n/a'), permetric: src.permetric, permetric_rollbacks_same_runs: rows.filter((r) => r.permetric_verdict === 'rollback').length, mean_missing: rows.length ? rows.reduce((a, r) => a + r.missing, 0) / rows.length : null };
}
mkdirSync(out, { recursive: true });
const repoSha = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); const engineSha = execSync('git rev-parse HEAD', { cwd: join(ENGINE, '..') }).toString().trim();
writeFileSync(join(out, 'runs.json'), JSON.stringify(results, null, 1));
writeFileSync(join(out, 'endpoints.json'), JSON.stringify({ study: '2026-10-twin-two-sample-replay', generated: new Date().toISOString(), arms: ARMS, counters, exceptions: exceptionLog, rows: Object.values(E) }, null, 2));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ repo_sha: repoSha, engine_sha: engineSha, module_sha256: hash, onebox_runs: process.env.ONEBOX_RUNS ?? null, node: process.version }, null, 2));
for (const r of Object.values(E)) console.log(`${(r.study + '/' + r.cell).padEnd(28)} ${r.arm} tasks=${r.tasks} ${r.rollbacks}/${r.runs} (median tick ${r.median_tick}) ${r.verdict} | per-metric ${r.permetric}`);
console.log(`exceptions ${counters.exceptions}; written ${out}`);

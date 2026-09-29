// studies/mini-twin-aa/harness/run.mjs — study 2026-09-mini-twin-aa, the registered run and its smoke.
// Usage: node studies/mini-twin-aa/harness/run.mjs [--mode full|smoke] [--out results/run-<UTC>]
//   MINI_DATA=<dir of the ten pre-gap ndjson files> (default ../tessera/runs/mini-data)
// No RNG, no wall clock in artifacts, every catch counted, append-only run dir.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const REPO = join(STUDY, '..', '..');
const DATA = process.env.MINI_DATA ?? join('/Users/johnwarren/concord/tessera/runs/mini-data');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const mode = arg('--mode', 'full');
const runId = arg('--run-id', `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
const OUT = arg('--out', join(STUDY, 'results', runId));
if (existsSync(OUT)) { console.error(`refusing to overwrite ${OUT}`); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

export const STUDY_ID = '2026-09-mini-twin-aa';
export const TICK_S = 10;
export const WINDOW = 360;
export const MIN_PRESENT = 180;
export const CLUSTERS = { E: ['c0', 'c1', 'c2', 'c3'], P0: ['c4', 'c5', 'c6', 'c7', 'c8'], P1: ['c9', 'c10', 'c11', 'c12', 'c13'] };
export const PAIRS = [
  { arm: 'S', id: 'c0-c1', canary: 'c0', control: 'c1', cluster: 'E' }, { arm: 'S', id: 'c2-c3', canary: 'c2', control: 'c3', cluster: 'E' },
  { arm: 'S', id: 'c4-c5', canary: 'c4', control: 'c5', cluster: 'P0' }, { arm: 'S', id: 'c6-c7', canary: 'c6', control: 'c7', cluster: 'P0' },
  { arm: 'S', id: 'c9-c10', canary: 'c9', control: 'c10', cluster: 'P1' }, { arm: 'S', id: 'c11-c12', canary: 'c11', control: 'c12', cluster: 'P1' },
  { arm: 'X', id: 'c0-c9', canary: 'c0', control: 'c9', cluster: 'E/P1' },
];
export const PROFILE = { canary_weight: 0.5, alpha_rollback: 0.05, alpha_proceed: 0.05, alpha_srm: 0.001, max_ticks: WINDOW, metrics: [{ id: 'core_res', kind: 'sign', worse: 'higher', tolerance: 0.15 }] };

const counters = { exceptions: 0, hash_mismatches: 0 };
const exceptionLog = [];
const counted = (label, fn) => { try { return fn(); } catch (e) { counters.exceptions++; exceptionLog.push({ label, error: String(e?.stack ?? e).slice(0, 2000) }); return null; } };

// ── freeze ───────────────────────────────────────────────────────────────────────────────────
const sums = new Map(readFileSync(join(STUDY, 'SHA256SUMS'), 'utf8').split('\n').map((l) => l.trim().split(/\s+\*?/)).filter((p) => p.length === 2).map(([h, n]) => [basename(n), h]));
const files = [...sums.keys()].sort();
const hashChecks = [];
for (const f of files) {
  const got = createHash('sha256').update(readFileSync(join(DATA, f))).digest('hex');
  const ok = got === sums.get(f); hashChecks.push({ file: f, ok }); if (!ok) counters.hash_mismatches++;
}
if (counters.hash_mismatches > 0) { writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ study: STUDY_ID, not_executable: ['hash_mismatch'], hashChecks }, null, 2)); console.error('NOT-EXECUTABLE: hash mismatch'); process.exit(3); }

// ── ticks ────────────────────────────────────────────────────────────────────────────────────
const CORES = Object.values(CLUSTERS).flat();
const acc = new Map();   // tick -> { n, sum[core], mhz[core] }
let rawLines = 0, rawBad = 0;
for (const f of files) {
  const rl = createInterface({ input: createReadStream(join(DATA, f)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { rawBad++; continue; }
    rawLines++;
    const k = Math.floor(d.t / TICK_S);
    let a = acc.get(k); if (!a) { a = { n: 0, res: Object.fromEntries(CORES.map((c) => [c, 0])), mhz: Object.fromEntries(CORES.map((c) => [c, 0])), cl: { e: 0, p0: 0, p1: 0 }, clres: { e: 0, p0: 0, p1: 0 } }; acc.set(k, a); }
    a.n++;
    for (const c of CORES) { a.res[c] += Number(d[`${c}_res`]) || 0; a.mhz[c] += Number(d[`${c}_mhz`]) || 0; }
    a.cl.e += Number(d.e_mhz) || 0; a.cl.p0 += Number(d.p0_mhz) || 0; a.cl.p1 += Number(d.p1_mhz) || 0;
    a.clres.e += Number(d.e_res) || 0; a.clres.p0 += Number(d.p0_res) || 0; a.clres.p1 += Number(d.p1_res) || 0;
  }
}
const keys = [...acc.keys()].sort((a, b) => a - b);
const k0 = keys[0], k1 = keys[keys.length - 1];
const nTicks = k1 - k0 + 1;
const value = (k, c) => { const a = acc.get(k); return a ? a.res[c] / a.n : null; };

// §0(c) layout check (Amendment 1): each core's residency correlates best with its declared cluster's
// residency over the whole substrate.
function corr(x, y) { const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0; }
const clRes = { E: keys.map((k) => acc.get(k).clres.e / acc.get(k).n), P0: keys.map((k) => acc.get(k).clres.p0 / acc.get(k).n), P1: keys.map((k) => acc.get(k).clres.p1 / acc.get(k).n) };
const layout = {};
for (const [name, cores] of Object.entries(CLUSTERS)) {
  for (const c of cores) {
    const x = keys.map((k) => acc.get(k).res[c] / acc.get(k).n);
    const r = { E: corr(x, clRes.E), P0: corr(x, clRes.P0), P1: corr(x, clRes.P1) };
    const best = Object.entries(r).sort((a, b) => b[1] - a[1])[0][0];
    layout[c] = { declared: name, best, r };
  }
}
const layoutBad = Object.entries(layout).filter(([, l]) => l.best !== l.declared).map(([c]) => c);

// ── gate ─────────────────────────────────────────────────────────────────────────────────────
const twin = require(join(REPO, 'dist/engine/gates/_health-twin.js'));
function runWindow(pair, start, opts = {}) {
  let run = twin.freshTwinArm(PROFILE);
  const rec = { pair: pair.id, arm: pair.arm, cluster: pair.cluster, start_tick: start, start_t: (k0 + start) * TICK_S, outcome: 'inconclusive', verdict_tick: null, present: 0, skipped: 0, used: 0, ties: 0, missing: 0, voided: false, ...(opts.inject ? { inject: opts.inject } : {}), ...(opts.swap ? { swap: true } : {}) };
  let report = null;
  for (let t = 0; t < WINDOW; t++) {
    const k = k0 + start + t;
    let x = value(k, pair.canary), y = value(k, pair.control);
    let input;
    if (x === null || y === null) { input = { canaryRequests: 0, controlRequests: 0, observations: {} }; }
    else {
      rec.present++;
      if (opts.inject) x += opts.inject;
      if (opts.swap) [x, y] = [y, x];
      input = { canaryRequests: 1, controlRequests: 1, observations: { core_res: { canary: x, control: y } } };
    }
    const step = twin.stepTwinArm(PROFILE, run, input);
    run = step.run; report = step.report;
    if (report.engine_verdict !== 'extend') { rec.outcome = report.engine_verdict; rec.verdict_tick = t; break; }
  }
  const m = report?.metrics?.[0];
  if (m) { rec.used = m.used; rec.ties = m.ties; rec.skipped = m.skipped; rec.missing = m.missing; rec.rollback_e = m.rollback_e; rec.proceed_e = m.proceed_e; }
  return rec;
}

const windows = [];
const starts = []; for (let s = 0; s + WINDOW <= nTicks; s += WINDOW) starts.push(s);
const presentIn = (s) => { let n = 0; for (let t = 0; t < WINDOW; t++) if (acc.has(k0 + s + t)) n++; return n; };
const scorableStarts = starts.filter((s) => presentIn(s) >= MIN_PRESENT);
const unscorable = starts.filter((s) => presentIn(s) < MIN_PRESENT).map((s) => ({ start_tick: s, present: presentIn(s) }));

let smoke = null;
if (mode === 'smoke') {
  const s = scorableStarts[0]; const pair = PAIRS[0];
  const plain = runWindow(pair, s), inj = runWindow(pair, s, { inject: 20 }), sw = runWindow(pair, s, { swap: true });
  smoke = { start: s, plain, injected: inj, swapped: sw, checks: { i_injected_rollback: inj.outcome === 'rollback', ii_rollback_swaps_to_proceed: plain.outcome !== 'rollback' || sw.outcome === 'proceed', iii_accounting: plain.used + plain.ties + plain.skipped + plain.missing === (plain.verdict_tick === null ? WINDOW : plain.verdict_tick + 1) } };
} else {
  for (const pair of PAIRS) for (const s of scorableStarts) { const r = counted(`${pair.id}@${s}`, () => runWindow(pair, s)); windows.push(r ?? { pair: pair.id, arm: pair.arm, start_tick: s, voided: true }); }
}

// ── endpoints ────────────────────────────────────────────────────────────────────────────────
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
function binomCdf(k, n, p) { if (p <= 0) return 1; if (p >= 1) return k >= n ? 1 : 0; let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return Math.min(1, s); }
function cpUpper95(k, n) { if (n === 0) return null; if (k >= n) return 1; let lo = k / n, hi = 1; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (binomCdf(k, n, mid) > 0.05) lo = mid; else hi = mid; } return hi; }
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const summarize = (ws) => { const n = ws.length; const by = (o) => ws.filter((w) => w.outcome === o); const rb = by('rollback'); const used = ws.reduce((a, w) => a + w.used, 0), ties = ws.reduce((a, w) => a + w.ties, 0), skipped = ws.reduce((a, w) => a + w.skipped, 0);
  return { windows: n, rollbacks: rb.length, rate: n ? rb.length / n : null, cp_upper95: cpUpper95(rb.length, n), median_rollback_tick: median(rb.map((w) => w.verdict_tick)),
    proceed: by('proceed').length, inconclusive: by('inconclusive').length, invalid_experiment: by('invalid_experiment').length, median_proceed_tick: median(by('proceed').map((w) => w.verdict_tick)),
    tie_share: used + ties ? ties / (used + ties) : null, skipped_share: used + ties + skipped ? skipped / (used + ties + skipped) : null }; };
const scored = windows.filter((w) => !w.voided);
const endpoints = { per_pair: {}, not_executable: [] };
for (const p of PAIRS) endpoints.per_pair[p.id] = { arm: p.arm, cluster: p.cluster, ...summarize(scored.filter((w) => w.pair === p.id)) };
const armS = scored.filter((w) => w.arm === 'S');
endpoints.E1 = { ...summarize(armS), pass: armS.length ? armS.filter((w) => w.outcome === 'rollback').length / armS.length <= 0.05 : null, per_pair_pass: Object.fromEntries(PAIRS.filter((p) => p.arm === 'S').map((p) => [p.id, endpoints.per_pair[p.id].rate === null ? null : endpoints.per_pair[p.id].rate <= 0.05])) };
endpoints.E3 = endpoints.per_pair['c0-c9'];
endpoints.E4 = { hashes_ok: counters.hash_mismatches === 0, exceptions: counters.exceptions, scorable_windows: scorableStarts.length, layout_contradicted: layoutBad, pass: counters.hash_mismatches === 0 && counters.exceptions === 0 && scorableStarts.length >= 100 && layoutBad.length === 0 };
if (scorableStarts.length < 100) endpoints.not_executable.push(`scorable_windows_${scorableStarts.length}_below_100`);
if (layoutBad.length) endpoints.not_executable.push(`layout_contradicted:${layoutBad.join(',')}`);
if (windows.length && windows.filter((w) => w.voided).length / windows.length > 0.05) endpoints.not_executable.push('voided_above_5pct');
if (mode !== 'full') endpoints.not_executable.push(`mode_${mode}`);
endpoints.executable = endpoints.not_executable.length === 0;

const enginePkg = JSON.parse(readFileSync(join(REPO, 'node_modules/@johnpatrickwarren-oss/deploysignal-engine/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const manifest = { study: STUDY_ID, mode, run_id: basename(OUT), repo_head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), tracked_changes: git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('??')),
  engine_installed: enginePkg.version, engine_resolved: lock.packages['node_modules/@johnpatrickwarren-oss/deploysignal-engine']?.resolved ?? null, node: process.version, platform: `${platform()} ${release()}`, cpus: cpus().length,
  substrate: { dir: DATA, files, hash_checks: hashChecks, raw_lines: rawLines, raw_bad: rawBad, tick_s: TICK_S, ticks: nTicks, ticks_present: keys.length, t_first: k0 * TICK_S, t_last: k1 * TICK_S, layout },
  design: { window: WINDOW, min_present: MIN_PRESENT, profile: PROFILE, pairs: PAIRS, windows_total: starts.length, scorable: scorableStarts.length, unscorable },
  authority: twin.TWIN_VERDICT_MAP ? 'advisory (TWIN_ARM_AUTHORITY unchanged)' : null, command: `node studies/mini-twin-aa/harness/run.mjs --mode ${mode}`, counters, exceptions: exceptionLog, ...(smoke ? { smoke } : {}), wall_seconds: Math.round((Date.now() - t0) / 1000) };
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(OUT, 'windows.json'), JSON.stringify(windows, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(endpoints, null, 2) + '\n');
console.log(JSON.stringify({ run: basename(OUT), executable: endpoints.executable, not_executable: endpoints.not_executable, ticks: nTicks, present: keys.length, scorable: scorableStarts.length, layout_bad: layoutBad, E1: endpoints.E1, per_pair: Object.fromEntries(Object.entries(endpoints.per_pair).map(([k, v]) => [k, { rate: v.rate, proceed: v.proceed, inconclusive: v.inconclusive, tie_share: v.tie_share }])), E4: endpoints.E4, ...(smoke ? { smoke: smoke.checks, plain: smoke.plain.outcome, injected: smoke.injected.outcome, swapped: smoke.swapped.outcome } : {}), wall_seconds: manifest.wall_seconds }, null, 1));

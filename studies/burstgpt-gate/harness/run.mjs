// studies/burstgpt-gate/harness/run.mjs — study 2026-09-burstgpt-gate, the registered run.
// Usage: node studies/burstgpt-gate/harness/run.mjs [--mode full|smoke] [--out results/run-<UTC>]
// Reuses the part-1 harness library (studies/gwdg-gate/harness/lib.mjs) for the compiler call,
// the engine loader, the scenario and the run-directory rule. No RNG, no wall clock in artifacts,
// every catch counted.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { compileBundle, loadEngine, buildScenario, ensureFreshDir, sha256File, ARMS } from '../../gwdg-gate/harness/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const REPO = join(STUDY, '..', '..');
const BUNDLE_DIR = join(REPO, 'runs', 'baselines', 'real-burstgpt-v2');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const mode = arg('--mode', 'full');
const runId = arg('--run-id', `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
const OUT = arg('--out', join(STUDY, 'results', runId));
ensureFreshDir(OUT);
const t0 = Date.now();
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

export const STUDY_ID = '2026-09-burstgpt-gate';
export const SUB_TICKS = 12;          // 12 × 5 s = 60 s
export const CAL_TICKS = 5760;        // four days
export const WINDOW = 100;
export const SIGNAL = 'cost_req';
export const PROFILE = 'generic-microservice@1.0.0';
const counters = { exceptions: 0, compile_failures: 0, hash_mismatches: 0 };
const exceptionLog = [];
const counted = (label, fn) => { try { return fn(); } catch (e) { counters.exceptions++; exceptionLog.push({ label, error: String(e?.stack ?? e).slice(0, 2000) }); return null; } };

// ── substrate ────────────────────────────────────────────────────────────────────────────────
const BUNDLE_SHA = '1b7b8ec46bbdac4edf4590c885950801d6236826f6ead406c59d3bc8b2241d90';   // registered in PREREGISTRATION §1 via the run manifest of the smoke; asserted below
const bundlePath = join(BUNDLE_DIR, 'bundle.jsonl');
const bundleSha = sha256File(bundlePath);
if (BUNDLE_SHA !== '1b7b8ec46bbdac4edf4590c885950801d6236826f6ead406c59d3bc8b2241d90' && bundleSha !== BUNDLE_SHA) counters.hash_mismatches++;
const raw = JSON.parse(readFileSync(bundlePath, 'utf8').trim());
const cost5 = raw.signal_series[SIGNAL], req5 = raw.auxiliary_series.requests_per_tick, hod5 = raw.hour_of_day, dow5 = raw.day_of_week;
const nTicks = Math.floor(cost5.length / SUB_TICKS);
const series = new Array(nTicks), requests = new Array(nTicks), hod = new Array(nTicks), dow = new Array(nTicks);
for (let k = 0; k < nTicks; k++) {
  let tot = 0, cnt = 0;
  for (let i = k * SUB_TICKS; i < (k + 1) * SUB_TICKS; i++) if (req5[i] > 0) { tot += cost5[i] * req5[i]; cnt += req5[i]; }
  series[k] = cnt > 0 ? tot / cnt : null; requests[k] = cnt; hod[k] = hod5[k * SUB_TICKS]; dow[k] = dow5 ? dow5[k * SUB_TICKS] : 0;
}
const missing = series.filter((v) => v === null).length;

// ── calibration bundle ───────────────────────────────────────────────────────────────────────
const bdir = join(OUT, 'bundle');
mkdirSync(bdir, { recursive: true });
const runs = []; let cur = null;
for (let k = 0; k < CAL_TICKS; k++) {
  if (series[k] === null) { if (cur) { runs.push(cur); cur = null; } continue; }
  if (!cur) cur = { tenant_id: raw.tenant_id, signal_series: { [SIGNAL]: [] }, hour_of_day: [], day_of_week: [] };
  cur.signal_series[SIGNAL].push(series[k]); cur.hour_of_day.push(hod[k]); cur.day_of_week.push(dow[k]);
}
if (cur) runs.push(cur);
const calPresent = runs.reduce((a, r) => a + r.hour_of_day.length, 0);
writeFileSync(join(bdir, 'manifest.json'), JSON.stringify({ version: 'real_burstgpt-v2-60s-cal4d', generated_at: 'real-burstgpt-v2', seed: 0, cell_dim: 'hour_of_day', n_runs: runs.length,
  ticks_per_run: Math.max(0, ...runs.map((r) => r.hour_of_day.length)), tenants: 1, signals: [SIGNAL], baseline_provenance: 'real_burstgpt',
  caveat_filters_applied: [...(raw.caveat_filters_applied ?? []), 'burstgpt_gate:60s_request_weighted_cost_per_request', 'burstgpt_gate:empty_ticks_missing_not_zero', 'burstgpt_gate:calibration_first_5760_ticks'] }, null, 2) + '\n');
writeFileSync(join(bdir, 'bundle.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
mkdirSync(join(OUT, 'configs'), { recursive: true });
const cfgPath = join(OUT, 'configs', 'generic-microservice.A.json');
const compileArgs = ['tools/calibrate.js', '--baseline', bdir, '--alpha', '1e-3', '--families', 'A', '--profile_ref', PROFILE, '--out', cfgPath, '--disable_worker_pool', 'true'];
let compile;
try {
  const stdout = execFileSync('node', compileArgs, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  compile = { ok: true, config: JSON.parse(readFileSync(cfgPath, 'utf8')), stdout_tail: stdout.slice(-1500) };
} catch (e) { counters.compile_failures++; compile = { ok: false, error: String(e.message ?? e).slice(0, 4000), stderr: String(e.stderr ?? '').slice(0, 4000) }; }
void compileBundle; void ARMS;

// ── windows ──────────────────────────────────────────────────────────────────────────────────
const windows = [];
if (compile.ok) {
  const engine = loadEngine(REPO);
  const cfg = compile.config;
  const per = cfg.baseline_cells?.aggregate_fallback?.family_A?.per_signal?.[SIGNAL];
  const scenario = buildScenario({ [SIGNAL]: per?.baseline_mean_raw ?? per?.baseline_mean });
  const nWin = mode === 'smoke' ? 1 : Math.floor((nTicks - CAL_TICKS) / WINDOW);
  for (let k = 0; k < nWin; k++) {
    const start = CAL_TICKS + k * WINDOW;
    const rec = counted(`window ${k}`, () => {
      const tb = new engine.TrendBuffer(10);
      const r = { k, start, end: start + WINDOW, day_group: k <= 57 ? 'days_4_to_8' : 'days_9_to_10', outcome: 'proceed', fire_tick: null, first_signal: null, rollback_ids: [],
        missing_ticks: 0, present_ticks: 0, evaluated: 0, shadow_empty_present: 0, requests: 0, voided: false, inject: mode === 'smoke' ? 3 : null };
      for (let t = 0; t < WINDOW; t++) {
        const live = {}; const v = series[start + t];
        if (v === null) r.missing_ticks++; else { live[SIGNAL] = mode === 'smoke' ? v * 3 : v; tb.push(SIGNAL, live[SIGNAL]); r.present_ticks++; r.requests += requests[start + t]; }
        const res = engine.orchestrate({ liveMetrics: live, scenario, hoursElapsed: t / 60, trendBuffer: tb, tick: t, totalTicks: WINDOW, compiledConfig: cfg, currentHourOfDay: hod[start + t], fusionTopology: 'portfolio' });
        r.evaluated++;
        if (v !== null && !(res.healthResult?.family_A_shadow?.length > 0)) r.shadow_empty_present++;
        if (res.verdict === 'rollback') {
          r.outcome = 'rollback'; r.fire_tick = t; r.rollback_ids = (res.healthResult?.rollback ?? []).map((x) => x.id);
          r.first_signal = (res.healthResult?.family_A_shadow ?? []).find((s) => s.verdict === 'fire')?.signal ?? r.rollback_ids[0] ?? null; break;
        }
      }
      return r;
    });
    windows.push(rec ?? { k, start, voided: true });
  }
}

// ── endpoints ────────────────────────────────────────────────────────────────────────────────
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
function binomCdf(k, n, p) { if (p <= 0) return 1; if (p >= 1) return k >= n ? 1 : 0; let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return Math.min(1, s); }
function cpUpper95(k, n) { if (n === 0) return null; if (k >= n) return 1; let lo = k / n, hi = 1; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (binomCdf(k, n, mid) > 0.05) lo = mid; else hi = mid; } return hi; }
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const scoredW = windows.filter((w) => !w.voided);
const rb = scoredW.filter((w) => w.outcome === 'rollback');
const presentTicks = scoredW.reduce((a, w) => a + (w.fire_tick !== null ? w.present_ticks : w.present_ticks), 0);
const grp = (g) => { const ws = scoredW.filter((w) => w.day_group === g); const r = ws.filter((w) => w.outcome === 'rollback'); return { windows: ws.length, rollbacks: r.length, rate: ws.length ? r.length / ws.length : null }; };
const endpoints = {
  E1: { windows: scoredW.length, rollbacks: rb.length, rate: scoredW.length ? rb.length / scoredW.length : null, cp_upper95: cpUpper95(rb.length, scoredW.length),
    per_1000_present_ticks: presentTicks ? rb.length / presentTicks * 1000 : null, present_ticks: presentTicks, pass: scoredW.length ? rb.length / scoredW.length <= 0.05 : null,
    median_fire_tick: median(rb.map((w) => w.fire_tick)), days_4_to_8: grp('days_4_to_8'), days_9_to_10: grp('days_9_to_10'),
    missing_share_fired: rb.length ? rb.reduce((a, w) => a + w.missing_ticks, 0) / (rb.length * WINDOW) : null,
    missing_share_unfired: scoredW.length - rb.length ? scoredW.filter((w) => w.outcome !== 'rollback').reduce((a, w) => a + w.missing_ticks, 0) / ((scoredW.length - rb.length) * WINDOW) : null,
    shadow_empty_present_total: scoredW.reduce((a, w) => a + w.shadow_empty_present, 0) },
  E2: { hash_ok: counters.hash_mismatches === 0, compile_ok: compile.ok, exceptions: counters.exceptions, pass: counters.hash_mismatches === 0 && compile.ok && counters.exceptions === 0 },
  not_executable: [],
};
if (counters.hash_mismatches) endpoints.not_executable.push('bundle_hash_mismatch');
if (!compile.ok) endpoints.not_executable.push('compile_failed');
if (mode === 'full' && scoredW.length < 60) endpoints.not_executable.push(`windows_${scoredW.length}_below_60`);
if (windows.length && windows.filter((w) => w.voided).length / windows.length > 0.05) endpoints.not_executable.push('voided_above_5pct');
if (mode !== 'full') endpoints.not_executable.push(`mode_${mode}`);
endpoints.executable = endpoints.not_executable.length === 0;

const enginePkg = JSON.parse(readFileSync(join(REPO, 'node_modules/@johnpatrickwarren-oss/deploysignal-engine/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const per = compile.ok ? compile.config.baseline_cells?.aggregate_fallback?.family_A?.per_signal ?? {} : {};
const manifest = {
  study: STUDY_ID, mode, run_id: basename(OUT), repo_head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  tracked_changes: git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('??')),
  engine_installed: enginePkg.version, engine_resolved: lock.packages['node_modules/@johnpatrickwarren-oss/deploysignal-engine']?.resolved ?? null,
  node: process.version, platform: `${platform()} ${release()}`, cpus: cpus().length,
  substrate: { bundle: 'runs/baselines/real-burstgpt-v2/bundle.jsonl', bundle_sha256: bundleSha, bundle_sha256_registered: BUNDLE_SHA, sub_ticks: SUB_TICKS, study_ticks: nTicks, missing_ticks: missing, missing_share: missing / nTicks },
  calibration: { ticks: CAL_TICKS, present: calPresent, runs: runs.length, profile: PROFILE, families: 'A', alpha: '1e-3', compile_args: compileArgs, compile_ok: compile.ok,
    ...(compile.ok ? { family_a_signals: compile.config.family_a_signals ?? null, bonferroni_factor: compile.config.bonferroni_factor ?? null, cells: compile.config.baseline_cells?.cells?.length ?? 0,
      cells_with_family_A: (compile.config.baseline_cells?.cells ?? []).filter((c) => c.family_A).length,
      per_signal: Object.fromEntries(Object.entries(per).map(([s, p]) => [s, { mean_raw: p.baseline_mean_raw ?? p.baseline_mean, sigma2_raw: p.baseline_sigma_squared_raw ?? p.baseline_sigma_squared, phi: p.ar1_phi ?? null, signal_class: p.signal_class ?? null, sigma_floor_applied: !!p.sigma_floor_applied, threshold_kind: p.betting_sliding_buffer_threshold !== undefined ? 'bootstrap' : 'ville' }])),
      config_sha256: sha256File(cfgPath) } : { error: compile.error, stderr: compile.stderr }) },
  window: WINDOW, command: `node studies/burstgpt-gate/harness/run.mjs --mode ${mode}`, counters, exceptions: exceptionLog, wall_seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(OUT, 'windows.json'), JSON.stringify(windows, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(endpoints, null, 2) + '\n');
console.log(JSON.stringify({ run: basename(OUT), executable: endpoints.executable, not_executable: endpoints.not_executable, E1: { windows: endpoints.E1.windows, rollbacks: endpoints.E1.rollbacks, rate: endpoints.E1.rate, pass: endpoints.E1.pass, days_4_to_8: endpoints.E1.days_4_to_8, days_9_to_10: endpoints.E1.days_9_to_10 }, E2: endpoints.E2, calibration: { present: calPresent, runs: runs.length, cells_with_family_A: manifest.calibration.cells_with_family_A, per_signal: manifest.calibration.per_signal }, wall_seconds: manifest.wall_seconds }, null, 1));

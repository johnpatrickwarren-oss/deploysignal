// studies/gwdg-gate/harness/run.mjs — study 2026-09-gwdg-gate, the registered run.
// Usage: node studies/gwdg-gate/harness/run.mjs [--mode full|pilot] [--out results/run-<UTC>]
//   GWDG_DATA=<dataset dir> (default: ../tessera/runs/gwdg-data/<version>)
// Writes results/run-<UTC>/{manifest.json, units.json, windows.json, endpoints.json}; refuses an existing dir.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import {
  STUDY_ID, SIGNALS, XID, ARMS, CALIBRATION_TICKS, CALIBRATION_PRESENCE_FLOOR, NULL_MIN_TICKS, DETECTION_HALF_TICKS,
  parseManifest, parseIncidents, eventsByNode, fileWindows, unitWindows, loadTidy, writeBundle, compileBundle,
  loadEngine, runWindow, loadSums, sha256File, ensureFreshDir, isoUtc, tickMs,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = join(HERE, '..');
const REPO = join(STUDY, '..', '..');
const DATA = process.env.GWDG_DATA ?? join(REPO, '..', 'tessera', 'runs', 'gwdg-data', 'gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const mode = arg('--mode', 'full');
const runId = arg('--run-id', `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
const OUT = arg('--out', join(STUDY, 'results', runId));
ensureFreshDir(OUT);
const t0 = Date.now();
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

const counters = { exceptions: 0, compile_failures: 0, hash_mismatches: 0 };
const exceptionLog = [];
function counted(label, fn) {
  try { return fn(); } catch (e) { counters.exceptions++; exceptionLog.push({ label, error: String(e?.stack ?? e).slice(0, 2000) }); return null; }
}

// ── freeze check ──────────────────────────────────────────────────────────────────────────────
const sums = loadSums(join(STUDY, 'SHA256SUMS'));
const hashChecks = [];
function verify(path) {
  const name = basename(path); const expect = sums.get(name);
  const got = sha256File(path);
  const ok = expect !== undefined && expect === got;
  hashChecks.push({ file: name, ok, expected: expect ?? null });
  if (!ok) counters.hash_mismatches++;
  return ok;
}
verify(join(DATA, 'incident_events.csv')); verify(join(DATA, 'manifest.csv'));
const manifestCsv = parseManifest(readFileSync(join(DATA, 'manifest.csv'), 'utf8'));
const incidents = parseIncidents(readFileSync(join(DATA, 'incident_events.csv'), 'utf8'));
const events = eventsByNode(manifestCsv, incidents);

// ── §2 file table (all label-heavy files, so the exclusion table is complete) ──────────────────
let files = [...manifestCsv.entries()].filter(([, m]) => m.inputType === 'label-heavy-prometheus').map(([f]) => f).sort();
if (mode === 'pilot') files = files.slice(0, 2);
const fileTable = files.map((f) => fileWindows(f, manifestCsv, events));

// ── engine ───────────────────────────────────────────────────────────────────────────────────
const engine = loadEngine(REPO);
const units = []; const windows = [];

for (const fw of fileTable) {
  const fileRec = { file: fw.file, node: fw.node, span: [isoUtc(fw.spanStart), isoUtc(fw.spanEnd)], I: isoUtc(fw.I), labelled: fw.labelled,
    E_first: fw.eFirst === null ? null : isoUtc(fw.eFirst), other_events: fw.others.map((e) => ({ day: isoUtc(e.dayMs), source: e.source, label: e.label })),
    confounded: fw.confounded };
  const path = join(DATA, 'telemetry', fw.file);
  if (!verify(path)) { units.push({ ...fileRec, gpu: null, eligible: false, reason: 'hash_mismatch' }); continue; }
  const tidy = await loadTidy(path);
  for (const gpu of tidy.gpus) {
    const unitId = `${fw.file.replace(/_tidy\.csv$/, '')}__gpu${gpu}`;
    const gs = tidy.series[gpu];
    const uw = unitWindows(fw, gs);
    const u = { ...fileRec, unit: unitId, gpu, uuid: tidy.uuid[gpu] ?? null, eligible: uw.eligible, reason: uw.reason,
      calibration: uw.calibration && { start: isoUtc(uw.calibration.start), end: isoUtc(uw.calibration.end), present_all: uw.calibration.present, per_signal: uw.calibration.perSignal },
      null_window: uw.nullWin && { start: isoUtc(uw.nullWin.start), end: isoUtc(uw.nullWin.end), ticks: uw.nullWin.ticks },
      null_reason: uw.nullReason ?? null,
      detection_window: uw.detection && { start: isoUtc(uw.detection.start), end: isoUtc(uw.detection.end), ticks: uw.detection.ticks },
      detection_reason: uw.detectionReason ?? null,
      bundle: null, compile: {}, voided: false };
    units.push(u);
    if (!uw.eligible) continue;
    const bdir = join(OUT, 'bundles', unitId);
    u.bundle = counted(`bundle ${unitId}`, () => writeBundle(bdir, unitId, tidy.uuid[gpu], gs, uw.calibration));
    if (!u.bundle) { u.voided = true; continue; }
    for (const arm of Object.keys(ARMS)) {
      mkdirSync(join(OUT, 'configs'), { recursive: true });
      const c = compileBundle(REPO, bdir, arm, join(OUT, 'configs', `${unitId}.${arm}.json`));
      const agg = c.ok ? c.config.baseline_cells?.aggregate_fallback : null;
      const per = agg?.family_A?.per_signal ?? {};
      u.compile[arm] = c.ok
        ? { ok: true, cells: c.config.baseline_cells?.cells?.length ?? 0, cells_with_family_A: (c.config.baseline_cells?.cells ?? []).filter((x) => x.family_A).length,
            family_C: !!agg?.family_C, bonferroni_factor: c.config.bonferroni_factor ?? null,
            sigma_floor_signals: SIGNALS.filter((s) => per[s]?.sigma_floor_applied), warnings: (c.config.compile_warnings ?? []).map((w) => w.code),
            per_signal: Object.fromEntries(SIGNALS.map((s) => [s, per[s] ? { mean: per[s].baseline_mean_raw ?? per[s].baseline_mean, sigma2: per[s].baseline_sigma_squared_raw ?? per[s].baseline_sigma_squared, phi: per[s].ar1_phi ?? null, threshold_kind: per[s].betting_sliding_buffer_threshold !== undefined ? 'bootstrap' : 'ville' } : null])) }
        : { ok: false, error: c.error, stderr: c.stderr };
      if (!c.ok) { counters.compile_failures++; continue; }
      for (const kind of ['null', 'detection']) {
        const win = kind === 'null' ? uw.nullWin : uw.detection;
        if (!win) continue;
        const rec = counted(`gate ${unitId} ${arm} ${kind}`, () => runWindow(engine, c.config, gs, win));
        if (!rec) { u.voided = true; windows.push({ unit: unitId, arm, kind, voided: true }); continue; }
        const lead = rec.fireMs === null ? null : (rec.fireMs - fw.I) / 3600000;
        windows.push({ unit: unitId, file: fw.file, gpu, arm, kind, ticks: win.ticks, start: isoUtc(win.start), end: isoUtc(win.end), voided: false,
          outcome: rec.outcome, fire_tick: rec.fireTick, fire_at: rec.fireMs === null ? null : isoUtc(rec.fireMs), lead_hours_vs_I: kind === 'detection' ? lead : null,
          xid_first_tick: rec.xidFirstTick, fire_minus_xid_ticks: rec.fireTick !== null && rec.xidFirstTick !== null ? rec.fireTick - rec.xidFirstTick : null,
          firing_families: rec.firingFamilies, rollback_ids: rec.rollbackIds, first_signal: rec.firstSignal,
          missing_ticks: rec.missingTicks, evaluated: rec.evaluated, outlook_empty: rec.outlookEmpty });
      }
    }
  }
  process.stdout.write(`${fw.file}: ${tidy.gpus.length} gpus; units so far ${units.length}; exceptions ${counters.exceptions}; compile failures ${counters.compile_failures}\n`);
}

// ── endpoints ────────────────────────────────────────────────────────────────────────────────
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
function binomCdf(k, n, p) { if (p <= 0) return 1; if (p >= 1) return k >= n ? 1 : 0; let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return Math.min(1, s); }
/** One-sided 95% Clopper–Pearson upper bound: the smallest p with P(X ≤ k; n, p) ≤ 0.05. */
function cpUpper95(k, n) { if (n === 0) return null; if (k >= n) return 1; let lo = k / n, hi = 1; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (binomCdf(k, n, mid) > 0.05) lo = mid; else hi = mid; } return hi; }
const median = (xs) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const scored = (arm, kind) => windows.filter((w) => w.arm === arm && w.kind === kind && !w.voided);
const endpoints = { arms: {}, E5: null, not_executable: [] };
for (const arm of Object.keys(ARMS)) {
  const nul = scored(arm, 'null'); const det = scored(arm, 'detection');
  const nullRb = nul.filter((w) => w.outcome === 'rollback');
  const nullTicks = nul.reduce((a, w) => a + (w.fire_tick !== null ? w.fire_tick + 1 : w.ticks), 0);
  const detRb = det.filter((w) => w.outcome === 'rollback');
  const leads = detRb.map((w) => w.lead_hours_vs_I);
  const vsXid = detRb.filter((w) => w.fire_minus_xid_ticks !== null).map((w) => w.fire_minus_xid_ticks);
  const e1rate = nul.length ? nullRb.length / nul.length : null; const e2rate = det.length ? detRb.length / det.length : null;
  endpoints.arms[arm] = {
    E1: { null_units: nul.length, rollbacks: nullRb.length, rate: e1rate, cp_upper95: cpUpper95(nullRb.length, nul.length), per_1000_ticks: nullTicks ? nullRb.length / nullTicks * 1000 : null, null_ticks: nullTicks, pass: e1rate === null ? null : e1rate <= 0.05,
      first_signals: Object.fromEntries([...new Set(nullRb.map((w) => w.first_signal))].map((s) => [s, nullRb.filter((w) => w.first_signal === s).length])),
      families: Object.fromEntries([...new Set(nullRb.flatMap((w) => w.firing_families))].map((f) => [f, nullRb.filter((w) => w.firing_families.includes(f)).length])),
      median_fire_tick: median(nullRb.map((w) => w.fire_tick)) },
    E2: { detection_units: det.length, rollbacks: detRb.length, rate: e2rate, pass: e2rate === null ? null : e2rate >= 0.5,
      first_signals: Object.fromEntries([...new Set(detRb.map((w) => w.first_signal))].map((s) => [s, detRb.filter((w) => w.first_signal === s).length])),
      families: Object.fromEntries([...new Set(detRb.flatMap((w) => w.firing_families))].map((f) => [f, detRb.filter((w) => w.firing_families.includes(f)).length])) },
    E3: { detected: detRb.length, median_lead_hours_vs_I: median(leads), early_fraction: detRb.length ? leads.filter((h) => h < 0).length / detRb.length : null,
      early: leads.filter((h) => h < 0).length, in_day: leads.filter((h) => h >= 0).length,
      with_xid: vsXid.length, median_fire_minus_xid_ticks: median(vsXid), before_xid: vsXid.filter((d) => d < 0).length,
      units_with_xid_in_window: det.filter((w) => w.xid_first_tick !== null).length,
      units_with_missing_in_window: det.filter((w) => w.missing_ticks > 0).length },
  };
}
const detA = new Set(scored('A', 'detection').filter((w) => w.outcome === 'rollback').map((w) => w.unit));
const detAC = new Set(scored('AC', 'detection').filter((w) => w.outcome === 'rollback').map((w) => w.unit));
const nulA = new Set(scored('A', 'null').filter((w) => w.outcome === 'rollback').map((w) => w.unit));
const nulAC = new Set(scored('AC', 'null').filter((w) => w.outcome === 'rollback').map((w) => w.unit));
endpoints.E4 = { detections_AC_not_A: [...detAC].filter((u) => !detA.has(u)), detections_A_not_AC: [...detA].filter((u) => !detAC.has(u)),
  false_rollbacks_AC_not_A: [...nulAC].filter((u) => !nulA.has(u)), false_rollbacks_A_not_AC: [...nulA].filter((u) => !nulAC.has(u)) };
const candidates = units.filter((u) => u.eligible).length;
const voided = units.filter((u) => u.voided).length;
endpoints.E5 = { exceptions: counters.exceptions, compile_failures: counters.compile_failures, candidate_units: candidates, compile_failure_share: candidates ? counters.compile_failures / (2 * candidates) : null, voided_units: voided,
  pass: counters.exceptions === 0 && (candidates ? counters.compile_failures / (2 * candidates) <= 0.10 : false) };
const nullUnits = new Set(scored('A', 'null').map((w) => w.unit)).size, detUnits = new Set(scored('A', 'detection').map((w) => w.unit)).size;
if (counters.hash_mismatches > 0) endpoints.not_executable.push(`hash_mismatch:${counters.hash_mismatches}`);
if (nullUnits < 20) endpoints.not_executable.push(`null_units_${nullUnits}_below_20`);
if (detUnits < 20) endpoints.not_executable.push(`detection_units_${detUnits}_below_20`);
if (candidates && counters.compile_failures / (2 * candidates) > 0.10) endpoints.not_executable.push('compile_failures_above_10pct');
if (candidates && voided / candidates > 0.05) endpoints.not_executable.push('voided_units_above_5pct');
if (mode !== 'full') endpoints.not_executable.push(`mode_${mode}`);
endpoints.executable = endpoints.not_executable.length === 0;
endpoints.unit_counts = { files: fileTable.length, units_total: units.filter((u) => u.gpu !== null).length, candidates, null_units: nullUnits, detection_units: detUnits,
  excluded: units.filter((u) => u.gpu !== null && !u.eligible).length };

// ── artifacts ────────────────────────────────────────────────────────────────────────────────
const enginePkg = JSON.parse(readFileSync(join(REPO, 'node_modules/@johnpatrickwarren-oss/deploysignal-engine/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const manifest = {
  study: STUDY_ID, mode, run_id: basename(OUT),
  repo_head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  tracked_changes: git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('??')),
  engine_installed: enginePkg.version, engine_resolved: lock.packages['node_modules/@johnpatrickwarren-oss/deploysignal-engine']?.resolved ?? null,
  node: process.version, platform: `${platform()} ${release()}`, cpus: cpus().length,
  dataset: { doi: '10.5281/zenodo.19052367', version: 'v1.0.0', dir: DATA, hash_checks: hashChecks },
  rules: { calibration_ticks: CALIBRATION_TICKS, presence_floor: CALIBRATION_PRESENCE_FLOOR, null_min_ticks: NULL_MIN_TICKS, detection_half_ticks: DETECTION_HALF_TICKS, tick_minutes: tickMs / 60000, signals: [...SIGNALS], xid: XID, amendment: 1 },
  arms: ARMS, command: `node studies/gwdg-gate/harness/run.mjs --mode ${mode}`,
  counters, exceptions: exceptionLog, wall_seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(OUT, 'units.json'), JSON.stringify(units, null, 1) + '\n');
writeFileSync(join(OUT, 'windows.json'), JSON.stringify(windows, null, 1) + '\n');
writeFileSync(join(OUT, 'endpoints.json'), JSON.stringify(endpoints, null, 2) + '\n');
console.log(JSON.stringify({ run: basename(OUT), executable: endpoints.executable, not_executable: endpoints.not_executable, unit_counts: endpoints.unit_counts,
  E1: Object.fromEntries(Object.entries(endpoints.arms).map(([a, e]) => [a, { rate: e.E1.rate, pass: e.E1.pass }])),
  E2: Object.fromEntries(Object.entries(endpoints.arms).map(([a, e]) => [a, { rate: e.E2.rate, pass: e.E2.pass }])),
  E5: endpoints.E5, wall_seconds: manifest.wall_seconds }, null, 1));

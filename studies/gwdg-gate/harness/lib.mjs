// studies/gwdg-gate/harness/lib.mjs — study 2026-09-gwdg-gate: dataset parsing, the §2 window
// rules, per-unit BaselineBundle writing, the shipped compiler, and the per-tick gate runner.
//
// Harness discipline: no RNG, no wall clock in tracked artifacts, no bare catch (every catch
// counts into a visible counter the caller prints), every external interface smoke-checked
// before the sweep (harness/smoke.mjs).

import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const STUDY_ID = '2026-09-gwdg-gate';
export const TICK_MINUTES = 10;
export const CALIBRATION_TICKS = 576;   // 96 h (Amendment 1)
export const CALIBRATION_PRESENCE_FLOOR = 530;   // Amendment 1
export const NULL_MIN_TICKS = 144;      // 24 h
export const DETECTION_HALF_TICKS = 144; // ±24 h around I
export const PRE_EVENT_TICKS = 144;     // E_first − 24 h

export const SIGNALS = Object.freeze([
  'DCGM_FI_DEV_GPU_TEMP', 'DCGM_FI_DEV_MEMORY_TEMP', 'DCGM_FI_DEV_POWER_USAGE', 'DCGM_FI_DEV_GPU_UTIL',
  'DCGM_FI_DEV_MEM_COPY_UTIL', 'DCGM_FI_DEV_SM_CLOCK', 'DCGM_FI_DEV_MEM_CLOCK',   // NVLINK removed, Amendment 1
]);
export const XID = 'DCGM_FI_DEV_XID_ERRORS';

export const ARMS = Object.freeze({
  A: { profile: 'gwdg-gpu-node-a@1.0.0', families: 'A' },
  AC: { profile: 'gwdg-gpu-node-ac@1.0.0', families: 'A,C' },
});

// ── time ─────────────────────────────────────────────────────────────────────────────────────

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms. */
export function parseTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`gwdg: unparseable timestamp '${s}'`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
/** "17 Feb 2025" → epoch ms at 00:00 UTC. */
export function parseIncidentDate(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(s.trim());
  if (!m || MONTHS[m[2]] === undefined) throw new Error(`gwdg: unparseable incidentDate '${s}'`);
  return Date.UTC(+m[3], MONTHS[m[2]], +m[1]);
}
/** "ggpu142_2025-02-17_..." → epoch ms at 00:00 UTC. */
export function parseFileDate(name) {
  const m = /_(\d{4})-(\d{2})-(\d{2})_/.exec(name);
  if (!m) throw new Error(`gwdg: no date in file name '${name}'`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
export const tickMs = TICK_MINUTES * 60 * 1000;
export function isoUtc(ms) { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); }

// ── labels ───────────────────────────────────────────────────────────────────────────────────

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** SHA256SUMS lines "<hex>  <name>" → Map(name → hex). */
export function loadSums(path) {
  const out = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(basename(m[2]), m[1]);
  }
  return out;
}

/** manifest.csv → Map(tidy file name (decompressed) → { node, minMs, maxMs, inputType }). */
export function parseManifest(text) {
  const out = new Map();
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 6) continue;
    const tidy = c[1].replace(/\.bz2$/, '');
    out.set(tidy, { node: c[3], minMs: c[4] ? parseTs(c[4]) : null, maxMs: c[5] ? parseTs(c[5]) : null, inputType: c[2] });
  }
  return out;
}

/** incident_events.csv → Map(node → [{ dayMs, category, description }]). */
export function parseIncidents(text) {
  const out = new Map();
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 9) continue;
    const node = c[0];
    const entry = { dayMs: parseIncidentDate(c[1]), category: c[4], description: c[3] };
    if (!out.has(node)) out.set(node, []);
    out.get(node).push(entry);
  }
  return out;
}

// ── telemetry ────────────────────────────────────────────────────────────────────────────────

/** Stream one decompressed tidy CSV; keep the study signals and XID per GPU.
 *  Returns { gpus: string[], uuid: {gpu→uuid}, series: {gpu: {metric: Map(ms → value)}}, rows, kept }. */
export async function loadTidy(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null, ci = null;
  const want = new Set([...SIGNALS, XID]);
  const series = {}; const uuid = {};
  let rows = 0, kept = 0;
  for await (const line of rl) {
    if (header === null) {
      header = line.split(','); ci = Object.fromEntries(header.map((h, i) => [h, i]));
      for (const col of ['timeUtc', 'metric', 'value', 'gpu', 'uuid']) {
        if (ci[col] === undefined) throw new Error(`gwdg: ${basename(path)} lacks column ${col}`);
      }
      continue;
    }
    rows++;
    const c = line.split(',');
    const metric = c[ci.metric];
    if (!want.has(metric)) continue;
    const gpu = c[ci.gpu];
    if (gpu === '') continue;
    const v = Number(c[ci.value]);
    if (!Number.isFinite(v)) continue;
    kept++;
    const ms = parseTs(c[ci.timeUtc]);
    (series[gpu] ??= {});
    (series[gpu][metric] ??= new Map()).set(ms, v);
    if (!uuid[gpu] && c[ci.uuid]) uuid[gpu] = c[ci.uuid];
  }
  return { gpus: Object.keys(series).sort(), uuid, series, rows, kept };
}

// ── §2 units and windows ─────────────────────────────────────────────────────────────────────

/** Events per node: incident rows plus every telemetry file date (§1 "Events"). */
export function eventsByNode(manifest, incidents) {
  const ev = new Map();
  for (const [node, list] of incidents) for (const e of list) (ev.get(node) ?? ev.set(node, []).get(node)).push({ dayMs: e.dayMs, source: 'incident_events', label: e.category });
  for (const [file, m] of manifest) {
    if (m.inputType !== 'label-heavy-prometheus') continue;
    const dayMs = parseFileDate(file);
    const list = ev.get(m.node) ?? ev.set(m.node, []).get(m.node);
    if (!list.some((e) => e.dayMs === dayMs)) list.push({ dayMs, source: 'telemetry_file', label: file });
  }
  for (const list of ev.values()) list.sort((a, b) => a.dayMs - b.dayMs);
  return ev;
}

/** Derive a file's windows on the grid of its own incident date. Returns the file-level
 *  decision (before per-GPU presence checks). */
export function fileWindows(file, manifest, events) {
  const m = manifest.get(file);
  if (!m) throw new Error(`gwdg: ${file} not in manifest.csv`);
  const I = parseFileDate(file);
  const nodeEvents = events.get(m.node) ?? [];
  const labelled = nodeEvents.some((e) => e.dayMs === I && e.source === 'incident_events');
  const inSpan = nodeEvents.filter((e) => e.dayMs >= m.minMs && e.dayMs <= m.maxMs);
  const eFirst = inSpan.length > 0 ? inSpan[0].dayMs : null;
  const others = inSpan.filter((e) => e.dayMs !== I);
  const detStart = I - DETECTION_HALF_TICKS * tickMs, detEnd = I + DETECTION_HALF_TICKS * tickMs;
  const confounded = others.some((e) => (e.dayMs >= m.minMs && e.dayMs < detStart) || (e.dayMs >= detStart && e.dayMs < detEnd));
  return { file, node: m.node, spanStart: m.minMs, spanEnd: m.maxMs, I, labelled, eFirst, others, detStart, detEnd, confounded };
}

/** Per-GPU windows on that GPU's own DCGM timestamp grid (§2). */
export function unitWindows(fw, gpuSeries) {
  const present = (ms) => SIGNALS.every((s) => gpuSeries[s]?.has(ms));
  const allMs = new Set();
  for (const s of SIGNALS) for (const ms of (gpuSeries[s]?.keys() ?? [])) allMs.add(ms);
  const grid = [...allMs].sort((a, b) => a - b);
  if (grid.length === 0) return { eligible: false, reason: 'no_dcgm_rows', calibration: null, nullWin: null, detection: null };
  const first = grid[0];
  // the tick grid is the file's 10-minute lattice from the GPU's first sample
  const calStart = first, calEnd = calStart + CALIBRATION_TICKS * tickMs;   // [calStart, calEnd)
  const preEvent = fw.eFirst === null ? null : fw.eFirst - PRE_EVENT_TICKS * tickMs;
  const out = { eligible: true, reason: null, calibration: { start: calStart, end: calEnd, present: 0, ticks: CALIBRATION_TICKS, perSignal: {} }, nullWin: null, detection: null };
  for (const s of SIGNALS) {
    let n = 0; for (let ms = calStart; ms < calEnd; ms += tickMs) if (gpuSeries[s]?.has(ms)) n++;
    out.calibration.perSignal[s] = n;
  }
  let allPresent = 0; for (let ms = calStart; ms < calEnd; ms += tickMs) if (present(ms)) allPresent++;
  out.calibration.present = allPresent;
  const low = SIGNALS.filter((s) => out.calibration.perSignal[s] < CALIBRATION_PRESENCE_FLOOR);
  if (preEvent !== null && calEnd > preEvent) { out.eligible = false; out.reason = `calibration_ends_after_E_first_minus_24h (${isoUtc(calEnd)} > ${isoUtc(preEvent)})`; return out; }
  if (low.length > 0) { out.eligible = false; out.reason = `calibration_presence_below_${CALIBRATION_PRESENCE_FLOOR}: ${low.map((s) => `${s}=${out.calibration.perSignal[s]}`).join(',')}`; return out; }
  if (preEvent !== null) {
    const ticks = Math.floor((preEvent - calEnd) / tickMs);
    out.nullWin = ticks >= NULL_MIN_TICKS ? { start: calEnd, end: preEvent, ticks } : null;
    if (out.nullWin === null) out.nullReason = `null_window_${ticks}_ticks_below_${NULL_MIN_TICKS}`;
  }
  out.detection = fw.labelled && !fw.confounded ? { start: fw.detStart, end: fw.detEnd, ticks: 2 * DETECTION_HALF_TICKS } : null;
  if (out.detection === null) out.detectionReason = !fw.labelled ? 'no_label_row' : 'confounded';
  return out;
}

// ── bundle + compile ─────────────────────────────────────────────────────────────────────────

/** Write a per-unit BaselineBundle: runs are maximal contiguous stretches with all signals present. */
export function writeBundle(dir, unitId, uuid, gpuSeries, cal) {
  mkdirSync(dir, { recursive: true });
  const runs = [];
  let cur = null;
  for (let ms = cal.start; ms < cal.end; ms += tickMs) {
    const ok = SIGNALS.every((s) => gpuSeries[s]?.has(ms));
    if (!ok) { if (cur) { runs.push(cur); cur = null; } continue; }
    if (!cur) cur = { tenant_id: uuid ?? unitId, signal_series: Object.fromEntries(SIGNALS.map((s) => [s, []])), hour_of_day: [], day_of_week: [] };
    for (const s of SIGNALS) cur.signal_series[s].push(gpuSeries[s].get(ms));
    const d = new Date(ms);
    cur.hour_of_day.push(d.getUTCHours());
    cur.day_of_week.push(d.getUTCDay());
  }
  if (cur) runs.push(cur);
  const manifest = {
    version: `real_gwdg-${unitId}`,
    generated_at: 'gwdg-gpu-node-telemetry-v1.0.0',   // the input's identity, never the clock
    seed: 0,
    cell_dim: 'hour_of_day',
    n_runs: runs.length,
    ticks_per_run: Math.max(0, ...runs.map((r) => r.hour_of_day.length)),
    tenants: 1,
    signals: [...SIGNALS],
    baseline_provenance: 'real_gwdg',
    caveat_filters_applied: ['gwdg:per_gpu_calibration_window_576_ticks', 'gwdg:runs_are_contiguous_all_signals_present_stretches'],
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'bundle.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { runs: runs.length, samples: runs.reduce((a, r) => a + r.hour_of_day.length, 0) };
}

/** The shipped compiler, no override. Returns { ok, config?, stdout, stderr, error? }. */
export function compileBundle(repoRoot, bundleDir, arm, outPath) {
  const args = ['tools/calibrate.js', '--baseline', bundleDir, '--alpha', '1e-3', '--families', ARMS[arm].families,
    '--profile_ref', ARMS[arm].profile, '--out', outPath, '--disable_worker_pool', 'true'];
  try {
    const stdout = execFileSync('node', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return { ok: true, config: JSON.parse(readFileSync(outPath, 'utf8')), stdout, args };
  } catch (e) {
    // counted by the caller (E5 / NOT-EXECUTABLE); never silent
    return { ok: false, error: String(e.message ?? e).slice(0, 4000), stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '').slice(0, 4000), args };
  }
}

// ── gate ─────────────────────────────────────────────────────────────────────────────────────

export function loadEngine(repoRoot) {
  const shared = require(join(repoRoot, 'shared.js'));
  const gate = require(join(repoRoot, 'tools/_build-report-card-gate.js'));
  return { orchestrate: shared.orchestrate, TrendBuffer: shared.TrendBuffer, buildScenario: gate._buildScenarioForTest ?? null };
}

/** The scenario of tools/_build-report-card-gate.js buildScenario, restated (that module does not
 *  export it). Risk medium, change type config (no warm-up), every flag false. */
export function buildScenario(cellMean) {
  return {
    id: 'gwdg-gate', name: 'GWDG gate', riskLevel: 'medium', bakeHours: 0, author: 'human', changeType: 'config',
    timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: { ...cellMean },
  };
}

/** Aggregate-fallback per-signal means from a compiled config (raw space). */
export function aggregateMeans(cfg) {
  const per = cfg?.baseline_cells?.aggregate_fallback?.family_A?.per_signal ?? {};
  const out = {};
  for (const s of SIGNALS) { const p = per[s]; if (p) out[s] = p.baseline_mean_raw ?? p.baseline_mean; }
  return out;
}

/** Run the gate over one window. Returns the window record (§3 "Recorded per window"). */
export function runWindow(engine, cfg, gpuSeries, win, opts = {}) {
  const { orchestrate, TrendBuffer } = engine;
  const tb = new TrendBuffer(10);
  const scenario = buildScenario(aggregateMeans(cfg));
  const totalTicks = win.ticks;
  const rec = { outcome: 'proceed', fireTick: null, fireMs: null, firingFamilies: [], rollbackIds: [], firstSignal: null,
    missingTicks: 0, xidFirstTick: null, evaluated: 0, outlookEmpty: 0 };
  const inject = opts.inject ?? null;   // { signal, fromTick, sigma } — smoke only
  let t = 0;
  for (let ms = win.start; ms < win.end && t < totalTicks; ms += tickMs, t++) {
    const live = {};
    let anyMissing = false;
    for (const s of SIGNALS) {
      const v = gpuSeries[s]?.get(ms);
      if (v === undefined) { anyMissing = true; continue; }
      live[s] = v;
      if (inject && inject.signal === s && t >= inject.fromTick) live[s] = v + inject.delta;
      tb.push(s, live[s]);
    }
    if (anyMissing) rec.missingTicks++;
    const xid = gpuSeries[XID]?.get(ms);
    if (rec.xidFirstTick === null && xid !== undefined && xid !== 0) rec.xidFirstTick = t;
    const result = orchestrate({
      liveMetrics: live, scenario, hoursElapsed: t / 6, trendBuffer: tb, tick: t, totalTicks,
      compiledConfig: cfg, currentHourOfDay: new Date(ms).getUTCHours(), fusionTopology: 'portfolio',
    });
    rec.evaluated++;
    const fusion = result.gateResults?.fusion;
    if (!fusion || !Array.isArray(fusion.evidence_outlook) || fusion.evidence_outlook.length === 0) rec.outlookEmpty++;
    if (result.verdict === 'rollback') {
      rec.outcome = 'rollback'; rec.fireTick = t; rec.fireMs = ms;
      rec.firingFamilies = fusion ? fusion.firing_families.slice() : [];
      rec.rollbackIds = (result.healthResult?.rollback ?? []).map((r) => r.id);
      const first = (result.healthResult?.family_A_shadow ?? []).find((v) => v.verdict === 'fire');
      rec.firstSignal = first?.signal ?? (rec.rollbackIds[0] ?? null);
      break;   // a session stops at its first rollback
    }
  }
  return rec;
}

export function ensureFreshDir(dir) {
  if (existsSync(dir)) throw new Error(`refusing to overwrite existing run dir ${dir}`);
  mkdirSync(dir, { recursive: true });
}

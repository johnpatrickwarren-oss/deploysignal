// tools/self-calibrate.ts — ADR 0002: measure the temporal path's own false-alarm rate on a service's undeployed
// history and store it for the gate to serve beside every advisory fire. The procedure is
// studies/temporal-null-real/harness/run.mjs made a product step: take the raw per-tick history, remove the windows
// that contain a change (the lifecycle store's sessions plus declared exclusions), calibrate from the first part as
// production would (tools/calibrate), replay the shipped `orchestrate` over non-overlapping sessions of the rest,
// count. Nothing here estimates anything the bound depends on; it measures how far this service's history is from
// the detectors' null.
//
//   node tools/self-calibrate.js --service-id <id> --store <baselineHistoryDir> --raw <ticks.json> [--raw <more.json>]
//        [--signals p99_latency,downstream_err] [--tick-seconds 120] [--session-ticks 32] [--calibration-end <ISO>]
//        [--exclude <exclusions.json>] [--profile-ref <id@ver>] [--alpha 1e-3] [--families A,B,C,D,E] [--out <dir>]
//        [--cell-dim hour_of_day_x_day_of_week|hour_of_day] [--risk-level high|medium|...]  (the gate's own calibration and scenario settings)
//
// Raw tick file: `{ ticks: [{ t: ISO, metrics: { <signal>: number, ... }, traffic_pct?: number, healthy?: boolean }] }`,
// one file per series (a lane, a unit); several files are replayed as separate series and pooled into one record.
// A tick with a missing metric is unusable and voids the session that contains it.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { selfCalibrationDir, upper95, type SelfCalibrationRecord } from '../service/session/self-calibration';

const TOOL_VERSION = '1.0.0';

interface RawTick { t: string; metrics: Record<string, number>; traffic_pct?: number; healthy?: boolean }
interface Args { service_id: string; store: string; raw: string[]; signals: string[]; tick_seconds: number; session_ticks: number; calibration_end: string | null; exclude: string | null; profile_ref: string | null; alpha: number; families: string; out: string | null; now: string | null; cell_dim: 'hour_of_day' | 'hour_of_day_x_day_of_week'; risk_level: string }

const ARG_DEFAULTS: Record<string, string> = { signals: 'p99_latency,downstream_err', 'tick-seconds': '120', 'session-ticks': '32', alpha: '0.001', families: 'A,B,C,D,E', 'cell-dim': 'hour_of_day_x_day_of_week', 'risk-level': 'high' };

function collectArgs(argv: string[]): { a: Record<string, string>; raws: string[] } {
  const a: Record<string, string> = { ...ARG_DEFAULTS }; const raws: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const v = argv[i + 1]; i++;
    if (k === 'raw') raws.push(v); else a[k] = v;
  }
  for (const k of ['service-id', 'store']) if (typeof a[k] !== 'string') throw new Error(`--${k} required`);
  return { a, raws };
}

export function parseArgs(argv: string[]): Args {
  const { a, raws } = collectArgs(argv);
  const opt = (k: string): string | null => a[k] ?? null;
  return {
    service_id: a['service-id'], store: a['store'], raw: raws,
    signals: a['signals'].split(',').map((s) => s.trim()).filter(Boolean),
    tick_seconds: Number(a['tick-seconds']), session_ticks: Number(a['session-ticks']),
    calibration_end: opt('calibration-end'), exclude: opt('exclude'), profile_ref: opt('profile-ref'),
    alpha: Number(a['alpha']), families: a['families'], out: opt('out'), now: opt('now'),
    cell_dim: a['cell-dim'] as Args['cell_dim'], risk_level: a['risk-level'],
  };
}

/** Change windows from the lifecycle store: every session's [begun_at, ended_at ?? last_tick_at ?? begun_at + 1 h]. */
export function storeExclusions(store: string, serviceId: string): Array<{ start: string; end: string; source: string }> {
  const dir = path.join(store, serviceId, 'sessions'); if (!fs.existsSync(dir)) return [];
  const out: Array<{ start: string; end: string; source: string }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.verdicts.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const start = s.begun_at ?? s.created_at; if (!start) continue;
      const end = s.ended_at ?? s.last_tick_at ?? new Date(Date.parse(start) + 3600000).toISOString();
      out.push({ start, end, source: `lifecycle-store session ${s.session_id ?? f}` });
    } catch (e) { out.push({ start: '1970-01-01T00:00:00Z', end: '1970-01-01T00:00:00Z', source: `unreadable session file ${f}: ${(e as Error).message}` }); }
  }
  return out;
}

function inExclusion(ms: number, ex: Array<{ start: string; end: string }>): boolean { return ex.some((e) => ms >= Date.parse(e.start) && ms < Date.parse(e.end)); }

export interface SeriesResult { series: string; sessions: Array<{ start: string; end: string; executable: boolean; void_reason: string | null; verdict: string | null; rollback_ids: Record<string, number>; extend_ids: Record<string, number> }> }

export interface SeriesInput { name: string; ticks: RawTick[] }
interface Context { args: Args; repoRoot: string; exclusions: Array<{ start: string; end: string; source: string }>; calEnd: number; allStart: number; allEnd: number }

const toMs = (s: string): number => Date.parse(s);

function loadSeries(args: Args): SeriesInput[] {
  if (args.raw.length === 0) throw new Error('at least one --raw series');
  return args.raw.map((p) => ({ name: path.basename(p).replace(/\.json$/, ''), ticks: (JSON.parse(fs.readFileSync(p, 'utf8')).ticks as RawTick[]).slice().sort((x, y) => toMs(x.t) - toMs(y.t)) }));
}

function buildContext(args: Args, repoRoot: string, series: SeriesInput[]): Context {
  const allStart = Math.min(...series.map((s) => toMs(s.ticks[0].t)));
  const allEnd = Math.max(...series.map((s) => toMs(s.ticks[s.ticks.length - 1].t))) + args.tick_seconds * 1000;
  const declared = args.exclude ? (JSON.parse(fs.readFileSync(args.exclude, 'utf8')) as Array<{ start: string; end: string; source?: string }>).map((e) => ({ ...e, source: e.source ?? 'declared' })) : [];
  const exclusions = [...storeExclusions(args.store, args.service_id), ...declared];
  const calEnd = args.calibration_end ? toMs(args.calibration_end) : allStart + Math.floor((allEnd - allStart) / 2);
  if (calEnd - allStart < 24 * 3600000) throw new Error(`calibration window shorter than 24 h (${((calEnd - allStart) / 3600000).toFixed(1)} h)`);
  return { args, repoRoot, exclusions, calEnd, allStart, allEnd };
}

function usableTick(ctx: Context, x: RawTick): boolean {
  return ctx.args.signals.every((s) => Number.isFinite(x.metrics?.[s])) && !inExclusion(toMs(x.t), ctx.exclusions) && x.healthy !== false;
}

function voidReason(ctx: Context, x: RawTick): string {
  if (inExclusion(toMs(x.t), ctx.exclusions)) return 'change window';
  return x.healthy === false ? 'unhealthy' : 'missing metric';
}

/** 1. The calibration bundle from the usable calibration ticks of every series; returns the work dir and per-series means. */
function buildBundle(ctx: Context, series: SeriesInput[]): { work: string; bundleDir: string; means: Record<string, Record<string, number>> } {
  const { args } = ctx;
  const work = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'self-calibrate-'));
  const bundleDir = path.join(work, 'bundle'); fs.mkdirSync(bundleDir, { recursive: true });
  const lines: string[] = []; const means: Record<string, Record<string, number>> = {};
  for (const s of series) {
    const cal = s.ticks.filter((x) => toMs(x.t) < ctx.calEnd && usableTick(ctx, x));
    const m: Record<string, number> = {}; for (const sig of args.signals) m[sig] = cal.reduce((a, x) => a + x.metrics[sig], 0) / Math.max(1, cal.length); means[s.name] = m;
    for (let i = 0; i + args.session_ticks <= cal.length; i += args.session_ticks) {
      const run = cal.slice(i, i + args.session_ticks);
      const sigs: Record<string, number[]> = {}; for (const sig of args.signals) sigs[sig] = run.map((x) => x.metrics[sig]);
      sigs['traffic_pct'] = run.map((x) => x.traffic_pct ?? 1);
      lines.push(JSON.stringify({ tenant_id: args.service_id, signal_series: sigs, hour_of_day: run.map((x) => new Date(x.t).getUTCHours()), day_of_week: run.map((x) => new Date(x.t).getUTCDay()) }));
    }
  }
  if (lines.length < 2) throw new Error(`calibration window yields ${lines.length} runs of ${args.session_ticks} ticks; need at least 2`);
  fs.writeFileSync(path.join(bundleDir, 'bundle.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify({ version: `self-calibrate-${args.service_id}`, generated_at: new Date(0).toISOString(), seed: 0, cell_dim: args.cell_dim, n_runs: lines.length, ticks_per_run: args.session_ticks, tenants: 1, signals: [...args.signals, 'traffic_pct'] }, null, 2));
  return { work, bundleDir, means };
}

/** 2. Calibrate as production would (tools/calibrate). */
function compileConfig(ctx: Context, work: string, bundleDir: string): { compiledPath: string; cfg: any } {
  const { args, repoRoot } = ctx;
  const compiledPath = path.join(work, 'compiled.json');
  const calArgs = [path.join(repoRoot, 'tools', 'calibrate.js'), '--baseline', bundleDir, '--alpha', String(args.alpha), '--families', args.families, '--out', compiledPath];
  if (args.profile_ref) calArgs.push('--profile_ref', args.profile_ref);
  execFileSync(process.execPath, calArgs, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  return { compiledPath, cfg: JSON.parse(fs.readFileSync(compiledPath, 'utf8')) };
}

type SessionRec = SeriesResult['sessions'][number];

function recordTick(rec: SessionRec, r: any, k: number, last: boolean): void {
  for (const f of r.healthResult?.rollback ?? []) if (!(f.id in rec.rollback_ids)) rec.rollback_ids[f.id] = k;
  for (const f of r.healthResult?.extend ?? []) if (!(f.id in rec.extend_ids)) rec.extend_ids[f.id] = k;
  if (rec.verdict === null && r.verdict !== 'extend') rec.verdict = r.verdict;
  if (last && rec.verdict === null) rec.verdict = (r.healthResult && r.healthResult.extend.length > 0) ? 'extend' : 'proceed';
}

/** One session through the shipped orchestrate; fills verdict and the first-tick ids. */
function replaySession(ctx: Context, engine: any, cfg: any, run: RawTick[], baseline: Record<string, number>, name: string, rec: SessionRec): void {
  const { args } = ctx; const { orchestrate, TrendBuffer } = engine;
  const tb = new TrendBuffer(10);
  const scenario = { id: `self-cal-${name}`, riskLevel: args.risk_level, bakeHours: (args.session_ticks * args.tick_seconds) / 3600, author: 'human', changeType: 'config', timeWindow: 'ok', flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true }, baseline };
  for (let k = 0; k < run.length; k++) {
    const live: Record<string, number> = { ...run[k].metrics, traffic_pct: run[k].traffic_pct ?? 1 };
    for (const key of Object.keys(live)) tb.push(key, live[key]);
    const d = new Date(run[k].t);
    const r = orchestrate({ liveMetrics: live, scenario, hoursElapsed: k * (scenario.bakeHours / run.length), trendBuffer: tb, tick: k, totalTicks: run.length, compiledConfig: cfg, currentHourOfDay: d.getUTCHours(), currentDayOfWeek: d.getUTCDay(), fusionTopology: 'portfolio' });
    recordTick(rec, r, k, k === run.length - 1);
  }
}

const familyOf = (id: string): string => { const m = /^family_([A-E])_/.exec(id); return m ? m[1] : 'B'; };

interface Tally { sessions: number; fires: number; fam: Record<string, { sessions: number; fires: number; holds: number }>; holdIds: Record<string, number>; fireIds: Record<string, number> }

function tallySession(t: Tally, rec: SessionRec): void {
  t.sessions++; if (rec.verdict === 'rollback') t.fires++;
  const famsR = new Set(Object.keys(rec.rollback_ids).map(familyOf)), famsE = new Set(Object.keys(rec.extend_ids).map(familyOf));
  for (const f of ['A', 'B', 'C', 'D', 'E']) { t.fam[f] ??= { sessions: 0, fires: 0, holds: 0 }; t.fam[f].sessions++; if (famsR.has(f)) t.fam[f].fires++; if (famsE.has(f)) t.fam[f].holds++; }
  for (const id of Object.keys(rec.rollback_ids)) t.fireIds[id] = (t.fireIds[id] ?? 0) + 1;
  for (const id of Object.keys(rec.extend_ids)) t.holdIds[id] = (t.holdIds[id] ?? 0) + 1;
}

/** 3. Non-overlapping sessions after the calibration end, per series. */
function replayAll(ctx: Context, cfg: any, series: SeriesInput[], means: Record<string, Record<string, number>>): { results: SeriesResult[]; tally: Tally } {
  const engine = require(path.join(ctx.repoRoot, 'shared.js'));
  const tally: Tally = { sessions: 0, fires: 0, fam: {}, holdIds: {}, fireIds: {} }; const results: SeriesResult[] = [];
  for (const s of series) {
    const ev = s.ticks.filter((x) => toMs(x.t) >= ctx.calEnd); const out: SessionRec[] = [];
    const baseline: Record<string, number> = { ...means[s.name], traffic_pct: 1 };
    for (let i = 0; i + ctx.args.session_ticks <= ev.length; i += ctx.args.session_ticks) {
      const run = ev.slice(i, i + ctx.args.session_ticks);
      const bad = run.find((x) => !usableTick(ctx, x));
      const rec: SessionRec = { start: run[0].t, end: run[run.length - 1].t, executable: !bad, void_reason: bad ? voidReason(ctx, bad) : null, verdict: null, rollback_ids: {}, extend_ids: {} };
      if (rec.executable) { replaySession(ctx, engine, cfg, run, baseline, s.name, rec); tallySession(tally, rec); }
      out.push(rec);
    }
    results.push({ series: s.name, sessions: out });
  }
  return { results, tally };
}

/** Effective Family A betting thresholds per signal: the compiler stamps a bootstrap threshold when Family D compiles
 *  (knowledge stats/gwdg-gate-2026-09-29, finding 2); on some series it is astronomically high and the detector cannot
 *  fire. The record says so, because a 0-fire rate from a detector that cannot fire is not a measurement. */
function effectiveThresholds(cfg: any): SelfCalibrationRecord['thresholds'] {
  const out: SelfCalibrationRecord['thresholds'] = {};
  const alphaA = cfg.alpha_budget?.per_family?.A ?? 0; const perSignal = cfg.baseline_cells?.aggregate_fallback?.family_A?.per_signal ?? {};
  const sigs = Object.keys(perSignal); const ville = alphaA > 0 && sigs.length > 0 ? sigs.length / alphaA : Infinity;
  for (const sig of sigs) { const b = perSignal[sig].betting_sliding_buffer_threshold ?? null; out[sig] = { bootstrap: b, ville, unreachable: b !== null && Number.isFinite(ville) && b > 1000 * ville }; }
  return out;
}

function writeRecord(ctx: Context, record: SelfCalibrationRecord, results: SeriesResult[], compiledPath: string): string {
  const dir = selfCalibrationDir(ctx.args.store, ctx.args.service_id); fs.mkdirSync(dir, { recursive: true });
  const stamp = record.measured_at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(dir, `${stamp}.sessions.json`), JSON.stringify(results, null, 1));
  const tmp = path.join(dir, 'latest.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(record, null, 2)); fs.renameSync(tmp, path.join(dir, 'latest.json'));
  fs.copyFileSync(compiledPath, path.join(dir, `${stamp}.compiled.json`));
  return path.join(dir, 'latest.json');
}

export function runSelfCalibration(args: Args, repoRoot: string): { record: SelfCalibrationRecord; series: SeriesResult[]; outPath: string } {
  const series = loadSeries(args);
  const ctx = buildContext(args, repoRoot, series);
  const { work, bundleDir, means } = buildBundle(ctx, series);
  const { compiledPath, cfg } = compileConfig(ctx, work, bundleDir);
  const { results, tally } = replayAll(ctx, cfg, series, means);
  const perFamily: SelfCalibrationRecord['per_family'] = {};
  for (const [f, v] of Object.entries(tally.fam)) perFamily[f] = { sessions: v.sessions, fires: v.fires, upper95: upper95(v.fires, v.sessions), holds: v.holds };
  const enginePkg = require(path.join(repoRoot, 'node_modules', '@johnpatrickwarren-oss', 'deploysignal-engine', 'package.json'));
  const record: SelfCalibrationRecord = {
    schema_version: '1', service_id: args.service_id, measured_at: args.now ?? new Date().toISOString(),
    span: { start: new Date(ctx.allStart).toISOString(), end: new Date(ctx.allEnd).toISOString(), calibration_end: new Date(ctx.calEnd).toISOString(), tick_seconds: args.tick_seconds, session_ticks: args.session_ticks },
    exclusions: ctx.exclusions, sessions: tally.sessions, fires: tally.fires, upper95: upper95(tally.fires, tally.sessions), per_family: perFamily, hold_ids: tally.holdIds, fire_ids: tally.fireIds,
    engine_version: enginePkg.version, compiled_config_sha256: createHash('sha256').update(fs.readFileSync(compiledPath)).digest('hex'), signals: args.signals, thresholds: effectiveThresholds(cfg), tool_version: TOOL_VERSION,
    settings: { cell_dim: args.cell_dim, risk_level: args.risk_level, profile_ref: args.profile_ref, alpha: args.alpha, families: args.families },
  };
  const outPath = writeRecord(ctx, record, results, compiledPath);
  return { record, series: results, outPath };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const { record, outPath } = runSelfCalibration(args, path.resolve(__dirname, '..'));
  const fams = Object.entries(record.per_family).map(([f, v]) => `${f}:${v.fires}/${v.sessions} (holds ${v.holds})`).join(' ');
  const unreachable = Object.entries(record.thresholds).filter(([, t]) => t.unreachable).map(([s]) => s);
  if (unreachable.length) console.log(`WARNING: Family A's betting threshold is unreachable on ${unreachable.join(', ')} (bootstrap threshold > 1000 × the Ville threshold): a 0-fire rate there is not a measurement`);
  console.log(`self-calibrate ${record.service_id}: ${record.fires}/${record.sessions} sessions rolled back (upper95 ${record.upper95.toFixed(3)}); families ${fams}; exclusions ${record.exclusions.length}; → ${outPath}`);
}

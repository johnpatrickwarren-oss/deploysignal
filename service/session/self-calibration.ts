// service/session/self-calibration.ts — ADR 0002: the stored result of `tools/self-calibrate`, read at session
// begin and served beside the gate's verdicts. The record lives at
// `<baselineHistoryDir>/<service_id>/self-calibration/latest.json` (plus one timestamped copy per run). The gate
// never computes it; it reads it, decides `stale`, and serves the summary. Absence is not an error: the
// response then carries `self_calibration: null`, which is itself the information ("nobody has measured this
// detector on this service").

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface SelfCalibrationFamily { sessions: number; fires: number; upper95: number; holds: number }

export interface SelfCalibrationRecord {
  schema_version: '1';
  service_id: string;
  measured_at: string;                 // ISO, when the replay ran
  span: { start: string; end: string; calibration_end: string; tick_seconds: number; session_ticks: number };
  exclusions: Array<{ start: string; end: string; source: string }>;
  sessions: number;                    // executable sessions replayed
  fires: number;                       // sessions ending rollback (any family)
  upper95: number;                     // exact one-sided 95% upper bound on the per-session rate
  per_family: Record<string, SelfCalibrationFamily>;
  hold_ids: Record<string, number>;
  fire_ids: Record<string, number>;
  engine_version: string;
  compiled_config_sha256: string;      // of the config the replay used (compiled from the same history)
  signals: string[];
  /** per Family A signal: the compiled betting threshold, the Ville threshold n_signals/α_A, and whether the detector cannot fire */
  thresholds: Record<string, { bootstrap: number | null; ville: number; unreachable: boolean }>;
  tool_version: string;
  settings?: { cell_dim: string; risk_level: string; profile_ref: string | null; alpha: number; families: string };
}

export interface SelfCalibrationSummary {
  sessions: number; fires: number; upper95: number; measured_at: string; stale: boolean; stale_reason: string | null;
  per_family: Record<string, SelfCalibrationFamily>; span_days: number;
  /** signals on which Family A's compiled threshold cannot be reached (its 0 fires there measure nothing) */
  unreachable_signals: string[];
}

export function selfCalibrationDir(baselineHistoryDir: string, serviceId: string): string {
  return path.join(baselineHistoryDir, serviceId, 'self-calibration');
}

export function sha256File(p: string): string { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/** Exact one-sided upper 95% bound for k of n (Clopper–Pearson), by bisection. */
export function upper95(k: number, n: number): number {
  if (n <= 0) return 1;
  const lg = (x: number): number => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); };
  const lgC = (nn: number, kk: number): number => lg(nn + 1) - lg(kk + 1) - lg(nn - kk + 1);
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const p = (lo + hi) / 2; let cdf = 0; for (let j = 0; j <= k; j++) cdf += Math.exp(lgC(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p)); if (cdf > 0.05) lo = p; else hi = p; }
  return hi;
}

/** Read the latest record and decide staleness against `now` and the compiled config the session runs on.
 *  Returns null when no record exists. Throws only on a present-but-corrupt record. */
export function readSelfCalibration(
  baselineHistoryDir: string, serviceId: string, opts: { now?: Date; compiledConfigPath?: string | null } = {},
): SelfCalibrationSummary | null {
  const p = path.join(selfCalibrationDir(baselineHistoryDir, serviceId), 'latest.json');
  if (!fs.existsSync(p)) return null;
  const rec = JSON.parse(fs.readFileSync(p, 'utf8')) as SelfCalibrationRecord;
  if (rec.schema_version !== '1' || typeof rec.sessions !== 'number' || typeof rec.fires !== 'number') throw new Error(`self-calibration: ${p} is not a schema 1 record`);
  const now = opts.now ?? new Date();
  const spanMs = Date.parse(rec.span.end) - Date.parse(rec.span.start);
  const ageMs = now.getTime() - Date.parse(rec.measured_at);
  let stale = false, reason: string | null = null;
  if (ageMs > spanMs) { stale = true; reason = `measured ${Math.round(ageMs / 3600000)} h ago, older than its ${Math.round(spanMs / 3600000)} h span`; }
  if (opts.compiledConfigPath && fs.existsSync(opts.compiledConfigPath)) {
    const h = sha256File(opts.compiledConfigPath);
    if (h !== rec.compiled_config_sha256) { stale = true; reason = (reason ? reason + '; ' : '') + 'the session runs on a different compiled config than the one measured'; }
  }
  return { sessions: rec.sessions, fires: rec.fires, upper95: rec.upper95, measured_at: rec.measured_at, stale, stale_reason: reason, per_family: rec.per_family, span_days: spanMs / 86400000, unreachable_signals: Object.entries(rec.thresholds ?? {}).filter(([, t]) => t.unreachable).map(([s]) => s) };
}

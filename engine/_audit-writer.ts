// engine/_audit-writer.ts — Audit log writer + record finalization/serialization.
// Buffered append-only JSONL with daily rotation. Hot path is allocation-only
// (lazy stat computation deferred to flush) so the decision loop stays cheap.
// Split verbatim from engine/audit.ts.

// Node built-ins via ES-compatible import form so this compiles under
// both `module: commonjs` (Node test runtime) and `module: es2020`
// (browser-bundle generator). The browser bundle shims these at the top
// of the concatenated output; createAuditWriter is the only fs/path
// consumer and demos never invoke it.
import * as fs from 'fs';
import * as path from 'path';

import type {
  AuditWriter, AuditRecord, AuditRecordV2, TrendSnapshot,
} from './types';

interface AuditWriterOpts {
  dir?: string | null;
  service?: string;
  rotateDaily?: boolean;
}

/**
 * createAuditWriter({dir, service, rotateDaily})
 *
 * Returns {write(record), close()} for appending JSONL audit records.
 * Buffered — flushes every 500ms and on close().
 * Daily rotation by UTC date.
 * No-op if dir is falsy.
 */
export function createAuditWriter(opts?: AuditWriterOpts): AuditWriter {
  if (!opts || !opts.dir) return { write: noop, close: noop };

  const dir = opts.dir;
  const service = opts.service || 'default';
  const rotate = opts.rotateDaily !== false;

  const serviceDir = path.join(dir, service);
  fs.mkdirSync(serviceDir, { recursive: true });

  // Each buffered record is stamped with the UTC date observed at write()
  // time so daily rotation attributes it to the day it was produced — a
  // flush that crosses midnight must not drag pre-midnight records into
  // the new day's file (remediation L2).
  let buffer: Array<{ rec: AuditRecord | AuditRecordV2; date: string }> = [];
  const fixedDate = utcDate();
  let flushTimer: ReturnType<typeof setInterval> | null = setInterval(flush, 500);
  // The flush timer is a convenience, not a liveness requirement: it must
  // not keep a CLI/tool process alive when close() is forgotten
  // (remediation L2). unref is absent in browser-ish runtimes, hence `?.`.
  flushTimer.unref?.();

  function utcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function filePath(date: string): string {
    return path.join(serviceDir, date + '.jsonl');
  }

  function flush(): void {
    if (buffer.length === 0) return;
    // Group serialized lines by their write-time date, preserving order
    // within each file (records only ever move forward in time, so at most
    // two groups exist per flush in practice).
    const linesByDate: { [date: string]: string } = {};
    for (let i = 0; i < buffer.length; i++) {
      const rec = _finalize(buffer[i].rec);
      const replacer = rec.schema_version === '2' ? _schemaV2Replacer : _schemaV1Replacer;
      const date = buffer[i].date;
      linesByDate[date] = (linesByDate[date] || '') + JSON.stringify(rec, replacer) + '\n';
    }
    buffer = [];
    const dates = Object.keys(linesByDate);
    for (let d = 0; d < dates.length; d++) {
      try {
        fs.appendFileSync(filePath(dates[d]), linesByDate[dates[d]], 'utf8');
      } catch (_e) {
        // Best-effort — don't crash the decision path
      }
    }
  }

  function write(record: AuditRecord | AuditRecordV2): void {
    buffer.push({ rec: record, date: rotate ? utcDate() : fixedDate });
  }

  function close(): void {
    if (flushTimer !== null) clearInterval(flushTimer);
    flushTimer = null;
    flush();
  }

  return { write, close };
}

/**
 * Finalize a record before serialization: compute trend_snapshot from
 * raw buffer data. Called during flush, not in the hot decision path.
 */
function _finalize(record: AuditRecord | AuditRecordV2): AuditRecord | AuditRecordV2 {
  if (record._rawTrend) {
    const snapshot: { [key: string]: TrendSnapshot } = {};
    const keys = Object.keys(record._rawTrend);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const hist = record._rawTrend[key];
      snapshot[key] = _computeStats(hist, record._tsFn ?? null);
    }
    record.trend_snapshot = snapshot;
  } else {
    record.trend_snapshot = {};
  }
  delete record._rawTrend;
  delete record._tsFn;
  return record;
}

function _computeStats(
  hist: number[] | null | undefined,
  tsFn: ((t: TrendSnapshot, direction: 'rise' | 'fall') => number) | null,
): TrendSnapshot {
  if (!hist || hist.length < 4) {
    const empty: TrendSnapshot = {
      slope: 0, slopeNorm: 0, cv: 1, mean: 0, min: 0, max: 0, range: 0, roc: 0,
      n: hist ? hist.length : 0, stable: false, insufficient: true, trendStrength: 0,
    };
    return empty;
  }
  const n = hist.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += hist[i]; sumXY += i * hist[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const mean = sumY / n;
  const slopeNorm = mean !== 0 ? slope / Math.abs(mean) : 0;
  let variance = 0;
  for (let j = 0; j < n; j++) variance += Math.pow(hist[j] - mean, 2);
  const stdDev = Math.sqrt(variance / n);
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : 1;
  let roc = 0;
  if (n >= 3) {
    const rc = hist.slice(-3);
    roc = (rc[rc.length - 1] - rc[0]) / (rc.length - 1);
    roc = mean !== 0 ? roc / Math.abs(mean) : 0;
  }
  const stable = cv < 0.04 && Math.abs(slopeNorm) > 0.002;
  let tmin = hist[0], tmax = hist[0];
  for (let k = 1; k < n; k++) { if (hist[k] < tmin) tmin = hist[k]; if (hist[k] > tmax) tmax = hist[k]; }
  const t: TrendSnapshot = {
    slope, slopeNorm, stable, cv, mean, roc, min: tmin, max: tmax, range: tmax - tmin, n, insufficient: false,
  };
  t.trendStrength = tsFn ? tsFn(t, 'rise') : 0;
  return t;
}

export function noop(): void { /* no-op */ }

// Schema-v1 serialization guard. The in-process VerdictResult may carry
// W2/W3/W4 provenance fields (family_A_shadow / family_C_verdict /
// family_D_shadow / family_E_verdict / fusion) that the on-disk v1 schema
// does not describe. Drop those at write time for v1 records; v2 records
// adopt them formally per audit/SCHEMA.md v2.
const SCHEMA_V1_STRIP_KEYS = new Set<string>([
  'family_A_shadow',
  'family_A_legacy_shadow',
  'family_C_verdict',
  'family_C_mmd_verdict',
  'family_D_shadow',
  'family_E_verdict',
  'fusion',
]);
function _schemaV1Replacer(key: string, value: unknown): unknown {
  if (SCHEMA_V1_STRIP_KEYS.has(key)) return undefined;
  return value;
}

// Schema-v2 serialization guard. v2 surfaces `families` as the normative
// per-family block; the in-process `family_*_shadow` / `family_*_verdict`
// keys and raw `fusion` are redundant projections, so strip them from
// gate_results.health to keep the on-disk record canonical (matches v2
// spec — fields live in top-level `families`, not inside gate_results).
const SCHEMA_V2_STRIP_KEYS = new Set<string>([
  'family_A_shadow',
  'family_A_legacy_shadow',
  'family_C_verdict',
  'family_C_mmd_verdict',
  'family_D_shadow',
  'family_E_verdict',
  'fusion',
]);
function _schemaV2Replacer(key: string, value: unknown): unknown {
  if (SCHEMA_V2_STRIP_KEYS.has(key)) return undefined;
  return value;
}

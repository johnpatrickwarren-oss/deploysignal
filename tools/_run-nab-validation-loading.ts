// tools/_run-nab-validation-loading.ts — Q64 SPEC-4 NAB dataset loading.
//
// Extracted VERBATIM from tools/run-nab-validation.ts (dataset discovery,
// CSV parsing, labels load, annotation conversion). Re-exported from
// tools/run-nab-validation.ts to preserve the original import surface.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NABSubBenchmark, NABDatasetAnnotation } from './_run-nab-validation-types';

// ── NAB dataset discovery + parsing ─────────────────────────────

/** Discover NAB dataset CSV files under <nabRepoPath>/data/<sub>/*.csv. */
export function discoverNABDatasets(
  nabRepoPath: string, subBenchmarks: NABSubBenchmark[],
): Array<{ subBenchmark: NABSubBenchmark; relPath: string; absPath: string }> {
  const out: Array<{ subBenchmark: NABSubBenchmark; relPath: string; absPath: string }> = [];
  const dataRoot = path.join(nabRepoPath, 'data');
  if (!fs.existsSync(dataRoot)) {
    throw new Error(`NAB repository missing data/ directory at ${nabRepoPath}; verify nabRepoPath`);
  }
  for (const sub of subBenchmarks) {
    const subDir = path.join(dataRoot, sub);
    if (!fs.existsSync(subDir)) continue;
    const entries = fs.readdirSync(subDir);
    for (const entry of entries) {
      if (!entry.endsWith('.csv')) continue;
      const abs = path.join(subDir, entry);
      const rel = path.join(sub, entry);
      out.push({ subBenchmark: sub, relPath: rel, absPath: abs });
    }
  }
  return out;
}

/** Parse NAB dataset CSV. Numenta convention: header row `timestamp,
 *  value`; per-tick observation. Returns per-tick value array (tick
 *  index = row index post-header). */
export function parseNABDatasetCsv(absPath: string): { values: number[]; timestamps: string[] } {
  const data = fs.readFileSync(absPath, 'utf8');
  const lines = data.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0].split(',').map((s) => s.trim());
  const tsIdx = header.indexOf('timestamp');
  const valIdx = header.indexOf('value');
  if (tsIdx < 0 || valIdx < 0) {
    throw new Error(
      `NAB CSV ${path.basename(absPath)} missing 'timestamp' or 'value' header column. `
      + `Got: ${JSON.stringify(header)}`,
    );
  }
  const values: number[] = [];
  const timestamps: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    timestamps.push(f[tsIdx]);
    values.push(parseFloat(f[valIdx]));
  }
  return { values, timestamps };
}

/** Load NAB combined_windows.json labels file. Maps relative dataset
 *  path (e.g. 'realKnownCause/foo.csv') to array of [start_ts, end_ts]
 *  ISO strings. */
export function loadNABLabels(labelsPath: string): Record<string, Array<[string, string]>> {
  if (!fs.existsSync(labelsPath)) {
    throw new Error(`NAB labels missing at ${labelsPath}; verify nabRepoPath/labels/combined_windows.json`);
  }
  const data = fs.readFileSync(labelsPath, 'utf8');
  return JSON.parse(data);
}

/** Convert NAB ISO-timestamp anomaly windows to tick-index annotations
 *  by indexing into the per-dataset timestamps array. */
/** Normalize a NAB timestamp string for comparison.
 *  Labels carry microseconds (`"2014-04-10 07:15:00.000000"`) while
 *  CSVs drop them (`"2014-04-10 07:15:00"`). Strip the fractional
 *  seconds component so label timestamps match CSV timestamps for
 *  tick-bucket lookup. Also tolerates `T` separator and `Z` suffix
 *  defensively. */
function normalizeNABTimestamp(ts: string): string {
  // Convert ISO 'T' separator to space; drop trailing 'Z'.
  let s = ts.replace('T', ' ').replace(/Z$/, '');
  // Strip fractional seconds.
  s = s.replace(/\.\d+$/, '');
  return s;
}

export function annotationsFromLabels(
  labelWindows: Array<[string, string]>, timestamps: string[],
): NABDatasetAnnotation[] {
  const tsToTick = new Map<string, number>();
  for (let i = 0; i < timestamps.length; i++) tsToTick.set(normalizeNABTimestamp(timestamps[i]), i);
  const out: NABDatasetAnnotation[] = [];
  for (const [startTs, endTs] of labelWindows) {
    const start = tsToTick.get(normalizeNABTimestamp(startTs));
    const end = tsToTick.get(normalizeNABTimestamp(endTs));
    if (start === undefined || end === undefined) continue;  // label timestamp not in dataset
    out.push({ anomaly_window_start: start, anomaly_window_end: end });
  }
  return out;
}

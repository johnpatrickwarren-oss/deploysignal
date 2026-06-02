// tools/_ingest-public-dataset-emit.ts — Q60 Slice 1 public-dataset
// ingestion: baseline-bundle emitter (extracted verbatim from
// tools/ingest-public-dataset.ts during a behavior-preserving split).

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BundleRun } from './ingest-real-trace.js';
import type { BaselineProvenance } from '../engine/types';
import { ALL_SIGNALS, type BaselineManifest } from './_ingest-public-dataset-types.js';

// ── Baseline bundle emitter ──────────────────────────────────────

export function emitBaselineBundle(
  outputDir: string,
  bundleRuns: BundleRun[],
  meta: {
    baseline_provenance: BaselineProvenance;
    caveat_filters_applied: string[];
    tick_seconds: number;
  },
): void {
  fs.mkdirSync(outputDir, { recursive: true });

  // Compute n_runs + ticks_per_run from the runs (max length).
  let ticksPerRun = 0;
  const tenants = new Set<string>();
  for (const run of bundleRuns) {
    tenants.add(run.tenant_id);
    for (const sig of Object.keys(run.signal_series)) {
      const len = run.signal_series[sig].length;
      if (len > ticksPerRun) ticksPerRun = len;
    }
  }

  // Determine which signals are populated across the runs.
  const populatedSignals = new Set<string>();
  for (const run of bundleRuns) {
    for (const sig of Object.keys(run.signal_series)) {
      populatedSignals.add(sig);
    }
  }

  // Manifest.json: same shape as synthetic-v1 manifest.
  // Derive synthetic 168-cell hour_of_day_x_day_of_week mapping per
  // tick index when the upstream mapper hasn't already attached one.
  // Real-trace timestamps are elapsed-seconds anchored at trace start,
  // not wall-clock; the calibrator's diurnal cell partition is a sample-
  // bucketing aid (variance estimation across 168 cells), not a model of
  // real diurnality, so a synthetic anchor at Sunday 00:00:00 is
  // sufficient and consistent across substrates.
  const tickSeconds = meta.tick_seconds;
  for (const run of bundleRuns) {
    const len = Object.values(run.signal_series)[0]?.length ?? 0;
    if (!run.hour_of_day) {
      const hod = new Array<number>(len);
      const dow = new Array<number>(len);
      for (let t = 0; t < len; t++) {
        const sec = t * tickSeconds;
        hod[t] = Math.floor(sec / 3600) % 24;
        dow[t] = Math.floor(sec / 86400) % 7;
      }
      run.hour_of_day = hod;
      run.day_of_week = dow;
    }
  }

  const manifest: BaselineManifest = {
    version: `${meta.baseline_provenance}-v1`,
    generated_at: new Date().toISOString(),
    seed: 0,  // real-data ingestion is deterministic by source data
    cell_dim: 'hour_of_day_x_day_of_week',
    n_runs: bundleRuns.length,
    ticks_per_run: ticksPerRun,
    tenants: tenants.size,
    signals: ALL_SIGNALS,  // canonical signal-set; populated subset stamped via signal_series
    baseline_provenance: meta.baseline_provenance,
    caveat_filters_applied: meta.caveat_filters_applied,
  };
  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // bundle.jsonl: one JSON object per run.
  const lines = bundleRuns.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(outputDir, 'bundle.jsonl'), lines + '\n');

  // README.md: provenance + caveats note.
  const readme = `# Real-data baseline bundle: ${meta.baseline_provenance}\n\n`
    + `Generated: ${manifest.generated_at}\n\n`
    + `Source: Q60 Slice 1 ingestion via tools/ingest-public-dataset.ts.\n\n`
    + `## Caveat filters applied\n\n`
    + meta.caveat_filters_applied.map((f) => `- ${f}`).join('\n')
    + `\n\n## Signals populated\n\n`
    + Array.from(populatedSignals).map((s) => `- ${s}`).join('\n')
    + '\n';
  fs.writeFileSync(path.join(outputDir, 'README.md'), readme);
}

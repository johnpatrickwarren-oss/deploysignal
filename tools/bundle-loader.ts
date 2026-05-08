// tools/bundle-loader.ts — REPLY-51b R4-2 bundle-metadata fast-path.
//
// Exposes `loadBundleMetadata(path)` for the dispatch layer to
// reconcile profile-specified `cell_dimensions` against what the
// baseline bundle actually supports (three-case per REPLY-51a D4).
// Reads only `manifest.json`; does not materialize `bundle.jsonl`
// samples so the call stays fast (compile-startup path) and safe
// (no heavy I/O under contention).
//
// Sample-materializing `loadBundle` stays in `tools/calibrate.ts`
// — this module is the narrow metadata surface Phase 4 needs.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BundleMetadata } from '../engine/types';

interface RawManifest {
  version?: string;
  generated_at?: string;
  seed?: number;
  cell_dim?: 'hour_of_day' | 'hour_of_day_x_day_of_week';
  n_runs?: number;
  ticks_per_run?: number;
  tenants?: number;
  signals?: string[];
  temporal_span_days?: number;
  ingestion_version?: string;
}

/** Load + parse the bundle's manifest; derive the narrow metadata
 *  contract the profile dispatch layer consumes. Throws with a
 *  descriptive error when `manifest.json` is missing or malformed —
 *  fast-fail at compile-startup beats a cryptic failure later. */
export function loadBundleMetadata(bundleDir: string): BundleMetadata {
  const abs = path.resolve(process.cwd(), bundleDir);
  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`bundle manifest.json missing in ${abs}`);
  }
  let raw: RawManifest;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawManifest;
  } catch (err) {
    throw new Error(
      `bundle manifest.json at ${manifestPath} failed to parse: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }

  const cellDim = raw.cell_dim;
  // hour_of_day: always present on any non-degenerate bundle (a
  // bundle without an hour axis isn't compile-eligible).
  const hourOfDay = cellDim === 'hour_of_day' || cellDim === 'hour_of_day_x_day_of_week';
  const dayOfWeek = cellDim === 'hour_of_day_x_day_of_week';
  // tenant_tier: fast-path heuristic via `manifest.tenants`. A bundle
  // declaring ≥ 2 tenants can support per-tier cell emission. Single-
  // tenant (or un-declared) bundles collapse to the aggregate tier.
  // Verifying per-run `tenant_id` presence would require scanning
  // bundle.jsonl; skipped in the fast-path per REPLY-51b R4-2 intent.
  const tenantTier = (raw.tenants ?? 1) > 1;
  // workload_class + region: no manifest support in v1 bundles;
  // always false. Future bundle generators add these fields; reader
  // upgrades follow.
  const workloadClass = false;
  const region = false;

  const sampleCount = (raw.n_runs ?? 0) * (raw.ticks_per_run ?? 0);
  const temporalSpanDays = raw.temporal_span_days ?? 0;
  const sourceId = raw.version ?? 'unknown';
  const ingestionVersion = raw.ingestion_version ?? sourceId;

  return {
    available_dimensions: {
      hour_of_day: hourOfDay,
      day_of_week: dayOfWeek,
      workload_class: workloadClass,
      tenant_tier: tenantTier,
      region: region,
    },
    sample_count: sampleCount,
    temporal_span_days: temporalSpanDays,
    source_id: sourceId,
    ingestion_version: ingestionVersion,
  };
}

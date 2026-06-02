// tools/_ingest-real-trace-mooncake.ts — Mooncake (Kimi KV-cache)
// schema-map mapper. Extracted verbatim from
// tools/ingest-real-trace.ts (behavior-preserving split).

import type { BundleRun } from './_ingest-real-trace-types.js';

/** Q60 Slice 1 Phase-1.2 schema-drift normalization: actual Mooncake
 *  JSONL field names are `timestamp` (no `_ms` suffix; integer ms
 *  offset) + `hash_ids: number[]` (page-hash 64-bit ints, NOT
 *  strings) per Mac Claude 2 Phase 1.1 acquisition probe at
 *  `<external-dataset-dir>/Mooncake/FAST25-release/
 *  arxiv-trace/mooncake_trace.jsonl`. Mapper accepts both shapes via
 *  field-aliasing + hash_ids type widening. */
export interface MooncakeRawRow {
  // Canonical-normalized field name:
  timestamp_ms?: number;
  // Raw-JSONL field name (drift):
  timestamp?: number;
  input_length: number;
  output_length: number;
  // Hash IDs — accept both shapes; widening to (string | number)[].
  hash_ids: Array<string | number>;
}

/** Map Mooncake rows to KV-cache saturation signal. Constrained to
 *  Family B kv_cache calibration per D2 caveat — NOT Family D
 *  spectral/BOCPD (multi-cycle required; Mooncake is 1-hour
 *  window). Caller must constrain row input to a single 1-hour
 *  window; the mapper doesn't enforce the window boundary
 *  (caller's responsibility). Phase-1.2 schema-drift normalization
 *  accepts `timestamp` (raw JSONL) OR `timestamp_ms` (canonical) +
 *  hash_ids as (string | number)[]. */
export function mapMooncakeRows(
  rows: MooncakeRawRow[],
  opts: { tick_seconds?: number; tenant_id?: string } = {},
): { run: BundleRun; filters_applied: string[] } {
  const tickSeconds = opts.tick_seconds ?? 5;
  const tenantId = opts.tenant_id ?? 'mooncake-aggregate';
  const filters: string[] = [
    'mooncake_window:1hour_single',
    'mooncake_scope:family_b_kv_cache_only_not_family_d',
  ];
  if (rows.length === 0) {
    return {
      run: { tenant_id: tenantId, signal_series: {} },
      filters_applied: filters,
    };
  }
  // Phase-1.2 normalization: accept either timestamp_ms (canonical)
  // OR timestamp (raw JSONL).
  const tsAt = (r: MooncakeRawRow): number => r.timestamp_ms ?? r.timestamp ?? 0;
  const t0 = tsAt(rows[0]);
  const buckets = new Map<number, MooncakeRawRow[]>();
  for (const r of rows) {
    const tick = Math.floor((tsAt(r) - t0) / (tickSeconds * 1000));
    const b = buckets.get(tick) ?? [];
    b.push(r);
    buckets.set(tick, b);
  }
  const sortedTicks = Array.from(buckets.keys()).sort((a, b) => a - b);
  // kv_cache saturation proxy: hash-id reuse ratio within the
  // bucket. Distinct-hash-ids / total-hash-ids = 1.0 means every
  // request carries fresh cache lines (low reuse; high saturation
  // risk). Smaller ratios indicate hot caches.
  const kvCache: number[] = [];
  const tokensTurn: number[] = [];
  for (const t of sortedTicks) {
    const bucketRows = buckets.get(t) ?? [];
    const allHashes: string[] = [];
    let totalTokens = 0;
    for (const r of bucketRows) {
      // Phase-1.2 hash_ids type widening: convert all to strings for
      // Set semantics.
      for (const h of r.hash_ids) allHashes.push(String(h));
      totalTokens += r.input_length + r.output_length;
    }
    const distinct = new Set(allHashes).size;
    const reuse = allHashes.length > 0 ? distinct / allHashes.length : 1.0;
    kvCache.push(reuse);
    tokensTurn.push(bucketRows.length > 0 ? totalTokens / bucketRows.length : 0);
  }
  return {
    run: {
      tenant_id: tenantId,
      signal_series: { kv_cache: kvCache, tokens_turn: tokensTurn },
    },
    filters_applied: filters,
  };
}

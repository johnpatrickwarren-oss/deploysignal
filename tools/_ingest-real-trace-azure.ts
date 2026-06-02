// tools/_ingest-real-trace-azure.ts — Azure LLM Inference schema-map
// mapper. Extracted verbatim from tools/ingest-real-trace.ts
// (behavior-preserving split).
//
// CAVEAT (architect + TPM): ContextTokens is an ESTIMATOR field,
// not an actual count. Used ONLY for arrival-process grounding —
// never fed as cost_req. Cost derivation comes from grounded-
// synthetic overlay with explicit flag.

import type { BundleRun } from './_ingest-real-trace-types.js';

/** Q60 Slice 1 Phase-1.2 schema-drift normalization: actual Azure
 *  CSV header is `TIMESTAMP,ContextTokens,GeneratedTokens` (per Mac
 *  Claude 2 Phase 1.1 acquisition probe at
 *  `<external-dataset-dir>/AzurePublicDataset/data/
 *  AzureLLMInferenceTrace_conv.csv`). Mapper accepts both
 *  canonical-normalized rows (the ingestion orchestrator's
 *  `tools/ingest-public-dataset.ts` does CSV-header translation)
 *  AND raw-CamelCase rows (for direct mapper consumption from
 *  CSV-parser callers); see field-aliasing in mapAzureLLMRows. */
export interface AzureLLMRawRow {
  // Canonical-normalized field names (post-orchestrator translation):
  timestamp_ms?: number;
  context_tokens_est?: number;  // estimator; see caveat
  generated_tokens?: number;
  // Raw-CSV CamelCase field names (pre-orchestrator translation):
  TIMESTAMP?: number | string;  // ISO datetime string OR ms epoch
  ContextTokens?: number;
  GeneratedTokens?: number;
}

/** Parse Azure TIMESTAMP value (ISO datetime string `2023-11-16
 *  18:15:46.6805900` OR numeric ms epoch) to numeric ms epoch. */
function parseAzureTimestamp(v: number | string): number {
  if (typeof v === 'number') return v;
  // ISO datetime string with fractional seconds; Date.parse accepts
  // most ISO variants. Fallback to 0 on parse failure.
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** Map Azure LLM Inference rows to arrival-process + throughput
 *  signals. Does NOT emit cost_req — caveat requires grounded-
 *  synthetic cost derivation. Accepts both canonical-normalized rows
 *  and raw-CamelCase rows per Phase-1.2 schema-drift normalization. */
export function mapAzureLLMRows(
  rows: AzureLLMRawRow[],
  opts: { tick_seconds?: number; tenant_id?: string } = {},
): { run: BundleRun; filters_applied: string[] } {
  const tickSeconds = opts.tick_seconds ?? 5;
  const tenantId = opts.tenant_id ?? 'azure-llm-aggregate';
  const filters = ['azure_context_tokens_arrival_only:drop_from_cost_req'];

  if (rows.length === 0) {
    return {
      run: { tenant_id: tenantId, signal_series: {} },
      filters_applied: filters,
    };
  }

  // Phase-1.2 normalization: accept either canonical or CamelCase.
  const normalized = rows.map((r) => ({
    timestamp_ms: r.timestamp_ms ?? (r.TIMESTAMP !== undefined ? parseAzureTimestamp(r.TIMESTAMP) : 0),
    generated_tokens: r.generated_tokens ?? r.GeneratedTokens ?? 0,
  }));

  const t0 = normalized[0].timestamp_ms;
  const buckets = new Map<number, typeof normalized>();
  for (const r of normalized) {
    const tick = Math.floor((r.timestamp_ms - t0) / (tickSeconds * 1000));
    const b = buckets.get(tick) ?? [];
    b.push(r);
    buckets.set(tick, b);
  }
  const sortedTicks = Array.from(buckets.keys()).sort((a, b) => a - b);
  const tokensTurn: number[] = [];
  for (const t of sortedTicks) {
    const bucketRows = buckets.get(t) ?? [];
    const tokens = bucketRows.map((r) => r.generated_tokens);
    const mean = tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
    tokensTurn.push(mean);
  }
  return {
    run: {
      tenant_id: tenantId,
      signal_series: { tokens_turn: tokensTurn },
    },
    filters_applied: filters,
  };
}

// tools/_ingest-real-trace-burstgpt.ts — BurstGPT schema-map mapper.
// Extracted verbatim from tools/ingest-real-trace.ts (behavior-
// preserving split).
//
// Q60 Slice 1 V1 architect-pick A1 (BurstGPT cost_req-only mapper
// rewrite): actual public BurstGPT_1.csv schema (per Mac Claude 2
// Phase 1.1 acquisition probe at `<external-dataset-dir>/
// BurstGPT/data/BurstGPT_1.csv`) lacks `session_id` +
// `elapsed_ms` + `model_version` fields; `Log Type` enum drifted to
// `'API log'` / `'Conversation log'` (request types) from spec's
// `'service_error'` / `'internal_error'` / `'upstream_5xx'` (error
// types). Existing pre-V1 mapper produced malformed BundleRun on
// actual data (empty p99_latency; all-zero downstream_err).
//
// V1 architect-pick A1: downscope BurstGPT mapper to cost_req-only
// signal coverage. Drop p99_latency + downstream_err derivation;
// keep cost_req via tokens × pricing overlay (grounded-synthetic
// channel architecturally pre-existed for cost_req derivation).
// BurstGPT contributes 1 of 3 Family A signals to per-substrate
// calibration; sparse-cell fallback handles the rest. Multi-signal
// coverage retained on Azure + Mooncake substrates per Slice 1
// architecture.
//
// Actual schema (post-Phase-1.1):
//   {
//     timestamp_s: number,        // CSV `Timestamp` (numeric s)
//     model: string,              // CSV `Model` (e.g., 'ChatGPT')
//     request_tokens: number,     // CSV `Request tokens`
//     response_tokens: number,    // CSV `Response tokens`
//     total_tokens: number,       // CSV `Total tokens` (informational)
//     log_type: string,           // CSV `Log Type` (informational)
//   }
//
// Pitch claim CAVEAT post-A1: BurstGPT cost_req-only validation;
// multi-signal coverage on Azure + Mooncake.

import type { BundleRun } from './_ingest-real-trace-types.js';

export interface BurstGPTRawRow {
  timestamp_s: number;
  model?: string;
  request_tokens: number;
  response_tokens: number;
  total_tokens?: number;
  log_type?: string;
}

export interface BurstGPTIngestOpts {
  /** Tokens-to-cost multiplier (caller supplies from published
   *  pricing table; e.g., GPT-4 $0.03 per 1K input + $0.06 per 1K
   *  output → combined multiplier per prompt shape). REQUIRED for
   *  cost_req derivation post-A1; without this, signal_series stays
   *  empty since no other signals derivable from actual schema. */
  tokens_to_cost_per_request?: (request_tokens: number, response_tokens: number) => number;
  /** Tick cadence — default 5 seconds per tick (matches DS
   *  canonical 5s sampling interval). */
  tick_seconds?: number;
  /** Synthetic tenant_id for the derived run. Default 'burstgpt-
   *  aggregate' (no per-session ID in actual data). */
  tenant_id?: string;
}

/** Map a set of BurstGPT rows to a single BundleRun (V1 A1: cost_req-
 *  only). Synthetic tenant_id (no session_id in actual data); time-
 *  bucket by tick_seconds; cost_req via tokens × pricing overlay. */
export function mapBurstGPTRows(
  rows: BurstGPTRawRow[],
  opts: BurstGPTIngestOpts = {},
): { run: BundleRun; filters_applied: string[] } {
  const tickSeconds = opts.tick_seconds ?? 5;
  const tenantId = opts.tenant_id ?? 'burstgpt-aggregate';
  const filters: string[] = [
    'burstgpt_v1_a1:cost_req_only_scope',
    'burstgpt_no_p99_latency:elapsed_ms_field_absent_in_actual_csv',
    'burstgpt_no_downstream_err:service_error_log_type_absent_in_actual_csv',
  ];

  if (rows.length === 0) {
    return {
      run: { tenant_id: tenantId, signal_series: {} },
      filters_applied: filters,
    };
  }
  if (!opts.tokens_to_cost_per_request) {
    // Without pricing multiplier, no signals derivable post-A1.
    filters.push('burstgpt_no_pricing_multiplier:cost_req_undefined');
    return {
      run: { tenant_id: tenantId, signal_series: {} },
      filters_applied: filters,
    };
  }

  // Bucket rows into tick-aligned windows.
  const t0 = rows[0].timestamp_s;
  const buckets = new Map<number, BurstGPTRawRow[]>();
  for (const r of rows) {
    const tick = Math.floor((r.timestamp_s - t0) / tickSeconds);
    const b = buckets.get(tick) ?? [];
    b.push(r);
    buckets.set(tick, b);
  }
  const sortedTicks = Array.from(buckets.keys()).sort((a, b) => a - b);

  const costReq: number[] = [];
  for (const t of sortedTicks) {
    const bucketRows = buckets.get(t) ?? [];
    const costs = bucketRows.map(
      (r) => opts.tokens_to_cost_per_request!(r.request_tokens, r.response_tokens),
    );
    const mean = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    costReq.push(mean);
  }

  return {
    run: {
      tenant_id: tenantId,
      signal_series: { cost_req: costReq },
    },
    filters_applied: filters,
  };
}

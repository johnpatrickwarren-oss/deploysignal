// tools/ingest-real-trace.ts — REPLY-52 D2 real-data schema-map layer.
//
// Per-source mapping functions that translate raw third-party trace
// rows into DS's per-run signal_series shape (same format as
// synthetic-v1 bundles). Structural translation only — NO runtime
// dataset integration here (datasets live outside the repo; caller
// feeds pre-parsed rows). Caveat-filtering baked into the mapping
// per REPLY-52 §D2 (service_error filtering, model-version
// segmentation, Mooncake 1-hour window constraints).
//
// Design invariants:
//   - Pure functions on pre-parsed row arrays; no file I/O on raw
//     trace data. (Callers handle file reads with their own
//     source-appropriate parser.)
//   - Each source maps to a BundleRun shape: tenant_id +
//     signal_series + (hour_of_day[] + day_of_week[]) parallel
//     arrays. Consumer feeds BundleRun[] to gen-synthetic-baseline
//     style emitter.
//   - grounded_synthetic source derives cost_req + quality signals
//     from raw tokens × pricing × judge-model distributions; flagged
//     via CompiledConfig.baseline_provenance='grounded_synthetic'.

import type { BaselineProvenance } from '../engine/types';

export interface BundleRun {
  tenant_id: string;
  signal_series: Record<string, number[]>;
  hour_of_day?: number[];
  day_of_week?: number[];
}

export interface IngestReport {
  source: BaselineProvenance;
  n_runs: number;
  n_ticks_total: number;
  signals_populated: string[];
  /** Structured log of caveat-driven filters applied (per D2). */
  filters_applied: string[];
}

// ── BurstGPT ────────────────────────────────────────────────────────
//
// Q60 Slice 1 V1 architect-pick A1 (BurstGPT cost_req-only mapper
// rewrite): actual public BurstGPT_1.csv schema (per Mac Claude 2
// Phase 1.1 acquisition probe at `/Users/johnwarren/Desktop/q60-raw-
// data/BurstGPT/data/BurstGPT_1.csv`) lacks `session_id` +
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

// ── Azure LLM Inference (2025 multimodal) ──────────────────────────
//
// CAVEAT (architect + TPM): ContextTokens is an ESTIMATOR field,
// not an actual count. Used ONLY for arrival-process grounding —
// never fed as cost_req. Cost derivation comes from grounded-
// synthetic overlay with explicit flag.

/** Q60 Slice 1 Phase-1.2 schema-drift normalization: actual Azure
 *  CSV header is `TIMESTAMP,ContextTokens,GeneratedTokens` (per Mac
 *  Claude 2 Phase 1.1 acquisition probe at
 *  `/Users/johnwarren/Desktop/q60-raw-data/AzurePublicDataset/data/
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

// ── Mooncake (Kimi KV-cache) ────────────────────────────────────────

/** Q60 Slice 1 Phase-1.2 schema-drift normalization: actual Mooncake
 *  JSONL field names are `timestamp` (no `_ms` suffix; integer ms
 *  offset) + `hash_ids: number[]` (page-hash 64-bit ints, NOT
 *  strings) per Mac Claude 2 Phase 1.1 acquisition probe at
 *  `/Users/johnwarren/Desktop/q60-raw-data/Mooncake/FAST25-release/
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

// ── Grounded-synthetic overlay ──────────────────────────────────────

export interface GroundedSyntheticInputs {
  /** Raw per-tick token counts (request + response summed or
   *  separated as caller prefers; multiplier resolves). */
  tokens_per_tick: number[];
  /** Per-tick judge-model quality scores in [0, 1]. */
  judge_scores: number[];
  /** Per-tick tool-invocation success counts + attempts (for
   *  tool_success_rate). */
  tool_success?: { successes: number[]; attempts: number[] };
  /** Published cost-per-token (USD); multiplied against tokens
   *  for cost_req. */
  cost_per_token: number;
}

/** Derive quality/cost/error signals from the grounded-synthetic
 *  overlay inputs. Explicit `grounded-synthetic` provenance flag
 *  should be stamped on the resulting CompiledConfig so audit
 *  consumers know the derivation. */
export function mapGroundedSyntheticOverlay(
  inputs: GroundedSyntheticInputs,
  opts: { tenant_id?: string } = {},
): { run: BundleRun; filters_applied: string[] } {
  const tenantId = opts.tenant_id ?? 'grounded-synthetic';
  const signal_series: Record<string, number[]> = {};

  // cost_req: tokens × pricing per tick.
  const costReq = inputs.tokens_per_tick.map((n) => n * inputs.cost_per_token);
  signal_series.cost_req = costReq;

  // eval_score: judge-model distribution directly.
  signal_series.eval_score = inputs.judge_scores.slice();

  // tool_success_rate: successes / attempts per tick.
  if (inputs.tool_success) {
    const { successes, attempts } = inputs.tool_success;
    const rate: number[] = [];
    for (let i = 0; i < successes.length; i++) {
      const att = attempts[i] ?? 0;
      rate.push(att > 0 ? successes[i] / att : 0);
    }
    signal_series.tool_success_rate = rate;
  }

  return {
    run: { tenant_id: tenantId, signal_series },
    filters_applied: [
      'grounded_synthetic:cost_req_via_tokens_times_pricing',
      'grounded_synthetic:eval_score_via_judge_model_distribution',
    ],
  };
}

// ── HuggingFace LMSYS Arena (Q62 Slice 2 H1; HF-only narrowing) ─────
//
// Per ARCHITECT-REPLY-Q62-PHASE-1-2-LS-1-SCHEMA-DRIFT-DISPOSITION.md
// § Ask 1 (H1 PICKED). REPLACES architect-spec-as-drafted interface
// (which expected conversation_id + judge + turn + *_tokens + timestamp_ms
// + request_latency_ms — none of which exist in lmsys-arena-human-
// preference-55k actual schema; per Q62 LS-1 schema-drift diagnostic).
//
// H1 empirical schema (post-Q62 LS-1 verification on
// lmsys/lmsys-arena-human-preference-55k 176MB train.csv;
// johns-Mac-mini:~/q62-raw-data/HuggingFace-LMSYS-Arena/data/):
//   id, model_a, model_b, prompt, response_a, response_b,
//   winner_model_a, winner_model_b, winner_tie
//
// Signal coverage emitted (3-signal multi-signal vs Slice 1 single-signal):
//   - eval_score: winner_model_a==1 ? 1.0 : 0.0 (binary mapping; rejected
//     winner_tie rows don't reach this code path under default
//     reject_judge_disagreement=true).
//   - cost_req: tokens × per-model pricing (caller-supplied function).
//     Tokens derived from text length (Math.ceil(len/4); GPT-tokenizer
//     approximation; CAVEAT documented in filters_applied stamping).
//   - tokens_turn: prompt + winner response tokens (sum across all turns
//     within the multi-turn conversation row).
//
// Synthetic-timestamp framework (Q62 LS-1 H1 disposition CAVEAT):
//   HF dataset has NO actual timestamps. Per-row tick assignment derives
//   from row_index × tick_seconds. CAVEAT filters_applied stamping makes
//   the synthetic-timestamp framework explicit; substrate validation
//   methodology integrity preserved per architect § H1 implementation
//   scope. Pitch claim narrows accordingly per architect § H1 pitch claim.
//
// Caveat filters retained:
//   - model_segment: model-family segmentation (gpt-3.5/gpt-4/claude-3/all).
//   - reject_judge_disagreement (default true): drops winner_tie rows for
//     eval_score signal validity.
//
// AlpaServe + DeepSpeed-FastGen mappers DROPPED at H1 (tagged
// Phase-3.d Slice 2.b future per architect § Ask 1 disposition; v9b/v9c
// substrate naming reserved for future re-discovery cycle).

export interface HuggingFaceLMSYSArenaRawRow {
  // Empirical schema columns from lmsys-arena-human-preference-55k
  // train.csv (post-Q62 LS-1 verification 2026-05-04):
  id: string;
  model_a: string;
  model_b: string;
  /** JSON-encoded array of per-turn user prompts (multi-turn conversations
   *  embedded as JSON-array within the single row). Caller-side: parsed
   *  by mapper via JSON.parse with text-array fallback. */
  prompt: string;
  /** JSON-encoded array of per-turn model A responses (parallel to prompt). */
  response_a: string;
  /** JSON-encoded array of per-turn model B responses (parallel to prompt). */
  response_b: string;
  /** Boolean (or 0/1 numeric on raw CSV) — model A won pairwise comparison. */
  winner_model_a: boolean | number;
  /** Boolean (or 0/1) — model B won. */
  winner_model_b: boolean | number;
  /** Boolean (or 0/1) — judge tie / both bad (combined; actual schema only
   *  has single winner_tie column, NOT the architect-drafted winner_tie +
   *  winner_tie_bothbad pair). */
  winner_tie: boolean | number;
}

export interface HuggingFaceLMSYSArenaIngestOpts {
  tick_seconds?: number;
  tenant_id?: string;
  model_segment?: 'gpt-3.5' | 'gpt-4' | 'claude-3' | 'all';
  reject_judge_disagreement?: boolean;
  tokens_to_cost_per_request?: (
    model: string, prompt_tokens: number, response_tokens: number,
  ) => number;
}

/** Approximate token count from text length. GPT-family tokenizer
 *  averages ~4 characters per token for English text; this heuristic
 *  is documented in CAVEAT framework — not a precise tokenization. */
function approxTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Parse JSON-encoded multi-turn array; on parse failure, treat as
 *  single-turn raw text. Returns sum of approx token counts across all
 *  turns. */
function parseMultiTurnTokenSum(jsonOrText: string): number {
  if (!jsonOrText) return 0;
  try {
    const arr = JSON.parse(jsonOrText);
    if (Array.isArray(arr)) {
      let sum = 0;
      for (const turn of arr) {
        if (typeof turn === 'string') sum += approxTokenCount(turn);
      }
      return sum;
    }
  } catch {
    // Not valid JSON; fall through to single-turn fallback.
  }
  return approxTokenCount(jsonOrText);
}

/** Truthy coercion that tolerates boolean (true/false) AND CSV-parser
 *  raw 0/1 numerics for winner_* columns. */
function isWinnerTrue(v: boolean | number | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  return v === 1 || v > 0.5;
}

export function mapHuggingFaceLMSYSArenaRows(
  rows: HuggingFaceLMSYSArenaRawRow[],
  opts: HuggingFaceLMSYSArenaIngestOpts = {},
): { run: BundleRun; filters_applied: string[] } {
  const tickSeconds = opts.tick_seconds ?? 5;
  const tenantId = opts.tenant_id ?? 'huggingface-lmsys-arena-aggregate';
  const rejectDisagreement = opts.reject_judge_disagreement ?? true;
  const filters: string[] = [
    'synthetic_timestamp_derivation:row_index_x_tick_seconds',
    'token_count_heuristic:chars_div_4_gpt_tokenizer_approximation',
  ];

  if (rows.length === 0) {
    return { run: { tenant_id: tenantId, signal_series: {} }, filters_applied: filters };
  }

  let filtered = rows;

  // Judge-disagreement caveat filter (default true): drop winner_tie rows.
  if (rejectDisagreement) {
    filtered = filtered.filter((r) => isWinnerTrue(r.winner_model_a) || isWinnerTrue(r.winner_model_b));
    filters.push('reject_judge_disagreement:true');
  }

  // Model-segment caveat filter (analogous to BurstGPT model_version_segment).
  if (opts.model_segment && opts.model_segment !== 'all') {
    const seg = opts.model_segment;
    filtered = filtered.filter((r) =>
      r.model_a.startsWith(seg) || r.model_b.startsWith(seg)
    );
    filters.push(`model_segment:${seg}`);
  }

  if (filtered.length === 0) {
    return { run: { tenant_id: tenantId, signal_series: {} }, filters_applied: filters };
  }

  // Per-row → per-tick mapping (synthetic timestamp via row_index × tick_seconds).
  // Tick cadence preserved via tick_seconds parameter for parity with Slice 1
  // substrates' time_seconds bucketing semantics; per-row maps to one tick
  // (no per-bucket aggregation needed since rows are already pairwise outcomes).
  void tickSeconds;  // tick cadence reserved for future per-tick aggregation extensions
  const evalScore: number[] = [];
  const costReq: number[] = [];
  const tokensTurn: number[] = [];
  for (const r of filtered) {
    const aWon = isWinnerTrue(r.winner_model_a);
    // eval_score: 1.0 if model_a wins; 0.0 if model_b wins.
    evalScore.push(aWon ? 1.0 : 0.0);
    // tokens_turn + cost_req: parse multi-turn JSON arrays; sum across all turns.
    const promptTokens = parseMultiTurnTokenSum(r.prompt);
    const responseTokens = parseMultiTurnTokenSum(aWon ? r.response_a : r.response_b);
    tokensTurn.push(promptTokens + responseTokens);
    if (opts.tokens_to_cost_per_request) {
      costReq.push(opts.tokens_to_cost_per_request(
        aWon ? r.model_a : r.model_b,
        promptTokens, responseTokens,
      ));
    }
  }

  const signal_series: Record<string, number[]> = {
    eval_score: evalScore,
    tokens_turn: tokensTurn,
  };
  if (opts.tokens_to_cost_per_request) {
    signal_series.cost_req = costReq;
  } else {
    filters.push('huggingface_no_pricing_multiplier:cost_req_undefined');
  }

  return {
    run: { tenant_id: tenantId, signal_series },
    filters_applied: filters,
  };
}

// AlpaServe + DeepSpeed-FastGen mappers DROPPED at Q62 Slice 2 H1
// per ARCHITECT-REPLY-Q62-PHASE-1-2-LS-1-SCHEMA-DRIFT-DISPOSITION § Ask 1.
// Tagged Phase-3.d Slice 2.b future cycle when architect re-discovers
// replacement multi-signal LLM-inference traces with verified availability.


/** Source identifiers matching CompiledConfig.baseline_provenance.
 *  Exported for CLI dispatch + test coverage. */
export const SUPPORTED_SOURCES: BaselineProvenance[] = [
  'real_burstgpt',
  'real_azure_llm_inference',
  'real_mooncake',
  'grounded_synthetic',
  // Q62 Slice 2 H1 (HF-only narrowing per architect H1 disposition;
  // real_alpaserve + real_deepspeed_fastgen DROPPED post Q62 LS-1
  // schema-drift CRITICAL on both datasets; tagged Phase-3.d Slice 2.b).
  'real_huggingface_lmsys_arena',
];

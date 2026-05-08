// test/real-data-ingestion-schema-map.test.ts — REPLY-52 D2 coverage.
//
// Verifies structural mapping + caveat-filtering invariants for
// the four real-data / grounded-synthetic sources. No file I/O on
// raw datasets — fixtures are inline, per D2's "structural
// translation only, no runtime dataset integration" boundary.
//
//   - BurstGPT: service_error log_type filtering, model-version
//     segmentation, session_id → tenant_id, p99 bucket calculation,
//     cost_req multiplier wiring.
//   - Azure: ContextTokens arrival-only caveat tag surfaces in
//     filters_applied; cost_req NEVER emitted from Azure rows.
//   - Mooncake: hash_ids → kv_cache reuse ratio; family-B-only +
//     1-hour-window caveat tags surface.
//   - Grounded-synthetic: cost_req = tokens × pricing; eval_score
//     passthrough; tool_success_rate = successes / attempts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapBurstGPTRows, mapAzureLLMRows, mapMooncakeRows,
  mapGroundedSyntheticOverlay, SUPPORTED_SOURCES,
} from '../tools/ingest-real-trace';
import type {
  BurstGPTRawRow, AzureLLMRawRow, MooncakeRawRow,
} from '../tools/ingest-real-trace';

// ── BurstGPT (Q60 Slice 1 V1 A1: cost_req-only mapper rewrite) ──────
//
// Pre-A1 tests (session_id → tenant_id, log_type service_error
// filter, model_version_segment, p99_latency from elapsed_ms) removed
// per Q60 V1 disposition: actual public BurstGPT_1.csv schema lacks
// `session_id` / `elapsed_ms` / `model_version` fields. A1
// downscoped mapper to cost_req-only signal coverage. New tests
// validate post-A1 contract.

test('burstgpt (V1 A1): synthetic tenant_id with no session_id in actual data', () => {
  const rows: BurstGPTRawRow[] = [
    { timestamp_s: 0, request_tokens: 10, response_tokens: 20 },
    { timestamp_s: 4, request_tokens: 10, response_tokens: 20 },
  ];
  const { run } = mapBurstGPTRows(rows, {
    tick_seconds: 5,
    tokens_to_cost_per_request: (req, res) => req * 0.0001 + res * 0.0002,
  });
  assert.equal(run.tenant_id, 'burstgpt-aggregate');  // synthetic default
});

test('burstgpt (V1 A1): cost_req-only signal coverage; p99_latency + downstream_err absent', () => {
  const rows: BurstGPTRawRow[] = [
    { timestamp_s: 0, request_tokens: 100, response_tokens: 50 },
    { timestamp_s: 6, request_tokens: 200, response_tokens: 100 },
  ];
  const { run, filters_applied } = mapBurstGPTRows(rows, {
    tick_seconds: 5,
    tokens_to_cost_per_request: (req, res) => req * 0.0001 + res * 0.0002,
  });
  // V1 A1: cost_req only; p99_latency + downstream_err NOT present.
  assert.ok(run.signal_series.cost_req);
  assert.equal(run.signal_series.cost_req.length, 2);  // tick 0 + tick 1
  // tick 0: 100*0.0001 + 50*0.0002 = 0.02
  assert.ok(Math.abs(run.signal_series.cost_req[0] - 0.02) < 1e-9);
  assert.equal(run.signal_series.p99_latency, undefined);
  assert.equal(run.signal_series.downstream_err, undefined);
  assert.ok(filters_applied.includes('burstgpt_v1_a1:cost_req_only_scope'));
});

test('burstgpt (V1 A1): without pricing multiplier, signal_series stays empty', () => {
  const rows: BurstGPTRawRow[] = [
    { timestamp_s: 0, request_tokens: 100, response_tokens: 50 },
  ];
  const { run, filters_applied } = mapBurstGPTRows(rows, { tick_seconds: 5 });
  // No tokens_to_cost_per_request → no signals derivable post-A1.
  assert.equal(Object.keys(run.signal_series).length, 0);
  assert.ok(filters_applied.includes('burstgpt_no_pricing_multiplier:cost_req_undefined'));
});

test('burstgpt (V1 A1): empty rows → empty signal_series', () => {
  const { run } = mapBurstGPTRows([], { tick_seconds: 5 });
  assert.equal(Object.keys(run.signal_series).length, 0);
});

// ── Azure LLM Inference ─────────────────────────────────────────────

test('azure: ContextTokens arrival-only caveat surfaces; cost_req NEVER emitted', () => {
  const rows: AzureLLMRawRow[] = [
    { timestamp_ms: 0,     context_tokens_est: 500, generated_tokens: 40 },
    { timestamp_ms: 2000,  context_tokens_est: 600, generated_tokens: 50 },
    { timestamp_ms: 6000,  context_tokens_est: 550, generated_tokens: 60 },
  ];
  const { run, filters_applied } = mapAzureLLMRows(rows, { tick_seconds: 5 });
  // Only tokens_turn — no cost_req (caveat).
  assert.ok(run.signal_series.tokens_turn);
  assert.equal(run.signal_series.cost_req, undefined);
  assert.ok(filters_applied.includes(
    'azure_context_tokens_arrival_only:drop_from_cost_req',
  ));
});

test('azure: empty rows → empty signal_series + caveat still documented', () => {
  const { run, filters_applied } = mapAzureLLMRows([]);
  assert.equal(Object.keys(run.signal_series).length, 0);
  assert.ok(filters_applied.includes(
    'azure_context_tokens_arrival_only:drop_from_cost_req',
  ));
});

// ── Mooncake ────────────────────────────────────────────────────────

test('mooncake: hash_ids distinct/total → kv_cache reuse ratio', () => {
  const rows: MooncakeRawRow[] = [
    // Tick 0: 4 distinct hashes across 6 total → reuse ratio = 4/6 ≈ 0.667
    { timestamp_ms: 0,    input_length: 10, output_length: 20,
      hash_ids: ['h1', 'h2', 'h3'] },
    { timestamp_ms: 2000, input_length: 10, output_length: 20,
      hash_ids: ['h1', 'h4', 'h2'] },
  ];
  const { run, filters_applied } = mapMooncakeRows(rows, { tick_seconds: 5 });
  assert.ok(run.signal_series.kv_cache);
  assert.ok(Math.abs(run.signal_series.kv_cache[0] - 4 / 6) < 1e-9);
  // Family B only + 1-hour window caveats.
  assert.ok(filters_applied.includes('mooncake_window:1hour_single'));
  assert.ok(filters_applied.includes('mooncake_scope:family_b_kv_cache_only_not_family_d'));
});

test('mooncake: no hash_ids → reuse ratio defaults to 1.0 (maximum fresh)', () => {
  const rows: MooncakeRawRow[] = [
    { timestamp_ms: 0, input_length: 10, output_length: 20, hash_ids: [] },
  ];
  const { run } = mapMooncakeRows(rows, { tick_seconds: 5 });
  assert.equal(run.signal_series.kv_cache[0], 1.0);
});

test('mooncake: tokens_turn derived from input + output lengths', () => {
  const rows: MooncakeRawRow[] = [
    { timestamp_ms: 0,    input_length: 100, output_length: 50, hash_ids: ['a'] },
    { timestamp_ms: 1000, input_length: 200, output_length: 100, hash_ids: ['b'] },
  ];
  const { run } = mapMooncakeRows(rows, { tick_seconds: 5 });
  // Both rows in tick 0: mean of 150 + 300 = 225.
  assert.equal(run.signal_series.tokens_turn[0], 225);
});

test('mooncake (Phase-1.2): accepts raw `timestamp` field + numeric hash_ids', () => {
  // Actual Mooncake JSONL schema (per Phase 1.1 acquisition probe):
  //   {"timestamp": 0, "input_length": ..., "output_length": ...,
  //    "hash_ids": [0, 1, 2, ...]}  ← timestamp (no _ms); hash_ids: number[]
  const rows: MooncakeRawRow[] = [
    { timestamp: 0,    input_length: 100, output_length: 50, hash_ids: [0, 1, 2] },
    { timestamp: 1000, input_length: 200, output_length: 100, hash_ids: [0, 3, 1] },
  ];
  const { run } = mapMooncakeRows(rows, { tick_seconds: 5 });
  // Both rows in tick 0: 4 distinct hashes (0,1,2,3) / 6 total = 0.667
  assert.ok(Math.abs(run.signal_series.kv_cache[0] - 4 / 6) < 1e-9);
});

// ── Grounded-synthetic overlay ──────────────────────────────────────

test('grounded-synthetic: cost_req = tokens × pricing per tick', () => {
  const { run, filters_applied } = mapGroundedSyntheticOverlay({
    tokens_per_tick: [100, 200, 300],
    judge_scores: [0.9, 0.88, 0.85],
    cost_per_token: 0.00001,
  });
  assert.deepEqual(run.signal_series.cost_req, [0.001, 0.002, 0.003]);
  assert.ok(filters_applied.includes('grounded_synthetic:cost_req_via_tokens_times_pricing'));
});

test('grounded-synthetic: eval_score passes judge distribution through', () => {
  const { run, filters_applied } = mapGroundedSyntheticOverlay({
    tokens_per_tick: [100],
    judge_scores: [0.9, 0.88, 0.92],
    cost_per_token: 0.00001,
  });
  assert.deepEqual(run.signal_series.eval_score, [0.9, 0.88, 0.92]);
  assert.ok(filters_applied.includes('grounded_synthetic:eval_score_via_judge_model_distribution'));
});

test('grounded-synthetic: tool_success_rate = successes / attempts', () => {
  const { run } = mapGroundedSyntheticOverlay({
    tokens_per_tick: [100, 100, 100],
    judge_scores: [0.9, 0.9, 0.9],
    cost_per_token: 0.00001,
    tool_success: {
      successes: [9, 8, 0],
      attempts:  [10, 10, 0],
    },
  });
  assert.ok(run.signal_series.tool_success_rate);
  assert.equal(run.signal_series.tool_success_rate[0], 0.9);
  assert.equal(run.signal_series.tool_success_rate[1], 0.8);
  // Zero attempts → 0 (no divide-by-zero).
  assert.equal(run.signal_series.tool_success_rate[2], 0);
});

test('grounded-synthetic: omitting tool_success → tool_success_rate absent', () => {
  const { run } = mapGroundedSyntheticOverlay({
    tokens_per_tick: [100],
    judge_scores: [0.9],
    cost_per_token: 0.00001,
  });
  assert.equal(run.signal_series.tool_success_rate, undefined);
});

// ── SUPPORTED_SOURCES invariant ─────────────────────────────────────

test('supported_sources enumerates the 5 mapper targets (4 Slice 1 + 1 Q62 Slice 2 H1 — HF-only narrowing)', () => {
  assert.deepEqual(SUPPORTED_SOURCES, [
    'real_burstgpt',
    'real_azure_llm_inference',
    'real_mooncake',
    'grounded_synthetic',
    // Q62 Slice 2 H1 (HF-only post LS-1 schema-drift; alpaserve +
    // deepspeed_fastgen DROPPED at H1; tagged Phase-3.d Slice 2.b).
    'real_huggingface_lmsys_arena',
  ]);
});

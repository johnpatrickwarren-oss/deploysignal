// tools/_ingest-real-trace-huggingface.ts — HuggingFace LMSYS Arena
// schema-map mapper. Extracted verbatim from
// tools/ingest-real-trace.ts (behavior-preserving split).
//
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

import type { BundleRun } from './_ingest-real-trace-types.js';

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

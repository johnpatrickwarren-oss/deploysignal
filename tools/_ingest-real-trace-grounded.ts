// tools/_ingest-real-trace-grounded.ts — grounded-synthetic overlay
// mapper. Extracted verbatim from tools/ingest-real-trace.ts
// (behavior-preserving split).

import type { BundleRun } from './_ingest-real-trace-types.js';

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

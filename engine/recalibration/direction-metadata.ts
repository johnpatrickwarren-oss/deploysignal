// engine/recalibration/direction-metadata.ts — Addition #15 baseline-
// maintenance lifecycle. Direction-of-better metadata for the
// maturity-metric signals used by candidate-vs-active classification
// (Task 3, engine/recalibration/classify.ts).
//
// Per NORTH-STAR-ARCHITECTURE.md § Addition #15 and plan §A2: this
// table was NOT previously a first-class engine module. It existed only
// as (a) WorkloadProfileSliEntry.direction_of_better in profile YAML,
// (b) the maturity_metrics blocks in runs/baseline-history/demo/*.json
// demo fixtures, (c) NORTH-STAR prose. This module is the single
// engine-level source of truth going forward; values below are
// hand-transcribed from the demo fixtures' maturity_metrics blocks
// (verified identical across runs/baseline-history/demo/v*.json), not
// read from those files at runtime — the demo/ directory stays a
// fixture, untouched by this addition (plan §A5).
//
// D6 (engine/tools split): pure, no fs, no I/O.

/** 'informational' signals are tracked (cost, tokens, cache, corpus
 *  churn) but have no inherent better/worse direction — an operator
 *  override is required to fold them into classification (see
 *  `directionOfBetter`'s override contract below). */
export type DirectionOfBetter = 'higher' | 'lower' | 'informational';

/** The 13 maturity-metric signals and their baseline direction-of-
 *  better classification. Exactly this set — OQ-2: unknown signals are
 *  not silently defaulted, they resolve to `null` from
 *  `directionOfBetter` and are skipped (with a warning field) by the
 *  classifier that consumes this table. */
export const DIRECTION_OF_BETTER: Readonly<Record<string, DirectionOfBetter>> = Object.freeze({
  p99_latency: 'lower',
  ttft: 'lower',
  downstream_err: 'lower',
  hbm_spill: 'lower',
  refusal_rate: 'lower',
  mfu: 'higher',
  eval_score: 'higher',
  tool_success_rate: 'higher',
  collective_ops: 'higher',
  cost_req: 'informational',
  tokens_turn: 'informational',
  kv_cache: 'informational',
  corpus_delta: 'informational',
});

/** Signals excluded from direction-of-better classification entirely —
 *  not "informational", genuinely not a maturity signal. OQ-1:
 *  `traffic_pct` is a mechanism/weighting signal (fraction of traffic
 *  routed to a variant), not a health signal; it never participates in
 *  improvement/degradation classification. */
export const CLASSIFICATION_EXCLUDED_SIGNALS: readonly string[] = ['traffic_pct'];

/** Resolve a signal's direction-of-better, honoring an optional
 *  operator override map.
 *
 *  Overrides are permitted ONLY for signals whose base classification
 *  is 'informational' (per plan §B store-meta
 *  `informational_direction_overrides`) — e.g. an operator who has
 *  decided cost_req should count as 'higher is better' for their
 *  service. Attempting to override a signal that already has an
 *  inherent 'higher' | 'lower' direction — or a signal not in the
 *  table at all — throws, since silently flipping an established
 *  direction (or inventing one for an unknown signal) would corrupt
 *  classification (Task 3) without an explicit, auditable decision.
 *
 *  Returns `null` for signals absent from the table (including
 *  CLASSIFICATION_EXCLUDED_SIGNALS members, which are deliberately not
 *  present in DIRECTION_OF_BETTER) — callers treat `null` as "skip,
 *  unclassifiable". */
export function directionOfBetter(
  signal: string,
  overrides?: Record<string, 'higher' | 'lower'>,
): DirectionOfBetter | null {
  const base = Object.prototype.hasOwnProperty.call(DIRECTION_OF_BETTER, signal)
    ? DIRECTION_OF_BETTER[signal]
    : null;

  if (overrides && Object.prototype.hasOwnProperty.call(overrides, signal)) {
    if (base !== 'informational') {
      throw new Error(
        `direction override for '${signal}' is not permitted: overrides are only `
        + `allowed for 'informational' signals (base direction: ${base ?? 'unknown signal'})`,
      );
    }
    return overrides[signal];
  }

  return base;
}

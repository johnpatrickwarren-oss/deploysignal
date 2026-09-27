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
//
// Defect 2026-09-25: this table was the ONLY direction source — a profile's
// sli_list direction_of_better and δ_min were never read. A configured
// direction (CompiledConfig.sli_meta) is now read first; the table is the
// fallback for signals the profile does not declare.

import type { SliMeta } from '../types/_config-profiles';

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

/** Defect 2026-09-25: the profile's own direction for `signal` (CompiledConfig.sli_meta, from the
 *  profile's sli_list), or null. A configured direction is read BEFORE the table above, so a
 *  profile's non-LLM signals are classifiable and a profile may give an 'informational' table
 *  signal a direction. */
export function configuredDirection(signal: string, configured?: SliMeta): 'higher' | 'lower' | null {
  if (!configured || !Object.prototype.hasOwnProperty.call(configured, signal)) return null;
  return configured[signal].direction_of_better;
}

/** A disagreement between a store-level operator override and the profile's configured direction
 *  for the same signal. `applied` names the side that was used. Recorded on the classification
 *  result (and the CandidateRecord) instead of thrown. */
export interface DirectionConflict {
  signal: string;
  override: 'higher' | 'lower';
  configured: 'higher' | 'lower';
  applied: 'override' | 'configured';
}

/** Resolve a signal's direction-of-better from three sources: the store's operator override,
 *  the profile's configured direction (CompiledConfig.sli_meta), and the DIRECTION_OF_BETTER
 *  table.
 *
 *  Precedence (review finding on the 2026-09-25 fix, which threw whenever a profile configured a
 *  signal the store also overrode, e.g. cost_req in every shipped profile):
 *    1. An override on a signal the TABLE classes 'informational' wins, including over a
 *       configured direction. This is the documented store-meta mechanism
 *       (`informational_direction_overrides`) and an explicit per-service operator decision.
 *    2. An override on any other signal that the profile configures is ignored; the configured
 *       direction applies.
 *    3. An override on a signal that is neither table-informational nor configured throws, as
 *       before: silently flipping an established direction, or inventing one for an unknown
 *       signal, would corrupt classification without an auditable decision.
 *  In cases 1 and 2 a disagreement between override and configured direction is returned as
 *  `conflict`; agreement is not a conflict.
 *
 *  `direction` is `null` for signals neither configured nor in the table (including
 *  CLASSIFICATION_EXCLUDED_SIGNALS members) — callers treat `null` as "skip, unclassifiable". */
export function resolveDirection(
  signal: string,
  overrides?: Record<string, 'higher' | 'lower'>,
  configured?: SliMeta,
): { direction: DirectionOfBetter | null; conflict?: DirectionConflict } {
  const table = Object.prototype.hasOwnProperty.call(DIRECTION_OF_BETTER, signal) ? DIRECTION_OF_BETTER[signal] : null;
  const fromProfile = configuredDirection(signal, configured);

  if (overrides && Object.prototype.hasOwnProperty.call(overrides, signal)) {
    const override = overrides[signal];
    if (table === 'informational') {
      return fromProfile !== null && fromProfile !== override
        ? { direction: override, conflict: { signal, override, configured: fromProfile, applied: 'override' } }
        : { direction: override };
    }
    if (fromProfile !== null) {
      return fromProfile !== override
        ? { direction: fromProfile, conflict: { signal, override, configured: fromProfile, applied: 'configured' } }
        : { direction: fromProfile };
    }
    throw new Error(
      `direction override for '${signal}' is not permitted: overrides are only `
      + `allowed for 'informational' signals (base direction: ${table ?? 'unknown signal'})`,
    );
  }

  return { direction: fromProfile ?? table };
}

/** `resolveDirection` without the conflict record. */
export function directionOfBetter(
  signal: string,
  overrides?: Record<string, 'higher' | 'lower'>,
  configured?: SliMeta,
): DirectionOfBetter | null {
  return resolveDirection(signal, overrides, configured).direction;
}

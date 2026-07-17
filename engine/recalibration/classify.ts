// engine/recalibration/classify.ts — Addition #15 baseline-maintenance
// lifecycle. Direction classification: compares a candidate baseline's
// per-signal means against the active baseline's and produces a
// per-signal + aggregate improvement/degradation/mixed verdict.
//
// D6 (engine/tools split): pure, no fs, no I/O. Consumes plain
// Record<string, number> signal-mean maps — engine/recalibration/
// compare.ts (Task 4) is the module that extracts those maps from a
// CompiledConfig; this module doesn't know about CompiledConfig shape
// at all, keeping the classification math testable in isolation.
//
// Relative-delta transform mirrors baseline-drift-detector.ts's
// `relativeDeviationMean`: r = (cand - act) / act when |act| exceeds
// float precision, else the additive fallback (cand - act). Same
// rationale as the drift detector — a near-zero active mean makes the
// relative form numerically meaningless, so the module falls back to an
// absolute-delta comparison against the same epsilon.

import { directionOfBetter, CLASSIFICATION_EXCLUDED_SIGNALS } from './direction-metadata';
import type { DirectionClassification, PerSignalDirection } from '../types';
import { RECALIBRATION_REASON_CODES } from '../types';

/** OQ-3: default unchanged dead-band, in relative terms (1%).
 *  store-meta's `unchanged_epsilon_rel` (Task 6+) overrides this at the
 *  CLI layer; this module just takes `opts.epsilon` as the resolved
 *  value so it stays store-agnostic. */
export const DEFAULT_UNCHANGED_EPSILON = 0.01;

export interface ClassificationOptions {
  /** Relative-delta dead-band below which a signal is 'unchanged'.
   *  Defaults to DEFAULT_UNCHANGED_EPSILON (OQ-3). */
  epsilon?: number;
  /** Per-signal direction override, permitted only for signals whose
   *  base direction-of-better is 'informational' (see
   *  direction-metadata.ts's directionOfBetter contract — throws
   *  otherwise). Threaded straight through to directionOfBetter. */
  overrides?: Record<string, 'higher' | 'lower'>;
}

export interface ClassifyRecalibrationResult {
  direction_classification: DirectionClassification;
  per_signal_direction: Record<string, PerSignalDirection>;
  suggested_reason_codes: string[];
}

/** relativeDeviationMean, single-value form (baseline-drift-detector.ts
 *  §Math). Exported (not just used internally) so engine/recalibration/
 *  compare.ts (Task 4) reuses the identical transform for its
 *  per-signal delta report instead of re-deriving it — one relative-
 *  delta definition for the whole recalibration module, mirroring the
 *  drift detector's array-valued version. That module operates on
 *  ordered signal vectors under a covariance matrix; this single-value
 *  form operates on a named Record and has no covariance dependency.
 *  Mirrors the same |b| > 1e-12 threshold and additive fallback. */
export function relativeDelta(activeMean: number, candidateMean: number): number {
  return Math.abs(activeMean) > 1e-12
    ? (candidateMean - activeMean) / activeMean
    : (candidateMean - activeMean);
}

/** Per-signal verdict. Returns `null` when the signal is excluded
 *  (CLASSIFICATION_EXCLUDED_SIGNALS, e.g. traffic_pct) or unclassifiable
 *  (unknown to DIRECTION_OF_BETTER and no override applies) — callers
 *  omit `null` results from per_signal_direction rather than defaulting
 *  them (OQ-1/OQ-2).
 *
 *  Rules (plan §C Task 3):
 *    1. |relativeDelta| < epsilon -> 'unchanged'.
 *    2. Otherwise, an 'informational' direction (no override resolved
 *       it to higher/lower) degrades on ANY non-unchanged move — there
 *       is no inherent better/worse sense to credit an improvement to.
 *    3. Otherwise, sign of relativeDelta vs the resolved 'higher' |
 *       'lower' direction determines 'improved' | 'degraded'. */
export function classifySignal(
  signal: string,
  activeMean: number,
  candidateMean: number,
  opts: ClassificationOptions = {},
): PerSignalDirection | null {
  if ((CLASSIFICATION_EXCLUDED_SIGNALS as readonly string[]).includes(signal)) return null;

  const direction = directionOfBetter(signal, opts.overrides);
  if (direction === null) return null;

  const epsilon = opts.epsilon ?? DEFAULT_UNCHANGED_EPSILON;
  const deltaRel = relativeDelta(activeMean, candidateMean);
  if (Math.abs(deltaRel) < epsilon) return 'unchanged';

  if (direction === 'informational') return 'degraded';
  if (direction === 'higher') return deltaRel > 0 ? 'improved' : 'degraded';
  return deltaRel < 0 ? 'improved' : 'degraded';
}

/** Aggregate verdict across the (active, candidate) signal-mean
 *  intersection. Throws when that intersection is empty — a candidate
 *  and active baseline that share zero signal names cannot be compared
 *  at all, which is a caller-level error (mismatched configs), not a
 *  degenerate-but-legal classification result.
 *
 *  Aggregation rule (plan §C Task 3 / OQ-4): degraded signals present
 *  and no improved signals -> 'degradation'; improved signals present
 *  and no degraded signals -> 'improvement'; anything else (both
 *  present, all-unchanged, or every classifiable signal excluded) ->
 *  'mixed' — the conservative "needs operator review" verdict. */
export function classifyRecalibration(
  activeMeans: Record<string, number>,
  candidateMeans: Record<string, number>,
  opts: ClassificationOptions = {},
): ClassifyRecalibrationResult {
  const activeSignals = new Set(Object.keys(activeMeans));
  const intersection = Object.keys(candidateMeans).filter((s) => activeSignals.has(s));
  if (intersection.length === 0) {
    throw new Error(
      'classifyRecalibration: empty signal intersection between active and candidate baselines',
    );
  }

  const per_signal_direction: Record<string, PerSignalDirection> = {};
  for (const signal of intersection) {
    const verdict = classifySignal(signal, activeMeans[signal], candidateMeans[signal], opts);
    if (verdict === null) continue;
    per_signal_direction[signal] = verdict;
  }

  const verdicts = Object.values(per_signal_direction);
  const improvedCount = verdicts.filter((v) => v === 'improved').length;
  const degradedCount = verdicts.filter((v) => v === 'degraded').length;

  let direction_classification: DirectionClassification;
  if (improvedCount > 0 && degradedCount === 0) {
    direction_classification = 'improvement';
  } else if (degradedCount > 0 && improvedCount === 0) {
    direction_classification = 'degradation';
  } else {
    direction_classification = 'mixed';
  }

  const suggested_reason_codes = direction_classification === 'improvement'
    ? []
    : [...RECALIBRATION_REASON_CODES];

  return { direction_classification, per_signal_direction, suggested_reason_codes };
}

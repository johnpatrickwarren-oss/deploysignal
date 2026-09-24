// engine/g0/reversibility-classifier.ts — Addition #5 G0 classifier.
//
// Per NORTH-STAR-ARCHITECTURE.md Addition #5 and ARCHITECT-REPLY-32
// implementation brief. G0 blast-radius gate classifies a deploy's
// reversibility at deploy start (once per deploy, NOT per tick) by
// consulting the configured `ReversibilityAnnotationSource` and
// applying the default-fallback when no annotation is available.
//
// Architect-set rule (ARCHITECT-REPLY-32 Open Q2): default-fallback is
// `'forward_only'` — missing annotations must NOT auto-rollback.
// Operators opt into automated rollback by explicitly annotating
// `'reversible'`. Conservative default for gate purposes. TPM's
// alternatives (`'conditional'` default; null-stays-null) considered
// and rejected for operator toil / decision refusal respectively.

import type {
  Reversibility, ReversibilityAnnotationSource,
} from '../o0/reversibility-source';

export interface ReversibilityClassification {
  /** Concrete reversibility value post-classification — one of
   *  `reversible | forward_only | conditional`. Never null. */
  reversibility: Reversibility;
  /** Where the value came from: `'platform_annotation'` when the
   *  source returned a non-null value; `'default_fallback'` when the
   *  source returned null and the classifier applied the architect-set
   *  default. */
  reversibility_source: 'platform_annotation' | 'default_fallback';
}

/** Architect-set default per ARCHITECT-REPLY-32 Open Q2. */
export const DEFAULT_FALLBACK_REVERSIBILITY: Reversibility = 'forward_only';

/**
 * Classify a deploy's reversibility using the configured annotation
 * source. Synchronous — runway sources don't do I/O. Pure w.r.t. the
 * source: same input `deploy_id` against the same source returns the
 * same classification.
 *
 * Called once per deploy at deploy start. Result is threaded across
 * ticks via `OrchestrateParams.reversibilityClassification` so the
 * classifier doesn't re-run per tick.
 */
export function classifyReversibility(
  deploy_id: string,
  source: ReversibilityAnnotationSource,
): ReversibilityClassification {
  const annotation = source.getReversibility(deploy_id);
  if (annotation !== null) {
    return {
      reversibility: annotation,
      reversibility_source: 'platform_annotation',
    };
  }
  return {
    reversibility: DEFAULT_FALLBACK_REVERSIBILITY,
    reversibility_source: 'default_fallback',
  };
}

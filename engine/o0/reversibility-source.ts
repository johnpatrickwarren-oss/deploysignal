// engine/o0/reversibility-source.ts — Addition #5 annotation-source adapters.
//
// Per NORTH-STAR-ARCHITECTURE.md Addition #5 and ARCHITECT-REPLY-32
// implementation brief. A `ReversibilityAnnotationSource` exposes one
// method — `getReversibility(deployId)` — returning the platform-
// annotated reversibility for a deploy, or `null` when no annotation
// is available (triggers the classifier's default-fallback path).
//
// Runway ships three implementations:
//   NoReversibilitySource       — default; always returns null.
//                                 Missing annotations become
//                                 default-fallback = 'forward_only' at
//                                 the classifier level (conservative;
//                                 missing annotations must NOT
//                                 auto-rollback per architect choice).
//   InlineReversibilitySource   — test fixture; pins a specific value
//                                 (or null) for any deploy_id.
//   ScenarioReversibilitySource — runway synthetic; reads from a
//                                 `Record<deploy_id, Reversibility>`
//                                 typically sourced from scenario JSON.
//
// Real-orchestrator sources (Argo Rollouts resource annotation reader,
// Spinnaker pipeline parameter reader, MLflow tag reader) are for follow-on
// per brief anti-scope. The interface is intentionally synchronous —
// runway sources don't do I/O, and the orchestrator evaluates
// synchronously; async sources can be wrapped with internal caching +
// a sync getter when real adapters land.

/** Concrete reversibility values. Post-classification output is always
 *  one of these three — the classifier's default-fallback resolves
 *  missing annotations to `'forward_only'`. */
export type Reversibility = 'reversible' | 'forward_only' | 'conditional';

export interface ReversibilityAnnotationSource {
  /**
   * Return the platform-annotated reversibility for a deploy, or `null`
   * when no annotation is available. The classifier converts `null` to
   * the default-fallback value (`'forward_only'`).
   */
  getReversibility(deploy_id: string): Reversibility | null;
}

/** Default source. Every deploy receives `null` → default-fallback
 *  applies at the classifier. Orchestrator uses this when the caller
 *  doesn't thread a real source through — guarantees backward compat
 *  with pre-#5 callers and frees new callers from boilerplate. */
export class NoReversibilitySource implements ReversibilityAnnotationSource {
  getReversibility(_deploy_id: string): Reversibility | null {
    return null;
  }
}

/** Test fixture. Pins a specific value (or explicit `null`) for every
 *  deploy_id. Useful for unit tests that want deterministic annotation
 *  behavior without constructing a Record. */
export class InlineReversibilitySource implements ReversibilityAnnotationSource {
  constructor(private readonly value: Reversibility | null) {}

  getReversibility(_deploy_id: string): Reversibility | null {
    return this.value;
  }
}

/** Runway synthetic source. Reads from a keyed Record, typically
 *  populated from a scenario JSON file at test setup. Unknown deploy
 *  IDs fall through to `null` → default-fallback applies. */
export class ScenarioReversibilitySource implements ReversibilityAnnotationSource {
  constructor(private readonly annotations: Record<string, Reversibility>) {}

  getReversibility(deploy_id: string): Reversibility | null {
    return this.annotations[deploy_id] ?? null;
  }
}

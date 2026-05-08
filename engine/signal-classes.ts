// engine/signal-classes.ts — Q2.A signal-class taxonomy + transforms.
//
// Per ARCHITECT Q2-A-SIGNAL-CLASS-REGISTRY-SPEC. Closes the bounded-
// probability calibration gap surfaced at REPLY-52ge V1.H1
// (`tool_success_rate` σ² underflow on saturated samples) plus the
// asymmetric-H₀ clipping-bias mechanism predicted in REPLY-52gd, by
// applying a class-appropriate variance-stabilizing transform at both
// compile time (calibration) and runtime (detector dispatch).
//
// Architecturally clean replacement for P1's compile-time variance
// floor; P1 stays as belt-and-suspenders defense-in-depth.
//
// Independent of Q2.B.4 (calibration coherence; Mac Claude 1 lane).
// Field-level coordination via `FamilyAPerSignalParams.baseline_mean_raw`
// confirmed in spec.

/** Four-class taxonomy covering DeploySignal's six Family A signals
 *  + extensible to future signals. Each class implies a forward
 *  transform applied symmetrically at compile time (to baseline
 *  samples) and at runtime (to live observations) before standard
 *  z-score derivation.
 *
 *  - `gaussian_like`        — identity transform; standard betting
 *    pipeline. Latency-style signals. Default for unclassified
 *    signals.
 *  - `bounded_probability`  — logit transform; rate-style signals
 *    in [0, 1] that saturate at boundary. Logit maps (0, 1) →
 *    (−∞, +∞); resulting σ² is well-conditioned in logit-space.
 *  - `heavy_tail`           — log transform; multiplicative-process
 *    values (cost, tokens). Log compresses the tail; resulting
 *    distribution is approximately Gaussian for typical multiplicative
 *    data.
 *  - `counts`               — Anscombe stabilizer 2·√(x + 3/8); maps
 *    Poisson(λ) → ≈ N(2√λ, 1) for moderate λ. Future signals like
 *    `error_count`. */
export type SignalClass =
  | 'gaussian_like'
  | 'bounded_probability'
  | 'heavy_tail'
  | 'counts';

// ── Transform constants ──────────────────────────────────────────────

/** Logit-transform boundary clip. Chosen to keep
 *  `log(eps / (1 − eps)) ≈ −20.7` (well within float64 range; not
 *  catastrophic FP loss). Spec open-Q 3 — tunable post-empirical-test;
 *  architect-default 1e-9 with regression tests. */
export const LOGIT_BOUNDARY_EPS = 1e-9;

/** Log-transform floor. Avoids `log(0)` on signals that may legitimately
 *  hit zero (rare cost samples, idle-period tokens). */
export const LOG_FLOOR_EPS = 1e-9;

/** Anscombe constant — Snedecor & Cochran 1967. `2·√(x + 3/8)` maps
 *  Poisson(λ) → ≈ N(2√λ, 1) for moderate λ. Spec open-Q 4 — chosen
 *  Anscombe over Freeman-Tukey per established usage. */
const ANSCOMBE_CONSTANT = 3 / 8;

// ── Forward transforms (per-class) ──────────────────────────────────

/** Logit transform: x ∈ (0, 1) → (−∞, +∞).
 *  Boundary clipping prevents `log(0)` / `log(∞)` at saturation;
 *  inverse-operation (sigmoid) produces back-mapped value within
 *  [eps, 1 − eps]. */
export function logitTransform(x: number): number {
  const xClipped = Math.max(
    LOGIT_BOUNDARY_EPS,
    Math.min(1 - LOGIT_BOUNDARY_EPS, x),
  );
  return Math.log(xClipped / (1 - xClipped));
}

/** Log transform: x ∈ [0, +∞) → (−∞, +∞).
 *  Floor clipping handles legitimate zeros without producing −∞. */
export function logTransform(x: number): number {
  return Math.log(Math.max(LOG_FLOOR_EPS, x));
}

/** Anscombe variance-stabilizing transform for Poisson-like counts.
 *  `f(x) = 2 · √(max(0, x) + 3/8)` — handles x = 0 explicitly via the
 *  `max(0, …)` guard so negative inputs (which shouldn't occur on a
 *  count signal but defensively might via FP rounding) don't produce
 *  NaN. */
export function anscombeTransform(x: number): number {
  return 2 * Math.sqrt(Math.max(0, x) + ANSCOMBE_CONSTANT);
}

/** Class-appropriate forward transform dispatcher. Single function
 *  call; O(1) per tick per signal at runtime; runtime cost negligible.
 *  Unknown / non-enumerated class falls back to identity transform —
 *  defensive default for forward-compat with future class additions
 *  loaded from a CompiledConfig that this code revision didn't ship. */
export function transformForClass(x: number, cls: SignalClass): number {
  switch (cls) {
    case 'gaussian_like':
      return x;
    case 'bounded_probability':
      return logitTransform(x);
    case 'heavy_tail':
      return logTransform(x);
    case 'counts':
      return anscombeTransform(x);
  }
}

// ── Default class assignment for DeploySignal's standard signal set ──

/** Default signal-class assignment per spec table. Operators can
 *  override per-deploy via `CompiledConfig.signal_classes`; absence
 *  = lookup in this map; absence in this map = `'gaussian_like'`. */
export const DEFAULT_SIGNAL_CLASSES: Record<string, SignalClass> = {
  // Gaussian-like (latencies; standard Gaussian-H₀ assumption holds)
  p99_latency:           'gaussian_like',
  ttft:                  'gaussian_like',

  // Bounded-probability (rates ∈ [0, 1]; saturate at boundary)
  tool_success_rate:     'bounded_probability',
  eval_score:            'bounded_probability',
  downstream_err:        'bounded_probability',

  // Heavy-tail (multiplicative-process values)
  cost_req:              'heavy_tail',
  tokens_turn:           'heavy_tail',
};

/** Resolve the class for a given signal: caller-supplied override map
 *  → DEFAULT_SIGNAL_CLASSES → 'gaussian_like'. Centralizes the
 *  three-tier lookup so calibrator and runtime dispatcher share
 *  byte-identical resolution. */
export function resolveSignalClass(
  signal: string,
  overrides?: Record<string, SignalClass>,
): SignalClass {
  return overrides?.[signal] ?? DEFAULT_SIGNAL_CLASSES[signal] ?? 'gaussian_like';
}

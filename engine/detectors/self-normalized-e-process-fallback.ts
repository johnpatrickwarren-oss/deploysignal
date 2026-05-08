// engine/detectors/self-normalized-e-process-fallback.ts —
// Q70 Phase-3.d.E §7 EmpiricalProcessLILBound + §6 BetaBinomialMixture
// self-normalized e-process variant fallback.
//
// Per Q70-PHASE-3-D-E-CALIBRATION-REGIME-ARCHITECTURE-SPEC.md § Q70.2.
// Architectural rationale: when conditional exemption (Q70.1) exempts
// >X% of test coverage for a detector × substrate × sweep_mode triple,
// exemption-based approach defeats the test purpose. Self-normalized
// e-process variant handles correlated observations natively without
// requiring matching calibration-time phi.
//
// §7 EmpiricalProcessLILBound is PRIMARY (canonical-library
// `uniform_boundaries.h:250-269` + `:513-556`). Closed-form at runtime;
// O(1) per call post-construction.
// §6 BetaBinomialMixture is SECONDARY (canonical-library `:285-323` +
// `:580-660`). Runtime bisection via find_mixture_bound; sub-Bernoulli
// specific (bounded [0,1] random variables); narrower applicability —
// activated only for family_E_conformal on bounded_probability signals
// per architect-pick at Q70.4 ASK B.
//
// SLICE 1 scope (this file):
//   - SelfNormalizedEProcessFallback discriminated union per spec line 122.
//   - §7 LIL closed-form runtime evaluation (well-defined; library-faithful
//     `A * sqrt((log(1 + log(t / t_min)) + C) / t)` per spec line 99-104).
//   - C calibration constant carried as a parameter (computed offline via
//     library reference impl; library cross-check at spec § Library
//     cross-check status item 2 confirms `uniform_boundaries.h` is the
//     authoritative source for the bisection-derived C calibration).
//   - §6 BetaBinomial structure stubbed; runtime bisection helpers
//     deferred to SLICE 2 (architectural complexity per spec LS-2;
//     library reference impl `find_mixture_bound` requires full
//     bracket-and-solve dispatch surface).
//
// SLICE 2 scope (follow-on, post-empirical-sweep validation):
//   - C bisection-and-solve at construction time (mirrors library bisection
//     + brent + bracket-and-solve dispatch).
//   - §6 BetaBinomial `find_mixture_bound` runtime bisection (mirrors
//     library structural fork at `:389-406` skipping `find_s_upper_bound`
//     doubling search per Q70.4 ASK C).
//   - Asymmetric p-locked prior (Q70.4 ASK B) for family_E_conformal
//     bounded_probability signals; biased clamped r_ estimator (Q70.4
//     ASK D).
//
// Anti-scope at Q70 SLICE 1:
//   - NO callers wired this slice — module is library-grade primitive
//     consumed by detectors in SLICE 2.
//   - NO calibration-time stamping wired this slice (tools/calibrators/*
//     extension is SLICE 2).

import type {
  LilBoundHyperparams,
  BetaBinomialMixtureHyperparams,
  SelfNormalizedEProcessFallback,
} from '../types/self-normalized-fallback';

export type {
  LilBoundHyperparams,
  BetaBinomialMixtureHyperparams,
  SelfNormalizedEProcessFallback,
};

// ── §7 EmpiricalProcessLILBound runtime evaluation ───────────────

const ONE_OVER_SQRT_2 = 1 / Math.SQRT2;

/** Validate §7 LIL hyperparameters per library asserts. Throws on invariant
 *  violation; callers (calibrators in SLICE 2) should guarantee validity at
 *  compile time. */
export function assertLilBoundHyperparams(p: LilBoundHyperparams): void {
  if (!(p.alpha > 0 && p.alpha < 1)) {
    throw new RangeError(`LIL alpha must be in (0, 1); got ${p.alpha}`);
  }
  if (!(p.t_min >= 1)) {
    throw new RangeError(`LIL t_min must be >= 1; got ${p.t_min}`);
  }
  if (!(p.A > ONE_OVER_SQRT_2)) {
    throw new RangeError(`LIL A must be > 1/sqrt(2) ≈ 0.7071; got ${p.A}`);
  }
  if (!Number.isFinite(p.C)) {
    throw new RangeError(`LIL C must be finite; got ${p.C}`);
  }
}

/** §7 EmpiricalProcessLILBound evaluation at intrinsic time `t`.
 *
 *  Closed-form (library reference impl `uniform_boundaries.h` operator()):
 *    bound(t) = A * sqrt( (log(1 + log(t / t_min)) + C) / t )
 *
 *  Asserts t >= t_min. Returns the upper-confidence boundary value
 *  (one-sided per Q70.4 ASK A architect-pick). The empirical process
 *  S_t / sqrt(V_t) crosses the bound under H₁; healthy operation stays
 *  below uniformly with crossing probability <= alpha.
 *
 *  O(1) per call post-construction.
 */
export function evaluateLilBound(p: LilBoundHyperparams, t: number): number {
  if (!(t >= p.t_min)) {
    throw new RangeError(`LIL bound: t (${t}) must be >= t_min (${p.t_min})`);
  }
  const logTerm = Math.log(1 + Math.log(t / p.t_min));
  return p.A * Math.sqrt((logTerm + p.C) / t);
}

// ── §6 BetaBinomialMixture runtime evaluation (SLICE 2 stub) ────

/** Marker for §6 features that are SLICE 1 stubbed. Throws with a
 *  clear pointer so accidental wire-ups surface immediately during
 *  development. */
function notImplementedSlice1(feature: string): never {
  throw new Error(
    `[Q70 SLICE 1] §6 BetaBinomialMixture ${feature} not implemented; ` +
    `requires library reference impl bisection helpers (find_mixture_bound + ` +
    `bracket-and-solve dispatch). Tracking: Q70 SLICE 2 follow-on per spec ` +
    `LS-2 (Mac-Claude-implementation-time-gap-hunting).`,
  );
}

/** Validate §6 BetaBinomial hyperparameters per library asserts.
 *  Architect-picks at Q70.4: asymmetric p-locked g/h; biased clamped r_;
 *  finite s_upper_bound = v / g (skips `find_s_upper_bound` doubling
 *  search per library `:389-406`). */
export function assertBetaBinomialHyperparams(p: BetaBinomialMixtureHyperparams): void {
  if (!(p.alpha > 0 && p.alpha < 1)) {
    throw new RangeError(`BetaBinomial alpha must be in (0, 1); got ${p.alpha}`);
  }
  if (!(p.v_opt > 0)) {
    throw new RangeError(`BetaBinomial v_opt must be > 0; got ${p.v_opt}`);
  }
  if (!(p.alpha_opt > 0 && p.alpha_opt < 1)) {
    throw new RangeError(
      `BetaBinomial alpha_opt must be in (0, 1); got ${p.alpha_opt}`,
    );
  }
  if (!(p.g > 0 && p.h > 0)) {
    throw new RangeError(
      `BetaBinomial g/h must be positive (asymmetric p-locked: g = baseline_mean, h = 1 - baseline_mean); got g=${p.g}, h=${p.h}`,
    );
  }
}

/** §6 BetaBinomialMixture bound evaluation. SLICE 1: throws notImplemented;
 *  SLICE 2 will mirror library `find_mixture_bound` runtime bisection
 *  semantics with the structural fork at `:389-406` (finite
 *  `s_upper_bound = v / g_` per Q70.4 ASK C; skips
 *  `find_s_upper_bound` doubling search). */
export function evaluateBetaBinomialBound(
  _p: BetaBinomialMixtureHyperparams,
  _v: number,
): number {
  return notImplementedSlice1('evaluateBetaBinomialBound');
}

// ── Variant dispatch ───────────────────────────────────────────────

/** Dispatch self-normalized fallback evaluation to the appropriate
 *  variant. `t` for §7 LIL is the tick count; `v` for §6 BetaBinomial
 *  is the intrinsic time (sufficient statistic). Architect's
 *  recommendation per spec § Q70.2 architectural rationale: §7 LIL
 *  primary for cross-detector universality; §6 BetaBinomial secondary
 *  for family_E_conformal on bounded_probability signals only. */
export function evaluateSelfNormalizedBound(
  p: SelfNormalizedEProcessFallback,
  t: number,
): number {
  if (p.variant === 'lil_bound') return evaluateLilBound(p, t);
  return evaluateBetaBinomialBound(p, t);
}

/** Variant-agnostic validation. Useful at calibrator-stamping time
 *  (SLICE 2) before the compiled config is shipped. */
export function assertSelfNormalizedHyperparams(
  p: SelfNormalizedEProcessFallback,
): void {
  if (p.variant === 'lil_bound') return assertLilBoundHyperparams(p);
  return assertBetaBinomialHyperparams(p);
}

// ── Architect-default constants (Q70.4) ───────────────────────────

/** Library canonical default for §7 LIL A constant.
 *  Library `uniform_boundaries.h:250-269` default; see also the
 *  architectural rationale at Howard-Ramdas-2021 §7. */
export const LIL_A_DEFAULT = 0.85;

/** Library canonical default for §7 LIL t_min. */
export const LIL_T_MIN_DEFAULT = 1;

/** Library canonical default for §6 BetaBinomial alpha_opt. */
export const BETA_BINOMIAL_ALPHA_OPT_DEFAULT = 0.05;

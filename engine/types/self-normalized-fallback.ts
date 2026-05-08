// engine/types/self-normalized-fallback.ts —
// Q70 Phase-3.d.E §7 EmpiricalProcessLILBound + §6 BetaBinomialMixture
// hyperparameter type definitions.
//
// Architectural placement note: types live in engine/types/* (cross-
// cutting); runtime evaluators live in
// engine/detectors/self-normalized-e-process-fallback.ts. Family-specific
// per-cell / per-signal config schemas (engine/types/families/*) reference
// `SelfNormalizedEProcessFallback` as an additive optional field per
// sub-rule 2 MERGE pattern.
//
// Per Q70-PHASE-3-D-E-CALIBRATION-REGIME-ARCHITECTURE-SPEC.md § Q70.2 +
// Q70.4 architectural ASK A-D picks (one-sided default; asymmetric
// p-locked prior for §6 BetaBinomial; finite s_upper_bound = v / g;
// biased clamped r_).

/** §7 EmpiricalProcessLILBound hyperparameters (Howard-Ramdas-2021 §7
 *  + companion quantile paper double-stitching). Per architect-pick
 *  at Q70.4: one-sided default; A=0.85 canonical library default. */
export interface LilBoundHyperparams {
  variant: 'lil_bound';
  /** Crossing probability (Type-I error budget). Library asserts > 0. */
  alpha: number;
  /** Minimum tick at which the bound is valid. Library default 1;
   *  asserts t_min >= 1. */
  t_min: number;
  /** Canonical A constant. Library default 0.85; asserts A > 1/sqrt(2)
   *  for the LIL bound's leading-coefficient validity. */
  A: number;
  /** Calibration constant solved numerically at construction time via
   *  bisection-and-solve such that
   *    Pr( sup_t S_t / phi(t) > 1 ) <= alpha
   *  under the empirical-process double-stitching scheme. SLICE 1 carries
   *  this as a precomputed parameter (offline via library reference
   *  impl); SLICE 2 will solve at construction time. */
  C: number;
}

/** §6 BetaBinomialMixture hyperparameters (Howard-Ramdas-2021 §6
 *  Propositions 6 & 7; sub-Bernoulli BetaBinomial). Per architect-pick
 *  at Q70.4: one-sided default; asymmetric p-locked prior; finite
 *  s_upper_bound = v / g; biased clamped r_ estimator. */
export interface BetaBinomialMixtureHyperparams {
  variant: 'beta_binomial_mixture';
  /** Crossing probability. */
  alpha: number;
  /** Target intrinsic time. */
  v_opt: number;
  /** Crossing probability target at v_opt. Library default 0.05. */
  alpha_opt: number;
  /** Lower-tail range (asymmetric p-locked: g = baseline_mean post-
   *  logit-inverse for bounded_probability signals per Q2.A transform). */
  g: number;
  /** Upper-tail range (asymmetric p-locked: h = 1 - baseline_mean
   *  post-logit-inverse for bounded_probability signals). */
  h: number;
  /** One-sided default; library canonical. Q70.4 ASK A architect-pick. */
  is_one_sided: boolean;
}

/** Discriminated union over §7 LIL (primary) + §6 BetaBinomial
 *  (secondary; family_E_conformal bounded_probability signals only). */
export type SelfNormalizedEProcessFallback =
  | LilBoundHyperparams
  | BetaBinomialMixtureHyperparams;

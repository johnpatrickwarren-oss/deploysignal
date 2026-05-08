// engine/detectors/family-a-mixture-supermartingale.ts — Q66 Phase-3.d.A
// Page-CUSUM Ville-bounded variant.
//
// Per Q66-PHASE-3-D-A-PAGE-CUSUM-MIXTURE-SUPERMARTINGALE-SPEC.md § Q66.2.
// Implements Howard-Ramdas-McAuliffe-Sekhon-2021 mixture-supermartingale
// (*Time-uniform, Nonparametric, Nonasymptotic Confidence Sequences*;
// Annals of Statistics 2021; arXiv:1810.08240) variant for Page-CUSUM.
// Anytime-valid Ville-bounded by construction:
//
//   M_t = ∫ exp(δ · S_t - ψ_X(δ) · t) dπ(δ)
//
// where S_t = Σ (x_s - baseline_mean) is the partial centered sum and
// ψ_X is the cumulant generating function of X under H₀. By Ville's
// inequality, P(sup_t M_t ≥ 1/α) ≤ α uniformly in time. Detector fires
// at first tick t where M_t ≥ 1/α; FPR ≤ α uniformly.
//
// Critical architectural property: anytime-valid Ville bound holds under
// EXCHANGEABLE H₀ — does NOT require iid or correlated-vs-iid resampler
// discipline; works UNIFORMLY under iid_bootstrap + parametric_gaussian +
// parametric_ar1 modes. This sidesteps Q58 close-with-CAVEAT inheritance
// + Q59 H4 PERMANENT methodology-resampler-mode mismatch entirely.
//
// Sub-rule 3 INVERTED at Phase D (per spec § Anti-scope): Q58 clause 1
// (NO Page-CUSUM validation methodology re-engineering) + Q59 clause 2
// (NO Page-CUSUM Ville-bounded re-engineering) EXPLICITLY RETIRE at
// Phase-3.d.A close — Phase D's purpose is exactly that re-engineering.

import type { FamilyAPerSignalParams } from '../types/families/a';

/** Per-(signal) mixture-supermartingale state. Persists across ticks
 *  within a window; reset at window boundary. Sticky firing latch
 *  preserves Ville-bound semantic (once threshold crossed, detector
 *  remains in fired state). */
export interface MixtureSupermartingaleState {
  /** Running sum of pre-whitened centered observations:
   *    S_t = Σ (x_s_centered − phi · x_{s-1}_centered)
   *  When phi=0 (Slice 1 behavior; pre-Phase-3.d.A.b configs), S_t
   *  reduces to Σ x_s_centered identically. */
  S_t: number;
  /** Current mixture-supermartingale value M_t. */
  M_t: number;
  /** Sticky firing latch — set true at first tick t where M_t ≥ 1/α;
   *  remains true until window boundary state reset. */
  fired: boolean;
  /** Tick index of first fire (null until threshold crossed). */
  tick_at_first_fire: number | null;
  /** Sample count this signal this window. Mirrors classical CUSUM `n`
   *  for diagnostic + bake-profile parity; not gating. */
  n: number;
  /** Q66 Phase-3.d.A.b — last centered observation for AR(1) pre-
   *  whitening. Persists across ticks within window; reset to 0 at
   *  window boundary state reset (initialized to 0 by
   *  freshMixtureSupermartingaleState). When ar1_phi=0 (default), this
   *  field is unused and pre-whitening reduces to identity. */
  last_x_centered: number;
}

export function freshMixtureSupermartingaleState(): MixtureSupermartingaleState {
  return { S_t: 0, M_t: 1, fired: false, tick_at_first_fire: null, n: 0, last_x_centered: 0 };
}

export type MixtureSupermartingaleStates = Record<string, MixtureSupermartingaleState>;

export function getOrCreateMixtureSupermartingaleState(
  states: MixtureSupermartingaleStates, signal: string,
): MixtureSupermartingaleState {
  const s = states[signal];
  if (s) return s;
  const fresh = freshMixtureSupermartingaleState();
  states[signal] = fresh;
  return fresh;
}

/** Howard-Ramdas-2021 §4.2 stitched-Gaussian mixture closed-form M_t.
 *
 *  For a sub-Gaussian process with per-tick variance σ² and mixture prior
 *  N(0, σ²_prior), the supermartingale evaluates to:
 *
 *    M_t = sqrt(σ²_prior / (σ²·t + σ²_prior))
 *        · exp(S_t² / (2 · (σ²·t + σ²_prior)))
 *
 *  Stable computation via log-space:
 *    log_M_t = (S_t² / (2 · denom)) + 0.5 · log(σ²_prior / denom)
 *    where denom = σ²·t + σ²_prior.
 *
 *  M_t starts at 1.0 at t=0 (S_0=0, denom=σ²_prior, log_M_0 = 0). */
export function computeGaussianMixtureSupermartingale(
  S_t: number, t: number, sigma_squared: number, sigma_squared_prior: number,
): number {
  if (sigma_squared_prior <= 0) {
    throw new Error(`Gaussian mixture σ²_prior must be > 0; got ${sigma_squared_prior}`);
  }
  if (sigma_squared < 0) {
    throw new Error(`Per-tick σ² must be ≥ 0; got ${sigma_squared}`);
  }
  const denom = sigma_squared * t + sigma_squared_prior;
  if (denom <= 0) {
    // Degenerate: σ² = 0 and t = 0; treat as no-evidence (M_0 = 1).
    return 1.0;
  }
  const log_M_t = (S_t * S_t) / (2 * denom)
                + 0.5 * Math.log(sigma_squared_prior / denom);
  // Numerical guard — clamp log_M to avoid Math.exp overflow returning Infinity
  // when test scenarios push M_t past Ville threshold by huge margin. Cap at
  // 10× threshold log scale for typical α=1e-3..1e-5 → ln(1/α) ≈ 7..12 → cap ~120.
  const log_M_capped = Math.min(log_M_t, 120);
  return Math.exp(log_M_capped);
}

/** Log-Gamma via Stirling+Lanczos approximation. Accurate to ~1e-10 for
 *  positive real arguments; sufficient for Beta mixture supermartingale
 *  closed-form which evaluates Γ(α) · Γ(β) / Γ(α+β) ratios. */
function logGamma(x: number): number {
  // Lanczos approximation with g=7, n=9 coefficients (Numerical Recipes 6.1).
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula: Γ(x) · Γ(1-x) = π / sin(πx).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Howard-Ramdas-2021 §5 Beta mixture supermartingale closed-form.
 *
 *  For a [0,1]-bounded process (Bernoulli or bounded random variables
 *  post-logit-transform inverse) with Beta(α_prior, β_prior) prior on
 *  the post-change mean, the mixture supermartingale at tick t with
 *  cumulative success count k = (S_t + t·baseline_p) (where baseline_p
 *  is the H₀ mean) evaluates to:
 *
 *    M_t = B(α_prior + k, β_prior + t - k) / B(α_prior, β_prior)
 *        · baseline_p^(-k) · (1 - baseline_p)^(-(t-k))
 *
 *  where B(·,·) is the Beta function = Γ(·)·Γ(·)/Γ(·+·).
 *
 *  In our application, the input is `S_t` (centered: live observation
 *  minus baseline_mean accumulated across t). For [0,1]-bounded signals
 *  baseline_p = baseline_mean (in raw probability space). We reconstruct
 *  k = S_t + t · baseline_mean and clamp to [0, t] to handle finite-
 *  sample variance.
 *
 *  Stable computation in log space throughout:
 *    log B(a, b) = logGamma(a) + logGamma(b) - logGamma(a+b)
 *    log M_t = [logB(α'+k, β'+t-k) - logB(α', β')] - [k·log(p) + (t-k)·log(1-p)]
 *
 *  where (α', β') = (α_prior, β_prior). */
export function computeBetaMixtureSupermartingale(
  S_t: number, t: number,
  baseline_mean_p: number,
  alpha_prior: number, beta_prior: number,
): number {
  if (alpha_prior <= 0 || beta_prior <= 0) {
    throw new Error(`Beta mixture priors must be > 0; got α=${alpha_prior}, β=${beta_prior}`);
  }
  if (t === 0) return 1.0;
  if (baseline_mean_p <= 0 || baseline_mean_p >= 1) {
    // Degenerate baseline; mixture undefined. Return 1 (no evidence).
    return 1.0;
  }
  // Reconstruct cumulative success count k from S_t.
  let k = S_t + t * baseline_mean_p;
  // Clamp to [ε, t-ε] to avoid log(0) at boundaries.
  const eps = 1e-9;
  k = Math.max(eps, Math.min(t - eps, k));
  const log_post = logGamma(alpha_prior + k) + logGamma(beta_prior + t - k)
                 - logGamma(alpha_prior + beta_prior + t);
  const log_prior = logGamma(alpha_prior) + logGamma(beta_prior)
                  - logGamma(alpha_prior + beta_prior);
  const log_h0 = k * Math.log(baseline_mean_p) + (t - k) * Math.log(1 - baseline_mean_p);
  const log_M_t = (log_post - log_prior) - log_h0;
  const log_M_capped = Math.min(log_M_t, 120);
  return Math.exp(log_M_capped);
}

export interface PageCusumMixtureSupermartingaleInput {
  signal: string;
  /** Centered observation: x = live_value - baseline_mean. */
  x_centered: number;
  /** Live raw value (used for Beta mixture k reconstruction; ignored for
   *  Gaussian mixture). For Beta mixture, x_centered + baseline_mean
   *  must lie in [0,1] for the supermartingale to be well-defined. */
  live_value: number;
  /** Baseline mean (raw observation space; matches Page-CUSUM's
   *  cellMeanRaw consumption per Q2.B.5). */
  baseline_mean: number;
  /** Per-tick variance σ² under H₀. Sub-Gaussian variance proxy for
   *  Gaussian mixture; ignored for Beta mixture. */
  sigma_squared: number;
  /** Mixture-supermartingale parameters from compile-time calibration
   *  (per Q66.1 derivation). */
  params: NonNullable<FamilyAPerSignalParams['mixture_supermartingale_params']>;
  /** Q66 Phase-3.d.A.b — per-signal AR(1) phi from compile-time
   *  Yule-Walker calibration. Applied at runtime as pre-whitening:
   *    x_pre_whitened = x_centered − phi · state.last_x_centered
   *  Pre-whitened residual is approximately IID sub-Gaussian → Howard-
   *  Ramdas-2021 §4.2 closed-form applies unchanged.
   *
   *  Optional; absence (phi=0) reduces to Slice 1 behavior (no pre-
   *  whitening; identity transformation). Pre-Phase-3.d.A.b configs
   *  + iid_bootstrap mode pass undefined; .A.b configs pass
   *  cal.ar1_phi from compile output. */
  ar1_phi?: number;
  /** State persists across ticks within window. Mutated in place. */
  state: MixtureSupermartingaleState;
  /** α-budget per detector — Ville-bound threshold = 1/α. */
  alpha: number;
}

export interface PageCusumMixtureSupermartingaleResult {
  fire: boolean;
  M_t: number;
  threshold: number;
  /** Two-sided detection: TRUE if Ville-bound exceeded for either positive
   *  drift (S_t > 0) OR negative drift (S_t < 0) under symmetric Gaussian
   *  mixture. Per architect spec § Q66.4 ASK D disposition: two-sided
   *  detection is the natural form for symmetric-Gaussian-prior mixture-
   *  supermartingale; classical Page-CUSUM was one-sided (reset-at-zero
   *  truncates negative drift); Phase D variant flips to two-sided. */
  two_sided: boolean;
}

/** Q66 Phase-3.d.A — Howard-Ramdas-2021 mixture-supermartingale Page-CUSUM
 *  variant. Anytime-valid Ville-bounded; methodology-resampler-mode
 *  INVARIANT. */
export function evaluatePageCusumMixtureSupermartingale(
  input: PageCusumMixtureSupermartingaleInput,
): PageCusumMixtureSupermartingaleResult {
  const { x_centered, live_value, baseline_mean, sigma_squared, params, state, alpha } = input;

  // Q66 Phase-3.d.A.b — AR(1) pre-whitening per architect H1' disposition.
  // Apply x_pre_whitened = x_centered − phi · state.last_x_centered
  // BEFORE partial-sum update. State.last_x_centered carries previous
  // centered observation across ticks within window; reset to 0 at
  // freshMixtureSupermartingaleState (window boundary). When phi=0
  // (Slice 1 default; pre-Phase-3.d.A.b configs + iid_bootstrap mode),
  // pre-whitening reduces to identity (x_pre_whitened === x_centered).
  const phi = input.ar1_phi ?? 0;
  const x_pre_whitened = x_centered - phi * state.last_x_centered;
  // Persist current centered observation for next tick's pre-whitening
  // step. CRITICAL: store BEFORE pre-whitening (raw centered value) so
  // next tick's prediction subtracts phi · x_t (current), not phi ·
  // x_t_pre_whitened (which would compound the AR(1) correction).
  state.last_x_centered = x_centered;

  // Update partial sum on PRE-WHITENED observation (running; NOT
  // reset-at-zero like classical CUSUM). When phi=0, S_t reduces to
  // Σ x_centered identically (Slice 1 byte-identical).
  state.S_t += x_pre_whitened;
  state.n += 1;
  const t = state.n;

  let M_t: number;
  if (params.mixture_distribution === 'gaussian') {
    if (params.gaussian_sigma_squared_prior === undefined) {
      throw new Error(
        `mixture_supermartingale_params.gaussian_sigma_squared_prior missing for ${input.signal}; `
        + 'Q66.1 hyperparameter derivation incomplete at compile time',
      );
    }
    // Two-sided: M_t computed for both positive (S_t) and negative (-S_t)
    // drift under symmetric Gaussian prior; aggregate is max (architect
    // ASK D disposition; symmetric mixture detects either direction).
    // Closed-form is symmetric in S_t² so |S_t| treatment is identical;
    // single computation suffices for two-sided semantic.
    M_t = computeGaussianMixtureSupermartingale(
      state.S_t, t, sigma_squared, params.gaussian_sigma_squared_prior,
    );
  } else if (params.mixture_distribution === 'beta') {
    if (params.beta_alpha_prior === undefined || params.beta_beta_prior === undefined) {
      throw new Error(
        `mixture_supermartingale_params.beta_alpha/beta_prior missing for ${input.signal}; `
        + 'Q66.1 hyperparameter derivation incomplete at compile time',
      );
    }
    M_t = computeBetaMixtureSupermartingale(
      state.S_t, t, baseline_mean,
      params.beta_alpha_prior, params.beta_beta_prior,
    );
    // Suppress unused-variable lint for Beta path (sigma_squared + live_value
    // not consumed; kept in input shape for caller-side parity with Gaussian).
    void sigma_squared; void live_value;
  } else {
    throw new Error(
      `Mixture distribution '${params.mixture_distribution}' not implemented at Phase-3.d.A SLICE 1; `
      + 'categorical mixture deferred to Phase-3.d.A.b sub-track',
    );
  }

  state.M_t = M_t;

  const threshold = 1 / alpha;
  const fire = M_t >= threshold;
  if (fire && !state.fired) {
    state.fired = true;
    state.tick_at_first_fire = t - 1;  // 0-indexed tick of first fire
  }

  return {
    fire: state.fired,  // sticky latch — once fired, stays fired
    M_t,
    threshold,
    two_sided: true,
  };
}

/** Q66.A.b — compute per-signal AR(1) coefficient phi via Yule-Walker
 *  on baseline cell residuals (centered against `baseline_mean`).
 *
 *  Estimator: lag-1 sample autocorrelation
 *    phi_hat = Σ x_t · x_{t-1} / Σ x_t²
 *  on centered residuals x = raw_value − baseline_mean. Phi clipped
 *  to [-0.95, +0.95] for numerical stability (avoid near-unit-root
 *  variance amplification in subsequent pre-whitening).
 *
 *  Returns 0 when:
 *    - cellRows.length < 2 (insufficient samples for lag-1 autocorrelation)
 *    - centered variance underflows (< 1e-12) → no signal to estimate phi
 *    - all observations identical (degenerate baseline)
 *
 *  Per axis 4.b reinforcement (input-data-structure semantic): AR(1)
 *  phi MUST be estimated on baseline-mean-centered series, NOT raw
 *  series. Raw-series Yule-Walker conflates non-zero mean with AR(1)
 *  coefficient (bias toward unity for highly-positive-mean signals;
 *  see Q59 LS-2 architect-side capture). */
export function computePerSignalAr1Phi(
  values: ReadonlyArray<number>,
  baseline_mean: number,
): number {
  if (values.length < 2) return 0;
  // Centered residuals: x = raw_value − baseline_mean.
  // Lag-1 covariance: Σ x_t · x_{t-1} for t = 1..N-1.
  let lag1 = 0;
  let variance = 0;
  const x0 = values[0] - baseline_mean;
  variance += x0 * x0;
  let xPrev = x0;
  for (let i = 1; i < values.length; i++) {
    const x = values[i] - baseline_mean;
    lag1 += x * xPrev;
    variance += x * x;
    xPrev = x;
  }
  if (variance < 1e-12) return 0;
  const phi = lag1 / variance;
  return Math.max(-0.95, Math.min(0.95, phi));
}

/** Q66.1 — derive mixture_supermartingale_params from existing Family A
 *  per-signal calibration state. Compile-time helper consumed by
 *  tools/calibrators/family-a.ts. Returns undefined for signal classes
 *  without a Phase-3.d.A SLICE 1 implementation (categorical →
 *  Phase-3.d.A.b). */
export function deriveMixtureSupermartingaleParams(
  per_signal: FamilyAPerSignalParams,
): FamilyAPerSignalParams['mixture_supermartingale_params'] | undefined {
  const sigClass = per_signal.signal_class ?? 'heavy_tail';  // gaussian_like default → heavy_tail Gaussian mixture
  const sigmaSquaredRaw = per_signal.baseline_sigma_squared_raw
    ?? per_signal.baseline_sigma_squared;
  switch (sigClass) {
    case 'gaussian_like':
    case 'heavy_tail':
    case 'counts': {
      if (sigmaSquaredRaw === undefined || sigmaSquaredRaw <= 0) return undefined;
      return {
        mixture_distribution: 'gaussian',
        gaussian_sigma_squared_prior: sigmaSquaredRaw,
      };
    }
    case 'bounded_probability': {
      // Howard-Ramdas-2021 §5: per-signal Beta mixture priors.
      // Architect-default: n_prior = 5 (numerical experiments default);
      // p_baseline = baseline_mean_raw (raw probability space for [0,1]
      // signals; raw-space mean lives in [0,1] for bounded_probability
      // class — pre-Q2.A logit-transform input).
      const n_prior = 5;
      const p_baseline = per_signal.baseline_mean_raw ?? per_signal.baseline_mean;
      // Clamp to (0,1) for Beta well-definedness.
      const p_clamped = Math.max(1e-6, Math.min(1 - 1e-6, p_baseline));
      const alpha_prior = Math.max(1, 0.5 + n_prior * p_clamped);
      const beta_prior = Math.max(1, 0.5 + n_prior * (1 - p_clamped));
      return {
        mixture_distribution: 'beta',
        beta_alpha_prior: alpha_prior,
        beta_beta_prior: beta_prior,
      };
    }
    default:
      // Unknown signal class: defer to Phase-3.d.A.b.
      return undefined;
  }
}

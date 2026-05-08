// engine/resamplers/ar1.ts — Q2.B.7 AR(1)-aware joint Gaussian resampler.
//
// Per Q2-B-7-ACF-AWARE-PARAMETRIC-SPEC.md (architect, 2026-04-27).
// Closes the parametric-iid mismatch on Family D spectral surfaced as
// Phase-2 commitment since REPLY-52gi.
//
// Mechanism: vector AR(1) `x_t = μ + diag(ρ)·(x_{t-1} − μ) + ε_t` with
// joint white-noise `ε_t ~ N(0, Σ_eps)` where
//   Σ_eps[i,j] = (1 − ρ_i·ρ_j) · Σ_x[i,j]
// derived from the Lyapunov equation Σ_x = Φ·Σ_x·Φᵀ + Σ_eps for
// diagonal Φ = diag(ρ). Stationary marginal `Var(x_t,i) = Σ_x[i,i]`
// AND lag-1 autocorrelation matches `ρ_i` per signal by construction;
// joint cross-signal Σ_x preserved at same tick via Σ_eps cross-terms.
//
// Anti-scope: per-signal AR(1) only (diagonal Φ). VAR(1) full multivariate
// off-diagonal lag matrix is post-Q2.B.7 architectural decision; out of
// scope here.

import { jointGaussianSample } from './cholesky';

/** Sample one tick of a joint AR(1) process given previous-tick state,
 *  white-noise Cholesky factor `L_eps`, and per-signal AR(1) coefficients
 *  `ρ`. Caller threads state across ticks; this function is pure on
 *  inputs.
 *
 *  @param xPrev  length-p previous-tick state.
 *  @param mu     length-p mean vector (cell-matched μ).
 *  @param rho    length-p per-signal AR(1) coefficients.
 *  @param L_eps  p × p lower-triangular Cholesky of Σ_eps.
 *  @param prng   deterministic uniform RNG.
 *  @returns      length-p next-tick sample. */
export function jointAR1Sample(
  xPrev: number[],
  mu: number[],
  rho: number[],
  L_eps: number[][],
  prng: () => number,
): number[] {
  const p = mu.length;
  if (xPrev.length !== p) {
    throw new Error(`jointAR1Sample: xPrev length ${xPrev.length} ≠ p=${p}`);
  }
  if (rho.length !== p) {
    throw new Error(`jointAR1Sample: rho length ${rho.length} ≠ p=${p}`);
  }
  // ε_t ~ N(0, Σ_eps) via L_eps Cholesky
  const eps = jointGaussianSample(new Array(p).fill(0), L_eps, prng);
  // x_t = μ + diag(ρ) · (x_{t-1} − μ) + ε_t
  const xNext = new Array(p);
  for (let i = 0; i < p; i++) {
    xNext[i] = mu[i] + rho[i] * (xPrev[i] - mu[i]) + eps[i];
  }
  return xNext;
}

/** Initialize x_0 from the stationary distribution N(μ, Σ_x). Avoids
 *  needing a burn-in pass on the resampler — the chain starts at
 *  equilibrium directly.
 *
 *  Equivalent to a single `jointGaussianSample(μ, L_x, prng)` draw,
 *  where `L_x = Cholesky(Σ_x = Σ_C_blended)` is the cell's calibrated
 *  joint covariance Cholesky factor.
 *
 *  @param mu    length-p mean vector.
 *  @param L_x   p × p lower-triangular Cholesky of Σ_x.
 *  @param prng  deterministic uniform RNG.
 *  @returns     length-p sample drawn from the stationary distribution. */
export function initAR1Stationary(
  mu: number[],
  L_x: number[][],
  prng: () => number,
): number[] {
  return jointGaussianSample(mu, L_x, prng);
}

/** Compute Σ_eps from Σ_x and the per-signal AR(1) coefficient vector ρ.
 *
 *  Σ_eps[i,j] = (1 − ρ_i·ρ_j) · Σ_x[i,j]
 *
 *  Caller takes Cholesky(Σ_eps) and stamps the lower-triangular factor
 *  on the cell for the resampler to consume. Exported separately so
 *  test code can verify Σ_eps construction in same-units terms as
 *  Σ_x without going through the Cholesky factorization. */
export function computeWhiteNoiseCovariance(
  sigmaX: number[][],
  rho: number[],
): number[][] {
  const p = rho.length;
  if (sigmaX.length !== p) {
    throw new Error(
      `computeWhiteNoiseCovariance: Σ_x rows ${sigmaX.length} ≠ ρ length ${p}`,
    );
  }
  const sigmaEps: number[][] = Array.from(
    { length: p }, () => new Array(p).fill(0),
  );
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      sigmaEps[i][j] = (1 - rho[i] * rho[j]) * sigmaX[i][j];
    }
  }
  return sigmaEps;
}

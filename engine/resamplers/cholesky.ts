// engine/resamplers/cholesky.ts — joint Gaussian sampling via Cholesky
// factorization of a positive-semi-definite covariance matrix.
//
// Per ARCHITECT-REPLY-52gi §TPM-ask-2 (2026-04-26): closes the parametric-
// resampler bug surfaced by Step-6 wrapper-bypass log diff (commit
// 6c5c8ff). Earlier `parametricGaussianWindow` generated each signal
// independently from N(μ_signal, σ²_signal), giving a joint distribution
// with diagonal covariance. Family C Hotelling T² is calibrated against
// the cell's NON-diagonal Σ_C; the diagonal-vs-non-diagonal mismatch
// inflated T² firing rate to 72/131 (55%) on healthy windows. Cholesky-
// based joint sampling preserves the calibrated covariance structure.

/**
 * Compute the lower-triangular Cholesky factor `L` of a positive-semi-
 * definite matrix Σ such that `L · Lᵀ = Σ`. Diagonal entries are
 * regularized via `max(s, eps)` to handle rank-deficient or near-zero
 * eigenvalue cells (e.g., low-variance cells where one signal is
 * almost-degenerate). Non-finite or negative diagonals upstream of the
 * regularizer indicate calibration corruption — caller's responsibility
 * to detect via post-compile validation.
 *
 * @param Sigma  p × p symmetric covariance matrix.
 * @param eps    floor on diagonal pivot magnitude (default 1e-12).
 * @returns      p × p lower-triangular L with L[i][j] = 0 for j > i.
 */
export function cholesky(Sigma: number[][], eps: number = 1e-12): number[][] {
  const p = Sigma.length;
  if (p === 0) return [];
  for (let i = 0; i < p; i++) {
    if (Sigma[i].length !== p) {
      throw new Error(`cholesky: Σ row ${i} length ${Sigma[i].length} ≠ p=${p}`);
    }
  }
  const L: number[][] = [];
  for (let i = 0; i < p; i++) L.push(new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    // Diagonal: L[j][j] = sqrt(Σ[j][j] − Σ_{k<j} L[j][k]²)
    let sum = Sigma[j][j];
    for (let k = 0; k < j; k++) sum -= L[j][k] * L[j][k];
    const pivot = Math.sqrt(Math.max(sum, eps));
    L[j][j] = pivot;
    // Below-diagonal entries: L[i][j] = (Σ[i][j] − Σ_{k<j} L[i][k]·L[j][k]) / L[j][j]
    for (let i = j + 1; i < p; i++) {
      let s = Sigma[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = s / pivot;
    }
  }
  return L;
}

/**
 * Generate one joint Gaussian sample `x = μ + L · u` where `u ~ N(0, I_p)`
 * iid. Reuses the boxMullerStandard from the existing Q3 resampler so the
 * underlying RNG semantics stay consistent across the codebase.
 *
 * @param mu   length-p mean vector.
 * @param L    p × p lower-triangular Cholesky factor of Σ.
 * @param prng deterministic uniform RNG; same shape as the existing
 *             `mulberry32`-backed source used in `tools/build-report-card.js`.
 * @returns    length-p sample vector.
 */
export function jointGaussianSample(
  mu: number[],
  L: number[][],
  prng: () => number,
): number[] {
  const p = mu.length;
  if (L.length !== p) {
    throw new Error(`jointGaussianSample: μ length ${p} ≠ L rows ${L.length}`);
  }
  const u = new Array(p);
  for (let i = 0; i < p; i++) u[i] = boxMullerStandard(prng);
  const x = new Array(p);
  for (let i = 0; i < p; i++) {
    let s = mu[i];
    // Lower-triangular multiply: x_i = μ_i + Σ_{j<=i} L[i][j] · u[j]
    for (let j = 0; j <= i; j++) s += L[i][j] * u[j];
    x[i] = s;
  }
  return x;
}

/** Box-Muller standard-normal draw. u1 floored at 1e-12 to avoid log(0).
 *  Mirror of `tools/build-report-card.js`'s helper so this module stays
 *  self-contained; the duplicate is fine for a small numerical primitive. */
export function boxMullerStandard(prng: () => number): number {
  const u1 = Math.max(prng(), 1e-12);
  const u2 = prng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

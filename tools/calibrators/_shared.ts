// tools/calibrators/_shared.ts — End-phase slice 3b (D-54-3).
//
// Numerical utilities shared by per-family calibrators. Pure
// functions; no module-level state. Leading underscore signals
// "internal to tools/calibrators/" — external consumers should not
// import from this module directly.

/** Mulberry32 PRNG — fast deterministic uniform source in [0, 1).
 *  Used by family-c (MCD c-step randomization + MMD bootstrap),
 *  family-d (spectral null bootstrap), family-e (conformal bootstrap). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller Gaussian sampler. Used by family-e conformal bootstrap. */
export function gaussian(rng: () => number): number {
  let u = rng(); while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Cholesky L such that L L^T = A. Returns null if A not PD.
 *  Used by family-c (safe-Hotelling log-det precompute) and
 *  family-e (conformal Mahalanobis sampling). */
export function choleskyLocal(A: number[][]): number[][] | null {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Symmetric eigendecomposition via cyclic Jacobi rotations.
 *  Returns `{ eigenvalues, eigenvectors }` where eigenvectors[i][k] is
 *  the i-th component of the k-th eigenvector (column-major V), so
 *  `A ≈ V · diag(eigenvalues) · V^T`. Convergence: O(p²) sweeps; for
 *  p ≤ 20 (Family C ≤ 11) the absolute iteration cost is negligible.
 *
 *  Mutates a working copy of A; input matrix is not modified. Assumes
 *  A is symmetric (caller's responsibility); off-diagonal averaging
 *  is not performed here.
 *
 *  Used by Q2.B.6.1 PSD projection (Σ_eps regularization) and is
 *  available to other calibrators that need eigenvalue access. */
export function symmetricEigenDecomposition(A: number[][]): {
  eigenvalues: number[];
  eigenvectors: number[][];
} {
  const n = A.length;
  // Working copy of A (will be diagonalized in-place by Jacobi rotations).
  const M: number[][] = Array.from({ length: n }, (_, i) => A[i].slice());
  // V starts as identity; accumulates left rotations to form the
  // eigenvector matrix. V[i][k] = i-th component of k-th eigenvector.
  const V: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0);
    row[i] = 1;
    return row;
  });
  const MAX_SWEEPS = 64;
  const TOL = 1e-14;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    // Off-diagonal Frobenius² — convergence indicator.
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += M[i][j] * M[i][j];
    }
    if (off < TOL) break;
    // Annihilate every off-diagonal element once per sweep.
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = M[p][q];
        if (Math.abs(apq) < TOL) continue;
        const app = M[p][p];
        const aqq = M[q][q];
        // tan(2θ) = 2·apq / (app − aqq); pick the smaller-magnitude root
        // for numerical stability (Press et al., Numerical Recipes §11.1).
        const theta = (aqq - app) / (2 * apq);
        let t: number;
        if (Math.abs(theta) > 1e16) {
          t = 1 / (2 * theta);
        } else {
          t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        }
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // Update M (Givens rotation on rows + columns p, q).
        M[p][p] = app - t * apq;
        M[q][q] = aqq + t * apq;
        M[p][q] = 0;
        M[q][p] = 0;
        for (let i = 0; i < n; i++) {
          if (i === p || i === q) continue;
          const mip = M[i][p];
          const miq = M[i][q];
          M[i][p] = c * mip - s * miq;
          M[p][i] = M[i][p];
          M[i][q] = s * mip + c * miq;
          M[q][i] = M[i][q];
        }
        // Accumulate rotation into V (right-multiply).
        for (let i = 0; i < n; i++) {
          const vip = V[i][p];
          const viq = V[i][q];
          V[i][p] = c * vip - s * viq;
          V[i][q] = s * vip + c * viq;
        }
      }
    }
  }
  const eigenvalues = new Array<number>(n);
  for (let i = 0; i < n; i++) eigenvalues[i] = M[i][i];
  return { eigenvalues, eigenvectors: V };
}

/** Project a symmetric matrix to its nearest PSD via eigenvalue
 *  clipping. Used by Q2.B.6.1 to regularize Σ_eps from the Lyapunov
 *  bridge `(1 − ρ_i·ρ_j)·Σ_C[i,j]`, which is generically non-PSD when
 *  ρ has heterogeneous values: clipping the negative eigenvalues at a
 *  trace-relative floor produces a Cholesky-factorizable proxy that
 *  is closest (in Frobenius norm) to Σ_eps over the PSD cone.
 *
 *  `epsRelativeScale` defaults to 1e-9. The floor is `eps_rel·trace/p`
 *  so that scale-equivariance holds: projectPSD(c·Σ) = c·projectPSD(Σ)
 *  for c > 0. Smaller eps_rel → less regularization, closer to the
 *  raw Σ_eps but more chance of cholesky-pivot underflow downstream.
 *
 *  Returns the symmetric PSD matrix `V · max(Λ, ε) · V^T`. */
export function projectPSD(
  Sigma: number[][],
  epsRelativeScale: number = 1e-9,
): number[][] {
  const p = Sigma.length;
  if (p === 0) return [];
  // Trace-relative floor (scale-equivariant; positive even when Σ has
  // a zero or negative trace edge case).
  let trace = 0;
  for (let i = 0; i < p; i++) trace += Sigma[i][i];
  const eps = Math.max(epsRelativeScale * Math.abs(trace) / p, 1e-300);
  const { eigenvalues, eigenvectors } = symmetricEigenDecomposition(Sigma);
  const lambdaClipped = eigenvalues.map((lambda) => Math.max(lambda, eps));
  // Σ_psd[i,j] = Σ_k V[i,k] · λ_k_clipped · V[j,k]
  const SigmaPSD: number[][] = Array.from(
    { length: p }, () => new Array(p).fill(0),
  );
  for (let k = 0; k < p; k++) {
    const lk = lambdaClipped[k];
    for (let i = 0; i < p; i++) {
      const vik = eigenvectors[i][k];
      for (let j = 0; j < p; j++) {
        SigmaPSD[i][j] += vik * lk * eigenvectors[j][k];
      }
    }
  }
  // Symmetrize to absorb FP drift in the V·Λ·V^T accumulation.
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const avg = 0.5 * (SigmaPSD[i][j] + SigmaPSD[j][i]);
      SigmaPSD[i][j] = avg;
      SigmaPSD[j][i] = avg;
    }
  }
  return SigmaPSD;
}

/** Minimum eigenvalue of a symmetric matrix. Convenience wrapper used
 *  by Q2.B.6.1 audit step to verify post-projection PSD coverage. */
export function minEigenvalue(A: number[][]): number {
  if (A.length === 0) return 0;
  const { eigenvalues } = symmetricEigenDecomposition(A);
  let m = eigenvalues[0];
  for (let i = 1; i < eigenvalues.length; i++) {
    if (eigenvalues[i] < m) m = eigenvalues[i];
  }
  return m;
}

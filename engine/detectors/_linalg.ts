// engine/detectors/_linalg.ts — shared linear-algebra helpers.
//
// Cholesky factorization and triangular forward-solve, used by both
// Family C (Hotelling T²) and Family E (Mahalanobis conformal). Pulled
// into a shared module so the browser bundle's name-collision-free
// concatenation pass doesn't see duplicate top-level declarations.

/** Cholesky decomposition A = L L^T for a symmetric PSD matrix A.
 *  Returns null if A is not positive definite (any non-positive diagonal
 *  pivot during reduction). Pure in-place math; allocates one triangular
 *  result. */
export function cholesky(A: number[][]): number[][] | null {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) return null;
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/** Solve L y = b for lower-triangular L. */
export function forwardSolve(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

/** Addition #20 — log(det(A)) via Cholesky. A = L L^T ⇒
 *  det(A) = det(L)² = (Π L_ii)² ⇒ log det(A) = 2 · Σ log L_ii.
 *  Returns null if A is not positive definite. Used by
 *  `tools/calibrate.ts` to precompute `safe_hotelling_params.precompiled_log_det_shrink`
 *  at compile time. */
export function logDet(A: number[][]): number | null {
  const L = cholesky(A);
  if (!L) return null;
  let s = 0;
  for (let i = 0; i < L.length; i++) s += Math.log(L[i][i]);
  return 2 * s;
}

/** Addition #22 (ARCHITECT-REPLY-46 D3) — binary search returning the
 *  smallest index `k` such that `sorted[k] >= target`. Returns
 *  `sorted.length` if no such index exists (target strictly exceeds all
 *  elements). Empty array → 0. O(log n). Pure function.
 *
 *  Used by the Family E weighted e-value detector to rank a live
 *  Mahalanobis score against the calibration distribution: `k`
 *  indexes into a precomputed `cumulative_weights_above[k]` array
 *  giving `Σ_{i ≥ k} weight_i` — the denominator of the conformal
 *  e-value construction per REPLY-46 D3. */
export function findFirstGE(sorted: number[], target: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Addition #19 (ARCHITECT-REPLY-35 D4) — standard weighted-quantile.
 *
 *  Sort `(score_i, weight_i)` pairs by `score_i` ascending; return the
 *  smallest `score_k` such that `(Σ_{i≤k} w_i) / (Σ_i w_i) ≥ q`. Ties
 *  resolved conservatively: when the cumulative-weighted fraction equals
 *  `q` at the `k`-th rank, we still return `score_k` (which, because
 *  sort keys stable-tie-break, may equal `score_{k+1}`; the caller fires
 *  strictly above the returned threshold, so equal-to-threshold live
 *  scores don't fire — the safe-side choice).
 *
 *  Edge cases:
 *    - `scores.length === 0` → returns 0 (no calibration; caller must
 *      have already bailed via the underpowered guard).
 *    - `scores.length !== weights.length` → throws; invariant violation.
 *    - `Σw ≤ 0` (degenerate weights) → returns the max score. */
export function weightedQuantile(scores: number[], weights: number[], q: number): number {
  const n = scores.length;
  if (n === 0) return 0;
  if (weights.length !== n) {
    throw new Error(`weightedQuantile: scores (${n}) and weights (${weights.length}) length mismatch`);
  }
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => scores[a] - scores[b]);
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  if (!(total > 0)) return scores[idx[n - 1]];
  let cum = 0;
  for (let k = 0; k < n; k++) {
    cum += weights[idx[k]];
    if (cum / total >= q) return scores[idx[k]];
  }
  return scores[idx[n - 1]];
}

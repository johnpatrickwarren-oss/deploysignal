// tools/calibrators/_family-c-covariance.ts — Family C covariance,
// numerical, and PSD-gate helpers. Split VERBATIM from family-c.ts
// (End-phase slice 3c, D-54-3) during the god-file decomposition; no
// computation changed. Re-exported through the family-c.ts facade so the
// public import surface is unchanged.

import { choleskyLocal } from './_shared.js';

// ── Covariance helpers ──────────────────────────────────────────────

/** Column-wise mean of an n × p row matrix. */
export function columnMean(rows: number[][]): number[] {
  const p = rows[0].length;
  const m = new Array(p).fill(0);
  for (const r of rows) for (let i = 0; i < p; i++) m[i] += r[i];
  for (let i = 0; i < p; i++) m[i] /= rows.length;
  return m;
}

/** Element-wise relative deviation: r_ti = (x_ti - μ_i) / μ_i. Returns an
 *  n × p matrix of dimensionless deviations — the scale-free quantity the
 *  Hotelling T² detector operates on. Falls back to additive (x - μ) when
 *  μ_i ≈ 0 to avoid division blow-up. */
export function relativeDeviations(rows: number[][], mean: number[]): number[][] {
  const p = mean.length;
  const out: number[][] = [];
  for (const r of rows) {
    const z = new Array(p);
    for (let i = 0; i < p; i++) {
      const m = mean[i];
      z[i] = Math.abs(m) > 1e-12 ? (r[i] - m) / m : (r[i] - m);
    }
    out.push(z);
  }
  return out;
}

/** Sample covariance (n×p matrix input, assumed mean-zero per column). */
export function sampleCovariance(Z: number[][]): number[][] {
  const n = Z.length;
  const p = Z[0].length;
  const S: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const z of Z) {
    for (let i = 0; i < p; i++) {
      const zi = z[i];
      const row = S[i];
      for (let j = 0; j < p; j++) row[j] += zi * z[j];
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) S[i][j] /= n;
  return S;
}

/** Ledoit-Wolf shrinkage toward an identity-scaled target (Ledoit &
 *  Wolf 2004, "A well-conditioned estimator..."). Works on mean-zero
 *  input Z (n × p). Returns the shrunk covariance and the intensity λ.
 *  The target is `μ_diag · I` where μ_diag = trace(S)/p — scale-aware
 *  because Z is already in z-score-ish units (relative deviation). */
export function ledoitWolfShrinkage(Z: number[][]): { cov: number[][]; lambda: number } {
  const n = Z.length;
  const p = Z[0].length;
  const S = sampleCovariance(Z);
  let muDiag = 0;
  for (let i = 0; i < p; i++) muDiag += S[i][i];
  muDiag /= p;
  let dSq = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      const fij = (i === j) ? muDiag : 0;
      const diff = S[i][j] - fij;
      dSq += diff * diff;
    }
  }
  let bBar2 = 0;
  for (const z of Z) {
    let normSq = 0;
    for (let i = 0; i < p; i++) {
      const zi = z[i];
      for (let j = 0; j < p; j++) {
        const diff = zi * z[j] - S[i][j];
        normSq += diff * diff;
      }
    }
    bBar2 += normSq;
  }
  bBar2 /= (n * n);
  const bSq = Math.min(bBar2, dSq);
  const lambda = dSq > 0 ? bSq / dSq : 0;
  const cov: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      const fij = (i === j) ? muDiag : 0;
      cov[i][j] = lambda * fij + (1 - lambda) * S[i][j];
    }
  }
  return { cov, lambda };
}

/** Q2.B.6a (ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66) — drop convex
 *  shrinkage. Returns Σ_pc when `perCellN ≥ rankFloor` (rank-sufficient);
 *  otherwise returns a deep copy of Σ_aggregate. α is now binary
 *  {0, 1}: 1 = rank-sufficient (per-cell), 0 = rank-deficient
 *  (aggregate). The discontinuity at the boundary is intentional —
 *  architect §61 picked the simpler "rank-sufficient vs rank-deficient"
 *  semantic threshold over the smooth-shrinkage convex blend.
 *
 *  Pre-Q2.B.6a (Q2.B.4 e203a96): `α · Σ_pc + (1 − α) · Σ_aggregate` with
 *  `α = clamp(n / mcdFloor, 0, 1)`. That convex blend was found at
 *  Q2.B.5 to combine with the cell-selection bug (Q2.B.6c) and produce
 *  parametric Cholesky 131/131 false-fires under v5.2-q2b5. Q2.B.6
 *  closes both: Q2.B.6c fixes cell selection in build-report-card.js;
 *  Q2.B.6a (this function) drops the convex blend.
 *
 *  Architecturally regressive on the shrinkage decision (Q2.B.4
 *  introduced smooth shrinkage to stabilize moderate-sample cells)
 *  but correct on the coherence decision (architect §74). Trade-off
 *  accepted: production methodology surfaces rely on byte-exact
 *  agreement between resampler-source Σ and runtime-test-statistic Σ;
 *  smooth shrinkage breaks that agreement under iid bootstrap. */
export function applyAggregateShrinkage(
  perCellCov: number[][],
  aggregateCov: number[][],
  perCellN: number,
  rankFloor: number,
): { cov: number[][]; alpha: number } {
  if (perCellN >= rankFloor) {
    return { cov: perCellCov, alpha: 1 };
  }
  return { cov: aggregateCov.map((row) => row.slice()), alpha: 0 };
}

// ── Numerical helpers ──────────────────────────────────────────────

/** Wilson-Hilferty χ²(0.975, p) approximation. Matches the Hotelling
 *  detector's runtime quantile. */
export function chiSqQuantile975(p: number): number {
  const z = 1.95996398454005;
  const a = 1 - 2 / (9 * p);
  const b = z * Math.sqrt(2 / (9 * p));
  const root = a + b;
  return p * root * root * root;
}

/** log det via Cholesky: log det(L L^T) = 2 · Σ log L_ii. Returns null
 *  when the input isn't positive definite (Cholesky fails). */
export function logDetCholesky(S: number[][]): number | null {
  const L = choleskyLocal(S);
  if (!L) return null;
  let logDet = 0;
  for (let i = 0; i < L.length; i++) logDet += Math.log(L[i][i]);
  return 2 * logDet;
}

/** Same semantic as logDetCholesky; second copy existed pre-3c in the
 *  Family E section. Kept under the longer name so the safe-Hotelling
 *  precompute reads `logDetLocal(...)` per its original source. */
export function logDetLocal(A: number[][]): number | null {
  const L = choleskyLocal(A);
  if (!L) return null;
  let s = 0;
  for (let i = 0; i < L.length; i++) s += Math.log(L[i][i]);
  return 2 * s;
}

/** Mahalanobis distance squared r^T Σ⁻¹ r given Σ's Cholesky L. */
export function mahalanobisSqFromL(z: number[], mean: number[], L: number[][]): number {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = z[i] - mean[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  let sum = 0;
  for (const v of y) sum += v * v;
  return sum;
}

/** Mahalanobis distance √(z^T Σ⁻¹ z) for mean-zero z. */
export function mahalanobis(z: number[], L: number[][]): number {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = z[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  let sum = 0;
  for (const v of y) sum += v * v;
  return Math.sqrt(sum);
}

// ── PSD / off-diagonal gates ──────────────────────────────────────

/** REPLY-38 Cluster 1 — tolerant PSD check. Cholesky with a pivot floor
 *  `eps`: rejects matrices that are strictly PD but numerically near-
 *  singular. */
export const PSD_TOLERANCE = 1e-10;

/** REPLY-41 Option 2 — off-diagonal nondegeneracy tolerance, relative
 *  to the mean absolute diagonal. */
export const OFFDIAG_REL_TOLERANCE = 1e-6;

export function isPSDWithTolerance(A: number[][], eps: number): boolean {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= eps) return false;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return true;
}

// ── Shared local Cholesky (lower-triangular) ────────────────────────

/** Lower-triangular Cholesky factor of a PSD matrix Σ. Mirror of
 *  `engine/resamplers/cholesky.ts` to keep the calibrator side-effect-
 *  free + isolated from runtime engine imports. Diagonal regularized
 *  via max(s, 1e-12) to handle rank-deficient cells.
 *
 *  Internal helper shared by the Hotelling-bootstrap and per-cell-build
 *  submodules; not part of the public family-c.ts surface. */
export function choleskyLowerTriangular(Sigma: number[][]): number[][] {
  const p = Sigma.length;
  const L: number[][] = [];
  for (let i = 0; i < p; i++) L.push(new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    let sum = Sigma[j][j];
    for (let k = 0; k < j; k++) sum -= L[j][k] * L[j][k];
    const pivot = Math.sqrt(Math.max(sum, 1e-12));
    L[j][j] = pivot;
    for (let i = j + 1; i < p; i++) {
      let s = Sigma[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = s / pivot;
    }
  }
  return L;
}

// test/cholesky-resampler.test.ts — V1.H3 Cholesky resampler unit tests
// per ARCHITECT-REPLY-52gi §TPM-ask-2.
//
// Two layers:
//   (1) cholesky() correctness against scipy.linalg.cholesky reference
//       values on small Σ (identity, diagonal, 2×2 with correlation,
//       rank-deficient with eps regularization).
//   (2) jointGaussianSample() empirical covariance over 10k samples
//       matches input Σ within Monte-Carlo tolerance (proves the
//       resampler preserves multivariate structure — the fix for the
//       Step-6-wrapper-bypass diagonal-Σ bug).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cholesky, jointGaussianSample,
} from '../dist/engine/resamplers/cholesky';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length;
  const n = B[0].length;
  const k = B.length;
  const C: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let t = 0; t < k; t++) row[j] += A[i][t] * B[t][j];
    }
    C.push(row);
  }
  return C;
}
function transpose(A: number[][]): number[][] {
  const m = A.length;
  const n = A[0].length;
  const T: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m);
    for (let j = 0; j < m; j++) row[j] = A[j][i];
    T.push(row);
  }
  return T;
}

test('cholesky: identity matrix → identity factor', () => {
  const I = [[1, 0], [0, 1]];
  const L = cholesky(I);
  assert.deepStrictEqual(L, [[1, 0], [0, 1]]);
});

test('cholesky: diagonal matrix [[4,0],[0,9]] → diag([2,3])', () => {
  const D = [[4, 0], [0, 9]];
  const L = cholesky(D);
  assert.equal(L[0][0], 2);
  assert.equal(L[1][1], 3);
  assert.equal(L[0][1], 0);
  assert.equal(L[1][0], 0);
});

test('cholesky: 2×2 with correlation [[2,1],[1,2]] reproduces Σ via L·Lᵀ', () => {
  // scipy reference: L = [[√2, 0], [1/√2, √(3/2)]]
  // L·Lᵀ should equal Σ exactly modulo fp.
  const Sigma = [[2, 1], [1, 2]];
  const L = cholesky(Sigma);
  const reconstructed = matMul(L, transpose(L));
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      assert.ok(Math.abs(reconstructed[i][j] - Sigma[i][j]) < 1e-10,
        `L·Lᵀ[${i}][${j}] = ${reconstructed[i][j]} ≠ Σ[${i}][${j}] = ${Sigma[i][j]}`);
    }
  }
  // Specific values per scipy:
  assert.ok(Math.abs(L[0][0] - Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(L[1][0] - 1 / Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(L[1][1] - Math.sqrt(1.5)) < 1e-12);
  assert.equal(L[0][1], 0);
});

test('cholesky: 3×3 well-conditioned reconstructs Σ', () => {
  // Σ = LLᵀ with L = [[1,0,0],[0.5,1,0],[0.3,0.4,1]]
  // → Σ_diag = [1, 1.25, 1.25], off-diag computed below.
  const Sigma = [[1, 0.5, 0.3], [0.5, 1.25, 0.55], [0.3, 0.55, 1.25]];
  const L = cholesky(Sigma);
  const reconstructed = matMul(L, transpose(L));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(reconstructed[i][j] - Sigma[i][j]) < 1e-10,
        `L·Lᵀ[${i}][${j}] reconstruction error too large`);
    }
  }
  // Lower-triangular check
  assert.equal(L[0][1], 0);
  assert.equal(L[0][2], 0);
  assert.equal(L[1][2], 0);
});

test('cholesky: rank-deficient diagonal with eps regularization', () => {
  // Σ has a near-zero diagonal entry — eps should keep L invertible.
  const Sigma = [[1, 0], [0, 0]];
  const L = cholesky(Sigma, 1e-6);
  // L[1][1] should equal sqrt(eps) = 1e-3
  assert.ok(Math.abs(L[1][1] - 1e-3) < 1e-10,
    `eps regularization failed: L[1][1] = ${L[1][1]}, expected ${1e-3}`);
});

test('jointGaussianSample: empirical covariance matches input Σ over 10k samples', () => {
  // Generate 10k samples from N(μ, Σ) via Cholesky; compute empirical
  // covariance; assert it matches Σ within Monte-Carlo tolerance (~5%
  // for n=10k on 2×2 problems per CLT scaling).
  const mu = [0, 0];
  const Sigma = [[2, 0.7], [0.7, 1]];
  const L = cholesky(Sigma);
  const N = 10000;
  const rng = mulberry32(0x12345678);
  const samples: number[][] = [];
  for (let i = 0; i < N; i++) samples.push(jointGaussianSample(mu, L, rng));
  // Empirical mean
  const empMean = [0, 0];
  for (const s of samples) { empMean[0] += s[0]; empMean[1] += s[1]; }
  empMean[0] /= N; empMean[1] /= N;
  // Empirical covariance
  const empCov = [[0, 0], [0, 0]];
  for (const s of samples) {
    const d0 = s[0] - empMean[0];
    const d1 = s[1] - empMean[1];
    empCov[0][0] += d0 * d0;
    empCov[0][1] += d0 * d1;
    empCov[1][0] += d1 * d0;
    empCov[1][1] += d1 * d1;
  }
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) empCov[i][j] /= N;
  }
  // Tolerances: σ_emp/σ_true should be within ~5% at n=10k. Off-diag
  // tolerance is looser because correlation estimates have higher
  // variance.
  console.log(`[cholesky test] empirical covariance vs Σ:`);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const tol = i === j ? 0.05 * Sigma[i][j] : 0.10;
      const err = Math.abs(empCov[i][j] - Sigma[i][j]);
      console.log(`  Σ[${i}][${j}] = ${Sigma[i][j].toFixed(3)}; emp = ${empCov[i][j].toFixed(3)}; |err| = ${err.toFixed(4)}; tol = ${tol.toFixed(4)}`);
      assert.ok(err < tol,
        `empirical Σ[${i}][${j}] = ${empCov[i][j]}, expected ${Sigma[i][j]} ± ${tol}`);
    }
  }
});

test('jointGaussianSample: x = μ when L is zero (degenerate)', () => {
  // Edge case: zero covariance → all samples equal μ.
  const mu = [5, 10];
  const L = [[0, 0], [0, 0]];
  const rng = mulberry32(0xDEAD);
  for (let i = 0; i < 100; i++) {
    const x = jointGaussianSample(mu, L, rng);
    assert.equal(x[0], 5);
    assert.equal(x[1], 10);
  }
});

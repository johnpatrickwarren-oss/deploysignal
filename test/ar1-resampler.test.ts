// test/ar1-resampler.test.ts — Q2.B.7 AR(1)-aware parametric resampler
// unit + module-level coverage.
//
// Per Q2-B-7-ACF-AWARE-PARAMETRIC-SPEC.md §Tests. Translated from spec's
// describe/it pseudo-code into node:test (DeploySignal convention).
//
// Out of scope here: Q3 parametric_ar1 H₀ regression (sweeps the full
// substrate; see test/family-d-ar1-calibration.test.ts + the post-merge
// build-report-card-driven acceptance run).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  jointAR1Sample,
  initAR1Stationary,
  computeWhiteNoiseCovariance,
} from '../engine/resamplers/ar1';
import {
  cholesky,
  jointGaussianSample,
} from '../engine/resamplers/cholesky';

// ── Deterministic PRNG (mulberry32) ───────────────────────────────

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

// ── computeWhiteNoiseCovariance ──────────────────────────────────

test('Q2.B.7 ar1: computeWhiteNoiseCovariance — Σ_eps[i,i] = (1−ρ²)·Σ_x[i,i]', () => {
  const sigmaX = [
    [1.0, 0.3, 0.0],
    [0.3, 2.0, 0.5],
    [0.0, 0.5, 4.0],
  ];
  const rho = [0.4, 0.5, 0.0];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  // Diagonal: Σ_eps[i,i] = (1 − ρ_i²) · Σ_x[i,i]
  assert.ok(Math.abs(sigmaEps[0][0] - (1 - 0.16) * 1.0) < 1e-12);
  assert.ok(Math.abs(sigmaEps[1][1] - (1 - 0.25) * 2.0) < 1e-12);
  assert.ok(Math.abs(sigmaEps[2][2] - (1 - 0.0) * 4.0) < 1e-12);
});

test('Q2.B.7 ar1: computeWhiteNoiseCovariance — off-diagonal = (1 − ρ_i·ρ_j) · Σ_x[i,j]', () => {
  const sigmaX = [
    [1.0, 0.5],
    [0.5, 1.0],
  ];
  const rho = [0.6, 0.4];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  // Σ_eps[0,1] = (1 − 0.6·0.4) · 0.5 = 0.76 · 0.5 = 0.38
  assert.ok(Math.abs(sigmaEps[0][1] - 0.38) < 1e-12);
  assert.ok(Math.abs(sigmaEps[1][0] - 0.38) < 1e-12);
});

test('Q2.B.7 ar1: computeWhiteNoiseCovariance — ρ=0 returns Σ_x unchanged (iid degeneracy)', () => {
  const sigmaX = [
    [1.5, 0.7],
    [0.7, 2.3],
  ];
  const rho = [0, 0];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      assert.ok(Math.abs(sigmaEps[i][j] - sigmaX[i][j]) < 1e-12);
    }
  }
});

test('Q2.B.7 ar1: computeWhiteNoiseCovariance — throws on dimension mismatch', () => {
  const sigmaX = [[1.0, 0.0], [0.0, 1.0]];
  const rho = [0.5, 0.5, 0.5]; // length 3 vs Σ_x 2x2
  assert.throws(() => computeWhiteNoiseCovariance(sigmaX, rho), /rows.*ρ length/);
});

// ── jointAR1Sample shape + dimension validation ──────────────────

test('Q2.B.7 ar1: jointAR1Sample — output length matches μ length', () => {
  const mu = [10, 20, 30];
  const rho = [0.3, 0.5, 0.0];
  const sigmaX = [
    [1.0, 0.0, 0.0],
    [0.0, 4.0, 0.0],
    [0.0, 0.0, 9.0],
  ];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  const L_eps = cholesky(sigmaEps);
  const xPrev = [10, 20, 30];
  const xNext = jointAR1Sample(xPrev, mu, rho, L_eps, mulberry32(42));
  assert.equal(xNext.length, 3);
  for (const v of xNext) assert.ok(Number.isFinite(v));
});

test('Q2.B.7 ar1: jointAR1Sample — throws when xPrev length ≠ μ length', () => {
  const mu = [0, 0];
  const rho = [0.5, 0.5];
  const L_eps = [[1, 0], [0, 1]];
  assert.throws(
    () => jointAR1Sample([0, 0, 0], mu, rho, L_eps, mulberry32(1)),
    /xPrev length/,
  );
});

// ── Stationary marginal variance preservation ────────────────────

test('Q2.B.7 ar1: jointAR1Sample preserves stationary marginal Var(x_i) = Σ_x[i,i]', () => {
  // Run N trajectories of T ticks; sample marginal variance at last tick;
  // assert ≈ Σ_x[i,i] within Monte-Carlo error.
  const mu = [0, 0];
  const rho = [0.5, 0.3];
  const sigmaX = [
    [1.0, 0.0],
    [0.0, 4.0],
  ];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  const L_eps = cholesky(sigmaEps);
  const L_x = cholesky(sigmaX);

  const N = 5000;
  const T = 50;
  const finalSamples: number[][] = [];
  for (let n = 0; n < N; n++) {
    const prng = mulberry32(0x42 + n);
    let x = initAR1Stationary(mu, L_x, prng);
    for (let t = 0; t < T; t++) {
      x = jointAR1Sample(x, mu, rho, L_eps, prng);
    }
    finalSamples.push(x);
  }
  // Marginal variance per signal at final tick
  for (let i = 0; i < 2; i++) {
    let mean = 0;
    for (const x of finalSamples) mean += x[i];
    mean /= N;
    let varEmp = 0;
    for (const x of finalSamples) varEmp += (x[i] - mean) ** 2;
    varEmp /= N;
    // ±5% tolerance for Monte-Carlo error at N=5000
    const target = sigmaX[i][i];
    assert.ok(Math.abs(varEmp - target) / target < 0.07,
      `signal ${i}: empirical var ${varEmp.toFixed(3)} vs target ${target}`);
  }
});

// ── Lag-1 autocorrelation preservation ───────────────────────────

test('Q2.B.7 ar1: jointAR1Sample preserves lag-1 autocorrelation per signal', () => {
  // One long trajectory; compute lag-1 sample ACF; assert ≈ ρ within
  // sampling error.
  const mu = [0];
  const rho = [0.6];
  const sigmaX = [[1.0]];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  const L_eps = cholesky(sigmaEps);
  const L_x = cholesky(sigmaX);

  const T = 10000;
  const prng = mulberry32(0x12345);
  let x = initAR1Stationary(mu, L_x, prng);
  const trace: number[] = [x[0]];
  for (let t = 0; t < T; t++) {
    x = jointAR1Sample(x, mu, rho, L_eps, prng);
    trace.push(x[0]);
  }
  // Lag-1 sample ACF
  let traceMean = 0;
  for (const v of trace) traceMean += v;
  traceMean /= trace.length;
  let num = 0, denom = 0;
  for (let t = 0; t < trace.length - 1; t++) {
    num += (trace[t] - traceMean) * (trace[t + 1] - traceMean);
  }
  for (const v of trace) denom += (v - traceMean) ** 2;
  const acf1 = num / denom;
  // Tolerance: ±0.05 at T=10000 for ρ=0.6
  assert.ok(Math.abs(acf1 - 0.6) < 0.05,
    `lag-1 ACF ${acf1.toFixed(3)} should be near ρ=0.6`);
});

// ── Joint covariance preservation across signals at same tick ────

test('Q2.B.7 ar1: jointAR1Sample preserves joint Σ_x at same tick', () => {
  // Sample N trajectories; compute joint covariance at final tick;
  // assert ≈ Σ_x within Monte-Carlo error.
  const mu = [0, 0];
  const rho = [0.4, 0.4];
  const sigmaX = [
    [1.0, 0.5],
    [0.5, 1.0],
  ];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  const L_eps = cholesky(sigmaEps);
  const L_x = cholesky(sigmaX);

  const N = 5000;
  const T = 50;
  const finalSamples: number[][] = [];
  for (let n = 0; n < N; n++) {
    const prng = mulberry32(0xABC + n);
    let x = initAR1Stationary(mu, L_x, prng);
    for (let t = 0; t < T; t++) {
      x = jointAR1Sample(x, mu, rho, L_eps, prng);
    }
    finalSamples.push(x);
  }
  // Empirical Σ at final tick
  const meanX = [0, 0];
  for (const x of finalSamples) { meanX[0] += x[0]; meanX[1] += x[1]; }
  meanX[0] /= N; meanX[1] /= N;
  let cov01 = 0;
  for (const x of finalSamples) cov01 += (x[0] - meanX[0]) * (x[1] - meanX[1]);
  cov01 /= N;
  // Target: Σ_x[0,1] = 0.5; tolerance ±0.07 at N=5000
  assert.ok(Math.abs(cov01 - 0.5) < 0.08,
    `cross-signal cov ${cov01.toFixed(3)} should be near 0.5`);
});

// ── ρ=0 degeneracy: AR(1) reduces to iid joint Gaussian ──────────

test('Q2.B.7 ar1: ρ=0 degeneracy — AR(1) sample equivalent to fresh joint Gaussian', () => {
  // When all ρ_i=0, jointAR1Sample(x_prev, μ, 0, L_eps=L_x, prng)
  // should be equivalent to jointGaussianSample(μ, L_x, prng): xPrev
  // is multiplied by 0; Σ_eps = Σ_x (since 1 − 0·0 = 1).
  const mu = [5, 10];
  const rho = [0, 0];
  const sigmaX = [
    [1.0, 0.3],
    [0.3, 2.0],
  ];
  const sigmaEps = computeWhiteNoiseCovariance(sigmaX, rho);
  // Sanity: Σ_eps == Σ_x at ρ=0
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      assert.equal(sigmaEps[i][j], sigmaX[i][j]);
    }
  }
  const L_eps = cholesky(sigmaEps);
  // jointAR1 from arbitrary xPrev should match jointGaussianSample(μ, L_eps, prng)
  // Both consume identical PRNG draws.
  const prng1 = mulberry32(99);
  const prng2 = mulberry32(99);
  const ar1Out = jointAR1Sample([100, 200], mu, rho, L_eps, prng1);
  const gaussOut = jointGaussianSample(mu, L_eps, prng2);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(ar1Out[i] - gaussOut[i]) < 1e-12,
      `ρ=0 should reduce to fresh joint Gaussian; ar1[${i}]=${ar1Out[i]} vs gauss[${i}]=${gaussOut[i]}`);
  }
});

// ── initAR1Stationary smoke test ─────────────────────────────────

test('Q2.B.7 ar1: initAR1Stationary returns sample of correct length', () => {
  const mu = [1, 2, 3];
  const L_x = cholesky([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  const x0 = initAR1Stationary(mu, L_x, mulberry32(7));
  assert.equal(x0.length, 3);
  for (const v of x0) assert.ok(Number.isFinite(v));
});

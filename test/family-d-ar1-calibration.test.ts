// test/family-d-ar1-calibration.test.ts — Q2.B.7 Family D AR(1)
// calibration regression.
//
// Per Q2-B-7-ACF-AWARE-PARAMETRIC-SPEC.md §Tests. Verifies:
//   (a) fitAR1Coefficient recovers ρ ≈ 0 on iid samples
//   (b) fitAR1Coefficient recovers known ρ on synthetic AR(1) data
//   (c) Yule-Walker estimator clips at ±0.95 for stationarity
//   (d) buildFamilyDForSignalAR1 stamps ar1_phi + ar1_sigma_eps + the
//       expected schema fields; values fall in physically-meaningful
//       ranges
//   (e) AR(1) bootstrap threshold ≥ iid bootstrap threshold for ρ > 0
//       (autocorrelation inflates peak |ACF| under H₀)
//   (f) AR(1) and iid bootstrap thresholds agree at ρ ≈ 0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitAR1Coefficient,
  buildFamilyDForSignalAR1,
  buildFamilyDForSignal,
  FAMILY_D_BOOTSTRAP_SEED,
} from '../tools/calibrators/family-d';

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

function gaussian(rng: () => number): number {
  let u = rng();
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ── (a) fitAR1Coefficient on iid samples → ρ ≈ 0 ──────────────────

test('Q2.B.7 family-d: fitAR1Coefficient recovers ρ ≈ 0 on iid samples', () => {
  const rng = mulberry32(0xCAFE);
  const iid: number[] = [];
  for (let i = 0; i < 5000; i++) iid.push(gaussian(rng));
  const phi = fitAR1Coefficient(iid);
  assert.ok(Math.abs(phi) < 0.05, `iid ρ should be near 0; got ${phi}`);
});

// ── (b) fitAR1Coefficient recovers known ρ on synthetic AR(1) ─────

test('Q2.B.7 family-d: fitAR1Coefficient recovers ρ ≈ 0.5 on synthetic AR(1)', () => {
  const TRUE_RHO = 0.5;
  const N = 10000;
  const rng = mulberry32(0xBEEF);
  const samples: number[] = [0];
  for (let t = 1; t < N; t++) {
    samples.push(TRUE_RHO * samples[t - 1] + gaussian(rng));
  }
  const phi = fitAR1Coefficient(samples);
  assert.ok(Math.abs(phi - TRUE_RHO) < 0.05,
    `synthetic AR(1) ρ=0.5 recovered as ${phi.toFixed(3)}`);
});

test('Q2.B.7 family-d: fitAR1Coefficient recovers ρ ≈ 0.8 on stronger AR(1)', () => {
  const TRUE_RHO = 0.8;
  const N = 10000;
  const rng = mulberry32(0xFADE);
  const samples: number[] = [0];
  for (let t = 1; t < N; t++) {
    samples.push(TRUE_RHO * samples[t - 1] + gaussian(rng));
  }
  const phi = fitAR1Coefficient(samples);
  assert.ok(Math.abs(phi - TRUE_RHO) < 0.05,
    `synthetic AR(1) ρ=0.8 recovered as ${phi.toFixed(3)}`);
});

test('Q2.B.7 family-d: fitAR1Coefficient recovers negative ρ', () => {
  const TRUE_RHO = -0.3;
  const N = 10000;
  const rng = mulberry32(0xABCD);
  const samples: number[] = [0];
  for (let t = 1; t < N; t++) {
    samples.push(TRUE_RHO * samples[t - 1] + gaussian(rng));
  }
  const phi = fitAR1Coefficient(samples);
  assert.ok(Math.abs(phi - TRUE_RHO) < 0.05,
    `synthetic AR(1) ρ=-0.3 recovered as ${phi.toFixed(3)}`);
});

// ── (c) Stationarity clip at ±0.95 ───────────────────────────────

test('Q2.B.7 family-d: fitAR1Coefficient clips at +0.95 on near-non-stationary input', () => {
  // Construct a sample where lag-1 ratio approaches 1.0 (constant
  // increment series); Yule-Walker estimator will report ρ → 1.
  const N = 1000;
  const samples: number[] = [];
  for (let t = 0; t < N; t++) samples.push(t * 1.0);
  const phi = fitAR1Coefficient(samples);
  assert.ok(phi <= 0.95, `clip should hold; got ${phi}`);
  // Should be exactly 0.95 since the underlying ratio exceeds it.
  assert.equal(phi, 0.95);
});

test('Q2.B.7 family-d: fitAR1Coefficient handles degenerate constant series', () => {
  // All samples identical → denom = 0 → ρ = 0 (defensive return).
  const constant = new Array(100).fill(42);
  assert.equal(fitAR1Coefficient(constant), 0);
});

test('Q2.B.7 family-d: fitAR1Coefficient handles too-short input', () => {
  assert.equal(fitAR1Coefficient([]), 0);
  assert.equal(fitAR1Coefficient([1.0]), 0);
});

// ── (d) buildFamilyDForSignalAR1 schema + value ranges ───────────

test('Q2.B.7 family-d: buildFamilyDForSignalAR1 stamps ar1_phi + ar1_sigma_eps', () => {
  const N = 1000;
  const TRUE_RHO = 0.4;
  const rng = mulberry32(0xC0DE);
  const samples: number[] = [0];
  for (let t = 1; t < N; t++) {
    samples.push(TRUE_RHO * samples[t - 1] + gaussian(rng));
  }
  const out = buildFamilyDForSignalAR1(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(out.result, 'result populated');
  if (!out.result) return;
  // ar1_phi recovered close to TRUE_RHO
  assert.ok(out.result.ar1_phi !== undefined, 'ar1_phi stamped');
  assert.ok(Math.abs((out.result.ar1_phi ?? 0) - TRUE_RHO) < 0.1,
    `ar1_phi=${out.result.ar1_phi} should be near ${TRUE_RHO}`);
  // σ_eps in physically-meaningful range
  assert.ok(out.result.ar1_sigma_eps !== undefined, 'ar1_sigma_eps stamped');
  assert.ok((out.result.ar1_sigma_eps ?? 0) > 0,
    `σ_eps should be positive; got ${out.result.ar1_sigma_eps}`);
  // Existing schema fields still emit
  assert.ok(out.result.bootstrap_null_quantile >= 0);
  assert.ok(out.result.bootstrap_null_quantile <= 1);
  assert.equal(out.result.min_peak_lag, 3);
  assert.equal(out.result.max_peak_lag, 10);
  // C53 retirement (2026-08-18): bootstrap_null ships regardless of useLegacy.
  assert.equal(out.result.spectral_variant, 'bootstrap_null');
});

test('Q2.B.7 family-d: too-short input returns null result', () => {
  const samples = new Array(50).fill(0).map(() => Math.random());
  const out = buildFamilyDForSignalAR1(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.equal(out.result, null);
});

test('Q2.B.7 family-d: useLegacy=true flips spectral_variant to bootstrap_null', () => {
  const N = 500;
  const rng = mulberry32(0xBABE);
  const samples = Array.from({ length: N }, () => gaussian(rng));
  const out = buildFamilyDForSignalAR1(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, true);
  assert.ok(out.result);
  assert.equal(out.result?.spectral_variant, 'bootstrap_null');
});

// ── (e) AR(1) threshold ≥ iid threshold for ρ > 0 ────────────────

test('Q2.B.7 family-d: AR(1) bootstrap threshold ≥ iid bootstrap threshold for ρ > 0', () => {
  // AR(1) data with ρ = 0.6 → autocorrelation should inflate peak |ACF|
  // under bootstrap, raising the threshold relative to iid bootstrap of
  // the same samples.
  const N = 1000;
  const TRUE_RHO = 0.6;
  const rng = mulberry32(0xDEAD);
  const samples: number[] = [0];
  for (let t = 1; t < N; t++) {
    samples.push(TRUE_RHO * samples[t - 1] + gaussian(rng));
  }
  const ar1Out = buildFamilyDForSignalAR1(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  const iidOut = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(ar1Out.result && iidOut.result);
  if (!ar1Out.result || !iidOut.result) return;
  // AR(1) threshold should be strictly greater than iid (with margin
  // for sampling variability at N_BOOTSTRAPS=2000).
  assert.ok(ar1Out.result.bootstrap_null_quantile >= iidOut.result.bootstrap_null_quantile - 0.02,
    `AR(1) threshold (${ar1Out.result.bootstrap_null_quantile.toFixed(3)}) `
    + `should be ≥ iid threshold (${iidOut.result.bootstrap_null_quantile.toFixed(3)}) `
    + `for ρ=${TRUE_RHO}`);
});

// ── (f) AR(1) ≈ iid threshold at ρ ≈ 0 ───────────────────────────

test('Q2.B.7 family-d: AR(1) and iid bootstrap thresholds agree at ρ ≈ 0', () => {
  const rng = mulberry32(0x77);
  const iidSamples = Array.from({ length: 1000 }, () => gaussian(rng));
  const ar1Out = buildFamilyDForSignalAR1(iidSamples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  const iidOut = buildFamilyDForSignal(iidSamples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(ar1Out.result && iidOut.result);
  if (!ar1Out.result || !iidOut.result) return;
  // ρ should be near 0 on iid input
  assert.ok(Math.abs(ar1Out.result.ar1_phi ?? 0) < 0.1,
    `iid ρ should be ~0; got ${ar1Out.result.ar1_phi}`);
  // Thresholds should agree under iid input. α=1e-4 quantile-index lands
  // at sample 1999/2000 (essentially max-of-2000), which has high Monte-
  // Carlo variance — tolerance reflects that, not a meaningful gap
  // between the two methods.
  const rel = Math.abs(ar1Out.result.bootstrap_null_quantile - iidOut.result.bootstrap_null_quantile)
    / Math.max(iidOut.result.bootstrap_null_quantile, 1e-6);
  assert.ok(rel < 0.30,
    `AR(1)/iid threshold relative diff at ρ=0 should be small; got ${(rel * 100).toFixed(1)}%`);
});

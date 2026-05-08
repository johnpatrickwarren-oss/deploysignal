// test/family-a-class-calibration.test.ts — Q2.A per-class calibration.
//
// Per ARCHITECT Q2-A-SIGNAL-CLASS-REGISTRY-SPEC §Tests. Verifies that
// buildFamilyAPerSignal:
//   (a) defaults to gaussian_like (identity transform; pre-Q2.A
//       byte-identical behavior on Family A regression invariance)
//   (b) routes bounded_probability through logit, producing well-
//       conditioned σ² on saturated samples (closes V1.H1)
//   (c) routes heavy_tail through log, producing well-conditioned σ²
//       on multiplicative-process samples
//   (d) routes counts through Anscombe, stabilizing Poisson variance
//       (≈ 1 for moderate λ)
//   (e) emits baseline_mean_raw for Q2.B.4 coherence audit consumption
//       in same-space terms as Family C's mean_vector

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFamilyAPerSignal } from '../tools/calibrators/family-a';

// ── (a) gaussian_like default — pre-Q2.A regression invariance ────

test('Q2.A family-a calib: gaussian_like default — pre-Q2.A behaviour preserved', () => {
  // p99_latency-style samples: μ ≈ 200, σ ≈ a few units.
  // mulberry32-style deterministic generator so the test is stable.
  let s = 0xC0DE;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const samples = Array.from({ length: 1000 }, () => 200 + 5 * (rng() - 0.5) * 2);
  const out = buildFamilyAPerSignal(samples);  // default gaussian_like
  assert.equal(out.result.signal_class, 'gaussian_like');
  // baseline_mean ≈ 200 (raw space ≡ transformed space under identity)
  assert.ok(Math.abs(out.result.baseline_mean - 200) < 1, `mean=${out.result.baseline_mean}`);
  // baseline_mean_raw matches baseline_mean exactly under identity
  assert.equal(out.result.baseline_mean_raw, out.result.baseline_mean);
  // Variance well above the P1 floor (no degeneracy on this fixture).
  assert.ok(out.result.baseline_sigma_squared > 1,
    `σ²=${out.result.baseline_sigma_squared}; expected > 1 on σ ≈ 5/√3 fixture`);
  // δ_min and τ² preserved
  assert.ok(out.result.delta_min > 0);
  assert.ok(out.result.tau_squared > 0);
});

// ── (b) bounded_probability — saturated samples, logit transform ──

test('Q2.A family-a calib: bounded_probability saturated samples — logit yields well-conditioned σ²', () => {
  // Pre-Q2.A behaviour: σ² ≈ 10⁻³⁰ FP underflow on samples like
  // [0.999, 0.999, ..., 0.999, 0.99]. Post-Q2.A: logit-transformed
  // samples have σ² well above any FP-precision floor.
  const saturated = [...Array(999).fill(0.999), 0.99];
  const out = buildFamilyAPerSignal(saturated, 'bounded_probability');

  assert.equal(out.result.signal_class, 'bounded_probability');
  // baseline_mean is logit-space ≈ logit(0.999) = log(0.999/0.001) ≈ 6.907
  assert.ok(Math.abs(out.result.baseline_mean - 6.907) < 0.05,
    `logit-space mean=${out.result.baseline_mean}; expected ≈ 6.907`);
  // baseline_mean_raw is the raw arithmetic mean ≈ 0.99891
  assert.ok(Math.abs((out.result.baseline_mean_raw ?? 0) - 0.99891) < 0.001,
    `raw mean=${out.result.baseline_mean_raw}; expected ≈ 0.99891`);
  // σ² well-conditioned: NOT FP-underflowed
  assert.ok(out.result.baseline_sigma_squared > 1e-6,
    `logit-space σ²=${out.result.baseline_sigma_squared}; expected > 1e-6 (no underflow)`);
  // P1 floor should NOT be needed in transformed space here (logit
  // expands range away from saturation; σ² is robust).
  // The implementation may still apply the floor as belt-and-
  // suspenders; we don't assert its absence — only that σ² is finite
  // and meaningful.
});

test('Q2.A family-a calib: bounded_probability mid-range samples — logit handles 0.5 correctly', () => {
  // mid-range Bernoulli-like rate; logit(0.5) = 0
  const samples = Array.from({ length: 500 }, (_, i) => 0.5 + 0.05 * Math.sin(i));
  const out = buildFamilyAPerSignal(samples, 'bounded_probability');
  assert.equal(out.result.signal_class, 'bounded_probability');
  // logit(≈0.5) ≈ 0
  assert.ok(Math.abs(out.result.baseline_mean) < 0.5,
    `logit-space mean=${out.result.baseline_mean}; expected near 0`);
  // raw mean ≈ 0.5
  assert.ok(Math.abs((out.result.baseline_mean_raw ?? 0) - 0.5) < 0.01);
});

// ── (c) heavy_tail — multiplicative samples, log transform ────────

test('Q2.A family-a calib: heavy_tail — log handles multiplicative samples', () => {
  // cost_req-style: 0.005 × exp(0.1·U[0,1]); raw mean ≈ 0.005·e^0.05 ≈ 0.005256
  let s = 0xBEEF;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const samples = Array.from({ length: 1000 }, () => 0.005 * Math.exp(0.1 * rng()));
  const out = buildFamilyAPerSignal(samples, 'heavy_tail');

  assert.equal(out.result.signal_class, 'heavy_tail');
  // log-space mean ≈ log(0.005) + 0.05 ≈ -5.298 + 0.05 ≈ -5.248
  const expectedLogMean = Math.log(0.005) + 0.05;
  assert.ok(Math.abs(out.result.baseline_mean - expectedLogMean) < 0.05,
    `log-space mean=${out.result.baseline_mean}; expected ≈ ${expectedLogMean.toFixed(3)}`);
  // raw mean is the arithmetic mean of original samples
  assert.ok((out.result.baseline_mean_raw ?? 0) > 0.005);
  assert.ok((out.result.baseline_mean_raw ?? 0) < 0.0056);
  // log-space σ² well-conditioned
  assert.ok(out.result.baseline_sigma_squared > 1e-9);
});

// ── (d) counts — Anscombe stabilizer ──────────────────────────────

test('Q2.A family-a calib: counts — Anscombe stabilizes Poisson variance to ≈ 1', () => {
  // Approximate Poisson(λ=100) via rounding clipped Gaussian. Variance
  // of 2·sqrt(Y + 3/8) ≈ 1 for moderate λ — Anscombe's stabilizing
  // property.
  let s = 0xF00D;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Box-Muller for proper Gaussian, scaled to Poisson sd = √100 = 10.
  const lambda = 100;
  const samples: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const u = Math.max(rng(), 1e-9);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    samples.push(Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z)));
  }
  const out = buildFamilyAPerSignal(samples, 'counts');

  assert.equal(out.result.signal_class, 'counts');
  // Anscombe-transformed mean ≈ 2·√(100 + 3/8) ≈ 20.0375
  assert.ok(Math.abs(out.result.baseline_mean - 20) < 0.5,
    `Anscombe-space mean=${out.result.baseline_mean}; expected ≈ 20`);
  // Anscombe-transformed variance ≈ 1 for moderate λ
  assert.ok(Math.abs(out.result.baseline_sigma_squared - 1) < 0.3,
    `Anscombe-space σ²=${out.result.baseline_sigma_squared}; expected ≈ 1`);
});

// ── (e) baseline_mean_raw is always emitted ───────────────────────

test('Q2.A family-a calib: baseline_mean_raw emitted for all classes', () => {
  for (const cls of ['gaussian_like', 'bounded_probability', 'heavy_tail', 'counts'] as const) {
    const samples = [0.5, 0.5, 0.5, 0.5, 0.5];
    const out = buildFamilyAPerSignal(samples, cls);
    assert.ok(out.result.baseline_mean_raw !== undefined,
      `baseline_mean_raw missing for class=${cls}`);
    // Raw mean is always the arithmetic mean of original samples.
    assert.equal(out.result.baseline_mean_raw, 0.5,
      `baseline_mean_raw mismatch for class=${cls}`);
  }
});

// ── (f) signal_class is always stamped ────────────────────────────

test('Q2.A family-a calib: signal_class field stamped on all emits', () => {
  for (const cls of ['gaussian_like', 'bounded_probability', 'heavy_tail', 'counts'] as const) {
    const out = buildFamilyAPerSignal([0.5, 0.6, 0.7], cls);
    assert.equal(out.result.signal_class, cls);
  }
});

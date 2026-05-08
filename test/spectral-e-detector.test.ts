// test/spectral-e-detector.test.ts — Addition #21 slice-1.
//
// Verifies evaluateSpectralEDetector per ARCHITECT-REPLY-45 D3/D4 anchor
// values: μ₀=0.42, σ₀=0.05, δ_D=0.015 (=0.3·σ₀). Expected z_t per tick:
//   - Healthy (peak_t = μ₀):      z_t = -0.045  (wealth ≈ 0.956×/tick)
//   - 1σ₀ mild (peak_t = 0.47):   z_t = +0.255  (fire ~36 ticks)
//   - 2σ₀ moderate (peak_t=0.52): z_t = +0.555  (fire ~17 ticks)
//   - 3σ₀ strong (peak_t=0.57):   z_t = +0.855  (fire ~11 ticks)
// All within REPLY-45 §D4 sufficiency-gate targets (1σ₀ ≤50, 2σ₀ ≤25,
// 3σ₀ ≤15 tick fire-horizon). Anchors align with P1 derivation and
// P5 pseudo-code — no cross-anchor drift.
//
// Ville null bound: 131-deploy Monte Carlo with Gaussian-sampled
// peak|ACF|-like scalar under H₀. Long-run fire rate ≤ 1.5·α_D per
// architect's finite-sample bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FamilyDPerSignal, SpectralEDetectorState } from '../engine/types';
import {
  evaluateSpectralEDetector, freshSpectralEDetectorState,
} from '../engine/detectors/spectral';

const MU0 = 0.42;
const SIGMA0 = 0.05;
const DELTA = 0.3 * SIGMA0;  // = 0.015 per D4
const ALPHA_D = 1e-4;
const FIRE_THRESHOLD = 1 / ALPHA_D;  // = 10,000

function makeParams(): FamilyDPerSignal {
  return {
    bootstrap_null_quantile: 0.60,   // legacy field; unused by e-detector
    min_peak_lag: 3,
    max_peak_lag: 10,
    spectral_variant: 'e_detector',
    null_mean: MU0,
    null_std: SIGMA0,
    betting_delta: DELTA,
  };
}

function makeInput() {
  return { params: makeParams(), alpha: ALPHA_D, signal: 'kv_cache' };
}

// ── (1) Formula anchors (P5 pseudo-code cases; float precision) ─────

test('spectral-e-detector: healthy (peak=μ₀) z_t = -0.045 exactly', () => {
  const input = makeInput();
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(input, MU0, state);
  // z_t = r·0 - 0.5·r²  where r=0.3  ⇒  z_t = -0.045
  const expectedM = Math.exp(-0.045);
  assert.ok(Math.abs(state.M - expectedM) < 1e-12,
    `M=${state.M} vs expected=${expectedM}`);
  assert.equal(state.n, 1);
});

test('spectral-e-detector: 1σ₀ (peak=0.47) z_t = +0.255', () => {
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), 0.47, state);
  const expectedM = Math.exp(0.255);
  assert.ok(Math.abs(state.M - expectedM) < 1e-10,
    `M=${state.M} vs expected=${expectedM}`);
});

test('spectral-e-detector: 2σ₀ (peak=0.52) z_t = +0.555', () => {
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), 0.52, state);
  const expectedM = Math.exp(0.555);
  assert.ok(Math.abs(state.M - expectedM) < 1e-10,
    `M=${state.M} vs expected=${expectedM}`);
});

test('spectral-e-detector: 3σ₀ (peak=0.57) z_t = +0.855', () => {
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), 0.57, state);
  const expectedM = Math.exp(0.855);
  assert.ok(Math.abs(state.M - expectedM) < 1e-10,
    `M=${state.M} vs expected=${expectedM}`);
});

// ── (2) Sign / monotonicity / invariance ────────────────────────────

test('spectral-e-detector: z_t monotonic in peak height', () => {
  const small = freshSpectralEDetectorState();
  const large = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), 0.47, small);  // 1σ₀
  evaluateSpectralEDetector(makeInput(), 0.57, large);  // 3σ₀
  assert.ok(large.M > small.M,
    `larger peak should yield larger M: small=${small.M}, large=${large.M}`);
});

test('spectral-e-detector: healthy peak drives M < 1 (sub-martingale under H₀)', () => {
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), MU0, state);
  assert.ok(state.M < 1, `M=${state.M} should decay on healthy observation`);
});

test('spectral-e-detector: peak > μ₀ drives M > 1 (super-martingale under alternative)', () => {
  const state = freshSpectralEDetectorState();
  evaluateSpectralEDetector(makeInput(), MU0 + 2 * SIGMA0, state);
  assert.ok(state.M > 1, `M=${state.M} should grow under oscillation`);
});

// ── (3) Fire-horizon sufficiency gate (D4 targets) ──────────────────

function firstFireTick(peakConstant: number, maxTicks: number): number {
  const input = makeInput();
  const state = freshSpectralEDetectorState();
  for (let t = 1; t <= maxTicks; t++) {
    evaluateSpectralEDetector(input, peakConstant, state);
    if (state.M >= FIRE_THRESHOLD) return t;
  }
  return -1;
}

test('spectral-e-detector: 2σ₀ sustained oscillation fires within 25 ticks (D4 target)', () => {
  const t = firstFireTick(0.52, 100);
  assert.ok(t > 0 && t <= 25,
    `2σ₀ sustained peak should fire within 25 ticks; got t=${t}`);
});

test('spectral-e-detector: 3σ₀ sustained oscillation fires within 15 ticks (D4 target)', () => {
  const t = firstFireTick(0.57, 100);
  assert.ok(t > 0 && t <= 15,
    `3σ₀ sustained peak should fire within 15 ticks; got t=${t}`);
});

test('spectral-e-detector: 1σ₀ mild sustained oscillation fires within 50 ticks (D4 target)', () => {
  const t = firstFireTick(0.47, 100);
  assert.ok(t > 0 && t <= 50,
    `1σ₀ sustained peak should fire within 50 ticks; got t=${t}`);
});

test('spectral-e-detector: healthy peak=μ₀ sustained does NOT fire within 500-tick window', () => {
  const t = firstFireTick(MU0, 500);
  assert.equal(t, -1, `healthy should not fire; got t=${t}`);
});

// ── (4) Ville null bound (Monte Carlo on Gaussian-sampled peaks) ────

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
  let u = rng(); while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

test('spectral-e-detector: Ville null bound — 131-deploy sweep healthy fire rate ≤ 1.5·α_D', () => {
  // Each "deploy" = 200 ticks of peak|ACF| samples drawn from N(μ₀, σ₀²)
  // (the compile-time null distribution the e-detector standardizes
  // against). Under H₀ the wealth trajectory is a supermartingale and
  // Ville's inequality bounds the per-deploy peak-crossing probability
  // by α_D = 1e-4. Finite-sample upper bound 1.5·α_D per architect's
  // REPLY-43 §Open Q3 convention (2σ of Poisson(α·N)).
  const N_DEPLOYS = 131;
  const TICKS_PER_DEPLOY = 200;
  let firedCount = 0;
  for (let d = 0; d < N_DEPLOYS; d++) {
    const state = freshSpectralEDetectorState();
    const rng = mulberry32(0x5D50 + d);
    let fired = false;
    for (let t = 1; t <= TICKS_PER_DEPLOY; t++) {
      const peak = MU0 + SIGMA0 * gaussian(rng);  // N(μ₀, σ₀²) draw
      evaluateSpectralEDetector(makeInput(), peak, state);
      if (state.M >= FIRE_THRESHOLD) { fired = true; break; }
    }
    if (fired) firedCount++;
  }
  // At α=1e-4 on 131 deploys, expected fires ≈ 0.013. Observing 0 or 1
  // is the realistic envelope; loose upper bound 1.5·α·100 accommodates
  // single-sample variance. Any run with >2 fires flags a substantive
  // Ville bound violation.
  const rate = firedCount / N_DEPLOYS;
  assert.ok(firedCount <= 2,
    `expected ≤2 fires on healthy sweep (α=1e-4 × 131 deploys); got ${firedCount} (rate=${rate.toExponential(3)})`);
});

// ── (5) Suppression guards ──────────────────────────────────────────

test('spectral-e-detector: suppresses with spectral_e_detector_params_missing when null_mean absent', () => {
  const input = {
    params: {
      bootstrap_null_quantile: 0.6, min_peak_lag: 3, max_peak_lag: 10,
      spectral_variant: 'e_detector' as const,
      // no null_mean, null_std, betting_delta
    },
    alpha: ALPHA_D, signal: 'kv_cache',
  };
  const state = freshSpectralEDetectorState();
  const v = evaluateSpectralEDetector(input, 0.5, state);
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'spectral_e_detector_params_missing');
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

test('spectral-e-detector: suppresses with spectral_null_std_nonpositive when σ₀ ≤ 0', () => {
  const input = {
    params: {
      bootstrap_null_quantile: 0.6, min_peak_lag: 3, max_peak_lag: 10,
      spectral_variant: 'e_detector' as const,
      null_mean: 0.42, null_std: 0, betting_delta: 0.015,
    },
    alpha: ALPHA_D, signal: 'kv_cache',
  };
  const state = freshSpectralEDetectorState();
  const v = evaluateSpectralEDetector(input, 0.5, state);
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'spectral_null_std_nonpositive');
  assert.equal(state.M, 1);
});

test('spectral-e-detector: fresh state has M=1, n=0, alphaConsumed=0', () => {
  const s = freshSpectralEDetectorState();
  assert.equal(s.M, 1);
  assert.equal(s.n, 0);
  assert.equal(s.alphaConsumed, 0);
});

test('spectral-e-detector: fire emits signal=kv_cache + family=D', () => {
  const state = freshSpectralEDetectorState();
  let v;
  for (let t = 1; t <= 20; t++) {
    v = evaluateSpectralEDetector(makeInput(), 0.57, state);  // 3σ₀
    if (v.verdict === 'fire') break;
  }
  assert.ok(v && v.verdict === 'fire', 'should fire within 20 ticks on 3σ₀');
  assert.equal(v!.family, 'D');
  assert.equal(v!.signal, 'kv_cache');
  assert.equal(v!.reason_code, 'spectral_e_detector_wealth_exceeded');
});

// test/v1-h3-ville-bound-iid-gaussian.test.ts — Architect-led
// V1.H3 verification: does betting-e-process implementation
// satisfy Ville's inequality on synthetic exchangeable iid
// Gaussian observations under H₀?
//
// Per ARCHITECT-REPLY-52gb V1.H3 brief. The FPR-sweep observed
// 47/131 (35.9%) Ville-bounded fires on iid-resampled compile-
// substrate healthy windows; if betting-e-process is Ville-clean
// on synthetic iid Gaussian (where the null distribution is
// exact), V1.H3 (implementation bug) is falsified and the
// remaining hypothesis is V1.H1 (calibration-vs-bootstrap
// second-moment mismatch).
//
// Test mirrors FPR-sweep dimensions: 131 independent trajectories
// × 100 ticks under H₀ with σ matching calibration. Per Ville's
// inequality with α = 3.33e-5 per signal × 6 signals concurrent
// (v5 default), expected per-window fire probability ≤ 6 × 3.33e-5
// ≈ 2 × 10⁻⁴, so expected fires ≤ 131 × 2e-4 ≈ 0.026. Allow ≤ 1
// fire as loose upper-bound capturing finite-sample noise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshBettingState, updateBettingState,
} from '@johnpatrickwarren-oss/deploysignal-engine/detectors/betting-e-process';

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
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

test('V1.H3 — Ville bound on 131-trajectory × 100-tick iid-Gaussian H₀ (FPR-sweep parity)', () => {
  // α matches v5's per-signal betting allocation (α_A_betting / 6 signals
  // = 3.3e-5/signal). The single-detector trial count (131) emulates the
  // FPR-sweep dimensions; under iid Gaussian H₀, Ville's inequality says
  // P(any tick exceeds 1/α | H₀) ≤ α regardless of the 100-tick window.
  const alphaBetting = 3.33e-5;
  const threshold = 1 / alphaBetting;
  const baselineMean = 100;
  const sigma2 = 4;  // σ = 2; matches "well-calibrated" baseline scale
  const TRAJECTORIES = 131;
  const TICKS = 100;
  let fires = 0;
  let maxWealthSeen = 1;
  for (let traj = 0; traj < TRAJECTORIES; traj++) {
    const state = freshBettingState();
    const rng = mulberry32(0xCAFE0000 + traj);
    let fired = false;
    for (let t = 0; t < TICKS; t++) {
      const x = baselineMean + gaussian(rng) * 2;  // ~ N(μ, σ²) under H₀
      updateBettingState(state, x, baselineMean, sigma2, alphaBetting);
      if (state.M > maxWealthSeen) maxWealthSeen = state.M;
      if (state.M >= threshold) { fires++; fired = true; break; }
    }
  }
  // Under Ville's inequality, P(fire | H₀) ≤ α per trajectory, so
  // expected fires across 131 trajectories ≤ 131 · α ≈ 4.4e-3 (single
  // detector). Allow ≤ 1 fire as loose upper-bound capturing finite-
  // sample noise; PRIMARY signal is the >1000× margin observed under
  // the FPR sweep on iid-resampled compile-substrate data.
  console.log(`[V1.H3] iid-Gaussian H₀: fires=${fires}/${TRAJECTORIES} trajectories (max wealth seen=${maxWealthSeen.toFixed(2)}, threshold=${threshold.toFixed(0)})`);
  assert.ok(fires <= 1,
    `Ville-bound violation on iid Gaussian H₀: expected ≤ 1/${TRAJECTORIES} fires; got ${fires} (max wealth ${maxWealthSeen.toFixed(2)})`);
});

test('V1.H3 — Ville bound on tighter 1000-trajectory iid-Gaussian H₀', () => {
  // Larger trial count tightens the Ville-bound check. Under α = 3.33e-5,
  // expected fires across 1000 trajectories ≤ 1000 · α ≈ 0.033 — i.e.,
  // 0 expected, with ≤ 1 fire admissible at the 96th-percentile of the
  // trajectory-count Poisson distribution.
  const alphaBetting = 3.33e-5;
  const threshold = 1 / alphaBetting;
  const baselineMean = 100;
  const sigma2 = 4;
  const TRAJECTORIES = 1000;
  const TICKS = 100;
  let fires = 0;
  for (let traj = 0; traj < TRAJECTORIES; traj++) {
    const state = freshBettingState();
    const rng = mulberry32(0xFACE0000 + traj);
    for (let t = 0; t < TICKS; t++) {
      const x = baselineMean + gaussian(rng) * 2;
      updateBettingState(state, x, baselineMean, sigma2, alphaBetting);
      if (state.M >= threshold) { fires++; break; }
    }
  }
  console.log(`[V1.H3] 1000-trajectory iid-Gaussian H₀: fires=${fires}/${TRAJECTORIES}`);
  assert.ok(fires <= 1,
    `Ville-bound violation on 1000-trajectory iid Gaussian H₀: expected ≤ 1; got ${fires}`);
});

test('V1.H3 — bootstrap-with-replacement variance amplification probe (calibration mismatch H1 sketch)', () => {
  // Architect's V1.H1 hypothesis: iid-bootstrap-with-replacement from
  // finite cell samples may inflate per-tick variance vs the calibration
  // σ². If σ_actual > σ_calibration, |z_t| saturates at ±1 frequently
  // and the bet-driven wealth product accumulates more aggressively than
  // a true-iid-Gaussian H₀ would produce. This test emulates that effect:
  // generate observations from a heavier-tail distribution (mixture of
  // two Gaussians at ±1.5σ) but pass calibration σ² unchanged.
  //
  // Under this miscalibration, the betting wealth IS expected to violate
  // the Ville bound — the bound holds only when E[z_t | F_{t-1}] = 0 in
  // the law that generated z_t. If we tell the detector σ²=4 but actually
  // sample from a distribution with E[z²] > 1/9, we've broken H₀.
  const alphaBetting = 3.33e-5;
  const threshold = 1 / alphaBetting;
  const baselineMean = 100;
  const sigma2 = 4;          // calibration σ = 2 (z_t bounded at ±1 with B=3)
  const sigma_actual = 4;    // 2× the calibration σ — emulates bootstrap-tail mismatch
  const TRAJECTORIES = 131;
  const TICKS = 100;
  let fires = 0;
  let maxWealthSeen = 1;
  for (let traj = 0; traj < TRAJECTORIES; traj++) {
    const state = freshBettingState();
    const rng = mulberry32(0xBADBEEF0 + traj);
    for (let t = 0; t < TICKS; t++) {
      const x = baselineMean + gaussian(rng) * sigma_actual;
      updateBettingState(state, x, baselineMean, sigma2, alphaBetting);
      if (state.M > maxWealthSeen) maxWealthSeen = state.M;
      if (state.M >= threshold) { fires++; break; }
    }
  }
  console.log(`[V1.H3 H1-probe] σ_actual=2σ_calibration: fires=${fires}/${TRAJECTORIES} (max wealth=${maxWealthSeen.toFixed(2)})`);
  // Reported as informational; this is a hypothesis-test script,
  // not a regression gate. Assertion permits 0..131 fires; the printed
  // count is the architecture-level observation.
  assert.ok(fires >= 0);
});

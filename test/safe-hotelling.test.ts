// test/safe-hotelling.test.ts — Addition #20 slice-1 (ARCHITECT-REPLY-43 D4).
//
// Verifies `evaluateSafeHotelling`'s mixture-prior e-process wealth-update
// formula on analytically-derivable fixtures, rather than on architect-
// rough-arithmetic anchors from REPLY-43 §Pseudo-code.
//
// Rationale for anchor-free numeric assertions (TPM disposition
// approving Option (c), 2026-04-20 mid-session):
//   Architect's Practice-3 spot-check (precompiled_log_det_shrink ≈ 0.055
//   at τ²/λ ≈ 1%) and Practice-5 case-2 pseudo-code (z_t ≈ 0.445 requires
//   τ²/λ ≈ 6%) are internally inconsistent — a 17.82→17 rounding cascade
//   in the hand-compute inflated the diff 5×. Tests below lock in the
//   formula against self-derived analytic expectations on simple isotropic
//   fixtures; strict numeric anchors against synthetic-v1 deferred to
//   slice-2 empirical demo runs where precompiled_log_det_shrink is
//   computed from actual cell covariances.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FamilyCPerCell } from '../engine/types';
import { evaluateSafeHotelling, freshSafeHotellingState } from '../engine/detectors/hotelling';

/** Build a p-dim isotropic cell Σ = I_p with analytically-known
 *  `precompiled_log_det_shrink = ½ · p · log(1 + τ²)`. */
function isotropicCell(p: number, tauSquared: number): FamilyCPerCell {
  const cov: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    cov[i] = new Array(p).fill(0);
    cov[i][i] = 1;
  }
  return {
    mean_vector: new Array(p).fill(0),
    covariance: cov,
    hotelling_variant: 'safe_test',
    safe_hotelling_params: {
      tau_squared: tauSquared,
      alpha: 1e-4,
      precompiled_log_det_shrink: 0.5 * p * Math.log(1 + tauSquared),
      shrink_fraction: tauSquared,  // isotropic test fixture: τ²/(trace/p) = τ²/1 = τ²
    },
  };
}

// ── (1) Formula-correctness against analytic fixtures ───────────────

test('safe-Hotelling: x=0 → z_t = -precompiled_log_det_shrink exactly', () => {
  const p = 2;
  const tau2 = 0.01;
  const cell = isotropicCell(p, tau2);
  const state = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [0, 0], state);
  // z_t = -½ p log(1+τ²) = -½·2·log(1.01) ≈ -0.00995
  // M_1 = exp(z_t)
  const expectedM = Math.exp(-0.5 * p * Math.log(1 + tau2));
  assert.ok(Math.abs(state.M - expectedM) < 1e-12, `M=${state.M} vs expected=${expectedM}`);
  assert.equal(state.n, 1);
});

test('safe-Hotelling: x=[1,0] in 2-dim isotropic (τ²=0.01) matches analytic LLR', () => {
  const p = 2;
  const tau2 = 0.01;
  const cell = isotropicCell(p, tau2);
  const state = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [1, 0], state);
  // xᵀΣ⁻¹x = 1; xᵀ(Σ+τ²I)⁻¹x = 1/(1+τ²)
  // diff = 1 - 1/(1+τ²); ½·diff added to -precompiled_log_det_shrink
  const shrink = 0.5 * p * Math.log(1 + tau2);
  const qDiff = 1 - 1 / (1 + tau2);
  const expectedZ = -shrink + 0.5 * qDiff;
  const expectedM = Math.exp(expectedZ);
  assert.ok(Math.abs(state.M - expectedM) < 1e-12, `M=${state.M} vs expected=${expectedM}`);
});

test('safe-Hotelling: x=[3,3,0] in 3-dim isotropic (τ²=0.05) matches analytic LLR', () => {
  const p = 3;
  const tau2 = 0.05;
  const cell = isotropicCell(p, tau2);
  const state = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [3, 3, 0], state);
  // xᵀΣ⁻¹x = 18; xᵀ(Σ+τ²I)⁻¹x = 18/(1+τ²) = 18/1.05
  const shrink = 0.5 * p * Math.log(1 + tau2);
  const qDiff = 18 - 18 / (1 + tau2);
  const expectedZ = -shrink + 0.5 * qDiff;
  const expectedM = Math.exp(expectedZ);
  assert.ok(Math.abs(state.M - expectedM) < 1e-10, `M=${state.M} vs expected=${expectedM}`);
});

// ── (2) Sign / monotonicity / invariance (no strict numbers) ────────

test('safe-Hotelling: healthy x (near zero) drives M < 1 (sub-martingale under H₀)', () => {
  const cell = isotropicCell(3, 0.05);
  const state = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [0.05, -0.03, 0.02], state);
  assert.ok(state.M < 1, `M=${state.M} should decay on healthy observation`);
});

test('safe-Hotelling: moderate drift drives M > 1 (super-martingale under alternative)', () => {
  const cell = isotropicCell(3, 0.05);
  const state = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [3, 3, 0], state);
  assert.ok(state.M > 1, `M=${state.M} should grow on drifted observation`);
});

test('safe-Hotelling: z_t monotonic in shift magnitude', () => {
  const cell = isotropicCell(3, 0.05);
  const small = freshSafeHotellingState();
  const large = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [2, 2, 0], small);
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [3, 3, 0], large);
  assert.ok(large.M > small.M, `larger shift M=${large.M} should exceed smaller-shift M=${small.M}`);
});

test('safe-Hotelling: dimension-permutation invariance on isotropic Σ', () => {
  const cell = isotropicCell(3, 0.05);
  const a = freshSafeHotellingState();
  const b = freshSafeHotellingState();
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [3, 0, 0], a);
  evaluateSafeHotelling({ cell, alpha: 1e-4 }, [0, 3, 0], b);
  assert.ok(Math.abs(a.M - b.M) < 1e-12, `isotropic M permutation-invariant (a=${a.M}, b=${b.M})`);
});

// ── (3) Fire-within-reasonable-window (loose bound) ─────────────────

test('safe-Hotelling: fires within [1,50] ticks on 20-per-dim 2-dim shift', () => {
  const cell = isotropicCell(3, 0.05);
  const state = freshSafeHotellingState();
  let fireTick = -1;
  for (let t = 1; t <= 50; t++) {
    const v = evaluateSafeHotelling({ cell, alpha: 1e-4 }, [20, 20, 0], state);
    if (v.verdict === 'fire') { fireTick = t; break; }
  }
  assert.ok(fireTick >= 1 && fireTick <= 50,
    `fire within [1,50]; got t=${fireTick}, final M=${state.M}`);
});

// ── (4) Suppression paths (param/PSD guards) ────────────────────────

test('safe-Hotelling: suppresses with params_missing when safe_hotelling_params absent', () => {
  const cell: FamilyCPerCell = {
    mean_vector: [0, 0],
    covariance: [[1, 0], [0, 1]],
    // no safe_hotelling_params → dormant-add backward-compat path
  };
  const state = freshSafeHotellingState();
  const v = evaluateSafeHotelling({ cell, alpha: 1e-4 }, [1, 0], state);
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'safe_hotelling_params_missing');
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

test('safe-Hotelling: suppresses with covariance_singular on non-PSD Σ', () => {
  const cell: FamilyCPerCell = {
    mean_vector: [0, 0],
    covariance: [[-1, 0], [0, 1]],  // negative diagonal
    hotelling_variant: 'safe_test',
    safe_hotelling_params: {
      tau_squared: 0.01,
      alpha: 1e-4,
      precompiled_log_det_shrink: 0,
      shrink_fraction: 0.01,
    },
  };
  const state = freshSafeHotellingState();
  const v = evaluateSafeHotelling({ cell, alpha: 1e-4 }, [1, 0], state);
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'covariance_singular');
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

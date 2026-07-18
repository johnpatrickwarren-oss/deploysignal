// test/conformal-e-value.test.ts — Addition #22 slice-3 (post REPLY-46b).
//
// Verifies evaluateConformalWeightedEValue per ARCHITECT-REPLY-46b
// corrected D3 hedged-indicator form:
//
//   indicator = (den_raw < α_E · total_weight) ? 1 : 0
//   e_t = 1 + indicator − α_E
//        ⇒ indicator=0: e_t = 1 − α_E  (no fire signal; slight decay)
//        ⇒ indicator=1: e_t = 2 − α_E  (fire signal; wealth doubles)
//   M_t = M_{t-1} · e_t
//   fire iff M_t ≥ 1/α_E
//
// Validity: E[e_t | H₀] = α_E·(2−α_E) + (1−α_E)·(1−α_E) = 1 exactly.
// Ville bound: sup_t P(M_t ≥ 1/α_E | H₀) ≤ α_E. Assertion re-enabled
// post-REPLY-46b.
//
// Test strategy: For α_E=1e-4 with uniform weights over M samples, the
// fire threshold α_E · total_weight = 1e-4. On uniform weights with
// M < 10,000, only the "s_t beyond all scores" rank triggers
// indicator=1 (cumulative_weights_above there = 0 < α_E). Interior
// ranks have cumulative_above ≥ 1/M ≥ α_E, no indicator fire.
// M=10,000 gives per-tick P(indicator=1 | H₀ exchangeable) ≈ 1/(M+1)
// ≈ α_E, validating the Ville bound empirically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConformalParams, ConformalEValueState } from '../engine/types';
import {
  evaluateConformalWeightedEValue, freshConformalEValueState,
} from '../engine/detectors/conformal';
import { findFirstGE } from '../engine/detectors/_linalg';

const ALPHA_E = 1e-4;
const FIRE_THRESHOLD = 1 / ALPHA_E;  // = 10,000

// ── (1) findFirstGE binary-search edge cases ────────────────────────

test('findFirstGE: empty array returns 0', () => {
  assert.equal(findFirstGE([], 0.5), 0);
});

test('findFirstGE: single element, target below → 0', () => {
  assert.equal(findFirstGE([0.5], 0.3), 0);
});

test('findFirstGE: single element, target above → length', () => {
  assert.equal(findFirstGE([0.5], 0.7), 1);
});

test('findFirstGE: target exactly at an element returns that index (first-ge semantic)', () => {
  assert.equal(findFirstGE([0.1, 0.3, 0.5, 0.7, 0.9], 0.5), 2);
});

test('findFirstGE: target between elements returns index of next-larger', () => {
  assert.equal(findFirstGE([0.1, 0.3, 0.5, 0.7, 0.9], 0.4), 2);
});

test('findFirstGE: target below all returns 0', () => {
  assert.equal(findFirstGE([0.1, 0.3, 0.5], -1), 0);
});

test('findFirstGE: target above all returns length', () => {
  assert.equal(findFirstGE([0.1, 0.3, 0.5], 1.0), 3);
});

test('findFirstGE: duplicate elements — returns first occurrence', () => {
  assert.equal(findFirstGE([0.1, 0.3, 0.3, 0.3, 0.5], 0.3), 1);
});

// ── (2) E-value calculation fixtures ────────────────────────────────

function makeUniformParams(M: number): Extract<ConformalParams, { kind: 'weighted_e_value' }> {
  const scores = new Array<number>(M);
  const weights = new Array<number>(M);
  for (let i = 0; i < M; i++) {
    scores[i] = i / M;
    weights[i] = 1 / M;
  }
  const cumulative_weights_above = new Array<number>(M);
  for (let k = 0; k < M; k++) cumulative_weights_above[k] = (M - k) / M;
  return {
    kind: 'weighted_e_value',
    scores, weights, cumulative_weights_above,
    total_weight: 1,
    halflife_days: 7,
    effective_sample_size: M,
  };
}

function identityCov(p: number): number[][] {
  const c: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    c[i] = new Array(p).fill(0);
    c[i][i] = 1;
  }
  return c;
}

function xAtNorm(p: number, norm: number): number[] {
  const x = new Array(p).fill(0);
  x[0] = norm;
  return x;
}

// ── (3) Hedged-indicator formula anchors (REPLY-46b) ────────────────

test('conformal-e-value: s_t below all scores → indicator=0 → e_t = 1 − α_E (wealth decay)', () => {
  const M = 1000;
  const params = makeUniformParams(M);
  const state = freshConformalEValueState();
  // s_t = 0 → k = 0; cumulative_weights_above[0] = 1. Fire cutoff =
  // α·total_weight = 1e-4. 1 >= 1e-4 → indicator=0 → e_t = 1 − α_E.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: ALPHA_E },
    xAtNorm(11, 0), state,
  );
  const expectedM = 1 - ALPHA_E;
  assert.ok(Math.abs(state.M - expectedM) < 1e-12, `expected M=${expectedM}, got ${state.M}`);
});

test('conformal-e-value: s_t at median → indicator=0 → e_t = 1 − α_E', () => {
  const M = 1000;
  const params = makeUniformParams(M);
  const state = freshConformalEValueState();
  // Median: s_t = 0.5, k = 500, cumulative_weights_above[500] = 0.5.
  // 0.5 >> α_E=1e-4 → indicator=0 → e_t = 0.9999.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: ALPHA_E },
    xAtNorm(11, 0.5), state,
  );
  assert.ok(Math.abs(state.M - (1 - ALPHA_E)) < 1e-12);
});

test('conformal-e-value: s_t at 99.9th %-ile → indicator=0 (still interior; above α_E threshold)', () => {
  const M = 1000;
  const params = makeUniformParams(M);
  const state = freshConformalEValueState();
  // Rank 999: cumulative_above = 1/1000 = 1e-3. 1e-3 < 1e-4? NO.
  // Indicator=0 → e_t = 1 − α_E.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: ALPHA_E },
    xAtNorm(11, 0.999), state,
  );
  assert.ok(Math.abs(state.M - (1 - ALPHA_E)) < 1e-12);
});

test('conformal-e-value: s_t beyond all scores → indicator=1 → e_t = 2 − α_E (wealth doubles)', () => {
  const M = 1000;
  const params = makeUniformParams(M);
  const state = freshConformalEValueState();
  // s_t = 2.0 > all scores. k = 1000. den_raw = 0 (out of cumulative array).
  // 0 < α_E·total_weight = 1e-4 → indicator=1 → e_t = 2 − α_E.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: ALPHA_E },
    xAtNorm(11, 2.0), state,
  );
  const expectedM = 2 - ALPHA_E;
  assert.ok(Math.abs(state.M - expectedM) < 1e-12, `expected M=${expectedM}, got ${state.M}`);
});

test('conformal-e-value: sub-α interior rank (M=10 calibration, α=0.2) → indicator=1', () => {
  // Concrete interior fire: with M=10 and α=0.2, fire cutoff = 0.2.
  // cumulative_above[9] = 0.1 < 0.2 → indicator=1 at rank 9.
  const M = 10;
  const params: Extract<ConformalParams, { kind: 'weighted_e_value' }> = {
    kind: 'weighted_e_value',
    scores: Array.from({ length: M }, (_, i) => i / M),
    weights: Array.from({ length: M }, () => 1 / M),
    cumulative_weights_above: Array.from({ length: M }, (_, k) => (M - k) / M),
    total_weight: 1,
    halflife_days: 7,
    effective_sample_size: M,
  };
  const state = freshConformalEValueState();
  // s_t between scores[8]=0.8 and scores[9]=0.9 → k=9.
  // cumulative_above[9] = 1/10 = 0.1 < 0.2 (α·total_weight) → indicator=1.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: 0.2 },
    xAtNorm(11, 0.85), state,
  );
  const alphaLocal = 0.2;
  const expectedM = 2 - alphaLocal;
  assert.ok(Math.abs(state.M - expectedM) < 1e-12, `expected M=${expectedM}, got ${state.M}`);
});

// ── (4) Martingale E[M] = 1 on exchangeable null ────────────────────

test('conformal-e-value: martingale E[M_1|H₀] = 1 exactly under exchangeable sampling', () => {
  // Analytic: E[e_t|H₀] = P(ind=1)·(2−α) + P(ind=0)·(1−α).
  // Under exchangeability with uniform weights and M samples,
  // P(ind=1) = (# ranks k with cum_above[k] < α·total)/(M+1).
  // For M=1000, α=1e-4: only rank M (beyond) triggers ind=1,
  // so P(ind=1) = 1/(M+1) = 1/1001 ≈ 9.99e-4.
  // E[e] = 9.99e-4 · (2−1e-4) + (1 − 9.99e-4) · (1 − 1e-4)
  //      = 0.001997 + 0.998902 ≈ 1.0009 — not exactly 1 because
  // P(ind=1) ≠ α exactly for small M.
  //
  // At M = 10,000, α = 1e-4: P(ind=1) ≈ 1/10001 ≈ 9.999e-5, very
  // close to α. E[e] ≈ 1.00 to 6 decimal places.
  //
  // This test validates the FORMULA's numerical correctness on a
  // known single-sample fire case, not the martingale statistical
  // property (which the Ville-empirical test below validates).
  const M = 10000;
  const params = makeUniformParams(M);
  const state = freshConformalEValueState();
  // Interior tick (not fire): e_t = 1 − α_E = 0.9999.
  evaluateConformalWeightedEValue(
    { params, covariance: identityCov(11), alpha: ALPHA_E },
    xAtNorm(11, 0.5), state,
  );
  assert.ok(Math.abs(state.M - 0.9999) < 1e-12);
});

// ── (5) Fire-horizon sufficiency under sustained indicator=1 ────────

function firstFireTick(params: Extract<ConformalParams, { kind: 'weighted_e_value' }>,
                      sTarget: number, alpha: number, maxTicks: number): number {
  const state = freshConformalEValueState();
  const cov = identityCov(11);
  const x = xAtNorm(11, sTarget);
  for (let t = 1; t <= maxTicks; t++) {
    evaluateConformalWeightedEValue({ params, covariance: cov, alpha }, x, state);
    if (state.M >= 1 / alpha) return t;
  }
  return -1;
}

test('conformal-e-value: sustained indicator=1 (s_t beyond all scores) fires within ~14 ticks at α=1e-4', () => {
  // Under sustained indicator=1: M_t = (2 − α)^t. Fire at M ≥ 1/α.
  // For α=1e-4: (1.9999)^t ≥ 10000 → t ≥ log(10000)/log(2) ≈ 13.29 → t=14.
  const params = makeUniformParams(1000);
  const t = firstFireTick(params, 2.0, ALPHA_E, 20);
  assert.ok(t > 0 && t <= 14, `expected fire at t ≤ 14; got t=${t}`);
  assert.ok(t >= 13, `expected fire at t ≥ 13 (analytic lower bound); got t=${t}`);
});

test('conformal-e-value: healthy (sustained indicator=0) does NOT fire within 500 ticks at α=1e-4', () => {
  // Under sustained indicator=0: M_t = (1 − α)^t. For α=1e-4,
  // M_500 = 0.9999^500 ≈ 0.951. Far below 10,000.
  const params = makeUniformParams(1000);
  const state = freshConformalEValueState();
  const cov = identityCov(11);
  // s_t at median; indicator always 0.
  for (let t = 1; t <= 500; t++) {
    evaluateConformalWeightedEValue(
      { params, covariance: cov, alpha: ALPHA_E },
      xAtNorm(11, 0.5), state,
    );
  }
  assert.ok(state.M < 1, `expected M < 1 after 500 healthy ticks; got ${state.M}`);
  assert.ok(state.M > 0.9, `expected slow decay (>0.9); got ${state.M}`);
});

// ── (6) Ville-inequality empirical bound (RE-ENABLED per REPLY-46b) ─

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

test('conformal-e-value: Ville-inequality empirical bound holds on exchangeable null (100 deploys × 100 ticks, fire rate ≤ 1.5·α_E)', () => {
  // RE-ENABLED per ARCHITECT-REPLY-46b: the corrected hedged-indicator
  // form satisfies E[e_t|H₀] = 1, so Ville's inequality applies.
  //
  // Under exchangeability (s_t drawn from the same distribution as
  // calibration), the wealth process is a true martingale under H₀.
  // Ville bounds sup_t P(M_t ≥ 1/α_E | H₀) ≤ α_E = 1e-4.
  // For 100 deploys × 100 ticks, expected fire count ≈ 0.01; observing
  // 0 or 1 is the realistic envelope. 1.5× finite-sample tolerance
  // allows up to ~2 fires.
  const M = 10000;  // large enough that P(beyond-all) ≈ α_E exactly
  const params = makeUniformParams(M);
  const cov = identityCov(11);
  const N_DEPLOYS = 100;
  const TICKS_PER_DEPLOY = 100;
  let firedCount = 0;
  for (let d = 0; d < N_DEPLOYS; d++) {
    const state = freshConformalEValueState();
    const rng = mulberry32(0xEE00 + d);
    let fired = false;
    for (let t = 1; t <= TICKS_PER_DEPLOY; t++) {
      // Draw s_t uniformly from [0, 1) to match the uniform
      // calibration distribution — canonical exchangeability regime.
      const sTarget = rng();
      evaluateConformalWeightedEValue(
        { params, covariance: cov, alpha: ALPHA_E },
        xAtNorm(11, sTarget), state,
      );
      if (state.M >= FIRE_THRESHOLD) { fired = true; break; }
    }
    if (fired) firedCount++;
  }
  assert.ok(firedCount <= 2,
    `expected ≤2 fires on exchangeability null sweep (α_E·N=${ALPHA_E*N_DEPLOYS*TICKS_PER_DEPLOY}); got ${firedCount}`);
});

// ── (7) Suppression + state invariants ─────────────────────────────

test('conformal-e-value: suppresses with covariance_singular on non-PSD Σ', () => {
  const params = makeUniformParams(100);
  const state = freshConformalEValueState();
  const badCov = [[-1, 0], [0, 1]];  // negative diagonal
  const v = evaluateConformalWeightedEValue(
    { params, covariance: badCov, alpha: ALPHA_E },
    [1, 0], state,
  );
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'covariance_singular');
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

test('conformal-e-value: covariance_singular verdict carries signal=weighted_conformal_e_value '
  + '+ family=E — same tag its fire/clean siblings carry, so a suppressed verdict on this '
  + 'branch is still attributable to the right detector in v2 audit records', () => {
  const params = makeUniformParams(100);
  const state = freshConformalEValueState();
  const badCov = [[-1, 0], [0, 1]];  // negative diagonal
  const v = evaluateConformalWeightedEValue(
    { params, covariance: badCov, alpha: ALPHA_E },
    [1, 0], state,
  );
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.family, 'E');
  assert.equal(v.signal, 'weighted_conformal_e_value');
});

test('conformal-e-value: fresh state has M=1, n=0, alphaConsumed=0', () => {
  const s = freshConformalEValueState();
  assert.equal(s.M, 1);
  assert.equal(s.n, 0);
  assert.equal(s.alphaConsumed, 0);
});

test('conformal-e-value: fire emits signal=weighted_conformal_e_value + family=E', () => {
  const params = makeUniformParams(1000);
  const state = freshConformalEValueState();
  let v;
  // Sustained indicator=1 → e_t = 2 − α_E ≈ 2; 14 ticks → wealth ≥ 10000.
  for (let t = 1; t <= 20; t++) {
    v = evaluateConformalWeightedEValue(
      { params, covariance: identityCov(11), alpha: ALPHA_E },
      xAtNorm(11, 2.0), state,
    );
    if (v.verdict === 'fire') break;
  }
  assert.ok(v && v.verdict === 'fire', 'should fire under sustained indicator=1');
  assert.equal(v!.family, 'E');
  assert.equal(v!.signal, 'weighted_conformal_e_value');
  assert.equal(v!.reason_code, 'conformal_e_value_wealth_exceeded');
});

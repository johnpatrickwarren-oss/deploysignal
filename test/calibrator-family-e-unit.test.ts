// test/calibrator-family-e-unit.test.ts — End-phase slice 3c (D-54-3).
//
// Unit tests for tools/calibrators/family-e.ts in isolation. Verifies:
//   - 3-variant dispatch: unweighted / weighted / weighted_e_value.
//   - REPLY-38 Cluster 2 weighting-beneficial gate (span + ESS) routes
//     short-span / low-ESS baselines to unweighted.
//   - REPLY-46b hedged-indicator: reverse-cumulative weights precompute
//     matches the expected tail-sum formula.
//   - resolveFamilyEVariantSelector schema-migrates legacy
//     force_legacy_family_e boolean correctly.
//   - computeBaselineSpanDays / familyESeedForCell / expectedESSUnderUniformAge
//     return expected shapes for edge cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILY_E_CALIBRATION_SIZE,
  FAMILY_E_ESS_THRESHOLD,
  FAMILY_E_MIN_SPAN_DAYS,
  buildFamilyEPerCell,
  buildFamilyEPerCellUnweighted,
  resolveFamilyEVariantSelector,
  computeBaselineSpanDays,
  familyESeedForCell,
  expectedESSUnderUniformAge,
} from '../tools/calibrators/family-e.js';
import type { FamilyCPerCell } from '../engine/types';

/** Tiny test FamilyCPerCell fixture (well-conditioned 3×3 Σ). */
function fixture(): FamilyCPerCell {
  return {
    mean_vector: [1.0, 1.0, 1.0],
    covariance: [
      [1.0, 0.1, 0.0],
      [0.1, 1.0, 0.1],
      [0.0, 0.1, 1.0],
    ],
    covariance_method: 'ledoit_wolf',
    covariance_shrinkage: 0.05,
  };
}

// ── Variant dispatch ──────────────────────────────────────────────

test('family-e unit: force_unweighted emits unweighted variant', () => {
  const cp = buildFamilyEPerCell(fixture(), 42, 7, 30, 'force_unweighted');
  assert.ok(cp, 'result present');
  assert.equal(cp!.kind, 'unweighted');
});

test('family-e unit: force_weighted falls back to unweighted under default ESS heuristic', () => {
  // Under proposedHalflife=min(spanDays/2,14), λs stays ≥ 2·log(2) ≈ 1.386
  // for all reasonable spans, producing ESS ≈ 0.866·M — below the 0.9·M
  // threshold. So both 'auto' and 'force_weighted' route to unweighted
  // in practice; force_weighted_e_value is the only selector that
  // reliably emits the weighted-e-value path.
  const cp = buildFamilyEPerCell(fixture(), 43, 7, 30, 'force_weighted');
  assert.ok(cp);
  assert.equal(cp!.kind, 'unweighted',
    'force_weighted + default ESS gate fails → unweighted fallback');
});

test('family-e unit: auto routes to unweighted when ESS gate fails', () => {
  const cp = buildFamilyEPerCell(fixture(), 44, 14, 30, 'auto');
  assert.ok(cp);
  // Default ESS gate fails → unweighted fallback.
  assert.equal(cp!.kind, 'unweighted');
});

test('family-e unit: short-span baseline falls back to unweighted under auto', () => {
  // spanDays < FAMILY_E_MIN_SPAN_DAYS (7) → unweighted regardless of halflife.
  const cp = buildFamilyEPerCell(fixture(), 45, 3, 3, 'auto');
  assert.ok(cp);
  assert.equal(cp!.kind, 'unweighted');
});

test('family-e unit: force_weighted_e_value bypasses ESS+span gate (emits weighted_e_value on short span)', () => {
  // Even at short span, force_weighted_e_value keeps the weighted path.
  const cp = buildFamilyEPerCell(fixture(), 46, 3, 3, 'force_weighted_e_value');
  assert.ok(cp);
  assert.equal(cp!.kind, 'weighted_e_value');
});

// ── REPLY-46b hedged-indicator: cumulative_weights_above ─────────

test('family-e unit: weighted_e_value cumulative_weights_above is reverse-cumulative sum', () => {
  const cp = buildFamilyEPerCell(fixture(), 47, 14, 30, 'force_weighted_e_value');
  assert.ok(cp);
  assert.equal(cp!.kind, 'weighted_e_value');
  if (cp!.kind !== 'weighted_e_value') return;
  const M = cp!.weights.length;
  assert.equal(M, FAMILY_E_CALIBRATION_SIZE);
  // cumulative_weights_above[k] = Σ_{j≥k} weights[j]
  // Last element should equal weights[M-1].
  assert.ok(Math.abs(cp!.cumulative_weights_above[M - 1] - cp!.weights[M - 1]) < 1e-9);
  // First element should equal total_weight.
  assert.ok(Math.abs(cp!.cumulative_weights_above[0] - cp!.total_weight) < 1e-6);
  // Verify reverse-cumulative property at a spot-check index.
  const k = 100;
  let expected = 0;
  for (let j = k; j < M; j++) expected += cp!.weights[j];
  assert.ok(Math.abs(cp!.cumulative_weights_above[k] - expected) < 1e-6);
});

test('family-e unit: unweighted calibration_scores sorted ascending', () => {
  const cp = buildFamilyEPerCellUnweighted(fixture(), 48);
  assert.ok(cp);
  if (cp!.kind !== 'unweighted') return;
  const scores = cp!.calibration_scores;
  assert.equal(scores.length, FAMILY_E_CALIBRATION_SIZE);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1], `scores unsorted at idx ${i}`);
  }
  // Scores are Mahalanobis-like norms — all non-negative.
  assert.ok(scores[0] >= 0);
});

// ── Variant selector resolution ──────────────────────────────────

test('family-e unit: resolveFamilyEVariantSelector prefers explicit selector', () => {
  assert.equal(
    resolveFamilyEVariantSelector({ family_E_variant_selector: 'force_unweighted' }),
    'force_unweighted',
  );
  assert.equal(
    resolveFamilyEVariantSelector({ family_E_variant_selector: 'force_weighted_e_value' }),
    'force_weighted_e_value',
  );
});

test('family-e unit: resolveFamilyEVariantSelector migrates legacy force_legacy_family_e', () => {
  assert.equal(resolveFamilyEVariantSelector({ force_legacy_family_e: true }), 'force_weighted');
  assert.equal(resolveFamilyEVariantSelector({ force_legacy_family_e: false }), 'auto');
});

test('family-e unit: resolveFamilyEVariantSelector defaults to auto when neither field present', () => {
  assert.equal(resolveFamilyEVariantSelector({}), 'auto');
});

test('family-e unit: explicit selector overrides legacy boolean', () => {
  assert.equal(
    resolveFamilyEVariantSelector({
      family_E_variant_selector: 'force_unweighted',
      force_legacy_family_e: true,
    }),
    'force_unweighted',
  );
});

// ── Helpers ──────────────────────────────────────────────────────

test('family-e unit: expectedESSUnderUniformAge degenerates to M at λ=0', () => {
  const M = FAMILY_E_CALIBRATION_SIZE;
  assert.ok(Math.abs(expectedESSUnderUniformAge(0, 10, M) - M) < 1e-6);
});

test('family-e unit: expectedESSUnderUniformAge monotone decreasing in λs', () => {
  const M = FAMILY_E_CALIBRATION_SIZE;
  const ess1 = expectedESSUnderUniformAge(0.01, 10, M);
  const ess2 = expectedESSUnderUniformAge(0.1, 10, M);
  const ess3 = expectedESSUnderUniformAge(1.0, 10, M);
  assert.ok(ess1 > ess2, `ess(0.01) ${ess1} > ess(0.1) ${ess2}`);
  assert.ok(ess2 > ess3, `ess(0.1) ${ess2} > ess(1.0) ${ess3}`);
});

test('family-e unit: familyESeedForCell is deterministic and key-sensitive', () => {
  const k1 = { hour_of_day: 0, day_of_week: 0 };
  const k2 = { hour_of_day: 0, day_of_week: 0 };
  const k3 = { hour_of_day: 1, day_of_week: 0 };
  assert.equal(familyESeedForCell(k1), familyESeedForCell(k2));
  assert.notEqual(familyESeedForCell(k1), familyESeedForCell(k3));
});

test('family-e unit: computeBaselineSpanDays returns ticks/24 with fallback of 14', () => {
  const bundle = {
    version: 'test', seed: 0, n_runs: 1, ticks_per_run: 48,
    signals: ['x'], runs: [{ signal_series: { x: new Array(48).fill(0) } }],
  } as unknown as Parameters<typeof computeBaselineSpanDays>[0];
  assert.equal(computeBaselineSpanDays(bundle), 2);  // 48/24
  const empty = {
    version: 'empty', seed: 0, n_runs: 0, ticks_per_run: 0, signals: [], runs: [],
  } as unknown as Parameters<typeof computeBaselineSpanDays>[0];
  assert.equal(computeBaselineSpanDays(empty), 14);  // fallback
});

test('family-e unit: constants match architect-specified values', () => {
  assert.equal(FAMILY_E_CALIBRATION_SIZE, 20000);
  assert.equal(FAMILY_E_ESS_THRESHOLD, 0.9);
  assert.equal(FAMILY_E_MIN_SPAN_DAYS, 7);
});

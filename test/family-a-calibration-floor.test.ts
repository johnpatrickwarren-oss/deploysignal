// test/family-a-calibration-floor.test.ts — V1.H1 P1 calibration
// variance floor regression test per ARCHITECT-REPLY-52ge §128-178.
//
// Three cases (architect spec verbatim):
//   1. Bounded-probability saturated (P1 floor triggers; σ² ≥ floor).
//   2. Non-degenerate signal (P1 floor inactive; empirical variance preserved).
//   3. Identical-samples edge case (FP underflow protection).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  meanStd, buildFamilyAPerSignal, SIGMA_SQUARED_FLOOR_CV_SQUARED,
} from '../tools/calibrators/family-a.js';

test('P1 floor: bounded-probability saturated — σ² ≥ floor and sigma_floor_applied=true', () => {
  // Mirrors tool_success_rate's per-cell sample distribution at
  // saturated cells: 999/1000 observations exactly at 1.0, one
  // observation at 0.99. Empirical σ² is below the floor, so the
  // floor must engage.
  const samples = [...Array(999).fill(1.0), 0.99];
  const { mean, std, sigma_floor_applied } = meanStd(samples);
  const sigma2 = std * std;
  const muSquared = mean * mean;
  const expectedFloor = Math.max(
    Number.EPSILON * muSquared,
    SIGMA_SQUARED_FLOOR_CV_SQUARED * muSquared,
  );
  assert.equal(sigma_floor_applied, true,
    `floor must engage on bounded-probability saturated; got applied=${sigma_floor_applied}`);
  assert.ok(sigma2 >= expectedFloor,
    `sigma² (${sigma2}) must be ≥ floor (${expectedFloor})`);
  // Also assert the floor matches the formula (within fp tolerance):
  // for μ ≈ 0.99999, floor = 1e-6 · μ² ≈ 1e-6.
  const floorRel = SIGMA_SQUARED_FLOOR_CV_SQUARED * muSquared;
  assert.ok(Math.abs(sigma2 - floorRel) / floorRel < 1e-6,
    `sigma² should equal floor exactly when empirical is below; got sigma²=${sigma2}, expected ≈ ${floorRel}`);

  // Verify buildFamilyAPerSignal propagates the audit field.
  const built = buildFamilyAPerSignal(samples).result;
  assert.equal(built.sigma_floor_applied, true,
    'buildFamilyAPerSignal must set sigma_floor_applied=true on floored cells');
});

test('P1 floor: non-degenerate signal — empirical variance preserved', () => {
  // Mirrors p99_latency-style cell: μ ≈ 200, σ ≈ 5 (cv ≈ 2.5e-2),
  // well above the 1e-3 cv floor. Floor must NOT engage; empirical
  // variance must round-trip.
  const rng = (() => {
    let s = 0xC0DE;
    return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  })();
  const samples = Array.from({ length: 1000 },
    () => 200 + 5 * (rng() - 0.5) * 2);
  const { mean, std, sigma_floor_applied } = meanStd(samples);
  const sigma2 = std * std;
  const cv = std / Math.abs(mean);
  assert.equal(sigma_floor_applied, false,
    `floor must NOT engage on non-degenerate signal; got applied=${sigma_floor_applied}`);
  // cv should be in the [1e-4, 1e-2] band per architect spec
  // (uniform sample on ±5 around 200 → σ ≈ 5/√3 ≈ 2.89, cv ≈ 1.4·10⁻²).
  assert.ok(cv > 1e-4 && cv < 1e-1,
    `cv (${cv}) should be in (1e-4, 1e-1) band for non-degenerate signal`);
  // The empirical variance must round-trip (within fp): floor was inactive,
  // so std² should equal sample-variance modulo Math.sqrt-and-square fp.
  const empVariance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / samples.length;
  assert.ok(Math.abs(sigma2 - empVariance) / empVariance < 1e-9,
    `non-degenerate sigma² (${sigma2}) should equal empirical (${empVariance})`);

  const built = buildFamilyAPerSignal(samples).result;
  assert.equal(built.sigma_floor_applied, undefined,
    'buildFamilyAPerSignal must omit sigma_floor_applied on non-floored cells');
});

test('P1 floor: identical samples edge case — FP underflow protection', () => {
  // All-identical observations would give variance = 0 in pre-floor
  // implementation, breaking the betting-e-process bounded-z scaling
  // (division by zero in the runtime). The floor must keep σ² > 0.
  const samples = Array(1000).fill(1.0);
  const { mean, std, sigma_floor_applied } = meanStd(samples);
  const sigma2 = std * std;
  assert.equal(mean, 1.0, 'mean of all-1.0 samples must be 1.0');
  assert.equal(sigma_floor_applied, true,
    'floor must engage on identical-sample edge case');
  assert.ok(sigma2 > 0,
    `sigma² must be strictly positive after floor; got ${sigma2}`);
  // Floor formula at μ=1 gives 1e-6 (or ε_f if larger; ε_f ≈ 2.2e-16).
  const muSquared = mean * mean;
  const expectedFloor = Math.max(
    Number.EPSILON * muSquared,
    SIGMA_SQUARED_FLOOR_CV_SQUARED * muSquared,
  );
  assert.ok(Math.abs(sigma2 - expectedFloor) / expectedFloor < 1e-6,
    `sigma² (${sigma2}) should equal floor (${expectedFloor}) on identical-sample edge`);
});

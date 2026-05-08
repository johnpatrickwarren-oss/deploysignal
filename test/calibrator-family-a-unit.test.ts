// test/calibrator-family-a-unit.test.ts — End-phase slice 3c (D-54-3).
//
// Unit tests for tools/calibrators/family-a.ts in isolation. Verifies
// the Option 3 { result, timings } return shape + numerical
// correctness of the mixture-prior parameter derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFamilyAPerSignal,
  meanStd,
  TAU_SQUARED_DIV,
} from '../tools/calibrators/family-a.js';

test('family-a unit: return carries { result, timings: { tau2_fit_ns } }', () => {
  const { result, timings } = buildFamilyAPerSignal([100, 105, 98, 102, 95, 103]);
  assert.ok(result, 'result present');
  assert.ok(timings, 'timings present');
  assert.ok(typeof timings.tau2_fit_ns === 'bigint', 'tau2_fit_ns is bigint');
  assert.ok(timings.tau2_fit_ns >= 0n, 'tau2_fit_ns ≥ 0');
});

test('family-a unit: baseline_mean + baseline_sigma_squared match meanStd', () => {
  const samples = [10, 20, 30, 40, 50];
  const { mean, std } = meanStd(samples);
  const { result } = buildFamilyAPerSignal(samples);
  assert.ok(Math.abs(result.baseline_mean - mean) < 1e-12);
  assert.ok(Math.abs(result.baseline_sigma_squared - std * std) < 1e-12);
});

test('family-a unit: delta_min = max(0.05·mean, 2·std)', () => {
  // Case A: practical-significance floor (0.05·mean dominates).
  //   mean=100, std=0.1  →  0.05·100 = 5;  2·0.1 = 0.2  →  δ_min = 5.
  const resA = buildFamilyAPerSignal(Array.from({ length: 50 }, (_, i) => 100 + 0.1 * Math.sin(i)));
  assert.ok(resA.result.delta_min >= 5 - 0.01);

  // Case B: noise floor dominates (2·std > 0.05·mean).
  //   mean=1, std=1    →  0.05·1 = 0.05;  2·1 = 2  →  δ_min = 2.
  const samples = [-1, 1, -1, 1, -1, 1, -1, 1];
  const { mean, std } = meanStd(samples);
  const resB = buildFamilyAPerSignal(samples);
  const expected = Math.max(0.05 * mean, 2 * std);
  assert.ok(Math.abs(resB.result.delta_min - expected) < 1e-9);
});

test('family-a unit: tau_squared = delta_min² / TAU_SQUARED_DIV', () => {
  assert.equal(TAU_SQUARED_DIV, 4);
  const samples = [100, 102, 98, 101, 99, 100];
  const { result } = buildFamilyAPerSignal(samples);
  const expected = (result.delta_min * result.delta_min) / TAU_SQUARED_DIV;
  assert.ok(Math.abs(result.tau_squared - expected) < 1e-12);
});

test('family-a unit: empty sample array degenerates to zero mean/std', () => {
  const { result } = buildFamilyAPerSignal([]);
  assert.equal(result.baseline_mean, 0);
  assert.equal(result.baseline_sigma_squared, 0);
});

test('family-a unit: meanStd matches independent computation', () => {
  const xs = [1, 2, 3, 4, 5];
  const { mean, std } = meanStd(xs);
  const expectedMean = 3;
  let variance = 0;
  for (const x of xs) variance += (x - expectedMean) ** 2;
  const expectedStd = Math.sqrt(variance / xs.length);
  assert.ok(Math.abs(mean - expectedMean) < 1e-12);
  assert.ok(Math.abs(std - expectedStd) < 1e-12);
});

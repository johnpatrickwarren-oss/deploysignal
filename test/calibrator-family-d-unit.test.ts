// test/calibrator-family-d-unit.test.ts — End-phase slice 3c (D-54-3).
//
// Unit tests for tools/calibrators/family-d.ts in isolation. Verifies
// the Option 3 { result, timings } return shape + ACF-based spectral
// null-bootstrap properties.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFamilyDForSignal, FAMILY_D_E_DETECTOR_RETIRED,
  acfAtLag,
  peakAbsACF,
  FAMILY_D_BOOTSTRAP_SEED,
} from '../tools/calibrators/family-d.js';

/** Tiny mulberry32 for deterministic test input generation. */
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

// ── Return-shape + short-sample degeneration ──────────────────────

test('family-d unit: return carries { result, timings } shape', () => {
  const samples = Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.1) + 0.01 * i);
  const out = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(out, 'return value present');
  assert.ok('result' in out, 'result key present');
  assert.ok('timings' in out, 'timings key present');
  assert.ok(out.result, 'result populated');
});

test('family-d unit: fewer than 200 samples returns null result', () => {
  const { result } = buildFamilyDForSignal([1, 2, 3, 4, 5], 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.equal(result, null);
});

// ── Variant switch ─────────────────────────────────────────────────

test('family-d unit: useLegacy=true emits spectral_variant=bootstrap_null', () => {
  const samples = Array.from({ length: 500 }, () => Math.random());
  const { result } = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, true);
  assert.ok(result);
  assert.equal(result!.spectral_variant, 'bootstrap_null');
});

// C53 retirement (2026-08-18): the e_detector variant no longer ships. The AR(1)-aware
// calibrator supplies per-trajectory-MAX moments where the runtime standardizes single
// evaluations, and the pinned runtime (v0.6.6-pre) predates both the disjoint-cadence fix
// (engine d3d6d06) and the priced c-bound (bb56070) — correct moments on that runtime would
// false-fire on 28.6% of healthy 300-tick trajectories at the shipped threshold
// (knowledge/stats/family-d-emean-2026-08-18). Reversal is FAMILY_D_E_DETECTOR_RETIRED,
// gated on an engine re-pin plus a registered study.

test('family-d unit: useLegacy=false ALSO emits bootstrap_null while the e_detector variant is retired', () => {
  const samples = Array.from({ length: 500 }, () => Math.random());
  const { result } = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(result);
  assert.equal(result!.spectral_variant, 'bootstrap_null');
});

test('family-d unit: the retirement is one greppable constant, currently true', () => {
  assert.equal(FAMILY_D_E_DETECTOR_RETIRED, true);
});

test('family-d unit: betting_delta = 0.3 · null_std (REPLY-45 D4)', () => {
  const samples = Array.from({ length: 500 }, () => Math.random());
  const { result } = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(result);
  if (!result) return;
  const betting = result.betting_delta ?? 0;
  const nullStd = result.null_std ?? 0;
  assert.ok(Math.abs(betting - 0.3 * nullStd) < 1e-9);
});

test('family-d unit: bootstrap_null_quantile lies between 0 and 1', () => {
  const samples = Array.from({ length: 500 }, () => Math.random());
  const { result } = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(result);
  assert.ok(result!.bootstrap_null_quantile >= 0 && result!.bootstrap_null_quantile <= 1,
    `null_quantile=${result!.bootstrap_null_quantile}`);
});

test('family-d unit: min/max_peak_lag match architect-pinned defaults', () => {
  const samples = Array.from({ length: 500 }, () => Math.random());
  const { result } = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(result);
  assert.equal(result!.min_peak_lag, 3);
  assert.equal(result!.max_peak_lag, 10);
});

// ── Determinism ────────────────────────────────────────────────────

test('family-d unit: same seed → identical result (deterministic)', () => {
  const samples = Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.1));
  const a = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  const b = buildFamilyDForSignal(samples, 1e-4, FAMILY_D_BOOTSTRAP_SEED, false);
  assert.ok(a.result && b.result);
  assert.equal(a.result!.bootstrap_null_quantile, b.result!.bootstrap_null_quantile);
  assert.equal(a.result!.null_mean, b.result!.null_mean);
  assert.equal(a.result!.null_std, b.result!.null_std);
});

test('family-d unit: different seed → different bootstrap null quantile', () => {
  const samples = Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.1));
  const a = buildFamilyDForSignal(samples, 1e-4, 0xAAAA, false);
  const b = buildFamilyDForSignal(samples, 1e-4, 0xBBBB, false);
  assert.ok(a.result && b.result);
  // High-probability property, not guaranteed — but on 2000 bootstraps
  // the chance of exact equality on two different seeds is effectively 0.
  assert.notEqual(a.result!.bootstrap_null_quantile, b.result!.bootstrap_null_quantile);
});

// ── ACF helpers ────────────────────────────────────────────────────

test('family-d unit: acfAtLag(y, 0 or ≥ N) returns 0', () => {
  const y = [1, 2, 3, 4, 5];
  assert.equal(acfAtLag(y, 0), 0);
  assert.equal(acfAtLag(y, 5), 0);
  assert.equal(acfAtLag(y, 100), 0);
});

test('family-d unit: peakAbsACF over empty lag range is 0', () => {
  const y = Array.from({ length: 20 }, (_, i) => i);
  // minLag > maxLag → loop skips.
  assert.equal(peakAbsACF(y, 10, 5), 0);
});

test('family-d unit: peakAbsACF on periodic signal is near 1', () => {
  // Pure sine wave with period 6 → peak ACF at lag 6 ≈ 1.
  const y: number[] = [];
  for (let i = 0; i < 200; i++) y.push(Math.sin(2 * Math.PI * i / 6));
  const peak = peakAbsACF(y, 3, 10);
  assert.ok(peak > 0.9, `expected near-1 peak on period-6 sine; got ${peak}`);
});

test('family-d unit: peakAbsACF on white noise is modest (< 0.5 at 500 samples)', () => {
  const rng = mulberry32(0x42);
  const y: number[] = [];
  for (let i = 0; i < 500; i++) y.push(rng() - 0.5);
  const peak = peakAbsACF(y, 3, 10);
  assert.ok(peak < 0.5, `white noise peak should be small; got ${peak}`);
});

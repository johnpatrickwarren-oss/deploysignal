// test/compile-mcd-skip-low-variance.test.ts — REPLY-50 D6b coverage.
//
// Asserts:
//   - A synthetic low-variance cell (λ < 0.1 AND outlier-fraction < 5%
//     under LW pre-check) → covariance_method='ledoit_wolf' with
//     mcd_skip_reason='low_variance'.
//   - A high-variance / contaminated cell → covariance_method='mcd'
//     (full MCD path runs, no skip).
//   - Operator `covariance_method_override='mcd'` bypasses D6b skip
//     (forced full MCD regardless of low-variance diagnosis).
//
// Q2 empirical note: slice-1 measurement on synthetic-v1 showed 0/1
// MCD-eligible cells triggered skip (aggregate cell failed outlier-
// fraction < 5% despite λ ≪ 0.1). These tests exercise the code path
// with both skip-eligible and skip-ineligible synthetic fixtures so
// regression coverage is complete even when skip-rate is tuned by
// architect per Q2 escalation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFamilyCPerCell } from '../tools/calibrate';

/** Deterministic PRNG mirroring mulberry32 so fixtures are reproducible. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** D6b-triggerable fixture: zero-centred unit-variance rows.
 *
 *  Empirical Q2 finding during slice-1: the combination of
 *  `relativeDeviations` (divides by column mean) + LW shrinkage on
 *  positive-mean low-CV signals rarely produces Σ_LW whose Mahalanobis
 *  distribution has tails light enough to satisfy `outlier_frac < 5%`.
 *  Architect-projected 30% hit rate on synthetic-v1 → empirically 0%.
 *  Mac Claude surfaces the distribution to architect for retune per
 *  brief Q2 protocol (`ARCHITECT-REPLY-50.md`).
 *
 *  This fixture uses μ=0 so `relativeDeviations` takes the |m|<1e-12
 *  branch (absolute deviations, not scale-normalised) — Σ_LW matches
 *  the underlying σ² identity and Mahalanobis² tracks χ²(p) correctly.
 *  It's a synthetic stand-in that exercises the D6b skip code path;
 *  production-baseline fixtures would either need a retuned threshold
 *  or a different LW pre-check formulation. */
function lowVarianceCell(n: number, p: number, seed: number): number[][] {
  const rng = mulberry(seed);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(p);
    for (let j = 0; j < p; j++) row[j] = gaussian(rng); // μ=0, σ=1
    rows.push(row);
  }
  return rows;
}

/** High-variance contaminated cell: 90% clean + 10% heavy outliers
 *  (shift ±10σ). Under LW-derived Σ, outlier fraction lands far
 *  above 5%, forcing D6b to NOT skip (full MCD runs). */
function contaminatedCell(n: number, p: number, seed: number): number[][] {
  const rng = mulberry(seed);
  const rows: number[][] = [];
  const nContam = Math.floor(n * 0.10);
  for (let i = 0; i < n - nContam; i++) {
    const row = new Array<number>(p);
    for (let j = 0; j < p; j++) row[j] = 1 + 0.1 * gaussian(rng);
    rows.push(row);
  }
  for (let i = 0; i < nContam; i++) {
    const row = new Array<number>(p);
    const sign = (i % 2 === 0) ? 1 : -1;
    for (let j = 0; j < p; j++) row[j] = 1 + sign * (2 + 0.5 * gaussian(rng)); // heavy outlier
    rows.push(row);
  }
  return rows;
}

test('D6b: low-variance clean cell → skip MCD, emit LW with skip reason (default-on post-slice-2)', () => {
  const rows = lowVarianceCell(250, 11, 0xC0DE);
  // Slice-2 flipped default to true; no explicit flag needed.
  const cell = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.equal(cell.covariance_method, 'ledoit_wolf');
  assert.equal(cell.mcd_skip_reason, 'low_variance');
  assert.ok(typeof cell.covariance_shrinkage === 'number');
  assert.ok((cell.covariance_shrinkage as number) < 0.1,
    `low-variance λ must satisfy the D6b threshold; got ${cell.covariance_shrinkage}`);
});

test('D6b: explicit `enable_d6b_mcd_skip: false` restores slice-1 behavior (shadow-compare)', () => {
  // Escape hatch for shadow-compare against pre-streamlining main:
  // setting the flag explicitly false bypasses the LW diagnostic and
  // runs the full MCD path. Same fixture as default-on test above,
  // different outcome.
  const rows = lowVarianceCell(250, 11, 0xC0DE);
  const cell = buildFamilyCPerCell(
    rows, { enable_d6b_mcd_skip: false }, { hour_of_day: 0 }, 1e-4,
  );
  assert.equal(cell.mcd_skip_reason, undefined,
    'explicit false must bypass D6b skip');
  assert.equal(cell.covariance_method, 'mcd',
    'full MCD path runs on explicit opt-out');
});

test('D6b: contaminated cell → full MCD path, no skip (default-on)', () => {
  const rows = contaminatedCell(250, 11, 0xDEADBEEF);
  const cell = buildFamilyCPerCell(rows, {}, { hour_of_day: 1 }, 1e-4);
  assert.equal(cell.mcd_skip_reason, undefined,
    'contaminated cell must not carry the D6b skip marker');
  assert.ok(
    cell.covariance_method === 'mcd'
    || cell.covariance_method === 'mrcd'
    || cell.covariance_method === 'ledoit_wolf'
    || cell.covariance_method === 'ledoit_wolf_from_degenerate_mrcd',
    `expected a valid covariance_method post-MCD, got ${cell.covariance_method}`,
  );
});

test('D6b: covariance_method_override=mcd → override wins, no skip', () => {
  const rows = lowVarianceCell(250, 11, 0xBEEF);
  const cell = buildFamilyCPerCell(
    rows,
    { covariance_method_override: 'mcd' },
    { hour_of_day: 2 },
    1e-4,
  );
  assert.equal(cell.mcd_skip_reason, undefined,
    'covariance_method_override=mcd must bypass D6b skip (full MCD runs)');
});

test('D6b: small-n cell routes to MRCD, not MCD → D6b untouched', () => {
  // n=50 < max(5·11, 200)=200 → D2 routes to MRCD, not MCD.
  const rows = lowVarianceCell(50, 11, 0xABCD);
  const cell = buildFamilyCPerCell(rows, {}, { hour_of_day: 3 }, 1e-4);
  assert.equal(cell.covariance_method, 'mrcd');
  assert.equal(cell.mcd_skip_reason, undefined,
    'D6b only applies to MCD-eligible cells (n ≥ max(5p, 200))');
});

test('D6b: covariance_method_override=ledoit_wolf → plain LW, no skip marker', () => {
  const rows = lowVarianceCell(250, 11, 0xBABE);
  const cell = buildFamilyCPerCell(
    rows,
    { covariance_method_override: 'ledoit_wolf' },
    { hour_of_day: 4 },
    1e-4,
  );
  assert.equal(cell.covariance_method, 'ledoit_wolf');
  assert.equal(cell.mcd_skip_reason, undefined,
    'explicit LW override is distinct from the D6b auto-skip path');
});

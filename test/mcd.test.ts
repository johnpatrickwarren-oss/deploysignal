// test/mcd.test.ts — Addition #18 Part 1 acceptance for FastMCD.
//
// Breakdown-point + migration-regression per the brief. The MCD
// implementation lives in tools/calibrate.ts; exported via the
// `fastMCD` helper. Tests run deterministically (fixed seeds).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// tools/calibrate is compiled to ./tools/calibrate.js by `npx tsc -p
// tsconfig.test.json` (the test tsconfig covers test/ + tools/).
// Test uses the helper directly; engine integration is covered by
// the family-c-alpha-split + canned-demo tests.
import { fastMCD } from '../tools/calibrate';

/** Seed a deterministic Gaussian draw via mulberry32 → Box-Muller. */
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
function gauss(rng: () => number): number {
  let u = rng(); while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Sample `n` p-dimensional rows from N(μ, σ²·I). */
function sampleNormal(n: number, p: number, mean: number[], sigma: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(p);
    for (let k = 0; k < p; k++) row[k] = mean[k] + sigma * gauss(rng);
    out.push(row);
  }
  return out;
}

test('mcd unit 1: breakdown-point — 25% outliers do not poison the MCD mean', () => {
  // 100-sample clean Gaussian baseline at mean [0, 0, 0] (p=3) with σ=1;
  // inject 25% outliers at mean [10, 10, 10] (same σ). FastMCD with α=0.75
  // (h = 75 = clean-set size) should recover the clean mean within a
  // small tolerance; the raw sample mean would sit near [2.5, 2.5, 2.5].
  // 25% is the breakdown-point limit for α=0.75 — going higher pushes
  // FastMCD into the regime where recovery isn't guaranteed (tested
  // separately via MRCD with regularization).
  const p = 3;
  const clean = sampleNormal(75, p, [0, 0, 0], 1.0, 0xC1EA10);
  const outliers = sampleNormal(25, p, [10, 10, 10], 1.0, 0x0001E8);
  const all = clean.concat(outliers);

  // Shuffle so the outliers aren't contiguous.
  const rng = mulberry32(0x5EED);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  const mcd = fastMCD(all, 0.75);
  assert.ok(mcd, 'FastMCD must converge');
  // Clean mean is [0, 0, 0]. Raw sample mean with 25 % outliers ≈ [2.5, 2.5, 2.5].
  // MCD should land substantially closer to clean — within 1.5 absolute on
  // every dimension (a meaningful improvement over raw; exact value
  // depends on initial-subset seed but should be << 2.5).
  for (let k = 0; k < p; k++) {
    assert.ok(
      Math.abs(mcd!.mean[k]) < 1.5,
      `MCD mean[${k}] = ${mcd!.mean[k]} must recover clean mean (|·| < 1.5)`,
    );
  }
  // h_support should be ⌈0.75 × 100⌉ = 75.
  assert.equal(mcd!.h_support, 75);
});

test('mcd unit 2: no-contamination baseline yields similar mean/cov to raw sample', () => {
  // On a clean baseline (no outliers), MCD with α=0.75 should recover a
  // mean/cov close to the raw sample moments — since 25 % of the clean
  // data is dropped, some variance inflation on the kept subset is fine
  // (MCD is consistent up to an asymptotic constant); the test here is
  // sanity only: the mean is near zero + cov is positive definite.
  const n = 200;
  const p = 4;
  const rows = sampleNormal(n, p, [0, 0, 0, 0], 1.0, 0xC1EAFF);
  const mcd = fastMCD(rows, 0.75);
  assert.ok(mcd);
  for (let k = 0; k < p; k++) {
    assert.ok(
      Math.abs(mcd!.mean[k]) < 0.4,
      `MCD mean on clean data should be near zero; got ${mcd!.mean[k]} at ${k}`,
    );
  }
  // Covariance diagonals should be roughly 1 ± 0.5 (finite-sample).
  for (let k = 0; k < p; k++) {
    assert.ok(
      mcd!.cov[k][k] > 0.2 && mcd!.cov[k][k] < 2.5,
      `MCD variance[${k}] = ${mcd!.cov[k][k]} out of range on clean data`,
    );
  }
});

test('mcd unit 3: reweighted MCD preserves support indices ordering', () => {
  const rows = sampleNormal(50, 3, [0, 0, 0], 1.0, 0xABCDEF);
  const mcd = fastMCD(rows, 0.8);
  assert.ok(mcd);
  // Support indices must be sorted ascending (used by downstream audit
  // provenance to reconstruct the kept subset deterministically).
  const s = mcd!.support_indices;
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i] > s[i - 1], 'support_indices must be sorted strictly ascending');
  }
  assert.equal(s.length, Math.ceil(0.8 * rows.length));
});

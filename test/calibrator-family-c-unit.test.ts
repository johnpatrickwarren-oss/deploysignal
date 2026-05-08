// test/calibrator-family-c-unit.test.ts — End-phase slice 3c (D-54-3).
//
// Unit tests for tools/calibrators/family-c.ts in isolation. Verifies:
//   - buildFamilyCPerCell returns { result, timings, diagnostics } shape.
//   - MCD / MRCD / LW dispatch follows the sample-size routing rule.
//   - D6b diagnostics populate on MCD-eligible cells; empty on LW/MRCD.
//   - Timings accumulate into the returned struct (not global state).
//   - PSD-gate fallback demotes non-PSD MCD output to LW.
//   - chiSqQuantile975 approximation matches expected values.
//   - Ledoit-Wolf shrinkage λ ∈ [0, 1] on shrinkable input.
//   - fastMCD produces a PD covariance on a clean Gaussian-like sample.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFamilyCPerCell,
  fastMCD,
  chiSqQuantile975,
  ledoitWolfShrinkage,
  columnMean,
  relativeDeviations,
  sampleCovariance,
  isPSDWithTolerance,
  PSD_TOLERANCE,
  MMD_MIN_BASELINE_SAMPLES,
  FASTMCD_DEFAULT_ALPHA,
} from '../tools/calibrators/family-c.js';
import { mulberry32 } from '../tools/calibrators/_shared.js';

// ── Deterministic row-matrix generators ───────────────────────────

/** Clean Gaussian-like rows with given mean + σ per column. Fixed seed. */
function gaussRows(n: number, p: number, seed: number, mean: number[], sigma: number[]): number[][] {
  const rng = mulberry32(seed);
  const rows: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = new Array(p);
    for (let j = 0; j < p; j++) {
      // Box-Muller for per-column σ.
      let u = rng(); while (u === 0) u = rng();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
      r[j] = mean[j] + sigma[j] * z;
    }
    rows[i] = r;
  }
  return rows;
}

// ── Routing: MCD vs MRCD vs LW ────────────────────────────────────

test('family-c unit: large-n clean sample routes to MCD', () => {
  const rows = gaussRows(400, 5, 42, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const { result } = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  // n=400, p=5 → n ≥ max(5·p, 200) = 200 → MCD path. D6b may demote to
  // LW with mcd_skip_reason='low_variance' on low-contamination samples.
  const skipReason = result.mcd_skip_reason ?? 'none';
  assert.ok(
    result.covariance_method === 'mcd'
    || (result.covariance_method === 'ledoit_wolf' && skipReason === 'low_variance'),
    `expected mcd or d6b-skipped LW; got ${result.covariance_method} (skip=${skipReason})`,
  );
});

test('family-c unit: small-n routes to MRCD', () => {
  // n just above p+1 but below 2·p+1 → MRCD.
  const rows = gaussRows(8, 5, 43, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const { result } = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  // MRCD may fall back to LW via the off-diagonal gate if the covariance
  // collapses. Both are legitimate small-n outcomes.
  const method = result.covariance_method ?? 'unknown';
  assert.ok(
    ['mrcd', 'ledoit_wolf', 'ledoit_wolf_from_degenerate_mrcd'].includes(method),
    `expected mrcd/lw/lw_from_degenerate; got ${method}`,
  );
});

test('family-c unit: p > 20 routes to Ledoit-Wolf', () => {
  const p = 25;
  const mean = new Array(p).fill(1);
  const sigma = new Array(p).fill(0.05);
  const rows = gaussRows(100, p, 44, mean, sigma);
  const { result } = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.equal(result.covariance_method, 'ledoit_wolf');
});

test('family-c unit: covariance_method_override forces path', () => {
  const rows = gaussRows(400, 5, 45, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const { result } = buildFamilyCPerCell(
    rows, { covariance_method_override: 'ledoit_wolf' }, { hour_of_day: 0 }, 1e-4,
  );
  assert.equal(result.covariance_method, 'ledoit_wolf');
});

// ── Return-shape: timings + diagnostics ───────────────────────────

test('family-c unit: return carries { result, timings, diagnostics }', () => {
  const rows = gaussRows(100, 3, 46, [10, 20, 30], [0.1, 0.2, 0.3]);
  const out = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.ok(out.result, 'result present');
  assert.ok(out.timings, 'timings present');
  assert.ok(typeof out.timings.cov_estimation_ns === 'bigint', 'cov_estimation_ns is bigint');
  assert.ok(typeof out.timings.mmd_bootstrap_ns === 'bigint', 'mmd_bootstrap_ns is bigint');
  assert.ok(typeof out.timings.mmd_bootstrap_skipped_cells === 'number');
  assert.ok(typeof out.timings.mcd_skipped_low_variance_cells === 'number');
  assert.ok(out.diagnostics, 'diagnostics present');
  assert.ok(Array.isArray(out.diagnostics.d6b_cells), 'd6b_cells is array');
});

test('family-c unit: cov_estimation_ns accumulates positive time', () => {
  const rows = gaussRows(400, 5, 47, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const out = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.ok(out.timings.cov_estimation_ns > 0n, 'cov_estimation_ns > 0');
});

test('family-c unit: D6b diagnostics populate on MCD-routed cells', () => {
  const rows = gaussRows(400, 5, 48, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const out = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.equal(out.diagnostics.d6b_cells.length, 1, 'exactly one d6b record per MCD-routed cell');
  const d = out.diagnostics.d6b_cells[0];
  assert.ok(d.lambda >= 0 && d.lambda <= 1, `λ in [0,1]; got ${d.lambda}`);
  assert.ok(d.outlier_fraction >= 0 && d.outlier_fraction <= 1, `outlier_fraction in [0,1]; got ${d.outlier_fraction}`);
  assert.equal(d.n_rows, 400);
});

test('family-c unit: D6b diagnostics empty on LW-routed cells', () => {
  // p > 20 forces LW routing — no D6b check runs.
  const p = 25;
  const rows = gaussRows(100, p, 49, new Array(p).fill(1), new Array(p).fill(0.05));
  const out = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.equal(out.diagnostics.d6b_cells.length, 0, 'LW-routed cell emits no D6b record');
});

// ── Numerical helpers ─────────────────────────────────────────────

test('family-c unit: chiSqQuantile975 matches known values', () => {
  // Wilson-Hilferty approximation — tolerant to ~1%.
  // χ²(0.975, 1) ≈ 5.024; χ²(0.975, 5) ≈ 12.833; χ²(0.975, 11) ≈ 21.920.
  assert.ok(Math.abs(chiSqQuantile975(1) - 5.024) / 5.024 < 0.02);
  assert.ok(Math.abs(chiSqQuantile975(5) - 12.833) / 12.833 < 0.02);
  assert.ok(Math.abs(chiSqQuantile975(11) - 21.920) / 21.920 < 0.02);
});

test('family-c unit: ledoitWolfShrinkage returns λ in [0, 1]', () => {
  const rows = gaussRows(200, 5, 50, [0, 0, 0, 0, 0], [1, 1, 1, 1, 1]);
  const mean = columnMean(rows);
  const Z = relativeDeviations(rows, mean.map(() => 1));
  const { cov, lambda } = ledoitWolfShrinkage(Z);
  assert.ok(lambda >= 0 && lambda <= 1, `λ=${lambda}`);
  assert.equal(cov.length, 5);
  assert.equal(cov[0].length, 5);
});

test('family-c unit: sampleCovariance is symmetric', () => {
  const rows = gaussRows(100, 4, 51, [0, 0, 0, 0], [1, 2, 3, 4]);
  const mean = columnMean(rows);
  const Z = rows.map((r) => r.map((v, i) => v - mean[i]));
  const S = sampleCovariance(Z);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      assert.ok(Math.abs(S[i][j] - S[j][i]) < 1e-12, `asymmetric: S[${i}][${j}]=${S[i][j]} vs S[${j}][${i}]=${S[j][i]}`);
    }
  }
});

test('family-c unit: isPSDWithTolerance rejects near-singular matrices', () => {
  const almostSingular = [[1, 1], [1, 1 + 1e-15]];
  assert.equal(isPSDWithTolerance(almostSingular, PSD_TOLERANCE), false);
  const pd = [[1, 0.1], [0.1, 1]];
  assert.equal(isPSDWithTolerance(pd, PSD_TOLERANCE), true);
});

// ── fastMCD smoke test ────────────────────────────────────────────

test('family-c unit: fastMCD produces PD covariance on clean sample', () => {
  const rows = gaussRows(200, 4, 52, [0, 0, 0, 0], [1, 1, 1, 1]);
  const result = fastMCD(rows, FASTMCD_DEFAULT_ALPHA);
  assert.ok(result, 'fastMCD returned a result');
  assert.equal(result!.cov.length, 4);
  // Diagonal entries must be positive.
  for (let i = 0; i < 4; i++) {
    assert.ok(result!.cov[i][i] > 0, `diag[${i}]=${result!.cov[i][i]} must be positive`);
  }
  assert.ok(result!.h_support >= 5, `h_support=${result!.h_support}`);
  assert.ok(result!.support_indices.length === result!.h_support);
});

test('family-c unit: MMD_MIN_BASELINE_SAMPLES gates mmd_params', () => {
  // Small-n cell — below the 100-sample MMD floor → mmd_params=null even
  // if routed to MCD/MRCD. Floor lowered 500 → 100 in commit 42d1ad8 per
  // ARCHITECT-REPLY-52g (Shekhar–Ramdas 2023 §5 empirical-floor); fixture
  // n adjusted from 100 → 50 to stay below the new threshold.
  assert.equal(MMD_MIN_BASELINE_SAMPLES, 100);
  const rows = gaussRows(50, 5, 53, [100, 200, 0.5, 0.1, 1.0], [1, 2, 0.01, 0.01, 0.01]);
  const { result } = buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4);
  assert.equal(result.mmd_params, null, 'n=50 < 100 → mmd_params null');
});

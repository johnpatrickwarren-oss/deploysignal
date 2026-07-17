// test/comparator-baseline-stats.test.ts — WS6.2 Task 2 unit tests for the
// comparator-baseline harness's statistics primitives: mannWhitneyU (normal
// approximation, tie-corrected) and meanSigmaFromCompiledCell (compiled-cell
// baseline mean/sigma reader with the aggregate_fallback calling pattern).
//
// No content, threshold, or code from any prior comparator study was
// consulted in writing these fixtures — all hand-computed from first
// principles against the rank-sum formulas in ENDPOINTS.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mannWhitneyU, meanSigmaFromCompiledCell } from '../tools/_comparator-baseline-stats';

test('mannWhitneyU: identical samples (full ties) → u at its null mean, p ≈ 1', () => {
  const a = [1, 2, 3, 4, 5];
  const b = [1, 2, 3, 4, 5];
  const r = mannWhitneyU(a, b);
  // Hand-computed: pooled ranks are symmetric average-rank pairs, so
  // rankSumA - nA(nA+1)/2 == nA*nB/2 exactly (no directional signal).
  assert.equal(r.u, 12.5);
  // Tolerance reflects the Abramowitz & Stegun 7.1.26 erf approximation's
  // own bound (~1.5e-7 max absolute error), not a fixture-precision fudge.
  assert.ok(Math.abs(r.pTwoSided - 1) < 1e-6, `expected pTwoSided ≈ 1, got ${r.pTwoSided}`);
  assert.ok(Math.abs(r.pGreater - 0.5) < 1e-6, `expected pGreater ≈ 0.5, got ${r.pGreater}`);
  assert.ok(Math.abs(r.pLess - 0.5) < 1e-6, `expected pLess ≈ 0.5, got ${r.pLess}`);
});

test('mannWhitneyU: cleanly shifted samples (no overlap, no ties) → small directional p', () => {
  const a = [1, 2, 3, 4, 5];
  const b = [10, 11, 12, 13, 14];
  const r = mannWhitneyU(a, b);
  // Hand-computed: a's ranks are 1..5 (sum 15), b's ranks are 6..10 (sum 40).
  // uA = 15 - 5*6/2 = 0; meanU = 12.5; varU = (25/12)*11 ≈ 22.9167; sd ≈ 4.7871.
  // z = (0 - 12.5) / 4.7871 ≈ -2.6112 → Φ(z) ≈ 0.00452.
  assert.equal(r.u, 0);
  assert.ok(r.pLess < 0.01, `a is stochastically less than b; expected pLess < 0.01, got ${r.pLess}`);
  assert.ok(Math.abs(r.pLess - 0.00452) < 0.001, `expected pLess ≈ 0.00452, got ${r.pLess}`);
  assert.ok(r.pGreater > 0.99, `expected pGreater > 0.99, got ${r.pGreater}`);
  assert.ok(Math.abs(r.pTwoSided - 2 * r.pLess) < 1e-9, 'pTwoSided should be 2*min(pGreater,pLess)');
});

test('mannWhitneyU: ties handled — hand-computed rank-sum with tied pooled values', () => {
  const a = [1, 2, 3];
  const b = [2, 3, 4];
  const r = mannWhitneyU(a, b);
  // Pooled sorted: 1,2,2,3,3,4 → avg ranks: 1→1, 2→2.5, 3→4.5, 4→6.
  // rankSumA = 1 + 2.5 + 4.5 = 8 → uA = 8 - 3*4/2 = 2.
  // tie correction: groups of size [1,2,2,1] → Σ(t³−t) = 0+6+6+0 = 12.
  // varU = (3*3/12)*(7 - 12/(6*5)) = 0.75*6.6 = 4.95 → sd ≈ 2.22486.
  // z = (2 - 4.5) / 2.22486 ≈ -1.1236 → Φ(z) ≈ 0.1306.
  assert.equal(r.u, 2);
  assert.ok(Math.abs(r.pLess - 0.1306) < 0.005, `expected pLess ≈ 0.1306, got ${r.pLess}`);
  assert.ok(Math.abs(r.pTwoSided - 2 * r.pLess) < 1e-9);
});

test('mannWhitneyU: degenerate input (empty sample) → p = 1, no throw', () => {
  const r = mannWhitneyU([], [1, 2, 3]);
  assert.equal(r.pTwoSided, 1);
  assert.equal(r.pGreater, 1);
  assert.equal(r.pLess, 1);
});

test('mannWhitneyU: all values identical across both samples (zero rank variance) → p = 1', () => {
  const r = mannWhitneyU([5, 5, 5], [5, 5, 5, 5]);
  assert.equal(r.pTwoSided, 1);
  assert.equal(r.pGreater, 1);
  assert.equal(r.pLess, 1);
});

// ── meanSigmaFromCompiledCell ────────────────────────────────────────

const compiledConfigPath = path.join(__dirname, '..', 'runs', 'compiled-configs', 'v5-sequential-e-process.json');
const compiledConfig = JSON.parse(fs.readFileSync(compiledConfigPath, 'utf8'));

test('meanSigmaFromCompiledCell: aggregate_fallback p99_latency matches compiled-config values', () => {
  const { mu, sigma } = meanSigmaFromCompiledCell(compiledConfig.baseline_cells.aggregate_fallback, 'p99_latency');
  assert.ok(Math.abs(mu - 184.929) < 0.01, `expected mu ≈ 184.929, got ${mu}`);
  assert.ok(Math.abs(sigma * sigma - 340.51) < 0.1, `expected sigma^2 ≈ 340.51, got ${sigma * sigma}`);
});

test('meanSigmaFromCompiledCell: real per-cell family_A entry (not aggregate_fallback)', () => {
  const cell = compiledConfig.baseline_cells.cells.find(
    (c: any) => c.family_A && c.key.hour_of_day === 0 && c.key.day_of_week === 0 && c.key.tenant_tier === 'large'
  );
  assert.ok(cell, 'fixture cell (0, 0, large) with family_A must exist in the compiled config');
  const { mu, sigma } = meanSigmaFromCompiledCell(cell, 'p99_latency');
  assert.ok(Math.abs(mu - 160.162) < 0.01, `expected mu ≈ 160.162, got ${mu}`);
  assert.ok(Math.abs(sigma * sigma - 125.8998) < 0.01, `expected sigma^2 ≈ 125.8998, got ${sigma * sigma}`);
});

test('meanSigmaFromCompiledCell: signal absent from cell throws (caller must supply aggregate_fallback)', () => {
  const cellWithoutFamilyA = compiledConfig.baseline_cells.cells.find((c: any) => !c.family_A);
  assert.ok(cellWithoutFamilyA, 'fixture cell without family_A must exist in the compiled config');
  assert.throws(() => meanSigmaFromCompiledCell(cellWithoutFamilyA, 'p99_latency'), /no family_A\.per_signal entry/);
  assert.throws(() => meanSigmaFromCompiledCell(null, 'p99_latency'), /no family_A\.per_signal entry/);
});

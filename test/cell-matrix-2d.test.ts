// test/cell-matrix-2d.test.ts — W3 §3.1.f acceptance for the unified
// 2-D baseline cell matrix emitted by tools/calibrate.ts with Family C.
//
// Asserts:
//   - 168 cells populated (24 hour × 7 day) under the full Family C run.
//   - Every populated cell's family_C covariance is symmetric and PSD.
//   - Pooled cells carry pooled_from and variance_inflated.
//   - aggregate_fallback block is present and usable.
//   - Family B block is unchanged from v1-legacy-equivalent.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { CompiledConfig } from '../dist/engine/types';

const ROOT = path.resolve(__dirname, '..');
const V1_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v1-legacy-equivalent.json');
const V3_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v3-with-family-c.json');
const BASELINE_DIR = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');

let V3: CompiledConfig;
let V1: CompiledConfig;

before(() => {
  const needsBaseline = !fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'));
  if (needsBaseline) {
    execSync('node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
      { cwd: ROOT, stdio: 'inherit' });
  }
  if (!fs.existsSync(V3_PATH)) {
    execSync('node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B,C --out runs/compiled-configs/v3-with-family-c.json',
      { cwd: ROOT, stdio: 'inherit' });
  }
  if (!fs.existsSync(V1_PATH)) {
    execSync('node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --out runs/compiled-configs/v1-legacy-equivalent.json',
      { cwd: ROOT, stdio: 'inherit' });
  }
  V3 = JSON.parse(fs.readFileSync(V3_PATH, 'utf8'));
  V1 = JSON.parse(fs.readFileSync(V1_PATH, 'utf8'));
});

// ── Structural assertions ────────────────────────────────────────────

test('cell-matrix: 2-D matrix has 168 cells (24 × 7)', () => {
  assert.deepEqual(V3.baseline_cells!.dimensions, ['hour_of_day', 'day_of_week']);
  assert.equal(V3.baseline_cells!.cells.length, 168);
});

test('cell-matrix: cell keys uniquely cover the (hour, day) grid', () => {
  const seen = new Set<string>();
  for (const c of V3.baseline_cells!.cells) {
    const key = `${c.key.hour_of_day}|${c.key.day_of_week}`;
    assert.ok(!seen.has(key), `duplicate cell key ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, 168);
});

test('cell-matrix: strict and pooled cells populate family_A + family_C', () => {
  for (const c of V3.baseline_cells!.cells) {
    if (c.confidence === 'strict' || c.confidence === 'pooled') {
      assert.ok(c.family_A, `cell ${JSON.stringify(c.key)} confidence=${c.confidence} missing family_A`);
      // Family C only emits when the cell has ≥ p+1 rows; normally all
      // strict/pooled cells will have it but we allow the edge case.
      if (c.family_C) {
        assert.ok(Array.isArray(c.family_C.mean_vector));
        assert.ok(c.family_C.mean_vector.length > 0);
        assert.ok(Array.isArray(c.family_C.covariance));
        assert.equal(c.family_C.covariance.length, c.family_C.mean_vector.length);
      }
    }
  }
});

test('cell-matrix: pooled cells carry pooled_from + variance_inflated', () => {
  for (const c of V3.baseline_cells!.cells) {
    if (c.confidence === 'pooled') {
      assert.ok(Array.isArray(c.pooled_from), 'pooled cell must list pooled_from');
      assert.equal(c.variance_inflated, true, 'pooled cell must be variance_inflated=true');
    }
  }
});

test('cell-matrix: aggregate_fallback has Family A per-signal + Family C', () => {
  const fb = V3.baseline_cells!.aggregate_fallback;
  assert.ok(fb.family_A);
  assert.ok(fb.family_A!.per_signal['p99_latency']);
  assert.ok(fb.family_A!.per_signal['ttft']);
  // Family C fallback should be present for a full-Family-C compile.
  assert.ok(fb.family_C);
  assert.equal(fb.family_C!.mean_vector.length, fb.family_C!.covariance.length);
});

// ── Covariance math assertions (symmetry + PSD per cell) ─────────────

function isSymmetric(A: number[][], tol = 1e-9): boolean {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(A[i][j] - A[j][i]) > tol) return false;
    }
  }
  return true;
}

/** Cholesky-based PSD test: returns true iff A has a successful LL^T
 *  factorization (i.e., strictly positive definite). PSD-but-singular
 *  matrices with λ_min = 0 will fail here — the Ledoit-Wolf shrinkage
 *  is unconditional so we expect strict positive definiteness. */
function isPSD(A: number[][]): boolean {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) return false;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return true;
}

test('cell-matrix: every Family C covariance is symmetric', () => {
  let checked = 0;
  for (const c of V3.baseline_cells!.cells) {
    if (c.family_C) {
      assert.ok(isSymmetric(c.family_C.covariance),
        `cell ${JSON.stringify(c.key)} covariance not symmetric`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no Family C cells found');
});

test('cell-matrix: every Family C covariance is positive definite', () => {
  let checked = 0, failing = 0;
  for (const c of V3.baseline_cells!.cells) {
    if (c.family_C) {
      if (!isPSD(c.family_C.covariance)) failing++;
      checked++;
    }
  }
  assert.equal(failing, 0, `${failing}/${checked} Family C covariances not PSD`);
});

test('cell-matrix: Ledoit-Wolf shrinkage λ ∈ [0, 1] for every Family C cell', () => {
  for (const c of V3.baseline_cells!.cells) {
    if (c.family_C?.covariance_shrinkage !== undefined) {
      const l = c.family_C.covariance_shrinkage;
      assert.ok(l >= 0 && l <= 1, `cell ${JSON.stringify(c.key)} λ=${l} out of [0,1]`);
    }
  }
});

// ── Family B invariance: v3 and v1 agree on the Family B cutoffs ─────

test('cell-matrix: Family B block unchanged vs v1-legacy-equivalent', () => {
  // REPLY-51b R4-4 relaxed family_B to optional; legacy compiles
  // still always emit it (CLI --families default includes B), so
  // non-null assertion is safe on these test fixtures.
  assert.ok(V3.family_B && V1.family_B, 'legacy + family-A compiles must emit family_B');
  assert.deepEqual(V3.family_B.cutoffs, V1.family_B.cutoffs);
  assert.deepEqual(V3.family_B.vote_thresholds, V1.family_B.vote_thresholds);
});

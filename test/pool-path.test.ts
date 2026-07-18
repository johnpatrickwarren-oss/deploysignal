// test/pool-path.test.ts — W4 §4.0 T1 (Reviewer-flagged):
// exercise the pooling code path end-to-end on a deliberately sparse bundle.
//
// Shipped v3 baseline (500 runs × 32 ticks) saturates every cell at strict
// confidence (n≈83–114), so `cell-matrix-2d.test.ts` assertions about
// pooled cells were vacuously true. This test generates a small sparse
// bundle where raw per-cell counts fall in the [20, 60) pooled band, then
// asserts the compiler emits ≥1 cell with `confidence: 'pooled'`,
// non-empty `pooled_from`, and `variance_inflated: true`.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { CompiledConfig } from '../dist/engine/types';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'pool-baseline-sparse');
const COMPILED_PATH = path.join(FIXTURE_DIR, 'compiled.json');

let CFG: CompiledConfig;

before(() => {
  // Generator: n=400 × ticks=20 ⇒ ~47 samples/cell average under random
  // (start_hour, start_day), landing most cells in the pooled band and
  // a minority at strict. Deterministic under seed=42.
  if (!fs.existsSync(path.join(FIXTURE_DIR, 'bundle.jsonl'))) {
    execSync(
      'node tools/gen-synthetic-baseline.ts --out test/fixtures/pool-baseline-sparse --n 400 --ticks 20 --tenants 4 --seed 42',
      { cwd: ROOT, stdio: 'pipe' },
    );
  }
  if (!fs.existsSync(COMPILED_PATH)) {
    execSync(
      'node tools/calibrate.ts --baseline test/fixtures/pool-baseline-sparse --alpha 1e-3 --families A,B,C --out test/fixtures/pool-baseline-sparse/compiled.json',
      { cwd: ROOT, stdio: 'pipe' },
    );
  }
  CFG = JSON.parse(fs.readFileSync(COMPILED_PATH, 'utf8'));
});

test('pool-path: sparse fixture produces ≥1 cell with confidence=pooled', () => {
  const pooled = CFG.baseline_cells!.cells.filter((c) => c.confidence === 'pooled');
  assert.ok(pooled.length > 0,
    `expected ≥1 pooled cell in sparse fixture; got 0 (breakdown: ${summarize(CFG)})`);
});

test('pool-path: pooled cells carry non-empty pooled_from and variance_inflated', () => {
  const pooled = CFG.baseline_cells!.cells.filter((c) => c.confidence === 'pooled');
  assert.ok(pooled.length > 0, 'no pooled cells to test');
  for (const c of pooled) {
    assert.ok(Array.isArray(c.pooled_from) && c.pooled_from.length > 0,
      `pooled cell ${JSON.stringify(c.key)} missing non-empty pooled_from`);
    assert.equal(c.variance_inflated, true,
      `pooled cell ${JSON.stringify(c.key)} missing variance_inflated=true`);
  }
});

test('pool-path: pooled family_A per_signal populated for primary SLIs', () => {
  const pooled = CFG.baseline_cells!.cells.filter((c) => c.confidence === 'pooled');
  const sample = pooled[0];
  assert.ok(sample.family_A, 'pooled cell missing family_A block');
  // Primary SLIs should be present; quality-tier signals (eval_score,
  // tool_success_rate) may be absent in a sparse bundle where those
  // signals didn't accumulate — we assert on universally-present signals.
  for (const signal of ['p99_latency', 'ttft', 'cost_req', 'downstream_err']) {
    const p: (typeof sample.family_A.per_signal)[string] = sample.family_A.per_signal[signal];
    assert.ok(p, `pooled cell missing family_A.per_signal[${signal}]`);
    assert.ok(p.baseline_sigma_squared >= 0, 'σ² should be ≥0');
    assert.ok(p.tau_squared > 0, 'τ² should be >0');
    assert.ok(p.delta_min > 0, 'δ_min should be >0');
  }
});

test('pool-path: pooled family_C is symmetric PSD when populated', () => {
  const pooled = CFG.baseline_cells!.cells.filter((c) => c.confidence === 'pooled' && c.family_C);
  assert.ok(pooled.length > 0, 'expected ≥1 pooled cell with family_C populated');
  const c = pooled[0];
  const cov = c.family_C!.covariance;
  const p = cov.length;
  // Symmetry check
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < i; j++) {
      assert.ok(Math.abs(cov[i][j] - cov[j][i]) < 1e-9,
        `cov not symmetric at (${i}, ${j}) in pooled cell ${JSON.stringify(c.key)}`);
    }
  }
  // PSD (Cholesky existence) check
  const L: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  let psd = true;
  for (let i = 0; i < p && psd; i++) {
    for (let j = 0; j <= i && psd; j++) {
      let s = cov[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) psd = false;
        else L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  assert.ok(psd, `pooled cell family_C covariance not PSD`);
});

function summarize(cfg: CompiledConfig): string {
  const by = (c: string) => cfg.baseline_cells!.cells.filter((x) => x.confidence === c).length;
  return `strict=${by('strict')} pooled=${by('pooled')} aggregate=${by('aggregate')} none=${by('none')}`;
}

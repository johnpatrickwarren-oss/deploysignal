// test/mSPRT.test.ts — Family A Page-CUSUM detector unit tests.
//
// Q69.D (2026-08-18, applied at the v0.6.7-pre re-pin): the classical Page-CUSUM
// (`evaluateCUSUM`, `lookupCellParams`) is deleted from the engine (engine
// validation/nab/RERUN-2026-08-18-PREREGISTRATION.md § 3), so the classical
// behavior acceptance tests (a)–(f), (h), the FP-rate sanity run, and T3 are
// retired with their subject. What survives is what the engine still ships and
// the mixture path still uses:
//   - `updateCUSUM` pure-math and T4 degenerate-σ² tests (unchanged),
//   - `trafficGateMin` missing-gate test (unchanged),
//   - (g) per-cell divergence and T1 cell-crossing, ported from the retired
//     `lookupCellParams` wrapper to `matchCellByHour` — the cell-matching
//     primitive the mixture path uses — reading the compiled per-signal
//     fields directly.
//
// Original acceptance record per WEEK2-HANDOFF.md §2.1.d (architect-rewrite
// 2026-04-18), retained in git history at the pre-re-pin revision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type { CompiledConfig } from '../dist/engine/types';
import {
  freshCUSUM, updateCUSUM, trafficGateMin,
} from '@johnpatrickwarren-oss/deploysignal-engine/detectors/page-cusum';
import { matchCellByHour } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_page-cusum-core';

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
const BASELINE_DIR = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');

function ensureConfig(): CompiledConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
      execSync(
        'node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
        { cwd: ROOT, stdio: 'inherit' },
      );
    }
    execSync(
      'node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B --out runs/compiled-configs/v2-with-family-a.json',
      { cwd: ROOT, stdio: 'inherit' },
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as CompiledConfig;
}

/** Per-signal Family A entry for the first cell matching the hour. */
function cellSignal(cfg: CompiledConfig, hour: number, signal: string) {
  const cell = matchCellByHour(cfg.baseline_cells!.cells, { hour_of_day: hour });
  assert.ok(cell, `no cell for hour_of_day=${hour}`);
  const entry = cell!.family_A?.per_signal?.[signal];
  assert.ok(entry, `cell h=${hour} has no family_A per_signal entry for ${signal}`);
  return entry!;
}

// ────────────────────────────────────────────────────────────────────
// (g) Per-cell τ² and σ² differ between h=2 and h=14 (ported: reads the
// compiled cell entries via matchCellByHour instead of the retired
// lookupCellParams assembly).
test('CUSUM: (g) per-cell τ² and σ² differ between h=2 and h=14', () => {
  const cfg = ensureConfig();
  const p2 = cellSignal(cfg, 2, 'p99_latency');
  const p14 = cellSignal(cfg, 14, 'p99_latency');
  assert.notEqual(p2.tau_squared, p14.tau_squared);
  assert.notEqual(p2.baseline_sigma_squared, p14.baseline_sigma_squared);
  assert.notEqual(p2.baseline_mean, p14.baseline_mean);
});

// ────────────────────────────────────────────────────────────────────
// trafficGateMin handles missing gate in the compiled config.
test('CUSUM: trafficGateMin returns 0 when gate is not compiled', () => {
  const fake: CompiledConfig = {
    version: 'x', compiler_version: 'x', compiled_at: '', baseline_ref: '',
    alpha_budget: { total: 0, per_family: {} },
    family_B: { cutoffs: {}, vote_thresholds: {} },
  };
  assert.equal(trafficGateMin(fake), 0);
});

// ────────────────────────────────────────────────────────────────────
// Pure-math unit: updateCUSUM math matches the architect's spec.
test('CUSUM: updateCUSUM matches architect math formula', () => {
  const state = freshCUSUM();
  const sigma2 = 100, tau2 = 25;
  const x = 5;
  const logShrink = 0.5 * Math.log(sigma2 / (sigma2 + tau2));
  const quad = (x * x * tau2) / (2 * sigma2 * (sigma2 + tau2));
  const expectedZ = logShrink + quad;
  const expectedS = Math.max(0, 0 + expectedZ);
  const s = updateCUSUM(state, x, sigma2, tau2, 1e-4);
  assert.ok(Math.abs(s - expectedS) < 1e-12, `expected S=${expectedS}, got ${s}`);
  assert.equal(state.n, 1);
  assert.equal(state.alphaConsumed, 1e-4);
});

// ────────────────────────────────────────────────────────────────────
// T1 (W3 §3.0, from REVIEWER-REPORT-WK02) — cell-crossing analytical
// assertion, ported to the surviving primitives: the cross-cell update
// must use the NEW cell's σ² and τ² specifically.
test('CUSUM: (T1) cell-crossing applies new cell σ², τ² analytically', () => {
  const cfg = ensureConfig();
  const p14 = cellSignal(cfg, 14, 'p99_latency');
  const p20 = cellSignal(cfg, 20, 'p99_latency');
  // Sanity: the two cells actually differ (Q1 acceptance); if this ever
  // flattens, the whole premise collapses.
  assert.notEqual(p14.baseline_sigma_squared, p20.baseline_sigma_squared);
  assert.notEqual(p14.tau_squared, p20.tau_squared);

  const state = freshCUSUM();
  // Tick 1: cell h=14. Big positive deviation so S stays > 0 after one
  // step and the cross-cell z_n contribution isn't truncated away.
  const x1 = 4 * Math.sqrt(p14.baseline_sigma_squared);
  updateCUSUM(state, x1, p14.baseline_sigma_squared, p14.tau_squared, 1e-4);
  const sBeforeCross = state.S;

  // Tick 2: cell h=20. Compute the expected S directly from p20's params.
  const x2 = 2 * Math.sqrt(p20.baseline_sigma_squared);
  const s2 = p20.baseline_sigma_squared;
  const t2 = p20.tau_squared;
  const expectedZ = 0.5 * Math.log(s2 / (s2 + t2)) + (x2 * x2 * t2) / (2 * s2 * (s2 + t2));
  const expectedS = Math.max(0, sBeforeCross + expectedZ);
  updateCUSUM(state, x2, s2, t2, 1e-4);
  assert.ok(Math.abs(state.S - expectedS) < 1e-12,
    `cross-cell update must use new cell's σ²/τ²; got S=${state.S}, expected ${expectedS}`);

  // And the expected value MUST differ from what the OLD cell's params
  // would have produced — the reviewer's exact bias concern.
  const s1 = p14.baseline_sigma_squared;
  const t1 = p14.tau_squared;
  const zWithOldParams = 0.5 * Math.log(s1 / (s1 + t1)) + (x2 * x2 * t1) / (2 * s1 * (s1 + t1));
  const sWithOldParams = Math.max(0, sBeforeCross + zWithOldParams);
  assert.notEqual(expectedS, sWithOldParams,
    'if these match, the test would be vacuous — old/new cell params must diverge');
});

// ────────────────────────────────────────────────────────────────────
// T4 (W3 §3.0, from REVIEWER-REPORT-WK02) — σ² = 0 degenerate cell.
// Documents the existing fallback behavior in updateCUSUM so a silent
// refactor can't drift it.
test('CUSUM: (T4) σ² ≤ 0 falls back to z = x² / (2τ²)', () => {
  const state = freshCUSUM();
  const tau2 = 4;
  const x = 3;
  // σ² exactly 0.
  const expectedZ = (x * x) / (2 * tau2);  // 9 / 8 = 1.125
  const s = updateCUSUM(state, x, 0, tau2, 1e-4);
  assert.ok(Math.abs(s - expectedZ) < 1e-12, `σ²=0 fallback: expected S=${expectedZ}, got ${s}`);

  // σ² negative — should behave identically to σ² = 0 via the `<= 0` guard.
  const s2state = freshCUSUM();
  const s2 = updateCUSUM(s2state, x, -1, tau2, 1e-4);
  assert.ok(Math.abs(s2 - expectedZ) < 1e-12, `σ²<0 fallback: expected S=${expectedZ}, got ${s2}`);

  // σ² ≤ 0 AND τ² ≤ 0 → z = 0, S stays at 0.
  const s3state = freshCUSUM();
  const s3 = updateCUSUM(s3state, x, 0, 0, 1e-4);
  assert.equal(s3, 0, 'σ²=0 and τ²=0 must yield z=0');
});

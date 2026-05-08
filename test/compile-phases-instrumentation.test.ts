// test/compile-phases-instrumentation.test.ts — REPLY-50 D7 coverage.
//
// Asserts (slice-3d updated):
//   - `compile_phases` is the expected shape (all numeric fields present).
//   - All per-phase accumulators are non-negative.
//   - After exercising buildFamilyCPerCell with an aggregator, the
//     finalized cov_estimation_ms > 0.
//   - `finalizePhaseTimings(timings, totalNs)` returns total_ms =
//     Math.round(totalNs / 1e6).
//   - `mcd_skipped_low_variance_cells` + `mmd_bootstrap_skipped_cells`
//     are integer counters, default 0 on a fresh aggregator.
//
// Slice-3d note: pre-3d used module-level `_phaseTimings` + a
// `resetPhaseTimings()` export; the D-54-3 Option-3 completion removes
// module state entirely. Tests now instantiate a compile-local
// `CompileAggregator` via `newCompileAggregatorExported()` and pass it
// to buildFamilyCPerCell / finalizePhaseTimings explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompilePhases } from '../engine/types';
import {
  finalizePhaseTimings, buildFamilyCPerCell, newCompileAggregatorExported,
} from '../tools/calibrate';

/** Generate a deterministic 11-dim synthetic baseline suitable for
 *  buildFamilyCPerCell. n ≥ max(5p, 200) = 200 so D2 routing picks
 *  MCD (the path that triggers D6b diagnostic). Values drawn from a
 *  mulberry32 PRNG so different runs hit the same (λ, outlier_frac). */
function syntheticRows(n: number, p: number, seed: number): number[][] {
  let a = seed >>> 0;
  const rng = (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(p);
    for (let j = 0; j < p; j++) {
      // Box-Muller pair → standard normal; offset so every dim has positive mean.
      const u1 = Math.max(rng(), 1e-9);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      row[j] = 1 + 0.1 * z;
    }
    rows.push(row);
  }
  return rows;
}

function assertCompilePhasesShape(cp: CompilePhases): void {
  assert.equal(typeof cp.l0_prep_ms, 'number');
  assert.equal(typeof cp.cov_estimation_ms, 'number');
  assert.equal(typeof cp.mmd_bootstrap_ms, 'number');
  assert.equal(typeof cp.conformal_calibration_ms, 'number');
  assert.equal(typeof cp.tau2_fit_ms, 'number');
  assert.equal(typeof cp.worker_pool_overhead_ms, 'number');
  assert.equal(typeof cp.total_ms, 'number');
  for (const v of [
    cp.l0_prep_ms, cp.cov_estimation_ms, cp.mmd_bootstrap_ms,
    cp.conformal_calibration_ms, cp.tau2_fit_ms, cp.worker_pool_overhead_ms, cp.total_ms,
  ]) {
    assert.ok(v >= 0, `phase field must be non-negative, got ${v}`);
  }
}

test('compile-phases: finalize returns expected shape with non-negative values', () => {
  const agg = newCompileAggregatorExported();
  const cp = finalizePhaseTimings(agg.timings, 100_000_000n); // 100ms total
  assertCompilePhasesShape(cp);
  assert.equal(cp.total_ms, 100);
  // Fresh aggregator → all phase accumulators = 0.
  assert.equal(cp.cov_estimation_ms, 0);
  assert.equal(cp.mmd_bootstrap_ms, 0);
  assert.equal(cp.mcd_skipped_low_variance_cells, 0);
  assert.equal(cp.mmd_bootstrap_skipped_cells, 0);
});

test('compile-phases: buildFamilyCPerCell drives cov_estimation_ms > 0', () => {
  const agg = newCompileAggregatorExported();
  const rows = syntheticRows(250, 11, 0xC0DE);
  // Default opts → chosen='mcd' via D2 routing (n=250 ≥ max(5·11, 200) = 200).
  buildFamilyCPerCell(rows, {}, { hour_of_day: 0 }, 1e-4, agg);
  const cp = finalizePhaseTimings(agg.timings, 1_000_000_000n); // 1s envelope
  assertCompilePhasesShape(cp);
  assert.ok(cp.cov_estimation_ms > 0,
    `cov_estimation_ms must be >0 after a cell build, got ${cp.cov_estimation_ms}`);
});

test('compile-phases: sum of disjoint phases ≤ total_ms (residual is non-negative)', () => {
  const agg = newCompileAggregatorExported();
  const rows = syntheticRows(300, 11, 0xDEADBEEF);
  buildFamilyCPerCell(rows, {}, { hour_of_day: 1 }, 1e-4, agg);
  // Use a synthetic "total" generously larger than the aggregated phases.
  const cp = finalizePhaseTimings(agg.timings, 5_000_000_000n); // 5s
  const sum =
    cp.l0_prep_ms + cp.cov_estimation_ms + cp.mmd_bootstrap_ms
    + cp.conformal_calibration_ms + cp.tau2_fit_ms + cp.worker_pool_overhead_ms;
  assert.ok(sum <= cp.total_ms + 1,
    `sum of phases (${sum}ms) must be ≤ total_ms (${cp.total_ms}ms) by construction; residual captures unattributed time`);
});

test('compile-phases: D4 skip counter increments on post-Ville-full default', () => {
  const agg = newCompileAggregatorExported();
  const rows = syntheticRows(600, 11, 0xFEED); // ≥ MMD_MIN_BASELINE_SAMPLES (500)
  // Default opts → force_legacy_family_c unset → useLegacyC=false → D4 skip.
  buildFamilyCPerCell(rows, {}, { hour_of_day: 2 }, 1e-4, agg);
  const cp = finalizePhaseTimings(agg.timings, 2_000_000_000n);
  assert.ok((cp.mmd_bootstrap_skipped_cells ?? 0) >= 1,
    `D4 should skip MMD bootstrap on post-Ville-full default cell, got ${cp.mmd_bootstrap_skipped_cells}`);
  // Because bootstrap was skipped, mmd_bootstrap_ms should be 0.
  assert.equal(cp.mmd_bootstrap_ms, 0);
});

test('compile-phases: D4 bootstrap runs on force_legacy_family_c=true', () => {
  const agg = newCompileAggregatorExported();
  const rows = syntheticRows(600, 11, 0xF00D);
  buildFamilyCPerCell(rows, { force_legacy_family_c: true }, { hour_of_day: 3 }, 1e-4, agg);
  const cp = finalizePhaseTimings(agg.timings, 60_000_000_000n);
  assert.equal(cp.mmd_bootstrap_skipped_cells ?? 0, 0,
    'legacy mode must run the bootstrap, not skip');
  assert.ok(cp.mmd_bootstrap_ms > 0,
    `bootstrap time must be recorded, got ${cp.mmd_bootstrap_ms}ms`);
});

test('compile-phases: fresh aggregator starts with zeroed accumulators', () => {
  // Pre-3d: "resetPhaseTimings zeros all accumulators" — tested module
  // state behaviour. Slice-3d replaces that contract: callers allocate
  // a fresh aggregator per compile via newCompileAggregatorExported().
  // Fresh-allocation produces all-zeros by construction.
  const agg = newCompileAggregatorExported();
  const cp = finalizePhaseTimings(agg.timings, 0n);
  assert.equal(cp.cov_estimation_ms, 0);
  assert.equal(cp.mmd_bootstrap_ms, 0);
  assert.equal(cp.conformal_calibration_ms, 0);
  assert.equal(cp.tau2_fit_ms, 0);
  assert.equal(cp.mcd_skipped_low_variance_cells, 0);
  assert.equal(cp.mmd_bootstrap_skipped_cells, 0);
});

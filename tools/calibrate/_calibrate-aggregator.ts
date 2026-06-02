// tools/calibrate/_calibrate-aggregator.ts — compile-local timing/diagnostic
// aggregator + phase-timing finalization. Extracted VERBATIM from the
// pre-split tools/calibrate.ts god-file (D-54-3 god-file decomposition).
//
// ── REPLY-50 D7 / slice-3d — compile-phase timing instrumentation ──
//
// Wall-clock accumulators (nanoseconds) for each compile phase live in
// a COMPILE-LOCAL `CompileAggregator` — slice-3d completion of
// ARCHITECT-REPLY-54b Option 3. `main()` calls `newCompileAggregator()`
// at start and threads it through the dispatch layer; per-family pure
// calibrators return { timings, diagnostics } structs that the caller
// merges. Worker-dispatched cells return structured replies that main-
// thread onReply unpacks into the same aggregator. No module-level
// state remains; `finalizePhaseTimings` + `summarizeD6bDiagnostics`
// take explicit state arguments instead of reading from the module.

import type { CompilePhases } from '../../engine/types';
import {
  D6B_LAMBDA_THRESHOLD,
  D6B_OUTLIER_FRACTION_THRESHOLD,
} from '../calibrators/family-c.js';
import type {
  PhaseTimingsNs, CompileAggregator, D6bCellDiagnostic,
} from './_calibrate-types.js';

export function newPhaseTimings(): PhaseTimingsNs {
  return {
    l0_prep_ns: 0n,
    cov_estimation_ns: 0n,
    mmd_bootstrap_ns: 0n,
    conformal_calibration_ns: 0n,
    tau2_fit_ns: 0n,
    worker_pool_overhead_ns: 0n,
    mcd_skipped_low_variance_cells: 0,
    mmd_bootstrap_skipped_cells: 0,
  };
}

export function newCompileAggregator(): CompileAggregator {
  return { timings: newPhaseTimings(), d6b_cells: [] };
}

/** D-54-3 slice 3d — export the compile-aggregator factory so tests
 *  and external tools can construct a fresh aggregator per compile
 *  invocation without reaching for module state. */
export function newCompileAggregatorExported(): CompileAggregator {
  return newCompileAggregator();
}

export function summarizeD6bDiagnostics(d6b: D6bCellDiagnostic[]): void {
  if (d6b.length === 0) return;
  const nCells = d6b.length;
  const skipped = d6b.filter((d) => d.skipped).length;
  const lambdaBelow = d6b.filter((d) => d.lambda < D6B_LAMBDA_THRESHOLD).length;
  const outlierBelow = d6b.filter((d) => d.outlier_fraction < D6B_OUTLIER_FRACTION_THRESHOLD).length;
  const bothBelow = d6b.filter(
    (d) => d.lambda < D6B_LAMBDA_THRESHOLD && d.outlier_fraction < D6B_OUTLIER_FRACTION_THRESHOLD,
  ).length;
  // λ and outlier-fraction percentiles across the MCD-eligible cells.
  const lambdas = d6b.map((d) => d.lambda).sort((a, b) => a - b);
  const outliers = d6b.map((d) => d.outlier_fraction).sort((a, b) => a - b);
  const pct = (xs: number[], q: number): number => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  console.log(
    `  D6b Q2 diagnostics: MCD-eligible cells=${nCells}  skipped=${skipped}  `
    + `λ<${D6B_LAMBDA_THRESHOLD}: ${lambdaBelow}/${nCells}  `
    + `outlier_frac<${D6B_OUTLIER_FRACTION_THRESHOLD}: ${outlierBelow}/${nCells}  `
    + `both: ${bothBelow}/${nCells}`,
  );
  console.log(
    `    λ percentiles p50=${pct(lambdas, 0.5).toFixed(4)}  p90=${pct(lambdas, 0.9).toFixed(4)}  `
    + `outlier_frac percentiles p50=${pct(outliers, 0.5).toFixed(4)}  p90=${pct(outliers, 0.9).toFixed(4)}`,
  );
}

export function hrNow(): bigint { return process.hrtime.bigint(); }
export function nsToMs(ns: bigint): number { return Number(ns / 1000000n) + Number(ns % 1000000n) / 1e6; }

/** Compose a CompilePhases struct from explicit timing state +
 *  total elapsed wall time. Pre-slice-3d read module state; now
 *  takes the caller's aggregator timings as the source of truth.
 *  Exported for test consumption + for callers who want to compose
 *  a CompilePhases from a captured aggregator state. */
export function finalizePhaseTimings(timings: PhaseTimingsNs, totalNs: bigint): CompilePhases {
  // Make phases disjoint so `sum(phase_ms) ≈ total_ms`. The
  // cov_estimation accumulator wraps the whole buildFamilyCPerCell
  // call (covers MCD + MRCD + LW + MMD params construction + safe-
  // Hotelling + e-MMD). The mmd_bootstrap accumulator is a zoom-in
  // on just the 2000-shot bootstrap inside buildMMDParams, so it
  // already counts inside cov_estimation. Subtract it out for the
  // reported cov_estimation_ms; residual (worker-pool overhead + I/O
  // not attributed to any phase) ends up as total − sum.
  const covEstNetNs = timings.cov_estimation_ns - timings.mmd_bootstrap_ns;
  return {
    l0_prep_ms: Math.round(nsToMs(timings.l0_prep_ns)),
    cov_estimation_ms: Math.round(nsToMs(covEstNetNs < 0n ? 0n : covEstNetNs)),
    mmd_bootstrap_ms: Math.round(nsToMs(timings.mmd_bootstrap_ns)),
    conformal_calibration_ms: Math.round(nsToMs(timings.conformal_calibration_ns)),
    tau2_fit_ms: Math.round(nsToMs(timings.tau2_fit_ns)),
    worker_pool_overhead_ms: Math.round(nsToMs(timings.worker_pool_overhead_ns)),
    total_ms: Math.round(nsToMs(totalNs)),
    mcd_skipped_low_variance_cells: timings.mcd_skipped_low_variance_cells,
    mmd_bootstrap_skipped_cells: timings.mmd_bootstrap_skipped_cells,
  };
}

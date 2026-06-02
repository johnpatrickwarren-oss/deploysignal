// tools/calibrate/_calibrate-family-wrappers.ts — thin wrappers around the
// pure per-family calibrators (family-a/c/d/e) that thread the compile-local
// aggregator's timing accumulators. Extracted VERBATIM from the pre-split
// tools/calibrate.ts god-file (D-54-3 god-file decomposition). No numeric or
// behavioral change.

import type {
  CompilerOptions, FamilyAPerSignalParams, FamilyCPerCell, FamilyDPerSignal,
} from '../../engine/types';
import type { SignalClass } from '../../engine/signal-classes.js';
import type { CompileAggregator } from './_calibrate-types.js';

// D-54-3 slice 3c — Family C (MCD / MRCD / Ledoit-Wolf routing +
// safe-Hotelling + e-MMD + D6b diagnostic) extracted to
// tools/calibrators/family-c.ts (Option 3 side-effect-free).
import {
  buildFamilyCPerCell as _buildFamilyCPerCellPure,
} from '../calibrators/family-c.js';

// D-54-3 slice 3b — buildFamilyAPerSignal extracted to
// tools/calibrators/family-a.ts (Option 3 side-effect-free).
import {
  buildFamilyAPerSignal as _buildFamilyAPerSignalPure,
} from '../calibrators/family-a.js';

// D-54-3 slice 3b — Family D extracted to tools/calibrators/family-d.ts.
import {
  buildFamilyDForSignalAR1 as _buildFamilyDForSignalAR1Pure,
} from '../calibrators/family-d.js';

/** D-54-3 slice 3c/3d — wrapper around the pure Family C calibrator.
 *  When `agg` is provided, timings + D6b diagnostics accumulate into
 *  the compile-local aggregator; when omitted (test-harness inline
 *  usage), the wrapper returns a bare cell with timings discarded.
 *  Slice-3d removed the module-level aggregator state. */
export function buildFamilyCPerCell(
  rows: number[][],
  opts: CompilerOptions = {},
  key?: Record<string, string | number>,
  alphaMMD?: number,
  agg?: CompileAggregator,
): FamilyCPerCell {
  const { result, timings, diagnostics } = _buildFamilyCPerCellPure(rows, opts, key, alphaMMD);
  if (agg) {
    agg.timings.cov_estimation_ns += timings.cov_estimation_ns;
    agg.timings.mmd_bootstrap_ns += timings.mmd_bootstrap_ns;
    agg.timings.mmd_bootstrap_skipped_cells += timings.mmd_bootstrap_skipped_cells;
    agg.timings.mcd_skipped_low_variance_cells += timings.mcd_skipped_low_variance_cells;
    for (const d of diagnostics.d6b_cells) agg.d6b_cells.push(d);
  }
  return result;
}

/** D-54-3 slice 3b/3d — wrapper around pure extracted function.
 *  Delegates to tools/calibrators/family-a.ts. When `agg` is passed,
 *  timings accumulate into the compile-local aggregator; when omitted
 *  (test-harness inline usage), the wrapper returns a bare cell and
 *  timings are discarded. Slice-3d removed the module-level
 *  `_phaseTimings`; callers thread state explicitly now. */
export function buildFamilyAPerSignal(
  samples: number[],
  agg?: CompileAggregator,
  signalClass: SignalClass = 'gaussian_like',
): FamilyAPerSignalParams {
  const { result, timings } = _buildFamilyAPerSignalPure(samples, signalClass);
  if (agg) agg.timings.tau2_fit_ns += timings.tau2_fit_ns;
  return result;
}

/** D-54-3 slice 3b — wrapper around pure extracted function.
 *
 *  Q2.B.7 — routes to AR(1)-aware bootstrap path (buildFamilyDForSignalAR1)
 *  by default. Stamps `ar1_phi` + `ar1_sigma_eps` per signal so the
 *  parametric_ar1 resampler in tools/build-report-card.js can drive
 *  AR(1)-aware H₀ generation. Pre-Q2.B.7 iid bootstrap path retained
 *  in the calibrator module (buildFamilyDForSignal) for shadow-compare
 *  + force_legacy_family_d operator override. */
export function buildFamilyDForSignal(
  allSamples: number[], alphaD: number, seed: number, useLegacy: boolean,
): FamilyDPerSignal | null {
  const { result } = _buildFamilyDForSignalAR1Pure(allSamples, alphaD, seed, useLegacy);
  return result;
}

// tools/calibrators/_family-c-mmd.ts — Sequential-MMD compile-time
// precompute (bandwidth, baseline×baseline sum, bootstrap null quantile,
// per-cell seeding, MMDParams builder). Split VERBATIM from family-c.ts
// (End-phase slice 3c, D-54-3); no computation changed. Re-exported
// through the family-c.ts facade so the public surface is unchanged.

import type { MMDParams } from '../../engine/types';
import { mulberry32 } from './_shared.js';
import { columnMean, relativeDeviations } from './_family-c-covariance.js';

// ── Sequential MMD compile-time precompute ──────────────────────

/** Bandwidth via the median heuristic. */
export function medianPairwiseDistance(rows: number[][]): number {
  const n = rows.length;
  const p = rows[0].length;
  const capN = Math.min(n, 1000);
  const distances: number[] = [];
  for (let i = 0; i < capN; i++) {
    for (let j = i + 1; j < capN; j++) {
      let s = 0;
      for (let k = 0; k < p; k++) { const d = rows[i][k] - rows[j][k]; s += d * d; }
      distances.push(Math.sqrt(s));
    }
  }
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)] || 1;
}

/** Gaussian RBF kernel k(x, y) = exp(-||x - y||² / (2·σ²)). */
export function rbfKernel(x: number[], y: number[], bandwidth: number): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; s += d * d; }
  return Math.exp(-s / (2 * bandwidth * bandwidth));
}

/** Third term of the MMD U-statistic: sum over all baseline×baseline pairs. */
export function mmdBaselineBaselineSum(rows: number[][], bandwidth: number): number {
  const m = rows.length;
  let sum = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i === j) continue;
      sum += rbfKernel(rows[i], rows[j], bandwidth);
    }
  }
  return sum;
}

/** Bootstrap null quantile. */
export function mmdBootstrapNullQuantile(
  rows: number[][],
  bandwidth: number,
  baselineBaselineSum: number,
  windowSize: number,
  alpha: number,
  nBootstraps: number,
  seed: number,
): number {
  const m = rows.length;
  const b = windowSize;
  if (m < b + 1) return 0;
  const rng = mulberry32(seed);
  const samples = new Array(nBootstraps);
  const baselineBaselineTerm = baselineBaselineSum / (m * (m - 1));
  for (let bi = 0; bi < nBootstraps; bi++) {
    const window: number[][] = new Array(b);
    for (let i = 0; i < b; i++) window[i] = rows[Math.floor(rng() * m)];
    let xx = 0, xy = 0;
    for (let i = 0; i < b; i++) {
      for (let j = 0; j < b; j++) {
        if (i !== j) xx += rbfKernel(window[i], window[j], bandwidth);
      }
      for (let j = 0; j < m; j++) xy += rbfKernel(window[i], rows[j], bandwidth);
    }
    const U = (xx / (b * (b - 1))) - (2 * xy / (b * m)) + baselineBaselineTerm;
    samples[bi] = U;
  }
  samples.sort((a: number, b2: number) => a - b2);
  const q = samples[Math.min(samples.length - 1, Math.floor((1 - alpha) * samples.length))];
  return q;
}

export const MMD_BOOTSTRAP_SEED_BASE = 0xFAAD >>> 0;
export function mmdSeedForCell(key: Record<string, string | number>): number {
  let h = MMD_BOOTSTRAP_SEED_BASE;
  for (const [k, v] of Object.entries(key).sort()) {
    const s = `${k}=${v};`;
    for (let i = 0; i < s.length; i++) h = ((h + s.charCodeAt(i)) * 1103515245 + 12345) >>> 0;
  }
  return h >>> 0;
}

export const MMD_WINDOW_SIZE = 30;
export const MMD_BOOTSTRAP_N = 2000;
// Per ARCHITECT-REPLY-52g (Shekhar–Ramdas 2023 §5 empirical-floor):
// betting-e-MMD calibration is well-conditioned for n ≥ 100; the prior
// 500-sample floor was conservative beyond what the literature supports.
// Lowering 500→100 lets per-cell baselines at synthetic-v1 scale and
// realistic real-data densities qualify for the Ville-bounded e-MMD path
// rather than falling back to the classical bootstrap-null variant.
export const MMD_MIN_BASELINE_SAMPLES = 100;

/** Inner MMD-params builder — pure; returns its own timings slice that
 *  buildFamilyCPerCell folds into the cov_estimation aggregate. */
export interface MMDParamsBuildResult {
  result: MMDParams | null;
  timings: {
    mmd_bootstrap_ns: bigint;
    mmd_bootstrap_skipped_cells: number;
  };
}

export function buildMMDParams(
  rows: number[][],
  alphaMMD: number,
  key: Record<string, string | number>,
  opts: { skipBootstrap?: boolean } = {},
): MMDParamsBuildResult {
  if (rows.length < MMD_MIN_BASELINE_SAMPLES) {
    return { result: null, timings: { mmd_bootstrap_ns: 0n, mmd_bootstrap_skipped_cells: 0 } };
  }
  const rawMean = columnMean(rows);
  const rawZ = relativeDeviations(rows, rawMean);
  const bandwidth = medianPairwiseDistance(rawZ);
  const baseSum = mmdBaselineBaselineSum(rawZ, bandwidth);
  let nullQuantile: number;
  let nullBootstraps: number;
  let mmdBootstrapNs = 0n;
  let mmdBootstrapSkippedCells = 0;
  if (opts.skipBootstrap) {
    nullQuantile = 0;
    nullBootstraps = 0;
    mmdBootstrapSkippedCells = 1;
  } else {
    const tBoot = process.hrtime.bigint();
    nullQuantile = mmdBootstrapNullQuantile(
      rawZ, bandwidth, baseSum, MMD_WINDOW_SIZE, alphaMMD,
      MMD_BOOTSTRAP_N, mmdSeedForCell(key),
    );
    nullBootstraps = MMD_BOOTSTRAP_N;
    mmdBootstrapNs = process.hrtime.bigint() - tBoot;
  }
  return {
    result: {
      kernel: 'gaussian_rbf',
      bandwidth,
      window_size: MMD_WINDOW_SIZE,
      baseline_baseline_sum: baseSum,
      null_quantile: nullQuantile,
      null_quantile_bootstraps: nullBootstraps,
      alpha: alphaMMD,
    },
    timings: {
      mmd_bootstrap_ns: mmdBootstrapNs,
      mmd_bootstrap_skipped_cells: mmdBootstrapSkippedCells,
    },
  };
}

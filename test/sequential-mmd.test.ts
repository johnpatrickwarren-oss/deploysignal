// test/sequential-mmd.test.ts — Addition #18 Part 2 acceptance.
//
// Sequential MMD detector. Tests exercise the math surface directly
// (computeUt + freshMMDState) without spinning up the full orchestrator
// — the operator-intent end-to-end path is covered by
// family-c-alpha-split.test.ts running on a compiled config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUt, freshMMDState } from '../dist/engine/detectors/sequential-mmd';
import type { MMDParams } from '../dist/engine/types';

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
function draw(n: number, p: number, mean: number[], sigma: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(p);
    for (let k = 0; k < p; k++) row[k] = mean[k] + sigma * gauss(rng);
    out.push(row);
  }
  return out;
}
function medianPairwise(rows: number[][]): number {
  const distances: number[] = [];
  const cap = Math.min(rows.length, 100);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      let s = 0;
      for (let k = 0; k < rows[i].length; k++) { const d = rows[i][k] - rows[j][k]; s += d * d; }
      distances.push(Math.sqrt(s));
    }
  }
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)] || 1;
}
function bbSum(rows: number[][], bw: number): number {
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      let d2 = 0;
      for (let k = 0; k < rows[i].length; k++) { const d = rows[i][k] - rows[j][k]; d2 += d * d; }
      s += Math.exp(-d2 / (2 * bw * bw));
    }
  }
  return s;
}

function makeParams(baseline: number[][], alpha: number): MMDParams {
  const bandwidth = medianPairwise(baseline);
  return {
    kernel: 'gaussian_rbf',
    bandwidth,
    window_size: 30,
    baseline_baseline_sum: bbSum(baseline, bandwidth),
    null_quantile: 0,  // not used by computeUt itself
    null_quantile_bootstraps: 0,
    alpha,
  };
}

// ────────────────────────────────────────────────────────────────────
// Unit tests.
// ────────────────────────────────────────────────────────────────────

test('mmd unit 1: freshMMDState returns empty window', () => {
  const s = freshMMDState();
  assert.equal(s.window.length, 0);
  assert.equal(s.ticks_observed, 0);
});

test('mmd unit 2: scale-invariance — U_t is invariant to global baseline rescaling', () => {
  // Draw a baseline; draw a same-distribution live window. Compute U_t
  // under two scales (1x and 5x). Median-heuristic bandwidth scales
  // proportionally → U_t numerically identical.
  const baseline = draw(200, 4, [0, 0, 0, 0], 1.0, 0xBA5E);
  const live = draw(30, 4, [0, 0, 0, 0], 1.0, 0xAC70);
  const scaled = (rows: number[][], s: number) => rows.map((r) => r.map((v) => v * s));
  const u1 = computeUt(live, baseline, makeParams(baseline, 1e-4));
  const baseline5 = scaled(baseline, 5);
  const live5 = scaled(live, 5);
  const u5 = computeUt(live5, baseline5, makeParams(baseline5, 1e-4));
  assert.ok(
    Math.abs(u1 - u5) < 1e-6,
    `MMD U_t must be scale-invariant with median bandwidth; got |u1 - u5| = ${Math.abs(u1 - u5)}`,
  );
});

test('mmd unit 3: detection power — bimodality emergence raises U_t substantially', () => {
  // Clean baseline = single-mode Gaussian at origin.
  // "Live under H₀" = same distribution → small U_t.
  // "Live under bimodal drift" = 50/50 mixture of N([+3,+3], I) and
  //   N([-3,-3], I) — same global mean as baseline, much higher
  //   variance. Sequential MMD catches this; Hotelling T² (mean-shift
  //   only) would not.
  const baseline = draw(300, 2, [0, 0], 1.0, 0xB1CE);
  const liveClean = draw(30, 2, [0, 0], 1.0, 0x1CE0);
  // Bimodal window.
  const liveBimodal: number[][] = [];
  const rng = mulberry32(0x81B0);
  for (let i = 0; i < 30; i++) {
    const pick = rng() < 0.5 ? [3, 3] : [-3, -3];
    liveBimodal.push([pick[0] + gauss(rng), pick[1] + gauss(rng)]);
  }
  const params = makeParams(baseline, 1e-4);
  const uClean = computeUt(liveClean, baseline, params);
  const uBimodal = computeUt(liveBimodal, baseline, params);
  assert.ok(
    uBimodal > uClean + 0.05,
    `bimodal drift must raise U_t substantially over null; clean=${uClean} bimodal=${uBimodal}`,
  );
});

test('mmd unit 4: null-distribution U_t stays small on in-distribution windows', () => {
  // 20 independent in-distribution windows. Median U_t should sit in a
  // small band around zero (within a few ×1e-3 for this kernel choice);
  // this is the Type-I-error sanity check — if the null distribution
  // were mis-calibrated, U_t would drift far from zero systematically.
  const baseline = draw(300, 3, [0, 0, 0], 1.0, 0xDE5E);
  const params = makeParams(baseline, 1e-4);
  const samples: number[] = [];
  for (let s = 0; s < 20; s++) {
    const live = draw(30, 3, [0, 0, 0], 1.0, 0xEA00 + s);
    samples.push(computeUt(live, baseline, params));
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  // For a well-calibrated kernel MMD on matched distributions, U_t is
  // Op(1/b); with b=30 that's 0.03 or so. Use a loose 0.1 bound.
  assert.ok(
    Math.abs(median) < 0.1,
    `median null U_t must sit near zero; got ${median}`,
  );
});

test('mmd unit 5: computeUt returns 0 on degenerate windows', () => {
  // Either of b < 2 or m < 2 collapses the U-statistic. Must not throw.
  const params: MMDParams = {
    kernel: 'gaussian_rbf', bandwidth: 1, window_size: 30,
    baseline_baseline_sum: 0, null_quantile: 0,
    null_quantile_bootstraps: 0, alpha: 1e-4,
  };
  assert.equal(computeUt([], [[1]], params), 0);
  assert.equal(computeUt([[1]], [], params), 0);
  assert.equal(computeUt([[1]], [[1]], params), 0);
});

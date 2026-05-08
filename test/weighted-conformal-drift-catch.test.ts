// test/weighted-conformal-drift-catch.test.ts — Addition #19 (ARCHITECT-
// REPLY-35) drift-catch demonstration.
//
// Scenario: a baseline where old samples are drawn from a wide
// distribution and recent samples from a tight distribution. Under
// unweighted conformal, the threshold is dominated by the old wide tail
// — the detector stays permissive. Under weighted conformal with a
// half-life shorter than the baseline span, the threshold tightens
// toward the recent-tight tail and a drift-injected live signal fires
// when it wouldn't have under the legacy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFamilyE } from '../dist/engine/detectors/conformal';
import { FAMILY_C_SIGNALS } from '../dist/engine/detectors/hotelling';
import { weightedQuantile } from '../dist/engine/detectors/_linalg';
import type {
  CompiledConfig, FamilyCPerCell, ConformalParams,
} from '../dist/engine/types';

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
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function buildCfg(famE: ConformalParams, famC: FamilyCPerCell, alphaE: number): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.1.0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: alphaE } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: 20000, confidence: 'strict',
        family_C: famC,
        family_E: famE,
      }],
      aggregate_fallback: { family_C: famC, family_E: famE },
    },
  };
}

test('weighted conformal catches drift that unweighted misses on a nonstationary baseline', () => {
  // Construct a nonstationary bootstrap distribution directly: half of
  // the scores are "old wide" (scaled up by 3×), half are "recent tight"
  // (scaled down by 0.3×). The Mahalanobis Σ used by the detector is
  // identity for this test so the live score equals the raw deviation
  // norm.
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  const mean = Array.from({ length: p }, (_, i) => (i === 0 ? 100 : 1));
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov };

  const M = 20000;
  const rng = mulberry32(0xBEEF);
  const scoresOld: number[] = [];
  const scoresRecent: number[] = [];
  for (let m = 0; m < M / 2; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) { const w = gaussian(rng); sum += w * w; }
    scoresOld.push(Math.sqrt(sum) * 3);    // old wide tail
  }
  for (let m = 0; m < M / 2; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) { const w = gaussian(rng); sum += w * w; }
    scoresRecent.push(Math.sqrt(sum) * 0.3); // recent tight tail
  }
  const scoresMixed = [...scoresOld, ...scoresRecent];
  const weightsOld = new Array(M / 2).fill(Math.exp(-10));    // old: near-zero weight
  const weightsRecent = new Array(M / 2).fill(1);             // recent: full weight
  const weightsMixed = [...weightsOld, ...weightsRecent];
  // Sort pair by ascending score for downstream consumers (matches
  // compiler convention).
  const idx = Array.from({ length: M }, (_, i) => i);
  idx.sort((a, b) => scoresMixed[a] - scoresMixed[b]);
  const sortedS = idx.map(i => scoresMixed[i]);
  const sortedW = idx.map(i => weightsMixed[i]);

  // Loose α so the threshold test is numerically robust.
  const alphaE = 0.001;

  // Unweighted: legacy shape preserves all M scores with uniform weight.
  const legacyE: ConformalParams = { calibration_scores: sortedS };
  // Weighted: same scores, decayed weights.
  let sw = 0, sw2 = 0;
  for (const w of sortedW) { sw += w; sw2 += w * w; }
  const weightedE: ConformalParams = {
    kind: 'weighted',
    scores: sortedS, weights: sortedW, halflife_days: 1,
    effective_sample_size: (sw * sw) / sw2,
    calibration_method: 'weighted_parametric_gaussian_bootstrap',
  };

  // Sanity: weighted threshold < unweighted threshold (recent tight tail
  // dominates under decay weights).
  const qU = weightedQuantile(sortedS, new Array(M).fill(1), 1 - alphaE);
  const qW = weightedQuantile(sortedS, sortedW, 1 - alphaE);
  assert.ok(qW < qU,
    `weighted threshold ${qW.toFixed(3)} must be tighter than unweighted ${qU.toFixed(3)}`);

  // Drift-injected live signal: Mahalanobis score between qW and qU —
  // exceeds weighted threshold, sits below unweighted threshold.
  // The detector uses relative deviation r_i = (x_i − μ_i) / μ_i under
  // identity covariance, so setting r[0] = targetScore and r[i≥1] = 0
  // yields a Mahalanobis norm exactly equal to targetScore.
  const targetScore = (qW + qU) / 2;
  const live: Record<string, number> = {};
  live[FAMILY_C_SIGNALS[0]] = mean[0] * (1 + targetScore);
  for (let i = 1; i < p; i++) live[FAMILY_C_SIGNALS[i]] = mean[i];

  // Unweighted: must not fire (score < threshold).
  const cfgU = buildCfg(legacyE, famC, alphaE);
  const vU = evaluateFamilyE(cfgU, live, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  // Unweighted fires when conformal p < α. For the injected score
  // between qU (unweighted (1-α)-quantile) and qW, p is slightly above α
  // and verdict is 'clean'.
  assert.equal(vU!.verdict, 'clean',
    `unweighted path must miss the drift at intermediate score; got ${vU!.verdict}`);

  // Weighted: must fire (score > weighted threshold).
  const cfgW = buildCfg(weightedE, famC, alphaE);
  const vW = evaluateFamilyE(cfgW, live, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vW!.verdict, 'fire',
    `weighted path must catch the drift the unweighted path missed; got ${vW!.verdict}`);
  assert.equal(vW!.reason_code, 'weighted_conformal_threshold_exceeded');
});

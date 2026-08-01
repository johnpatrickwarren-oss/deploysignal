// test/weighted-conformal-migration.test.ts — Addition #19 (ARCHITECT-REPLY-35
// D8) backward-compat gate. The discriminated-union migration must accept both:
//   1. Legacy shape `{ calibration_scores: [...] }` (no `kind`) parses as
//      the unweighted variant; `evaluateFamilyE` routes through the
//      standard conformal p-value path.
//   2. New `{ kind: 'weighted', scores, weights, ... }` variant routes
//      through the weighted-quantile threshold path and produces
//      equivalent behavior on a temporally-uniform synthetic baseline
//      (weighting is near-identity there, so fire points must coincide
//      within ε tolerance).
//
// No on-disk v4 recompile is required: both variants are constructed
// inline with deterministic bootstrap seeds so the test is reproducible
// on any checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFamilyE } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/conformal';
import { FAMILY_C_SIGNALS } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/hotelling';
import { isWeightedConformal } from '../dist/engine/types';
import type {
  CompiledConfig, FamilyCPerCell, ConformalParams,
} from '../dist/engine/types';

/** Deterministic mulberry32 + Box-Muller. Same RNG the compiler uses. */
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

function buildCfg(famE: ConformalParams, famC: FamilyCPerCell): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.1.0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: 1e-4 } },
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

test('weighted-conformal migration: legacy `{calibration_scores}` (no kind) routes through unweighted path', () => {
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 0.01 : 0)));
  const mean = Array.from({ length: p }, (_, i) => (i === 0 ? 100 : 1));
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov };
  // Bootstrap M scores from N(0, I) deterministically.
  const M = 20000;
  const rng = mulberry32(0xFA01E);
  const scores: number[] = new Array(M);
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) { const w = gaussian(rng); sum += w * w; }
    scores[m] = Math.sqrt(sum);
  }
  scores.sort((a, b) => a - b);
  // Legacy shape: no `kind`, just `calibration_scores`.
  const legacyE = { calibration_scores: scores } as ConformalParams;
  assert.ok(!isWeightedConformal(legacyE), 'legacy shape must parse as unweighted');

  const cfg = buildCfg(legacyE, famC);
  // Clean tick: live at mean → small score → verdict 'clean'.
  const liveAtMean: Record<string, number> = {};
  for (let i = 0; i < p; i++) liveAtMean[FAMILY_C_SIGNALS[i]] = mean[i];
  const vClean = evaluateFamilyE(cfg, liveAtMean, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vClean!.verdict, 'clean');
  assert.equal(vClean!.reason_code, 'below_threshold');

  // Drift tick: live 50% off from mean → huge Mahalanobis score → 'fire'
  // via the legacy conformal-p path (reason_code conformal_p_below_threshold).
  const liveHigh: Record<string, number> = {};
  for (let i = 0; i < p; i++) liveHigh[FAMILY_C_SIGNALS[i]] = mean[i] * 1.5;
  const vFire = evaluateFamilyE(cfg, liveHigh, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vFire!.verdict, 'fire');
  assert.equal(vFire!.reason_code, 'conformal_p_below_threshold');
});

test('weighted-conformal migration: weighted variant on uniform-weight fixture matches unweighted outcomes', () => {
  // On a temporally-uniform synthetic baseline the weighting is near-
  // identity (all ages ≈ span/2 → roughly equal weights). A deterministic
  // bootstrap of scores + weights must produce the same fire/clean
  // verdicts as the legacy path on identical live ticks.
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 0.01 : 0)));
  const mean = Array.from({ length: p }, (_, i) => (i === 0 ? 100 : 1));
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov };
  const M = 20000;
  const rng = mulberry32(0xFA01E);
  const scores: number[] = new Array(M);
  const weights: number[] = new Array(M);
  // Weights chosen ≈ uniform: decay exponent small vs span → w_m ≈ 1.
  const halflife = 14;  // days
  const span = 7;       // days
  const lambda = Math.log(2) / halflife;
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let i = 0; i < p; i++) { const w = gaussian(rng); sum += w * w; }
    scores[m] = Math.sqrt(sum);
    const age = rng() * span;
    weights[m] = Math.exp(-lambda * age);
  }
  const idx = Array.from({ length: M }, (_, i) => i);
  idx.sort((a, b) => scores[a] - scores[b]);
  const sortedS = idx.map(i => scores[i]);
  const sortedW = idx.map(i => weights[i]);
  let sw = 0, sw2 = 0;
  for (const w of sortedW) { sw += w; sw2 += w * w; }
  const weightedE: ConformalParams = {
    kind: 'weighted',
    scores: sortedS, weights: sortedW,
    halflife_days: halflife,
    effective_sample_size: (sw * sw) / sw2,
    calibration_method: 'weighted_parametric_gaussian_bootstrap',
  };
  assert.ok(isWeightedConformal(weightedE));
  assert.ok(weightedE.effective_sample_size > 0.9 * M,
    `near-uniform weights should preserve >90% ESS; got ${weightedE.effective_sample_size.toFixed(0)}/${M}`);

  const cfg = buildCfg(weightedE, famC);
  // Clean tick.
  const liveAtMean: Record<string, number> = {};
  for (let i = 0; i < p; i++) liveAtMean[FAMILY_C_SIGNALS[i]] = mean[i];
  const vClean = evaluateFamilyE(cfg, liveAtMean, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vClean!.verdict, 'clean');
  assert.equal(vClean!.reason_code, 'below_threshold');

  // Fire tick.
  const liveHigh: Record<string, number> = {};
  for (let i = 0; i < p; i++) liveHigh[FAMILY_C_SIGNALS[i]] = mean[i] * 1.5;
  const vFire = evaluateFamilyE(cfg, liveHigh, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vFire!.verdict, 'fire');
  assert.equal(vFire!.reason_code, 'weighted_conformal_threshold_exceeded');
  assert.ok(vFire!.threshold !== null && vFire!.statistic !== null);
  assert.ok(vFire!.statistic! > vFire!.threshold!,
    'fire requires live score > weighted threshold');
});

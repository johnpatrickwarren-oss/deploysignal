// test/weighted-quantile.test.ts — Addition #19 (ARCHITECT-REPLY-35 D4) unit
// tests for the weightedQuantile primitive.
//
// Three gates per the brief:
//   1. Uniform weights → standard empirical quantile (regression guard)
//   2. Skewed weights → quantile shifts toward the weighted mass
//   3. ESS bound → weighted reduces to n_effective samples; caller uses
//      the returned threshold rather than a discrete p-value

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weightedQuantile } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_linalg';

test('weightedQuantile: uniform weights reduce to standard empirical quantile', () => {
  const scores = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const weights = new Array(scores.length).fill(1);
  // The (1 − 0.1)-th quantile of [1..10] under uniform weights: smallest
  // score with cumulative ≥ 0.9 → rank 9 → score 9.
  assert.equal(weightedQuantile(scores, weights, 0.9), 9);
  // Median (q = 0.5): smallest with cumulative ≥ 0.5 → rank 5 → score 5.
  assert.equal(weightedQuantile(scores, weights, 0.5), 5);
  // q = 1.0: last score.
  assert.equal(weightedQuantile(scores, weights, 1.0), 10);
});

test('weightedQuantile: skewed weights shift quantile toward weighted mass', () => {
  // All weight on the max score → any q > 0 returns the max.
  const scores = [1, 2, 3, 4, 5];
  const weightsMax = [0, 0, 0, 0, 1];
  assert.equal(weightedQuantile(scores, weightsMax, 0.5), 5);
  assert.equal(weightedQuantile(scores, weightsMax, 0.99), 5);

  // All weight on the min score → any q ≤ 1 returns the min.
  const weightsMin = [1, 0, 0, 0, 0];
  assert.equal(weightedQuantile(scores, weightsMin, 0.5), 1);
  assert.equal(weightedQuantile(scores, weightsMin, 0.99), 1);

  // Half-half on scores 2 and 4 → median pulls to 2 or 4 depending on q.
  const weightsPair = [0, 1, 0, 1, 0];
  assert.equal(weightedQuantile(scores, weightsPair, 0.5), 2);
  assert.equal(weightedQuantile(scores, weightsPair, 0.6), 4);
});

test('weightedQuantile: time-decay shifts tail mass toward recent-sample scores', () => {
  // 100 scores; pretend the first 50 are "old wide" (values 5-10) and the
  // last 50 are "recent tight" (values 0-1). Under uniform weights the
  // 0.9-quantile lives in the wide tail; under decay weights favoring the
  // recent half, the 0.9-quantile tightens toward 1.
  const scores: number[] = [];
  for (let i = 0; i < 50; i++) scores.push(5 + (i / 50) * 5);  // 5..10
  for (let i = 0; i < 50; i++) scores.push(i / 50);            // 0..1
  const uniform = new Array(100).fill(1);
  const decay   = new Array(100);
  // Old (first 50) weight ≈ e^{-10} ≈ 4.5e-5; recent (last 50) weight 1.
  for (let i = 0; i < 50; i++) decay[i] = Math.exp(-10);
  for (let i = 50; i < 100; i++) decay[i] = 1;
  const qU = weightedQuantile(scores, uniform, 0.9);
  const qD = weightedQuantile(scores, decay,   0.9);
  assert.ok(qU >= 5, `uniform-weighted q=0.9 in wide tail; got ${qU}`);
  assert.ok(qD < 1.5, `decay-weighted q=0.9 tightened toward recent tail; got ${qD}`);
  assert.ok(qD < qU, 'decay-weighted threshold must be strictly below uniform');
});

test('weightedQuantile: length mismatch throws; empty scores returns 0', () => {
  assert.throws(() => weightedQuantile([1, 2, 3], [1, 1], 0.5), /length mismatch/);
  assert.equal(weightedQuantile([], [], 0.5), 0);
});

test('weightedQuantile: zero-total weights falls back to max score', () => {
  const scores = [1, 2, 3, 4, 5];
  const weights = [0, 0, 0, 0, 0];
  assert.equal(weightedQuantile(scores, weights, 0.5), 5);
});

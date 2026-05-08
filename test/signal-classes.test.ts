// test/signal-classes.test.ts — Q2.A signal-class transforms.
//
// Per ARCHITECT Q2-A-SIGNAL-CLASS-REGISTRY-SPEC §Tests. Unit coverage
// of transform monotonicity, boundary clipping, inverse operation, and
// DEFAULT_SIGNAL_CLASSES coverage. Translated from spec's
// describe/it (jest-style) into node:test (DeploySignal convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  transformForClass,
  logitTransform,
  logTransform,
  anscombeTransform,
  resolveSignalClass,
  DEFAULT_SIGNAL_CLASSES,
  LOGIT_BOUNDARY_EPS,
  LOG_FLOOR_EPS,
} from '../engine/signal-classes';

// ── logitTransform ────────────────────────────────────────────────

test('logitTransform: x = 0.5 maps to 0', () => {
  assert.equal(logitTransform(0.5), 0);
});

test('logitTransform: handles boundary x = 0 via clipping (no -Infinity)', () => {
  const y = logitTransform(0);
  assert.ok(Number.isFinite(y), `logit(0) must be finite; got ${y}`);
  // Clipped to LOGIT_BOUNDARY_EPS → ≈ log(eps/(1-eps)) ≈ −20.72
  const expected = Math.log(LOGIT_BOUNDARY_EPS / (1 - LOGIT_BOUNDARY_EPS));
  assert.ok(Math.abs(y - expected) < 1e-9, `logit(0) expected ≈ ${expected}; got ${y}`);
});

test('logitTransform: handles boundary x = 1 via clipping (no +Infinity)', () => {
  const y = logitTransform(1);
  assert.ok(Number.isFinite(y), `logit(1) must be finite; got ${y}`);
  const expected = Math.log((1 - LOGIT_BOUNDARY_EPS) / LOGIT_BOUNDARY_EPS);
  // Tolerance loosened to 1e-6 — FP precision: (1 - eps) ≠ exactly
  // 0.999...9, so the computed quotient deviates from (1-eps)/eps by a
  // few units in the last place. Numerical correctness is unaffected.
  assert.ok(Math.abs(y - expected) < 1e-6, `logit(1) expected ≈ ${expected}; got ${y}`);
});

test('logitTransform: monotonic increasing in x', () => {
  const xs = [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99];
  const ys = xs.map(logitTransform);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] > ys[i - 1],
      `logit non-monotonic at x=${xs[i]}: ${ys[i]} not > ${ys[i - 1]}`);
  }
});

test('logitTransform: inverse — sigmoid(logit(x)) ≈ x for x ∈ [ε, 1-ε]', () => {
  const xs = [0.01, 0.1, 0.5, 0.9, 0.99];
  for (const x of xs) {
    const z = logitTransform(x);
    const xRecovered = 1 / (1 + Math.exp(-z));
    assert.ok(Math.abs(xRecovered - x) < 1e-6,
      `inverse mismatch at x=${x}: got ${xRecovered}`);
  }
});

// ── logTransform ──────────────────────────────────────────────────

test('logTransform: handles x = 0 via floor clipping (no -Infinity)', () => {
  const y = logTransform(0);
  assert.ok(Number.isFinite(y), `log(0) must be finite; got ${y}`);
  const expected = Math.log(LOG_FLOOR_EPS);
  assert.ok(Math.abs(y - expected) < 1e-9, `log(0) expected ≈ ${expected}; got ${y}`);
});

test('logTransform: handles negative x via floor clipping', () => {
  const y = logTransform(-1);
  assert.ok(Number.isFinite(y), `log(-1) must be finite; got ${y}`);
  // Clipped to LOG_FLOOR_EPS
  assert.ok(Math.abs(y - Math.log(LOG_FLOOR_EPS)) < 1e-9);
});

test('logTransform: monotonic increasing for positive x', () => {
  assert.ok(logTransform(2) > logTransform(1));
  assert.ok(logTransform(100) > logTransform(10));
  assert.ok(logTransform(1) > logTransform(0.5));
});

test('logTransform: matches Math.log on x in normal range', () => {
  // For x well above LOG_FLOOR_EPS, transform is identity-with-Math.log.
  assert.ok(Math.abs(logTransform(1) - 0) < 1e-12);
  assert.ok(Math.abs(logTransform(Math.E) - 1) < 1e-12);
});

// ── anscombeTransform / counts ────────────────────────────────────

test('anscombeTransform: f(0) = 2·sqrt(3/8) ≈ 1.2247', () => {
  const expected = 2 * Math.sqrt(3 / 8);
  assert.ok(Math.abs(anscombeTransform(0) - expected) < 1e-12);
});

test('anscombeTransform: f(λ) → 2·sqrt(λ) for large λ (large-λ Poisson regime)', () => {
  // For λ = 100, f(100) = 2·sqrt(100 + 3/8) ≈ 20.0375; 2·√100 = 20.
  // Difference is small (≈ 0.04 / 20 = 0.2%); confirms Anscombe→sqrt
  // limit.
  const lambda = 100;
  const exact = anscombeTransform(lambda);
  const limit = 2 * Math.sqrt(lambda);
  assert.ok(Math.abs(exact - limit) < 0.05,
    `Anscombe(100)=${exact} should be near 2·sqrt(100)=${limit}`);
});

test('anscombeTransform: handles negative x defensively', () => {
  // Negative shouldn't occur on a count signal, but guard against FP
  // rounding making baseline samples slightly negative.
  const y = anscombeTransform(-0.001);
  assert.ok(Number.isFinite(y));
  // Clamps via max(0, x); equals f(0).
  const expected = 2 * Math.sqrt(3 / 8);
  assert.ok(Math.abs(y - expected) < 1e-12);
});

test('anscombeTransform: monotonic increasing for x ≥ 0', () => {
  assert.ok(anscombeTransform(1) > anscombeTransform(0));
  assert.ok(anscombeTransform(100) > anscombeTransform(50));
});

// ── transformForClass dispatch ────────────────────────────────────

test('transformForClass: gaussian_like is identity', () => {
  for (const x of [-1.5, 0, 0.5, 1, 100, 1e6]) {
    assert.equal(transformForClass(x, 'gaussian_like'), x);
  }
});

test('transformForClass: bounded_probability dispatches to logit', () => {
  assert.equal(
    transformForClass(0.5, 'bounded_probability'),
    logitTransform(0.5),
  );
  assert.equal(
    transformForClass(0.99, 'bounded_probability'),
    logitTransform(0.99),
  );
});

test('transformForClass: heavy_tail dispatches to log', () => {
  assert.equal(transformForClass(2, 'heavy_tail'), logTransform(2));
  assert.equal(transformForClass(0.001, 'heavy_tail'), logTransform(0.001));
});

test('transformForClass: counts dispatches to Anscombe', () => {
  assert.equal(transformForClass(0, 'counts'), anscombeTransform(0));
  assert.equal(transformForClass(100, 'counts'), anscombeTransform(100));
});

// ── DEFAULT_SIGNAL_CLASSES coverage ───────────────────────────────

test('DEFAULT_SIGNAL_CLASSES: classifies all six Family A signals', () => {
  const expected = [
    'p99_latency', 'ttft',
    'tool_success_rate', 'eval_score', 'downstream_err',
    'cost_req', 'tokens_turn',
  ];
  for (const sig of expected) {
    assert.ok(DEFAULT_SIGNAL_CLASSES[sig] !== undefined,
      `signal ${sig} missing from DEFAULT_SIGNAL_CLASSES`);
  }
});

test('DEFAULT_SIGNAL_CLASSES: tool_success_rate is bounded_probability', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.tool_success_rate, 'bounded_probability');
});

test('DEFAULT_SIGNAL_CLASSES: eval_score is bounded_probability', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.eval_score, 'bounded_probability');
});

test('DEFAULT_SIGNAL_CLASSES: downstream_err is bounded_probability', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.downstream_err, 'bounded_probability');
});

test('DEFAULT_SIGNAL_CLASSES: cost_req is heavy_tail', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.cost_req, 'heavy_tail');
});

test('DEFAULT_SIGNAL_CLASSES: tokens_turn is heavy_tail', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.tokens_turn, 'heavy_tail');
});

test('DEFAULT_SIGNAL_CLASSES: p99_latency / ttft are gaussian_like', () => {
  assert.equal(DEFAULT_SIGNAL_CLASSES.p99_latency, 'gaussian_like');
  assert.equal(DEFAULT_SIGNAL_CLASSES.ttft, 'gaussian_like');
});

// ── resolveSignalClass three-tier lookup ──────────────────────────

test('resolveSignalClass: explicit override wins', () => {
  assert.equal(
    resolveSignalClass('p99_latency', { p99_latency: 'heavy_tail' }),
    'heavy_tail',
    'override should beat default',
  );
});

test('resolveSignalClass: falls back to DEFAULT_SIGNAL_CLASSES', () => {
  assert.equal(resolveSignalClass('tool_success_rate'), 'bounded_probability');
  assert.equal(resolveSignalClass('cost_req', {}), 'heavy_tail');
});

test('resolveSignalClass: unknown signal defaults to gaussian_like', () => {
  assert.equal(resolveSignalClass('made_up_signal'), 'gaussian_like');
  assert.equal(resolveSignalClass('made_up_signal', {}), 'gaussian_like');
});

test('resolveSignalClass: empty override map = use defaults', () => {
  assert.equal(
    resolveSignalClass('eval_score', {}),
    'bounded_probability',
  );
});

// test/recalibration-classify.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 3.
//
// Exercises engine/recalibration/classify.ts: classifySignal (per-signal
// verdict) + classifyRecalibration (aggregate verdict across the active-
// vs-candidate signal-mean intersection).
//
// Rules under test (plan §C Task 3):
//   - relative delta (cand-act)/|act|, additive fallback when |act| <
//     1e-12 (mirrors baseline-drift-detector's relativeDeviationMean).
//   - |delta_rel| < epsilon (default 0.01, OQ-3) -> 'unchanged'.
//   - otherwise sign vs directionOfBetter; 'informational' w/o override
//     degrades on ANY non-unchanged move.
//   - excluded signals (traffic_pct) omitted from per_signal_direction.
//   - aggregate: all improved -> improvement; all degraded ->
//     degradation; both present -> mixed; all-unchanged -> mixed (OQ-4).
//   - suggested_reason_codes: [] for improvement; full closed set for
//     degradation/mixed.
//   - empty signal intersection throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySignal, classifyRecalibration, DEFAULT_UNCHANGED_EPSILON,
} from '../engine/recalibration/classify';
import { RECALIBRATION_REASON_CODES } from '../engine/types/recalibration';

// ── classifySignal: per-signal verdicts ─────────────────────────────

test('classifySignal: lower-is-better signal improves on a decrease', () => {
  // p99_latency: lower is better. 200 -> 150 is a 25% relative drop.
  assert.equal(classifySignal('p99_latency', 200, 150), 'improved');
});

test('classifySignal: lower-is-better signal degrades on an increase', () => {
  assert.equal(classifySignal('p99_latency', 150, 200), 'degraded');
});

test('classifySignal: higher-is-better signal improves on an increase', () => {
  // mfu: higher is better. 0.70 -> 0.80 is a ~14.3% relative rise.
  assert.equal(classifySignal('mfu', 0.70, 0.80), 'improved');
});

test('classifySignal: higher-is-better signal degrades on a decrease', () => {
  assert.equal(classifySignal('mfu', 0.80, 0.70), 'degraded');
});

test('classifySignal: informational signal w/o override degrades on an upward move', () => {
  // cost_req: informational, no direction. 0.004 -> 0.005 (+25% rel).
  assert.equal(classifySignal('cost_req', 0.004, 0.005), 'degraded');
});

test('classifySignal: informational signal w/o override degrades on a downward move too', () => {
  // Any non-unchanged move degrades an informational signal, regardless
  // of sign — there is no inherent "better" direction to credit.
  assert.equal(classifySignal('cost_req', 0.004, 0.003), 'degraded');
});

test('classifySignal: override flips an informational signal to standard higher/lower classification', () => {
  // Without an override, a 25% cost decrease still degrades (informational).
  assert.equal(classifySignal('cost_req', 0.004, 0.003), 'degraded');
  // With an operator override declaring cost_req 'lower is better', the
  // same decrease now classifies as an improvement.
  assert.equal(
    classifySignal('cost_req', 0.004, 0.003, { overrides: { cost_req: 'lower' } }),
    'improved',
  );
  // And an override declaring 'higher is better' flips the same delta to degraded.
  assert.equal(
    classifySignal('cost_req', 0.004, 0.003, { overrides: { cost_req: 'higher' } }),
    'degraded',
  );
});

test('classifySignal: epsilon dead-band — default 0.01 absorbs a small relative move', () => {
  // 200 -> 201 is a 0.5% relative move; below the default 1% epsilon.
  assert.equal(DEFAULT_UNCHANGED_EPSILON, 0.01);
  assert.equal(classifySignal('p99_latency', 200, 201), 'unchanged');
});

test('classifySignal: epsilon dead-band — a tighter epsilon lets the same move classify', () => {
  // Same 0.5% move, but epsilon = 0.001 (0.1%) no longer absorbs it.
  // p99_latency is lower-is-better; an increase degrades.
  assert.equal(classifySignal('p99_latency', 200, 201, { epsilon: 0.001 }), 'degraded');
});

test('classifySignal: additive fallback when |active mean| is near zero', () => {
  // active ~ 0: relative delta is undefined, so the additive fallback
  // (cand - act) applies directly, mirroring relativeDeviationMean.
  // hbm_spill is lower-is-better; active=0, candidate=0.02 is a rise
  // (0.02 >= default epsilon 0.01 in absolute terms under the fallback).
  assert.equal(classifySignal('hbm_spill', 0, 0.02), 'degraded');
  assert.equal(classifySignal('hbm_spill', 1e-13, 0.02), 'degraded');
});

test('classifySignal: traffic_pct is excluded, returns null', () => {
  assert.equal(classifySignal('traffic_pct', 1.0, 0.5), null);
});

test('classifySignal: unknown signal returns null', () => {
  assert.equal(classifySignal('made_up_signal_xyz', 1, 2), null);
});

// ── classifyRecalibration: aggregate verdicts ───────────────────────

test('classifyRecalibration: all-improving signals respecting higher/lower -> improvement', () => {
  const active = { p99_latency: 200, mfu: 0.70 };
  const candidate = { p99_latency: 150, mfu: 0.80 };
  const result = classifyRecalibration(active, candidate);
  assert.equal(result.direction_classification, 'improvement');
  assert.deepEqual(result.per_signal_direction, { p99_latency: 'improved', mfu: 'improved' });
  assert.deepEqual(result.suggested_reason_codes, []);
});

test('classifyRecalibration: all-degrading signals -> degradation with full reason-code list', () => {
  const active = { p99_latency: 150, mfu: 0.80 };
  const candidate = { p99_latency: 200, mfu: 0.70 };
  const result = classifyRecalibration(active, candidate);
  assert.equal(result.direction_classification, 'degradation');
  assert.deepEqual(result.per_signal_direction, { p99_latency: 'degraded', mfu: 'degraded' });
  assert.deepEqual(result.suggested_reason_codes, [...RECALIBRATION_REASON_CODES]);
});

test('classifyRecalibration: one improved + one degraded -> mixed', () => {
  const active = { p99_latency: 200, mfu: 0.80 };
  const candidate = { p99_latency: 150, mfu: 0.70 };
  const result = classifyRecalibration(active, candidate);
  assert.equal(result.direction_classification, 'mixed');
  assert.deepEqual(result.per_signal_direction, { p99_latency: 'improved', mfu: 'degraded' });
  assert.deepEqual(result.suggested_reason_codes, [...RECALIBRATION_REASON_CODES]);
});

test('classifyRecalibration: informational-only move -> degradation', () => {
  const active = { cost_req: 0.004 };
  const candidate = { cost_req: 0.005 };
  const result = classifyRecalibration(active, candidate);
  assert.equal(result.direction_classification, 'degradation');
  assert.deepEqual(result.per_signal_direction, { cost_req: 'degraded' });
});

test('classifyRecalibration: all-unchanged -> mixed (OQ-4)', () => {
  const active = { p99_latency: 200, mfu: 0.70 };
  const candidate = { p99_latency: 200.5, mfu: 0.7005 };
  const result = classifyRecalibration(active, candidate);
  assert.deepEqual(result.per_signal_direction, { p99_latency: 'unchanged', mfu: 'unchanged' });
  assert.equal(result.direction_classification, 'mixed');
  assert.deepEqual(result.suggested_reason_codes, [...RECALIBRATION_REASON_CODES]);
});

test('classifyRecalibration: traffic_pct is ignored in the aggregate + per-signal output', () => {
  const active = { p99_latency: 200, mfu: 0.70, traffic_pct: 1.0 };
  const candidate = { p99_latency: 150, mfu: 0.80, traffic_pct: 0.5 };
  const result = classifyRecalibration(active, candidate);
  assert.equal(result.direction_classification, 'improvement');
  assert.ok(!('traffic_pct' in result.per_signal_direction), 'traffic_pct must be omitted');
});

test('classifyRecalibration: empty signal intersection throws', () => {
  const active = { p99_latency: 200 };
  const candidate = { mfu: 0.8 };
  assert.throws(() => classifyRecalibration(active, candidate));
});

test('classifyRecalibration: overrides thread through to the aggregate classification', () => {
  const active = { cost_req: 0.004 };
  const candidate = { cost_req: 0.003 };
  const result = classifyRecalibration(active, candidate, { overrides: { cost_req: 'lower' } });
  assert.equal(result.direction_classification, 'improvement');
  assert.deepEqual(result.per_signal_direction, { cost_req: 'improved' });
  assert.deepEqual(result.suggested_reason_codes, []);
});

test('classifyRecalibration: custom epsilon threads through to per-signal classification', () => {
  const active = { p99_latency: 200 };
  const candidate = { p99_latency: 201 };
  const withDefault = classifyRecalibration(active, candidate);
  assert.deepEqual(withDefault.per_signal_direction, { p99_latency: 'unchanged' });
  const withTightEpsilon = classifyRecalibration(active, candidate, { epsilon: 0.001 });
  assert.deepEqual(withTightEpsilon.per_signal_direction, { p99_latency: 'degraded' });
});

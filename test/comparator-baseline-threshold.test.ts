// test/comparator-baseline-threshold.test.ts — WS6.2 Task 3 unit tests for
// the threshold-gate comparator arm (makeThresholdArm): step detection at
// the exact expected tick, sub-threshold-noise immunity, direction-table
// respect, m=1 edge case, and the sigma=0 guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeThresholdArm, type ThresholdParams } from '../tools/_comparator-baseline-threshold';
import type { CompiledConfig, HourDayCellKey } from '../tools/_comparator-baseline-types';

function fakeCompiledConfig(entries: Record<string, { mu: number; sigmaSq: number }>): CompiledConfig {
  const perSignal: Record<string, { baseline_mean: number; baseline_sigma_squared: number }> = {};
  for (const [signal, { mu, sigmaSq }] of Object.entries(entries)) {
    perSignal[signal] = { baseline_mean: mu, baseline_sigma_squared: sigmaSq };
  }
  return {
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: { family_A: { per_signal: perSignal } },
    },
  };
}

const cellKey: HourDayCellKey = { hour_of_day: 12, day_of_week: 3 };

test('threshold arm: step at a known tick fires at exactly stepTick + m - 1', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25 } }); // sigma = 5
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 3 },
    consecutiveTicks: 4,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const stepTick = 10;
  let firstFireTick: number | null = null;
  for (let t = 0; t < 30; t++) {
    const value = t < stepTick ? 100 : 100 + 4 * 5; // post-step z = 4 > k = 3
    const fired = arm.onTick(t, { p99_latency: value });
    if (fired.length > 0 && firstFireTick === null) firstFireTick = t;
  }
  assert.equal(firstFireTick, stepTick + params.consecutiveTicks - 1);
});

test('threshold arm: sub-threshold noise never fires', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25 } });
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 3 },
    consecutiveTicks: 3,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  let anyFire = false;
  for (let t = 0; t < 50; t++) {
    const value = 100 + ((t % 5) - 2) * 5; // z in [-2, 2], never exceeds k=3
    const fired = arm.onTick(t, { p99_latency: value });
    if (fired.length > 0) anyFire = true;
  }
  assert.equal(anyFire, false);
});

test('threshold arm: direction table respected — down-bad signal fires on a drop, not a rise', () => {
  const compiledConfig = fakeCompiledConfig({ eval_score: { mu: 0.9, sigmaSq: 0.0025 } }); // sigma = 0.05
  const params: ThresholdParams = {
    kPerSignal: { eval_score: 3 },
    consecutiveTicks: 2,
    directions: { eval_score: 'down' },
  };

  const armRise = makeThresholdArm(params, compiledConfig, cellKey);
  let roseFired = false;
  for (let t = 0; t < 10; t++) {
    const fired = armRise.onTick(t, { eval_score: 0.9 + 4 * 0.05 }); // z = +4, direction is 'down'
    if (fired.length > 0) roseFired = true;
  }
  assert.equal(roseFired, false, 'a rise in a down-bad signal should never fire');

  const armDrop = makeThresholdArm(params, compiledConfig, cellKey);
  let firstFireTick: number | null = null;
  for (let t = 0; t < 10; t++) {
    const fired = armDrop.onTick(t, { eval_score: 0.9 - 4 * 0.05 }); // z = -4, breaches 'down'
    if (fired.length > 0 && firstFireTick === null) firstFireTick = t;
  }
  assert.equal(firstFireTick, params.consecutiveTicks - 1);
});

test('threshold arm: m=1 fires on first breach', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25 } });
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 2 },
    consecutiveTicks: 1,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const fired = arm.onTick(0, { p99_latency: 100 + 3 * 5 }); // z = 3 > k = 2
  assert.deepEqual(fired, ['p99_latency']);
});

test('threshold arm: sigma=0 signal never fires (guard)', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 0 } });
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 1 },
    consecutiveTicks: 1,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const fired = arm.onTick(0, { p99_latency: 1_000_000 });
  assert.deepEqual(fired, []);
});

test('threshold arm: falls back to aggregate_fallback when no per-cell entry (via lookupCell miss)', () => {
  // cellKey has no matching entry in baseline_cells.cells, so lookupCell
  // returns null and the arm must resolve via aggregate_fallback.
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 200, sigmaSq: 100 } }); // sigma = 10
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 2 },
    consecutiveTicks: 1,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, { hour_of_day: 3, day_of_week: 5 });
  const notBreaching = arm.onTick(0, { p99_latency: 200 + 1 * 10 }); // z = 1, below k = 2
  assert.deepEqual(notBreaching, []);
  const breaching = arm.onTick(1, { p99_latency: 200 + 3 * 10 }); // z = 3 > k = 2
  assert.deepEqual(breaching, ['p99_latency']);
});

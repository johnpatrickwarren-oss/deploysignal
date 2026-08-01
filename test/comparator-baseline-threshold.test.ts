// test/comparator-baseline-threshold.test.ts — WS6.2 Task 3 unit tests for
// the threshold-gate comparator arm (makeThresholdArm): step detection at
// the exact expected tick, sub-threshold-noise immunity, direction-table
// respect, m=1 edge case, and the sigma=0 guard.
//
// Also covers the C1 regression (reviewer finding): the arm must apply
// the engine's class-appropriate transform to the live value before
// z-scoring, since `family_A.per_signal.<s>.baseline_mean/sigma_squared`
// are TRANSFORMED-space for non-gaussian_like signals. Without the fix, a
// healthy tick on the real v5 config z-scores at ~+10 (downstream_err)
// to ~+58 (cost_req) — see "C1 fix: real v5 config" below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  makeThresholdArm,
  runThresholdArmOverTrajectory,
  signalsWithFamilyACalibration,
  type ThresholdParams,
} from '../tools/_comparator-baseline-threshold';
import type { Baseline, CompiledConfig, HourDayCellKey, ReportCardCellModule, ReportCardWindowsModule } from '../tools/_comparator-baseline-types';
import type { SignalClass } from '@johnpatrickwarren-oss/deploysignal-engine/signal-classes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('../tools/_build-report-card-io');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cellModule = require('../tools/_build-report-card-cell') as ReportCardCellModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowsModule = require('../tools/_build-report-card-windows') as ReportCardWindowsModule;

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE_DIR = path.join(REPO_ROOT, 'runs', 'baselines', 'synthetic-v1');
const COMPILED_CONFIG_PATH = path.join(REPO_ROOT, 'runs', 'compiled-configs', 'v5-sequential-e-process.json');

function fakeCompiledConfig(entries: Record<string, { mu: number; sigmaSq: number; cls?: SignalClass }>): CompiledConfig {
  const perSignal: Record<string, { baseline_mean: number; baseline_sigma_squared: number; signal_class?: SignalClass }> = {};
  for (const [signal, { mu, sigmaSq, cls }] of Object.entries(entries)) {
    perSignal[signal] = { baseline_mean: mu, baseline_sigma_squared: sigmaSq, signal_class: cls };
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

test('signalsWithFamilyACalibration: restricts to signals present in aggregate_fallback.family_A.per_signal', () => {
  const compiledConfig = fakeCompiledConfig({
    p99_latency: { mu: 100, sigmaSq: 25 },
    eval_score: { mu: 0.9, sigmaSq: 0.0025 },
  });
  const resolvable = signalsWithFamilyACalibration(compiledConfig, ['p99_latency', 'eval_score', 'refusal_rate', 'kv_cache']);
  assert.deepEqual(resolvable.sort(), ['eval_score', 'p99_latency']);
});

test('threshold arm: real cell found but missing this signal\'s family_A entry retries against aggregate_fallback', () => {
  // Regression case surfaced by the Task 5 driver against the real
  // compiled config: lookupCell can return a REAL cell (present in
  // baseline_cells.cells) whose family_A.per_signal doesn't carry every
  // signal (partial per-cell calibration) — a plain `lookupCell(...) ??
  // aggregate_fallback` never retries in that case, since the `??` only
  // fires when lookupCell itself returns null. The arm must retry
  // against aggregate_fallback when meanSigmaFromCompiledCell throws for
  // the found cell, not just when the cell lookup itself misses.
  const cellKey: HourDayCellKey = { hour_of_day: 3, day_of_week: 5 };
  const compiledConfig: CompiledConfig = {
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [
        {
          key: { hour_of_day: 3, day_of_week: 5 },
          n_samples: 42,
          family_A: { per_signal: { downstream_err: { baseline_mean: 0.001, baseline_sigma_squared: 0.0001 } } },
        },
      ],
      aggregate_fallback: {
        family_A: { per_signal: { p99_latency: { baseline_mean: 200, baseline_sigma_squared: 100 } } }, // sigma = 10
      },
    },
  };
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 2 },
    consecutiveTicks: 1,
    directions: { p99_latency: 'up' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const notBreaching = arm.onTick(0, { p99_latency: 200 + 1 * 10 }); // z = 1, below k = 2 (aggregate_fallback stats)
  assert.deepEqual(notBreaching, []);
  const breaching = arm.onTick(1, { p99_latency: 200 + 3 * 10 }); // z = 3 > k = 2
  assert.deepEqual(breaching, ['p99_latency']);
});

// ── C1 fix: transform-space parity (reviewer finding) ──────────────────

test('C1 fix: bounded_probability signal transforms the live value via logit before z-scoring', () => {
  // Numbers lifted directly from the real v5-sequential-e-process.json
  // aggregate_fallback cell's downstream_err entry: baseline_mean/sigma
  // are in TRANSFORMED (logit) space; baseline_mean_raw is the raw-space
  // mean the transformed mean corresponds to (sigmoid(-2.0136) ~= 0.1178
  // ~= baseline_mean_raw). Feeding the RAW mean as the live value must
  // z-score near 0 once transformed — pre-fix, z-scoring the raw value
  // directly against the transformed mu/sigma produced z ~= +10 (the
  // exact symptom the reviewer flagged).
  const mu = -2.013632963773555; // baseline_mean (logit space)
  const sigma = Math.sqrt(0.04523485449299562); // sqrt(baseline_sigma_squared)
  const rawMean = 0.11953532178836776; // baseline_mean_raw; sigmoid(mu) ~= this
  const compiledConfig = fakeCompiledConfig({ downstream_err: { mu, sigmaSq: sigma * sigma, cls: 'bounded_probability' } });
  const params: ThresholdParams = {
    kPerSignal: { downstream_err: 2 },
    consecutiveTicks: 1,
    directions: { downstream_err: 'both' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const fired = arm.onTick(0, { downstream_err: rawMean });
  assert.deepEqual(fired, [], 'the raw-space mean must not breach a k=2 gate once correctly transformed to logit space');

  // A genuinely elevated raw downstream_err (well above the raw mean)
  // must still be detectable post-transform — the fix isn't "never fire".
  const armDetect = makeThresholdArm(params, compiledConfig, cellKey);
  const firedOnRegression = armDetect.onTick(0, { downstream_err: 0.9 }); // logit(0.9) ~= 2.197, far above mu in logit space
  assert.deepEqual(firedOnRegression, ['downstream_err'], 'a genuine bounded_probability regression must still breach post-transform');
});

test('C1 fix: heavy_tail signal transforms the live value via log before z-scoring', () => {
  // Same provenance as above, for cost_req (heavy_tail / log transform).
  // Pre-fix z-scoring the raw value directly against transformed mu/sigma
  // produced z ~= +58 (the reviewer's other cited symptom).
  const mu = -5.481363880733801; // baseline_mean (log space)
  const sigma = Math.sqrt(0.008843028246571431);
  const rawMean = 0.004181968510417738; // baseline_mean_raw; exp(mu) ~= this
  const compiledConfig = fakeCompiledConfig({ cost_req: { mu, sigmaSq: sigma * sigma, cls: 'heavy_tail' } });
  const params: ThresholdParams = {
    kPerSignal: { cost_req: 2 },
    consecutiveTicks: 1,
    directions: { cost_req: 'both' },
  };
  const arm = makeThresholdArm(params, compiledConfig, cellKey);
  const fired = arm.onTick(0, { cost_req: rawMean });
  assert.deepEqual(fired, [], 'the raw-space mean must not breach a k=2 gate once correctly transformed to log space');
});

test('C1 fix: gaussian_like (and unclassified) signals are unaffected — identity transform, byte-identical to pre-Q2.A behavior', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25, cls: 'gaussian_like' } });
  const compiledConfigNoClass = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25 } }); // pre-Q2.A: no signal_class field at all
  const params: ThresholdParams = { kPerSignal: { p99_latency: 3 }, consecutiveTicks: 1, directions: { p99_latency: 'up' } };
  for (const cfg of [compiledConfig, compiledConfigNoClass]) {
    const arm = makeThresholdArm(params, cfg, cellKey);
    assert.deepEqual(arm.onTick(0, { p99_latency: 100 + 4 * 5 }), ['p99_latency']); // z = 4 > k = 3
  }
});

test('C1 fix: real v5 config — healthy bootstrap window produces |z| < smallest grid k (2) for all six calibrated signals, all ticks', () => {
  // The regression test the reviewer said was missing: run the ACTUAL
  // threshold arm (via runThresholdArmOverTrajectory, not a hand-rolled
  // z-score) over a healthy bootstrap window drawn from the real compile
  // substrate, at k=2 (ENDPOINTS.md's smallest threshold grid value) and
  // m=1 (fires on the very first breaching tick) with direction 'both'
  // (strictest — catches a breach on either side) for every signal with
  // family_A calibration. Zero fires here means |z| < 2 held for all six
  // signals across every tick — proving live values are being compared
  // in the same space their baseline stats were derived in.
  const baseline = ioModule.loadBaseline(BASELINE_DIR) as Baseline;
  const compiledConfig: CompiledConfig = JSON.parse(fs.readFileSync(COMPILED_CONFIG_PATH, 'utf8'));
  const cells = cellModule.listPopulatedCells(baseline, 20);
  assert.ok(cells.length > 0, 'expected at least one populated cell in the real baseline');

  const allSignals = Object.keys(compiledConfig.baseline_cells.aggregate_fallback.family_A!.per_signal!);
  const calibratedSignals = signalsWithFamilyACalibration(compiledConfig, allSignals);
  assert.equal(calibratedSignals.length, 6, 'expected exactly 6 Family A-calibrated signals in the real v5 config');

  const kPerSignal: Record<string, number> = {};
  const directions: Record<string, 'both'> = {};
  for (const s of calibratedSignals) {
    kPerSignal[s] = 2; // smallest grids.threshold.k value
    directions[s] = 'both';
  }
  const params: ThresholdParams = { kPerSignal, consecutiveTicks: 1, directions };

  const cellKeyReal = cells[0];
  const rng = ioModule.mulberry32(42);
  const traj = windowsModule.generateHealthyWindow('iid_bootstrap', baseline, cellKeyReal, 20, rng, compiledConfig);

  const { firstFireTick, firingSignals } = runThresholdArmOverTrajectory(params, compiledConfig, traj);
  assert.equal(
    firstFireTick,
    null,
    `expected no false fires on a healthy bootstrap window at k=2 for any of ${JSON.stringify(firingSignals)}`,
  );
});

// ── I1: fireTicks (reviewer finding) ────────────────────────────────────

test('I1 fix: runThresholdArmOverTrajectory returns fireTicks — every firing tick, ascending, not just the first', () => {
  const compiledConfig = fakeCompiledConfig({ p99_latency: { mu: 100, sigmaSq: 25 } }); // sigma = 5
  const params: ThresholdParams = {
    kPerSignal: { p99_latency: 3 },
    consecutiveTicks: 1,
    directions: { p99_latency: 'up' },
  };
  // Breaches at ticks 2, 3 (z=4), recovers, breaches again at tick 6.
  const traj = {
    cell_key: cellKey,
    signal_series: {
      p99_latency: [100, 100, 100 + 4 * 5, 100 + 4 * 5, 100, 100, 100 + 4 * 5],
    },
  };
  const { firstFireTick, fireTicks } = runThresholdArmOverTrajectory(params, compiledConfig, traj);
  assert.equal(firstFireTick, 2);
  assert.deepEqual(fireTicks, [2, 3, 6], 'fireTicks must list every firing tick, ascending, not just the first');
});

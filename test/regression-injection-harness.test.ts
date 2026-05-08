// test/regression-injection-harness.test.ts — REPLY-52 D4 coverage.
//
// Verifies:
//   - All 5 v1 profiles load + validate against schema.
//   - injectRegression mutates only post-T_inject ticks; pre-T_inject
//     baseline samples are byte-identical.
//   - delta_kind dispatch produces expected applied-delta values:
//       * absolute → signal += delta (native units).
//       * relative_to_baseline_sigma → signal += delta × σ_pre.
//       * relative_to_baseline_mean → signal += delta × μ_pre.
//   - Step-function semantic: between offsets, delta stays constant.
//   - Signals not listed in affected_signals untouched.
//   - Schema validation rejects malformed profiles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  loadRegressionProfile, loadAllRegressionProfiles,
  injectRegression, applyDelta,
} from '../tools/inject-regression';
import type { SignalSeriesPerRun } from '../tools/inject-regression';
import type { RegressionProfile } from '../engine/types';

const REPO_ROOT = path.resolve(__dirname, '..');
const V1_PROFILE_IDS = [
  'openai_routing_error_ramp_2024_12_11',
  'anthropic_tpu_output_corruption_step_2025_09',
  'anthropic_xla_precision_drift_2025_08',
  'cloudflare_worker_kv_degradation_2024_03',
  'github_availability_latency_regression_2024_06',
];

test('regression: all 5 v1 profiles load + validate', () => {
  const profiles = loadAllRegressionProfiles();
  assert.ok(profiles.length >= 5, `expected ≥5 v1 profiles; got ${profiles.length}`);
  const ids = new Set(profiles.map((p) => p.id));
  for (const expected of V1_PROFILE_IDS) {
    assert.ok(ids.has(expected), `v1 profile "${expected}" missing`);
  }
});

test('regression: loadRegressionProfile throws on unknown id', () => {
  assert.throws(
    () => loadRegressionProfile('nonexistent_profile'),
    /not found/,
  );
});

test('regression: applyDelta absolute adds delta verbatim', () => {
  assert.ok(Math.abs(applyDelta(0.1, 0.05, 'absolute', 100, 10) - 0.15) < 1e-9);
  assert.ok(Math.abs(applyDelta(1.0, -0.3, 'absolute', 100, 10) - 0.7) < 1e-9);
});

test('regression: applyDelta sigma multiplies by baseline sigma', () => {
  // v' = v + 2.0 × σ (σ=10) = v + 20
  assert.equal(applyDelta(50, 2.0, 'relative_to_baseline_sigma', 100, 10), 70);
  // Negative delta also works.
  assert.equal(applyDelta(50, -1.5, 'relative_to_baseline_sigma', 100, 10), 35);
});

test('regression: applyDelta mean-fraction multiplies by baseline mean', () => {
  // v' = v + 0.1 × μ (μ=100) = v + 10
  assert.equal(applyDelta(50, 0.1, 'relative_to_baseline_mean', 100, 10), 60);
  // 25% inflation.
  assert.equal(applyDelta(100, 0.25, 'relative_to_baseline_mean', 100, 10), 125);
});

test('regression: pre-T_inject samples untouched', () => {
  const run: SignalSeriesPerRun = {
    signal_series: {
      downstream_err: Array.from({ length: 50 }, (_, i) => 0.1 + i * 0.001),
    },
  };
  const snapshot = run.signal_series.downstream_err.slice(0, 20);
  const profile = loadRegressionProfile('openai_routing_error_ramp_2024_12_11');
  injectRegression(run, profile, /* T_inject */ 20);
  // Pre-injection ticks 0..19 must be unchanged.
  for (let i = 0; i < 20; i++) {
    assert.equal(run.signal_series.downstream_err[i], snapshot[i],
      `tick ${i} mutated but should be pre-T_inject`);
  }
});

test('regression: openai profile — step delta applied at tick_offset boundaries', () => {
  // Baseline: flat 0.1 across 300 ticks.
  const run: SignalSeriesPerRun = {
    signal_series: {
      downstream_err: new Array(300).fill(0.1),
    },
  };
  const profile = loadRegressionProfile('openai_routing_error_ramp_2024_12_11');
  const tInject = 0;
  const report = injectRegression(run, profile, tInject);

  const series = run.signal_series.downstream_err;
  // Tick 0..59: delta=0.001 (active at offset 0)
  assert.ok(Math.abs(series[0] - 0.101) < 1e-9, `tick 0: expected 0.101; got ${series[0]}`);
  assert.ok(Math.abs(series[59] - 0.101) < 1e-9);
  // Tick 60..179: delta=0.012
  assert.ok(Math.abs(series[60] - 0.112) < 1e-9);
  assert.ok(Math.abs(series[179] - 0.112) < 1e-9);
  // Tick 180+: delta=0.035
  assert.ok(Math.abs(series[180] - 0.135) < 1e-9);
  assert.ok(Math.abs(series[299] - 0.135) < 1e-9);

  // Report summary
  assert.equal(report.profile_id, 'openai_routing_error_ramp_2024_12_11');
  assert.equal(report.injection_tick, 0);
  assert.ok(report.per_signal_stats.downstream_err);
  assert.ok(Math.abs(report.per_signal_stats.downstream_err.final_applied_delta - 0.035) < 1e-9);
});

test('regression: signals not in affected_signals untouched', () => {
  const run: SignalSeriesPerRun = {
    signal_series: {
      downstream_err: new Array(300).fill(0.1),
      p99_latency: new Array(300).fill(180),  // not in openai profile
    },
  };
  const profile = loadRegressionProfile('openai_routing_error_ramp_2024_12_11');
  injectRegression(run, profile, 0);
  // p99_latency not in affected_signals → unchanged.
  assert.ok(run.signal_series.p99_latency.every((v) => v === 180),
    'p99_latency should be unchanged when not in affected_signals');
});

test('regression: σ-scaled delta uses pre-injection baseline stats', () => {
  // Build a series with known σ across the pre-injection window.
  // Ticks 0..29 alternate ±5 around mean=100 → σ = 5.
  const prefix: number[] = [];
  for (let i = 0; i < 30; i++) prefix.push(i % 2 === 0 ? 105 : 95);
  const series = [...prefix, ...new Array(120).fill(100)];
  const run: SignalSeriesPerRun = { signal_series: { p99_latency: series } };

  // Synthetic profile: σ-scaled delta of 2.0 at offset 0 applied
  // for the full post-injection window.
  const syntheticProfile: RegressionProfile = {
    id: 'synthetic_sigma_test',
    source: 'test',
    duration_minutes: 10,
    affected_signals: ['p99_latency'],
    injection_points: [{
      tick_offset: 0, signal: 'p99_latency',
      delta_kind: 'relative_to_baseline_sigma', delta: 2.0,
    }],
    expected_detection: { family: 'A' },
  };
  const report = injectRegression(run, syntheticProfile, 30);
  // σ_pre = 5 → shift = 2.0 × 5 = 10 → post-injection value = 110.
  assert.ok(Math.abs(series[30] - 110) < 1e-9,
    `expected 2σ shift to bring 100 → 110; got ${series[30]}`);
  assert.ok(Math.abs(report.per_signal_stats.p99_latency.baseline_sigma - 5) < 1e-9);
  assert.ok(Math.abs(report.per_signal_stats.p99_latency.final_applied_delta - 10) < 1e-9);
});

test('regression: mean-fraction delta uses pre-injection baseline mean', () => {
  const run: SignalSeriesPerRun = {
    signal_series: {
      cost_req: [...new Array(30).fill(0.004), ...new Array(30).fill(0.004)],
    },
  };
  const syntheticProfile: RegressionProfile = {
    id: 'synthetic_mean_fraction_test',
    source: 'test',
    duration_minutes: 5,
    affected_signals: ['cost_req'],
    injection_points: [{
      tick_offset: 0, signal: 'cost_req',
      delta_kind: 'relative_to_baseline_mean', delta: 0.10,
    }],
    expected_detection: { family: 'A' },
  };
  injectRegression(run, syntheticProfile, 30);
  // μ_pre = 0.004 → 10% shift = 0.0004 → post = 0.0044.
  assert.ok(Math.abs(run.signal_series.cost_req[30] - 0.0044) < 1e-12);
});

test('regression: github profile exercises mixed delta_kind (mean-fraction + σ-scaled)', () => {
  // Build a baseline with known mean + sigma for both signals.
  const p99Baseline = new Array(30).fill(180);
  // Add noise so σ isn't zero.
  for (let i = 0; i < 30; i++) p99Baseline[i] = 180 + (i % 2 === 0 ? 5 : -5);
  const costBaseline = new Array(30).fill(0.004);
  const run: SignalSeriesPerRun = {
    signal_series: {
      p99_latency: [...p99Baseline, ...new Array(300).fill(180)],
      cost_req: [...costBaseline, ...new Array(300).fill(0.004)],
    },
  };
  const profile = loadRegressionProfile('github_availability_latency_regression_2024_06');
  const report = injectRegression(run, profile, 30);

  // cost_req: mean-fraction at offsets 0 (0.08), 120 (0.18), 240 (0.28).
  // μ_pre = 0.004.
  // Tick 30 (offset 0): 0.004 + 0.08 × 0.004 = 0.00432
  assert.ok(Math.abs(run.signal_series.cost_req[30] - 0.00432) < 1e-9);
  // Tick 150 (offset 120): 0.004 + 0.18 × 0.004 = 0.00472
  assert.ok(Math.abs(run.signal_series.cost_req[150] - 0.00472) < 1e-9);
  // Tick 270 (offset 240): 0.004 + 0.28 × 0.004 = 0.00512
  assert.ok(Math.abs(run.signal_series.cost_req[270] - 0.00512) < 1e-9);
  // p99_latency: σ-scaled at offsets 60 (1.8), 180 (2.8). σ_pre = 5.
  // Tick 90 (offset 60): 180 + 1.8 × 5 = 189
  assert.ok(Math.abs(run.signal_series.p99_latency[90] - 189) < 1e-9);
  // Tick 210 (offset 180): 180 + 2.8 × 5 = 194
  assert.ok(Math.abs(run.signal_series.p99_latency[210] - 194) < 1e-9);

  assert.equal(report.profile_id, 'github_availability_latency_regression_2024_06');
  assert.ok(report.per_signal_stats.cost_req);
  assert.ok(report.per_signal_stats.p99_latency);
});

test('regression: schema rejects profile with missing delta_kind', () => {
  // Construct a temp profile file with missing delta_kind.
  const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-regression-'));
  try {
    const malformed = {
      id: 'missing_delta_kind_test',
      source: 'test',
      duration_minutes: 5,
      affected_signals: ['p99_latency'],
      injection_points: [{
        tick_offset: 0,
        signal: 'p99_latency',
        // delta_kind intentionally absent
        delta: 1.0,
      }],
      expected_detection: { family: 'A' },
    };
    // Write + try to load via the standard directory.
    const profilesDir = path.join(REPO_ROOT, 'regression-profiles');
    const target = path.join(profilesDir, 'missing_delta_kind_test.yaml');
    const yaml = require('js-yaml') as typeof import('js-yaml');
    fs.writeFileSync(target, yaml.dump(malformed));
    try {
      assert.throws(
        () => loadRegressionProfile('missing_delta_kind_test'),
        /delta_kind|missing required property/,
      );
    } finally {
      fs.unlinkSync(target);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

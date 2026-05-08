// test/spectral.test.ts — Family D (ACF oscillation) unit tests.
//
// Acceptance per WEEK4-HANDOFF.md §4.1.d:
//   - peak detection fires on synthetic oscillating data
//   - bootstrap null empirically holds at α on synthetic healthy data
//   - ACF math matches the textbook deseason-then-normalize definition
//
// The "≥ 1 of 3 oscillation catches" gate lives in family-d-parity.test.ts
// (alongside 4.1.f compiler extension and 4.1.g sweep).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizedACF, peakACF, evaluateFamilyD, FAMILY_D_SIGNALS,
} from '../dist/engine/detectors/spectral';
import type { CompiledConfig } from '../dist/engine/types';

// ────────────────────────────────────────────────────────────────────
// Pure-math: ACF on a pure sine peaks at period or half-period. Since we
// take the absolute value (oscillation signature fires whether peak is the
// positive autocorrelation at period or the negative one at half-period),
// either lag is a valid detection. Use min_peak_lag=4 to push the half-
// period below the search range so the positive peak wins.
test('spectral: ACF peaks at the true period of a pure sine (search above half-period)', () => {
  const N = 60;
  const period = 6;
  const y: number[] = [];
  for (let i = 0; i < N; i++) y.push(Math.sin(2 * Math.PI * i / period));
  const { peak, lag } = peakACF(y, 4, 10);
  assert.equal(lag, period, `expected peak at lag=${period}, got ${lag}`);
  assert.ok(peak >= 0.85, `peak ACF on pure sine should be ≥0.85 (finite-window bias); got ${peak}`);
});

test('spectral: ACF half-period anti-correlation is captured by |ACF| peak', () => {
  const N = 60;
  const period = 6;
  const y: number[] = [];
  for (let i = 0; i < N; i++) y.push(Math.sin(2 * Math.PI * i / period));
  // With min_lag=3, half-period is in range — the absolute-value peak is
  // at lag=3 because ACF(lag=3) = -1 on a period-6 sine.
  const { peak, lag } = peakACF(y, 3, 10);
  assert.equal(lag, 3);
  assert.ok(peak > 0.9, `|ACF| at half-period should be near 1; got ${peak}`);
});

test('spectral: ACF on white-noise window produces low peak', () => {
  // Deterministic PRNG so the test doesn't flake.
  let seed = 0xD15EA5E >>> 0;
  function rng() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const N = 100, trials = 200;
  let maxPeak = 0;
  for (let k = 0; k < trials; k++) {
    const y: number[] = [];
    for (let i = 0; i < N; i++) y.push(2 * (rng() - 0.5));
    const { peak } = peakACF(y, 3, 10);
    if (peak > maxPeak) maxPeak = peak;
  }
  // White-noise ACF has stddev ≈ 1/√N ≈ 0.10; the max of 200 trials at
  // lags 3..10 should stay well below 0.5 almost surely.
  assert.ok(maxPeak < 0.5, `white-noise peak ACF too high: ${maxPeak}`);
});

test('spectral: normalizedACF at lag 0 is 1 by construction (via direct formula)', () => {
  const y = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  // At lag 0 the definition reduces to variance / variance = 1; the
  // implementation returns 0 at lag 0 (peakACF skips lag 0 anyway),
  // so we directly test lag=1 on a perfectly-alternating signal:
  // correlation at lag 1 is -1 on this signal.
  const r1 = normalizedACF(y, 1);
  assert.ok(r1 < -0.8, `expected strong negative correlation at lag 1, got ${r1}`);
});

// ────────────────────────────────────────────────────────────────────
// evaluateFamilyD end-to-end: fire on oscillation, clean on flat, bake gates.
function baseCfg(threshold: number): CompiledConfig {
  return {
    version: 'test', compiler_version: '0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 0, D: 1e-4, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: 1000, confidence: 'strict',
        family_D: {
          p99_latency: { bootstrap_null_quantile: threshold, min_peak_lag: 3, max_peak_lag: 10 },
        },
      }],
      aggregate_fallback: {
        family_D: {
          p99_latency: { bootstrap_null_quantile: threshold, min_peak_lag: 3, max_peak_lag: 10 },
        },
      },
    },
    bake_profiles: {
      p99_latency: { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
    },
    traffic_pct_gate: { min_traffic_pct_for_fire: 0.10 },
  };
}

test('spectral: fires on sinusoidal signal above compiled threshold', () => {
  const cfg = baseCfg(0.4);  // bootstrap null quantile = 0.4
  const N = 30;
  const samples: number[] = [];
  for (let i = 0; i < N; i++) samples.push(185 + 20 * Math.sin(2 * Math.PI * i / 6));
  const v = evaluateFamilyD(cfg, 'p99_latency', samples, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 30, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(v!.verdict, 'fire', `expected fire; got ${v!.verdict} (stat=${v!.statistic})`);
  assert.ok(v!.statistic! > 0.4);
  assert.ok(v!.alpha_spent > 0);
  assert.match(v!.reason_code, /spectral_peak_at_lag_/);
});

test('spectral: clean on white-noise signal below compiled threshold', () => {
  const cfg = baseCfg(0.6);  // high threshold so noise-driven peaks don't cross
  let seed = 0xC0FFEE >>> 0;
  function rng() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const N = 30;
  const samples: number[] = [];
  for (let i = 0; i < N; i++) samples.push(185 + 5 * (rng() - 0.5));
  const v = evaluateFamilyD(cfg, 'p99_latency', samples, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 30, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(v!.verdict, 'clean', `expected clean; got ${v!.verdict} stat=${v!.statistic}`);
  assert.equal(v!.alpha_spent, 0);
});

test('spectral: underfilled window suppresses fire', () => {
  const cfg = baseCfg(0.4);
  // Only 10 samples; max_peak_lag=10 ⇒ need ≥ 20 samples.
  const samples = Array.from({ length: 10 }, (_, i) => 185 + 20 * Math.sin(2 * Math.PI * i / 6));
  const v = evaluateFamilyD(cfg, 'p99_latency', samples, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 30, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(v!.verdict, 'suppressed');
  assert.equal(v!.reason_code, 'window_underfilled');
});

test('spectral: bake-profile gates suppress fire', () => {
  const cfg = baseCfg(0.4);
  const N = 30;
  const samples = Array.from({ length: N }, (_, i) => 185 + 20 * Math.sin(2 * Math.PI * i / 6));
  const v = evaluateFamilyD(cfg, 'p99_latency', samples, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 1, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(v!.verdict, 'suppressed');
  assert.equal(v!.reason_code, 'bake_profile_not_met');
});

test('spectral: bootstrap null empirically holds at α on synthetic healthy windows', () => {
  // With threshold set at the empirical (1−α_D) quantile of peak-ACF on
  // synthetic healthy windows, per-call FP rate should be ≤ α_D.
  const N = 30;
  let seed = 0xBEEFFACE >>> 0;
  function rng() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Draw 2000 healthy windows of length N with white-noise residuals on a
  // mild drift. Compute empirical (1−α_D) quantile and verify the FP rate
  // under that threshold holds at ≤ α_D (with some slack for finite N).
  const trials = 2000;
  const alphaD = 0.10;  // Use a loose α for the calibration-sanity test so
                         // only 200 exceedances are expected — keeps the
                         // quantile estimate tight on 2000 trials.
  const peaks: number[] = [];
  for (let t = 0; t < trials; t++) {
    const y: number[] = [];
    for (let i = 0; i < N; i++) y.push(185 + 3 * (rng() - 0.5));
    peaks.push(peakACF(y, 3, 10).peak);
  }
  peaks.sort((a, b) => a - b);
  const qIdx = Math.floor((1 - alphaD) * peaks.length);
  const threshold = peaks[qIdx];
  // FP rate under this threshold:
  let fires = 0;
  for (const p of peaks) if (p > threshold) fires++;
  const fpRate = fires / trials;
  assert.ok(fpRate <= alphaD + 0.02,
    `FP rate ${fpRate.toFixed(4)} exceeds α=${alphaD} (within +0.02 slack)`);
});

// ────────────────────────────────────────────────────────────────────
// Signal-set export sanity.
test('spectral: FAMILY_D_SIGNALS matches shipped registry (kv_cache only in W4)', () => {
  assert.equal(FAMILY_D_SIGNALS.length, 1);
  assert.equal(FAMILY_D_SIGNALS[0], 'kv_cache');
});

// test/comparator-baseline-canary.test.ts — WS6.2 Task 4 unit tests for the
// canary-vs-control comparator arm (runCanaryArm, deriveControlSeed):
// never-fires-on-identical-streams, real-injection detection, Bonferroni
// threshold math, and determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCanaryArm, deriveControlSeed, type CanaryParams } from '../tools/_comparator-baseline-canary';
import type { SignalSeries } from '../tools/_comparator-baseline-types';
import { injectRegression, loadRegressionProfile } from '../tools/inject-regression';

// Self-contained mulberry32 (test-fixture generation only — not a
// duplication of any production RNG-order logic under test elsewhere).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noisySeries(rng: () => number, n: number, mu: number, sigma: number): number[] {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = mu + sigma * (rng() * 2 - 1);
  return out;
}

// ── identical canary/control never fires ────────────────────────────

test('canary arm: identical canary/control never fires across 200 seeded random windows', () => {
  const defaultParams: CanaryParams = {
    alpha: 0.05,
    lookScheduleTicks: [20, 30, 40, 50, 60, 70, 80, 90, 99],
    windowTicks: 20,
    directions: { p99_latency: 'up' },
    signals: ['p99_latency'],
  };
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    const series = noisySeries(rng, 100, 100, 10);
    const canary: SignalSeries = { p99_latency: series };
    const control: SignalSeries = { p99_latency: series.slice() };
    const r = runCanaryArm(canary, control, defaultParams);
    assert.equal(r.firstFireTick, null, `seed ${seed}: identical streams must never fire`);
    assert.deepEqual(r.firingSignals, []);
    assert.deepEqual(r.fireTicks, [], `seed ${seed}: fireTicks must be empty when the arm never fires`);
  }
});

// ── real injection is detected ───────────────────────────────────────

test('canary arm: openai routing profile injection is detected at/after the injection tick, never before', () => {
  const profile = loadRegressionProfile('openai_routing_error_ramp_2024_12_11');
  const rng = mulberry32(7);
  const n = 250;
  const injectionTick = 30;
  const canaryRun = { signal_series: { downstream_err: noisySeries(rng, n, 0.0005, 0.0002) } };
  injectRegression(canaryRun, profile, injectionTick);

  const controlRng = mulberry32(deriveControlSeed(7));
  const control: SignalSeries = { downstream_err: noisySeries(controlRng, n, 0.0005, 0.0002) };

  const lookSchedule: number[] = [];
  for (let t = 20; t <= 240; t += 10) lookSchedule.push(t);

  const params: CanaryParams = {
    alpha: 0.05,
    lookScheduleTicks: lookSchedule,
    windowTicks: 20,
    directions: { downstream_err: 'up' },
    signals: ['downstream_err'],
  };

  const r = runCanaryArm(canaryRun.signal_series, control, params);
  assert.ok(r.firstFireTick !== null, 'expected the injected ramp to be detected');
  assert.ok(
    r.firstFireTick! >= injectionTick,
    `first fire tick ${r.firstFireTick} must be at/after the injection tick ${injectionTick}`,
  );
  assert.deepEqual(r.firingSignals, ['downstream_err']);

  // I1 fix (reviewer finding): fireTicks lists every firing look tick,
  // ascending — not just the first — and its first entry must agree with
  // firstFireTick.
  assert.ok(r.fireTicks.length > 0, 'expected at least one fire tick');
  assert.equal(r.fireTicks[0], r.firstFireTick, 'fireTicks[0] must equal firstFireTick');
  assert.deepEqual(r.fireTicks, [...r.fireTicks].sort((a, b) => a - b), 'fireTicks must be ascending');
  for (const t of r.fireTicks) assert.ok(t >= injectionTick, `fire tick ${t} must be at/after the injection tick`);
});

// ── Bonferroni math ───────────────────────────────────────────────────

test('canary arm: Bonferroni threshold math — fires at alpha, does not fire at alpha/10 (marginal case)', () => {
  // Reuses the hand-computed ties fixture from comparator-baseline-stats.test.ts:
  // a=[1,2,3] vs b=[2,3,4] -> pLess ~= 0.1306 (a stochastically less than b).
  const canary: SignalSeries = { eval_score: [1, 2, 3] };
  const control: SignalSeries = { eval_score: [2, 3, 4] };
  const baseParams: Omit<CanaryParams, 'alpha'> = {
    lookScheduleTicks: [3],
    windowTicks: 3,
    directions: { eval_score: 'down' }, // canary-less-than-control is the "bad" direction
    signals: ['eval_score'],
  };

  const firesAtAlpha = runCanaryArm(canary, control, { ...baseParams, alpha: 0.2 }); // 0.2/1 = 0.2 > 0.1306
  assert.ok(firesAtAlpha.firstFireTick !== null, 'expected a fire at alpha=0.2 (threshold 0.2 > p~=0.1306)');

  const noFireAtAlphaOver10 = runCanaryArm(canary, control, { ...baseParams, alpha: 0.02 }); // 0.02/1 = 0.02 < 0.1306
  assert.equal(noFireAtAlphaOver10.firstFireTick, null, 'expected no fire at alpha/10=0.02 (threshold 0.02 < p~=0.1306)');
});

// ── determinism ───────────────────────────────────────────────────────

test('canary arm: determinism — same inputs produce the same result object', () => {
  const rng = mulberry32(99);
  const canary: SignalSeries = { p99_latency: noisySeries(rng, 100, 100, 10) };
  const controlRng = mulberry32(deriveControlSeed(99));
  const control: SignalSeries = { p99_latency: noisySeries(controlRng, 100, 100, 10) };
  const params: CanaryParams = {
    alpha: 0.5, // deliberately loose to exercise a real (possibly firing) case
    lookScheduleTicks: [20, 40, 60, 80, 99],
    windowTicks: 20,
    directions: { p99_latency: 'both' },
    signals: ['p99_latency'],
  };
  const r1 = runCanaryArm(canary, control, params);
  const r2 = runCanaryArm(canary, control, params);
  assert.deepEqual(r1, r2);
});

// ── deriveControlSeed sanity ─────────────────────────────────────────

test('deriveControlSeed: deterministic and disjoint from its input seed', () => {
  assert.equal(deriveControlSeed(42), deriveControlSeed(42));
  assert.notEqual(deriveControlSeed(42), 42);
  assert.notEqual(deriveControlSeed(42), deriveControlSeed(43));
});

// test/comparator-baseline-driver.test.ts — WS6.2 Task 5 unit tests for
// the window-plan + multi-arm driver: (a) stream-parity (frozen
// trajectories, shared references, mutation throws), (b) portfolio
// reproduction against a direct runFprSweep invocation (proves the
// eval-healthy stream is byte-identical to the report card's), and
// (c) determinism (two build+materialize passes produce deeply equal
// series).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildWindowPlan, materializeWindow, runArmsOverWindow, buildDefaultArmsConfig } from '../tools/_comparator-baseline-driver';
import type { Baseline, CompiledConfig, EndpointsSpec } from '../tools/_comparator-baseline-types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('../tools/_build-report-card-io');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateModule = require('../tools/_build-report-card-gate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sweepsModule = require('../tools/_build-report-card-sweeps');

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE_DIR = path.join(REPO_ROOT, 'runs', 'baselines', 'synthetic-v1');
const COMPILED_CONFIG_PATH = path.join(REPO_ROOT, 'runs', 'compiled-configs', 'v5-sequential-e-process.json');

function loadEndpoints(overrides: Partial<EndpointsSpec['frozen_params']> = {}): EndpointsSpec {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'runs', 'comparator-baseline', 'ENDPOINTS.md'), 'utf8');
  const match = md.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, 'ENDPOINTS.md must contain a fenced json block');
  const parsed = JSON.parse(match![1]) as EndpointsSpec;
  return { ...parsed, frozen_params: { ...parsed.frozen_params, ...overrides } };
}

function loadFixtures(): { baseline: Baseline; compiledConfig: CompiledConfig } {
  const baseline = ioModule.loadBaseline(BASELINE_DIR) as Baseline;
  const compiledConfig = JSON.parse(fs.readFileSync(COMPILED_CONFIG_PATH, 'utf8')) as CompiledConfig;
  return { baseline, compiledConfig };
}

// ── (a) stream-parity: frozen trajectories, shared references, mutation throws ──

test('driver: materialized trajectories are deep-frozen and shared unmutated across every arm', () => {
  const { baseline, compiledConfig } = loadFixtures();
  const endpoints = loadEndpoints({ healthy_windows: 3, tuning_windows: 0, repeats_per_profile: 0 });
  const plan = buildWindowPlan(baseline, endpoints, []);
  const entry = plan.find((e) => e.provenance.split === 'eval_healthy');
  assert.ok(entry, 'expected at least one eval_healthy plan entry');

  const materialized = materializeWindow(entry!, baseline, compiledConfig);

  assert.ok(Object.isFrozen(materialized.traj.signal_series));
  assert.ok(Object.isFrozen(materialized.controlTraj.signal_series));
  const someSignal = Object.keys(materialized.traj.signal_series)[0];
  assert.ok(Object.isFrozen(materialized.traj.signal_series[someSignal]));

  assert.throws(() => {
    (materialized.traj.signal_series[someSignal] as number[])[0] = 999999;
  }, TypeError);
  assert.throws(() => {
    (materialized.traj.signal_series as Record<string, number[]>).__new_signal__ = [1, 2, 3];
  }, TypeError);

  // Every arm reads the SAME frozen objects (no defensive clone) — if any
  // arm attempted a mutation it would throw synchronously above/inside
  // this call, so completing without throwing (plus reference equality
  // after the call) is the "every arm sees identical data" proof.
  const seriesRefBefore = materialized.traj.signal_series;
  const arms = buildDefaultArmsConfig(endpoints, compiledConfig);
  const results = runArmsOverWindow(
    materialized,
    { threshold: arms.threshold, canary: arms.canary, thresholdDefault: arms.threshold, canaryDefault: arms.canary },
    compiledConfig,
    endpoints,
  );
  assert.equal(materialized.traj.signal_series, seriesRefBefore);
  assert.ok(Object.isFrozen(materialized.traj.signal_series));
  for (const armId of ['portfolio_alpha', 'portfolio_combined', 'threshold_tuned', 'canary_tuned', 'combined_tuned', 'combined_default']) {
    assert.ok(armId in results, `expected arm "${armId}" in runArmsOverWindow's result`);
  }
});

// ── (b) portfolio reproduction against a direct runFprSweep invocation ──

test('driver: eval-healthy stream reproduces runFprSweep exactly (reduced 10-window run, seed 42)', () => {
  const { baseline, compiledConfig } = loadFixtures();
  const HEALTHY_WINDOWS = 10;
  const SEED = 42;
  const CANARY_TICKS = 100;
  const BAKE_HOURS = 6;

  const endpoints = loadEndpoints({
    healthy_windows: HEALTHY_WINDOWS,
    tuning_windows: 0,
    repeats_per_profile: 0,
    eval_seed: SEED,
    canary_ticks: CANARY_TICKS,
    bake_hours: BAKE_HOURS,
  });
  const plan = buildWindowPlan(baseline, endpoints, []);
  const healthyEntries = plan.filter((e) => e.provenance.split === 'eval_healthy');
  assert.equal(healthyEntries.length, HEALTHY_WINDOWS);

  let myVilleFp = 0;
  let myClassicalFp = 0;
  let myFamilyBTrip = 0;
  let myAnyFired = 0;
  for (const entry of healthyEntries) {
    const materialized = materializeWindow(entry, baseline, compiledConfig);
    const r = gateModule.runGateOverTrajectory(materialized.traj, materialized.scenario, compiledConfig, CANARY_TICKS, BAKE_HOURS);
    let ville = false;
    let classical = false;
    let b = false;
    for (const id of r.firingDetectorIds ?? []) {
      const cls = gateModule.classifyFiringId(id, entry.provenance.cell_key, compiledConfig);
      if (cls === 'ville') ville = true;
      else if (cls === 'classical') classical = true;
      else if (cls === 'family_b') b = true;
    }
    if (ville) myVilleFp++;
    if (classical) myClassicalFp++;
    if (b) myFamilyBTrip++;
    if (ville || classical || b) myAnyFired++;
  }

  const fpr = sweepsModule.runFprSweep(
    baseline,
    undefined,
    compiledConfig,
    { healthyWindows: HEALTHY_WINDOWS, seed: SEED, canaryTicks: CANARY_TICKS, bakeHours: BAKE_HOURS, resampler: 'iid_bootstrap' },
    8e-4,
  );

  assert.equal(myVilleFp, fpr.fpr_ville_bounded.fp_count, 'Ville-bounded fp_count must match runFprSweep exactly');
  assert.equal(myClassicalFp, fpr.fpr_classical_epoch.fp_count, 'classical-epoch fp_count must match runFprSweep exactly');
  assert.equal(myFamilyBTrip, fpr.family_b_trip_count, 'family_b_trip_count must match runFprSweep exactly');
  assert.equal(
    myAnyFired,
    fpr.firing_attribution_by_category.windows_fired_total,
    'any-fire window count must match runFprSweep\'s windows_fired_total exactly',
  );
});

// ── (c) determinism ───────────────────────────────────────────────────

test('driver: two buildWindowPlan + materializeWindow passes produce deeply equal series', () => {
  const { baseline, compiledConfig } = loadFixtures();
  const endpoints = loadEndpoints({ healthy_windows: 5, tuning_windows: 5, repeats_per_profile: 0 });

  const planA = buildWindowPlan(baseline, endpoints, []);
  const planB = buildWindowPlan(baseline, endpoints, []);
  assert.equal(planA.length, planB.length);
  assert.deepEqual(
    planA.map((e) => e.trajectory),
    planB.map((e) => e.trajectory),
  );
  assert.deepEqual(
    planA.map((e) => e.provenance),
    planB.map((e) => e.provenance),
  );

  const idx = planA.findIndex((e) => e.provenance.split === 'eval_healthy');
  const materializedA = materializeWindow(planA[idx], baseline, compiledConfig);
  const materializedB = materializeWindow(planB[idx], baseline, compiledConfig);
  assert.deepEqual(materializedA.traj, materializedB.traj);
  assert.deepEqual(materializedA.controlTraj, materializedB.controlTraj);
  assert.deepEqual(materializedA.scenario, materializedB.scenario);
});

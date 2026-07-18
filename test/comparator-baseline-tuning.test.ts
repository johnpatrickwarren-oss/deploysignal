// test/comparator-baseline-tuning.test.ts — WS6.2 Task 6 unit tests for
// the tuning module: no-leakage (tuning-seed stream disjoint from eval
// seeds, frozen_params round-trip), selection-rule (tuneThreshold picks
// the known-minimal zero-fire k), and monotonic sanity (tuned params
// never fire on the tuning windows they were tuned against).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { tuneThreshold, tuneCanary, tuneCombined } from '../tools/_comparator-baseline-tune';
import { runThresholdArmOverTrajectory } from '../tools/_comparator-baseline-threshold';
import { buildWindowPlan } from '../tools/_comparator-baseline-driver';
import type {
  Baseline,
  CompiledConfig,
  EndpointsSpec,
  FrozenParams,
  Trajectory,
  WindowPlanEntry,
} from '../tools/_comparator-baseline-types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('../tools/_build-report-card-io');

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE_DIR = path.join(REPO_ROOT, 'runs', 'baselines', 'synthetic-v1');
const COMPILED_CONFIG_PATH = path.join(REPO_ROOT, 'runs', 'compiled-configs', 'v5-sequential-e-process.json');

function parsedEndpointsMd(): EndpointsSpec {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'runs', 'comparator-baseline', 'ENDPOINTS.md'), 'utf8');
  const match = md.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, 'ENDPOINTS.md must contain a fenced json block');
  return JSON.parse(match![1]) as EndpointsSpec;
}

function makeEndpoints(overrides: Partial<FrozenParams> = {}): EndpointsSpec {
  const base: FrozenParams = {
    eval_seed: 42,
    tuning_seed: 20260716,
    healthy_windows: 131,
    tuning_windows: 262,
    canary_ticks: 100,
    injection_tick: 30,
    repeats_per_profile: 20,
    bake_hours: 6,
    resampler: 'iid_bootstrap',
    look_schedule: [20, 30, 40, 50, 60, 70, 80, 90, 99],
    grids: {
      threshold: { k: [2, 2.5, 3, 3.5, 4, 5, 6, 8], m: [1, 2, 3, 5, 8], selection_rule: '' },
      canary: { alpha_c: [0.05, 0.01, 0.005, 0.001], W: [10, 20], selection_rule: '' },
      combined: { escalation_rule: '' },
      tuning_fp_budget: 0,
    },
    direction_table: { up_bad: [], down_bad: [], two_sided: [] },
  };
  return {
    endpoints_version: 'v1',
    primary_metrics: [],
    secondary_metrics: [],
    arms: [],
    frozen_params: { ...base, ...overrides },
  };
}

function fakeCompiledConfig(mu: number, sigma: number, signal: string): CompiledConfig {
  return {
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: { family_A: { per_signal: { [signal]: { baseline_mean: mu, baseline_sigma_squared: sigma * sigma } } } },
    },
  };
}

const CELL_KEY = { hour_of_day: 0, day_of_week: 0 };

/** Wrap a hand-built `Trajectory` as a `split: 'tuning'`-provenanced
 *  `WindowPlanEntry` (m2, reviewer finding: the tuners now assert this at
 *  runtime). Only `split` is load-bearing for the assertion; the rest of
 *  `provenance` is filled with innocuous fixture values. */
function tuningEntry(trajectory: Trajectory, index = 0): WindowPlanEntry {
  return {
    provenance: {
      split: 'tuning',
      seed: 0,
      window_index: index,
      cell_key: trajectory.cell_key,
      injection_tick: 30,
      bake_hours: 6,
    },
    trajectory,
  };
}

// ── no-leakage ────────────────────────────────────────────────────────

test('no-leakage: tuning-seed stream is disjoint from eval seeds; frozen_params round-trip ENDPOINTS.md exactly', () => {
  const endpointsFromDoc = parsedEndpointsMd();
  const fp = endpointsFromDoc.frozen_params;
  assert.equal(fp.eval_seed, 42);
  assert.equal(fp.healthy_windows, 131);
  assert.equal(fp.canary_ticks, 100);
  assert.equal(fp.injection_tick, 30);
  assert.equal(fp.repeats_per_profile, 20);

  const ioMod = ioModule as { loadBaseline(dir: string): Baseline };
  const baseline = ioMod.loadBaseline(BASELINE_DIR);
  const smallEndpoints = makeEndpoints({ ...fp, healthy_windows: 5, tuning_windows: 5, repeats_per_profile: 0 });
  const plan = buildWindowPlan(baseline, smallEndpoints, []);

  const tuningSeeds = new Set(plan.filter((e) => e.provenance.split === 'tuning').map((e) => e.provenance.seed));
  const evalSeeds = new Set(plan.filter((e) => e.provenance.split !== 'tuning').map((e) => e.provenance.seed));
  assert.ok(tuningSeeds.size > 0 && evalSeeds.size > 0);
  for (const s of tuningSeeds) assert.ok(!evalSeeds.has(s), `tuning seed ${s} must not appear in the eval seed set`);
});

// ── selection-rule ────────────────────────────────────────────────────

test('tuneThreshold: picks the known minimal zero-fire k for a hand-built tuning window', () => {
  const signal = 'p99_latency';
  const mu = 100;
  const sigma = 10;
  const compiledConfig = fakeCompiledConfig(mu, sigma, signal);
  // One breach of z=3.2 embedded in an otherwise-flat window: with m=1,
  // k=2/2.5/3 all breach (z=3.2 > k) -> false fire; k=3.5 is the smallest
  // grid value that does NOT breach (3.2 < 3.5) -> the known minimal
  // zero-fire k.
  const window: Trajectory = {
    cell_key: CELL_KEY,
    signal_series: { [signal]: [mu, mu, mu + 3.2 * sigma, mu, mu] },
  };
  const endpoints = makeEndpoints({
    grids: {
      threshold: { k: [2, 2.5, 3, 3.5, 4, 5, 6, 8], m: [1], selection_rule: '' },
      canary: { alpha_c: [0.05], W: [20], selection_rule: '' },
      combined: { escalation_rule: '' },
      tuning_fp_budget: 0,
    },
    direction_table: { up_bad: [signal], down_bad: [], two_sided: [] },
  });

  const { params, audit } = tuneThreshold([tuningEntry(window)], compiledConfig, endpoints);
  assert.equal(params.kPerSignal[signal], 3.5, 'expected the tuner to pick the known minimal zero-fire k=3.5');
  assert.equal(params.consecutiveTicks, 1);
  assert.ok(audit.grid.length > 0, 'audit should record the grid points tried');

  // ── monotonic sanity: tuned params never fire on the tuning window ──
  const { firstFireTick } = runThresholdArmOverTrajectory(params, compiledConfig, window);
  assert.equal(firstFireTick, null, 'tuned params must never fire on the tuning window they were selected against');
});

test('tuneThreshold: escalates m when no k in the grid resolves a signal at a smaller m', () => {
  const signal = 'p99_latency';
  const mu = 100;
  const sigma = 10;
  const compiledConfig = fakeCompiledConfig(mu, sigma, signal);
  // A single-tick spike of z=9 (beyond the largest grid k=8) followed by
  // recovery: at m=1 no k in the grid ever achieves 0 fires (even k=8
  // breaches once), so m=1 cannot resolve; at m=2 the spike is a single
  // isolated tick so no k=1-consecutive-tick run of length 2 ever forms
  // -> k can be as small as the grid allows (2) with 0 fires at m=2.
  const window: Trajectory = {
    cell_key: CELL_KEY,
    signal_series: { [signal]: [mu, mu, mu + 9 * sigma, mu, mu, mu, mu] },
  };
  const endpoints = makeEndpoints({
    grids: {
      threshold: { k: [2, 2.5, 3, 3.5, 4, 5, 6, 8], m: [1, 2], selection_rule: '' },
      canary: { alpha_c: [0.05], W: [20], selection_rule: '' },
      combined: { escalation_rule: '' },
      tuning_fp_budget: 0,
    },
    direction_table: { up_bad: [signal], down_bad: [], two_sided: [] },
  });

  const { params } = tuneThreshold([tuningEntry(window)], compiledConfig, endpoints);
  assert.equal(params.consecutiveTicks, 2, 'expected the tuner to escalate to m=2 since m=1 cannot resolve within the k grid');
  assert.equal(params.kPerSignal[signal], 2, 'at m=2 the isolated single-tick spike never sustains a 2-tick run, so k=2 (smallest grid value) already achieves 0 fires');
});

// ── tuneCanary + tuneCombined smoke (real baseline; general properties only) ──

test('tuneCanary: chosen params never fire on the tuning windows they were selected against (real baseline)', () => {
  const ioMod = ioModule as { loadBaseline(dir: string): Baseline };
  const baseline = ioMod.loadBaseline(BASELINE_DIR);
  const compiledConfig: CompiledConfig = JSON.parse(fs.readFileSync(COMPILED_CONFIG_PATH, 'utf8'));
  const endpoints = makeEndpoints({
    tuning_windows: 6,
    healthy_windows: 0,
    repeats_per_profile: 0,
    grids: {
      threshold: { k: [3], m: [3], selection_rule: '' },
      canary: { alpha_c: [0.05, 0.01, 0.005, 0.001], W: [10, 20], selection_rule: '' },
      combined: { escalation_rule: '' },
      tuning_fp_budget: 0,
    },
    direction_table: { up_bad: ['p99_latency'], down_bad: [], two_sided: [] },
  });
  const plan = buildWindowPlan(baseline, endpoints, []);
  const tuningEntries = plan.filter((e) => e.provenance.split === 'tuning');
  assert.equal(tuningEntries.length, 6);

  const { params, audit } = tuneCanary(tuningEntries, baseline, endpoints);
  assert.ok(audit.grid.length > 0);
  assert.ok(endpoints.frozen_params.grids.canary.alpha_c.includes(params.alpha));
  assert.ok(endpoints.frozen_params.grids.canary.W.includes(params.windowTicks));

  // Re-assert zero-fire (monotonic sanity) with the SAME deterministic
  // control-seed derivation tuneCanary itself used.
  let refires = 0;
  for (let i = 0; i < tuningEntries.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deriveControlSeed } = require('../tools/_comparator-baseline-canary');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const windowsMod = require('../tools/_build-report-card-windows');
    const controlSeed = deriveControlSeed(endpoints.frozen_params.tuning_seed + i);
    const controlRng = ioModule.mulberry32(controlSeed);
    const traj = tuningEntries[i].trajectory;
    const control = windowsMod.bootstrapHealthyWindow(baseline, traj.cell_key, 100, controlRng);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runCanaryArm } = require('../tools/_comparator-baseline-canary');
    const r = runCanaryArm(traj.signal_series, control.signal_series, params);
    if (r.firstFireTick !== null) refires++;
  }
  assert.equal(refires, 0, 'tuned canary params must never fire on the tuning windows they were selected against');
});

test('tuneCombined: escalation loop converges to 0 joint false fires on the tuning split', () => {
  // Deterministic-by-construction scenario (real bootstrap noise on a
  // handful of windows can legitimately fail to resolve within a small
  // grid — see the "escalates m" unit test above for why isolated spikes
  // are the controllable case): a single populated real cell (so
  // bootstrapHealthyWindow can generate the canary arm's control window)
  // paired with a hand-built, mostly-flat p99_latency series carrying one
  // isolated spike. The canary arm is made a structural no-op by using a
  // tuning window shorter than every grid W (10, 20) — `runCanaryArm`
  // skips any look whose trailing slice is shorter than W — so this test
  // isolates the threshold arm's k=2/m=1 -> k=2/m=2 escalation exactly
  // like the "escalates m" test, but driven through tuneCombined's own
  // alpha-then-m loop.
  const ioMod = ioModule as { loadBaseline(dir: string): Baseline };
  const baseline = ioMod.loadBaseline(BASELINE_DIR);
  const compiledConfig: CompiledConfig = JSON.parse(fs.readFileSync(COMPILED_CONFIG_PATH, 'utf8'));
  const signal = 'p99_latency';
  const fallbackEntry = compiledConfig.baseline_cells.aggregate_fallback.family_A!.per_signal![signal];
  const baselineMean = fallbackEntry.baseline_mean;
  const baselineSigma = Math.sqrt(fallbackEntry.baseline_sigma_squared);
  const populatedCell = compiledConfig.baseline_cells.cells.find((c) => c.family_A?.per_signal?.[signal])!.key;

  const window: Trajectory = {
    cell_key: { hour_of_day: populatedCell.hour_of_day, day_of_week: populatedCell.day_of_week },
    // 5 ticks: flat except one isolated 3.2-sigma spike (same shape as
    // the "escalates m" test above); shorter than any grid W so the
    // canary arm never has enough trailing history to fire.
    signal_series: { [signal]: [baselineMean, baselineMean, baselineMean + 3.2 * baselineSigma, baselineMean, baselineMean] },
  };

  const endpoints = makeEndpoints({
    grids: {
      threshold: { k: [2, 2.5, 3, 3.5, 4, 5, 6, 8], m: [1, 2], selection_rule: '' },
      canary: { alpha_c: [0.05, 0.01, 0.005, 0.001], W: [10, 20], selection_rule: '' },
      combined: { escalation_rule: '' },
      tuning_fp_budget: 0,
    },
    direction_table: { up_bad: [signal], down_bad: [], two_sided: [] },
  });

  const initialThreshold = {
    params: {
      kPerSignal: { [signal]: endpoints.frozen_params.grids.threshold.k[0] }, // k=2 -> breaches the 3.2-sigma spike
      consecutiveTicks: endpoints.frozen_params.grids.threshold.m[0], // m=1 -> fires on the single breach
      directions: { [signal]: 'up' as const },
    },
    audit: { grid: [], chosen: {} },
  };
  const initialCanary = {
    params: {
      alpha: endpoints.frozen_params.grids.canary.alpha_c[0],
      lookScheduleTicks: endpoints.frozen_params.look_schedule,
      windowTicks: endpoints.frozen_params.grids.canary.W[0],
      directions: initialThreshold.params.directions,
      signals: [signal],
    },
    audit: { grid: [], chosen: {} },
  };

  const { params, audit } = tuneCombined(initialThreshold, initialCanary, [tuningEntry(window)], baseline, compiledConfig, endpoints);
  assert.ok(audit.grid.length > 0);
  assert.equal(audit.grid[audit.grid.length - 1].false_fires, 0, 'the escalation loop must converge to 0 joint false fires');
  assert.equal(params.threshold.consecutiveTicks, 2, 'expected escalation to have reached m=2 (the isolated spike resolves there)');

  // m4 (reviewer finding): the escalation step that reached m=2 must have
  // recorded the RE-RESOLVED k_s for that m, not silently carried the
  // stale m=1 k_s forward without saying so.
  const escalatedEntry = audit.grid.find((g) => (g.params as { m?: number }).m === 2);
  assert.ok(escalatedEntry, 'expected an audit entry for the m=2 escalation step');
  assert.deepEqual(
    (escalatedEntry!.params as { kPerSignal?: Record<string, number> }).kPerSignal,
    { [signal]: 2 },
    'audit entry for m=2 must record the re-resolved k_s (k=2), not a stale m=1 k_s',
  );
  assert.equal(
    (escalatedEntry!.params as { k_re_resolution_failed?: boolean }).k_re_resolution_failed,
    undefined,
    'k re-resolution succeeded at m=2, so no k_re_resolution_failed marker should be present',
  );
});

// ── m2: runtime provenance guard ────────────────────────────────────────

test('tuneThreshold / tuneCanary / tuneCombined: throw if any supplied window is not provenance.split === "tuning"', () => {
  const signal = 'p99_latency';
  const mu = 100;
  const sigma = 10;
  const compiledConfig = fakeCompiledConfig(mu, sigma, signal);
  const window: Trajectory = { cell_key: CELL_KEY, signal_series: { [signal]: [mu, mu, mu] } };
  const leakedEntry: WindowPlanEntry = {
    provenance: {
      split: 'eval_healthy',
      seed: 0,
      window_index: 0,
      cell_key: CELL_KEY,
      injection_tick: 30,
      bake_hours: 6,
    },
    trajectory: window,
  };
  const endpoints = makeEndpoints({
    direction_table: { up_bad: [signal], down_bad: [], two_sided: [] },
  });

  assert.throws(
    () => tuneThreshold([leakedEntry], compiledConfig, endpoints),
    /provenance\.split/,
    'tuneThreshold must reject an eval-split window',
  );
  const baseline: Baseline = { manifest: { signals: [signal] }, runs: [], signalMeans: { [signal]: mu } };
  assert.throws(
    () => tuneCanary([leakedEntry], baseline, endpoints),
    /provenance\.split/,
    'tuneCanary must reject an eval-split window',
  );
  const stubArm = { params: { kPerSignal: { [signal]: 2 }, consecutiveTicks: 1, directions: { [signal]: 'up' as const } }, audit: { grid: [], chosen: {} } };
  const stubCanary = {
    params: { alpha: 0.05, lookScheduleTicks: [20], windowTicks: 20, directions: { [signal]: 'up' as const }, signals: [signal] },
    audit: { grid: [], chosen: {} },
  };
  assert.throws(
    () => tuneCombined(stubArm, stubCanary, [leakedEntry], baseline, compiledConfig, endpoints),
    /provenance\.split/,
    'tuneCombined must reject an eval-split window',
  );
});

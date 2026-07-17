// tools/_comparator-baseline-driver.ts — WS6.2 Task 5: window plan +
// multi-arm driver. Builds the full evaluation plan (tuning x262,
// eval-healthy x131, eval-injected x100) replicating runFprSweep's exact
// mulberry32(42) consumption order for the eval-healthy split and
// runProfileSweep's anchor-cell rule for injected windows; materializes
// one window into {traj, controlTraj, scenario}; and runs every arm over
// a materialized window through the identical, deep-frozen trajectory.
//
// Per §0 of the implementation plan: the untyped `_build-report-card-*.js`
// modules are require()d as-is through the typed interfaces in
// _comparator-baseline-types.ts and never modified.

import type {
  Baseline,
  CompiledConfig,
  EndpointsSpec,
  HourDayCellKey,
  ReportCardCellModule,
  ReportCardGateModule,
  ReportCardIoModule,
  ReportCardWindowsModule,
  Scenario,
  SignalSeries,
  Trajectory,
  WindowPlanEntry,
  WindowProvenance,
  ArmResult,
} from './_comparator-baseline-types';
import type { RegressionProfile } from '../engine/types';
import { injectRegression, loadRegressionProfile, type SignalSeriesPerRun } from './inject-regression';
import {
  runThresholdArmOverTrajectory,
  buildDirectionMap,
  signalsWithFamilyACalibration,
  type ThresholdParams,
} from './_comparator-baseline-threshold';
import { runCanaryArm, deriveControlSeed, type CanaryParams } from './_comparator-baseline-canary';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('./_build-report-card-io') as ReportCardIoModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cellModule = require('./_build-report-card-cell') as ReportCardCellModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowsModule = require('./_build-report-card-windows') as ReportCardWindowsModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateModule = require('./_build-report-card-gate') as ReportCardGateModule;

// ── buildWindowPlan ───────────────────────────────────────────────────

/** Generate the `count` windows of a shared-RNG-stream split (`tuning` or
 *  `eval_healthy`), consuming a SINGLE `mulberry32(seed)` instance across
 *  all iterations in the exact order runFprSweep uses: per iteration,
 *  one draw to pick the cell (`cells[floor(rng() * cells.length)]`), then
 *  the window-content draws (`bootstrapHealthyWindow`'s per-tick draws —
 *  identical to what `generateHealthyWindow('iid_bootstrap', ...)` would
 *  consume, since that mode forwards straight through with no extra
 *  draws). This function IS the RNG-order replication; materializeWindow
 *  never needs to touch this stream. */
function buildSharedStreamSplit(
  split: 'tuning' | 'eval_healthy',
  seed: number,
  count: number,
  cells: (HourDayCellKey & { n_samples: number })[],
  baseline: Baseline,
  windowLength: number,
  injectionTick: number,
  bakeHours: number,
): WindowPlanEntry[] {
  const rng = ioModule.mulberry32(seed);
  const out: WindowPlanEntry[] = [];
  for (let i = 0; i < count; i++) {
    const cellKey = cells[Math.floor(rng() * cells.length)];
    const trajectory = windowsModule.bootstrapHealthyWindow(baseline, cellKey, windowLength, rng);
    const provenance: WindowProvenance = {
      split,
      seed,
      window_index: i,
      cell_key: cellKey,
      injection_tick: injectionTick,
      bake_hours: bakeHours,
    };
    out.push({ provenance, trajectory });
  }
  return out;
}

/** Enumerate the full evaluation plan (tuning + eval-healthy +
 *  eval-injected windows), each entry carrying its provenance and an
 *  already-generated (pre-injection, pre-freeze) trajectory.
 *
 *  Only `resampler: 'iid_bootstrap'` (ENDPOINTS.md's frozen default) is
 *  supported here: the shared-stream splits call `bootstrapHealthyWindow`
 *  directly (equivalent to `generateHealthyWindow('iid_bootstrap', ...)`,
 *  which forwards to it with no extra draws) so this function doesn't
 *  need a compiledConfig parameter — the plan's 3-arg spec shape
 *  (`baseline, endpoints, profiles`) is preserved. `parametric_gaussian`
 *  would need compiledConfig threaded through; out of scope for this PR
 *  (ENDPOINTS.md's frozen_params.resampler is always 'iid_bootstrap'). */
export function buildWindowPlan(
  baseline: Baseline,
  endpoints: EndpointsSpec,
  profiles: RegressionProfile[],
): WindowPlanEntry[] {
  const fp = endpoints.frozen_params;
  if (fp.resampler !== 'iid_bootstrap') {
    throw new Error(
      `buildWindowPlan: resampler "${fp.resampler}" is not supported — only 'iid_bootstrap' ` +
        '(ENDPOINTS.md\'s frozen default) is wired for the shared-stream splits in this PR.',
    );
  }

  const cells = cellModule.listPopulatedCells(baseline, 20);
  if (cells.length === 0) {
    throw new Error('buildWindowPlan: no populated cells; baseline lacks hour_of_day/day_of_week metadata');
  }

  const entries: WindowPlanEntry[] = [];

  // ── Tuning split (healthy only) — mulberry32(tuning_seed) ──
  entries.push(
    ...buildSharedStreamSplit(
      'tuning', fp.tuning_seed, fp.tuning_windows, cells, baseline, fp.canary_ticks, fp.injection_tick, fp.bake_hours,
    ),
  );

  // ── Eval healthy split — byte-for-byte runFprSweep replication ──
  entries.push(
    ...buildSharedStreamSplit(
      'eval_healthy', fp.eval_seed, fp.healthy_windows, cells, baseline, fp.canary_ticks, fp.injection_tick, fp.bake_hours,
    ),
  );

  // ── Eval injected split — runProfileSweep's anchor-cell rule; one
  //    independent mulberry32 seed per (profile, repeat) window ──
  const anchorCell = cells.find((c) => c.hour_of_day === 12 && c.day_of_week === 3) ?? cells[0];
  for (let pi = 0; pi < profiles.length; pi++) {
    const profile = profiles[pi];
    for (let repeat = 0; repeat < fp.repeats_per_profile; repeat++) {
      const seed = fp.eval_seed + 1000 + pi * 100 + repeat;
      const rng = ioModule.mulberry32(seed);
      const trajectory = windowsModule.bootstrapHealthyWindow(baseline, anchorCell, fp.canary_ticks, rng);
      const provenance: WindowProvenance = {
        split: 'eval_injected',
        seed,
        window_index: pi * fp.repeats_per_profile + repeat,
        cell_key: anchorCell,
        profile_id: profile.id,
        repeat,
        injection_tick: fp.injection_tick,
        bake_hours: fp.bake_hours,
      };
      entries.push({ provenance, trajectory });
    }
  }

  return entries;
}

// ── materializeWindow ─────────────────────────────────────────────────

function cloneSignalSeries(series: SignalSeries): SignalSeries {
  const out: SignalSeries = {};
  for (const s of Object.keys(series)) out[s] = series[s].slice();
  return out;
}

function deepFreezeTrajectory(traj: Trajectory): Trajectory {
  for (const s of Object.keys(traj.signal_series)) Object.freeze(traj.signal_series[s]);
  Object.freeze(traj.signal_series);
  Object.freeze(traj.cell_key);
  return Object.freeze(traj);
}

/** Materialize one plan entry into the {traj, controlTraj, scenario} a
 *  window's arms are evaluated over: clone the plan's stored healthy
 *  trajectory (so repeated calls never mutate it), inject the entry's
 *  regression profile if `profile_id` is set, generate a paired control
 *  trajectory from `deriveControlSeed` (never injected), build the
 *  scenario shell via the existing `buildScenario(cellMeanFromRows(...),
 *  bake_hours)`, then deep-freeze both trajectories so every arm sees
 *  identical, immutable data (binding constraint — a mutation attempt by
 *  any arm throws). */
export function materializeWindow(
  entry: WindowPlanEntry,
  baseline: Baseline,
  compiledConfig: CompiledConfig,
): { traj: Trajectory; controlTraj: Trajectory; scenario: Scenario } {
  const { provenance } = entry;

  const traj: Trajectory = {
    cell_key: provenance.cell_key,
    signal_series: cloneSignalSeries(entry.trajectory.signal_series),
  };

  if (provenance.profile_id) {
    const profile = loadRegressionProfile(provenance.profile_id);
    // injectRegression only reads/mutates `signal_series`; the cast just
    // satisfies SignalSeriesPerRun's index signature (Trajectory has none
    // by design — it's a narrow, known shape everywhere else in this
    // harness). Mutates `traj` (our clone) in place, as documented.
    injectRegression(traj as unknown as SignalSeriesPerRun, profile, provenance.injection_tick);
  }

  const windowLength = entry.trajectory.signal_series[Object.keys(entry.trajectory.signal_series)[0]]?.length ?? 0;
  const controlSeed = deriveControlSeed(provenance.seed + provenance.window_index);
  const controlRng = ioModule.mulberry32(controlSeed);
  const controlTraj = windowsModule.generateHealthyWindow(
    'iid_bootstrap', baseline, provenance.cell_key, windowLength, controlRng, compiledConfig,
  );

  const cellRows = cellModule.collectCellRows(baseline, provenance.cell_key.hour_of_day, provenance.cell_key.day_of_week);
  const cellMean = cellModule.cellMeanFromRows(cellRows, baseline.manifest.signals);
  const scenario = gateModule.buildScenario(cellMean, provenance.bake_hours);

  return {
    traj: deepFreezeTrajectory(traj),
    controlTraj: deepFreezeTrajectory(controlTraj),
    scenario,
  };
}

// ── runArmsOverWindow ─────────────────────────────────────────────────

export interface TunedArmsConfig {
  threshold: ThresholdParams;
  canary: CanaryParams;
  thresholdDefault: ThresholdParams;
  canaryDefault: CanaryParams;
}

/** `k=3, m=3` all signals; Mann-Whitney at alpha=0.05 Bonferroni over
 *  signals x looks, W=20 — the untuned textbook defaults ENDPOINTS.md
 *  freezes for the `combined_default` bracketing row. The threshold
 *  arm's signal set is restricted to those with resolvable family_A
 *  calibration (see `signalsWithFamilyACalibration`); the canary arm
 *  doesn't depend on that calibration (Mann-Whitney works directly off
 *  the raw signal series) so it covers the full direction-table set. */
export function buildDefaultArmsConfig(
  endpoints: EndpointsSpec,
  compiledConfig: CompiledConfig,
): { threshold: ThresholdParams; canary: CanaryParams } {
  const fp = endpoints.frozen_params;
  const directions = buildDirectionMap(fp.direction_table);
  const allSignals = Object.keys(directions);
  const thresholdSignals = signalsWithFamilyACalibration(compiledConfig, allSignals);
  const kPerSignal: Record<string, number> = {};
  for (const s of thresholdSignals) kPerSignal[s] = 3;
  return {
    threshold: { kPerSignal, consecutiveTicks: 3, directions },
    canary: { alpha: 0.05, lookScheduleTicks: fp.look_schedule, windowTicks: 20, directions, signals: allSignals },
  };
}

function orArms(armId: string, a: ArmResult, b: ArmResult): ArmResult {
  const ticks = [a.firstFireTick, b.firstFireTick].filter((t): t is number => t !== null);
  const firstFireTick = ticks.length > 0 ? Math.min(...ticks) : null;
  const firingSignals = Array.from(new Set([...a.firingSignals, ...b.firingSignals]));
  // I1: union both arms' fire-tick lists, ascending + deduped, so the
  // OR-combined arm (combined_tuned / combined_default) still carries
  // the full firing history rather than collapsing to just firstFireTick.
  const fireTicks = Array.from(new Set([...a.fireTicks, ...b.fireTicks])).sort((x, y) => x - y);
  return { armId, firstFireTick, firingSignals, fireTicks };
}

/** Run every registered arm over one materialized window. Portfolio arms
 *  (`portfolio_alpha`, `portfolio_combined`) share a single engine pass
 *  via `runGateOverTrajectory`; `portfolio_alpha`'s fire/first-fire-tick
 *  is the earliest of the A/C/D/E (`ALPHA_SPENDING_FAMILIES`) per-family
 *  first-fire ticks, `portfolio_combined`'s is `runGateOverTrajectory`'s
 *  own overall `firstFireTick` (already the min across all families
 *  A-E). Both carry the raw `perFamilyFirstFireTick` so a downstream D1
 *  (post-injection) aggregation can be applied later without re-running
 *  the engine. Comparator arms reuse Tasks 3-4 directly over the same
 *  frozen `traj`/`controlTraj` objects — no defensive copies are made,
 *  so a would-be mutation by any arm throws (deep-freeze invariant). */
export function runArmsOverWindow(
  materialized: { traj: Trajectory; controlTraj: Trajectory; scenario: Scenario },
  arms: TunedArmsConfig,
  compiledConfig: CompiledConfig,
  endpoints: EndpointsSpec,
): Record<string, ArmResult> {
  const fp = endpoints.frozen_params;
  const { traj, controlTraj, scenario } = materialized;

  const gr = gateModule.runGateOverTrajectory(traj, scenario, compiledConfig, fp.canary_ticks, fp.bake_hours);
  const alphaFamilies = gateModule.ALPHA_SPENDING_FAMILIES;
  const alphaTicks = alphaFamilies
    .map((f) => gr.perFamilyFirstFireTick[f])
    .filter((t): t is number => t !== null && t !== undefined);
  const alphaFirstFireTick = alphaTicks.length > 0 ? Math.min(...alphaTicks) : null;
  const alphaFiringSignals = alphaFamilies
    .filter((f) => gr.perFamilyFirstFireTick[f] !== null && gr.perFamilyFirstFireTick[f] !== undefined)
    .map((f) => gr.perFamilyFirstSignal[f])
    .filter((s): s is string => s !== null && s !== undefined);
  const combinedFiringSignals = gr.firingFamilies
    .map((f) => gr.perFamilyFirstSignal[f])
    .filter((s): s is string => s !== null && s !== undefined);

  // Portfolio arms' fire history is bounded to what `runGateOverTrajectory`
  // (frozen, not re-run per-tick) exposes: a single first-fire tick, not a
  // full firing history. `fireTicks` is therefore the degenerate
  // single-entry/empty list here — see ArmResult's JSDoc. Richer
  // per-family firing detail for portfolio arms is `perFamilyFirstFireTick`.
  const result: Record<string, ArmResult> = {
    portfolio_alpha: {
      armId: 'portfolio_alpha',
      firstFireTick: alphaFirstFireTick,
      firingSignals: alphaFiringSignals,
      fireTicks: alphaFirstFireTick !== null ? [alphaFirstFireTick] : [],
      perFamilyFirstFireTick: gr.perFamilyFirstFireTick,
    },
    portfolio_combined: {
      armId: 'portfolio_combined',
      firstFireTick: gr.firstFireTick,
      firingSignals: combinedFiringSignals,
      fireTicks: gr.firstFireTick !== null ? [gr.firstFireTick] : [],
      perFamilyFirstFireTick: gr.perFamilyFirstFireTick,
    },
  };

  const thresholdTuned = runThresholdArmOverTrajectory(arms.threshold, compiledConfig, traj);
  result.threshold_tuned = { armId: 'threshold_tuned', ...thresholdTuned };

  const canaryTuned = runCanaryArm(traj.signal_series, controlTraj.signal_series, arms.canary);
  result.canary_tuned = { ...canaryTuned, armId: 'canary_tuned' };

  result.combined_tuned = orArms('combined_tuned', result.threshold_tuned, result.canary_tuned);

  const thresholdDefault = runThresholdArmOverTrajectory(arms.thresholdDefault, compiledConfig, traj);
  const canaryDefault = runCanaryArm(traj.signal_series, controlTraj.signal_series, arms.canaryDefault);
  result.combined_default = orArms(
    'combined_default',
    { armId: 'threshold_default', ...thresholdDefault },
    { ...canaryDefault, armId: 'canary_default' },
  );

  return result;
}

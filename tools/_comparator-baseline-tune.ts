// tools/_comparator-baseline-tune.ts — WS6.2 Task 6: tuning module.
// Selects comparator-arm parameters against the healthy-only tuning
// split, per ENDPOINTS.md's frozen grids and selection rules (never
// peeking at the eval split or any regression profile).

import type { Baseline, CompiledConfig, EndpointsSpec, Trajectory, WindowPlanEntry } from './_comparator-baseline-types';
import {
  runThresholdArmOverTrajectory,
  buildDirectionMap,
  signalsWithFamilyACalibration,
  type ThresholdParams,
  type Direction,
} from './_comparator-baseline-threshold';
import { runCanaryArm, deriveControlSeed, type CanaryParams } from './_comparator-baseline-canary';
import type { ReportCardWindowsModule } from './_comparator-baseline-types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioModule = require('./_build-report-card-io');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowsModule = require('./_build-report-card-windows') as ReportCardWindowsModule;

export interface TuningAudit {
  /** One entry per grid point tried, in the order tried. `false_fires`
   *  is the observed count over the tuning split (or -1 for a threshold
   *  grid point where some signal never resolved a zero-fire k within
   *  the k grid at that m — i.e. that m is not viable). */
  grid: Array<{ params: Record<string, unknown>; false_fires: number }>;
  chosen: Record<string, unknown>;
}

/** Runtime provenance guard (MINOR m2, reviewer finding): every window
 *  handed to a tuner must be provenance-stamped `split: 'tuning'` — the
 *  ONE check-and-extract chokepoint (mirrors `resolveMeanSigma` in
 *  _comparator-baseline-threshold.ts) so a caller can never silently feed
 *  an eval-split window into a tuning routine (that would be leakage:
 *  tuning against the very data the frozen endpoints later score against).
 *  Throws eagerly, before any grid work, rather than trusting the caller.
 *  Returns the bare trajectories the existing tick-loop helpers below
 *  operate on. */
function assertTuningWindows(windows: WindowPlanEntry[]): Trajectory[] {
  for (const w of windows) {
    if (w.provenance.split !== 'tuning') {
      throw new Error(
        `assertTuningWindows: window (seed=${w.provenance.seed}, index=${w.provenance.window_index}) has ` +
          `provenance.split "${w.provenance.split}", expected "tuning" — tuners must never see eval-split windows.`,
      );
    }
  }
  return windows.map((w) => w.trajectory);
}

function countThresholdFalseFires(
  windows: Trajectory[],
  compiledConfig: CompiledConfig,
  params: ThresholdParams,
): number {
  let count = 0;
  for (const traj of windows) {
    const { firstFireTick } = runThresholdArmOverTrajectory(params, compiledConfig, traj);
    if (firstFireTick !== null) count++;
  }
  return count;
}

/** Per-signal minimal-k resolution for a fixed `m`: for each signal, the
 *  smallest `k` (ascending grid order) whose ISOLATED single-signal gate
 *  produces zero false fires on `windows`. Returns `null` overall if any
 *  signal can't resolve within the grid at this `m` (caller should try a
 *  larger `m`). Extracted so both `tuneThreshold` (iterating the m grid)
 *  and `tuneCombined` (escalating m) share the same resolution logic. */
function resolveThresholdForM(
  windows: Trajectory[],
  compiledConfig: CompiledConfig,
  m: number,
  kGrid: number[],
  directions: Record<string, Direction>,
  signals: string[],
): { kPerSignal: Record<string, number>; resolved: boolean } {
  const kPerSignal: Record<string, number> = {};
  let resolved = true;
  for (const signal of signals) {
    let kForSignal: number | null = null;
    for (const k of kGrid) {
      const fires = countThresholdFalseFires(windows, compiledConfig, {
        kPerSignal: { [signal]: k },
        consecutiveTicks: m,
        directions,
      });
      if (fires === 0) {
        kForSignal = k;
        break;
      }
    }
    if (kForSignal === null) {
      resolved = false;
    } else {
      kPerSignal[signal] = kForSignal;
    }
  }
  return { kPerSignal, resolved };
}

/** Tune the threshold-gate arm per ENDPOINTS.md's frozen grid/rule: for
 *  each `m` (ascending), set `k_s` = the minimal per-signal k with zero
 *  isolated false fires on the tuning split; pick the smallest `m` whose
 *  per-signal gates ALSO produce zero false fires jointly (which, by
 *  construction, always holds once every signal resolves — the joint
 *  recheck is the "monotonic sanity" re-assertion baked into the tuner
 *  itself, not a separate step). The threshold signal set is restricted
 *  to those with resolvable family_A calibration (see
 *  `signalsWithFamilyACalibration`) — the same restriction Task 5's
 *  untuned defaults use, for the same reason (some signals have no
 *  family_A calibration anywhere in the compiled config). */
export function tuneThreshold(
  tuningWindows: WindowPlanEntry[],
  compiledConfig: CompiledConfig,
  endpoints: EndpointsSpec,
): { params: ThresholdParams; audit: TuningAudit } {
  const windows = assertTuningWindows(tuningWindows);
  const fp = endpoints.frozen_params;
  const grid = fp.grids.threshold;
  const directions = buildDirectionMap(fp.direction_table);
  const signals = signalsWithFamilyACalibration(compiledConfig, Object.keys(directions));

  const auditEntries: TuningAudit['grid'] = [];
  let chosen: { m: number; kPerSignal: Record<string, number> } | null = null;

  for (const m of grid.m) {
    const { kPerSignal, resolved } = resolveThresholdForM(windows, compiledConfig, m, grid.k, directions, signals);
    let jointFires = -1;
    if (resolved) {
      jointFires = countThresholdFalseFires(windows, compiledConfig, { kPerSignal, consecutiveTicks: m, directions });
    }
    auditEntries.push({ params: { m, kPerSignal: { ...kPerSignal }, resolved }, false_fires: jointFires });
    if (resolved && jointFires === 0 && chosen === null) {
      chosen = { m, kPerSignal: { ...kPerSignal } };
    }
  }

  if (!chosen) {
    throw new Error('tuneThreshold: no (k, m) combination achieved 0 false fires on the tuning split across the frozen grid');
  }

  return {
    params: { kPerSignal: chosen.kPerSignal, consecutiveTicks: chosen.m, directions },
    audit: { grid: auditEntries, chosen: { m: chosen.m, kPerSignal: chosen.kPerSignal } },
  };
}

function countCanaryFalseFires(
  windows: Trajectory[],
  baseline: Baseline,
  params: CanaryParams,
  seedBase: number,
): number {
  let count = 0;
  for (let i = 0; i < windows.length; i++) {
    const traj = windows[i];
    const controlSeed = deriveControlSeed(seedBase + i);
    const controlRng = ioModule.mulberry32(controlSeed);
    const windowLength = traj.signal_series[Object.keys(traj.signal_series)[0]]?.length ?? 0;
    const control = windowsModule.bootstrapHealthyWindow(baseline, traj.cell_key, windowLength, controlRng);
    const r = runCanaryArm(traj.signal_series, control.signal_series, params);
    if (r.firstFireTick !== null) count++;
  }
  return count;
}

/** Tune the canary-vs-control arm per ENDPOINTS.md's frozen grid/rule:
 *  largest `alpha_c` (most sensitive), then largest `W`, with zero false
 *  fires on the tuning split. Generates a fresh, deterministic, disjoint
 *  control window per tuning window (via `deriveControlSeed`, keyed off
 *  `tuning_seed + window index`) — never injected, mirroring the
 *  driver's control-generation approach for the eval splits. Records
 *  every (alpha_c, W) grid point tried (not just the winner) so the
 *  audit shows the comparator wasn't strawmanned. */
export function tuneCanary(
  tuningWindows: WindowPlanEntry[],
  baseline: Baseline,
  endpoints: EndpointsSpec,
): { params: CanaryParams; audit: TuningAudit } {
  const windows = assertTuningWindows(tuningWindows);
  const fp = endpoints.frozen_params;
  const grid = fp.grids.canary;
  const directions = buildDirectionMap(fp.direction_table);
  const signals = Object.keys(directions);
  const lookSchedule = fp.look_schedule;
  const wDescending = [...grid.W].sort((a, b) => b - a);

  const auditEntries: TuningAudit['grid'] = [];
  let chosen: { alpha: number; W: number } | null = null;

  for (const alpha of grid.alpha_c) {
    for (const W of wDescending) {
      const params: CanaryParams = { alpha, lookScheduleTicks: lookSchedule, windowTicks: W, directions, signals };
      const fires = countCanaryFalseFires(windows, baseline, params, fp.tuning_seed);
      auditEntries.push({ params: { alpha, W }, false_fires: fires });
      if (fires === 0 && chosen === null) {
        chosen = { alpha, W };
      }
    }
  }

  if (!chosen) {
    throw new Error('tuneCanary: no (alpha_c, W) combination achieved 0 false fires on the tuning split across the frozen grid');
  }

  return {
    params: { alpha: chosen.alpha, lookScheduleTicks: lookSchedule, windowTicks: chosen.W, directions, signals },
    audit: { grid: auditEntries, chosen },
  };
}

/** Combined-arm escalation loop per ENDPOINTS.md: if the OR of the two
 *  already-tuned arms exceeds 0/262 false fires jointly, tighten in
 *  pre-registered order — decrease alpha_c one grid step, then increase
 *  m one grid step (re-resolving k_s for the new m via
 *  `resolveThresholdForM`), repeating until 0 false fires or the grid is
 *  exhausted.
 *
 *  m4 (reviewer finding): every audit entry records the `kPerSignal`
 *  actually in force for that step, plus `k_re_resolution_failed: true`
 *  when the MOST RECENT m-escalation couldn't re-resolve k_s for the new
 *  m within the grid and therefore kept the stale (previous-m) k_s —
 *  otherwise a reader has no way to tell "these k values are valid for
 *  this m" from "these are stale k values silently carried forward"
 *  without re-deriving the escalation path by hand. */
export function tuneCombined(
  threshold: { params: ThresholdParams; audit: TuningAudit },
  canary: { params: CanaryParams; audit: TuningAudit },
  tuningWindows: WindowPlanEntry[],
  baseline: Baseline,
  compiledConfig: CompiledConfig,
  endpoints: EndpointsSpec,
): { params: { threshold: ThresholdParams; canary: CanaryParams }; audit: TuningAudit } {
  const windows = assertTuningWindows(tuningWindows);
  const fp = endpoints.frozen_params;
  const alphaGrid = fp.grids.canary.alpha_c; // pre-registered order: descending (most sensitive first)
  const mGrid = fp.grids.threshold.m; // pre-registered order: ascending

  let thresholdParams = threshold.params;
  let canaryParams = canary.params;
  let alphaIdx = alphaGrid.indexOf(canaryParams.alpha);
  let mIdx = mGrid.indexOf(thresholdParams.consecutiveTicks);
  let kReResolutionFailed = false;

  const auditEntries: TuningAudit['grid'] = [];
  const maxSteps = alphaGrid.length + mGrid.length + 1;

  for (let step = 0; step <= maxSteps; step++) {
    const combinedFires = countCombinedFalseFires(windows, baseline, compiledConfig, thresholdParams, canaryParams, fp.tuning_seed);
    auditEntries.push({
      params: {
        alpha: canaryParams.alpha,
        m: thresholdParams.consecutiveTicks,
        kPerSignal: { ...thresholdParams.kPerSignal },
        ...(kReResolutionFailed ? { k_re_resolution_failed: true } : {}),
      },
      false_fires: combinedFires,
    });
    if (combinedFires === 0) {
      return {
        params: { threshold: thresholdParams, canary: canaryParams },
        audit: { grid: auditEntries, chosen: { alpha: canaryParams.alpha, m: thresholdParams.consecutiveTicks } },
      };
    }
    if (alphaIdx + 1 < alphaGrid.length) {
      alphaIdx++;
      canaryParams = { ...canaryParams, alpha: alphaGrid[alphaIdx] };
    } else if (mIdx + 1 < mGrid.length) {
      mIdx++;
      const { kPerSignal, resolved } = resolveThresholdForM(
        windows, compiledConfig, mGrid[mIdx], fp.grids.threshold.k, thresholdParams.directions,
        Object.keys(thresholdParams.kPerSignal),
      );
      kReResolutionFailed = !resolved;
      if (resolved) {
        thresholdParams = { ...thresholdParams, consecutiveTicks: mGrid[mIdx], kPerSignal };
      } else {
        thresholdParams = { ...thresholdParams, consecutiveTicks: mGrid[mIdx] };
      }
    } else {
      throw new Error('tuneCombined: escalation grid exhausted without reaching 0 false fires on the tuning split');
    }
  }
  throw new Error('tuneCombined: escalation did not converge within the frozen grid');
}

function countCombinedFalseFires(
  windows: Trajectory[],
  baseline: Baseline,
  compiledConfig: CompiledConfig,
  thresholdParams: ThresholdParams,
  canaryParams: CanaryParams,
  seedBase: number,
): number {
  let count = 0;
  for (let i = 0; i < windows.length; i++) {
    const traj = windows[i];
    const { firstFireTick: tFire } = runThresholdArmOverTrajectory(thresholdParams, compiledConfig, traj);
    if (tFire !== null) {
      count++;
      continue;
    }
    const controlSeed = deriveControlSeed(seedBase + i);
    const controlRng = ioModule.mulberry32(controlSeed);
    const windowLength = traj.signal_series[Object.keys(traj.signal_series)[0]]?.length ?? 0;
    const control = windowsModule.bootstrapHealthyWindow(baseline, traj.cell_key, windowLength, controlRng);
    const canaryResult = runCanaryArm(traj.signal_series, control.signal_series, canaryParams);
    if (canaryResult.firstFireTick !== null) count++;
  }
  return count;
}

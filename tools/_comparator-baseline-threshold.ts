// tools/_comparator-baseline-threshold.ts — WS6.2 Task 3: threshold-gate
// comparator arm. Static per-signal μ±kσ gates with a consecutive-tick
// run-length state machine, mirroring Flagger/Argo-Rollouts-style metric
// threshold checks. μ_s, σ_s are read from the same compiled-config cell
// (with the same aggregate_fallback path) the portfolio consults —
// information parity per ENDPOINTS.md.
//
// Reviewer note honored: the cell-resolution + meanSigma call is wrapped
// in exactly ONE helper (`resolveMeanSigma`, below) so the fallback logic
// (`lookupCell(...) ?? aggregate_fallback`, per
// _comparator-baseline-stats.ts's meanSigmaFromCompiledCell JSDoc) exists
// in exactly one place, rather than being re-inlined per signal.

import type { CompiledConfig, HourDayCellKey, ReportCardCellModule, Trajectory } from './_comparator-baseline-types';
import { meanSigmaFromCompiledCell } from './_comparator-baseline-stats';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cellModule = require('./_build-report-card-cell') as ReportCardCellModule;

export type Direction = 'up' | 'down' | 'both';

export interface ThresholdParams {
  kPerSignal: Record<string, number>;
  consecutiveTicks: number;
  directions: Record<string, Direction>;
}

export interface ThresholdArm {
  onTick(t: number, live: Record<string, number>): string[];
}

/** Reads {mu, sigma} for `signal` at `cellKey`, falling back to
 *  `compiledConfig.baseline_cells.aggregate_fallback` the same way the
 *  engine and report-card machinery do elsewhere — the ONE place this
 *  resolution happens in the threshold arm. */
function resolveMeanSigma(
  compiledConfig: CompiledConfig,
  cellKey: HourDayCellKey,
  signal: string,
): { mu: number; sigma: number } {
  const cell = cellModule.lookupCell(compiledConfig, cellKey) ?? compiledConfig.baseline_cells.aggregate_fallback;
  return meanSigmaFromCompiledCell(cell, signal);
}

/** Build a threshold-gate arm for one window/trajectory (fixed cellKey).
 *  Returns an `onTick` state machine: call it once per tick, in tick
 *  order, with that tick's live signal values; it returns the signals
 *  that just completed a `consecutiveTicks`-long breach run as of this
 *  tick (empty array if none). The caller records the first tick with a
 *  non-empty return as the arm's first-fire tick.
 *
 *  Breach test: `(live[s] - mu_s) / sigma_s > k_s` for direction 'up',
 *  `< -k_s` for 'down', `abs(...) > k_s` for 'both'. A non-breaching tick
 *  resets that signal's run counter to 0. Signals with sigma === 0 (no
 *  observed variance at this cell) never fire — guards against a
 *  division that would otherwise always breach on the slightest
 *  deviation. */
export function makeThresholdArm(
  params: ThresholdParams,
  compiledConfig: CompiledConfig,
  cellKey: HourDayCellKey,
): ThresholdArm {
  const signals = Object.keys(params.kPerSignal);
  const musigma = new Map<string, { mu: number; sigma: number }>();
  for (const signal of signals) {
    musigma.set(signal, resolveMeanSigma(compiledConfig, cellKey, signal));
  }
  const runLengths: Record<string, number> = {};
  for (const signal of signals) runLengths[signal] = 0;

  return {
    onTick(_t: number, live: Record<string, number>): string[] {
      const fired: string[] = [];
      for (const signal of signals) {
        const value = live[signal];
        const { mu, sigma } = musigma.get(signal)!;
        if (value === undefined || sigma === 0) {
          runLengths[signal] = 0;
          continue;
        }
        const k = params.kPerSignal[signal];
        const direction = params.directions[signal] ?? 'both';
        const z = (value - mu) / sigma;
        const breach = direction === 'up' ? z > k : direction === 'down' ? z < -k : Math.abs(z) > k;
        runLengths[signal] = breach ? runLengths[signal] + 1 : 0;
        if (runLengths[signal] >= params.consecutiveTicks) fired.push(signal);
      }
      return fired;
    },
  };
}

/** Run a threshold arm over a full trajectory and reduce to an
 *  ArmResult-shaped summary. Shared by the Task 5 driver (per-window arm
 *  evaluation) and the Task 6 tuner (false-fire counting on the tuning
 *  split) so the tick loop exists in one place. */
export function runThresholdArmOverTrajectory(
  params: ThresholdParams,
  compiledConfig: CompiledConfig,
  traj: Trajectory,
): { firstFireTick: number | null; firingSignals: string[] } {
  const arm = makeThresholdArm(params, compiledConfig, traj.cell_key);
  const signals = Object.keys(traj.signal_series);
  const ticks = signals.length > 0 ? traj.signal_series[signals[0]].length : 0;
  let firstFireTick: number | null = null;
  const firingSignals = new Set<string>();
  for (let t = 0; t < ticks; t++) {
    const live: Record<string, number> = {};
    for (const s of signals) live[s] = traj.signal_series[s][t];
    const fired = arm.onTick(t, live);
    if (fired.length > 0) {
      if (firstFireTick === null) firstFireTick = t;
      for (const s of fired) firingSignals.add(s);
    }
  }
  return { firstFireTick, firingSignals: Array.from(firingSignals) };
}

/** Direction table (frozen in ENDPOINTS.md) → per-signal Direction map. */
export function buildDirectionMap(directionTable: {
  up_bad: string[];
  down_bad: string[];
  two_sided: string[];
}): Record<string, Direction> {
  const out: Record<string, Direction> = {};
  for (const s of directionTable.up_bad) out[s] = 'up';
  for (const s of directionTable.down_bad) out[s] = 'down';
  for (const s of directionTable.two_sided) out[s] = 'both';
  return out;
}

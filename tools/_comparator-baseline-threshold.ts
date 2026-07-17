// tools/_comparator-baseline-threshold.ts — WS6.2 Task 3: threshold-gate
// comparator arm. Static per-signal μ±kσ gates with a consecutive-tick
// run-length state machine, mirroring Flagger/Argo-Rollouts-style metric
// threshold checks. μ_s, σ_s are read from the same compiled-config cell
// the portfolio consults — information parity per ENDPOINTS.md, in the
// sense that this arm never sees calibration data the portfolio lacks.
//
// One deliberate, comparator-favoring asymmetry in the aggregate_fallback
// path (carried over from an earlier reviewer pass; corrected here to
// state it accurately rather than as unqualified "same fallback path"):
// the engine (`buildMSPRTParamsLocal` in
// `engine/detectors/betting-e-process.ts`) only retries
// `aggregate_fallback` when the matched cell's `confidence` is
// `'aggregate'` or `'none'` — for a `'pooled'` (or other
// confidence-gated) cell missing the signal, the engine returns `null`
// and that signal simply isn't monitored at that cell. `resolveMeanSigma`
// below has no such gate: it retries `aggregate_fallback` unconditionally
// whenever `meanSigmaFromCompiledCell` fails to find the signal on the
// matched cell, regardless of that cell's `confidence`. So this arm's
// fallback is strictly LOOSER than the engine's — it can resolve
// calibration (and therefore gate) a (cell, signal) pair the engine would
// silently decline to monitor. That is an asymmetry in the comparator's
// favor (more information, not less), consistent with ENDPOINTS.md's
// fairness note on the canary arm's control stream — the conservative
// direction for this study, not a parity violation.
//
// Reviewer note honored: the cell-resolution + meanSigma call is wrapped
// in exactly ONE helper (`resolveMeanSigma`, below) so the fallback logic
// (`lookupCell(...) ?? aggregate_fallback`, per
// _comparator-baseline-stats.ts's meanSigmaFromCompiledCell JSDoc) exists
// in exactly one place, rather than being re-inlined per signal.
//
// C1 fix (reviewer finding): the engine applies a class-appropriate
// variance-stabilizing transform (identity / logit / log / Anscombe —
// `engine/signal-classes.ts`) symmetrically at compile time AND runtime
// before standardizing (`engine/detectors/betting-e-process.ts`). That
// means `family_A.per_signal.<s>.baseline_mean` / `baseline_sigma_squared`
// are in TRANSFORMED space whenever the signal's class isn't
// 'gaussian_like'. This arm must apply the SAME forward transform to the
// live value before z-scoring, or it z-scores a raw-space observation
// against transformed-space stats — on the real v5 config this put a
// healthy tick at z≈+10 (downstream_err, bounded_probability) and z≈+58
// (cost_req, heavy_tail). `transformForClass` is imported from the
// engine (not reimplemented) and applied via `resolveMeanSigma`, below,
// which resolves {mu, sigma, class} for a (cell, signal) as ONE unit so
// the class always travels with the exact mu/sigma it was derived
// alongside (never transform against one cell's class but z-score
// against a different cell's mu/sigma).

import type { CompiledConfig, HourDayCellKey, ReportCardCellModule, Trajectory } from './_comparator-baseline-types';
import { meanSigmaFromCompiledCell } from './_comparator-baseline-stats';
import { transformForClass, type SignalClass } from '../engine/signal-classes';

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

/** Reads {mu, sigma, cls} for `signal` at `cellKey`, falling back to
 *  `compiledConfig.baseline_cells.aggregate_fallback` — the ONE place
 *  this resolution happens in the threshold arm. Two fallback cases,
 *  both handled here unconditionally: (1) `lookupCell` finds no cell at
 *  all for `cellKey` (e.g. a sparsely-populated cell not present in the
 *  compiled config), and (2) a real cell is found but its
 *  `family_A.per_signal` doesn't carry this particular signal (partial
 *  per-cell calibration) — in which case `meanSigmaFromCompiledCell`
 *  throws and this retries against `aggregate_fallback`, exactly as its
 *  JSDoc documents. Unconditionally is the operative word: unlike the
 *  engine's `buildMSPRTParamsLocal`, this fallback does not gate on the
 *  matched cell's `confidence` field — see the file header for the
 *  resulting (comparator-favoring) asymmetry.
 *
 *  `cls` is resolved from the SAME per_signal entry mu/sigma came from
 *  (never a different cell's class), then falls through exactly like the
 *  engine's own runtime resolution
 *  (`engine/detectors/betting-e-process.ts`: `perSig.signal_class ??
 *  cfg.signal_classes?.[signal] ?? 'gaussian_like'`). Deliberately NOT
 *  `resolveSignalClass`/`DEFAULT_SIGNAL_CLASSES` — per that file's
 *  comment, `DEFAULT_SIGNAL_CLASSES` is a compile-time default for new
 *  compiles, not a runtime fallback; a pre-Q2.A compiled config that
 *  lacks both fields was calibrated in raw space and must stay
 *  untransformed here too, byte-identical to the engine's behavior. */
function resolveMeanSigma(
  compiledConfig: CompiledConfig,
  cellKey: HourDayCellKey,
  signal: string,
): { mu: number; sigma: number; cls: SignalClass } {
  const cell = cellModule.lookupCell(compiledConfig, cellKey);
  let resolved: { mu: number; sigma: number; signalClass?: SignalClass } | undefined;
  if (cell) {
    try {
      resolved = meanSigmaFromCompiledCell(cell, signal);
    } catch {
      // Real cell, but no per-signal entry for this signal — fall
      // through to aggregate_fallback below.
    }
  }
  if (!resolved) {
    resolved = meanSigmaFromCompiledCell(compiledConfig.baseline_cells.aggregate_fallback, signal);
  }
  const cls: SignalClass = resolved.signalClass ?? (compiledConfig.signal_classes?.[signal] as SignalClass | undefined) ?? 'gaussian_like';
  return { mu: resolved.mu, sigma: resolved.sigma, cls };
}

/** Build a threshold-gate arm for one window/trajectory (fixed cellKey).
 *  Returns an `onTick` state machine: call it once per tick, in tick
 *  order, with that tick's live signal values; it returns the signals
 *  that just completed a `consecutiveTicks`-long breach run as of this
 *  tick (empty array if none). The caller records the first tick with a
 *  non-empty return as the arm's first-fire tick.
 *
 *  Breach test: `(transformForClass(live[s], cls_s) - mu_s) / sigma_s >
 *  k_s` for direction 'up', `< -k_s` for 'down', `abs(...) > k_s` for
 *  'both' — `mu_s`/`sigma_s` (and the class they're consistent with) come
 *  from `resolveMeanSigma`, which applies the engine's own
 *  `transformForClass` to the live value before z-scoring (C1 fix — see
 *  the file header). All four per-class transforms
 *  (identity/logit/log/Anscombe) are strictly monotone increasing, so a
 *  rise/fall in raw-space is still a rise/fall in transformed-space:
 *  the pre-registered 'up'/'down' direction table applies unchanged to
 *  the transformed z, no direction flip needed. A non-breaching tick
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
  const musigma = new Map<string, { mu: number; sigma: number; cls: SignalClass }>();
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
        const { mu, sigma, cls } = musigma.get(signal)!;
        if (value === undefined || sigma === 0) {
          runLengths[signal] = 0;
          continue;
        }
        const k = params.kPerSignal[signal];
        const direction = params.directions[signal] ?? 'both';
        const transformed = transformForClass(value, cls);
        const z = (transformed - mu) / sigma;
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
 *  split) so the tick loop exists in one place. `fireTicks` (I1) is
 *  every tick that produced a non-empty `onTick` return, ascending —
 *  not just the first — so a downstream escape/delay computation can
 *  tell a pre-injection false fire apart from a post-injection
 *  detection. */
export function runThresholdArmOverTrajectory(
  params: ThresholdParams,
  compiledConfig: CompiledConfig,
  traj: Trajectory,
): { firstFireTick: number | null; firingSignals: string[]; fireTicks: number[] } {
  const arm = makeThresholdArm(params, compiledConfig, traj.cell_key);
  const signals = Object.keys(traj.signal_series);
  const ticks = signals.length > 0 ? traj.signal_series[signals[0]].length : 0;
  let firstFireTick: number | null = null;
  const firingSignals = new Set<string>();
  const fireTicks: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const live: Record<string, number> = {};
    for (const s of signals) live[s] = traj.signal_series[s][t];
    const fired = arm.onTick(t, live);
    if (fired.length > 0) {
      if (firstFireTick === null) firstFireTick = t;
      fireTicks.push(t);
      for (const s of fired) firingSignals.add(s);
    }
  }
  return { firstFireTick, firingSignals: Array.from(firingSignals), fireTicks };
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

/** Restrict `signals` to those with a resolvable `family_A.per_signal`
 *  entry in `compiledConfig.baseline_cells.aggregate_fallback` — the
 *  threshold arm's information source per ENDPOINTS.md. Not every signal
 *  in the direction table has Family A calibration: the real
 *  v5-sequential-e-process.json compiled config calibrates only 6 of the
 *  15 direction-table signals via family_A (verified: the per-cell union
 *  across all 840 cells never exceeds aggregate_fallback's coverage, so
 *  checking aggregate_fallback alone is sufficient — no cell resolves a
 *  signal aggregate_fallback doesn't). A Flagger-style threshold gate
 *  can't be built for a signal with no calibrated baseline anywhere in
 *  the config, so those signals are simply not gated by this arm —
 *  mirroring how such tooling can't threshold-check a metric it was
 *  never configured with a baseline for. Used when building both the
 *  tuned (Task 6) and untuned-default (Task 5) threshold-arm signal
 *  sets. */
export function signalsWithFamilyACalibration(compiledConfig: CompiledConfig, signals: string[]): string[] {
  const fallbackPerSignal = compiledConfig.baseline_cells.aggregate_fallback.family_A?.per_signal ?? {};
  return signals.filter((s) => fallbackPerSignal[s] !== undefined);
}

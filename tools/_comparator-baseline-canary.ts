// tools/_comparator-baseline-canary.ts — WS6.2 Task 4: canary-vs-control
// comparator arm. At each look in a fixed schedule, runs a Mann-Whitney U
// test per signal on the trailing W ticks of the canary stream vs the
// same-index ticks of a paired control stream, Bonferroni-corrected across
// (signals × looks). Mimics the Spinnaker/Kayenta canary judge (per-metric
// Mann-Whitney) evaluated on a fixed-look progressive-delivery schedule.

import type { ArmResult, SignalSeries } from './_comparator-baseline-types';
import { mannWhitneyU } from './_comparator-baseline-stats';
import type { Direction } from './_comparator-baseline-threshold';

export interface CanaryParams {
  alpha: number;
  lookScheduleTicks: number[];
  windowTicks: number;
  directions: Record<string, Direction>;
  signals: string[];
}

/** Deterministic, disjoint control-stream seed derived from a window's
 *  seed. XORs with a fixed odd constant (the standard golden-ratio mix
 *  constant) so the control stream never coincides with the canary
 *  stream's own seed. */
export function deriveControlSeed(windowSeed: number): number {
  return (windowSeed ^ 0x9e3779b9) >>> 0;
}

/** Directional p-value for `canary` vs `control` on one signal, per the
 *  signal's pre-registered degradation direction: 'up' tests canary
 *  stochastically greater (pGreater), 'down' tests canary stochastically
 *  less (pLess), 'both' uses the two-sided p-value. */
function directionalP(canarySlice: number[], controlSlice: number[], direction: Direction): number {
  const r = mannWhitneyU(canarySlice, controlSlice);
  if (direction === 'up') return r.pGreater;
  if (direction === 'down') return r.pLess;
  return r.pTwoSided;
}

/** Run the canary-vs-control arm over one window. `canary` and `control`
 *  must share the same signal keys and be at least as long as the
 *  largest look-schedule tick. Fires on any (signal, look) pair whose
 *  directional p-value is below the Bonferroni-corrected threshold
 *  `alpha / (signals.length * lookScheduleTicks.length)`. `firingSignals`
 *  accumulates every signal that fired at any look (not just the first);
 *  `firstFireTick` is the earliest look tick with any fire. `fireTicks`
 *  (I1) is every look tick that fired (any signal), ascending and
 *  deduped — `lookScheduleTicks` need not itself be sorted, so this
 *  sorts rather than relying on iteration order. */
export function runCanaryArm(canary: SignalSeries, control: SignalSeries, params: CanaryParams): ArmResult {
  const denom = params.signals.length * params.lookScheduleTicks.length;
  const threshold = denom > 0 ? params.alpha / denom : params.alpha;

  let firstFireTick: number | null = null;
  const firingSignals = new Set<string>();
  const fireTicksSet = new Set<number>();

  for (const t of params.lookScheduleTicks) {
    const w = params.windowTicks;
    if (t < w) continue; // not enough trailing history at this look yet
    for (const signal of params.signals) {
      const canarySlice = (canary[signal] ?? []).slice(t - w, t);
      const controlSlice = (control[signal] ?? []).slice(t - w, t);
      if (canarySlice.length < w || controlSlice.length < w) continue;
      const direction = params.directions[signal] ?? 'both';
      const p = directionalP(canarySlice, controlSlice, direction);
      if (p < threshold) {
        firingSignals.add(signal);
        fireTicksSet.add(t);
        if (firstFireTick === null || t < firstFireTick) firstFireTick = t;
      }
    }
  }

  return {
    armId: 'canary',
    firstFireTick,
    firingSignals: Array.from(firingSignals),
    fireTicks: Array.from(fireTicksSet).sort((a, b) => a - b),
  };
}

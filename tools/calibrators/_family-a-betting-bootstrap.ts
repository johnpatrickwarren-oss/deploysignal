// tools/calibrators/_family-a-betting-bootstrap.ts
//
// Decomposition helpers for `bootstrapBettingSlidingBufferThreshold`
// (tools/calibrators/family-a.ts). Extracted verbatim from contiguous
// blocks of the original ~115-line function so the public function keeps
// its exact name/signature/behavior and delegates. No computation altered.

import { standardNormalLocal } from './_family-a-rng';

/** Per-trajectory betting state. Mirrors freshBettingState exactly.
 *  Extracted verbatim from the original function body. */
export type BettingNullState = {
  M: number; bet: number; n: number;
  runningMean: number; runningSecondMoment: number;
};

/** Bet-selection + boundedZ closures bound to (baselineMean, sigma).
 *  Extracted verbatim (lines 287-313 of the original function). */
export function makeBettingBetSelectors(
  baselineMean: number,
  sigma: number,
): {
  pickBet: (mean: number, second: number, prev: number) => number;
  boundedZ: (xRaw: number) => number;
} {
  // Match runtime constants from engine/detectors/betting-e-process.ts.
  const BOUNDED_SCALE_B = 3;
  const BET_CLIP = 1 - 1e-6;

  const grapaBet = (mean: number, second: number): number => {
    if (!(second > 0)) return 0;
    return mean / second;
  };
  const onsBet = (mean: number, second: number, prev: number): number => {
    const denomInner = 1 + prev * mean;
    if (!(second > 0) || Math.abs(denomInner) < 1e-9) return 0;
    const grad = -mean / denomInner;
    const step = grad / Math.max(second, 1e-6);
    const proposed = prev - step;
    if (proposed > BET_CLIP) return BET_CLIP;
    if (proposed < -BET_CLIP) return -BET_CLIP;
    return proposed;
  };
  const pickBet = (mean: number, second: number, prev: number): number => {
    const g = grapaBet(mean, second);
    if (Math.abs(g) <= BET_CLIP && Number.isFinite(g)) return g;
    return onsBet(mean, second, prev);
  };
  const boundedZ = (xRaw: number): number => {
    const denom = BOUNDED_SCALE_B * sigma;
    if (!(denom > 0)) return 0;
    const v = (xRaw - baselineMean) / denom;
    if (v > 1) return 1;
    if (v < -1) return -1;
    return v;
  };

  return { pickBet, boundedZ };
}

/** Simulate one null-H₀ AR(1) trajectory and return its MAX wealth.
 *  Extracted verbatim from the per-trajectory bootstrap loop body
 *  (lines 318-348 of the original function). */
export function simulateNullMaxWealth(
  rng: () => number,
  baselineMean: number,
  sigma: number,
  rho: number,
  epsScale: number,
  nTicks: number,
  burnIn: number,
  wealthFloor: number,
  pickBet: (mean: number, second: number, prev: number) => number,
  boundedZ: (xRaw: number) => number,
): number {
  // AR(1) generation in standardized z-space:
  //   z_t = ρ·z_{t-1} + √(1−ρ²)·ε_t,  ε_t ~ N(0, 1).
  // Stationary marginal Var(z_t) = 1 in both iid (ρ=0) and AR(1) cases.
  let zPrev = standardNormalLocal(rng);
  for (let i = 0; i < burnIn; i++) {
    zPrev = rho * zPrev + epsScale * standardNormalLocal(rng);
  }
  const state: BettingNullState = {
    M: 1, bet: 0, n: 0, runningMean: 0, runningSecondMoment: 0,
  };
  let trajMax = 1;
  for (let t = 0; t < nTicks; t++) {
    const zRaw = rho * zPrev + epsScale * standardNormalLocal(rng);
    zPrev = zRaw;
    // Map standardized z back to raw observation: x = μ + z · σ.
    const live = baselineMean + zRaw * sigma;
    // updateBettingState mirror: z = boundedZ(live), pick bet, advance.
    const z = boundedZ(live);
    const bet = pickBet(state.runningMean, state.runningSecondMoment, state.bet);
    const factor = 1 + bet * z;
    state.M = Math.max(wealthFloor, state.M * Math.max(0, factor));
    state.bet = bet;
    const n1 = state.n + 1;
    state.runningMean = state.runningMean + (z - state.runningMean) / n1;
    state.runningSecondMoment = state.runningSecondMoment
      + (z * z - state.runningSecondMoment) / n1;
    state.n = n1;
    if (state.M > trajMax) trajMax = state.M;
  }
  return trajMax;
}

/** Mean + std + (1 − α) quantile over per-trajectory MAX wealth.
 *  Extracted verbatim from the final statistics block (lines 351-360
 *  of the original function). */
export function summarizeBootstrapMaxStatistics(
  maxStatistics: number[],
  nBootstraps: number,
  alpha: number,
): { threshold: number; null_max_mean: number; null_max_std: number } {
  // Mean + std + (1 − α) quantile.
  let sum = 0;
  for (const m of maxStatistics) sum += m;
  const mean = sum / nBootstraps;
  let sqSum = 0;
  for (const m of maxStatistics) { const d = m - mean; sqSum += d * d; }
  const std = Math.sqrt(sqSum / nBootstraps);
  maxStatistics.sort((a, b) => a - b);
  const qIdx = Math.min(nBootstraps - 1, Math.floor((1 - alpha) * nBootstraps));
  const threshold = maxStatistics[qIdx];

  return { threshold, null_max_mean: mean, null_max_std: std };
}

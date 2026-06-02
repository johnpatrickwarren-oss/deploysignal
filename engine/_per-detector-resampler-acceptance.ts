// engine/_per-detector-resampler-acceptance.ts — Topic 58 per-detector
// α-budget acceptance + Wilson/Poisson seed-summary logic. Split out
// VERBATIM from the former per-detector-resampler-mode.ts god-file
// (acceptance group). Re-exported through the per-detector-resampler-
// mode facade; import surface unchanged.

import type { DetectorFamily } from './_per-detector-resampler-types';
import { PER_DETECTOR_FAMILIES } from './_per-detector-resampler-tables';

/** Per-detector α-budget acceptance check per Step-4 amendment.
 *  Architect-pick: mean firing count across N seeds ≤ α × healthy_windows
 *  × marginMultiplier (default 1.2). Tighter than the report-card-level
 *  1.5 × α_total because per-detector α is already conservative. */
export function checkPerDetectorAcceptance(
  perDetectorMeans: Partial<Record<DetectorFamily, number>>,
  alphaBudgets: Partial<Record<DetectorFamily, number>>,
  healthyWindows: number,
  marginMultiplier: number = 1.2,
): Record<DetectorFamily, { pass: boolean; mean: number; expected: number; threshold: number }> {
  const out: Partial<Record<DetectorFamily, { pass: boolean; mean: number; expected: number; threshold: number }>> = {};
  for (const family of PER_DETECTOR_FAMILIES) {
    const mean = perDetectorMeans[family] ?? 0;
    const alpha = alphaBudgets[family] ?? 0;
    const expected = alpha * healthyWindows;
    const threshold = expected * marginMultiplier;
    out[family] = {
      pass: alpha === 0 ? true : mean <= threshold,  // non-α detectors auto-pass
      mean,
      expected,
      threshold,
    };
  }
  return out as Record<DetectorFamily, { pass: boolean; mean: number; expected: number; threshold: number }>;
}

/** Wilson-score upper bound for binomial proportion. Used for
 *  per-seed pass-rate confidence interval (architect-pick: ≥ 6/8 seeds
 *  pass under per-seed firing_count ≤ ceil(μ + 1.96 × √μ) Poisson
 *  upper bound). */
export function wilsonUpperBound(successes: number, trials: number, z: number = 1.96): number {
  if (trials === 0) return 1;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = p + (z * z) / (2 * trials);
  const halfWidth = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return (center + halfWidth) / denom;
}

/** Compute per-detector mean firing-count across N seeds + per-seed
 *  pass count (against Poisson upper bound). */
export function summarizePerDetectorAcrossSeeds(
  perSeedFiringCounts: Array<Record<DetectorFamily, number>>,
  alphaBudgets: Partial<Record<DetectorFamily, number>>,
  healthyWindows: number,
): Record<DetectorFamily, {
  per_seed_counts: number[];
  mean: number;
  per_seed_pass_count: number;
  per_seed_pass_rate: number;
  poisson_upper_bound: number;
}> {
  const nSeeds = perSeedFiringCounts.length;
  const out: Partial<Record<DetectorFamily, {
    per_seed_counts: number[];
    mean: number;
    per_seed_pass_count: number;
    per_seed_pass_rate: number;
    poisson_upper_bound: number;
  }>> = {};
  for (const family of PER_DETECTOR_FAMILIES) {
    const counts = perSeedFiringCounts.map((s) => s[family] ?? 0);
    const sum = counts.reduce((a, b) => a + b, 0);
    const mean = nSeeds > 0 ? sum / nSeeds : 0;
    const alpha = alphaBudgets[family] ?? 0;
    const expected = alpha * healthyWindows;
    // Poisson upper bound at 95%: ceil(μ + 1.96 × √μ).
    const poissonUpper = Math.ceil(expected + 1.96 * Math.sqrt(expected));
    const passes = counts.filter((c) => c <= poissonUpper).length;
    out[family] = {
      per_seed_counts: counts,
      mean,
      per_seed_pass_count: passes,
      per_seed_pass_rate: nSeeds > 0 ? passes / nSeeds : 0,
      poisson_upper_bound: poissonUpper,
    };
  }
  return out as Record<DetectorFamily, {
    per_seed_counts: number[];
    mean: number;
    per_seed_pass_count: number;
    per_seed_pass_rate: number;
    poisson_upper_bound: number;
  }>;
}

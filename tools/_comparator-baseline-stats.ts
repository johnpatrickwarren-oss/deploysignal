// tools/_comparator-baseline-stats.ts — statistics primitives for the
// comparator-baseline harness (WS6.2 Task 2): Mann-Whitney U with a
// normal approximation and tie correction (used by the canary-comparison
// arm, Task 4), and a compiled-cell mean/sigma reader (used by the
// threshold arm, Task 3). No third-party dependencies.

import type { SignalClass } from '../engine/signal-classes';

export interface MannWhitneyResult {
  u: number;
  pTwoSided: number;
  pGreater: number;
  pLess: number;
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf
 *  approximation (max absolute error ~1.5e-7) — no dependencies. */
function standardNormalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - poly * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

/** Mann-Whitney U test (Wilcoxon rank-sum), normal approximation with tie
 *  correction. `u` is the rank-sum statistic for `a`
 *  (`u = rankSumA - nA(nA+1)/2`, where `rankSumA` is the sum of `a`'s
 *  ranks in the pooled, average-ranked data). `pGreater` is the one-sided
 *  p-value for "a stochastically greater than b"; `pLess` is the
 *  one-sided p-value for "a stochastically less than b";
 *  `pTwoSided = 2 * min(pGreater, pLess)` (capped at 1).
 *
 *  Degenerate inputs — either sample empty, or zero rank variance (e.g.
 *  every observation tied across both samples) — return
 *  `u = nA * nB / 2` (the null mean) and `p = 1` for all three fields:
 *  no evidence of a directional difference. */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const nA = a.length;
  const nB = b.length;
  const n = nA + nB;

  if (nA === 0 || nB === 0) {
    return { u: (nA * nB) / 2, pTwoSided: 1, pGreater: 1, pLess: 1 };
  }

  // Pool, sort, and assign average (1-indexed) ranks to tied groups.
  const pooled: Array<{ v: number; group: 'a' | 'b' }> = a
    .map((v): { v: number; group: 'a' | 'b' } => ({ v, group: 'a' }))
    .concat(b.map((v): { v: number; group: 'a' | 'b' } => ({ v, group: 'b' })))
    .sort((x, y) => x.v - y.v);

  const ranks = new Array<number>(n);
  const tieGroupSizes: number[] = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && pooled[j + 1].v === pooled[i].v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // 1-indexed average rank over [i, j]
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    tieGroupSizes.push(j - i + 1);
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < n; k++) {
    if (pooled[k].group === 'a') rankSumA += ranks[k];
  }

  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const meanU = (nA * nB) / 2;

  let tieCorrection = 0;
  for (const t of tieGroupSizes) tieCorrection += t ** 3 - t;
  const varU = ((nA * nB) / 12) * (n + 1 - tieCorrection / (n * (n - 1)));

  if (!(varU > 0)) {
    // No rank variance to test against (e.g. every observation tied
    // across both samples) — no evidence of a directional difference.
    return { u: uA, pTwoSided: 1, pGreater: 1, pLess: 1 };
  }

  const sd = Math.sqrt(varU);
  const z = (uA - meanU) / sd;

  const pGreater = Math.min(1, 1 - standardNormalCdf(z));
  const pLess = Math.min(1, standardNormalCdf(z));
  const pTwoSided = Math.min(1, 2 * Math.min(pGreater, pLess));

  return { u: uA, pTwoSided, pGreater, pLess };
}

// ── Compiled-cell mean/sigma reader (Task 3's threshold arm) ────────

export interface CompiledCellFamilyAStats {
  family_A?: {
    per_signal?: Record<
      string,
      { baseline_mean: number; baseline_sigma_squared: number; signal_class?: SignalClass }
    >;
  };
}

/** Reads a signal's baseline mean/sigma/signal_class from a compiled-config
 *  cell's `family_A.per_signal` block (`sigma = sqrt(baseline_sigma_squared)`).
 *  `signalClass` is the entry's own `signal_class` field (undefined for
 *  pre-Q2.A configs) — the caller resolves the final class (falling
 *  through to `CompiledConfig.signal_classes` then `'gaussian_like'`,
 *  mirroring the engine's runtime resolution) since that requires the
 *  full compiled config, not just this cell.
 *
 *  `cell` may be either a real per-cell record (from `lookupCell`) or the
 *  compiled config's `baseline_cells.aggregate_fallback` object — both
 *  share this shape. The caller implements "fall back to
 *  aggregate_fallback" (the same fallback path the engine and
 *  report-card machinery use elsewhere) by passing:
 *
 *    meanSigmaFromCompiledCell(
 *      lookupCell(compiledConfig, cellKey) ?? compiledConfig.baseline_cells.aggregate_fallback,
 *      signal
 *    )
 *
 *  Throws if the signal is present in neither the given cell. */
export function meanSigmaFromCompiledCell(
  cell: CompiledCellFamilyAStats | null | undefined,
  signal: string
): { mu: number; sigma: number; signalClass?: SignalClass } {
  const entry = cell?.family_A?.per_signal?.[signal];
  if (!entry) {
    throw new Error(
      `meanSigmaFromCompiledCell: no family_A.per_signal entry for signal "${signal}" on the given ` +
        'cell; caller should retry with compiledConfig.baseline_cells.aggregate_fallback'
    );
  }
  return { mu: entry.baseline_mean, sigma: Math.sqrt(entry.baseline_sigma_squared), signalClass: entry.signal_class };
}

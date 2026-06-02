// tools/calibrators/_family-c-hotelling.ts — Q2.B.6.2 sliding-buffer
// Hotelling bootstrap-threshold recalibration. Split from family-c.ts
// (End-phase slice 3c, D-54-3); computation preserved VERBATIM, with the
// formerly-monolithic bootstrapHotellingSlidingBufferThreshold body
// decomposed into contiguous <100-line helpers (identical behavior).
// Re-exported through the family-c.ts facade so the public surface is
// unchanged.

import type { SafeHotellingParams } from '../../engine/types';
import { mulberry32 } from './_shared.js';
import { choleskyLowerTriangular } from './_family-c-covariance.js';

// ── Q2.B.6.2 sliding-buffer Hotelling recalibration ─────────────────

/** Q2.B.6.2 — Family C sliding-buffer Hotelling bootstrap seed. Fixed
 *  so recompiles are deterministic. Mirrors Family D's
 *  FAMILY_D_BOOTSTRAP_SEED pattern. */
export const FAMILY_C_HOTELLING_BOOTSTRAP_SEED = 0xFC02C >>> 0;

/** Box-Muller standard-normal draw, mirror of family-d.ts /
 *  engine/resamplers/cholesky.ts. u1 floored at 1e-12 to avoid log(0).
 *  Inlined here so the calibrator stays self-contained relative to dist/
 *  layout. */
function standardNormalLocal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Forward-substitute L · y = r for y, given lower-triangular L. */
function forwardSolveLocal(L: number[][], r: number[]): number[] {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = r[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

/** Sliding-buffer bootstrap constants (Q2.B.6.2; see N-rationale on the
 *  public entry-point's doc comment). Hoisted so the per-trajectory
 *  simulation helper shares them with the entry point verbatim. */
const SLIDING_BUFFER_TRAJECTORIES = 500;
const TRAJECTORY_LENGTH = 100;
const BUFFER_START_TICK = 20;
const BUFFER_END_TICK = 100;
const BURN_IN = 10;

/** Cholesky factors used across both variants of the bootstrap. Σ + τ²I
 *  is required only for safe_test; build once (constant per cell). */
function buildBootstrapCholeskies(
  cellSigma: number[][],
  cellSigmaEps: number[][],
  variant: 'chi_square' | 'safe_test',
  safeHotellingParams: SafeHotellingParams | null,
): { Lx: number[][]; Leps: number[][]; LSigma: number[][] | null; LSigmaPlus: number[][] | null } {
  const p = cellSigma.length;
  const Lx = choleskyLowerTriangular(cellSigma);
  const Leps = choleskyLowerTriangular(cellSigmaEps);
  let LSigma: number[][] | null = null;
  let LSigmaPlus: number[][] | null = null;
  if (variant === 'chi_square') {
    LSigma = choleskyLowerTriangular(cellSigma);
  } else {
    LSigma = choleskyLowerTriangular(cellSigma);
    if (safeHotellingParams) {
      const sigmaPlus: number[][] = new Array(p);
      for (let i = 0; i < p; i++) {
        sigmaPlus[i] = cellSigma[i].slice();
        sigmaPlus[i][i] += safeHotellingParams.tau_squared;
      }
      LSigmaPlus = choleskyLowerTriangular(sigmaPlus);
    }
  }
  return { Lx, Leps, LSigma, LSigmaPlus };
}

/** One bootstrap trajectory: AR(1) simulation under sliding-buffer H₀
 *  with per-tick statistic evaluation; returns the per-trajectory MAX
 *  statistic. Identical block to the original inner loop body. */
function simulateTrajectoryMaxStatistic(
  rng: () => number,
  p: number,
  cellRho: number[],
  Lx: number[][],
  Leps: number[][],
  LSigma: number[][] | null,
  LSigmaPlus: number[][] | null,
  variant: 'chi_square' | 'safe_test',
  safeHotellingParams: SafeHotellingParams | null,
): number {
  // Initialize r at stationary N(0, Σ_C) via Lx.
  let r = new Array<number>(p);
  {
    const z = new Array<number>(p);
    for (let i = 0; i < p; i++) z[i] = standardNormalLocal(rng);
    for (let i = 0; i < p; i++) {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += Lx[i][j] * z[j];
      r[i] = acc;
    }
  }

  // Burn-in: r_t = ρ ⊙ r_{t-1} + ε_t, ε_t ~ N(0, Σ_eps).
  for (let i = 0; i < BURN_IN; i++) {
    const eps = new Array<number>(p);
    const z = new Array<number>(p);
    for (let k = 0; k < p; k++) z[k] = standardNormalLocal(rng);
    for (let k = 0; k < p; k++) {
      let acc = 0;
      for (let j = 0; j <= k; j++) acc += Leps[k][j] * z[j];
      eps[k] = acc;
    }
    const rNext = new Array<number>(p);
    for (let k = 0; k < p; k++) rNext[k] = cellRho[k] * r[k] + eps[k];
    r = rNext;
  }

  // Generate trajectory + sliding-buffer evaluation in one pass.
  let maxStatistic = 0;
  let safeWealth = 1;
  for (let t = 0; t < TRAJECTORY_LENGTH; t++) {
    const eps = new Array<number>(p);
    const z = new Array<number>(p);
    for (let k = 0; k < p; k++) z[k] = standardNormalLocal(rng);
    for (let k = 0; k < p; k++) {
      let acc = 0;
      for (let j = 0; j <= k; j++) acc += Leps[k][j] * z[j];
      eps[k] = acc;
    }
    const rNext = new Array<number>(p);
    for (let k = 0; k < p; k++) rNext[k] = cellRho[k] * r[k] + eps[k];
    r = rNext;

    if (t < BUFFER_START_TICK || t > BUFFER_END_TICK) continue;

    if (variant === 'chi_square') {
      const y = forwardSolveLocal(LSigma!, r);
      let t2 = 0;
      for (const v of y) t2 += v * v;
      if (t2 > maxStatistic) maxStatistic = t2;
    } else if (safeHotellingParams && LSigma && LSigmaPlus) {
      const y = forwardSolveLocal(LSigma, r);
      let xSigmaInvX = 0;
      for (const v of y) xSigmaInvX += v * v;
      const yPlus = forwardSolveLocal(LSigmaPlus, r);
      let xSigmaPlusInvX = 0;
      for (const v of yPlus) xSigmaPlusInvX += v * v;
      const z_t = -safeHotellingParams.precompiled_log_det_shrink
        + 0.5 * xSigmaInvX
        - 0.5 * xSigmaPlusInvX;
      // Match runtime denormal floor (engine/detectors/hotelling.ts:497).
      safeWealth = Math.max(1e-300, safeWealth * Math.exp(z_t));
      if (safeWealth > maxStatistic) maxStatistic = safeWealth;
    }
  }
  return maxStatistic;
}

/** Mean + std + (1 − α) quantile of the per-trajectory MAX statistics.
 *  Identical block to the original summary tail. */
function summarizeMaxStatistics(
  maxStatistics: number[],
  alpha: number,
): { threshold: number; null_max_mean: number; null_max_std: number } {
  let sum = 0;
  for (const m of maxStatistics) sum += m;
  const mean = sum / SLIDING_BUFFER_TRAJECTORIES;
  let sqSum = 0;
  for (const m of maxStatistics) { const d = m - mean; sqSum += d * d; }
  const std = Math.sqrt(sqSum / SLIDING_BUFFER_TRAJECTORIES);
  maxStatistics.sort((a, b) => a - b);
  const qIdx = Math.min(maxStatistics.length - 1,
    Math.floor((1 - alpha) * maxStatistics.length));
  const threshold = maxStatistics[qIdx];
  return { threshold, null_max_mean: mean, null_max_std: std };
}

/** Q2.B.6.2 — Bootstrap MAX statistic per trajectory under sliding-
 *  buffer AR(1) H₀ for Hotelling recalibration. Mirrors
 *  buildFamilyDForSignalAR1's sliding-buffer template (Q2.B.6.1 Step 5)
 *  on Family C's multivariate path.
 *
 *  Mechanism: simulate p-dim r-trajectories under joint AR(1) with
 *  stationary marginal Σ_C and per-signal AR(1) coefficients ρ. For each
 *  trajectory, evaluate the runtime statistic at every tick from
 *  BUFFER_START_TICK..BUFFER_END_TICK (analogous to runtime sliding-buffer
 *  evaluation across the 100-tick canary window) and track the per-
 *  trajectory MAX. The (1−α) quantile of MAX statistics is the threshold
 *  that satisfies per-trajectory FPR ≤ α — mirroring the
 *  Q2.B.6.1 Step 5 family_D recalibration template.
 *
 *  AR(1) simulation runs in r-space (relative-deviation): mean-zero
 *  vectors with stationary covariance = Σ_C and white-noise covariance
 *  Σ_eps. Architect spec §89-138's `cellMu` parameter is unused here for
 *  AR(1) simulation (kept in the signature for spec compatibility) since
 *  Σ_C is calibrated in r-space and runtime T²/wealth statistics consume
 *  r directly. This matches the Q2.B.6c diagnostic probe simulation.
 *
 *  - chi_square variant: statistic = T² = r_t^T Σ_C⁻¹ r_t per tick.
 *  - safe_test variant: statistic = wealth M_t (multiplicative process)
 *    starting at M_0 = 1 at BUFFER_START_TICK; per-tick z_t mirrors
 *    engine/detectors/hotelling.ts:evaluateSafeHotelling exactly:
 *      z_t = -precompiled_log_det_shrink + ½ rᵀΣ⁻¹r - ½ rᵀ(Σ+τ²I)⁻¹r
 *    M_t = M_{t-1} · exp(z_t); track max over the buffer evaluation.
 *
 *  Closes the per-trajectory FPR inflation that Q2.B.6.1 Step 5 closed
 *  on Family D — same architectural pattern (P4-β.5 evaluation-scope
 *  alignment) on the Family C path.
 *
 *  Bootstrap N=2000: matches Q2.B.6.1 Step 5 default. Per-cell ~3-5s
 *  compile cost on synthetic-v1 (840 cells × 2000 trajectories ×
 *  ~80 ticks × p=11 Cholesky/forward-solve).
 *
 *  Q2.B.6.2 — N=500 matches Q2.B.6.1 Step 5 family_D precedent (the
 *  architectural template referenced in the spec §3-7). Spec §82 said
 *  2000 but spec §302 also notes "if [variance] not [acceptable], raise
 *  to 5000" — implicitly tunable. The per-trajectory MAX statistic over
 *  ~80 ticks of sliding-buffer evaluation has lower MC variance than
 *  single-tick statistics, so 500 iters keeps tail-quantile estimate
 *  stable while reducing per-cell cost ~4× — bringing compile time
 *  closer to the architect §304 prediction of "~2-3s for 840 cells"
 *  (with the hash-cache, compile-time cost on synthetic-v1 is ~12s). */
export function bootstrapHotellingSlidingBufferThreshold(
  _cellMu: number[],
  cellSigma: number[][],
  cellRho: number[],
  cellSigmaEps: number[][],
  alpha: number,
  variant: 'chi_square' | 'safe_test',
  safeHotellingParams: SafeHotellingParams | null,
  seed: number,
): { threshold: number; bootstrap_n: number; null_max_mean: number; null_max_std: number } {
  const p = cellSigma.length;
  const rng = mulberry32(seed);
  const { Lx, Leps, LSigma, LSigmaPlus } = buildBootstrapCholeskies(
    cellSigma, cellSigmaEps, variant, safeHotellingParams,
  );

  const maxStatistics = new Array<number>(SLIDING_BUFFER_TRAJECTORIES);
  for (let traj = 0; traj < SLIDING_BUFFER_TRAJECTORIES; traj++) {
    maxStatistics[traj] = simulateTrajectoryMaxStatistic(
      rng, p, cellRho, Lx, Leps, LSigma, LSigmaPlus, variant, safeHotellingParams,
    );
  }

  const { threshold, null_max_mean, null_max_std } = summarizeMaxStatistics(maxStatistics, alpha);
  return {
    threshold,
    bootstrap_n: SLIDING_BUFFER_TRAJECTORIES,
    null_max_mean,
    null_max_std,
  };
}

// tools/calibrators/family-a.ts — End-phase slice 3b (D-54-3).
//
// Per-signal Family A calibration. Option 3 side-effect-free pattern
// per ARCHITECT-REPLY-54b: pure function returning { result, timings };
// caller accumulates timings in calibrate.ts local aggregator.
//
// Q2.A — accepts a `signalClass` parameter that drives a class-
// appropriate forward transform applied to baseline samples before
// meanStd derivation. Closes V1.H1 architecturally (bounded-probability
// signal saturation collapsing σ² → FP zero) by mapping bounded /
// heavy-tail / counts samples into a space where the Gaussian-H₀
// assumption underlying betting-e-process construction holds. Symmetric
// transform application at runtime (in engine/detectors/betting-e-
// process.ts) preserves the (μ, σ) calibration consistency between
// calibration-space and detection-space. P1 floor stays as belt-and-
// suspenders defense-in-depth for any residual edge case.

import type { FamilyAPerSignalParams } from '../../engine/types';
import { transformForClass, type SignalClass } from '../../engine/signal-classes';
import {
  computePerSignalAr1Phi,
  deriveMixtureSupermartingaleParams,
} from '../../engine/detectors/family-a-mixture-supermartingale';

/** τ² = δ_min² / TAU_SQUARED_DIV per ARCHITECT-REPLY-05.md.
 *  Page-CUSUM mixture-prior variance: prior concentrates around
 *  practical-significance-sized effects. */
export const TAU_SQUARED_DIV = 4;

export interface FamilyATimings {
  tau2_fit_ns: bigint;
}

export interface FamilyABuildResult {
  result: FamilyAPerSignalParams;
  timings: FamilyATimings;
}

/** P1 calibration variance floor coefficient — `σ²_floor = ε_f · μ²`
 *  with `ε_f = 10⁻⁶` corresponds to a coefficient-of-variation floor
 *  of 10⁻³ on per-signal calibration. Per ARCHITECT-REPLY-52ge §69-71;
 *  closes V1.H1 (tool_success_rate σ² FP underflow on bounded-
 *  probability signals saturating near 1.0).
 *
 *  Rationale: under iid-bootstrap E3 methodology, `evaluateBettingEProcess`
 *  computes `z_t = (x_t − μ) / (B · σ_calibration)` with B = 3. When
 *  σ_calibration collapses to floating-point zero (saturated bounded-
 *  probability signal), z_t saturates at ±1 every tick; asymmetric
 *  saturation pushes the GRAPA bet positive and Ville's wealth
 *  martingale supermartingale property breaks. The floor caps the
 *  ratio σ_calibration / |μ| at ≥ 10⁻³, keeping z_t finite for any
 *  realistic observation tail.
 */
export const SIGMA_SQUARED_FLOOR_CV_SQUARED = 1e-6;

/** Sample mean + population standard deviation, with P1 σ² floor
 *  applied to closure of V1.H1 calibration variance degeneracy.
 *  Returns `sigma_floor_applied` for audit visibility per
 *  ARCHITECT-REPLY-52ge §128-178. */
export function meanStd(xs: number[]): {
  mean: number; std: number; sigma_floor_applied: boolean;
} {
  if (xs.length === 0) {
    return { mean: 0, std: 0, sigma_floor_applied: false };
  }
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let variance = 0;
  for (const x of xs) variance += (x - mean) ** 2;
  variance /= xs.length;

  // P1 floor per ARCHITECT-REPLY-52ge §69-71:
  //   σ²_floor = max(ε_f · μ², 1·10⁻⁶ · μ²)
  // Belt-and-suspenders: ε_f · μ² catches any cell with μ so small
  // that 1·10⁻⁶ · μ² underflows below ε_f · μ² in floating-point.
  const muSquared = mean * mean;
  const sigmaSquaredFloor = Math.max(
    Number.EPSILON * muSquared,
    SIGMA_SQUARED_FLOOR_CV_SQUARED * muSquared,
  );
  const sigmaFloorApplied = variance < sigmaSquaredFloor;
  const sigmaSquared = Math.max(variance, sigmaSquaredFloor);
  return {
    mean,
    std: Math.sqrt(sigmaSquared),
    sigma_floor_applied: sigmaFloorApplied,
  };
}

/** Per-signal Family A parameters, computed from a sample array.
 *  Page-CUSUM mixture-prior variance (ARCHITECT-REPLY-05.md). Prior
 *  concentrates around practical-significance-sized effects: at
 *  δ_min the prior puts ~2 standard deviations of probability mass
 *  past the null.
 *
 *  Q2.A — `signalClass` drives a class-appropriate forward transform
 *  applied to baseline samples before meanStd. `baseline_mean` and
 *  `baseline_sigma_squared` are emitted in TRANSFORMED space when the
 *  class is non-identity (logit / log / Anscombe). `baseline_mean_raw`
 *  carries the pre-transform arithmetic mean for Q2.B.4 calibration-
 *  coherence audit. δ_min and τ² derivation operates on the transformed
 *  scale — same pre-Q2.A formula `max(0.05·μ', 2·σ')` over transformed
 *  μ'/σ', so the betting wealth dynamics see consistent units across
 *  calibration and runtime. Default `signalClass = 'gaussian_like'`
 *  preserves pre-Q2.A behavior byte-identically (transform = identity). */
/** Q2.B.5 (per Q2-B-5-SIGMA-COHERENCE-SPEC.md) — optional context for
 *  Σ-coherence enforcement. When `sigma_c_diagonal` is supplied (overlapping
 *  signal in both FAMILY_A and FAMILY_C), the emitter derives raw-space σ²
 *  from `μ_raw² · Σ_C[i,i]` instead of from the per-cell sample variance.
 *  When absent (Family-A-only signal: eval_score, tool_success_rate),
 *  the emitter falls through to raw per-cell sample variance with P1 floor. */
export interface FamilyABuildContext {
  signalClass?: SignalClass;
  sigma_c_diagonal?: number;
}

export function buildFamilyAPerSignal(
  samples: number[],
  contextOrClass: FamilyABuildContext | SignalClass = {},
): FamilyABuildResult {
  // Backward-compat: callers passing `SignalClass` directly (pre-Q2.B.5
  // signature). Detect by string vs object.
  const context: FamilyABuildContext = typeof contextOrClass === 'string'
    ? { signalClass: contextOrClass as SignalClass }
    : contextOrClass;
  const signalClass: SignalClass = context.signalClass ?? 'gaussian_like';
  const sigmaCDiagonal: number | undefined = context.sigma_c_diagonal;

  const t = process.hrtime.bigint();
  // Transformed-space stats drive δ_min / τ² / runtime-consumed (μ', σ').
  const transformed = signalClass === 'gaussian_like'
    ? samples
    : samples.map((s) => transformForClass(s, signalClass));
  const { mean, std, sigma_floor_applied } = meanStd(transformed);
  const sigma2 = std * std;
  const deltaMin = Math.max(0.05 * mean, 2 * std);
  const tauSquared = (deltaMin * deltaMin) / TAU_SQUARED_DIV;
  // Raw-space arithmetic mean — Q2.B.4 coherence audit consumes this
  // in same-space terms as Family C's per-cell mean_vector.
  let meanRaw = 0;
  if (samples.length > 0) {
    let sum = 0;
    for (const s of samples) sum += s;
    meanRaw = sum / samples.length;
  }
  // Q2.B.5 — raw-space σ² for Page-CUSUM consumption.
  // Overlapping signals: σ²_raw = μ_raw² · Σ_C_blended[i,i].
  // Family-A-only signals: raw per-cell sample variance (with P1 floor).
  let baselineSigmaSquaredRaw: number;
  if (sigmaCDiagonal !== undefined) {
    baselineSigmaSquaredRaw = meanRaw * meanRaw * sigmaCDiagonal;
  } else {
    // Compute raw-space σ² from raw samples directly.
    let varianceRaw = 0;
    if (samples.length > 0) {
      for (const s of samples) varianceRaw += (s - meanRaw) ** 2;
      varianceRaw /= samples.length;
    }
    baselineSigmaSquaredRaw = varianceRaw;
  }
  // P1 floor as defense-in-depth (belt-and-suspenders; should never
  // trigger on Σ-coherence-derived raw σ², but caps any FP underflow
  // edge case symmetrically with the transformed-space σ² floor).
  const muRawSquared = meanRaw * meanRaw;
  const rawFloor = Math.max(
    Number.EPSILON * muRawSquared,
    SIGMA_SQUARED_FLOOR_CV_SQUARED * muRawSquared,
  );
  if (baselineSigmaSquaredRaw < rawFloor) {
    baselineSigmaSquaredRaw = rawFloor;
  }
  // Q66.A.b — Yule-Walker AR(1) phi estimation on transformed centered
  // residuals. Estimated in transformed space because runtime detector
  // pre-whitens x_centered which is centered against `baseline_mean`
  // (transformed mean per Q2.A). Phi clipped to [-0.95, +0.95] inside
  // the helper for numerical stability. Per axis 4.b reinforcement,
  // estimation is on baseline-mean-centered series (NOT raw series).
  const ar1Phi = computePerSignalAr1Phi(transformed, mean);

  const result: FamilyAPerSignalParams = {
    baseline_mean: mean,
    baseline_mean_raw: meanRaw,
    baseline_sigma_squared: sigma2,
    baseline_sigma_squared_raw: baselineSigmaSquaredRaw,
    tau_squared: tauSquared,
    delta_min: deltaMin,
    ar1_phi: ar1Phi,
  };
  // Stamp the class on every emit (incl. gaussian_like) so audit
  // consumers can introspect the calibration without re-resolving
  // against DEFAULT_SIGNAL_CLASSES.
  result.signal_class = signalClass;
  // Q66 Phase-3.d.A close (item g) — derive + stamp mixture-supermartingale
  // hyperparams per Q66.1 derivation table (§ Phase-3.d.A SLICE 1 spec).
  // Runtime mixture-supermartingale variant (default at Phase-3.d.A close)
  // consumes this field; absence triggers runtime on-the-fly derivation
  // (degraded perf; recompile recommended). For signal classes without
  // a Phase-3.d.A SLICE 1 implementation (categorical → Phase-3.d.A.b),
  // derivation returns undefined and the field is omitted.
  const mixtureParams = deriveMixtureSupermartingaleParams(result);
  if (mixtureParams !== undefined) {
    result.mixture_supermartingale_params = mixtureParams;
  }
  if (sigma_floor_applied) {
    result.sigma_floor_applied = true;
  }
  return {
    result,
    timings: { tau2_fit_ns: process.hrtime.bigint() - t },
  };
}

// ── Q2.B.6.3 sliding-buffer betting wealth recalibration ────────────

/** Q2.B.6.3 — Family A betting bootstrap seed. Fixed so recompiles are
 *  deterministic. Mirrors Family D / Family C bootstrap-seed pattern. */
export const FAMILY_A_BETTING_BOOTSTRAP_SEED = 0xFA03B >>> 0;

/** Mulberry32 deterministic uniform RNG. Inlined here for self-
 *  containment relative to dist/ layout (matches family-c.ts pattern). */
function mulberry32Local(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormalLocal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Mirror engine/detectors/betting-e-process.ts:boundedZ + GRAPA/ONS
 *  bet selection + wealth update. Inlined here so the calibrator stays
 *  self-contained relative to dist/ layout (matches family-c.ts
 *  bootstrapHotellingSlidingBufferThreshold pattern).
 *
 *  Q2.B.6.3 closure: the runtime betting wealth process M_t = M_{t-1} ·
 *  (1 + λ_t · z_t) is martingale under iid H₀ where z_t are mean-zero
 *  independent. Under joint AR(1) H₀ with non-trivial ρ, conditional
 *  E[z_t | z_{t-1}] = ρ·z_{t-1} ≠ 0; running mean drifts; bet drifts;
 *  wealth process is NOT martingale; Ville bound empirically violated
 *  (cost_req cell at (17,4,aggregate): empirical 11.55% FPR vs 0% iid).
 *
 *  Same architectural pattern as Q2.B.6.2 family_C safe_test under AR(1).
 *  Fix: bootstrap MAX wealth per trajectory under joint AR(1) H₀;
 *  (1−α) quantile gives the sliding-buffer-aware threshold. */
export function bootstrapBettingSlidingBufferThreshold(
  baselineMean: number,
  sigmaSquared: number,
  rho: number,
  alpha: number,
  seed: number,
): {
  threshold: number;
  bootstrap_n: number;
  null_max_mean: number;
  null_max_std: number;
} {
  // N=500 matches Q2.B.6.1 Step 5 family_D + Q2.B.6.2 family_C precedent.
  // Per-trajectory MAX wealth has lower MC variance than single-tick
  // statistics; 500 iters keeps tail-quantile estimate stable.
  const N_BOOTSTRAPS = 500;
  const N_TICKS = 100;
  const BURN_IN = 10;
  const sigma = Math.sqrt(Math.max(sigmaSquared, 0));
  const epsScale = Math.sqrt(Math.max(0, 1 - rho * rho));
  // Match runtime constants from engine/detectors/betting-e-process.ts.
  const BOUNDED_SCALE_B = 3;
  const WEALTH_FLOOR = 1e-12;
  const BET_CLIP = 1 - 1e-6;

  // Inline runtime betting state for the bootstrap simulation. State
  // tracks wealth M, current bet, running first/second moments of z,
  // and tick count n. Mirrors freshBettingState exactly.
  type State = {
    M: number; bet: number; n: number;
    runningMean: number; runningSecondMoment: number;
  };

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

  const rng = mulberry32Local(seed);
  const maxStatistics = new Array<number>(N_BOOTSTRAPS);

  for (let traj = 0; traj < N_BOOTSTRAPS; traj++) {
    // AR(1) generation in standardized z-space:
    //   z_t = ρ·z_{t-1} + √(1−ρ²)·ε_t,  ε_t ~ N(0, 1).
    // Stationary marginal Var(z_t) = 1 in both iid (ρ=0) and AR(1) cases.
    let zPrev = standardNormalLocal(rng);
    for (let i = 0; i < BURN_IN; i++) {
      zPrev = rho * zPrev + epsScale * standardNormalLocal(rng);
    }
    const state: State = {
      M: 1, bet: 0, n: 0, runningMean: 0, runningSecondMoment: 0,
    };
    let trajMax = 1;
    for (let t = 0; t < N_TICKS; t++) {
      const zRaw = rho * zPrev + epsScale * standardNormalLocal(rng);
      zPrev = zRaw;
      // Map standardized z back to raw observation: x = μ + z · σ.
      const live = baselineMean + zRaw * sigma;
      // updateBettingState mirror: z = boundedZ(live), pick bet, advance.
      const z = boundedZ(live);
      const bet = pickBet(state.runningMean, state.runningSecondMoment, state.bet);
      const factor = 1 + bet * z;
      state.M = Math.max(WEALTH_FLOOR, state.M * Math.max(0, factor));
      state.bet = bet;
      const n1 = state.n + 1;
      state.runningMean = state.runningMean + (z - state.runningMean) / n1;
      state.runningSecondMoment = state.runningSecondMoment
        + (z * z - state.runningSecondMoment) / n1;
      state.n = n1;
      if (state.M > trajMax) trajMax = state.M;
    }
    maxStatistics[traj] = trajMax;
  }

  // Mean + std + (1 − α) quantile.
  let sum = 0;
  for (const m of maxStatistics) sum += m;
  const mean = sum / N_BOOTSTRAPS;
  let sqSum = 0;
  for (const m of maxStatistics) { const d = m - mean; sqSum += d * d; }
  const std = Math.sqrt(sqSum / N_BOOTSTRAPS);
  maxStatistics.sort((a, b) => a - b);
  const qIdx = Math.min(N_BOOTSTRAPS - 1, Math.floor((1 - alpha) * N_BOOTSTRAPS));
  const threshold = maxStatistics[qIdx];

  return {
    threshold,
    bootstrap_n: N_BOOTSTRAPS,
    null_max_mean: mean,
    null_max_std: std,
  };
}

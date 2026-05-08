// engine/detectors/betting-e-process.ts — Family A co-ship detector:
// betting-based e-processes with GRAPA + ONS fallback.
//
// Per ARCHITECT-REPLY-34.md (Addition #17, 2026-04-20). Family A now runs
// two independent anytime-valid tests per signal under a 50/50 α-split of
// the per-signal Bonferroni-corrected budget:
//
//   Page-CUSUM (engine/detectors/page-cusum.ts)
//     Mixture-prior log-likelihood S_n. Optimal for abrupt unknown-onset
//     mean shifts. Fires at S_n ≥ −log(α).
//
//   Betting e-processes (this file)
//     Wealth martingale M_t under H₀ via λ_t · z_t bet. Optimal for
//     gradual drift and non-Gaussian residual regimes. Fires at
//     M_t ≥ 1/α. Ville's inequality ⇒ anytime-valid time-uniform α
//     control, same FP-control philosophy as Page-CUSUM.
//
// Bet scheme: GRAPA (Generalized Reverse-Adaptive Predictable Adaptation)
// per Waudby-Smith & Ramdas 2024, with ONS (Online Newton Step) fallback
// when GRAPA's bet leaves the unit ball. No operator-exposed tunable;
// bet is derived from running moments of the standardized z_t.
//
// Bounded-support convention: z_t = clip((x − μ) / (B·σ), −1, 1) with
// B = 3. Under H₀, the un-clipped scaled deviation concentrates inside
// [−1, 1] so saturation is rare on healthy traffic; under drift, z_t
// saturates at ±1 giving a conservative wealth accumulation rate.
// Hard-clipping preserves the bounded-z_t precondition needed for
// (1 + λ·z) ≥ 0 throughout the wealth update.

import type {
  MSPRTParams, CompiledConfig, DetectorVerdict, BaselineCell,
  BaselineCellEntry, FamilyAPerSignalParams, BakeProfile,
  SchemaContinuityRecord, BettingEProcessState, TenantTier,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import { FAMILY_A_PRIMARY_SIGNALS, trafficGateMin } from './page-cusum';
// Q2.A — class-appropriate forward transform on live observation
// before mean-centering. Runtime resolution honors only what the
// compiled config declares (perSig.signal_class → cfg.signal_classes
// → 'gaussian_like'); transformForClass returns identity for the
// gaussian_like default so pre-Q2.A configs retain byte-identical
// runtime behavior. DEFAULT_SIGNAL_CLASSES is compile-time only.
import { transformForClass } from '../signal-classes';

const DEFAULT_BAKE: BakeProfile = {
  min_ticks_before_eligible: 3,
  min_observation_window: 3,
  max_deploy_window_days: 1,
};

/** Bounded-support scaling factor; z_t = (x − μ) / (B·σ) clipped to
 *  [−1, 1]. B = 3 covers ≈ 99.7% of Gaussian mass under H₀ without
 *  saturation. */
const BOUNDED_SCALE_B = 3;

/** Wealth floor — prevents numerical underflow on long no-drift runs
 *  where (1 + λ·z) stays under 1 for many consecutive ticks. */
const WEALTH_FLOOR = 1e-12;

/** GRAPA/ONS bet clip bound. Keeps (1 + λ·z) strictly positive when
 *  both factors hit their ±1 extremes. A tighter-than-1 clip gives a
 *  safety margin against numerical edge cases at the unit-ball boundary. */
const BET_CLIP = 1 - 1e-6;

export function freshBettingState(): BettingEProcessState {
  return {
    M: 1,
    bet: 0,
    n: 0,
    alphaConsumed: 0,
    runningMean: 0,
    runningSecondMoment: 0,
    onsFallbackCount: 0,
  };
}

/** Per-deploy per-signal state store mirror of CUSUMStates. */
export type BettingStates = Record<string, BettingEProcessState>;

export function getOrCreateBetting(states: BettingStates, signal: string): BettingEProcessState {
  const s = states[signal];
  if (s) return s;
  const fresh = freshBettingState();
  states[signal] = fresh;
  return fresh;
}

/** GRAPA bet — closed-form predictive λ derived from the running first
 *  and second moments of the standardized z_t sequence. Returns a bet in
 *  the open unit ball; caller falls back to ONS when the raw GRAPA value
 *  exceeds BET_CLIP in magnitude. */
export function grapaBet(runningMean: number, runningSecondMoment: number, _prevBet: number): number {
  // var_z = E[z²] − E[z]²; GRAPA targets λ = E[z] / (var_z + E[z]²)
  //                                       = E[z] / E[z²]  (algebra)
  // Handles zero-initial state by returning 0 when the denominator is
  // not strictly positive.
  if (!(runningSecondMoment > 0)) return 0;
  const raw = runningMean / runningSecondMoment;
  return raw;
}

/** ONS (Online Newton Step) fallback bet — used when GRAPA leaves the
 *  unit ball. A tempered gradient step on the log-wealth loss
 *  L_t(λ) = −log(1 + λ · z_t). The second-moment scaling comes from the
 *  running second moment of z to match ONS's A_t ≈ Σ ∇²L. */
export function onsBet(runningMean: number, runningSecondMoment: number, prevBet: number): number {
  // Approximate ∇L at prevBet evaluated at the running mean (predictive):
  // ∇L = −E[z] / (1 + prevBet · E[z]); approximate A by E[z²].
  const denomInner = 1 + prevBet * runningMean;
  if (!(runningSecondMoment > 0) || Math.abs(denomInner) < 1e-9) return 0;
  const grad = -runningMean / denomInner;
  const step = grad / Math.max(runningSecondMoment, 1e-6);
  const proposed = prevBet - step;
  if (proposed > BET_CLIP) return BET_CLIP;
  if (proposed < -BET_CLIP) return -BET_CLIP;
  return proposed;
}

/** Pick a bet: GRAPA if it's inside the unit ball, else ONS fallback.
 *  Returns `{ bet, fellBack }` so the caller can update the state's
 *  `onsFallbackCount` audit counter. */
export function pickBet(runningMean: number, runningSecondMoment: number, prevBet: number): { bet: number; fellBack: boolean } {
  const g = grapaBet(runningMean, runningSecondMoment, prevBet);
  if (Math.abs(g) <= BET_CLIP && Number.isFinite(g)) {
    return { bet: g, fellBack: false };
  }
  return { bet: onsBet(runningMean, runningSecondMoment, prevBet), fellBack: true };
}

/** Standardize + clip a raw observation to the bounded-support z. */
function boundedZ(x: number, mean: number, sigma: number): number {
  const denom = BOUNDED_SCALE_B * sigma;
  if (!(denom > 0)) return 0;
  const raw = (x - mean) / denom;
  if (raw > 1) return 1;
  if (raw < -1) return -1;
  return raw;
}

/** Betting-state tick update: derive z_t from the cell's baseline
 *  mean/σ, pick the bet, advance wealth with the non-negativity guard,
 *  and update running moments. Per-tick α is accounted separately in
 *  `alphaConsumed` for audit symmetry with Page-CUSUM. */
export function updateBettingState(
  state: BettingEProcessState,
  x: number,
  baselineMean: number,
  sigmaSquared: number,
  perTickAlpha: number,
): number {
  const sigma = Math.sqrt(Math.max(sigmaSquared, 0));
  const z = boundedZ(x, baselineMean, sigma);
  const picked = pickBet(state.runningMean, state.runningSecondMoment, state.bet);
  const factor = 1 + picked.bet * z;
  // Non-negativity guard (Waudby-Smith & Ramdas eq. 4.3). With BET_CLIP
  // strictly < 1 and |z| ≤ 1 the factor is already positive; guard is a
  // numerical safety net against floating-point rounding into zero.
  state.M = Math.max(WEALTH_FLOOR, state.M * Math.max(0, factor));
  state.bet = picked.bet;
  if (picked.fellBack) state.onsFallbackCount += 1;
  // Running first + second moments of z (for the next tick's bet).
  const n1 = state.n + 1;
  state.runningMean = state.runningMean + (z - state.runningMean) / n1;
  state.runningSecondMoment = state.runningSecondMoment + (z * z - state.runningSecondMoment) / n1;
  state.n = n1;
  state.alphaConsumed += perTickAlpha;
  return state.M;
}

/** Per-tick betting e-process input mirroring CUSUMInput. */
export interface BettingInput {
  signal: string;
  params: MSPRTParams;
  state: BettingEProcessState;
  trafficPct: number;
  trafficGate: number;
  ticksSinceDeploy: number;
  deployAgeDays: number;
  /** α_per_signal_betting: (α_A / bonf) · 0.5 per D7. Threshold = 1/α. */
  alphaBetting: number;
}

function suppressed(signal: string, reason: string, state: BettingEProcessState, threshold: number): DetectorVerdict {
  return {
    verdict: 'suppressed',
    statistic: state.M,
    threshold,
    alpha_consumed: state.alphaConsumed,
    alpha_spent: 0,
    reason_code: reason,
    family: 'A',
    signal,
  };
}

/** Evaluate the betting e-process at one tick, mirroring evaluateCUSUM's
 *  shape. Eligibility gates suppress FIRE (not ACCUMULATION); the wealth
 *  martingale evolves across suppressed ticks so that when eligibility
 *  lands, M_t already reflects deploy history — parity with Page-CUSUM's
 *  S_n accumulation semantic (D9). */
export function evaluateBettingEProcess(input: BettingInput, x: number): DetectorVerdict {
  const { signal, params, state, alphaBetting } = input;
  const sigmaSquared = params.derivation?.empirical_variance;
  const baselineMean = params.derivation?.mean;
  if (sigmaSquared === undefined || baselineMean === undefined) {
    throw new Error(`betting: missing derivation.{mean, empirical_variance} for signal ${signal}`);
  }
  updateBettingState(state, x + baselineMean, baselineMean, sigmaSquared, alphaBetting);
  // NOTE: the gates/health caller supplies `x` already mean-centered
  // (live − baseline mean, same convention as Page-CUSUM). updateBettingState
  // expects the raw `x` and re-centers internally; we restore by adding
  // `baselineMean` back. Keeping the caller's contract identical to
  // Page-CUSUM minimises the co-ship wiring churn in health.ts.
  // Q2.B.6.3 — sliding-buffer-aware betting threshold under joint AR(1) H₀.
  // Stamped by the calibrator post-AR(1)-ρ-stamping. Pre-Q2.B.6.3 configs
  // lack the field; falls through to analytical 1/α_betting (backward-
  // compat anchor — preserves pre-Q2.B.6.3 runtime behavior under the
  // fallback path). See coordination/DIAGNOSTIC-Q2-B-6-3-FAMILY-A-BETTING-
  // MECHANISM-2026-04-28.md.
  const threshold = params.derivation?.betting_sliding_buffer_threshold
    ?? (1 / alphaBetting);

  if (input.ticksSinceDeploy < params.min_ticks_before_eligible) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  if (state.n < params.min_observation_window) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  if (input.deployAgeDays > params.max_deploy_window_days) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  if (input.trafficPct < input.trafficGate) {
    return suppressed(signal, 'traffic_pct_below_gate', state, threshold);
  }

  if (state.M >= threshold) {
    return {
      verdict: 'fire',
      statistic: state.M,
      threshold,
      alpha_consumed: state.alphaConsumed,
      alpha_spent: alphaBetting,
      reason_code: 'betting_wealth_exceeded_threshold',
      family: 'A',
      signal,
    };
  }
  return {
    verdict: state.M > 1 ? 'indeterminate' : 'clean',
    statistic: state.M,
    threshold,
    alpha_consumed: state.alphaConsumed,
    alpha_spent: 0,
    reason_code: state.M > 1 ? 'accumulating' : 'at_initial_wealth',
    family: 'A',
    signal,
  };
}

function matchCellByHour(
  cells: BaselineCellEntry[],
  query: BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier },
): BaselineCellEntry | undefined {
  const matchOne = (tier: TenantTier | undefined): BaselineCellEntry | undefined =>
    cells.find((c) => {
      if (c.key.hour_of_day !== query.hour_of_day) return false;
      if (query.day_of_week !== undefined && c.key.day_of_week !== undefined) {
        if (c.key.day_of_week !== query.day_of_week) return false;
      }
      if (tier !== undefined && c.key.tenant_tier !== undefined) {
        if (c.key.tenant_tier !== tier) return false;
      }
      return true;
    });
  const direct = matchOne(query.tenant_tier);
  if (direct) return direct;
  if (query.tenant_tier !== undefined && query.tenant_tier !== 'aggregate') {
    return matchOne('aggregate');
  }
  return undefined;
}

function buildMSPRTParamsLocal(
  cfg: CompiledConfig,
  cell: BaselineCellEntry,
  signal: string,
): { params: MSPRTParams; perSig: FamilyAPerSignalParams } | null {
  let perSig: FamilyAPerSignalParams | undefined = cell.family_A?.per_signal[signal];
  let pooled = cell.confidence === 'pooled';
  const aggregateFallback = cell.confidence === 'aggregate' || cell.confidence === 'none';
  if (!perSig && aggregateFallback) {
    perSig = cfg.baseline_cells?.aggregate_fallback.family_A?.per_signal[signal];
    pooled = true;
  }
  if (!perSig) return null;
  const bake = cfg.bake_profiles?.[signal] ?? DEFAULT_BAKE;
  const alphaFamilyA = cfg.alpha_budget.per_family.A ?? 4e-4;
  const bonf = cfg.bonferroni_factor ?? 6;
  // Per-signal Bonferroni α; the betting/Page-CUSUM 50/50 split happens
  // in the callers (Page-CUSUM already halves via buildMSPRTParams from
  // page-cusum.ts once Addition #17 lands there; betting halves via the
  // alphaBetting field below).
  const alpha = alphaFamilyA / bonf;
  const params: MSPRTParams = {
    signal,
    tau_squared: perSig.tau_squared,
    delta_min: perSig.delta_min,
    min_samples: 0,
    min_ticks_before_eligible: bake.min_ticks_before_eligible,
    min_observation_window: bake.min_observation_window,
    max_deploy_window_days: bake.max_deploy_window_days,
    alpha,
    derivation: {
      tau_multiplier: 0,
      empirical_variance: perSig.baseline_sigma_squared,
      // Q2.B.5 — propagate raw-space σ² for downstream Page-CUSUM
      // consumption. Betting-e-process itself uses transformed-space
      // (Q2.A) σ² unchanged; the field is propagated here so the
      // shared MSPRTParams shape carries both scales coherently.
      empirical_variance_raw: perSig.baseline_sigma_squared_raw,
      mean: perSig.baseline_mean,
      mean_raw: perSig.baseline_mean_raw,
      std: Math.sqrt(perSig.baseline_sigma_squared),
      pooled,
      n_samples: cell.n_samples,
      // Q2.B.6.3 — propagate sliding-buffer-aware betting threshold so
      // evaluateBettingEProcess can consume it in preference to
      // analytical 1/α_betting. Backward-compat: pre-Q2.B.6.3 configs
      // (and signals lacking the field) fall through.
      betting_sliding_buffer_threshold: perSig.betting_sliding_buffer_threshold,
    },
  };
  return { params, perSig };
}

/** Per-tick Family A betting shadow. Parallel to evaluateFamilyAShadow;
 *  reads the same cell params + bake profile + ignore/schema gates so
 *  downstream audit records emit two independent per-signal verdicts
 *  (one per co-shipped detector) under a single Family A α-budget split
 *  50/50. Fires become `family_A_betting_{signal}` rollback entries. */
export function evaluateFamilyABettingShadow(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: BettingStates,
  ctx: {
    hourOfDay: number;
    dayOfWeek?: number;
    ticksSinceDeploy: number;
    deployAgeDays: number;
    trafficPct: number;
    schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
    ignoredSignals?: Set<string>;
    /** Addition #23 — tenant_id resolved to tenant_tier via
     *  `cfg.tenant_tier_map` for per-tier cell lookup. */
    tenantId?: string;
  },
): DetectorVerdict[] {
  if (!cfg.baseline_cells) return [];
  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'A')) {
    const reason = ctx.schemaContinuityClass === 'observability_stack'
      ? 'observability_stack_deploy' : 'schema_continuity_breaking';
    const out: DetectorVerdict[] = [];
    for (const signal of (cfg.family_a_signals ?? FAMILY_A_PRIMARY_SIGNALS)) {
      const state = getOrCreateBetting(states, signal);
      out.push({
        verdict: 'suppressed',
        statistic: state.M,
        threshold: null,
        alpha_consumed: state.alphaConsumed,
        alpha_spent: 0,
        reason_code: reason,
        family: 'A',
        signal,
      });
    }
    return out;
  }
  const trafficGate = trafficGateMin(cfg);
  const cell: BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier } = { hour_of_day: ctx.hourOfDay };
  if (ctx.dayOfWeek !== undefined) cell.day_of_week = ctx.dayOfWeek;
  cell.tenant_tier = resolveTenantTier(cfg, ctx.tenantId);
  const bc = cfg.baseline_cells;
  const match = matchCellByHour(bc.cells, cell);
  if (!match) return [];

  const out: DetectorVerdict[] = [];
  for (const signal of FAMILY_A_PRIMARY_SIGNALS) {
    if (ctx.ignoredSignals?.has(signal)) {
      const state = getOrCreateBetting(states, signal);
      out.push({
        verdict: 'suppressed',
        statistic: state.M,
        threshold: null,
        alpha_consumed: state.alphaConsumed,
        alpha_spent: 0,
        reason_code: 'ignore_threshold',
        family: 'A',
        signal,
        ignore_threshold_trigger_signal: signal,
      });
      continue;
    }
    const built = buildMSPRTParamsLocal(cfg, match, signal);
    if (!built) continue;
    const { params, perSig } = built;
    const live = liveMetrics[signal];
    if (live === undefined) continue;
    // Q2.A — apply class-appropriate forward transform to live observation
    // before mean-centering. cellMean is in TRANSFORMED space when the
    // class is non-identity (logit / log / Anscombe), so live must be
    // transformed first to be in the same space.
    //
    // Runtime resolution differs from compile-time resolution: at
    // runtime we ONLY consult what the compiled config declared
    // (perSig.signal_class first, then cfg.signal_classes), falling
    // through to 'gaussian_like' (identity) when neither is present.
    // Pre-Q2.A configs lack both fields and therefore preserve their
    // pre-Q2.A raw-space calibration semantics byte-identically — they
    // were calibrated WITHOUT a transform, so the runtime must NOT
    // apply one. DEFAULT_SIGNAL_CLASSES is a COMPILE-TIME default for
    // new compiles, not a runtime fallback.
    const cls = perSig.signal_class
      ?? cfg.signal_classes?.[signal]
      ?? 'gaussian_like';
    const liveTransformed = transformForClass(live, cls);
    const cellMean = params.derivation?.mean;
    if (cellMean === undefined) continue;
    const x = liveTransformed - cellMean;  // matches Page-CUSUM's input convention
    const state = getOrCreateBetting(states, signal);
    // α for this detector is half the per-signal budget (D7). Falls
    // back to the derived value when the compiled config predates #17.
    const alphaBetting = perSig.betting_e_process_alpha
      ?? (params.alpha * 0.5);
    const v = evaluateBettingEProcess({
      signal, params, state,
      trafficPct:       ctx.trafficPct,
      trafficGate,
      ticksSinceDeploy: ctx.ticksSinceDeploy,
      deployAgeDays:    ctx.deployAgeDays,
      alphaBetting,
    }, x);
    out.push(v);
  }
  return out;
}

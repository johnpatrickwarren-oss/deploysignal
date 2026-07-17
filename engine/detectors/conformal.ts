// engine/detectors/conformal.ts — Family E: Mahalanobis conformal novelty.
//
// Per WEEK4-HANDOFF.md §4.1.c and Addition #19 (ARCHITECT-REPLY-35).
// Nonconformity scorer: Mahalanobis distance on relative-deviation vectors,
// reusing Family C's per-cell mean vector and robust covariance (Ledoit-
// Wolf / MCD / MRCD per Addition #18) from the compiler. No per-family
// covariance derivation — the covariance pipeline is shared with Family C.
//
// Calibration comes from a parametric Gaussian bootstrap in the compiler:
// `tools/calibrate.ts#buildFamilyEPerCell` draws M samples w ~ N(0, I_p)
// and stores the Mahalanobis norms ||w|| under the cell's Σ as the
// calibration score distribution. Addition #19 extends this by attaching
// per-sample time-decay weights; the threshold becomes the `(1 − α_E)`-th
// weighted quantile of the bootstrap scores.
//
// Math:
//
//   s(x) = ||L⁻¹ (x̃ − μ̃)||        where x̃_i = (x_i − μ_i) / μ_i
//                                   and L L^T = Σ (Cholesky of robust cov)
//
//   unweighted path (legacy configs, `kind === 'unweighted'`):
//     p(x) = (#{ s_c ≥ s(x) } + 1) / (n_calibration + 1)   (conformal p-value)
//     Fire when p < α_family_E.
//
//   weighted path (Addition #19, `kind === 'weighted'`):
//     threshold = weightedQuantile(scores, weights, 1 − α_E)
//     Fire when s(x) > threshold. The weighting makes the null
//     distribution adapt to recent-baseline conditions; effective sample
//     size is carried on the struct and audit-visible.
//
// Per-family α comes from `CompiledConfig.alpha_budget.per_family.E`;
// default 1e-4 (10% of total 1e-3) when absent.
//
// Explicit non-goal per ARCHITECT-REPLY-11 Item 1:
//   Family E is the same Mahalanobis metric as Family C; it is blind by
//   construction to covariance-consistent joint drift (the architectural
//   gap in `adv_correlated_noise`). If Family E happens to catch it, note
//   in handoff-back; otherwise documented limit.
//
// Route (b) real-held-out calibration with weights (Tibshirani/Foygel-
// Barber/Candès/Ramdas 2019) is deferred per the sample-size
// floor: finite-sample coverage needs `n ≥ ⌈1/α⌉` per cell which exceeds
// typical cell sample counts at α = 1e-4.

import type {
  CompiledConfig, DetectorVerdict, BaselineCellEntry, ConformalParams, FamilyCPerCell,
  SchemaContinuityRecord, TenantTier, ConformalEValueState,
} from '../types';
// relative-deviation helper is file-local; exported below for health.ts
// to reuse when it threads x_t through to evaluateConformalWeightedEValue
// via evaluateFamilyE's dispatch branch.
import { isWeightedConformal, isWeightedEValueConformal, conformalSampleCount, resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import { cholesky, forwardSolve, weightedQuantile, findFirstGE } from './_linalg';
import {
  collectLiveVector, checkBakeAndTrafficGates, checkConformalPreGuards,
} from './_conformal-gates';

// Default α_family_E = 10% of 1e-3 per handoff §4.1.c.
const DEFAULT_ALPHA_E = 1e-4;

/** Mahalanobis distance √(r^T Σ⁻¹ r). Returns null if Σ is not PD.
 *  Exported so the compiler can precompute calibration scores with the
 *  same scoring function the detector uses at query time. */
export function mahalanobisDistance(r: number[], covariance: number[][]): number | null {
  const L = cholesky(covariance);
  if (!L) return null;
  const y = forwardSolve(L, r);
  let sum = 0;
  for (const v of y) sum += v * v;
  return Math.sqrt(sum);
}

/** Relative-deviation vector (x − μ) ./ μ, matching Family C's
 *  standardization. Falls back to additive (x − μ) when μ_i ≈ 0. */
function relativeDeviation(x: number[], mean: number[]): number[] {
  const p = mean.length;
  const r = new Array(p);
  for (let i = 0; i < p; i++) {
    const m = mean[i];
    r[i] = Math.abs(m) > 1e-12 ? (x[i] - m) / m : (x[i] - m);
  }
  return r;
}

/** Conformal p-value: (#{ s_c ≥ s_query } + 1) / (n_calibration + 1).
 *  `+1` in numerator and denominator makes this a valid (exchangeable)
 *  p-value even on exact ties. */
export function conformalPValue(queryScore: number, calibrationScores: number[]): number {
  if (calibrationScores.length === 0) return 1.0;
  let atLeast = 0;
  for (const s of calibrationScores) if (s >= queryScore) atLeast++;
  return (atLeast + 1) / (calibrationScores.length + 1);
}

/** Retrieve Family E calibration + matching Family C mean/covariance.
 *
 *  W5 §REPLY-16 Q2: Family E always consults `aggregate_fallback.family_E`
 *  for calibration_scores, never per-cell. Rationale: per-cell calibration
 *  would have far fewer samples than the aggregate's pooled baseline (16K+
 *  samples), risking the underpowered-guard tripping at the project's
 *  α_E=1e-4 default (which needs ≥9999 samples). The aggregate's pooled
 *  scores are statistically richer than any per-cell slice and the
 *  exchangeability assumption underlying conformal p-values is preserved
 *  (calibration draws are independent of the query).
 *
 *  The Family C mean/covariance used for the Mahalanobis distance still
 *  comes from the per-cell match when present — that's a different
 *  contract (per-cell baseline distribution shape, not nonconformity
 *  scoring tail), so per-cell μ/Σ continues to apply.
 */
export function lookupFamilyEParams(
  cfg: CompiledConfig,
  cell: { hour_of_day: number; day_of_week?: number; tenant_tier?: TenantTier },
): { params: ConformalParams; famC: FamilyCPerCell; source: BaselineCellEntry | 'aggregate' } | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  const fb = bc.aggregate_fallback;
  if (!fb.family_E) return null;
  // Addition #23 — two-stage cell match (exact tier → 'aggregate' tier)
  // so per-cell μ/Σ comes from the requested tenant_tier when present.
  const matchOne = (tier: TenantTier | undefined): BaselineCellEntry | undefined =>
    bc.cells.find((c) => {
      if (c.key.hour_of_day !== cell.hour_of_day) return false;
      if (cell.day_of_week !== undefined && c.key.day_of_week !== undefined) {
        if (c.key.day_of_week !== cell.day_of_week) return false;
      }
      if (tier !== undefined && c.key.tenant_tier !== undefined) {
        if (c.key.tenant_tier !== tier) return false;
      }
      return true;
    });
  let match = matchOne(cell.tenant_tier);
  if (!match && cell.tenant_tier !== undefined && cell.tenant_tier !== 'aggregate') {
    match = matchOne('aggregate');
  }
  // Calibration scores: always aggregate (per architect REPLY-16 Q2).
  // Family C μ/Σ for Mahalanobis: per-cell when available, else aggregate.
  const famC = (match?.family_C) ?? fb.family_C;
  if (!famC) return null;
  return { params: fb.family_E, famC, source: 'aggregate' };
}

/** Evaluate Family E at one tick. Legacy unweighted/weighted paths are
 *  stateless (per-tick single-shot). Addition #22 `weighted_e_value`
 *  variant is stateful — requires the `state` parameter; function
 *  mutates `state.M` / `state.n` / `state.alphaConsumed` in place on
 *  that dispatch branch.
 *
 *  Returns null when Family E isn't compiled for this cell/config. */
export function evaluateFamilyE(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  ctx: {
    hourOfDay: number;
    dayOfWeek?: number;
    ticksSinceDeploy: number;
    deployAgeDays: number;
    trafficPct: number;
    schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
    /** Addition #23 — tenant_id resolved to tenant_tier via
     *  `cfg.tenant_tier_map`; drives per-tier cell lookup for μ/Σ. */
    tenantId?: string;
  },
  state?: ConformalEValueState,
): DetectorVerdict | null {
  const tier = resolveTenantTier(cfg, ctx.tenantId);
  const lookup = lookupFamilyEParams(cfg, {
    hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek, tenant_tier: tier,
  });
  if (!lookup) return null;
  const { params, famC } = lookup;
  const alphaE = cfg.alpha_budget.per_family.E ?? DEFAULT_ALPHA_E;

  const preGuard = checkConformalPreGuards(
    ctx.schemaContinuityClass,
    !!(ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'E')),
    conformalSampleCount(params),
    alphaE,
  );
  if (preGuard) return preGuard;

  const vec = collectLiveVector(cfg, liveMetrics);
  if (!vec) return null;
  const { x, cSignals } = vec;

  const gate = checkBakeAndTrafficGates(cfg, cSignals, ctx, alphaE);
  if (gate) return gate;

  const r = relativeDeviation(x, famC.mean_vector);
  const s = mahalanobisDistance(r, famC.covariance);
  if (s === null) {
    // This is the sole production entry point for Family E — it
    // computes the Mahalanobis distance itself and returns here BEFORE
    // ever dispatching into CONFORMAL_EVALUATORS, so the inner
    // per-variant evaluators' own `covariance_singular` branches (e.g.
    // evaluateConformalWeightedEValue's, below) are unreachable from
    // here. Tag this verdict with the wealth-process `signal` when (and
    // only when) the resolved params are the `weighted_e_value` kind —
    // that's the only Family E variant whose live verdict is a wealth
    // martingale (see engine/verdict.ts's `WEALTH_SIGNAL_NAMES` /
    // `progressScaleFor`); the classical `unweighted` and `weighted`
    // kinds have no signal tag of their own anywhere in this file and
    // must stay untagged rather than borrow the wealth tag.
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'covariance_singular', family: 'E',
      ...(isWeightedEValueConformal(params) ? { signal: 'weighted_conformal_e_value' as const } : {}),
    };
  }

  // D-54-2 dispatch — variant routing via CONFORMAL_EVALUATORS map,
  // keyed by ConformalParams.kind discriminator. Three variants:
  //   'unweighted'       — pre-#19 parametric-bootstrap p-value.
  //   'weighted'         — #19 weighted-quantile threshold crossing.
  //   'weighted_e_value' — #22 hedged-indicator e-value (requires state).
  // Unknown variant strings throw per feedback_no_skip_test_policy.
  const variant = conformalKindForDispatch(params);
  const evaluator = CONFORMAL_EVALUATORS[variant];
  if (!evaluator) {
    throw new Error(
      `Unknown ConformalParams.kind: '${String((params as { kind?: string }).kind)}'. `
      + `Known: ${Object.keys(CONFORMAL_EVALUATORS).join(', ')}`,
    );
  }
  return evaluator({ params, s, r, alphaE, covariance: famC.covariance, state });
}

// ── D-54-2 — dispatch maps (ARCHITECT-REPLY-54 slice 2) ────────────

type ConformalKind = 'unweighted' | 'weighted' | 'weighted_e_value';

/** Unified context the Record<ConformalKind, Evaluator> receives.
 *  `state` is only required by `weighted_e_value`. */
interface ConformalDispatchCtx {
  params: ConformalParams;
  s: number;
  r: number[];
  alphaE: number;
  covariance: number[][];
  state?: ConformalEValueState;
}

type ConformalEvaluator = (ctx: ConformalDispatchCtx) => DetectorVerdict;

/** Pre-#19 unweighted parametric-bootstrap p-value. Fires when
 *  p(s | calibration_scores) < α_E. */
function evaluateConformalUnweighted(ctx: ConformalDispatchCtx): DetectorVerdict {
  const { params, s, alphaE } = ctx;
  // Discriminator narrows — unweighted variant carries calibration_scores.
  const scores = (params as Extract<ConformalParams, { kind?: 'unweighted' }>).calibration_scores;
  const p = conformalPValue(s, scores);
  if (p < alphaE) {
    return {
      verdict: 'fire', statistic: s, threshold: alphaE,
      alpha_consumed: alphaE, alpha_spent: alphaE,
      reason_code: 'conformal_p_below_threshold', family: 'E',
    };
  }
  return {
    verdict: 'clean', statistic: s, threshold: alphaE,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'E',
  };
}

/** Addition #19 weighted-quantile threshold crossing. */
function evaluateConformalWeightedQuantile(ctx: ConformalDispatchCtx): DetectorVerdict {
  const { params, s, alphaE } = ctx;
  const w = params as Extract<ConformalParams, { kind: 'weighted' }>;
  const threshold = weightedQuantile(w.scores, w.weights, 1 - alphaE);
  if (s > threshold) {
    return {
      verdict: 'fire', statistic: s, threshold,
      alpha_consumed: alphaE, alpha_spent: alphaE,
      reason_code: 'weighted_conformal_threshold_exceeded', family: 'E',
    };
  }
  return {
    verdict: 'clean', statistic: s, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'E',
  };
}

/** Addition #22 weighted-e-value wrapper. Preserves pre-refactor
 *  fall-through: state missing → suppressed with reason code. */
function evaluateConformalWeightedEValueDispatch(ctx: ConformalDispatchCtx): DetectorVerdict {
  const { params, s, r, alphaE, covariance, state } = ctx;
  if (!state) {
    return {
      verdict: 'suppressed', statistic: s, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'weighted_e_value_state_missing', family: 'E',
    };
  }
  const w = params as Extract<ConformalParams, { kind: 'weighted_e_value' }>;
  return evaluateConformalWeightedEValue(
    { params: w, covariance, alpha: alphaE },
    r, state,
  );
}

const CONFORMAL_EVALUATORS: Record<ConformalKind, ConformalEvaluator> = {
  'unweighted': evaluateConformalUnweighted,
  'weighted': evaluateConformalWeightedQuantile,
  'weighted_e_value': evaluateConformalWeightedEValueDispatch,
};

/** Resolve ConformalParams.kind to the dispatch key. Normalizes
 *  undefined (pre-#19 shape) → 'unweighted'. */
function conformalKindForDispatch(params: ConformalParams): ConformalKind {
  if (isWeightedEValueConformal(params)) return 'weighted_e_value';
  if (isWeightedConformal(params)) return 'weighted';
  const raw = (params as { kind?: string }).kind;
  if (raw === undefined || raw === 'unweighted') return 'unweighted';
  return raw as ConformalKind;
}

/** Exposed for dispatch-map parity testing. */
export const _CONFORMAL_EVALUATORS_FOR_TEST = CONFORMAL_EVALUATORS;
export const _conformalKindForDispatch = conformalKindForDispatch;

// ── Addition #22 — weighted e-value detector (ARCHITECT-REPLY-46b) ─────
//
// Hedged-indicator betting form (Shekhar-Ramdas 2023 λ=1 special case)
// with weighted exchangeability over the time-decayed calibration
// distribution from Addition #19. Fires at `M_t ≥ 1/α_E` under Ville's
// inequality — anytime-valid time-uniform α control, parallel to
// Family A (betting), C (safe-Hotelling + e-MMD), D (spectral
// e-detector). REPLACE semantic per D2.
//
// REPLY-46b corrected the original REPLY-46 D3 formula (`e_t =
// total_weight / den`) which was 1/p-conformal inversion and NOT a
// valid e-value: E[e_t|H₀] ≈ log(M) + γ, wealth grew multiplicatively
// under H₀. The hedged-indicator form `e_t = 1 + 𝟙(s_t ∈ upper-α tail)
// − α` preserves `E[e_t|H₀] = 1` exactly.
//
// Fresh per-(deploy, cell) wealth state `M₀ = 1`. Caller threads the
// state object through; this function mutates in place.
//
// Runtime cost: O(log M) binary search into the sorted scores + O(1)
// cumulative-weights lookup. ≈1μs per tick per cell at M=20,000.

/** Fresh wealth state for a new (deploy, cell) weighted-e-value
 *  evaluation. `M₀ = 1` per Ville-inequality convention. */
export function freshConformalEValueState(): ConformalEValueState {
  return { M: 1, n: 0, alphaConsumed: 0 };
}

/** Addition #22 (ARCHITECT-REPLY-46b corrected D3) — weighted e-value
 *  per-tick evaluation against a cell with `kind: 'weighted_e_value'`
 *  ConformalParams. Caller owns the state object; this function mutates
 *  `state.M` / `state.n` / `state.alphaConsumed` in place.
 *
 *  Formula (hedged-indicator betting form; λ=1 special case of
 *  Shekhar-Ramdas 2023):
 *
 *    Let s_t = √(xᵀ Σ⁻¹ x) be the live Mahalanobis distance against
 *    the cell's robust covariance.
 *    k = findFirstGE(sorted_scores, s_t)     // O(log M) rank
 *    den_raw = cumulative_weights_above[k]   // O(1) reverse-cumsum,
 *              0 if k === scores.length (s_t exceeds all calibration)
 *    indicator = (den_raw < α_E · total_weight) ? 1 : 0
 *    e_t = 1 + indicator − α_E
 *        ⇒ indicator=0: e_t = 1 − α_E ≈ 1 (slight wealth decay)
 *        ⇒ indicator=1: e_t = 2 − α_E ≈ 2 (wealth doubles on fire tick)
 *    M_t = M_{t-1} · e_t
 *    fire iff M_t ≥ 1/α_E
 *
 *  Validity (why this IS an e-value under weighted exchangeability):
 *
 *    Under H₀, P(indicator = 1 | H₀) = P(s_t is in upper α_E tail of
 *    calibration distribution) = α_E by construction of the weighted
 *    rank. So E[e_t | H₀] = α_E · (2 − α_E) + (1 − α_E) · (1 − α_E)
 *                          = 2α_E − α_E² + 1 − 2α_E + α_E²
 *                          = 1  exactly.
 *    Ville's inequality applies: sup_t P(M_t ≥ 1/α_E | H₀) ≤ α_E.
 *
 *  Replaces REPLY-46's original D3 formula `e_t = total_weight / den`
 *  which was 1/p-conformal inversion (not a valid e-value — E[e_t|H₀]
 *  ≈ log(M) + γ, wealth grew multiplicatively under H₀). REPLY-46b
 *  corrects by swapping to the hedged-indicator form that preserves
 *  the martingale property under weighted exchangeability. */
export function evaluateConformalWeightedEValue(
  input: {
    params: Extract<ConformalParams, { kind: 'weighted_e_value' }>;
    covariance: number[][];
    alpha: number;
  },
  x_t: number[],
  state: ConformalEValueState,
): DetectorVerdict {
  const threshold = 1 / input.alpha;
  const s_t = mahalanobisDistance(x_t, input.covariance);
  if (s_t === null) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'covariance_singular', family: 'E',
      signal: 'weighted_conformal_e_value',
    };
  }
  const { scores, cumulative_weights_above, total_weight } = input.params;
  const k = findFirstGE(scores, s_t);
  const den_raw = k < cumulative_weights_above.length ? cumulative_weights_above[k] : 0;
  const fireCutoff = input.alpha * total_weight;
  const indicator = den_raw < fireCutoff ? 1 : 0;
  const e_t = 1 + indicator - input.alpha;
  state.M = state.M * e_t;
  state.n += 1;
  if (state.M >= threshold) {
    const alphaSpent = Math.max(0, input.alpha - state.alphaConsumed);
    state.alphaConsumed = input.alpha;
    return {
      verdict: 'fire', statistic: state.M, threshold,
      alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
      reason_code: 'conformal_e_value_wealth_exceeded',
      family: 'E', signal: 'weighted_conformal_e_value',
    };
  }
  return {
    verdict: 'clean', statistic: state.M, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold',
    family: 'E', signal: 'weighted_conformal_e_value',
  };
}

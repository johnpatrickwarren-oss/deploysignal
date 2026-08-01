// engine/detectors/_hotelling-eval.ts — Family C per-tick evaluation
// entry point. Extracted from engine/detectors/hotelling.ts (god-file
// split) and decomposed into <100-line helpers. No behavior change:
// the suppression gates, threshold resolution, vector projection and
// dispatch are byte-for-byte equivalent to the pre-split inline form.

import type {
  CompiledConfig, DetectorVerdict, FamilyCPerCell,
  SchemaContinuityRecord, TenantTier, SafeHotellingState,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '@johnpatrickwarren-oss/deploysignal-engine/l0/schema-continuity';
import { trafficGateMin } from './page-cusum';
import { chiSquareQuantile } from './_hotelling-math';
import {
  FAMILY_C_SIGNALS, lookupFamilyCParams, familyCBakeProfile,
} from './_hotelling-lookup';
import {
  HOTELLING_EVALUATORS, hotellingVariantForDispatch,
} from './_hotelling-dispatch';

/** Build a Family C `suppressed` verdict with the given reason/threshold.
 *  Every suppression gate in the original inline body emitted this exact
 *  shape; factoring it keeps the gate helpers small without altering the
 *  emitted object. */
function suppressedC(reasonCode: string, threshold: number): DetectorVerdict {
  return {
    verdict: 'suppressed', statistic: null, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: reasonCode, family: 'C',
  };
}

type FamilyCCtx = {
  hourOfDay: number;
  dayOfWeek?: number;
  ticksSinceDeploy: number;
  deployAgeDays: number;
  trafficPct: number;
  schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  /** Addition #23 — tenant_id resolved to tenant_tier via
   *  `cfg.tenant_tier_map`; drives per-tier cell lookup. */
  tenantId?: string;
};

/** Resolve the χ²/sliding-buffer threshold for this evaluation. */
function resolveThreshold(cfg: CompiledConfig, params: FamilyCPerCell): number {
  // Addition #18 D8: Family C α-budget splits 50/50 between Hotelling T²
  // and Sequential MMD. When the cell carries `mmd_params` (post-#18
  // recompile), Hotelling takes half; otherwise it uses the full budget
  // (backward compat for v4-and-earlier configs). Threshold uses
  // Wilson-Hilferty chi-square quantile at `1 − α_hotelling`.
  const alphaFamilyC = cfg.alpha_budget.per_family.C ?? 2e-4;
  const alphaHotelling = params.mmd_params ? alphaFamilyC * 0.5 : alphaFamilyC;
  // REPLY-51b v2 R4-1 — χ² degrees-of-freedom matches compiled
  // joint-vector dimension (profile-driven when present).
  const signalsForChi2 = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
  // Q2.B.6.2 — sliding-buffer-aware threshold under joint AR(1) H₀.
  // Stamped by the calibrator post-cholesky_L_eps (per Q2-B-6-2 spec)
  // so per-trajectory FPR matches α under the runtime sliding-buffer
  // evaluation contract. Pre-Q2.B.6.2 configs lack the field; falls
  // through to the single-window Wilson-Hilferty χ²_p quantile (P3.7
  // backward-compat anchor).
  return params.hotelling_sliding_buffer_threshold
    ?? chiSquareQuantile(1 - alphaHotelling, signalsForChi2.length);
}

/** Run the suppression gates (schema continuity, bake profile, traffic).
 *  Returns a `suppressed` verdict to short-circuit, or null to proceed. */
function familyCSuppressionGate(
  cfg: CompiledConfig, ctx: FamilyCCtx, threshold: number,
): DetectorVerdict | null {
  // Addition #8 runtime consumer (W5 §S6): per-cell covariance is only
  // meaningful against the baseline's original schema. A breaking change
  // invalidates Σ; suppress without evaluating.
  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'C')) {
    return suppressedC(
      ctx.schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      threshold,
    );
  }

  // Addition #13 (per ARCHITECT-REPLY-31 correction): multivariate families
  // evaluate the full joint vector regardless of `ignore_thresholds` state.
  // An in-band signal contributes near-zero to the Mahalanobis quadratic
  // form naturally — (x − μ)ᵀ Σ⁻¹ (x − μ) with x ≈ μ for that component —
  // so explicit suppression would be redundant and would silence Family C
  // on other-signal drift the operator didn't intend to ignore.
  // ignore_thresholds are a per-signal suppression for single-signal
  // detectors (Family A) only; Family C is unaffected.

  // Bake-profile gate (joint; takes max of per-signal min_ticks_before_eligible).
  const bake = familyCBakeProfile(cfg);
  if (ctx.ticksSinceDeploy < bake.min_ticks) {
    return suppressedC('bake_profile_not_met', threshold);
  }
  // Addition #4 clause 2 — W4 §4.1.h lands the missing consumer. Family C
  // is per-tick single-shot, so ticksSinceDeploy is the post-deploy
  // sample count for this detector's purposes.
  if (ctx.ticksSinceDeploy < bake.min_obs) {
    return suppressedC('bake_profile_not_met', threshold);
  }
  if (ctx.deployAgeDays > bake.max_days) {
    return suppressedC('bake_profile_not_met', threshold);
  }

  // Traffic gate.
  if (ctx.trafficPct < trafficGateMin(cfg)) {
    return suppressedC('traffic_pct_below_gate', threshold);
  }
  return null;
}

/** Project liveMetrics onto the compiled joint-vector order. Returns null
 *  when any component is missing (the cov matrix dims don't shrink). */
function gatherLiveVector(
  cfg: CompiledConfig, liveMetrics: Record<string, number | undefined>,
): number[] | null {
  // REPLY-51b v2 R4-1 — project onto cfg.family_c_signals when
  // profile is active; fall back to hardcoded for legacy configs.
  // Missing signals kill the evaluation — the cov matrix dimensions
  // don't shrink.
  const cSignals = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
  const x: number[] = new Array(cSignals.length);
  for (let i = 0; i < cSignals.length; i++) {
    const v = liveMetrics[cSignals[i]];
    if (v === undefined) return null;
    x[i] = v;
  }
  return x;
}

/** Relative deviation vector r = (x − μ) ./ μ (element-wise), matching
 *  the compiler's covariance standardization. Fallback to additive
 *  (x − μ) when μ_i ≈ 0 — keeps the formula working on near-zero-mean
 *  signals (no such signal in the current set, but defensive). */
function relativeDeviation(x: number[], mu: number[]): number[] {
  const r: number[] = new Array(mu.length);
  for (let i = 0; i < mu.length; i++) {
    const m = mu[i];
    r[i] = Math.abs(m) > 1e-12 ? (x[i] - m) / m : (x[i] - m);
  }
  return r;
}

/** One Family C evaluation at one tick. Legacy `chi_square` path is
 *  stateless (per-tick joint test); the Addition #20 `safe_test` dispatch
 *  branch (activated when `cell.hotelling_variant === 'safe_test'` and
 *  `states` is provided) is stateful — it mutates the per-cell wealth
 *  martingale in `states[__sh_<tier>_<h>_<d>]`. */
export function evaluateFamilyC(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  ctx: FamilyCCtx,
  states?: Record<string, SafeHotellingState>,
): DetectorVerdict | null {
  if (!cfg.baseline_cells) return null;
  const tier = resolveTenantTier(cfg, ctx.tenantId);
  const lookup = lookupFamilyCParams(cfg, {
    hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek, tenant_tier: tier,
  });
  if (!lookup) return null;
  const { params } = lookup;
  const alphaFamilyC = cfg.alpha_budget.per_family.C ?? 2e-4;
  const alphaHotelling = params.mmd_params ? alphaFamilyC * 0.5 : alphaFamilyC;
  const threshold = resolveThreshold(cfg, params);

  const gate = familyCSuppressionGate(cfg, ctx, threshold);
  if (gate) return gate;

  // Gather the live vector, in the compiled joint-vector order.
  const x = gatherLiveVector(cfg, liveMetrics);
  if (x === null) return null;

  const r = relativeDeviation(x, params.mean_vector);

  // D-54-2 dispatch — variant routing via HOTELLING_EVALUATORS map.
  // `chi_square` is the default when hotelling_variant is unset (pre-#20
  // configs). `safe_test` additionally requires compile-time params +
  // runtime state store; missing prereqs fall through to chi_square
  // (preserves pre-refactor semantics byte-for-byte). Unknown variant
  // strings throw — see dispatch-maps.ts.
  const variant = hotellingVariantForDispatch(
    params.hotelling_variant, !!params.safe_hotelling_params, !!states,
  );
  const evaluator = HOTELLING_EVALUATORS[variant];
  if (!evaluator) {
    throw new Error(
      `Unknown hotelling_variant: '${String(params.hotelling_variant)}'. `
      + `Known: ${Object.keys(HOTELLING_EVALUATORS).join(', ')}`,
    );
  }
  return evaluator({
    params, r, alphaHotelling, threshold, states, tier,
    hourOfDay: ctx.hourOfDay, dayOfWeek: ctx.dayOfWeek,
  });
}

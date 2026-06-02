// engine/detectors/_page-cusum-shadow.ts — per-tick shadow evaluators for
// the Page-CUSUM detector family: the classical reset-at-zero path, the
// Howard-Ramdas-2021 mixture-supermartingale path, and the top-level
// dispatch wrapper. Split out of page-cusum.ts (god-file refactor). The
// two evaluators are decomposed into <100-line helpers; computation and
// emitted verdicts are VERBATIM from the original.

import type {
  CompiledConfig, DetectorVerdict, BaselineCell, TenantTier,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import {
  evaluatePageCusumMixtureSupermartingale,
  freshMixtureSupermartingaleState,
  deriveMixtureSupermartingaleParams,
  type MixtureSupermartingaleState,
} from './family-a-mixture-supermartingale';

import type {
  CUSUMStates, FamilyAShadowCtx,
} from './_page-cusum-types';
import { getOrCreateCUSUM, evaluateCUSUM } from './_page-cusum-core';
import {
  FAMILY_A_PRIMARY_SIGNALS, lookupCellParams, trafficGateMin,
  lookupFamilyAPerSignal,
} from './_page-cusum-params';

export type MixtureSupermartingaleStates = { [signal: string]: MixtureSupermartingaleState };

type ShadowCell = BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier };

/** Build the cell-lookup query from a shadow-evaluator context. */
function shadowCell(cfg: CompiledConfig, ctx: FamilyAShadowCtx): ShadowCell {
  const cell: ShadowCell = { hour_of_day: ctx.hourOfDay };
  if (ctx.dayOfWeek !== undefined) cell.day_of_week = ctx.dayOfWeek;
  cell.tenant_tier = resolveTenantTier(cfg, ctx.tenantId);
  return cell;
}

// ── classical path ────────────────────────────────────────────────────

/** Schema-continuity suppression for the classical path. Returns one
 *  suppressed verdict per Family A signal, or null when not suppressing. */
function schemaSuppressClassical(
  cfg: CompiledConfig,
  states: CUSUMStates,
  ctx: FamilyAShadowCtx,
): DetectorVerdict[] | null {
  // Addition #8 runtime consumer (W5 §S6): 'breaking' or 'observability_stack'
  // suppresses Family A entirely — x_n against a mismatched baseline mean is
  // garbage, so accumulating S_n is worse than silence. Emit one suppressed
  // verdict per primary SLI so the audit shape is symmetric with bake-profile
  // suppression; reason_code routes the family-level suppression_reason.
  if (!ctx.schemaContinuityClass || !shouldSuppress(ctx.schemaContinuityClass, 'A')) {
    return null;
  }
  const reason = ctx.schemaContinuityClass === 'observability_stack'
    ? 'observability_stack_deploy' : 'schema_continuity_breaking';
  const out: DetectorVerdict[] = [];
  for (const signal of (cfg.family_a_signals ?? FAMILY_A_PRIMARY_SIGNALS)) {
    const state = getOrCreateCUSUM(states, signal);
    out.push({
      verdict: 'suppressed',
      statistic: state.S,
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

/** Ignore-band suppressed verdict for the classical path (Addition #13). */
function ignoredVerdictClassical(states: CUSUMStates, signal: string): DetectorVerdict {
  const state = getOrCreateCUSUM(states, signal);
  return {
    verdict: 'suppressed',
    statistic: state.S,
    threshold: null,
    alpha_consumed: state.alphaConsumed,
    alpha_spent: 0,
    reason_code: 'ignore_threshold',
    family: 'A',
    signal,
    // Audit enrichment per ARCHITECT-REPLY-31: single-signal detector
    // has an unambiguous trigger — name it so downstream consumers
    // don't have to cross-reference operator config to reconstruct
    // which ignore-band caused the suppression.
    ignore_threshold_trigger_signal: signal,
  };
}

/** Evaluate one signal on the classical path; null → skip silently. */
function evalSignalClassical(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: CUSUMStates,
  cell: ShadowCell,
  trafficGate: number,
  ctx: FamilyAShadowCtx,
  signal: string,
): DetectorVerdict | null {
  const params = lookupCellParams(cfg, cell, signal);
  if (!params) return null;
  const live = liveMetrics[signal];
  if (live === undefined) return null;
  // Q2.B.5 — Page-CUSUM operates on RAW observation space (no Q2.A
  // forward transform). Mean-centers against `mean_raw` (Q2.A added
  // for Q2.B.4 audit; now consumed at runtime by Page-CUSUM under
  // Q2.B.5). Falls through to transformed-space `mean` on pre-Q2.A
  // configs lacking `mean_raw`. Family A betting-e-process retains
  // its transformed-space (Q2.A) consumption — different runtime
  // contracts; no cross-class coherence requirement (see spec
  // §Architectural mechanism).
  const cellMeanRaw = params.derivation?.mean_raw
    ?? params.derivation?.mean;
  if (cellMeanRaw === undefined) return null;
  const x = live - cellMeanRaw;
  const state = getOrCreateCUSUM(states, signal);
  return evaluateCUSUM({
    signal, params, state,
    trafficPct:       ctx.trafficPct,
    trafficGate,
    ticksSinceDeploy: ctx.ticksSinceDeploy,
    deployAgeDays:    ctx.deployAgeDays,
  }, x);
}

/** Per-tick shadow evaluator. For each primary SLI:
 *  1. Look up the cell params at `ctx.hourOfDay`.
 *  2. Compute x_n = live − cell baseline mean.
 *  3. Advance the CUSUM state (state must be supplied by caller).
 *  4. Emit `DetectorVerdict`.
 *
 *  Signals missing from either the live metrics map or the cell's params
 *  list are skipped silently — the engine runs on scenarios that may omit
 *  quality-tier signals. */
export function evaluateFamilyAShadow(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: CUSUMStates,
  ctx: FamilyAShadowCtx,
): DetectorVerdict[] {
  if (!cfg.baseline_cells) return [];
  const suppressed = schemaSuppressClassical(cfg, states, ctx);
  if (suppressed) return suppressed;

  const trafficGate = trafficGateMin(cfg);
  const cell = shadowCell(cfg, ctx);
  const out: DetectorVerdict[] = [];

  for (const signal of FAMILY_A_PRIMARY_SIGNALS) {
    if (ctx.ignoredSignals?.has(signal)) {
      out.push(ignoredVerdictClassical(states, signal));
      continue;
    }
    const v = evalSignalClassical(cfg, liveMetrics, states, cell, trafficGate, ctx, signal);
    if (v) out.push(v);
  }

  return out;
}

// ── Q66 Phase-3.d.A close (item g) → Q68 Phase-3.d.C consolidation ─────
// Howard-Ramdas-2021 mixture-supermartingale Page-CUSUM is the canonical
// Family A Page-CUSUM path post-Q68 close. Classical reset-at-zero variant
// retired from production dispatch at Q68 Phase-3.d.C consolidation
// (page_cusum_variant flag retired; no opt-in). evaluateFamilyAShadow
// (classical implementation) retained as exported helper for tools/run-nab-
// validation.ts consumption per Q64 anti-scope (full retirement at Q69 .D
// when NAB tooling re-derives for Ville-bounded variants).

/** Get-or-create a mixture-supermartingale state for `signal`. */
function getOrCreateMixture(states: MixtureSupermartingaleStates, signal: string): MixtureSupermartingaleState {
  const existing = states[signal];
  if (existing) return existing;
  const fresh = freshMixtureSupermartingaleState();
  states[signal] = fresh;
  return fresh;
}

/** Schema-continuity suppression for the mixture path. Mirrors the
 *  classical path for symmetry. Returns verdicts or null. */
function schemaSuppressMixture(
  cfg: CompiledConfig,
  states: MixtureSupermartingaleStates,
  ctx: FamilyAShadowCtx,
): DetectorVerdict[] | null {
  if (!ctx.schemaContinuityClass || !shouldSuppress(ctx.schemaContinuityClass, 'A')) {
    return null;
  }
  const reason = ctx.schemaContinuityClass === 'observability_stack'
    ? 'observability_stack_deploy' : 'schema_continuity_breaking';
  const out: DetectorVerdict[] = [];
  for (const signal of (cfg.family_a_signals ?? FAMILY_A_PRIMARY_SIGNALS)) {
    const state = getOrCreateMixture(states, signal);
    out.push({
      verdict: 'suppressed',
      statistic: state.M_t,
      threshold: null,
      alpha_consumed: 0,
      alpha_spent: 0,
      reason_code: reason,
      family: 'A',
      signal,
    });
  }
  return out;
}

/** Ignore-band suppressed verdict for the mixture path. */
function ignoredVerdictMixture(states: MixtureSupermartingaleStates, signal: string): DetectorVerdict {
  const state = getOrCreateMixture(states, signal);
  return {
    verdict: 'suppressed',
    statistic: state.M_t,
    threshold: null,
    alpha_consumed: 0,
    alpha_spent: 0,
    reason_code: 'ignore_threshold',
    family: 'A',
    signal,
    ignore_threshold_trigger_signal: signal,
  };
}

/** Evaluate one signal on the mixture-supermartingale path; null → skip. */
function evalSignalMixture(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: MixtureSupermartingaleStates,
  cell: ShadowCell,
  alphaFamilyA: number,
  bonf: number,
  signal: string,
): DetectorVerdict | null {
  const perSig = lookupFamilyAPerSignal(cfg, cell, signal);
  if (!perSig) return null;
  const live = liveMetrics[signal];
  if (live === undefined) return null;

  // Mixture-supermartingale operates on RAW observation space (Q2.B.5):
  // x_centered = live − baseline_mean_raw. Falls through to baseline_mean
  // (transformed) on pre-Q2.A configs.
  const baselineMeanRaw = perSig.baseline_mean_raw ?? perSig.baseline_mean;
  if (baselineMeanRaw === undefined) return null;
  const sigmaSquared = perSig.baseline_sigma_squared_raw
    ?? perSig.baseline_sigma_squared;
  if (sigmaSquared === undefined) return null;

  // Resolve mixture params: prefer compile-time stamp; derive on-the-fly
  // for pre-Phase-3.d.A-close configs lacking the field.
  const mixtureParams = perSig.mixture_supermartingale_params
    ?? deriveMixtureSupermartingaleParams(perSig);
  if (!mixtureParams) return null;

  // Per-signal alpha — same allocation as classical (split with betting
  // co-ship when present so the two Family A detectors share budget).
  const perSigBudget = alphaFamilyA / bonf;
  const alpha = perSig.betting_e_process_alpha !== undefined
    ? Math.max(perSigBudget - perSig.betting_e_process_alpha, perSigBudget * 0.5)
    : perSigBudget;

  const state = getOrCreateMixture(states, signal);

  const x_centered = live - baselineMeanRaw;
  const result = evaluatePageCusumMixtureSupermartingale({
    signal,
    x_centered,
    live_value: live,
    baseline_mean: baselineMeanRaw,
    sigma_squared: sigmaSquared,
    params: mixtureParams,
    ar1_phi: perSig.ar1_phi,
    state,
    alpha,
  });

  return {
    verdict: result.fire ? 'fire' : (state.S_t !== 0 ? 'indeterminate' : 'clean'),
    statistic: result.M_t,
    threshold: result.threshold,
    alpha_consumed: result.fire ? alpha : 0,
    alpha_spent: result.fire ? alpha : 0,
    reason_code: result.fire ? 'cusum_exceeded_threshold' : 'accumulating',
    family: 'A',
    signal,
  };
}

/** Per-tick mixture-supermartingale Page-CUSUM evaluator. Parallel to
 *  `evaluateFamilyAShadow` (classical) but consumes the Howard-Ramdas-2021
 *  Ville-bounded variant + AR(1) pre-whitening (Q66.A.b H1'). */
export function evaluateFamilyAShadowMixture(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: MixtureSupermartingaleStates,
  ctx: FamilyAShadowCtx,
): DetectorVerdict[] {
  if (!cfg.baseline_cells) return [];
  const suppressed = schemaSuppressMixture(cfg, states, ctx);
  if (suppressed) return suppressed;

  const cell = shadowCell(cfg, ctx);
  const out: DetectorVerdict[] = [];

  const alphaFamilyA = cfg.alpha_budget.per_family.A ?? 4e-4;
  const bonf = cfg.bonferroni_factor ?? 6;

  for (const signal of FAMILY_A_PRIMARY_SIGNALS) {
    if (ctx.ignoredSignals?.has(signal)) {
      out.push(ignoredVerdictMixture(states, signal));
      continue;
    }
    const v = evalSignalMixture(cfg, liveMetrics, states, cell, alphaFamilyA, bonf, signal);
    if (v) out.push(v);
  }

  return out;
}

/** Q68 Phase-3.d.C consolidation — top-level Family A Page-CUSUM dispatch
 *  wrapper. Always delegates to Howard-Ramdas-2021 mixture-supermartingale
 *  variant (Ville-bounded; methodology-resampler-mode invariant by
 *  construction). Classical variant retired at Q68 close; the
 *  `cusumStates` parameter is preserved in the signature for caller
 *  backward-compat (TrendBuffer.cusumStates allocation pattern) but is
 *  unused in the runtime path. */
export function evaluateFamilyA(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  _cusumStates: CUSUMStates,
  mixtureStates: MixtureSupermartingaleStates,
  ctx: FamilyAShadowCtx,
): DetectorVerdict[] {
  return evaluateFamilyAShadowMixture(cfg, liveMetrics, mixtureStates, ctx);
}

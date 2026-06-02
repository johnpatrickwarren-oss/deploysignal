// engine/detectors/_family-c-betting-eval.ts — Family C canonical
// betting-e-process: per-tick evaluator + its decomposed helpers.
//
// Split out of family-c-betting-e-process.ts (god-file decomposition).
// Behavior-preserving: the body of evaluateFamilyCBettingEProcess is
// partitioned into contiguous <100-line helpers (resolve/guards → state
// setup → tick core). No computation altered; the public name is
// re-exported by the facade.

import type {
  CompiledConfig, DetectorVerdict, FamilyCPerCell,
  SchemaContinuityRecord, FamilyCBettingEProcessState,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import { FAMILY_C_SIGNALS, lookupFamilyCParams } from './hotelling';
import { trafficGateMin } from './page-cusum';
import {
  generateBaselinePool, baselinePoolSeed, BASELINE_POOL_SIZE,
} from './sequential-mmd';
import {
  q72TraceEnabled, q72EmitProcessHeader, q72EmitCellHeader, q72EmitTick,
} from './_q72-trace';
import {
  computeRffFeatureMap, RFF_DEFAULT_DIM, type RffFeatureMap,
} from './family-c-rff';
import { DEFAULT_LAMBDA_MAX, LOG_FACTOR_FLOOR, freshFamilyCBettingEProcessState } from './_family-c-betting-state';
import {
  computeRffWitness, computeKernelMMDWitness, onsUpdate, liveVectorFamilyC,
} from './_family-c-betting-witness';

type EvalCtx = {
  hourOfDay: number;
  dayOfWeek?: number;
  ticksSinceDeploy: number;
  deployAgeDays: number;
  trafficPct: number;
  schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  tenantId?: string;
};

type StateBag = Record<string, FamilyCBettingEProcessState | number[][] | unknown>;

/** Most-constrained bake profile across Family C signals. Local copy
 *  (mirrors sequential-mmd.ts mmdBakeProfile) so this detector doesn't
 *  pull a private export from sibling. */
function familyCBakeProfile(cfg: CompiledConfig): { min_ticks: number; max_days: number } {
  const profiles = cfg.bake_profiles ?? {};
  let maxMinTicks = 0;
  let maxMaxDays = Infinity;
  let any = false;
  const signals = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
  for (const sig of signals) {
    const p = profiles[sig];
    if (!p) continue;
    any = true;
    if (p.min_ticks_before_eligible > maxMinTicks) maxMinTicks = p.min_ticks_before_eligible;
    if (p.max_deploy_window_days < maxMaxDays) maxMaxDays = p.max_deploy_window_days;
  }
  if (!any) return { min_ticks: 3, max_days: 1 };
  return { min_ticks: maxMinTicks, max_days: Number.isFinite(maxMaxDays) ? maxMaxDays : 1 };
}

function suppressedVerdict(reason: string, threshold: number, statistic: number | null): DetectorVerdict {
  return {
    verdict: 'suppressed', statistic, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: reason, family: 'C',
    signal: 'sequential_mmd_betting_e_process',
  };
}

/** Resolved cell + gating outcome. `verdict` set ⇒ short-circuit return
 *  that exact verdict; `skip` true ⇒ detector returns null; otherwise
 *  `cell`/`v` carry the projected inputs for the tick core. */
type Resolved =
  | { skip: true }
  | { verdict: DetectorVerdict }
  | {
      params: FamilyCPerCell;
      bp: NonNullable<FamilyCPerCell['betting_e_process_params']>;
      tier: string | undefined;
      lambdaMax: number;
      log_threshold: number;
      threshold: number;
      v: number[];
      rffActive: boolean;
      D: number;
    };

/** Config/lookup/schema/bake/traffic/live-vector guards. Mirrors the
 *  original evaluator's early-return ladder VERBATIM. */
function resolveCell(cfg: CompiledConfig, liveMetrics: Record<string, number | undefined>, ctx: EvalCtx): Resolved {
  if (!cfg.baseline_cells) return { skip: true };
  const tier = resolveTenantTier(cfg, ctx.tenantId);
  const lookup = lookupFamilyCParams(cfg, {
    hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek, tenant_tier: tier,
  });
  if (!lookup) return { skip: true };
  const params: FamilyCPerCell = lookup.params;

  // Q68 Phase-3.d.C consolidation — `mmd_variant` flag retired; Family C
  // MMD dispatch is unconditional Ville-bounded variant. Detector self-
  // gates on `betting_e_process_params` presence (Q67 v2 compile output).
  const bp = params.betting_e_process_params;
  if (!bp) return { skip: true };  // cell not compiled with Q67 params (pre-Phase-3.d.B)

  const lambdaMax = bp.lambda_max ?? DEFAULT_LAMBDA_MAX;
  const log_threshold = -Math.log(bp.alpha);  // log(1/α); compare in log-space

  // Schema continuity suppression — same rule as sibling Family C detectors.
  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'C')) {
    return { verdict: suppressedVerdict(
      ctx.schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      Math.exp(log_threshold), null,
    ) };
  }

  // Bake-profile + age gate — same most-constrained profile as Hotelling.
  const bake = familyCBakeProfile(cfg);
  const threshold = Math.exp(log_threshold);
  if (ctx.ticksSinceDeploy < bake.min_ticks) return { verdict: suppressedVerdict('bake_profile_not_met', threshold, null) };
  if (ctx.deployAgeDays > bake.max_days) return { verdict: suppressedVerdict('bake_profile_not_met', threshold, null) };
  if (ctx.trafficPct < trafficGateMin(cfg)) return { verdict: suppressedVerdict('traffic_pct_below_gate', threshold, null) };

  // Project live metrics into the Family C relative-deviation vector.
  const v = liveVectorFamilyC(liveMetrics, params.mean_vector, cfg.family_c_signals ?? FAMILY_C_SIGNALS);
  if (v === null) return { skip: true };

  // Q72 SLICE 2 — RFF mode active when calibrator stamped baseline_rff_mean.
  const rffActive = bp.baseline_rff_mean !== undefined && bp.baseline_rff_mean.length > 0;
  const D = rffActive ? (bp.rff_dim ?? RFF_DEFAULT_DIM) : 0;

  return { params, bp, tier, lambdaMax, log_threshold, threshold, v, rffActive, D };
}

/** Per-cell runtime resources: wealth state, RFF feature map, baseline
 *  pool — created/cached on the caller's state bag. Mirrors the original
 *  evaluator's stateKey/fmKey/poolKey blocks VERBATIM. */
function setupCellState(
  states: StateBag, ctx: EvalCtx, r: Extract<Resolved, { v: number[] }>,
): { stateKey: string; state: FamilyCBettingEProcessState; fm: RffFeatureMap | undefined; pool: number[][] | undefined } {
  const { bp, tier, v, rffActive, D } = r;

  // Per-(tier, hour, day) state. Mirrors evaluateEMmd's stateKey pattern.
  const stateKey = `__fc_betting_${tier ?? 'none'}_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let state = states[stateKey] as FamilyCBettingEProcessState | undefined;
  if (!state || typeof state.log_S_t !== 'number') {
    state = freshFamilyCBettingEProcessState(v.length, rffActive ? D : undefined);
    states[stateKey] = state;
  }
  // Lazy init for Q72 SLICE 2 RFF state when state was created pre-RFF.
  if (rffActive && state.q_running_phi_sum === undefined) {
    state.q_running_phi_sum = new Array<number>(D).fill(0);
  }

  // Q72 SLICE 2 — RFF feature map cached per cell by stateKey + rff_seed.
  const fmKey = `__rff_fm_${stateKey}`;
  let fm: RffFeatureMap | undefined;
  if (rffActive) {
    fm = states[fmKey] as RffFeatureMap | undefined;
    if (!fm) {
      fm = computeRffFeatureMap(bp.rff_seed ?? 0, D, v.length, bp.kernel_bandwidth_sigma);
      states[fmKey] = fm;
    }
  }

  // Baseline pool — reuse Sequential MMD's pseudo-sampling (Cholesky·w).
  const poolKey = `__mmd_pool_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let pool = states[poolKey] as number[][] | undefined;
  if (!rffActive && (!pool || pool.length === 0)) {
    const poolSize = bp.baseline_sample_size && bp.baseline_sample_size > 0
      ? bp.baseline_sample_size : BASELINE_POOL_SIZE;
    pool = generateBaselinePool(
      r.params, poolSize,
      baselinePoolSeed({ hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek }),
    );
    states[poolKey] = pool;
  }

  return { stateKey, state, fm, pool };
}

/** Q72 Phase-1 pre-mutation trace snapshot (captured BEFORE witness/wealth
 *  mutation). No-op fast path when Q72_TRACE unset. */
type TracePre = {
  log_S_t: number; lambda: number; hessian: number; witnessMax: number;
  qCount: number; qSumHash: number; vSum: number; tickId: number;
};

function captureTracePre(
  state: FamilyCBettingEProcessState, v: number[], rffActive: boolean,
): TracePre {
  const pre: TracePre = {
    log_S_t: state.log_S_t, lambda: state.ons_lambda, hessian: state.ons_inverse_hessian,
    witnessMax: state.witness_running_max, qCount: state.q_count,
    qSumHash: 0, vSum: 0, tickId: state.n,
  };
  if (q72TraceEnabled()) {
    if (rffActive && state.q_running_phi_sum) {
      for (const x of state.q_running_phi_sum) pre.qSumHash += x;
    } else {
      for (const x of state.q_running_sum) pre.qSumHash += x;
    }
    for (const x of v) pre.vSum += x;
  }
  return pre;
}

/** Compute the predictable witness F_t for this tick (RFF unbiased path or
 *  legacy biased streaming path). Returns phi_x for RFF Q-side bookkeeping. */
function computeWitness(
  r: Extract<Resolved, { v: number[] }>, state: FamilyCBettingEProcessState,
  fm: RffFeatureMap | undefined, pool: number[][] | undefined,
): { F_t: number; phi_x: Float64Array | null } {
  const { bp, v, rffActive } = r;
  if (rffActive && fm && bp.baseline_rff_mean && state.q_running_phi_sum) {
    const w = computeRffWitness(v, bp.baseline_rff_mean, state.q_running_phi_sum, state.q_count, fm);
    return { F_t: w.F_t, phi_x: w.phi_x };
  }
  const F_t = computeKernelMMDWitness(
    v, pool ?? [], state.q_running_sum, state.q_count,
    bp.kernel_bandwidth_sigma, state.witness_running_max, state.n,
  );
  return { F_t, phi_x: null };
}

/** Wealth update + ONS bet update + streaming Q-side bookkeeping (mutates
 *  state in-place, in the canonical order). */
function applyTickUpdate(
  r: Extract<Resolved, { v: number[] }>, state: FamilyCBettingEProcessState,
  F_t: number, phi_x: Float64Array | null,
): { wealth_factor: number; log_factor: number } {
  const { v, lambdaMax, rffActive } = r;

  // Wealth update: log_S_t += log(1 + λ_{t−1}·F_t).
  const wealth_factor = 1 + state.ons_lambda * F_t;
  const log_factor = Math.log(Math.max(wealth_factor, LOG_FACTOR_FLOOR));
  state.log_S_t += log_factor;

  // ONS bet update for next tick (predictable; uses current F_t).
  onsUpdate(state, F_t, lambdaMax);

  // Streaming Q-side bookkeeping (mutate AFTER witness computation).
  if (rffActive && phi_x && state.q_running_phi_sum) {
    const phiSum = state.q_running_phi_sum;
    for (let i = 0; i < phi_x.length; i++) phiSum[i] += phi_x[i];
  }
  for (let i = 0; i < v.length; i++) state.q_running_sum[i] += v[i];
  state.q_count += 1;
  state.n += 1;

  // Update witness running-max (used by next tick's normalization at n>10).
  const absF = Math.abs(F_t);
  if (absF > state.witness_running_max) state.witness_running_max = absF;

  return { wealth_factor, log_factor };
}

/** Ville-bound fire check (log-space). Mutates fire/alpha state; returns the
 *  verdict + whether it fired this tick (for the trace emit). */
function fireCheck(
  r: Extract<Resolved, { v: number[] }>, state: FamilyCBettingEProcessState,
): { result: DetectorVerdict; verdictLabel: string; firedThisTick: boolean } {
  const { bp, log_threshold, threshold } = r;
  const S_t_audit = state.log_S_t > 700 ? Number.MAX_VALUE : Math.exp(state.log_S_t);
  if (state.log_S_t >= log_threshold) {
    const alphaSpent = Math.max(0, bp.alpha - state.alphaConsumed);
    state.alphaConsumed = bp.alpha;
    let firedThisTick = false;
    if (!state.fired) {
      state.fired = true;
      state.tick_at_first_fire = state.n;
      firedThisTick = true;
    }
    return {
      result: {
        verdict: 'fire', statistic: S_t_audit, threshold,
        alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
        reason_code: 'family_c_betting_wealth_exceeded',
        family: 'C', signal: 'sequential_mmd_betting_e_process',
      },
      verdictLabel: 'fire', firedThisTick,
    };
  }
  return {
    result: {
      verdict: 'clean', statistic: S_t_audit, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'below_threshold', family: 'C',
      signal: 'sequential_mmd_betting_e_process',
    },
    verdictLabel: 'clean', firedThisTick: false,
  };
}

/** Evaluate the canonical Shekhar-Ramdas-2023 betting-e-process variant
 *  at one tick. Pattern mirrors `evaluateEMmd`: shared cell lookup +
 *  bake-profile guard + traffic gate + schema-continuity suppression.
 *  Returns null when:
 *    - cfg.baseline_cells absent (pre-#18 config)
 *    - cell lookup fails
 *    - cell missing betting_e_process_params (pre-Q67 / non-applicable cell)
 *    - liveMetrics missing any Family C signal */
export function evaluateFamilyCBettingEProcess(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: StateBag,
  ctx: EvalCtx,
): DetectorVerdict | null {
  const r = resolveCell(cfg, liveMetrics, ctx);
  if ('skip' in r) return null;
  if ('verdict' in r) return r.verdict;

  const { stateKey, state, fm, pool } = setupCellState(states, ctx, r);

  // Q72 Phase 1 instrumentation — emit headers on first call / first cell.
  if (q72TraceEnabled()) {
    q72EmitProcessHeader();
    q72EmitCellHeader(stateKey, {
      kernel_bandwidth_sigma: r.bp.kernel_bandwidth_sigma,
      lambda_max: r.bp.lambda_max,
      betting_strategy: r.bp.betting_strategy,
      ons_initial_lambda: r.bp.ons_initial_lambda,
      alpha: r.bp.alpha,
      baseline_sample_size: r.bp.baseline_sample_size,
      rff_active: r.rffActive,
      rff_seed: r.bp.rff_seed,
      rff_dim: r.bp.rff_dim,
    }, r.rffActive ? [] : (pool ?? []).slice(0, 5), r.rffActive ? 0 : (pool?.length ?? 0));
  }

  const pre = captureTracePre(state, r.v, r.rffActive);

  // ── Predictable witness F_t (computed BEFORE Q-side mutation) ───────
  const { F_t, phi_x } = computeWitness(r, state, fm, pool);

  // ── Wealth + ONS + bookkeeping ──────────────────────────────────────
  const { wealth_factor, log_factor } = applyTickUpdate(r, state, F_t, phi_x);

  // ── Ville-bound fire check ──────────────────────────────────────────
  const { result, verdictLabel, firedThisTick } = fireCheck(r, state);

  // Q72 Phase 1 instrumentation — emit per-tick record AFTER all mutations.
  if (q72TraceEnabled()) {
    q72EmitTick({
      cell_key: stateKey,
      tick_id: pre.tickId,
      log_S_t_pre: pre.log_S_t,
      ons_lambda_pre: pre.lambda,
      ons_inverse_hessian_pre: pre.hessian,
      witness_running_max: pre.witnessMax,
      q_count: pre.qCount,
      q_running_sum_hash: pre.qSumHash,
      v_first_3: r.v.slice(0, 3),
      v_sum: pre.vSum,
      F_t,
      wealth_factor,
      log_factor,
      log_S_t_post: state.log_S_t,
      ons_lambda_post: state.ons_lambda,
      ons_inverse_hessian_post: state.ons_inverse_hessian,
      verdict: verdictLabel,
      fired_this_tick: firedThisTick,
    });
  }
  return result;
}

// engine/detectors/family-c-betting-e-process.ts — Family C canonical
// Shekhar-Ramdas-2023 betting-e-process variant (Q67 SPEC Phase-3.d.B).
//
// Per Q67-PHASE-3-D-B-MMD-BETTING-E-PROCESS-SPEC.md § Q67.2 v2 (architect-
// drafted; canonical-aligned via library cross-check at
// `github.com/sshekhar17/nonparametric-testing-by-betting`):
//
//   `kernelMMD.py kernelMMDprediction` lines 57-92 — predictable witness
//      F[i] with running-max normalization at i > 10.
//   `SeqTestsUtils.py:11-38 ONSstrategy(F, lambda_max=0.5)` — ONS update
//      with c = 2/(2−log(3)) ≈ 1.6336, A_0 = 1, two-sided clamp.
//   `kernelMMD.py computeMMD` lines 14-54 — biased V-statistic MMD
//      estimator (denominators include diagonal).
//
// Wealth recursion (Shekhar-Ramdas 2023):
//
//   F_t = W_{t−1}(x_t)                        (kernel-MMD witness payoff)
//   S_t = S_{t−1} · (1 + λ_{t−1} · F_t)       (multiplicative wealth)
//   Fire when S_t ≥ 1/α                       (Ville bound; anytime-valid)
//
// ONS update (predictable; A_t F_{t-1}-measurable):
//
//   z_t = −F_t / (1 + λ_{t−1}·F_t)             (gradient; canonical sign)
//   A_t = A_{t−1} + z_t²                       (accumulated Hessian)
//   λ_t = clamp(λ_{t−1} − c·z_t/A_t, ±λ_max)   (Cutkosky-Orabona 2018 step)
//
// Distinct from existing #20 evaluateEMmd in sequential-mmd.ts —
// evaluateEMmd implements the Option-B simplification (kernel-distance
// scalar fed through GRAPA/ONS-fallback `pickBet`); this file implements
// the canonical Shekhar-Ramdas-2023 ONS variant with split-sample witness
// + running-max normalization + canonical hyperparameters. Both coexist
// at SLICE 1 — runtime dispatcher (sequential-mmd.ts; Step 3) picks per
// `mmd_variant` flag on the per-cell calibration.
//
// State management mirrors Q66 Phase-3.d.A SLICE 1 pattern: per-(tier,
// hour, day) cell-keyed state on the caller's state bag; persists across
// ticks within a deploy; orchestrator caller owns lifetime (not re-keyed
// across deploys — same convention as evaluateEMmd).
//
// Streaming-adapted predictable witness — DeploySignal use case has P
// fixed (per-cell baseline) + Q streaming (1 obs/tick). Q-side empirical
// distribution stored as running-sum / running-count (O(d) state); Q-side
// kernel evaluated at the empirical mean per coordinate. Predictability
// preserved because state.q_running_sum / state.q_count reflect ONLY past
// observations (mutated AFTER witness computation; mirrors architect-
// drafted pseudo-code line ordering).

import type {
  CompiledConfig, DetectorVerdict, FamilyCPerCell,
  SchemaContinuityRecord, FamilyCBettingEProcessState,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import { FAMILY_C_SIGNALS, lookupFamilyCParams } from './hotelling';
import { trafficGateMin } from './page-cusum';
import {
  rbf, generateBaselinePool, baselinePoolSeed, BASELINE_POOL_SIZE,
} from './sequential-mmd';
import {
  q72TraceEnabled, q72EmitProcessHeader, q72EmitCellHeader, q72EmitTick,
} from './_q72-trace';
import {
  computeRffFeatureMap, applyRffFeatureMap, rffDot, RFF_DEFAULT_DIM,
  type RffFeatureMap,
} from './family-c-rff';

/** Canonical ONS step-size constant per Cutkosky-Orabona 2018 with `+λF`
 *  payoff sign convention (Shekhar-Ramdas 2023 ONSstrategy docstring:
 *  "a `+` instead of `−` used by Cutkosky & Orabona (2018)"). Architecturally
 *  fixed — not B-dependent (architect v1 mistakenly tied to B; v2 amended
 *  post-library-cross-check). */
const ONS_STEP_SIZE_C = 2 / (2 - Math.log(3));  // ≈ 1.6336

/** Numerical guard for Math.log(0) on wealth-factor underflow. Mirrors
 *  evaluateEMmd's WEALTH_FLOOR convention. */
const LOG_FACTOR_FLOOR = 1e-12;

/** Witness running-max normalization activates after this many ticks per
 *  canonical kernelMMDprediction lines 57-92. Quote: "a heuristic that
 *  significantly improves the practical performance". */
const WITNESS_NORMALIZATION_THRESHOLD = 10;

/** Default λ_max if FamilyCBettingEProcessParams.lambda_max absent —
 *  canonical 0.5 per `ONSstrategy(F, lambda_max=0.5)` signature. */
const DEFAULT_LAMBDA_MAX = 0.5;

/** Initial wealth state for a new (deploy, cell) Q67 v2 evaluation.
 *
 *  `p` is the input dimension (Family C joint-vector size, typically 11).
 *  `D` is optional Q72 SLICE 2 RFF feature dimension; when provided,
 *  the state pre-allocates q_running_phi_sum ∈ R^D for the unbiased
 *  RFF witness path. Absent ⇒ legacy state shape (q_running_phi_sum
 *  not initialized; runtime falls back to biased streaming witness). */
export function freshFamilyCBettingEProcessState(
  p: number, D?: number,
): FamilyCBettingEProcessState {
  const state: FamilyCBettingEProcessState = {
    log_S_t: 0,                  // S_0 = 1 ⇒ log_S_0 = 0
    ons_lambda: 0,               // canonical λ_0 = 0 (no bet at start)
    ons_inverse_hessian: 1,      // canonical A_0 = 1 (implicit regularization)
    n: 0,
    witness_running_max: 0,
    q_running_sum: new Array<number>(p).fill(0),
    q_count: 0,
    fired: false,
    tick_at_first_fire: null,
    alphaConsumed: 0,
  };
  if (D !== undefined && D > 0) {
    state.q_running_phi_sum = new Array<number>(D).fill(0);
  }
  return state;
}

/** Q72 SLICE 2 (Phase 3.A) — unbiased RFF witness payoff F_t at
 *  observation x_t.
 *
 *  Witness construction:
 *    F_t = φ(x_t) · (μ_P^φ - μ_Q^φ)
 *    μ_Q^φ = (1/q_count) · q_running_phi_sum
 *
 *  Predictability: μ_Q^φ at tick t reflects ONLY past observations —
 *  caller MUST invoke this BEFORE updating q_running_phi_sum with
 *  the current φ(x_t). At q_count = 0 (first observation) the Q-side
 *  contribution is zero — F_1 carries only P-side anchor information,
 *  matching the canonical kernelMMDprediction i=0 boundary.
 *
 *  Linearity → unbiased: φ is a fixed linear feature map, so the
 *  Q-side empirical-mean of φ(X_j) is unbiased for E_X[φ(X)] (no
 *  Jensen's-inequality bias as in the legacy kernel-of-empirical-mean
 *  approximation; see `coordination/DIAGNOSTIC-Q72-PHASE-1-...md`).
 *
 *  Returns { F_t, phi_x } so the caller can update q_running_phi_sum
 *  AFTER computing F_t without re-applying the feature map. */
export function computeRffWitness(
  x_t: number[],
  baseline_rff_mean: ReadonlyArray<number> | Float64Array,
  q_running_phi_sum: ReadonlyArray<number> | Float64Array,
  q_count: number,
  fm: RffFeatureMap,
): { F_t: number; phi_x: Float64Array } {
  const phi_x = applyRffFeatureMap(x_t, fm);
  const D = fm.D;
  // Compute F_t = φ(x_t) · μ_P^φ − φ(x_t) · μ_Q^φ.
  // At q_count = 0, Q-side contribution is exactly zero.
  let f = 0;
  if (q_count > 0) {
    const inv_q = 1 / q_count;
    for (let i = 0; i < D; i++) {
      f += phi_x[i] * (baseline_rff_mean[i] - q_running_phi_sum[i] * inv_q);
    }
  } else {
    for (let i = 0; i < D; i++) f += phi_x[i] * baseline_rff_mean[i];
  }
  return { F_t: f, phi_x };
}

/** Compute the kernel-MMD witness payoff F_t at observation x_t.
 *
 *  Per canonical kernelMMD.py:57-92 kernelMMDprediction (streaming-adapted
 *  per Q67.4-ter "Witness paired-samples vs streaming adaptation"):
 *
 *    F_t = (1/N_P) Σ_i K(x_t, x_P_i)  −  K(x_t, μ_{Q_{t−1}})
 *
 *  where x_P_i are P-side baseline samples (size N_baseline; deterministic
 *  pseudo-pool from Cholesky(Σ) — same generator as sequential-mmd.ts) and
 *  μ_{Q_{t−1}} = (q_running_sum / q_count) is the empirical mean of past
 *  Q-side observations. Streaming approximation (kernel-of-empirical-mean
 *  vs sum-of-kernels) preserves O(d) state per Q67.4-ter; predictability
 *  preserved because q_running_sum reflects only past observations.
 *
 *  Running-max normalization at n > WITNESS_NORMALIZATION_THRESHOLD —
 *  divides F_t by max of past |F| values to keep witness bounded around
 *  unity (canonical comment: "heuristic that significantly improves the
 *  practical performance"). */
export function computeKernelMMDWitness(
  x_t: number[],
  baseline_pool: number[][],
  q_running_sum: number[],
  q_count: number,
  bandwidth: number,
  witness_running_max: number,
  n: number,
): number {
  // P-side mean kernel: (1/N_P) Σ K(x_t, x_P_i).
  let p_sum = 0;
  for (const yp of baseline_pool) p_sum += rbf(x_t, yp, bandwidth);
  const p_mean = p_sum / baseline_pool.length;

  // Q-side kernel-of-empirical-mean. At n=0 (no past observations) Q-side
  // contribution is zero — F_1 carries only P-side anchor information,
  // matching canonical kernelMMDprediction's i=0 boundary.
  let q_kernel = 0;
  if (q_count > 0) {
    const p = q_running_sum.length;
    const q_mean_vec = new Array<number>(p);
    for (let i = 0; i < p; i++) q_mean_vec[i] = q_running_sum[i] / q_count;
    q_kernel = rbf(x_t, q_mean_vec, bandwidth);
  }

  let F_t = p_mean - q_kernel;

  // Running-max normalization at n > 10 per canonical lines 57-92.
  if (n > WITNESS_NORMALIZATION_THRESHOLD && witness_running_max > 0) {
    F_t = F_t / witness_running_max;
  }

  return F_t;
}

/** ONS predictable bet update per canonical SeqTestsUtils.py:11-38
 *  ONSstrategy. Mutates `state.ons_lambda` and `state.ons_inverse_hessian`
 *  in-place; clamps λ_t to two-sided range [-λ_max, +λ_max] per Q67.4-bis
 *  v2 amendment (canonical default λ_max = 0.5).
 *
 *  Update rule:
 *    z_t = −F_t / (1 + λ_{t−1}·F_t)      gradient (canonical sign convention)
 *    A_t = A_{t−1} + z_t²                 accumulated Hessian (init A_0 = 1)
 *    λ_t = λ_{t−1} − c·z_t/A_t            ONS step (c = 2/(2−log(3)) ≈ 1.6336)
 *
 *  Numerical guard: if |1 + λ·F| < 1e-12 (wealth-factor near zero — would
 *  produce ±∞ gradient), skip the update and preserve λ unchanged.
 *  Practical edge case only at boundary |λ·F| ≈ 1; the wealth-factor floor
 *  in the caller's wealth update prevents log(0). */
export function onsUpdate(
  state: FamilyCBettingEProcessState,
  F_t: number,
  lambda_max: number,
): void {
  const denom = 1 + state.ons_lambda * F_t;
  if (Math.abs(denom) < 1e-12) return;  // skip on degenerate denom
  const z = -F_t / denom;
  state.ons_inverse_hessian += z * z;
  let lambda_new = state.ons_lambda - (ONS_STEP_SIZE_C * z) / state.ons_inverse_hessian;
  if (lambda_new > lambda_max) lambda_new = lambda_max;
  else if (lambda_new < -lambda_max) lambda_new = -lambda_max;
  state.ons_lambda = lambda_new;
}

/** Project live metrics into the Family C relative-deviation vector.
 *  Returns null when any consumed signal is missing (detector skips that
 *  tick) — same convention as evaluateEMmd / evaluateSequentialMMD. */
function liveVectorFamilyC(
  liveMetrics: Record<string, number | undefined>,
  mean: number[],
  signals: readonly string[],
): number[] | null {
  const p = signals.length;
  const v = new Array<number>(p);
  for (let i = 0; i < p; i++) {
    const live = liveMetrics[signals[i]];
    if (live === undefined) return null;
    const m = mean[i];
    v[i] = Math.abs(m) > 1e-12 ? (live - m) / m : (live - m);
  }
  return v;
}

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

/** Evaluate the canonical Shekhar-Ramdas-2023 betting-e-process variant
 *  at one tick. Pattern mirrors `evaluateEMmd`: shared cell lookup +
 *  bake-profile guard + traffic gate + schema-continuity suppression.
 *  Returns null when:
 *    - cfg.baseline_cells absent (pre-#18 config)
 *    - cell lookup fails
 *    - cell tagged with mmd_variant !== 'betting_e_process' (dispatcher route)
 *    - cell missing betting_e_process_params (pre-Q67 config or non-applicable cell)
 *    - liveMetrics missing any Family C signal */
export function evaluateFamilyCBettingEProcess(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: Record<string, FamilyCBettingEProcessState | number[][] | unknown>,
  ctx: {
    hourOfDay: number;
    dayOfWeek?: number;
    ticksSinceDeploy: number;
    deployAgeDays: number;
    trafficPct: number;
    schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
    tenantId?: string;
  },
): DetectorVerdict | null {
  if (!cfg.baseline_cells) return null;
  const tier = resolveTenantTier(cfg, ctx.tenantId);
  const lookup = lookupFamilyCParams(cfg, {
    hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek, tenant_tier: tier,
  });
  if (!lookup) return null;
  const params: FamilyCPerCell = lookup.params;

  // Q68 Phase-3.d.C consolidation — `mmd_variant` flag retired; Family C
  // MMD dispatch is unconditional Ville-bounded variant. Detector self-
  // gates on `betting_e_process_params` presence (Q67 v2 compile output).
  const bp = params.betting_e_process_params;
  if (!bp) return null;  // cell not compiled with Q67 params (pre-Phase-3.d.B)

  const lambdaMax = bp.lambda_max ?? DEFAULT_LAMBDA_MAX;
  const log_threshold = -Math.log(bp.alpha);  // log(1/α); compare in log-space

  // Schema continuity suppression — same rule as sibling Family C
  // detectors (Family C as a whole suppresses on breaking schema; #8).
  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'C')) {
    return suppressedVerdict(
      ctx.schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      Math.exp(log_threshold), null,
    );
  }

  // Bake-profile + age gate — same most-constrained profile as Hotelling.
  const bake = familyCBakeProfile(cfg);
  const threshold = Math.exp(log_threshold);
  if (ctx.ticksSinceDeploy < bake.min_ticks) return suppressedVerdict('bake_profile_not_met', threshold, null);
  if (ctx.deployAgeDays > bake.max_days) return suppressedVerdict('bake_profile_not_met', threshold, null);
  if (ctx.trafficPct < trafficGateMin(cfg)) return suppressedVerdict('traffic_pct_below_gate', threshold, null);

  // Project live metrics into the Family C relative-deviation vector.
  const v = liveVectorFamilyC(liveMetrics, params.mean_vector, cfg.family_c_signals ?? FAMILY_C_SIGNALS);
  if (v === null) return null;

  // Q72 SLICE 2 — RFF mode active when calibrator stamped baseline_rff_mean.
  // Falls through to legacy biased streaming witness when absent (preserves
  // replay of pre-Q72-SLICE-2 audit logs).
  const rffActive = bp.baseline_rff_mean !== undefined && bp.baseline_rff_mean.length > 0;
  const D = rffActive ? (bp.rff_dim ?? RFF_DEFAULT_DIM) : 0;

  // Per-(tier, hour, day) state. Mirrors evaluateEMmd's stateKey pattern.
  const stateKey = `__fc_betting_${tier ?? 'none'}_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let state = states[stateKey] as FamilyCBettingEProcessState | undefined;
  if (!state || typeof state.log_S_t !== 'number') {
    state = freshFamilyCBettingEProcessState(v.length, rffActive ? D : undefined);
    states[stateKey] = state;
  }
  // Lazy init for Q72 SLICE 2 RFF state when state was created pre-RFF
  // but cell config now carries RFF params (e.g., calibrator recompiled).
  if (rffActive && state.q_running_phi_sum === undefined) {
    state.q_running_phi_sum = new Array<number>(D).fill(0);
  }

  // Q72 SLICE 2 — RFF feature map cached per cell by stateKey + rff_seed.
  // Recomputed deterministically from seed if cache absent (e.g., first
  // dispatch after process boot). Same seed produces byte-identical
  // ω + b across Darwin/Linux per cross-platform-determinism gate.
  const fmKey = `__rff_fm_${stateKey}`;
  let fm: RffFeatureMap | undefined;
  if (rffActive) {
    fm = states[fmKey] as RffFeatureMap | undefined;
    if (!fm) {
      fm = computeRffFeatureMap(
        bp.rff_seed ?? 0, D, v.length, bp.kernel_bandwidth_sigma,
      );
      states[fmKey] = fm;
    }
  }

  // Baseline pool — reuse Sequential MMD's pseudo-sampling (Cholesky·w).
  // Cache by cell key; same seed function as evaluateEMmd / evaluateSequentialMMD
  // so all three variants agree on the P-side reference set under shadow-compare.
  // RFF mode skips building the pool at runtime (μ_P^φ is precomputed at
  // calibration time and stored in bp.baseline_rff_mean) — pool is only
  // needed for the legacy streaming-witness path.
  const poolKey = `__mmd_pool_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let pool = states[poolKey] as number[][] | undefined;
  if (!rffActive && (!pool || pool.length === 0)) {
    const poolSize = bp.baseline_sample_size && bp.baseline_sample_size > 0
      ? bp.baseline_sample_size : BASELINE_POOL_SIZE;
    pool = generateBaselinePool(
      params, poolSize,
      baselinePoolSeed({ hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek }),
    );
    states[poolKey] = pool;
  }

  // Q72 Phase 1 instrumentation — emit headers on first call / first cell.
  // No-op fast-path when Q72_TRACE env var unset.
  if (q72TraceEnabled()) {
    q72EmitProcessHeader();
    q72EmitCellHeader(stateKey, {
      kernel_bandwidth_sigma: bp.kernel_bandwidth_sigma,
      lambda_max: bp.lambda_max,
      betting_strategy: bp.betting_strategy,
      ons_initial_lambda: bp.ons_initial_lambda,
      alpha: bp.alpha,
      baseline_sample_size: bp.baseline_sample_size,
      rff_active: rffActive,
      rff_seed: bp.rff_seed,
      rff_dim: bp.rff_dim,
    }, rffActive ? [] : (pool ?? []).slice(0, 5), rffActive ? 0 : (pool?.length ?? 0));
  }

  // Q72 trace — capture pre-state BEFORE any mutation.
  const _q72_log_S_t_pre = state.log_S_t;
  const _q72_lambda_pre = state.ons_lambda;
  const _q72_hessian_pre = state.ons_inverse_hessian;
  const _q72_witness_max_pre = state.witness_running_max;
  const _q72_q_count_pre = state.q_count;
  let _q72_q_sum_hash = 0;
  if (q72TraceEnabled()) {
    if (rffActive && state.q_running_phi_sum) {
      for (const x of state.q_running_phi_sum) _q72_q_sum_hash += x;
    } else {
      for (const x of state.q_running_sum) _q72_q_sum_hash += x;
    }
  }
  let _q72_v_sum = 0;
  if (q72TraceEnabled()) {
    for (const x of v) _q72_v_sum += x;
  }
  const _q72_tick_id = state.n;  // pre-increment value

  // ── Predictable witness F_t ────────────────────────────────────────
  // Computed BEFORE q_running_sum / q_running_phi_sum mutation — F_t is
  // F_{t-1}-measurable.
  let F_t: number;
  let phi_x: Float64Array | null = null;
  if (rffActive && fm && bp.baseline_rff_mean && state.q_running_phi_sum) {
    // Q72 SLICE 2 unbiased RFF witness: F_t = φ(x_t) · (μ_P^φ - μ_Q^φ).
    const w = computeRffWitness(
      v, bp.baseline_rff_mean, state.q_running_phi_sum,
      state.q_count, fm,
    );
    F_t = w.F_t;
    phi_x = w.phi_x;
  } else {
    // Legacy biased streaming witness (Q67 §Q67.4-ter; pre-Q72-SLICE-2
    // configs only — backward-compat for replay of pre-fix audit logs).
    F_t = computeKernelMMDWitness(
      v, pool ?? [], state.q_running_sum, state.q_count,
      bp.kernel_bandwidth_sigma, state.witness_running_max, state.n,
    );
  }

  // ── Wealth update: log_S_t += log(1 + λ_{t−1}·F_t) ──────────────────
  // Log-space comparison avoids exp(log_S_t) overflow at large wealth.
  const wealth_factor = 1 + state.ons_lambda * F_t;
  const log_factor = Math.log(Math.max(wealth_factor, LOG_FACTOR_FLOOR));
  state.log_S_t += log_factor;

  // ── ONS bet update for next tick (predictable; uses current F_t) ────
  onsUpdate(state, F_t, lambdaMax);

  // ── Streaming Q-side bookkeeping (mutate AFTER witness computation) ──
  if (rffActive && phi_x && state.q_running_phi_sum) {
    // Q72 SLICE 2: update RFF Q-side empirical-mean numerator with this
    // tick's φ(x_t). The legacy q_running_sum is also updated to keep
    // pre-Q72-SLICE-2 audit-replay state coherent (ignored by the RFF
    // witness path).
    const phiSum = state.q_running_phi_sum;
    for (let i = 0; i < phi_x.length; i++) phiSum[i] += phi_x[i];
  }
  for (let i = 0; i < v.length; i++) state.q_running_sum[i] += v[i];
  state.q_count += 1;
  state.n += 1;

  // Update witness running-max (used by next tick's normalization at n>10).
  const absF = Math.abs(F_t);
  if (absF > state.witness_running_max) state.witness_running_max = absF;

  // ── Ville-bound fire check (in log-space for numerical stability) ────
  // Materialize S_t for audit visibility; use Math.exp guarded against
  // inf overflow at extreme wealth (rare but real on prolonged H₁ runs).
  const S_t_audit = state.log_S_t > 700 ? Number.MAX_VALUE : Math.exp(state.log_S_t);
  let _q72_verdict: string;
  let _q72_fired_this_tick = false;
  let _q72_result: DetectorVerdict;
  if (state.log_S_t >= log_threshold) {
    const alphaSpent = Math.max(0, bp.alpha - state.alphaConsumed);
    state.alphaConsumed = bp.alpha;
    if (!state.fired) {
      state.fired = true;
      state.tick_at_first_fire = state.n;
      _q72_fired_this_tick = true;
    }
    _q72_verdict = 'fire';
    _q72_result = {
      verdict: 'fire', statistic: S_t_audit, threshold,
      alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
      reason_code: 'family_c_betting_wealth_exceeded',
      family: 'C',
      signal: 'sequential_mmd_betting_e_process',
    };
  } else {
    _q72_verdict = 'clean';
    _q72_result = {
      verdict: 'clean', statistic: S_t_audit, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'below_threshold', family: 'C',
      signal: 'sequential_mmd_betting_e_process',
    };
  }

  // Q72 Phase 1 instrumentation — emit per-tick record AFTER all
  // mutations. Captures pre + post state + computed-this-tick deltas.
  if (q72TraceEnabled()) {
    q72EmitTick({
      cell_key: stateKey,
      tick_id: _q72_tick_id,
      log_S_t_pre: _q72_log_S_t_pre,
      ons_lambda_pre: _q72_lambda_pre,
      ons_inverse_hessian_pre: _q72_hessian_pre,
      witness_running_max: _q72_witness_max_pre,
      q_count: _q72_q_count_pre,
      q_running_sum_hash: _q72_q_sum_hash,
      v_first_3: v.slice(0, 3),
      v_sum: _q72_v_sum,
      F_t,
      wealth_factor,
      log_factor,
      log_S_t_post: state.log_S_t,
      ons_lambda_post: state.ons_lambda,
      ons_inverse_hessian_post: state.ons_inverse_hessian,
      verdict: _q72_verdict,
      fired_this_tick: _q72_fired_this_tick,
    });
  }
  return _q72_result;
}

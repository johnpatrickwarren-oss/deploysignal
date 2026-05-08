// engine/detectors/sequential-mmd.ts — Family C second detector.
//
// Addition #18 (ARCHITECT-REPLY-33 Part 2). Sequential nonparametric
// detector that runs ALONGSIDE Hotelling T² (not replacing); both emit
// `DetectorVerdict`s under `family === 'C'` with distinct `reason_code`
// values. Portfolio fusion unions them the same way Family A's per-
// signal Page-CUSUM + betting-e-process verdicts are unioned (co-ship
// per Addition #17).
//
// Motivation (brief D4): Hotelling T² is parametric — assumes joint-
// Gaussian relative-deviation vectors and captures mean-shift cleanly.
// Sequential MMD is nonparametric (kernel MMD) and captures
// distributional-shape shifts Hotelling misses: bimodality emergence,
// variance inflation without mean-shift, etc.
//
// Kernel (D5): Gaussian RBF with median-heuristic bandwidth. No operator
// tunable. Bandwidth derived at compile time per cell from baseline
// pairwise distances and stored on `FamilyCPerCell.mmd_params`.
//
// Streaming statistic (D6, Li/Chen 2019 "Sequential MMD with streaming
// data" adapted to per-tick):
//
//   U_t = (1 / (b·(b−1))) · Σ_{i≠j}^b  k(x_i, x_j)           [xx term]
//         − (2 / (b·m))   · Σ_i^b Σ_j^m k(x_i, y_j)          [xy term]
//         + (1 / (m·(m−1))) · Σ_{i≠j}^m k(y_i, y_j)          [yy term — precomputed]
//
// where {x_i} is the most-recent `b`-tick live window and {y_j} is the
// cell's baseline sample (size m). The third term ("yy") is baseline ×
// baseline — independent of the live window — so the compiler
// precomputes the sum and stores it as
// `FamilyCPerCell.mmd_params.baseline_baseline_sum`. Runtime cost per
// tick is O(b·(b−1) + b·m); the b·m cross-term dominates at m=500,
// b=30 → ~15 k kernel evaluations. At p=11 relative-deviation dims
// this is ~165 k flops per tick per deploy — cheap.
//
// Fire condition: observed `U_t > null_quantile` (compile-time bootstrap
// estimate of the (1−α_mmd) quantile under H₀).

import type {
  CompiledConfig, DetectorVerdict, FamilyCPerCell, MMDParams,
  SchemaContinuityRecord, EMmdState,
} from '../types';
import { resolveTenantTier } from '../types';
import { shouldSuppress } from '../l0/schema-continuity';
import { FAMILY_C_SIGNALS, lookupFamilyCParams } from './hotelling';
import { trafficGateMin } from './page-cusum';
import { pickBet } from './betting-e-process';

/** Running window of relative-deviation vectors. One window per deploy;
 *  orchestrator caller owns the lifetime (same shape as TrendBuffer). */
export interface SequentialMMDState {
  /** Most-recent `window_size` tick vectors in chronological order. */
  window: number[][];
  /** Total ticks observed this deploy (for bake/min-window eligibility). */
  ticks_observed: number;
}

export function freshMMDState(): SequentialMMDState {
  return { window: [], ticks_observed: 0 };
}

/** Retrieve or allocate the Sequential MMD state on the caller's state
 *  store. Keyed by a single global key (one MMD state per deploy);
 *  callers that care about cell-context can key by cell if desired. */
export function getOrCreateMMDState(
  states: Record<string, SequentialMMDState>,
): SequentialMMDState {
  const s = states.__mmd;
  if (s) return s;
  const fresh = freshMMDState();
  states.__mmd = fresh;
  return fresh;
}

/** Gaussian RBF kernel (square-exponential) with given bandwidth.
 *  k(x, y) = exp(-||x − y||² / (2·σ²)). Exported for reuse by the Q67
 *  Phase-3.d.B canonical betting-e-process variant. */
export function rbf(x: number[], y: number[], bandwidth: number): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; s += d * d; }
  return Math.exp(-s / (2 * bandwidth * bandwidth));
}

/** Compute U_t for the current window against the baseline set `baseline`.
 *  `mmdParams.baseline_baseline_sum` already carries the third term.
 *  Returns U_t as defined in the Li/Chen 2019 streaming recurrence. */
export function computeUt(
  window: number[][],
  baseline: number[][],
  mmdParams: MMDParams,
): number {
  const b = window.length;
  const m = baseline.length;
  if (b < 2 || m < 2) return 0;
  let xx = 0;
  for (let i = 0; i < b; i++) {
    for (let j = 0; j < b; j++) {
      if (i !== j) xx += rbf(window[i], window[j], mmdParams.bandwidth);
    }
  }
  let xy = 0;
  for (let i = 0; i < b; i++) {
    for (let j = 0; j < m; j++) {
      xy += rbf(window[i], baseline[j], mmdParams.bandwidth);
    }
  }
  const yy = mmdParams.baseline_baseline_sum / (m * (m - 1));
  return (xx / (b * (b - 1))) - (2 * xy / (b * m)) + yy;
}

/** Convert a live-metrics record into the Family C relative-deviation
 *  vector. REPLY-51b v2 R4-1: projects onto cfg.family_c_signals when
 *  profile is active; falls back to hardcoded FAMILY_C_SIGNALS.
 *  Returns null when any consumed signal is missing (detector skips
 *  that tick). */
function liveVector(
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

/** Most-constrained bake profile across Family C signals — same rule
 *  the Hotelling detector uses. Inline-computed here so the MMD detector
 *  doesn't export a dependency on hotelling's helpers. */
function mmdBakeProfile(cfg: CompiledConfig): { min_ticks: number; max_days: number } {
  const profiles = cfg.bake_profiles ?? {};
  let maxMinTicks = 0, maxMaxDays = Infinity;
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

/** Generate a deterministic baseline pool for the MMD cross-term. We
 *  pseudo-sample the cell's distribution via L·w where w ~ N(0, I) and
 *  L = Cholesky(Σ). This matches Family E's parametric-bootstrap approach
 *  and keeps the detector self-contained (no need to ship the raw baseline
 *  rows on every CompiledConfig). Deterministic across runs via seed. */
export function generateBaselinePool(
  params: FamilyCPerCell,
  size: number,
  seed: number,
): number[][] {
  const p = params.mean_vector.length;
  const L = choleskyLocal(params.covariance);
  const rng = mulberry32(seed);
  const pool: number[][] = new Array(size);
  for (let i = 0; i < size; i++) {
    const w = new Array<number>(p);
    for (let k = 0; k < p; k++) w[k] = gaussian(rng);
    const z = new Array<number>(p);
    if (L) {
      // z = L · w. Relative-deviation vector around the origin.
      for (let r = 0; r < p; r++) {
        let s = 0;
        for (let c = 0; c <= r; c++) s += L[r][c] * w[c];
        z[r] = s;
      }
    } else {
      // Degenerate Σ — emit w directly (implausible but safe).
      for (let r = 0; r < p; r++) z[r] = w[r];
    }
    pool[i] = z;
  }
  return pool;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  let u = rng(); while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function choleskyLocal(A: number[][]): number[][] | null {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

export const BASELINE_POOL_SIZE = 500;
const BASELINE_POOL_SEED_BASE = 0xB501 >>> 0;

/** Per-cell seeding for the baseline pool so cells yield deterministic,
 *  distinct pools (matches Family E's pattern). Exported for reuse by the
 *  Q67 Phase-3.d.B canonical betting-e-process variant. */
export function baselinePoolSeed(cellKey: { hour_of_day: number; day_of_week?: number }): number {
  let h = BASELINE_POOL_SEED_BASE;
  const str = `h=${cellKey.hour_of_day};d=${cellKey.day_of_week ?? -1};`;
  for (let i = 0; i < str.length; i++) h = ((h + str.charCodeAt(i)) * 1103515245 + 12345) >>> 0;
  return h >>> 0;
}

// ── Q68 Phase-3.d.C consolidation — evaluateSequentialMMD retired ────
// The Addition #18 classical bootstrap-null detector code path is
// removed at Q68 close. Per-cell `mmd_variant` flag is retired (schema
// type removed). Runtime dispatch in `engine/gates/health.ts` calls
// `evaluateFamilyCBettingEProcess` (Q67 v2 canonical Shekhar-Ramdas-2023
// betting-e-process variant) as the sole Family C MMD detector.
// `evaluateEMmd` (Option-B Addition #20; Ville-bounded by construction;
// not classical) is preserved for backward-compat with pre-Q67 cells
// lacking betting_e_process_params.
//
// Helpers retained (`computeUt`, `freshMMDState`, `getOrCreateMMDState`,
// `SequentialMMDState`, `rbf`, `generateBaselinePool`, `baselinePoolSeed`,
// `BASELINE_POOL_SIZE`) for unit-test consumption (`test/sequential-mmd.test.ts`)
// and Q67 v2 detector reuse.

// ── Addition #20 — e-MMD betting e-process (ARCHITECT-REPLY-43 D3) ────
//
// Option B DeploySignal simplification of Shekhar-Ramdas 2023: compile
// `kernel_baseline_mean_norm²` once per cell; at runtime derive the scalar
// kernel distance `d_t = √(k(x_t, x_t) - 2·(1/m)·Σ k(x_t, y_i) +
// kernel_baseline_mean_norm²)` and feed it through REPLY-34's betting
// primitives (GRAPA + ONS fallback via `pickBet`). Anytime-valid under
// Ville's inequality: fire at `M_t ≥ 1/α`.
//
// Reuses the same pseudo-baseline pool (L·w from Cholesky(Σ)) as
// Sequential MMD for the cross-term computation — same pattern, same
// determinism, no extra compile-time state beyond EMmdParams.

const E_MMD_BOUNDED_B = 3;  // matches REPLY-34's BOUNDED_SCALE_B convention
const E_MMD_WEALTH_FLOOR = 1e-12;

/** Initial wealth state for a new (deploy, cell) e-MMD evaluation. */
export function freshEMmdState(): EMmdState {
  return { M: 1, bet: 0, n: 0, runningMean: 0, runningSecondMoment: 0, alphaConsumed: 0 };
}

/** Evaluate the e-MMD betting e-process at one tick per REPLY-43 D3.
 *
 *  Semantic note on `pickBet` input moments (flagged for architect
 *  review at slice-2 landing): REPLY-43 D3 pseudo-code passes
 *  `(runningMean, runningSecondMoment)` — the moments of the raw
 *  kernel-distance scalar `d_t` — to `pickBet`. REPLY-34's primitives
 *  were designed for bounded z_t ∈ [−1, 1] with E[z] near 0 under H₀;
 *  feeding d-moments (E[d] > 0 under H₀) produces a different bet
 *  shape than the canonical bounded-z form. Implemented literally per
 *  brief; empirical fire horizons on canned demos are the ground
 *  truth in slice-2 integration tests. If those diverge, architect
 *  re-dispositions pickBet-input semantics.
 *
 *  Pattern mirrors `evaluateSequentialMMD` for cell lookup + guards;
 *  shares the same tier-aware `lookupFamilyCParams` and same
 *  pseudo-baseline pool generator. */
export function evaluateEMmd(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
  states: Record<string, EMmdState | number[][] | unknown>,
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
  const params = lookup.params;
  const eMmd = params.e_mmd_params;
  const mmd = params.mmd_params;
  // Dormant-add backward-compat: pre-#20 cells (no e_mmd_params) or
  // cells without mmd_params (bandwidth comes from there) return null.
  if (!eMmd || !mmd) return null;
  // Q67 SPEC § Q67.5 supersession — when a cell carries the canonical
  // betting-e-process params (Q67 v2 compile output), the parallel
  // evaluateFamilyCBettingEProcess call in health.ts owns this cell.
  // Returning null here prevents double-fire on cells that coexist
  // both Option-B (Addition #20) and Q67 v2 params during the
  // Phase-3.d.B → .C transition.
  if (params.betting_e_process_params) return null;

  const threshold = 1 / eMmd.alpha;

  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'C')) {
    return {
      verdict: 'suppressed', statistic: null, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: ctx.schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }

  const bake = mmdBakeProfile(cfg);
  if (ctx.ticksSinceDeploy < bake.min_ticks) {
    return {
      verdict: 'suppressed', statistic: null, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }
  if (ctx.deployAgeDays > bake.max_days) {
    return {
      verdict: 'suppressed', statistic: null, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }
  if (ctx.trafficPct < trafficGateMin(cfg)) {
    return {
      verdict: 'suppressed', statistic: null, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'traffic_pct_below_gate', family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }

  const v = liveVector(liveMetrics, params.mean_vector, cfg.family_c_signals ?? FAMILY_C_SIGNALS);
  if (v === null) return null;

  // Per-cell state key — one e-MMD state per (tier, hour, day) cell.
  const stateKey = `__emmd_${tier ?? 'none'}_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let state = states[stateKey] as EMmdState | undefined;
  if (!state || typeof state.M !== 'number') {
    state = freshEMmdState();
    states[stateKey] = state;
  }

  // Baseline pool — reuse Sequential MMD's pseudo-sampling pattern. Cache
  // by cell key so a single pool serves both MMD detectors. Seed uses
  // same function so pools stay identical between 'bootstrap_null' and
  // 'betting_e_process' variants (determinism under shadow-compare).
  const poolKey = `__mmd_pool_${ctx.hourOfDay}_${ctx.dayOfWeek ?? -1}`;
  let pool = states[poolKey] as number[][] | undefined;
  if (!pool || pool.length === 0) {
    pool = generateBaselinePool(
      params, BASELINE_POOL_SIZE,
      baselinePoolSeed({ hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek }),
    );
    states[poolKey] = pool;
  }

  // Kernel-distance scalar d_t² = k(x,x) − 2·(1/m)·Σ k(x, y_i) +
  // kernel_baseline_mean_norm². For Gaussian RBF, k(x, x) = 1.
  let crossSum = 0;
  for (const y of pool) crossSum += rbf(v, y, mmd.bandwidth);
  const crossMean = crossSum / pool.length;
  const dSquared = 1 - 2 * crossMean + eMmd.kernel_baseline_mean_norm_squared;
  const dT = Math.sqrt(Math.max(0, dSquared));

  // Update running moments of d_t (used for standardization AND as
  // pickBet's moment inputs per D3 literal; see semantic note above).
  state.n += 1;
  const n1 = state.n;
  state.runningMean = state.runningMean + (dT - state.runningMean) / n1;
  state.runningSecondMoment = state.runningSecondMoment + (dT * dT - state.runningSecondMoment) / n1;

  // Warmup: stabilize d-moments before betting. Emit suppressed so audit
  // trails show 'emmd_warming_moments' rather than clean/fire verdicts
  // during the first `running_moment_window` ticks.
  if (n1 < eMmd.running_moment_window) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'emmd_warming_moments', family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }

  // Standardize d_t via running moments; clip to [−1, 1] so the wealth
  // update's (1 + λ · d_t_std) factor stays non-negative under λ ∈
  // [−1, 1] (REPLY-34's BET_CLIP convention).
  const varD = Math.max(state.runningSecondMoment - state.runningMean * state.runningMean, 1e-12);
  const sigmaD = Math.sqrt(varD);
  let dStd = (dT - state.runningMean) / (E_MMD_BOUNDED_B * sigmaD);
  if (dStd > 1) dStd = 1;
  else if (dStd < -1) dStd = -1;

  const picked = pickBet(state.runningMean, state.runningSecondMoment, state.bet);
  const factor = Math.max(0, 1 + picked.bet * dStd);
  state.M = Math.max(E_MMD_WEALTH_FLOOR, state.M * factor);
  state.bet = picked.bet;

  if (state.M >= threshold) {
    const alphaSpent = Math.max(0, eMmd.alpha - state.alphaConsumed);
    state.alphaConsumed = eMmd.alpha;
    return {
      verdict: 'fire', statistic: state.M, threshold,
      alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
      reason_code: 'emmd_wealth_exceeded', family: 'C',
      signal: 'sequential_mmd_e_process',
    };
  }
  return {
    verdict: 'clean', statistic: state.M, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'C',
    signal: 'sequential_mmd_e_process',
  };
}

// engine/detectors/spectral.ts — Family D: ACF oscillation detector.
//
// Per WEEK4-HANDOFF.md §4.1.d. Detects periodic drift (oscillation periods
// ~3–10 ticks) that sliding-window CUSUM and Hotelling T² don't exercise.
// Motivating case: `adv_oscillating_cache_signal`-style structural gap —
// the signal isn't monotonically drifting, it's bouncing.
//
// Math (per signal, per tick, over a rolling window of `window_length`
// recent samples):
//
//   1. Deseason: subtract the window mean, so the ACF targets oscillation
//      rather than slow drift (which lives in Family A's domain).
//   2. Normalized ACF at lag k:
//          r(k) = Σ_{t=0..N-k-1} (y_t)(y_{t+k}) / Σ_{t=0..N-1} (y_t)²
//      — the unbiased ACF definition used by Box-Jenkins.
//   3. Peak search: find the max |r(k)| over k ∈ [min_peak_lag, max_peak_lag].
//   4. Fire when peak > bootstrap_null_quantile (threshold from compiler).
//
// Bootstrap null is compiled offline from the baseline bundle — the (1 − α_D)
// quantile of peak-ACF values observed across synthetic healthy windows.
// Detector reads the quantile directly; no runtime bootstrap.
//
// Per-family α from CompiledConfig.alpha_budget.per_family.D; default 1e-4
// (10% of 1e-3). Binary alpha_spent on fire per the W3 Q3 convention.

import type {
  CompiledConfig, DetectorVerdict, FamilyDPerSignal,
  SchemaContinuityRecord, SpectralEDetectorState,
} from '../types';
import { shouldSuppress } from '../l0/schema-continuity';

const DEFAULT_ALPHA_D = 1e-4;
const DEFAULT_MIN_PEAK_LAG = 3;
const DEFAULT_MAX_PEAK_LAG = 10;

/** Deseason-then-normalize ACF at lag `k` over a window `y` of length N. */
export function normalizedACF(y: number[], k: number): number {
  const N = y.length;
  if (k < 1 || k >= N) return 0;
  let mean = 0;
  for (const v of y) mean += v;
  mean /= N;
  let num = 0, denom = 0;
  for (let t = 0; t < N - k; t++) num += (y[t] - mean) * (y[t + k] - mean);
  for (let t = 0; t < N;     t++) denom += (y[t] - mean) * (y[t] - mean);
  return denom > 0 ? num / denom : 0;
}

/** Peak ACF over lag range [min_lag, max_lag]. Returns the peak value and
 *  the lag at which it occurs. */
export function peakACF(y: number[], minLag: number, maxLag: number): { peak: number; lag: number } {
  let peak = 0, lag = minLag;
  const cap = Math.min(maxLag, y.length - 1);
  for (let k = minLag; k <= cap; k++) {
    const v = Math.abs(normalizedACF(y, k));
    if (v > peak) { peak = v; lag = k; }
  }
  return { peak, lag };
}

/** Look up Family D params for a signal, falling back to aggregate. */
export function lookupFamilyDParams(
  cfg: CompiledConfig,
  cell: { hour_of_day: number; day_of_week?: number },
  signal: string,
): FamilyDPerSignal | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  const match = bc.cells.find((c) => {
    if (c.key.hour_of_day !== cell.hour_of_day) return false;
    if (cell.day_of_week !== undefined && c.key.day_of_week !== undefined) {
      return c.key.day_of_week === cell.day_of_week;
    }
    return true;
  });
  if (match?.family_D?.[signal]) return match.family_D[signal];
  return bc.aggregate_fallback.family_D?.[signal] ?? null;
}

/** Evaluate Family D for one signal at one tick. Needs a rolling window of
 *  recent values, supplied by the caller (typically the TrendBuffer's long
 *  view).
 *
 *  Legacy path (`cell.spectral_variant === 'bootstrap_null'` or absent):
 *  fires when peak|ACF| exceeds the per-signal compiled threshold.
 *
 *  Addition #21 path (`cell.spectral_variant === 'e_detector'` + `state`
 *  provided): routes peak|ACF| through the mixture-prior e-detector's
 *  wealth-process update (see evaluateSpectralEDetector). REPLACE semantic
 *  per REPLY-45 D1 — one detector_id per signal per tick. */
export function evaluateFamilyD(
  cfg: CompiledConfig,
  signal: string,
  recentSamples: number[],
  ctx: {
    hourOfDay: number;
    dayOfWeek?: number;
    ticksSinceDeploy: number;
    deployAgeDays: number;
    trafficPct: number;
    schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  },
  state?: SpectralEDetectorState,
): DetectorVerdict | null {
  const params = lookupFamilyDParams(cfg, { hour_of_day: ctx.hourOfDay, day_of_week: ctx.dayOfWeek }, signal);
  if (!params) return null;
  const alphaD = cfg.alpha_budget.per_family.D ?? DEFAULT_ALPHA_D;

  // Addition #8 runtime consumer (W5 §S6): ACF bootstrap null is compiled
  // against the baseline's schema; a breaking change makes the null
  // distribution stale.
  if (ctx.schemaContinuityClass && shouldSuppress(ctx.schemaContinuityClass, 'D')) {
    return {
      verdict: 'suppressed', statistic: null, threshold: params.bootstrap_null_quantile,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: ctx.schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      family: 'D', signal,
    };
  }

  // Signal-level bake profile (shared table with Family A/C).
  const bake = cfg.bake_profiles?.[signal];
  const minTicks = bake?.min_ticks_before_eligible ?? 3;
  const maxDays = bake?.max_deploy_window_days ?? 1;
  if (ctx.ticksSinceDeploy < minTicks) {
    return {
      verdict: 'suppressed', statistic: null, threshold: params.bootstrap_null_quantile,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'D', signal,
    };
  }
  if (ctx.deployAgeDays > maxDays) {
    return {
      verdict: 'suppressed', statistic: null, threshold: params.bootstrap_null_quantile,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'D', signal,
    };
  }

  const trafficGate = cfg.traffic_pct_gate?.min_traffic_pct_for_fire ?? 0;
  if (ctx.trafficPct < trafficGate) {
    return {
      verdict: 'suppressed', statistic: null, threshold: params.bootstrap_null_quantile,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'traffic_pct_below_gate', family: 'D', signal,
    };
  }

  // Need at least 2× max_peak_lag samples for a meaningful ACF peak.
  const minWindow = 2 * params.max_peak_lag;
  if (recentSamples.length < minWindow) {
    return {
      verdict: 'suppressed', statistic: null, threshold: params.bootstrap_null_quantile,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'window_underfilled', family: 'D', signal,
    };
  }

  const { peak, lag } = peakACF(recentSamples, params.min_peak_lag, params.max_peak_lag);

  // D-54-2 dispatch — variant routing via SPECTRAL_EVALUATORS map.
  // `bootstrap_null` is the default when spectral_variant is unset
  // (pre-#21 configs). `e_detector` additionally requires a runtime
  // state object; missing state falls through to bootstrap_null
  // (preserves pre-refactor semantics). Unknown variant strings throw.
  const variant = spectralVariantForDispatch(params.spectral_variant, !!state);
  const evaluator = SPECTRAL_EVALUATORS[variant];
  if (!evaluator) {
    throw new Error(
      `Unknown spectral_variant: '${String(params.spectral_variant)}'. `
      + `Known: ${Object.keys(SPECTRAL_EVALUATORS).join(', ')}`,
    );
  }
  return evaluator({ params, peak, lag, alphaD, signal, state });
}

// ── D-54-2 — dispatch maps (ARCHITECT-REPLY-54 slice 2) ────────────

/** Unified context the Record<SpectralVariant, Evaluator> receives. */
interface SpectralDispatchCtx {
  params: FamilyDPerSignal;
  peak: number;
  lag: number;
  alphaD: number;
  signal: string;
  state?: SpectralEDetectorState;
}

type SpectralVariant = 'bootstrap_null' | 'e_detector';
type SpectralEvaluator = (ctx: SpectralDispatchCtx) => DetectorVerdict;

/** Bootstrap-null (pre-#21) threshold-crossing test on peak|ACF|. */
function evaluateSpectralBootstrapNull(ctx: SpectralDispatchCtx): DetectorVerdict {
  const { params, peak, lag, alphaD, signal } = ctx;
  const threshold = params.bootstrap_null_quantile;
  if (peak >= threshold) {
    return {
      verdict: 'fire', statistic: peak, threshold,
      alpha_consumed: alphaD, alpha_spent: alphaD,
      reason_code: `spectral_peak_at_lag_${lag}`, family: 'D', signal,
    };
  }
  return {
    verdict: 'clean', statistic: peak, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'D', signal,
  };
}

/** E-detector wrapper for dispatch. Requires per-(deploy, signal) state. */
function evaluateSpectralEDetectorDispatch(ctx: SpectralDispatchCtx): DetectorVerdict {
  const { params, peak, alphaD, signal, state } = ctx;
  if (!state) {
    throw new Error(
      'evaluateSpectralEDetectorDispatch invoked without state — '
      + 'dispatch map gate must enforce prereqs before routing.',
    );
  }
  return evaluateSpectralEDetector({ params, alpha: alphaD, signal }, peak, state);
}

const SPECTRAL_EVALUATORS: Record<SpectralVariant, SpectralEvaluator> = {
  'bootstrap_null': evaluateSpectralBootstrapNull,
  'e_detector': evaluateSpectralEDetectorDispatch,
};

/** Resolve a cell's declared spectral_variant to the effective dispatch
 *  key. undefined → legacy default; 'e_detector' w/o state → legacy
 *  fallback (preserves pre-D-54-2 behavior). */
function spectralVariantForDispatch(
  raw: FamilyDPerSignal['spectral_variant'],
  hasState: boolean,
): SpectralVariant {
  if (raw === undefined || raw === 'bootstrap_null') return 'bootstrap_null';
  if (raw === 'e_detector') return hasState ? 'e_detector' : 'bootstrap_null';
  return raw as SpectralVariant;
}

/** Exposed for dispatch-map parity testing. */
export const _SPECTRAL_EVALUATORS_FOR_TEST = SPECTRAL_EVALUATORS;
export const _spectralVariantForDispatch = spectralVariantForDispatch;

/** Convenience: the signal list Family D watches. Restricted to the
 *  detectors shipped in the W4 registry (audit/SCHEMA.md v2 §Per-family
 *  detector registry). Other oscillation-prone signals (p99_latency,
 *  ttft, hbm_spill) will land when their `spectral_peak_acf_*` entries
 *  are added to the registry — post-W4 architect scope. */
export const FAMILY_D_SIGNALS = [
  'kv_cache',
] as const;

export { DEFAULT_ALPHA_D, DEFAULT_MIN_PEAK_LAG, DEFAULT_MAX_PEAK_LAG };

// ── Addition #21 — spectral e-detector (ARCHITECT-REPLY-45) ────────────
//
// Scalar mixture-prior e-value on peak|ACF| (Shin-Ramdas-Rinaldo 2022,
// simplified single-mixture form per REPLY-45 D3). Co-ships alongside
// the legacy bootstrap-null path; selection by `cell.spectral_variant`.
// Wealth update `M_t = M_{t-1} · exp(z_t)` with z_t derived from the
// log-likelihood ratio under μ ~ N(μ₀ + δ_D, σ₀²) on the peak|ACF|
// statistic. Anytime-valid under Ville's inequality: fire at `M_t ≥ 1/α_D`.

const E_DETECTOR_WEALTH_FLOOR = 1e-300;

/** Fresh wealth state for a new (deploy, signal) spectral-e-detector
 *  evaluation. `M₀ = 1` per Ville-inequality convention. */
export function freshSpectralEDetectorState(): SpectralEDetectorState {
  return { M: 1, n: 0, alphaConsumed: 0 };
}

/** Addition #21 (ARCHITECT-REPLY-45 D3) — spectral e-detector per-tick
 *  evaluation against a cell with populated `null_mean`, `null_std`, and
 *  `betting_delta`. Caller owns the state object; this function mutates
 *  `state.M` / `state.n` / `state.alphaConsumed` in place.
 *
 *  Formula (derivation from Gaussian-mean-shift LLR with prior
 *  μ ~ N(μ₀ + δ_D, σ₀²)):
 *
 *    Let r = δ_D / σ₀  (dimensionless mixture-shift magnitude).
 *    Let u = (peak_t − μ₀) / σ₀  (standardized peak).
 *    z_t = r · u − 0.5 · r²
 *        = (δ_D · (peak_t − μ₀)) / σ₀² − δ_D² / (2 σ₀²)
 *    M_t = M_{t-1} · exp(z_t)
 *    Fire when M_t ≥ 1/α_D.
 *
 *  Practice-5 anchors at μ₀=0.42, σ₀=0.05, δ_D=0.015, α_D=1e-4 per
 *  REPLY-45:
 *    - Healthy (peak_t = μ₀): z_t = −0.045; wealth drifts ~0.956×/tick.
 *    - 1σ₀ mild (peak_t = 0.47): z_t = +0.255; fire ~36 ticks.
 *    - 2σ₀ moderate (peak_t = 0.52): z_t = +0.555; fire ~17 ticks.
 *    - 3σ₀ strong (peak_t = 0.57): z_t = +0.855; fire ~11 ticks.
 *  All within sufficiency-gate canary window. */
export function evaluateSpectralEDetector(
  input: {
    params: FamilyDPerSignal;
    alpha: number;
    signal: string;
  },
  peak_t: number,
  state: SpectralEDetectorState,
): DetectorVerdict {
  const threshold = 1 / input.alpha;
  const { null_mean: mu0, null_std: sigma0, betting_delta: delta } = input.params;
  if (mu0 === undefined || sigma0 === undefined || delta === undefined) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'spectral_e_detector_params_missing',
      family: 'D', signal: input.signal,
    };
  }
  if (!(sigma0 > 0)) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'spectral_null_std_nonpositive',
      family: 'D', signal: input.signal,
    };
  }
  // z_t = r·u − 0.5·r² where r = δ/σ, u = (peak − μ)/σ. Compiled at this
  // shape (rather than the compound δ·(peak−μ)/σ² form) so the healthy-
  // case z_t = −0.5·r² is immediate and numerically stable.
  const r = delta / sigma0;
  const u = (peak_t - mu0) / sigma0;
  const z_t = r * u - 0.5 * r * r;
  state.M = Math.max(E_DETECTOR_WEALTH_FLOOR, state.M * Math.exp(z_t));
  state.n += 1;
  if (state.M >= threshold) {
    const alphaSpent = Math.max(0, input.alpha - state.alphaConsumed);
    state.alphaConsumed = input.alpha;
    return {
      verdict: 'fire', statistic: state.M, threshold,
      alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
      reason_code: 'spectral_e_detector_wealth_exceeded',
      family: 'D', signal: input.signal,
    };
  }
  return {
    verdict: 'clean', statistic: state.M, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold',
    family: 'D', signal: input.signal,
  };
}

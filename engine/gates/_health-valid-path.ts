// engine/gates/_health-valid-path.ts — C64 (a): the envelope-valid TERMINAL path for Family A.
//
// The registered ship rule of the C64 (d) power study (studies/valid-path-power, run
// 2026-09-03T18182Z; knowledge stats/valid-path-power-2026-09-03) routes the safe two-sample
// t e-value at known φ (engine detectors/safe-t-e-value.ts, `validUnderEstimatedBaseline:
// true`) into the α-participating decision: 1.0000 detection at the K1 canonical 1.5σ on the
// 100-tick canary, 0 of 524 null crossings at α = 0.05, exactly scale-invariant.
//
// WHAT IT NEEDS THAT THE GATE DOES NOT HAVE. safe-t is a two-sample construction on raw
// series. Compiled configs carry Family A MOMENTS only (baseline_mean, baseline_sigma_squared,
// ar1_phi, the bootstrap threshold — no calibration samples), and the TrendBuffer keeps 10/5/30-
// tick rolling views of the canary. So the caller supplies the calibration series per signal
// (`OrchestrateParams.validPath`), and this module keeps the full canary series per signal on
// the TrendBuffer as a plain data property (the same per-deploy persistence the plug-ins' state
// maps use; a lazily-initialised property survives the runtime's JSON snapshot).
//
// WHEN IT DECIDES. Once, at the terminal tick (`terminalLook`, set by the orchestrator when
// `tick >= totalTicks − 1`). A fixed-time e-value peeked every tick is not anytime-valid; the
// study read it once and so does this path. Before the terminal tick each routed signal emits a
// `clean` verdict with reason_code `safe_t_terminal_pending` (statistic null) so evidence_outlook
// and the audit record show the path is armed without turning `baking` into `extend`.
//
// α. The full per-signal Family A allocation `alpha_budget.per_family.A / bonferroni_factor` —
// the same derivation the plug-ins split 50/50 (engine detectors/betting-e-process.ts). Under
// C64 (b) the plug-ins on a routed signal are advisory, so this is the whole per-signal spend;
// until (b) lands, a routed signal is over-allocated by at most 2× and this comment says so.
//
// φ. Supplied by the caller (`validPath.ar1Phi[signal]`) — the known-φ regime the study
// measured — else the compiled cell's `ar1_phi` (an ESTIMATE: the safe-t header places the
// e-BH-relevant mean inside its bound only at calibration ≳ 100, so a shorter calibration
// without a supplied φ is refused with `safe_t_calibration_below_floor` rather than run
// out of envelope). Absent both, the engine's own estimator runs on the calibration window.
//
// BYTE-IDENTITY. With no `validPath` on the params nothing here runs: no verdicts, no state,
// no rollback ids. Fires push `family_A_safe_t_{signal}`; the audit layer resolves that id to
// the engine registry's `safe_t_e_value_{signal}` (engine ≥ v0.6.10-pre).

import { safeTwoSampleTEValue } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/safe-t-e-value';
import { FAMILY_A_PRIMARY_SIGNALS } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_page-cusum-core';
import type {
  Metrics, FiredSignal, HealthResult, TrendBufferI, DetectorVerdict, CompiledConfig,
} from '../types';
import type { HealthOpts } from './_health-types';

/** Caller-supplied inputs for the valid path. Absent → the path is inert (byte-identical gate). */
export interface ValidPathOpts {
  /** Raw calibration series per Family A signal (pre-deploy telemetry, same units as
   *  `liveMetrics[signal]`). Signals outside FAMILY_A_PRIMARY_SIGNALS are ignored. */
  calibration: Record<string, ReadonlyArray<number>>;
  /** Known AR(1) φ per signal (the envelope-valid regime). Optional per signal. */
  ar1Phi?: Record<string, number>;
  /** Override the per-signal α (default: alpha_budget.per_family.A / bonferroni_factor). */
  alphaPerSignal?: number;
}

/** Rollback id prefix for valid-path fires; the audit resolver maps it to the registry id. */
export const VALID_PATH_ROLLBACK_PREFIX = 'family_A_safe_t_';
/** reason_code values this path emits. Audit consumers key the registry id off the prefix. */
export const VALID_PATH_REASON = Object.freeze({
  pending: 'safe_t_terminal_pending',
  fire: 'safe_t_terminal_fire',
  clean: 'safe_t_terminal_clean',
  belowFloor: 'safe_t_calibration_below_floor',
  tooShort: 'safe_t_canary_too_short',
  error: 'safe_t_error',
});
/** Calibration length below which an ESTIMATED φ is refused (safe-t header, ADR 0005: the
 *  e-BH-relevant E[e|H0] ≤ 1 needs cal ≳ 100 when φ is a plug-in). */
export const VALID_PATH_MIN_CALIBRATION_ESTIMATED_PHI = 100;
/** Math minimum with a KNOWN φ (SAFE_T_ENVELOPE.minCalibration). */
export const VALID_PATH_MIN_CALIBRATION_KNOWN_PHI = 3;

type SeriesStore = { validPathSeries?: Record<string, number[]> };

function seriesStore(tb: TrendBufferI): Record<string, number[]> {
  const t = tb as TrendBufferI & SeriesStore;
  return (t.validPathSeries ??= {});
}

/** Per-signal α: the full Family A per-signal allocation (see file header). */
export function validPathAlpha(cfg: CompiledConfig | null | undefined, override?: number): number {
  if (override !== undefined) return override;
  const alphaFamilyA = cfg?.alpha_budget?.per_family?.A ?? 4e-4;
  const bonf = cfg?.bonferroni_factor ?? 6;
  return alphaFamilyA / bonf;
}

function cellPhi(cfg: CompiledConfig | null | undefined, signal: string, hour?: number, day?: number): number | undefined {
  const cells = cfg?.baseline_cells?.cells ?? [];
  const match = cells.find((c) => {
    if (hour === undefined || c.key.hour_of_day !== hour) return false;
    if (day !== undefined && c.key.day_of_week !== undefined) return c.key.day_of_week === day;
    return true;
  });
  const per = match?.family_A?.per_signal?.[signal] ?? cfg?.baseline_cells?.aggregate_fallback?.family_A?.per_signal?.[signal];
  return per?.ar1_phi;
}

function verdict(signal: string, v: Partial<DetectorVerdict> & { verdict: DetectorVerdict['verdict']; reason_code: string }): DetectorVerdict {
  return {
    statistic: null, threshold: null, alpha_consumed: 0, alpha_spent: 0, family: 'A', signal, ...v,
  };
}

/** Evaluate the terminal safe-t e-value for one routed signal. Exported for tests. */
export function terminalSafeTVerdict(
  signal: string, calibration: ReadonlyArray<number>, canary: ReadonlyArray<number>,
  alpha: number, phi: number | undefined,
): DetectorVerdict {
  const threshold = 1 / alpha;
  const minCal = phi === undefined ? VALID_PATH_MIN_CALIBRATION_ESTIMATED_PHI : VALID_PATH_MIN_CALIBRATION_KNOWN_PHI;
  if (calibration.length < minCal) {
    return verdict(signal, { verdict: 'suppressed', threshold, reason_code: VALID_PATH_REASON.belowFloor });
  }
  if (canary.length < 2) {
    return verdict(signal, { verdict: 'suppressed', threshold, reason_code: VALID_PATH_REASON.tooShort });
  }
  const series = calibration.concat(canary);
  const e = safeTwoSampleTEValue(series, { start: 0, len: calibration.length },
    { start: calibration.length, len: canary.length }, phi === undefined ? undefined : { ar1Phi: phi });
  const fire = e >= threshold;
  return verdict(signal, {
    verdict: fire ? 'fire' : 'clean', statistic: e, threshold,
    alpha_consumed: alpha, alpha_spent: fire ? alpha : 0,
    reason_code: fire ? VALID_PATH_REASON.fire : VALID_PATH_REASON.clean,
  });
}

/** Push this tick's observation for `signal` onto the per-deploy canary series. */
function recordTick(store: Record<string, number[]>, signal: string, x: unknown): number[] {
  const series = (store[signal] ??= []);
  if (typeof x === 'number' && Number.isFinite(x)) series.push(x);
  return series;
}

/** The terminal verdict for one routed signal, with the failure mode as a verdict rather
 *  than silence (the sibling runners swallow; a valid-path error must reach the audit). */
function terminalVerdictFor(
  signal: string, calibration: ReadonlyArray<number>, series: ReadonlyArray<number>,
  alpha: number, phi: number | undefined,
): DetectorVerdict {
  try {
    return terminalSafeTVerdict(signal, calibration, series, alpha, phi);
  } catch (_e) {
    return verdict(signal, { verdict: 'suppressed', threshold: 1 / alpha, reason_code: VALID_PATH_REASON.error });
  }
}

/** One routed signal, one tick: arm (pre-terminal) or decide (terminal). */
function routeSignal(
  signal: string, calibration: ReadonlyArray<number>, store: Record<string, number[]>,
  liveMetrics: Metrics, alpha: number, opts: HealthOpts,
): DetectorVerdict {
  const series = recordTick(store, signal, liveMetrics[signal]);
  if (!opts.terminalLook) {
    return verdict(signal, { verdict: 'clean', threshold: 1 / alpha, reason_code: VALID_PATH_REASON.pending });
  }
  const phi = opts.validPath?.ar1Phi?.[signal]
    ?? cellPhi(opts.compiledConfig, signal, opts.currentHourOfDay, opts.currentDayOfWeek);
  return terminalVerdictFor(signal, calibration, series, alpha, phi);
}

/** Family A valid path (C64 a). Appends one verdict per routed signal to `family_A_shadow`;
 *  a terminal fire pushes `family_A_safe_t_{signal}` into rollback. */
export function runFamilyAValidPath(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI, opts: HealthOpts,
): void {
  const vp = opts.validPath;
  if (!vp) return;
  const store = seriesStore(tb);
  const alpha = validPathAlpha(opts.compiledConfig, vp.alphaPerSignal);
  const out: DetectorVerdict[] = [];
  for (const signal of FAMILY_A_PRIMARY_SIGNALS) {
    const calibration = vp.calibration[signal];
    if (!calibration) continue;
    const v = routeSignal(signal, calibration, store, liveMetrics, alpha, opts);
    out.push(v);
    const id = VALID_PATH_ROLLBACK_PREFIX + signal;
    if (v.verdict === 'fire' && sup.indexOf(id) < 0) rollbackFired.push({ id, label: 'Family A safe-t ' + signal });
  }
  if (out.length > 0) result.family_A_shadow = (result.family_A_shadow ?? []).concat(out);
}

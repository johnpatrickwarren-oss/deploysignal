// engine/gates/_health-contrast.ts — C81 (Part 2): the control arm. A profile declares, per signal,
// which live metric keys are the canary units and which are their concurrent control twins (matched
// pairs) and a control-vs-control cohort believed null; the caller supplies each pair's healthy
// baseline contrast (raw numbers, the C64 lesson: compiled configs carry moments, not samples); and
// this module scores every (pair, signal) on the ENGINE's contrast construction (per-shard/contrast.ts,
// engine ADR 0032: fitContrast on the baseline contrast, the standardized residual per tick), runs the
// Family A mixture card on the residual, selects across pairs × signals under ONE e-BH budget through
// the engine's guarded e-BH, runs the 'gaussian' calibration monitor on the cohort's residual as the
// Mode gate (a signal whose cohort monitor has revoked is advisory, the C25/C65 pattern), and reports
// margins and e-BY intervals on the fused verdict (engine/_verdict-contrast.ts).
//
// AUTHORITY: ADVISORY. Engine study 2026-09-contrast-null (validation/contrast-null,
// run-20260905T061348Z; knowledge stats/contrast-null-2026-09-05) REFUSED the contrast null an
// admitting envelope: the shared component cancels exactly, but the contrast's estimated OFFSET is
// the plug-in n >> m price (mixture false alerts 0.34 / 0.18 / 0.03 per 1,000 ticks at fit 60 / 300 /
// 2000 on iid pairs against a contract of 0.025). The engine's gate admits `contrast_null_mixture`
// only under the caller's assertion { mMuchGreaterThanN } or { trueBaseline }. So:
//   - nothing here enters `rollback[]`, `firing_families` or α_spent (`CONTRAST_ARM_AUTHORITY`);
//   - the selection is REPORTED through `eBenjaminiHochbergGuarded` under `mMuchGreaterThanN` only
//     when the declared fit window is at least `CONTRAST_FIT_RATIO_FLOOR` canary lengths (Part 1's
//     law: the wealth's excess is about n/m nats over the horizon, so ratio 10 is ε ≈ 0.1 on the
//     FDR level, and the assertion says so at this one call site); below the floor the gate is
//     refused and the report says `refused_fit_ratio` with the raw e-values still shown;
//   - the temporal path (the plug-ins, the valid path) keeps its authority on every signal.
// The contrast verdicts live on `HealthResult.contrast_arm` (an extension field, never in
// `family_A_shadow`), so fusion's `anyFire` and the audit's Family A block cannot mistake one for a
// mixture fire. What reverses the advisory setting: an engine envelope that ADMITS the construction
// at the declared fit length (engine ADR 0032 "What would reverse the refusal").
//
// BYTE-IDENTITY. With no `control_arm` on the compiled config or no `contrastArm` on the params,
// nothing here runs.

import { fitContrast, type ContrastFit } from '@johnpatrickwarren-oss/deploysignal-engine/per-shard/contrast';
import { evaluatePageCusumMixtureSupermartingale, freshMixtureSupermartingaleState } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/family-a-mixture-supermartingale';
import type { MixtureSupermartingaleState } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/family-a-mixture-supermartingale';
import { eBenjaminiHochbergGuarded, envelopeFor } from '@johnpatrickwarren-oss/deploysignal-engine/fleet/e-bh-guarded';
import { freshCalibrationMonitor, updateCalibration, freshIncrementEstimator, updateIncrementEstimator, incrementEstimate, gInc, type CalibrationMonitorState, type IncrementEstimatorState } from '@johnpatrickwarren-oss/deploysignal-engine/fleet/calibration-monitor';
import { assertValidForFdrPath, type FdrPathAssertions } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/validity-envelope';
import type { Metrics, HealthResult, TrendBufferI, DetectorVerdict, CompiledConfig } from '../types';
import type { ControlArmPair, ControlArmCohortPair, ControlArmProfile } from '../types/_config-profiles';
import {
  CONTRAST_ARM_AUTHORITY, CONTRAST_ARM_Q, CONTRAST_FIT_RATIO_FLOOR, CONTRAST_ARM_REASON,
  CONTRAST_MONITOR_ALPHA, CONTRAST_MIXTURE_PRIOR,
} from '../guarantees';

// ── the profile's declaration ────────────────────────────────────────────────────────

export type { ControlArmPair, ControlArmCohortPair, ControlArmProfile };

// ── the caller's inputs ──────────────────────────────────────────────────────────────

/** A pair's healthy baseline: raw treatment and control series of `fit_ticks` samples. */
export interface ContrastBaselinePair { treatment: ReadonlyArray<number>; control: ReadonlyArray<number> }
/** Caller-supplied inputs for the control arm. Absent → the arm is inert (byte-identical gate). */
export interface ContrastArmOpts {
  /** per pair id (`${signal}|${canary}|${control}`): its healthy baseline contrast pair. */
  baseline: Record<string, ContrastBaselinePair>;
  /** per cohort pair id (`${signal}|${a}|${b}`): its healthy baseline pair (fit for the monitor). */
  cohortBaseline?: Record<string, ContrastBaselinePair>;
  /** STUDY-ONLY: force the `mMuchGreaterThanN` assertion regardless of the fit ratio, so a
   *  registered harness can measure the would-be decision below the floor. The report names it. */
  assertFitRatio?: boolean;
  /** STUDY-ONLY (engine v0.11.0-pre, h0-battery A7): promise the mixture's `mgf` tail premise
   *  (`lightTails`) where the substrate states its ground — a synthetic Gaussian generator. Live
   *  telemetry promises nothing: the cohort's measured increment mean is passed instead and the gate
   *  refuses (`refused_tail_premise`) while it is inconclusive. The report names which. */
  assertLightTails?: boolean;
}

export const pairId = (p: ControlArmPair): string => `${p.signal}|${p.canary}|${p.control}`;
export const cohortId = (c: ControlArmCohortPair): string => `${c.signal}|${c.a}|${c.b}`;

// ── per-deploy state on the TrendBuffer ──────────────────────────────────────────────

interface PairState {
  fit: ContrastFit;
  /** the previous centered contrast, for the causal whitening step. */
  dcPrev: number | null;
  mixture: MixtureSupermartingaleState;
  ticks: number;
  /** the residual's running sum and count: the level-free inputs of the e-BY interval. */
  S_t: number;
  /** last residual (for the report). */
  lastResidual: number | null;
}
interface CohortState { fit: ContrastFit; dcPrev: number | null; monitor: CalibrationMonitorState; estimator: IncrementEstimatorState; ticks: number }
interface ArmStore { pairs: Record<string, PairState>; cohort: Record<string, CohortState> }
type StoreHost = { contrastArmState?: ArmStore };

function store(tb: TrendBufferI): ArmStore {
  const t = tb as TrendBufferI & StoreHost;
  return (t.contrastArmState ??= { pairs: {}, cohort: {} });
}

/** One causal step of the engine's `applyContrast`: center, whiten at φ against the previous
 *  centered value (the first tick unwhitened, as Tessera), standardize by loc/scale. Equal to the
 *  engine's batch function tick for tick (test/c81-contrast-arm.test.ts). */
export function contrastResidualStep(d: number, dcPrev: number | null, fit: ContrastFit): { r: number; dc: number } {
  const dc = d - fit.center;
  const w = dcPrev === null ? dc : dc - fit.phi * dcPrev;
  return { r: (w - fit.loc) / fit.scale, dc };
}

function newPairState(b: ContrastBaselinePair): PairState {
  const d = b.treatment.map((x, i) => x - b.control[i]);
  return { fit: fitContrast(d), dcPrev: null, mixture: freshMixtureSupermartingaleState(), ticks: 0, S_t: 0, lastResidual: null };
}
function newCohortState(b: ContrastBaselinePair): CohortState {
  const d = b.treatment.map((x, i) => x - b.control[i]);
  // The estimator beside the monitor, same family ('gaussian', gInc): the C26 instrument on the
  // known-null cohort residual, pooled across cohort pairs into the gate's `incrementMean` (A7).
  return { fit: fitContrast(d), dcPrev: null, monitor: freshCalibrationMonitor({ alpha: CONTRAST_MONITOR_ALPHA, incrementKind: 'gaussian' }), estimator: freshIncrementEstimator(), ticks: 0 };
}

// ── the per-tick evaluation ──────────────────────────────────────────────────────────

/** The mixture card's parameters on a standardized residual: (μ, σ², φ) = (0, 1, 0), the engine's
 *  Gaussian mixing prior CONTRAST_MIXTURE_PRIOR. */
const MIXTURE_PARAMS = Object.freeze({ mixture_distribution: 'gaussian' as const, gaussian_sigma_squared_prior: CONTRAST_MIXTURE_PRIOR, ar1_phi: 0 });

/** One contrast verdict: family 'A' by construction (a mean-shift card), never α-spending. */
export interface ContrastPairVerdict extends DetectorVerdict {
  pair: string;
  canary: string;
  control: string;
  /** the mixture's running log-wealth on the residual (the e-value e-BH reads, in nats). */
  log_e: number;
  /** the residual's running sum and count (level-free e-BY inputs). */
  S_t: number;
  t: number;
  /** false when the signal's cohort monitor has revoked: advisory even under the assertion. */
  monitor_passing: boolean;
  last_residual: number | null;
}

/** The arm's per-tick block on the health result. */
export interface ContrastArmHealth {
  authority: typeof CONTRAST_ARM_AUTHORITY;
  q: number;
  fit_ticks: number;
  /** fit_ticks / totalTicks, the ratio the assertion is judged on. */
  fit_ratio: number | null;
  /** how the guarded e-BH was reached this tick. */
  gate: 'asserted_m_much_greater_than_n' | 'asserted_by_study_flag' | 'refused_fit_ratio' | 'refused_tail_premise' | 'no_admissible_pairs';
  /** engine v0.11.0-pre / h0-battery A7: how the mixture's `mgf` tail premise was met this tick —
   *  `cleared` (the cohort's measured increment mean clears the card bound), `promised` (the study
   *  flag), `inconclusive` / `refuted` / `unmeasured` (the gate refuses: `refused_tail_premise`). */
  tail_premise: 'cleared' | 'promised' | 'inconclusive' | 'refuted' | 'unmeasured';
  /** the pooled cohort increment mean the assertion carried, when measured. */
  increment_mean?: { lower95: number; upper95: number; n: number };
  /** the engine's own words when it refused the tail premise. */
  tail_premise_reason?: string;
  /** the universe the selection was made from (pairs whose monitor is passing). */
  K: number;
  verdicts: ContrastPairVerdict[];
  /** pair ids selected by e-BH at q among the admissible pairs; empty when the gate was refused. */
  selected: string[];
  log_threshold_e: number | null;
  /** per selected pair: log e − log threshold (the engine's margin). */
  log_margins: Record<string, number>;
  /** per signal: true iff every cohort pair for that signal is passing (or none is declared). */
  monitors: Record<string, boolean>;
}

const finite = (x: number): number => (Number.isFinite(x) ? x : NaN);

function advancePair(st: PairState, d: number): void {
  const { r, dc } = contrastResidualStep(d, st.dcPrev, st.fit);
  st.dcPrev = dc;
  if (!Number.isFinite(r)) return;   // a non-finite residual carries no evidence (ADR 0026 posture)
  st.ticks += 1; st.S_t += r; st.lastResidual = r;
  evaluatePageCusumMixtureSupermartingale({
    signal: 'contrast', x_centered: r, live_value: r, baseline_mean: 0, sigma_squared: 1, params: MIXTURE_PARAMS, state: st.mixture, alpha: CONTRAST_ARM_Q, ar1_phi: 0,
  });
}
function advanceCohort_(st: CohortState, d: number): void {
  const { r, dc } = contrastResidualStep(d, st.dcPrev, st.fit);
  st.dcPrev = dc;
  if (!Number.isFinite(r)) return;
  st.ticks += 1;
  updateCalibration(st.monitor, r);
  updateIncrementEstimator(st.estimator, Math.log(gInc(r)));
}

/** Chan–Golub–LeVeque pooling of two Welford states (the estimator's shape). */
function mergeIncrementStates(a: IncrementEstimatorState, b: IncrementEstimatorState): IncrementEstimatorState {
  if (a.n === 0) return { ...b }; if (b.n === 0) return { ...a };
  const n = a.n + b.n; const delta = b.mean - a.mean;
  return { n, mean: a.mean + delta * b.n / n, m2: a.m2 + b.m2 + delta * delta * a.n * b.n / n, max: Math.max(a.max, b.max) };
}
/** The arm's pooled cohort increment mean, once at least two increments are in. */
function incrementMeanFor(s: ArmStore): { lower95: number; upper95: number; n: number } | undefined {
  let acc = freshIncrementEstimator();
  for (const st of Object.values(s.cohort)) acc = mergeIncrementStates(acc, st.estimator);
  if (acc.n < 2) return undefined;
  const e = incrementEstimate(acc);
  return Number.isFinite(e.lower95) && Number.isFinite(e.upper95) ? { lower95: e.lower95, upper95: e.upper95, n: e.n } : undefined;
}
/** The assertions the guarded e-BH sees: fit ≫ horizon, plus the measured increment mean and/or the
 *  study-only promise for the tail premise (engine v0.11.0-pre). */
function contrastAssertions(incrementMean: { lower95: number; upper95: number } | undefined, lightTails: boolean | undefined): FdrPathAssertions {
  return { mMuchGreaterThanN: true, ...(incrementMean ? { incrementMean } : {}), ...(lightTails ? { lightTails: true } : {}) };
}
/** How the tail premise is met, and the engine's reason when it is not. Exported so the test and the
 *  registered study read the same decision the gate makes. */
export function contrastTailPremise(assertions: FdrPathAssertions): { token: ContrastArmHealth['tail_premise']; reason?: string } {
  const env = envelopeFor('contrast_null_mixture')!;
  const m = assertions.incrementMean;
  let admitted = true, reason: string | undefined;
  try { assertValidForFdrPath(env, assertions); } catch (e) { admitted = false; reason = (e as Error).message; }
  if (admitted) return { token: m && m.upper95 < 1.0005 ? 'cleared' : 'promised' };
  return { token: m === undefined ? 'unmeasured' : m.lower95 > 1.0005 ? 'refuted' : 'inconclusive', reason };
}

function read(m: Metrics, key: string): number | null {
  const v = (m as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Per signal, the cohort's verdict: passing iff every declared cohort pair for the signal is passing. */
function monitorsFor(spec: ControlArmProfile, s: ArmStore): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of spec.pairs) out[p.signal] = true;
  for (const c of spec.control_cohort) {
    const st = s.cohort[cohortId(c)];
    if (st && !st.monitor.passing) out[c.signal] = false;
  }
  return out;
}

function verdictFor(p: ControlArmPair, st: PairState, passing: boolean, selected: boolean, threshold: number | null): ContrastPairVerdict {
  const logE = finite(Math.log(Math.max(st.mixture.M_t ?? 1, 1e-300)));
  const reason = !passing ? CONTRAST_ARM_REASON.monitorRevoked : selected ? CONTRAST_ARM_REASON.selected : CONTRAST_ARM_REASON.clean;
  return {
    verdict: selected ? 'fire' : 'clean', statistic: logE, threshold, alpha_consumed: 0, alpha_spent: 0,
    reason_code: reason, family: 'A', signal: p.signal,
    pair: pairId(p), canary: p.canary, control: p.control, log_e: logE, S_t: st.S_t, t: st.ticks,
    monitor_passing: passing, last_residual: st.lastResidual,
  };
}

/** Select across the admissible pairs under one budget through the engine's guarded e-BH. Exported
 *  so the registered study reads the same function the gate runs. */
export function selectContrastArm(
  candidates: ReadonlyArray<{ pair: string; log_e: number }>, q: number, fitTicks: number, gate: ContrastArmHealth['gate'],
  assertions: FdrPathAssertions = { mMuchGreaterThanN: true },
): { selected: string[]; log_threshold_e: number | null; log_margins: Record<string, number> } {
  if (candidates.length === 0 || gate === 'refused_fit_ratio' || gate === 'refused_tail_premise' || gate === 'no_admissible_pairs') {
    return { selected: [], log_threshold_e: null, log_margins: {} };
  }
  // The one assertion site. Part 1's law: the mixture wealth's excess under the estimated offset is
  // about n/m nats over the horizon, so a fit of >= CONTRAST_FIT_RATIO_FLOOR canary lengths is
  // epsilon ~ 1/CONTRAST_FIT_RATIO_FLOOR on the FDR level (Ramdas-Wang Thm 10.24). Asserted, not proven.
  // Since engine v0.11.0-pre the envelope also carries the mixture's mgf tail premise; the caller
  // passes the cohort's measured increment mean and/or the study-only promise (h0-battery A7).
  const out = eBenjaminiHochbergGuarded(
    candidates.map((c) => ({ detectorId: 'contrast_null_mixture', eValue: Math.exp(c.log_e), assertions, calLen: fitTicks })), q,
  );
  const selected = out.selected.map((i) => candidates[i].pair);
  const log_margins: Record<string, number> = {};
  out.selected.forEach((i, k) => { log_margins[candidates[i].pair] = out.log_margin?.[k] ?? candidates[i].log_e - out.log_threshold_e; });
  return { selected, log_threshold_e: out.log_threshold_e, log_margins };
}

/** The cohort first: the Mode gate's reading precedes the selection. */
function advanceCohort(spec: ControlArmProfile, s: ArmStore, opts: ContrastArmOpts, liveMetrics: Metrics): void {
  for (const c of spec.control_cohort) {
    const id = cohortId(c);
    const b = opts.cohortBaseline?.[id];
    if (!b) continue;
    const st = (s.cohort[id] ??= newCohortState(b));
    const a = read(liveMetrics, c.a), bb = read(liveMetrics, c.b);
    if (a !== null && bb !== null) advanceCohort_(st, a - bb);
  }
}

interface PairRow { p: ControlArmPair; st: PairState; passing: boolean }

/** Advance every declared pair with a baseline; return the rows. */
function advancePairs(spec: ControlArmProfile, s: ArmStore, opts: ContrastArmOpts, liveMetrics: Metrics, monitors: Record<string, boolean>): PairRow[] {
  const rows: PairRow[] = [];
  for (const p of spec.pairs) {
    const id = pairId(p);
    const b = opts.baseline[id];
    if (!b) continue;
    const st = (s.pairs[id] ??= newPairState(b));
    const x = read(liveMetrics, p.canary), y = read(liveMetrics, p.control);
    if (x !== null && y !== null) advancePair(st, x - y);
    rows.push({ p, st, passing: monitors[p.signal] !== false });
  }
  return rows;
}

const logEOf = (st: PairState): number => finite(Math.log(Math.max(st.mixture.M_t ?? 1, 1e-300)));

/** Which route to the guarded e-BH this tick. */
function gateFor(nCandidates: number, fitRatio: number | null, studyFlag: boolean | undefined, tailOk: boolean): ContrastArmHealth['gate'] {
  if (nCandidates === 0) return 'no_admissible_pairs';
  const fit: ContrastArmHealth['gate'] = fitRatio !== null && fitRatio >= CONTRAST_FIT_RATIO_FLOOR ? 'asserted_m_much_greater_than_n'
    : studyFlag ? 'asserted_by_study_flag' : 'refused_fit_ratio';
  if (fit === 'refused_fit_ratio') return fit;
  return tailOk ? fit : 'refused_tail_premise';
}

/** The control arm, one tick. Appends nothing to family_A_shadow and pushes nothing to rollback:
 *  the block lands on `result.contrast_arm` and the fusion layer reports it. */
export function runContrastArm(
  result: HealthResult, liveMetrics: Metrics, tb: TrendBufferI, cfg: CompiledConfig | null | undefined,
  opts: ContrastArmOpts | undefined, totalTicks: number | undefined,
): void {
  const spec = cfg?.control_arm;
  if (!spec || !opts) return;
  const s = store(tb);
  advanceCohort(spec, s, opts, liveMetrics);
  const monitors = monitorsFor(spec, s);
  const rows = advancePairs(spec, s, opts, liveMetrics, monitors);
  const candidates = rows.filter((r) => r.passing && r.st.ticks > 0).map((r) => ({ pair: pairId(r.p), log_e: logEOf(r.st) })).filter((c) => Number.isFinite(c.log_e));
  const fitRatio = totalTicks && totalTicks > 0 ? spec.fit_ticks / totalTicks : null;
  const incrementMean = incrementMeanFor(s);
  const assertions = contrastAssertions(incrementMean, opts.assertLightTails);
  const tail = contrastTailPremise(assertions);
  const gate = gateFor(candidates.length, fitRatio, opts.assertFitRatio, tail.reason === undefined);
  const sel = selectContrastArm(candidates, spec.q ?? CONTRAST_ARM_Q, spec.fit_ticks, gate, assertions);
  const chosen = new Set(sel.selected);
  const block: ContrastArmHealth = {
    authority: CONTRAST_ARM_AUTHORITY, q: spec.q ?? CONTRAST_ARM_Q, fit_ticks: spec.fit_ticks, fit_ratio: fitRatio, gate, K: candidates.length,
    tail_premise: tail.token, ...(incrementMean ? { increment_mean: incrementMean } : {}), ...(tail.reason ? { tail_premise_reason: tail.reason } : {}),
    verdicts: rows.map(({ p, st, passing }) => verdictFor(p, st, passing, chosen.has(pairId(p)), sel.log_threshold_e)),
    selected: sel.selected, log_threshold_e: sel.log_threshold_e, log_margins: sel.log_margins, monitors,
  };
  (result as HealthResult & { contrast_arm?: ContrastArmHealth }).contrast_arm = block;
}

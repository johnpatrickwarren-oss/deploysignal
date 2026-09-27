// engine/gates/_health-twin.ts — Plan B: the randomized twin (engine ADR 0036) as a DeploySignal
// gate path. A thin wrapper over the engine's `stepTwinGate` (per-shard/twin-gate.ts): it converts
// the profile / HTTP `twin_arm` block (snake_case) to the engine's TwinGateConfig, steps the gate
// one tick, maps the engine verdict onto the gate vocabulary, and adds the planning figure
// `ticks_to_detect` (per-shard/twin-planning.ts) once it is computable.
//
// WHAT THE TWIN TESTS. The canary against a CONCURRENT control arm on the old version under
// randomized per-request routing. `rate` metrics compare the canary's share of bad events with its
// traffic share (Fisher noncentral hypergeometric, nothing estimated); `sign` metrics ask whether
// the canary's tick value is worse than the control's (null ½, equal weights required). The engine
// refuses a sign metric at canaryWeight ≠ 0.5, and a rate metric there unless
// allow_unequal_rate_split is set (study 2026-09-twin-null P2: 0.755 false rollback at w 0.1).
//
// AUTHORITY: ADVISORY (`TWIN_ARM_AUTHORITY`, engine/guarantees.ts). The report carries the verdict;
// nothing here enters rollback[], firing_families or alpha_spent. The premise (no arm-level effect
// on any tick) is untested on a real service; the authority ADR follows a real-service A/A run.
//
// ONLY THIS PATH. evaluateHealth routes a compiled config with `twin_arm` here and returns: no
// Family A/B/C/D/E, no structural rules (engine/gates/health.ts). The gate state rides the
// TrendBuffer (`twinArmState`), the per-deploy persistence the contrast arm and the valid path use.

import {
  initTwinGate, stepTwinGate,
  type TwinGateConfig, type TwinGateState, type TwinTickInput, type TwinVerdict,
} from '@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-gate';
import type { TwinObservation, TwinMetricSpec } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/twin-contrast';
import { ticksToDetect } from '@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-planning';
import type { HealthResult, TrendBufferI, CompiledConfig } from '../types';
import type { TwinArmProfile, TwinArmMetricProfile } from '../types/_config-profiles';
import { TWIN_ARM_AUTHORITY } from '../guarantees';

export type { TwinArmProfile, TwinArmMetricProfile, TwinTickInput, TwinVerdict, TwinGateState };

/** The gate vocabulary a twin verdict maps onto (the HTTP contract's `verdict`). */
export type TwinGateVerdict = 'rollback' | 'proceed' | 'extend' | 'hold' | 'halt';

/** Engine verdict → gate verdict. `inconclusive` (max_ticks with neither test decided) is a hold for
 *  a person, never a pass; `invalid_experiment` (the sample-ratio guard) is halt-and-shift-back. */
export const TWIN_VERDICT_MAP: Readonly<Record<TwinVerdict, TwinGateVerdict>> = Object.freeze({
  rollback: 'rollback',
  proceed: 'proceed',
  extend: 'extend',
  inconclusive: 'hold',
  invalid_experiment: 'halt',
});

/** One metric's evidence, snake_case (the HTTP contract's `metrics[]`). */
export interface TwinMetricReportSnake {
  id: string;
  rollback_e: number;
  rollback_threshold: number;
  proceed_e: number;
  proceed_threshold: number;
  used: number;
  skipped: number;
  ties: number;
  missing: number;
}

/** One tick's report: the HTTP contract's tick response body plus the SRM threshold. */
export interface TwinArmReport {
  verdict: TwinGateVerdict;
  engine_verdict: TwinVerdict;
  authority: typeof TWIN_ARM_AUTHORITY;
  tick: number;
  srm_e: number;
  srm_threshold: number;
  metrics: TwinMetricReportSnake[];
  ticks_to_detect?: number;
}

/** Per-rate-metric accumulators for the planning figure: bad events seen and ticks that carried
 *  them. Nothing here is read by the rollback or proceed tests. */
export interface TwinPlanningAccumulator { badEvents: number; ticks: number }

/** The per-deploy run: the engine's gate state plus the planning accumulators. JSON-serialisable. */
export interface TwinArmRun {
  state: TwinGateState;
  planning: Record<string, TwinPlanningAccumulator>;
}

function metricSpec(m: TwinArmMetricProfile): TwinMetricSpec {
  return { id: m.id, kind: m.kind, worse: m.worse, tolerance: m.tolerance };
}

/** The profile / HTTP block as the engine's TwinGateConfig. */
export function twinGateConfig(p: TwinArmProfile): TwinGateConfig {
  return {
    metrics: p.metrics.map(metricSpec),
    alphaRollback: p.alpha_rollback,
    alphaProceed: p.alpha_proceed,
    alphaSrm: p.alpha_srm,
    canaryWeight: p.canary_weight,
    maxTicks: p.max_ticks,
    ...(p.allow_unequal_rate_split !== undefined ? { allowUnequalRateSplit: p.allow_unequal_rate_split } : {}),
  };
}

/** A fresh run. Throws the engine's RangeError on a config it refuses (checkTwinGateConfig). */
export function freshTwinArm(p: TwinArmProfile): TwinArmRun {
  const planning: Record<string, TwinPlanningAccumulator> = {};
  for (const m of p.metrics) if (m.kind === 'rate') planning[m.id] = { badEvents: 0, ticks: 0 };
  return { state: initTwinGate(twinGateConfig(p)), planning };
}

/** Bad events in one rate observation (the engine's convention: `worse: 'lower'` means the events
 *  are successes), or null when the tick carries no usable count. */
function badEventsOf(m: TwinArmMetricProfile, obs: TwinObservation | undefined): number | null {
  if (!obs || !('canaryTotal' in obs)) return null;
  const { canaryEvents: ce, canaryTotal: ct, controlEvents: ke, controlTotal: kt } = obs;
  if (![ce, ct, ke, kt].every(Number.isFinite) || ct === 0 || kt === 0) return null;
  return m.worse === 'higher' ? ce + ke : (ct - ce) + (kt - ke);
}

function advancePlanning(p: TwinArmProfile, run: TwinArmRun, input: TwinTickInput): Record<string, TwinPlanningAccumulator> {
  const out: Record<string, TwinPlanningAccumulator> = {};
  for (const m of p.metrics) {
    if (m.kind !== 'rate') continue;
    const acc = run.planning[m.id] ?? { badEvents: 0, ticks: 0 };
    const bad = badEventsOf(m, input.observations[m.id]);
    out[m.id] = bad === null ? { ...acc } : { badEvents: acc.badEvents + bad, ticks: acc.ticks + 1 };
  }
  return out;
}

/** One metric's planning figure at level α, or null when not computable yet. */
function metricTicksToDetect(p: TwinArmProfile, run: TwinArmRun, m: TwinArmMetricProfile, alpha: number): number | null {
  if (m.kind === 'rate') {
    const acc = run.planning[m.id];
    if (!acc || acc.ticks === 0 || acc.badEvents === 0) return null;
    return ticksToDetect({
      kind: 'rate', canaryShare: p.canary_weight, oddsRatio: 1 + m.tolerance,
      badEventsPerTick: acc.badEvents / acc.ticks, alpha,
    });
  }
  const st = run.state.metrics[m.id];
  const seen = st ? st.used + st.ties : 0;
  if (seen === 0) return null;
  const tieRate = st.ties / seen;
  if (tieRate >= 1) return null;
  return ticksToDetect({ kind: 'sign', excessProbability: m.tolerance, tieRate, alpha });
}

/** Ticks a bake needs, from the start, for the ROLLBACK test to catch a regression of each metric's
 *  tolerance at the per-metric level α_rollback / N: the maximum over metrics, rounded up. A power
 *  figure (engine per-shard/twin-planning.ts: second-order growth at the capped Kelly bet, adaptive
 *  λ's learning cost omitted). Undefined until every metric is computable and finite: a rate metric
 *  needs one tick with bad events, a sign metric one scored or tied tick. */
export function ticksToDetectFor(p: TwinArmProfile, run: TwinArmRun): number | undefined {
  const alpha = p.alpha_rollback / p.metrics.length;
  let worst = 0;
  for (const m of p.metrics) {
    const t = metricTicksToDetect(p, run, m, alpha);
    if (t === null || !Number.isFinite(t)) return undefined;
    worst = Math.max(worst, t);
  }
  return Math.ceil(worst);
}

/** One tick. Pure: returns the next run and the report; the input run is not mutated. Throws the
 *  engine's RangeError/TypeError on malformed counts or an observation of the wrong kind. */
export function stepTwinArm(p: TwinArmProfile, run: TwinArmRun, input: TwinTickInput): { run: TwinArmRun; report: TwinArmReport } {
  const { state, decision } = stepTwinGate(twinGateConfig(p), run.state, input);
  const next: TwinArmRun = { state, planning: advancePlanning(p, run, input) };
  const ttd = ticksToDetectFor(p, next);
  const report: TwinArmReport = {
    verdict: TWIN_VERDICT_MAP[decision.verdict],
    engine_verdict: decision.verdict,
    authority: TWIN_ARM_AUTHORITY,
    tick: decision.tick,
    srm_e: decision.srmE,
    srm_threshold: decision.srmThreshold,
    metrics: decision.metrics.map((m) => ({
      id: m.id, rollback_e: m.rollbackE, rollback_threshold: m.rollbackThreshold,
      proceed_e: m.proceedE, proceed_threshold: m.proceedThreshold,
      used: m.used, skipped: m.skipped, ties: m.ties, missing: m.missing,
    })),
    ...(ttd !== undefined ? { ticks_to_detect: ttd } : {}),
  };
  return { run: next, report };
}

// ── evaluateHealth's twin-only path ──────────────────────────────────────────────────────────

type StoreHost = { twinArmState?: TwinArmRun };

/** A HealthResult carrying the twin report (an extension field, like `contrast_arm`). */
export type TwinArmHealth = HealthResult & { twin_arm?: TwinArmReport };

/** The whole health evaluation for a compiled config that declares `twin_arm`: an empty rollback
 *  and extend list and, when the caller supplied this tick's input and a TrendBuffer, the twin
 *  report on `result.twin_arm`. Nothing else runs. */
export function evaluateTwinOnly(
  cfg: CompiledConfig, tb: TrendBufferI | null, input: TwinTickInput | undefined, warmup: HealthResult['warmup'],
): TwinArmHealth {
  const result: TwinArmHealth = { rollback: [], extend: [], warmup, suppressed: [] };
  const spec = cfg.twin_arm;
  if (!spec || !input || !tb) return result;
  const host = tb as TrendBufferI & StoreHost;
  const step = stepTwinArm(spec, host.twinArmState ?? freshTwinArm(spec), input);
  host.twinArmState = step.run;
  result.twin_arm = step.report;
  return result;
}

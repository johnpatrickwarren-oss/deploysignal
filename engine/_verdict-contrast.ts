// engine/_verdict-contrast.ts — C81 (Part 2): the control arm's report on the fused verdict. Split
// from engine/verdict.ts so that file stays under the architecture gate's 800-line ceiling.
// ADVISORY: the block reports the arm's selection (through the engine's guarded e-BH, only under the
// fit-ratio assertion), its margins, the cohort monitors, and e-BY intervals on the selected pairs'
// residual means; it never touches `verdict`, `firing_families` or `total_alpha_spent`.

import type { HealthResult } from './types';
import type { ContrastArmReport, EffectIntervalsEBy } from './types/verdict';
import type { ContrastArmHealth } from './gates/_health-contrast';
import { E_BY_DELTA, CONTRAST_MIXTURE_PRIOR } from './guarantees';
import { eBenjaminiYekutieli } from '@johnpatrickwarren-oss/deploysignal-engine/fleet/e-by';

/** e-BY on the selected pairs: the level-free inputs are the residual's running sum and count with
 *  σ² = 1 (the residual is standardized) and ρ = the mixing prior; K = the admissible universe. */
function contrastEffectIntervals(block: ContrastArmHealth): EffectIntervalsEBy | undefined {
  if (block.K === 0) return undefined;
  const selected = block.verdicts.filter((v) => v.monitor_passing && block.selected.includes(v.pair) && v.t > 0);
  const out = eBenjaminiYekutieli(
    selected.map((v) => ({ id: v.pair, level_free: { S_t: v.S_t, t: v.t, sigma_squared: 1, sigma_squared_prior: CONTRAST_MIXTURE_PRIOR } })),
    block.K, E_BY_DELTA,
  );
  return {
    delta: out.delta, K: out.K, selected_count: out.selected_count, alpha_i: out.alpha_i,
    intervals: out.intervals.map((i) => ({ signal: i.id, alpha_i: i.alpha_i, center: i.center, half_width: i.half_width, lower: i.lower, upper: i.upper })),
    guarantee: out.guarantee,
    note: 'shift of the standardized contrast residual mean (treatment − control, in the fit\'s scale units) from 0; covers the shift from the ESTIMATED offset; reported, no verdict authority',
  };
}

/** The report, or undefined when the arm did not run (so every pre-existing verdict shape is unchanged). */
export function contrastArmReport(health: HealthResult): ContrastArmReport | undefined {
  const block = (health as HealthResult & { contrast_arm?: ContrastArmHealth }).contrast_arm;
  if (!block) return undefined;
  const effect_intervals = contrastEffectIntervals(block);
  return {
    authority: block.authority, q: block.q, fit_ticks: block.fit_ticks, fit_ratio: block.fit_ratio, gate: block.gate, K: block.K,
    pairs: block.verdicts.map((v) => ({ pair: v.pair, signal: v.signal ?? '', canary: v.canary, control: v.control, log_e: v.log_e, monitor_passing: v.monitor_passing, selected: block.selected.includes(v.pair), reason_code: v.reason_code })),
    selected: block.selected.slice(), log_threshold_e: block.log_threshold_e, log_margins: { ...block.log_margins }, monitors: { ...block.monitors },
    ...(effect_intervals ? { effect_intervals } : {}),
    note: 'ADVISORY (engine ADR 0032: the contrast null was refused an admitting envelope — the estimated offset is the plug-in n >> m price); selection reported through the guarded e-BH only under the fit-ratio assertion; never a rollback, never alpha',
  };
}

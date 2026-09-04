// engine/_verdict-e-by.ts — C62 (b), engine ADR 0030: the e-BY effect-size intervals the fused
// verdict reports for the Family A mixture signals that fired. Split from engine/verdict.ts so
// that file stays under the architecture gate's 800-line ceiling.

import type { DetectorVerdict } from './types';
import type { EffectIntervalsEBy } from './types/verdict';
import { FAMILY_A_PLUGIN_ADVISORY_REASON, E_BY_DELTA } from './guarantees';
import { eBenjaminiYekutieli } from '@johnpatrickwarren-oss/deploysignal-engine/fleet/e-by';

/** C62 (b), engine ADR 0030 — e-BY intervals for the fired mixture signals. K is every Family A
 *  verdict carrying a confidence sequence this tick (the mixture path; betting and safe-t
 *  entries carry none), S the fired ones that are not advisory plug-in fires (C64 b). Absent
 *  when no verdict carries a CS, so pre-0030 pins and the Beta path leave the verdict unchanged. */
export function eByEffectIntervals(famA: DetectorVerdict[]): EffectIntervalsEBy | undefined {
  const withCs = famA.filter((v) => v.signal && v.evidence?.confidence_sequence);
  if (withCs.length === 0) return undefined;
  const fired = withCs.filter((v) => v.verdict === 'fire' && v.reason_code !== FAMILY_A_PLUGIN_ADVISORY_REASON);
  const out = eBenjaminiYekutieli(
    fired.map((v) => ({ id: v.signal!, level_free: v.evidence!.confidence_sequence!.level_free })), withCs.length, E_BY_DELTA,
  );
  return {
    delta: out.delta, K: out.K, selected_count: out.selected_count, alpha_i: out.alpha_i,
    intervals: out.intervals.map((i) => ({ signal: i.id, alpha_i: i.alpha_i, center: i.center, half_width: i.half_width, lower: i.lower, upper: i.upper })),
    guarantee: out.guarantee,
    note: 'shift from the compiled baseline mean (whitened units when ar1_phi != 0); covers the shift from the ESTIMATE under an estimated baseline; reported, no verdict authority',
  };
}


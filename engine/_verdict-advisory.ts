// engine/_verdict-advisory.ts — C64 (b) helpers for the fusion layer (engine/verdict.ts):
// the advisory plug-in fire, the axis-3 form for the evidence outlook, and the note clause.
// Split out so verdict.ts stays under the repo's file-size ratchet; no fusion logic lives here.

import type { DetectorVerdict } from './types';
import { FAMILY_A_PLUGIN_ADVISORY_REASON, DETECTOR_GUARANTEES } from './guarantees';
import type { ApproximateEValueForm } from './guarantees';

/** A Family A plug-in fire on a signal the valid path is routed for: recorded, never a
 *  rollback trigger, books no α (engine/gates/_health-detectors.ts `advisoryPlugin`). */
export function isAdvisoryPluginFire(v: DetectorVerdict): boolean {
  return v.verdict === 'fire' && v.reason_code === FAMILY_A_PLUGIN_ADVISORY_REASON;
}

/** The axis-3 form of the Family A detector that produced `v`, read off this repo's guarantee
 *  table. The three constructions are told apart structurally: the terminal safe-t path by its
 *  reason_code prefix, the two plug-ins by the scale of their statistic — the caller passes
 *  `progressScaleFor(v)`; the ADR 0027 surface is never consulted, so a surface's presence
 *  changes nothing here. The Page-CUSUM mixture reports S_n against −log α (linear), the
 *  betting e-process wealth against its threshold (wealth). */
export function approximateEValueFor(v: DetectorVerdict, scale: 'linear' | 'wealth'): ApproximateEValueForm | undefined {
  if (v.family !== 'A' || !v.signal) return undefined;
  const id = v.reason_code.startsWith('safe_t_') ? `safe_t_e_value_${v.signal}`
    : scale === 'wealth' ? `betting_e_process_${v.signal}`
      : `mSPRT_${v.signal}`;
  return (DETECTOR_GUARANTEES as Record<string, { approximate_e_value?: ApproximateEValueForm }>)[id]?.approximate_e_value;
}

/** Trailing note clause naming advisory plug-in fires on routed signals; empty when none. */
export function advisoryPluginClause(advisoryFiredSignals: ReadonlyArray<string> | undefined): string {
  return advisoryFiredSignals && advisoryFiredSignals.length > 0
    ? `; plug-in fired advisory on ${advisoryFiredSignals.join(', ')} (routed to the valid path; no α spent)`
    : '';
}

// engine/_verdict-advisory.ts — advisory Family A helpers for the fusion layer (engine/verdict.ts):
// the advisory plug-in fire (C64 b, and FAMILY_A_ROLLBACK_AUTHORITY), the axis-3 form for the
// evidence outlook, and the note clauses.
// Split out so verdict.ts stays under the repo's file-size ratchet; no fusion logic lives here.

import type { DetectorVerdict } from './types';
import {
  FAMILY_A_PLUGIN_ADVISORY_REASON, FAMILY_A_UNAUTHORIZED_ADVISORY_REASON, DETECTOR_GUARANTEES,
  TEMPORAL_PATH_ADVISORY_REASON, temporalPathAdvisory,
} from './guarantees';
import type { ApproximateEValueForm } from './guarantees';

/** An advisory Family A plug-in fire — on a signal the valid path is routed for (C64 b), or on a
 *  signal without rollback authority (FAMILY_A_ROLLBACK_AUTHORITY): recorded, never a rollback
 *  trigger, books no α (engine/gates/_health-detectors.ts `advisoryPlugin`). */
export function isAdvisoryPluginFire(v: DetectorVerdict): boolean {
  return v.verdict === 'fire'
    && (v.reason_code === FAMILY_A_PLUGIN_ADVISORY_REASON || v.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON);
}

/** C87 — the health gate's treatment of one temporal-path verdict while the path is advisory:
 *  no α on any verdict; a fire that would have been pushed to rollback[] under `rollbackId`
 *  carries `advisory_reason` and `advisory_id` instead (its own `reason_code` is kept, so scale
 *  classification and the audit's detector-id resolution read what they read before). Not marked:
 *  an advisory plug-in fire (C64 b / unauthorized signal — its reason_code already says why) and
 *  a fire whose rollback id the warm-up suppression list holds (`rollbackId` null). */
export function temporalAdvisoryVerdict(v: DetectorVerdict, rollbackId: string | null): DetectorVerdict {
  if (!temporalPathAdvisory()) return v;
  const mark = v.verdict === 'fire' && rollbackId !== null && !isAdvisoryPluginFire(v);
  return {
    ...v, alpha_consumed: 0, alpha_spent: 0,
    ...(mark ? { advisory_reason: TEMPORAL_PATH_ADVISORY_REASON, advisory_id: rollbackId } : {}),
  };
}

/** C87 — the detection half of the corpus metric ("rollback OR an advisory A/C/D fire"): the
 *  rollback ids the temporal path would have pushed this tick had it held authority, read off the
 *  marks the health gate left. Empty when nothing fired, or when the path holds authority (then
 *  the ids are on `rollback[]` itself). */
export function temporalAdvisoryFireIds(hr: TemporalVerdicts | null | undefined): string[] {
  return temporalAdvisoryFires(hr).map((f) => f.id);
}

type TemporalVerdicts = {
  family_A_shadow?: object[]; family_C_verdict?: object | null;
  family_C_mmd_verdict?: object | null; family_D_shadow?: object[];
};

/** One advisory temporal-path fire as the reporting surfaces carry it (the gate service's
 *  `advisory_fires`): the rollback id it would have had, its family, and why it is advisory. */
export interface TemporalAdvisoryFire { id: string; family: 'A' | 'C' | 'D'; advisory_reason: string }

/** C87 — the advisory A/C/D fires on a health result, in A, C, D order. */
export function temporalAdvisoryFires(hr: TemporalVerdicts | null | undefined): TemporalAdvisoryFire[] {
  if (!hr) return [];
  const all: Array<object | null | undefined> = [
    ...(hr.family_A_shadow ?? []), hr.family_C_verdict, hr.family_C_mmd_verdict, ...(hr.family_D_shadow ?? []),
  ];
  const out: TemporalAdvisoryFire[] = [];
  for (const v of all) {
    const m = (v ?? {}) as { advisory_id?: string; advisory_reason?: string; family?: 'A' | 'C' | 'D' };
    if (m.advisory_id !== undefined && m.family) out.push({ id: m.advisory_id, family: m.family, advisory_reason: m.advisory_reason ?? '' });
  }
  return out;
}

type Fam = 'A' | 'B' | 'C' | 'D' | 'E';

/** C87 — split the families with a fire this tick by authority; both lists in A<B<C<D<E order.
 *  `A`, `C`, `D`: the family has a fire that is not an advisory plug-in fire; they drive the
 *  verdict only when the temporal path holds authority. `aPluginAdvisory`: Family A has an
 *  advisory plug-in fire (C64 b / unauthorized signal). `E`: Family E fires with authority
 *  (never, while FAMILY_E_ADVISORY); `eDetected`: it has a fire at all. */
export function splitFiredFamilies(d: {
  A: boolean; aPluginAdvisory: boolean; B: boolean; C: boolean; D: boolean; E: boolean; eDetected: boolean;
}): { firing: Fam[]; advisory: Fam[] } {
  const temporal = !temporalPathAdvisory();
  const firing: Fam[] = [], advisory: Fam[] = [];
  const route = (fam: Fam, fires: boolean, detected: boolean): void => {
    if (fires) firing.push(fam);
    else if (detected) advisory.push(fam);
  };
  route('A', d.A && temporal, d.A || d.aPluginAdvisory);
  route('B', d.B, false);
  route('C', d.C && temporal, d.C);
  route('D', d.D && temporal, d.D);
  route('E', d.E, d.eDetected);
  return { firing, advisory };
}

/** C87 — the `advisory_reason` a verdict carries, if any. The HealthResult's verdict arrays are
 *  typed by the pinned engine package, whose DetectorVerdict does not declare the field. */
export function advisoryReasonOf(v: object): string | undefined {
  return (v as { advisory_reason?: string }).advisory_reason;
}

/** The advisory fires split by reason, as the FamilyEvidenceRaw fields; a list is present only
 *  when non-empty, so a family without advisory fires gets no keys. */
export function advisoryFireFields(advisory: ReadonlyArray<DetectorVerdict>): {
  advisoryFiredSignals?: string[]; unauthorizedFiredSignals?: string[];
} {
  const routed = advisory.filter((v) => v.reason_code === FAMILY_A_PLUGIN_ADVISORY_REASON).map((v) => v.signal ?? 'unknown');
  const unauth = advisory.filter((v) => v.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON).map((v) => v.signal ?? 'unknown');
  return {
    ...(routed.length > 0 ? { advisoryFiredSignals: routed } : {}),
    ...(unauth.length > 0 ? { unauthorizedFiredSignals: [...new Set(unauth)] } : {}),
  };
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

/** Trailing note clauses naming advisory plug-in fires: on routed signals (C64 b), then on
 *  signals without Family A rollback authority. Empty when none. */
export function advisoryPluginClause(r: {
  advisoryFiredSignals?: ReadonlyArray<string>; unauthorizedFiredSignals?: ReadonlyArray<string>;
}): string {
  const routed = r.advisoryFiredSignals && r.advisoryFiredSignals.length > 0
    ? `; plug-in fired advisory on ${r.advisoryFiredSignals.join(', ')} (routed to the valid path; no α spent)`
    : '';
  const unauth = r.unauthorizedFiredSignals && r.unauthorizedFiredSignals.length > 0
    ? `; plug-in fired advisory on ${r.unauthorizedFiredSignals.join(', ')} (signal not authorized for Family A rollback; no α spent)`
    : '';
  return routed + unauth;
}

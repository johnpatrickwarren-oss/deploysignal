// engine/_orchestrator-lifecycle.ts — Addition #14 lifecycle emission
// helpers. Extracted verbatim from engine/orchestrator.ts (god-file split).
// Orchestrator-internal; not part of the public facade surface.

import { safeEmit } from './o0/lifecycle-events';
import type {
  LifecycleEventEmitter, LifecycleDeployState,
} from './o0/lifecycle-events';
import type {
  OrchestrateParams, VerdictResult, HealthResult, FamilyId,
  AuditRecord, AuditRecordV2,
} from './types';

// Emits the per-tick lifecycle sequence in the canonical order:
//   started (tick 0 only) → tick → suppressed (on transitions) → finished (terminal).
// Mutates `lifecycleState` latches exactly as the inline `_emit` body did.
export function emitTickLifecycle(
  lifecycleEmitter: LifecycleEventEmitter,
  lifecycleState: LifecycleDeployState,
  params: OrchestrateParams,
  result: VerdictResult,
  record: AuditRecord | AuditRecordV2 | null,
  deployId: string,
  tick: number,
  total: number,
): void {
  if (tick === 0 && !lifecycleState.startedEmitted) {
    emitStarted(lifecycleEmitter, deployId, params, result);
    lifecycleState.startedEmitted = true;
  }
  if (record) {
    safeEmit(lifecycleEmitter, 'evaluation.tick', {
      type: 'evaluation.tick',
      deploy_id: deployId,
      tick,
      audit_record: record,
    });
  }
  emitSuppressionTransitions(lifecycleEmitter, deployId, tick, result.healthResult, lifecycleState);
  if (!lifecycleState.finishedEmitted && isTerminal(result, tick, total)) {
    safeEmit(lifecycleEmitter, 'evaluation.finished', {
      type: 'evaluation.finished',
      deploy_id: deployId,
      final_verdict: result.verdict,
      total_alpha_spent: result.gateResults?.fusion?.total_alpha_spent ?? 0,
      families_summary: summarizeFamilies(result.healthResult),
    });
    lifecycleState.finishedEmitted = true;
  }
}

export function emitStarted(
  emitter: LifecycleEventEmitter,
  deployId: string,
  params: OrchestrateParams,
  result: VerdictResult,
): void {
  const cfg = params.compiledConfig;
  // cell_key uses the hour/day the orchestrator was called with; null
  // when the caller didn't thread cell coordinates through. cell_confidence
  // looks up the compiled-config cell; falls back to 'aggregate' when we
  // can't identify a cell (plain runtime without compiled_config).
  let cellKey: { hour_of_day?: number; day_of_week?: number } | null = null;
  if (params.currentHourOfDay !== undefined) {
    cellKey = { hour_of_day: params.currentHourOfDay };
    if (params.currentDayOfWeek !== undefined) cellKey.day_of_week = params.currentDayOfWeek;
  }
  let cellConfidence = 'aggregate';
  if (cfg?.baseline_cells && cellKey) {
    const match = cfg.baseline_cells.cells.find((c) => {
      if (c.key.hour_of_day !== cellKey!.hour_of_day) return false;
      if (cellKey!.day_of_week !== undefined && c.key.day_of_week !== undefined) {
        return c.key.day_of_week === cellKey!.day_of_week;
      }
      return true;
    });
    if (match) cellConfidence = match.confidence;
  }
  const families: FamilyId[] = ['B'];  // structural signatures always eligible
  if (cfg?.baseline_cells?.cells.some((c) => c.family_A)) families.push('A');
  if (cfg?.baseline_cells?.cells.some((c) => c.family_C)) families.push('C');
  if (cfg?.baseline_cells?.aggregate_fallback.family_D) families.push('D');
  if (cfg?.baseline_cells?.aggregate_fallback.family_E) families.push('E');
  families.sort();
  safeEmit(emitter, 'evaluation.started', {
    type: 'evaluation.started',
    deploy_id: deployId,
    cell_key: cellKey,
    cell_confidence: cellConfidence,
    families_eligible: families,
  });
  // Silence the unused-var warning from `result` — the parameter is
  // there for future extensions (e.g., surfacing the first tick's
  // verdict in the started event) but isn't consumed today.
  void result;
}

/** Compute the per-family "is this family suppressed right now" map.
 *  Family B structural signatures don't emit a suppression verdict, so
 *  B stays `false` for transition purposes. Families A/C/D/E use the
 *  health-result's shadow/verdict fields to determine suppression. */
function computeFamilySuppression(hr: HealthResult | null): Record<FamilyId, boolean> {
  const out: Record<FamilyId, boolean> = { A: false, B: false, C: false, D: false, E: false };
  if (!hr) return out;
  if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    out.A = hr.family_A_shadow.every((v) => v.verdict === 'suppressed');
  }
  if (hr.family_C_verdict) out.C = hr.family_C_verdict.verdict === 'suppressed';
  if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    out.D = hr.family_D_shadow.every((v) => v.verdict === 'suppressed');
  }
  if (hr.family_E_verdict) out.E = hr.family_E_verdict.verdict === 'suppressed';
  return out;
}

function suppressionReasonFor(hr: HealthResult | null, fam: FamilyId): string {
  if (!hr) return 'unknown';
  if (fam === 'A' && hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    return hr.family_A_shadow[0].reason_code;
  }
  if (fam === 'C' && hr.family_C_verdict) return hr.family_C_verdict.reason_code;
  if (fam === 'D' && hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    return hr.family_D_shadow[0].reason_code;
  }
  if (fam === 'E' && hr.family_E_verdict) return hr.family_E_verdict.reason_code;
  return 'unknown';
}

export function emitSuppressionTransitions(
  emitter: LifecycleEventEmitter,
  deployId: string,
  tick: number,
  hr: HealthResult | null,
  state: LifecycleDeployState,
): void {
  const now = computeFamilySuppression(hr);
  const families: FamilyId[] = ['A', 'B', 'C', 'D', 'E'];
  // Tick 0 is the baseline: record the initial per-family state but do
  // not emit `evaluation.suppressed` events. The spec is "emit when a
  // family transitions into a suppressed state MID-EVALUATION"; tick 0
  // is the initial state, not a transition. Otherwise deploys whose
  // bake-profile gates start a family off suppressed would spam an
  // uninformative tick-0 event on every run.
  if (tick === 0) {
    for (const fam of families) state.perFamilySuppressionState[fam] = now[fam];
    return;
  }
  for (const fam of families) {
    const was = state.perFamilySuppressionState[fam];
    const is = now[fam];
    if (!was && is) {
      safeEmit(emitter, 'evaluation.suppressed', {
        type: 'evaluation.suppressed',
        deploy_id: deployId,
        tick,
        family_id: fam,
        suppression_reason: suppressionReasonFor(hr, fam),
      });
    }
    state.perFamilySuppressionState[fam] = is;
  }
}

export function isTerminal(result: VerdictResult, tick: number, total: number): boolean {
  if (result.shortCircuit !== null) return true;
  if (result.verdict === 'rollback' || result.verdict === 'proceed') return true;
  return tick >= total - 1;
}

export function summarizeFamilies(hr: HealthResult | null): Record<string, { verdict: string; alpha_spent: number }> {
  const out: Record<string, { verdict: string; alpha_spent: number }> = {};
  if (!hr) return out;
  if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    const anyFire = hr.family_A_shadow.some((v) => v.verdict === 'fire');
    const allSupp = hr.family_A_shadow.every((v) => v.verdict === 'suppressed');
    const alpha = hr.family_A_shadow.reduce((s, v) => s + v.alpha_spent, 0);
    out.A = { verdict: anyFire ? 'fire' : allSupp ? 'suppressed' : 'clean', alpha_spent: alpha };
  }
  if (hr.family_C_verdict) {
    out.C = { verdict: hr.family_C_verdict.verdict, alpha_spent: hr.family_C_verdict.alpha_spent };
  }
  if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    const anyFire = hr.family_D_shadow.some((v) => v.verdict === 'fire');
    const alpha = hr.family_D_shadow.reduce((s, v) => s + v.alpha_spent, 0);
    out.D = { verdict: anyFire ? 'fire' : 'clean', alpha_spent: alpha };
  }
  if (hr.family_E_verdict) {
    out.E = { verdict: hr.family_E_verdict.verdict, alpha_spent: hr.family_E_verdict.alpha_spent };
  }
  out.B = { verdict: hr.rollback.length > 0 ? 'fire' : 'clean', alpha_spent: 0 };
  return out;
}

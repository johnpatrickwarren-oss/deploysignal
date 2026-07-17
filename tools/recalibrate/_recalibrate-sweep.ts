// tools/recalibrate/_recalibrate-sweep.ts — Addition #15 baseline-
// maintenance lifecycle, Task 7. Lazy timeout sweep + calendar safety
// net (plan §B D1/D2 design decisions; math lives in the pure
// engine/recalibration/timeout.ts sibling).
//
// D1 — every tools/recalibrate.ts subcommand (Task 8) calls
// `sweepTimeouts` FIRST, before doing its own work — see
// engine/recalibration/timeout.ts's header for the full lazy-evaluation
// rationale.
//
// OQ-5 — only 'reviewable' candidates time out here. pending_readiness /
// pending_shadow candidates past their own timeout_at are NOT touched:
// the state machine (engine/recalibration/state-machine.ts,
// requireReviewable) defines no legal 'timeout' transition from those
// states. Task 8's `check`/`list` handlers are expected to surface them
// as stale warnings (via `isTimedOut(candidate.timeout_at, now)` against
// listCandidates() results) instead of rejecting them outright.

import type { CandidateRecord } from '../../engine/types/recalibration';
import { transition } from '../../engine/recalibration/state-machine';
import { isTimedOut, calendarRefreshDue } from '../../engine/recalibration/timeout';
import type {
  LifecycleEventEmitter, RecalibrationTimeoutRejectedPayload,
} from '../../engine/o0/lifecycle-events';
import type { RecalibrationStore } from './_recalibrate-store';

export interface SweepResult {
  rejected_candidate_ids: string[];
}

/** Transition every 'reviewable' candidate whose `timeout_at` has passed
 *  (per `isTimedOut`) to 'rejected' via the state machine's `timeout`
 *  event, persist the updated record, and emit
 *  'recalibration.timeout_rejected' with the OQ-6 escalation object
 *  embedded on the payload (no seventh event type). Returns the
 *  rejected candidate ids so the CLI caller (Task 8) can report/exit on
 *  them without re-deriving the set. */
export async function sweepTimeouts(
  store: RecalibrationStore,
  emitter: LifecycleEventEmitter,
  nowIso: string,
): Promise<SweepResult> {
  const serviceId = store.readMeta().service_id;
  const rejected: string[] = [];

  for (const candidate of store.listCandidates()) {
    if (candidate.review_status !== 'reviewable') continue;
    if (!isTimedOut(candidate.timeout_at, nowIso)) continue;

    const updated = transition(candidate, { kind: 'timeout', at: nowIso, actor: 'system' });
    store.writeCandidate(updated);
    rejected.push(candidate.candidate_id);

    const payload: RecalibrationTimeoutRejectedPayload = {
      type: 'recalibration.timeout_rejected',
      service_id: serviceId,
      candidate_id: candidate.candidate_id,
      proposed_baseline_version: candidate.proposed_baseline_version,
      current_baseline_version: candidate.current_baseline_version,
      direction_classification: candidate.direction_classification,
      at: nowIso,
      escalation: { escalated: true, escalated_to: 'engineering_leadership' },
    };
    await emitter.emit('recalibration.timeout_rejected', payload);
  }

  return { rejected_candidate_ids: rejected };
}

export interface CalendarSafetyNetResult {
  due: boolean;
  last_activity_at: string | null;
  open_candidate_id: string | null;
}

function lastActivityAt(store: RecalibrationStore, candidates: CandidateRecord[]): string | null {
  const timestamps: string[] = [];
  const active = store.readActive();
  if (active) timestamps.push(active.promoted_at);
  for (const c of candidates) timestamps.push(c.created_at);
  if (timestamps.length === 0) return null;
  return timestamps.reduce((max, t) => (t > max ? t : max));
}

/** D2 — lazy calendar safety net. `due` is true only when BOTH:
 *   (a) no candidate is currently "open" (review_status !== 'decided' —
 *       an in-flight recalibration already covers the calendar
 *       backstop's purpose, so it stands down), AND
 *   (b) `nowIso`'s UTC month is strictly later than the service's last
 *       known activity month — the latest of the active pointer's
 *       `promoted_at` and every candidate's `created_at`.
 *  A service with no history at all (`last_activity_at: null`) is never
 *  due — there's no starting point to measure a month boundary from.
 *  Candidate compilation stays `tools/calibrate.ts`'s job (plan §B D2)
 *  — this function only decides whether the guidance should fire; the
 *  CLI (Task 8) prints the suggested `propose --creation-reason
 *  calendar_safety_net` command and exits 3. */
export function checkCalendarSafetyNet(store: RecalibrationStore, nowIso: string): CalendarSafetyNetResult {
  const candidates = store.listCandidates();
  const openCandidate = candidates.find((c) => c.review_status !== 'decided');
  const lastActivity = lastActivityAt(store, candidates);

  if (openCandidate) {
    return { due: false, last_activity_at: lastActivity, open_candidate_id: openCandidate.candidate_id };
  }
  if (lastActivity === null) {
    return { due: false, last_activity_at: null, open_candidate_id: null };
  }
  return {
    due: calendarRefreshDue(lastActivity, nowIso),
    last_activity_at: lastActivity,
    open_candidate_id: null,
  };
}

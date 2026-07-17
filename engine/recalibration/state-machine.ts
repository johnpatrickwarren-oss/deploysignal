// engine/recalibration/state-machine.ts — Addition #15 baseline-
// maintenance lifecycle. Pure candidate lifecycle state machine.
//
// D6 (engine/tools split): pure logic, no fs, no I/O. `transition`
// takes a CandidateRecord + an event and returns a NEW record — it
// never mutates its input, so callers (tools/recalibrate/* CLI
// handlers, Task 8) own persistence and can retry/compose freely.
//
// Legal path (plan §C Task 2):
//
//   pending_readiness -(readiness_passed)-> pending_shadow
//     -(shadow_validated)-> reviewable
//   reviewable -(approve|auto_promote)-> status 'active', review_status
//     'decided', outcome set
//   reviewable -(reject|timeout)-> status 'rejected'
//   pending_shadow -(shadow_failed)-> status 'rejected', outcome
//     'shadow_mode_failed'
//   active -(superseded_by)-> status 'superseded'
//   pending_readiness -(readiness_failed)-> status 'rejected'
//     (readiness_failed sets no RecalibrationOutcome — the closed
//     RecalibrationOutcome set only covers post-readiness terminal
//     decisions; a readiness-gate rejection isn't one of the five
//     defined outcomes. Plan §C Task 8: the CLI's `propose` handler is
//     expected to build such a record directly for its exit-2 path,
//     but the state machine supports the transition too for candidates
//     that reach pending_readiness before a later readiness re-check.)
//
// Constraints (every event, checked in this order):
//   1. auto_promote is legal ONLY when direction_classification ===
//      'improvement' (checked regardless of review_status).
//   2. approve / reject require a reason_code drawn from
//      RECALIBRATION_REASON_CODES.
//   3. The (status, review_status) pair must match the event's legal
//      source state exactly — OQ-5: only 'reviewable' candidates can
//      time out; pending_* candidates are surfaced as stale warnings
//      elsewhere (Task 7), not timed out directly.
//   4. Every legal transition appends exactly one ReviewHistoryEntry.
//   5. Anything not explicitly legal throws InvalidTransitionError.

import type {
  CandidateRecord, ReviewHistoryEntry, RecalibrationOutcome,
} from '../types';
import { RECALIBRATION_REASON_CODES } from '../types';

/** Discriminated-union event set consumed by `transition`. Distinct
 *  from ReviewHistoryEntry['action'] naming in a few cases (e.g. event
 *  kind 'approve' produces history action 'approved') — the event
 *  describes the caller's intent/verb, the history entry records the
 *  outcome. */
export type RecalibrationEvent =
  | { kind: 'readiness_passed'; at: string; actor: string; readiness?: object }
  | { kind: 'readiness_failed'; at: string; actor: string; readiness?: object; comment?: string }
  | { kind: 'shadow_validated'; at: string; actor: string; shadow_report_path?: string }
  | { kind: 'shadow_failed'; at: string; actor: string; comment?: string }
  | { kind: 'approve'; at: string; actor: string; reason_code: string; comment?: string }
  | { kind: 'reject'; at: string; actor: string; reason_code: string; comment?: string }
  | { kind: 'auto_promote'; at: string; actor: string }
  | { kind: 'timeout'; at: string; actor: string }
  | { kind: 'superseded_by'; at: string; actor: string; superseded_by_candidate_id?: string };

/** Thrown for any event that is not legal from the record's current
 *  (status, review_status) — including reason-code and classification
 *  guard failures. */
export class InvalidTransitionError extends Error {
  readonly candidateId: string;
  readonly eventKind: RecalibrationEvent['kind'];

  constructor(candidateId: string, eventKind: RecalibrationEvent['kind'], reason: string) {
    super(`invalid transition for candidate '${candidateId}' on event '${eventKind}': ${reason}`);
    this.name = 'InvalidTransitionError';
    this.candidateId = candidateId;
    this.eventKind = eventKind;
  }
}

function isValidReasonCode(code: string): boolean {
  return (RECALIBRATION_REASON_CODES as readonly string[]).includes(code);
}

function withHistory(rec: CandidateRecord, entry: ReviewHistoryEntry, patch: Partial<CandidateRecord>): CandidateRecord {
  return { ...rec, ...patch, history: [...rec.history, entry] };
}

function requireState(
  rec: CandidateRecord,
  ev: RecalibrationEvent,
  ok: boolean,
  reason: string,
): void {
  if (!ok) throw new InvalidTransitionError(rec.candidate_id, ev.kind, reason);
}

function handleReadinessPassed(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'readiness_passed' }>): CandidateRecord {
  requireState(rec, ev, rec.status === 'candidate' && rec.review_status === 'pending_readiness',
    `requires status 'candidate' + review_status 'pending_readiness', found '${rec.status}'/'${rec.review_status}'`);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'readiness_passed' };
  return withHistory(rec, entry, {
    review_status: 'pending_shadow',
    readiness: ev.readiness ?? rec.readiness,
  });
}

function handleReadinessFailed(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'readiness_failed' }>): CandidateRecord {
  requireState(rec, ev, rec.status === 'candidate' && rec.review_status === 'pending_readiness',
    `requires status 'candidate' + review_status 'pending_readiness', found '${rec.status}'/'${rec.review_status}'`);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'readiness_failed', comment: ev.comment };
  return withHistory(rec, entry, {
    status: 'rejected',
    review_status: 'decided',
    readiness: ev.readiness ?? rec.readiness,
  });
}

function handleShadowValidated(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'shadow_validated' }>): CandidateRecord {
  requireState(rec, ev, rec.status === 'candidate' && rec.review_status === 'pending_shadow',
    `requires status 'candidate' + review_status 'pending_shadow', found '${rec.status}'/'${rec.review_status}'`);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'shadow_validated' };
  return withHistory(rec, entry, {
    review_status: 'reviewable',
    shadow_mode_validated_at: ev.at,
    shadow_report_path: ev.shadow_report_path ?? rec.shadow_report_path,
  });
}

function handleShadowFailed(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'shadow_failed' }>): CandidateRecord {
  requireState(rec, ev, rec.status === 'candidate' && rec.review_status === 'pending_shadow',
    `requires status 'candidate' + review_status 'pending_shadow', found '${rec.status}'/'${rec.review_status}'`);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'shadow_failed', comment: ev.comment };
  const outcome: RecalibrationOutcome = 'shadow_mode_failed';
  return withHistory(rec, entry, { status: 'rejected', review_status: 'decided', outcome });
}

function requireReviewable(rec: CandidateRecord, ev: RecalibrationEvent): void {
  requireState(rec, ev, rec.status === 'candidate' && rec.review_status === 'reviewable',
    `requires status 'candidate' + review_status 'reviewable', found '${rec.status}'/'${rec.review_status}'`);
}

function requireValidReasonCode(rec: CandidateRecord, ev: RecalibrationEvent, reasonCode: string): void {
  requireState(rec, ev, isValidReasonCode(reasonCode), `reason_code '${reasonCode}' is not a valid RECALIBRATION_REASON_CODES entry`);
}

function handleApprove(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'approve' }>): CandidateRecord {
  requireReviewable(rec, ev);
  requireValidReasonCode(rec, ev, ev.reason_code);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'approved', reason_code: ev.reason_code, comment: ev.comment };
  const outcome: RecalibrationOutcome = 'operator_approved';
  return withHistory(rec, entry, { status: 'active', review_status: 'decided', outcome });
}

function handleReject(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'reject' }>): CandidateRecord {
  requireReviewable(rec, ev);
  requireValidReasonCode(rec, ev, ev.reason_code);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'rejected', reason_code: ev.reason_code, comment: ev.comment };
  const outcome: RecalibrationOutcome = 'operator_rejected';
  return withHistory(rec, entry, { status: 'rejected', review_status: 'decided', outcome });
}

function handleAutoPromote(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'auto_promote' }>): CandidateRecord {
  requireState(rec, ev, rec.direction_classification === 'improvement',
    `auto_promote is only legal when direction_classification is 'improvement', found '${rec.direction_classification}'`);
  requireReviewable(rec, ev);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'auto_promoted' };
  const outcome: RecalibrationOutcome = 'auto_promoted';
  return withHistory(rec, entry, { status: 'active', review_status: 'decided', outcome });
}

function handleTimeout(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'timeout' }>): CandidateRecord {
  requireReviewable(rec, ev);
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'timeout_rejected' };
  const outcome: RecalibrationOutcome = 'timeout_rejected';
  return withHistory(rec, entry, { status: 'rejected', review_status: 'decided', outcome });
}

function handleSupersededBy(rec: CandidateRecord, ev: Extract<RecalibrationEvent, { kind: 'superseded_by' }>): CandidateRecord {
  requireState(rec, ev, rec.status === 'active',
    `requires status 'active', found '${rec.status}'`);
  const comment = ev.superseded_by_candidate_id ? `superseded_by:${ev.superseded_by_candidate_id}` : undefined;
  const entry: ReviewHistoryEntry = { at: ev.at, actor: ev.actor, action: 'superseded', comment };
  return withHistory(rec, entry, { status: 'superseded' });
}

/** Pure state transition: applies `ev` to `rec`, returning a NEW
 *  CandidateRecord (input never mutated). Throws InvalidTransitionError
 *  for any event not legal from the record's current state. */
export function transition(rec: CandidateRecord, ev: RecalibrationEvent): CandidateRecord {
  switch (ev.kind) {
    case 'readiness_passed': return handleReadinessPassed(rec, ev);
    case 'readiness_failed': return handleReadinessFailed(rec, ev);
    case 'shadow_validated': return handleShadowValidated(rec, ev);
    case 'shadow_failed': return handleShadowFailed(rec, ev);
    case 'approve': return handleApprove(rec, ev);
    case 'reject': return handleReject(rec, ev);
    case 'auto_promote': return handleAutoPromote(rec, ev);
    case 'timeout': return handleTimeout(rec, ev);
    case 'superseded_by': return handleSupersededBy(rec, ev);
    default: {
      const _exhaustive: never = ev;
      throw new InvalidTransitionError(rec.candidate_id, (_exhaustive as RecalibrationEvent).kind, 'unknown event kind');
    }
  }
}

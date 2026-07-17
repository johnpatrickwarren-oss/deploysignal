// test/recalibration-state-machine.test.ts — Addition #15 baseline-
// maintenance lifecycle, Task 2.
//
// Exercises engine/types/recalibration.ts (contract types, transcribed
// verbatim per plan §C Task 2) and engine/recalibration/state-machine.ts
// (`transition(rec, ev)`, pure candidate lifecycle state machine).
//
// Legal path (plan §C Task 2):
//   pending_readiness -(readiness_passed)-> pending_shadow
//     -(shadow_validated)-> reviewable
//   reviewable -(approve|auto_promote)-> status 'active', review_status
//     'decided', outcome set
//   reviewable -(reject|timeout)-> 'rejected'
//   pending_shadow -(shadow_failed)-> 'rejected' / outcome
//     'shadow_mode_failed'
//   active -(superseded_by)-> 'superseded'
//   auto_promote only legal when direction_classification === 'improvement'
//   approve/reject require a valid reason_code
//   every transition appends history (append-only, ordered)
//   anything else throws InvalidTransitionError

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECALIBRATION_REASON_CODES,
} from '../engine/types/recalibration';
import type {
  CandidateRecord, DirectionClassification, RecalibrationOutcome,
} from '../engine/types/recalibration';
import {
  transition, InvalidTransitionError,
} from '../engine/recalibration/state-machine';
import type { RecalibrationEvent } from '../engine/recalibration/state-machine';

const VALID_REASON_CODE = RECALIBRATION_REASON_CODES[0];

function makeCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-demo',
    candidate_id: 'cand-001',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=42',
    direction_classification: 'improvement',
    per_signal_direction: { mfu: 'improved' },
    suggested_reason_codes: [],
    shadow_mode_validated_at: null,
    timeout_at: '2026-08-01T00:00:00.000Z',
    status: 'candidate',
    review_status: 'pending_readiness',
    creation_reason: 'drift_detected',
    created_at: '2026-07-01T00:00:00.000Z',
    source_window: { start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80, excluded_windows_applied: 0 },
    compiled_config_path: 'runs/compiled-configs/v6-candidate.json',
    outcome: null,
    history: [],
    ...overrides,
  };
}

function ev(kind: RecalibrationEvent['kind'], extra: Record<string, unknown> = {}): RecalibrationEvent {
  return { kind, at: '2026-07-02T00:00:00.000Z', actor: 'operator-1', ...extra } as RecalibrationEvent;
}

// ── Legal-path matrix ──────────────────────────────────────────────

test('legal: pending_readiness -> readiness_passed -> pending_shadow', () => {
  const rec = makeCandidate();
  const next = transition(rec, ev('readiness_passed'));
  assert.equal(next.review_status, 'pending_shadow');
  assert.equal(next.status, 'candidate');
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].action, 'readiness_passed');
});

test('legal: pending_shadow -> shadow_validated -> reviewable', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  const next = transition(rec, ev('shadow_validated', { shadow_report_path: 'runs/shadow/cand-001.json' }));
  assert.equal(next.review_status, 'reviewable');
  assert.equal(next.status, 'candidate');
  assert.equal(next.shadow_mode_validated_at, '2026-07-02T00:00:00.000Z');
  assert.equal(next.shadow_report_path, 'runs/shadow/cand-001.json');
  assert.equal(next.history[next.history.length - 1].action, 'shadow_validated');
});

test('legal: pending_shadow -> shadow_failed -> rejected / shadow_mode_failed', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  const next = transition(rec, ev('shadow_failed'));
  assert.equal(next.status, 'rejected');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.outcome, 'shadow_mode_failed' as RecalibrationOutcome);
  assert.equal(next.history[next.history.length - 1].action, 'shadow_failed');
});

test('legal: reviewable -> approve -> active / decided / operator_approved', () => {
  const rec = makeCandidate({ review_status: 'reviewable' });
  const next = transition(rec, ev('approve', { reason_code: VALID_REASON_CODE }));
  assert.equal(next.status, 'active');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.outcome, 'operator_approved' as RecalibrationOutcome);
  const last = next.history[next.history.length - 1];
  assert.equal(last.action, 'approved');
  assert.equal(last.reason_code, VALID_REASON_CODE);
});

test('legal: reviewable -> reject -> rejected / decided / operator_rejected', () => {
  const rec = makeCandidate({ review_status: 'reviewable' });
  const next = transition(rec, ev('reject', { reason_code: VALID_REASON_CODE }));
  assert.equal(next.status, 'rejected');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.outcome, 'operator_rejected' as RecalibrationOutcome);
  assert.equal(next.history[next.history.length - 1].action, 'rejected');
});

test('legal: reviewable -> auto_promote (improvement) -> active / auto_promoted', () => {
  const rec = makeCandidate({ review_status: 'reviewable', direction_classification: 'improvement' });
  const next = transition(rec, ev('auto_promote'));
  assert.equal(next.status, 'active');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.outcome, 'auto_promoted' as RecalibrationOutcome);
  assert.equal(next.history[next.history.length - 1].action, 'auto_promoted');
});

test('legal: reviewable -> timeout -> rejected / timeout_rejected', () => {
  const rec = makeCandidate({ review_status: 'reviewable' });
  const next = transition(rec, ev('timeout'));
  assert.equal(next.status, 'rejected');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.outcome, 'timeout_rejected' as RecalibrationOutcome);
  assert.equal(next.history[next.history.length - 1].action, 'timeout_rejected');
});

test('legal: active -> superseded_by -> superseded', () => {
  const rec = makeCandidate({ status: 'active', review_status: 'decided', outcome: 'operator_approved' });
  const next = transition(rec, ev('superseded_by', { superseded_by_candidate_id: 'cand-002' }));
  assert.equal(next.status, 'superseded');
  assert.equal(next.history[next.history.length - 1].action, 'superseded');
});

test('legal: pending_readiness -> readiness_failed -> rejected / decided', () => {
  const rec = makeCandidate();
  const next = transition(rec, ev('readiness_failed'));
  assert.equal(next.status, 'rejected');
  assert.equal(next.review_status, 'decided');
  assert.equal(next.history[next.history.length - 1].action, 'readiness_failed');
});

// ── Illegal transitions throw ──────────────────────────────────────

test('illegal: approve before shadow (pending_readiness) throws', () => {
  const rec = makeCandidate({ review_status: 'pending_readiness' });
  assert.throws(() => transition(rec, ev('approve', { reason_code: VALID_REASON_CODE })), InvalidTransitionError);
});

test('illegal: approve before shadow (pending_shadow) throws', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  assert.throws(() => transition(rec, ev('approve', { reason_code: VALID_REASON_CODE })), InvalidTransitionError);
});

test('illegal: approve an already-rejected candidate throws', () => {
  const rec = makeCandidate({ status: 'rejected', review_status: 'decided', outcome: 'operator_rejected' });
  assert.throws(() => transition(rec, ev('approve', { reason_code: VALID_REASON_CODE })), InvalidTransitionError);
});

test('illegal: auto_promote on degradation throws', () => {
  const rec = makeCandidate({ review_status: 'reviewable', direction_classification: 'degradation' as DirectionClassification });
  assert.throws(() => transition(rec, ev('auto_promote')), InvalidTransitionError);
});

test('illegal: auto_promote on mixed throws', () => {
  const rec = makeCandidate({ review_status: 'reviewable', direction_classification: 'mixed' as DirectionClassification });
  assert.throws(() => transition(rec, ev('auto_promote')), InvalidTransitionError);
});

test('illegal: approve with a bad reason_code throws', () => {
  const rec = makeCandidate({ review_status: 'reviewable' });
  assert.throws(() => transition(rec, ev('approve', { reason_code: 'not_a_real_code' })), InvalidTransitionError);
});

test('illegal: reject with a bad reason_code throws', () => {
  const rec = makeCandidate({ review_status: 'reviewable' });
  assert.throws(() => transition(rec, ev('reject', { reason_code: 'not_a_real_code' })), InvalidTransitionError);
});

test('illegal: timeout on non-reviewable (pending_shadow) throws', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  assert.throws(() => transition(rec, ev('timeout')), InvalidTransitionError);
});

test('illegal: timeout on non-reviewable (pending_readiness) throws', () => {
  const rec = makeCandidate({ review_status: 'pending_readiness' });
  assert.throws(() => transition(rec, ev('timeout')), InvalidTransitionError);
});

test('illegal: superseded_by on a non-active candidate throws', () => {
  const rec = makeCandidate({ status: 'candidate', review_status: 'reviewable' });
  assert.throws(() => transition(rec, ev('superseded_by')), InvalidTransitionError);
});

test('illegal: shadow_validated from pending_readiness throws', () => {
  const rec = makeCandidate({ review_status: 'pending_readiness' });
  assert.throws(() => transition(rec, ev('shadow_validated')), InvalidTransitionError);
});

test('illegal: readiness_passed from pending_shadow throws', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  assert.throws(() => transition(rec, ev('readiness_passed')), InvalidTransitionError);
});

// ── History append-only, ordered ───────────────────────────────────

test('history: append-only and ordered across a full legal path', () => {
  let rec = makeCandidate();
  const originalHistoryRef = rec.history;
  rec = transition(rec, ev('readiness_passed', { at: 't1' }));
  rec = transition(rec, ev('shadow_validated', { at: 't2' }));
  rec = transition(rec, ev('approve', { at: 't3', reason_code: VALID_REASON_CODE }));
  assert.deepEqual(
    rec.history.map((h) => h.action),
    ['readiness_passed', 'shadow_validated', 'approved'],
  );
  assert.deepEqual(rec.history.map((h) => h.at), ['t1', 't2', 't3']);
  // Original input's history array was never mutated (pure transition).
  assert.equal(originalHistoryRef.length, 0);
});

test('history: transition does not mutate its input record', () => {
  const rec = makeCandidate({ review_status: 'pending_shadow' });
  const snapshot = JSON.stringify(rec);
  transition(rec, ev('shadow_validated'));
  assert.equal(JSON.stringify(rec), snapshot, 'input record unchanged after transition');
});

// test/recalibration-timeout.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 7.
//
// Exercises engine/recalibration/timeout.ts (pure: computeTimeoutAt,
// isTimedOut, calendarRefreshDue) and
// tools/recalibrate/_recalibrate-sweep.ts (sweepTimeouts,
// checkCalendarSafetyNet — plan §B D1/D2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  DEFAULT_TIMEOUT_DAYS, computeTimeoutAt, isTimedOut, calendarRefreshDue,
} from '../engine/recalibration/timeout';
import { sweepTimeouts, checkCalendarSafetyNet } from '../tools/recalibrate/_recalibrate-sweep';
import { RecalibrationStore } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import type { RecalibrationTimeoutRejectedPayload } from '../engine/o0/lifecycle-events';
import type { CandidateRecord } from '../engine/types/recalibration';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-timeout-test-'));
}

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
    shadow_mode_validated_at: '2026-07-01T12:00:00.000Z',
    timeout_at: '2026-07-15T00:00:00.000Z',
    status: 'candidate',
    review_status: 'reviewable',
    creation_reason: 'drift_detected',
    created_at: '2026-07-01T00:00:00.000Z',
    source_window: {
      start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80, excluded_windows_applied: 0,
    },
    compiled_config_path: 'runs/compiled-configs/v6-candidate.json',
    outcome: null,
    history: [],
    ...overrides,
  };
}

// ── computeTimeoutAt / isTimedOut ────────────────────────────────────

test('computeTimeoutAt: default is created_at + 14 days (DEFAULT_TIMEOUT_DAYS)', () => {
  assert.equal(DEFAULT_TIMEOUT_DAYS, 14);
  const timeoutAt = computeTimeoutAt('2026-07-01T00:00:00.000Z');
  assert.equal(timeoutAt, '2026-07-15T00:00:00.000Z');
});

test('computeTimeoutAt: honors an explicit timeoutDays override', () => {
  const timeoutAt = computeTimeoutAt('2026-07-01T00:00:00.000Z', 21);
  assert.equal(timeoutAt, '2026-07-22T00:00:00.000Z');
});

test('isTimedOut: false before timeout_at, true at/after', () => {
  assert.equal(isTimedOut('2026-07-15T00:00:00.000Z', '2026-07-14T23:59:59.999Z'), false);
  assert.equal(isTimedOut('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'), true);
  assert.equal(isTimedOut('2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z'), true);
});

// ── calendarRefreshDue ────────────────────────────────────────────────

test('calendarRefreshDue: same month -> not due, even many days later', () => {
  assert.equal(calendarRefreshDue('2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z'), false);
});

test('calendarRefreshDue: next month -> due', () => {
  assert.equal(calendarRefreshDue('2026-07-15T00:00:00.000Z', '2026-08-01T00:00:00.000Z'), true);
});

test('calendarRefreshDue: year rollover (Dec -> Jan) -> due', () => {
  assert.equal(calendarRefreshDue('2026-12-15T00:00:00.000Z', '2027-01-01T00:00:00.000Z'), true);
});

test('calendarRefreshDue: earlier "now" than last event -> not due', () => {
  assert.equal(calendarRefreshDue('2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'), false);
});

// ── sweepTimeouts ─────────────────────────────────────────────────────

test('sweepTimeouts: rejects only reviewable-and-expired candidates', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({
    candidate_id: 'expired-reviewable', review_status: 'reviewable', timeout_at: '2026-07-10T00:00:00.000Z',
  }));
  store.writeCandidate(makeCandidate({
    candidate_id: 'fresh-reviewable', review_status: 'reviewable', timeout_at: '2026-08-01T00:00:00.000Z',
  }));
  store.writeCandidate(makeCandidate({
    candidate_id: 'expired-pending-shadow', review_status: 'pending_shadow', timeout_at: '2026-07-10T00:00:00.000Z',
  }));
  store.writeCandidate(makeCandidate({
    candidate_id: 'expired-pending-readiness', review_status: 'pending_readiness', timeout_at: '2026-07-10T00:00:00.000Z',
  }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await sweepTimeouts(store, emitter, '2026-07-16T00:00:00.000Z');

  assert.deepEqual(result.rejected_candidate_ids, ['expired-reviewable']);

  const rejected = store.readCandidate('expired-reviewable');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.review_status, 'decided');
  assert.equal(rejected.outcome, 'timeout_rejected');
  assert.equal(rejected.history[rejected.history.length - 1].action, 'timeout_rejected');

  // OQ-5: pending_* candidates are NOT timed out even past their
  // timeout_at — untouched by the sweep.
  const pendingShadow = store.readCandidate('expired-pending-shadow');
  assert.equal(pendingShadow.review_status, 'pending_shadow');
  assert.equal(pendingShadow.status, 'candidate');
  const pendingReadiness = store.readCandidate('expired-pending-readiness');
  assert.equal(pendingReadiness.review_status, 'pending_readiness');

  const fresh = store.readCandidate('fresh-reviewable');
  assert.equal(fresh.review_status, 'reviewable');
});

test('sweepTimeouts: emits recalibration.timeout_rejected with escalation payload', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({ candidate_id: 'expired-reviewable', timeout_at: '2026-07-10T00:00:00.000Z' }));

  const emitter = new InMemoryLifecycleEventEmitter();
  await sweepTimeouts(store, emitter, '2026-07-16T00:00:00.000Z');

  const events = emitter.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.timeout_rejected');
  const payload = events[0].payload as RecalibrationTimeoutRejectedPayload;
  assert.equal(payload.candidate_id, 'expired-reviewable');
  assert.equal(payload.service_id, 'svc-demo');
  assert.deepEqual(payload.escalation, { escalated: true, escalated_to: 'engineering_leadership' });
});

test('sweepTimeouts: no-op when nothing is expired', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({ candidate_id: 'fresh', timeout_at: '2026-08-01T00:00:00.000Z' }));
  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await sweepTimeouts(store, emitter, '2026-07-16T00:00:00.000Z');
  assert.deepEqual(result.rejected_candidate_ids, []);
  assert.equal(emitter.getEvents().length, 0);
});

// ── checkCalendarSafetyNet ────────────────────────────────────────────

test('checkCalendarSafetyNet: due after a month rollover with no open candidate', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({
    candidate_id: 'decided-one', review_status: 'decided', status: 'active', outcome: 'auto_promoted', created_at: '2026-07-01T00:00:00.000Z',
  }));
  const result = checkCalendarSafetyNet(store, '2026-08-02T00:00:00.000Z');
  assert.equal(result.due, true);
  assert.equal(result.open_candidate_id, null);
});

test('checkCalendarSafetyNet: not due within the same month', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({
    candidate_id: 'decided-one', review_status: 'decided', status: 'active', outcome: 'auto_promoted', created_at: '2026-07-01T00:00:00.000Z',
  }));
  const result = checkCalendarSafetyNet(store, '2026-07-20T00:00:00.000Z');
  assert.equal(result.due, false);
});

test('checkCalendarSafetyNet: an open candidate blocks due, even past a month rollover', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({
    candidate_id: 'open-one', review_status: 'pending_shadow', created_at: '2026-07-01T00:00:00.000Z',
  }));
  const result = checkCalendarSafetyNet(store, '2026-08-15T00:00:00.000Z');
  assert.equal(result.due, false);
  assert.equal(result.open_candidate_id, 'open-one');
});

test('checkCalendarSafetyNet: no history at all -> not due, null last_activity_at', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const result = checkCalendarSafetyNet(store, '2026-08-15T00:00:00.000Z');
  assert.equal(result.due, false);
  assert.equal(result.last_activity_at, null);
});

test('checkCalendarSafetyNet: last_activity_at prefers the active pointer\'s promoted_at over an older candidate created_at', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({
    candidate_id: 'cand-001', review_status: 'decided', status: 'active', outcome: 'auto_promoted', created_at: '2026-06-01T00:00:00.000Z',
  }));
  store.promote('cand-001', 'auto_promoted', '2026-07-05T00:00:00.000Z');
  const result = checkCalendarSafetyNet(store, '2026-07-20T00:00:00.000Z');
  // Last activity is the promotion (July), not the June candidate
  // creation — still the same month as "now", so not due.
  assert.equal(result.due, false);
  assert.equal(result.last_activity_at, '2026-07-05T00:00:00.000Z');
});

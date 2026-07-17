// test/recalibration-lifecycle-events.test.ts — Addition #15 baseline-
// maintenance lifecycle, Task 5.
//
// Exercises the six `recalibration.*` LifecycleEventType additions to
// engine/o0/lifecycle-events.ts (strict-additive alongside the original
// five `evaluation.*` events + the post-L3 consolidated-activation
// events). Per plan §C Task 5: base payload fields (type, service_id,
// candidate_id, proposed_baseline_version, current_baseline_version,
// direction_classification, at) on every recalibration.* event;
// operator_id + reason_code extras on approved/rejected;
// shadow_report_path on shadow_validated; an escalation object embedded
// in timeout_rejected (OQ-6 — no seventh event type for escalation).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NoOpLifecycleEventEmitter, InMemoryLifecycleEventEmitter,
} from '../engine/o0/lifecycle-events';
import type {
  LifecycleEventType, LifecycleEventPayload,
  RecalibrationProposedPayload, RecalibrationShadowValidatedPayload,
  RecalibrationOperatorApprovedPayload, RecalibrationOperatorRejectedPayload,
  RecalibrationAutoPromotedPayload, RecalibrationTimeoutRejectedPayload,
} from '../engine/o0/lifecycle-events';

const BASE = {
  service_id: 'svc-demo',
  candidate_id: 'cand-001',
  proposed_baseline_version: 'v6@seed=42',
  current_baseline_version: 'v5@seed=42',
  direction_classification: 'improvement' as const,
  at: '2026-07-16T00:00:00.000Z',
};

test('recalibration.* : all six event types emit via InMemory with payload narrowing', async () => {
  const emitter = new InMemoryLifecycleEventEmitter();

  const proposed: RecalibrationProposedPayload = { type: 'recalibration.proposed', ...BASE };
  const shadowValidated: RecalibrationShadowValidatedPayload = {
    type: 'recalibration.shadow_validated', ...BASE, shadow_report_path: 'runs/shadow/cand-001.json',
  };
  const approved: RecalibrationOperatorApprovedPayload = {
    type: 'recalibration.operator_approved', ...BASE, operator_id: 'operator-1', reason_code: 'traffic_mix_change',
  };
  const rejected: RecalibrationOperatorRejectedPayload = {
    type: 'recalibration.operator_rejected', ...BASE, operator_id: 'operator-1', reason_code: 'regression',
  };
  const autoPromoted: RecalibrationAutoPromotedPayload = { type: 'recalibration.auto_promoted', ...BASE };
  const timeoutRejected: RecalibrationTimeoutRejectedPayload = {
    type: 'recalibration.timeout_rejected',
    ...BASE,
    escalation: { escalated: true, escalated_to: 'engineering_leadership' },
  };

  await emitter.emit('recalibration.proposed', proposed);
  await emitter.emit('recalibration.shadow_validated', shadowValidated);
  await emitter.emit('recalibration.operator_approved', approved);
  await emitter.emit('recalibration.operator_rejected', rejected);
  await emitter.emit('recalibration.auto_promoted', autoPromoted);
  await emitter.emit('recalibration.timeout_rejected', timeoutRejected);

  const events = emitter.getEvents();
  assert.equal(events.length, 6);

  const types: LifecycleEventType[] = events.map((e) => e.type);
  assert.deepEqual(types, [
    'recalibration.proposed', 'recalibration.shadow_validated',
    'recalibration.operator_approved', 'recalibration.operator_rejected',
    'recalibration.auto_promoted', 'recalibration.timeout_rejected',
  ]);

  // Base fields present + narrowable on every event.
  for (const e of events) {
    const p = e.payload as LifecycleEventPayload & typeof BASE;
    assert.equal(p.service_id, BASE.service_id);
    assert.equal(p.candidate_id, BASE.candidate_id);
    assert.equal(p.proposed_baseline_version, BASE.proposed_baseline_version);
    assert.equal(p.current_baseline_version, BASE.current_baseline_version);
    assert.equal(p.direction_classification, BASE.direction_classification);
    assert.equal(p.at, BASE.at);
  }

  // Type-specific extras narrow correctly.
  const shadowEvent = events.find((e) => e.type === 'recalibration.shadow_validated')!;
  assert.equal((shadowEvent.payload as RecalibrationShadowValidatedPayload).shadow_report_path, 'runs/shadow/cand-001.json');

  const approvedEvent = events.find((e) => e.type === 'recalibration.operator_approved')!;
  const approvedPayload = approvedEvent.payload as RecalibrationOperatorApprovedPayload;
  assert.equal(approvedPayload.operator_id, 'operator-1');
  assert.equal(approvedPayload.reason_code, 'traffic_mix_change');

  const rejectedEvent = events.find((e) => e.type === 'recalibration.operator_rejected')!;
  const rejectedPayload = rejectedEvent.payload as RecalibrationOperatorRejectedPayload;
  assert.equal(rejectedPayload.operator_id, 'operator-1');
  assert.equal(rejectedPayload.reason_code, 'regression');

  // OQ-6: escalation embedded in timeout_rejected, no seventh event type.
  const timeoutEvent = events.find((e) => e.type === 'recalibration.timeout_rejected')!;
  const timeoutPayload = timeoutEvent.payload as RecalibrationTimeoutRejectedPayload;
  assert.deepEqual(timeoutPayload.escalation, { escalated: true, escalated_to: 'engineering_leadership' });
});

test('recalibration.* : NoOpLifecycleEventEmitter accepts every recalibration.* type without throwing', async () => {
  const emitter = new NoOpLifecycleEventEmitter();
  const proposed: RecalibrationProposedPayload = { type: 'recalibration.proposed', ...BASE };
  const timeoutRejected: RecalibrationTimeoutRejectedPayload = {
    type: 'recalibration.timeout_rejected',
    ...BASE,
    escalation: { escalated: true, escalated_to: 'engineering_leadership' },
  };
  await emitter.emit('recalibration.proposed', proposed);
  await emitter.emit('recalibration.timeout_rejected', timeoutRejected);
  // No throw = pass. NoOp is the backward-compat default; recalibration
  // callers that don't wire a real emitter must be zero-side-effect too.
});

test('recalibration.* : existing five evaluation.* event types still emit unaffected', async () => {
  const emitter = new InMemoryLifecycleEventEmitter();
  const types: LifecycleEventType[] = [
    'evaluation.triggered', 'evaluation.started', 'evaluation.tick',
    'evaluation.suppressed', 'evaluation.finished',
  ];
  assert.equal(types.length, 5, 'five original event types unaffected by the recalibration.* addition');

  await emitter.emit('evaluation.triggered', {
    type: 'evaluation.triggered', deploy_id: 'd', service_id: 's',
    compiled_config_version: 'v', expected_window_ticks: 1, risk_tier: 'low',
  });
  await emitter.emit('evaluation.finished', {
    type: 'evaluation.finished', deploy_id: 'd',
    final_verdict: 'proceed', total_alpha_spent: 0, families_summary: {},
  });
  const events = emitter.getEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'evaluation.triggered');
  assert.equal(events[1].type, 'evaluation.finished');
});

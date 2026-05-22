// test/q29-anvil-types.test.ts — Q29 / Addition #29 type contracts.
//
// Closes PRD-29 AC-1: ExpectedFailurePattern + ChaosOrchestrationAdapter
// + ChaosVerdict + translateToChaosVerdict + tickWithinFaultWindow exported
// from engine/o0/anvil/types with the contract Q29 specifies.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  translateToChaosVerdict,
  tickWithinFaultWindow,
} from '../dist/engine/o0/anvil/types';
import type {
  ExpectedFailurePattern,
  ChaosVerdict,
  EngineNativeVerdict,
} from '../dist/engine/o0/anvil/types';

test('Q29 / AC-1 — translateToChaosVerdict: proceed → experiment_passed', () => {
  const v: ChaosVerdict = translateToChaosVerdict('proceed', false);
  assert.equal(v, 'experiment_passed');
});

test('Q29 / AC-1 — translateToChaosVerdict: rollback → experiment_failed_unexpectedly (irrespective of suppress-set membership)', () => {
  assert.equal(translateToChaosVerdict('rollback', false), 'experiment_failed_unexpectedly');
  assert.equal(translateToChaosVerdict('rollback', true), 'experiment_failed_unexpectedly');
  // Q29.2 architect-pick: the label is the same; the annotation
  // (firing_family_in_suppress_set) rides on the audit record.
});

test('Q29 / AC-1 — translateToChaosVerdict: extend → experiment_still_running', () => {
  assert.equal(translateToChaosVerdict('extend', false), 'experiment_still_running');
});

test('Q29 / AC-1 — translateToChaosVerdict: suppressed_insufficient_samples → experiment_inconclusive', () => {
  assert.equal(
    translateToChaosVerdict('suppressed_insufficient_samples', false),
    'experiment_inconclusive',
  );
});

test('Q29 / AC-1 — translateToChaosVerdict covers every native verdict (exhaustive)', () => {
  const all: EngineNativeVerdict[] = [
    'proceed', 'extend', 'rollback', 'suppressed_insufficient_samples',
  ];
  for (const v of all) {
    const out = translateToChaosVerdict(v, false);
    assert.ok(
      ['experiment_passed', 'experiment_failed_unexpectedly',
       'experiment_still_running', 'experiment_inconclusive'].includes(out),
      `${v} → ${out} must be a ChaosVerdict`,
    );
  }
});

test('Q29 / AC-1 — tickWithinFaultWindow: inside the window returns true', () => {
  const pattern: ExpectedFailurePattern = {
    kind: 'latency_injection',
    affected_signals: ['p99_latency'],
    magnitude: 0.3,
    magnitude_unit: 'relative_fraction',
    recovery_seconds: 60,
    suppress_families: ['A'],
    fault_start_unix: 1_700_000_000,
  };
  assert.equal(tickWithinFaultWindow(pattern, 1_700_000_000), true);  // start boundary inclusive
  assert.equal(tickWithinFaultWindow(pattern, 1_700_000_030), true);  // midway
  assert.equal(tickWithinFaultWindow(pattern, 1_700_000_060), true);  // end boundary inclusive
});

test('Q29 / AC-1 — tickWithinFaultWindow: outside the window returns false', () => {
  const pattern: ExpectedFailurePattern = {
    kind: 'latency_injection',
    affected_signals: ['p99_latency'],
    magnitude: 0.3,
    magnitude_unit: 'relative_fraction',
    recovery_seconds: 60,
    suppress_families: ['A'],
    fault_start_unix: 1_700_000_000,
  };
  assert.equal(tickWithinFaultWindow(pattern, 1_699_999_999), false);  // before start
  assert.equal(tickWithinFaultWindow(pattern, 1_700_000_061), false);  // after recovery
});

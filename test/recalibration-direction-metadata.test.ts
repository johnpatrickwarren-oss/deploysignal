// test/recalibration-direction-metadata.test.ts — Addition #15 baseline-
// maintenance lifecycle, Task 1.
//
// Exercises engine/recalibration/direction-metadata.ts: the direction-
// of-better lookup table for the 13 maturity-metric signals (per plan
// §A2 — hand-copied from runs/baseline-history/demo/*.json's
// maturity_metrics blocks, NOT read from those files at test time, so
// this test independently pins the contract rather than round-tripping
// fixture data through itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTION_OF_BETTER, CLASSIFICATION_EXCLUDED_SIGNALS, directionOfBetter,
} from '../engine/recalibration/direction-metadata';
import type { DirectionOfBetter } from '../engine/recalibration/direction-metadata';

// Hand-copied literal — independent of the module under test and of the
// demo fixture files. Mirrors plan §A2 / §C Task 1.
const EXPECTED: Record<string, DirectionOfBetter> = {
  p99_latency: 'lower',
  ttft: 'lower',
  downstream_err: 'lower',
  hbm_spill: 'lower',
  refusal_rate: 'lower',
  mfu: 'higher',
  eval_score: 'higher',
  tool_success_rate: 'higher',
  collective_ops: 'higher',
  cost_req: 'informational',
  tokens_turn: 'informational',
  kv_cache: 'informational',
  corpus_delta: 'informational',
};

test('1: table covers exactly the 13 signals, values match hand-copied literal', () => {
  const keys = Object.keys(DIRECTION_OF_BETTER);
  assert.equal(keys.length, 13, 'exactly 13 signals in the table');
  for (const [signal, direction] of Object.entries(EXPECTED)) {
    assert.equal(DIRECTION_OF_BETTER[signal], direction, `direction for ${signal}`);
  }
  // No extra signals beyond the expected 13.
  const extra = keys.filter((k) => !(k in EXPECTED));
  assert.deepEqual(extra, [], 'no signals beyond the hand-copied 13');
});

test('2: override maps cost_req -> higher', () => {
  const result = directionOfBetter('cost_req', { cost_req: 'higher' });
  assert.equal(result, 'higher');
});

test('3: override targeting a non-informational signal throws', () => {
  assert.throws(() => directionOfBetter('p99_latency', { p99_latency: 'higher' }));
});

test('4: unknown signal returns null', () => {
  assert.equal(directionOfBetter('made_up_signal_xyz'), null);
});

test('5: traffic_pct is excluded from classification and absent from the table', () => {
  assert.deepEqual(CLASSIFICATION_EXCLUDED_SIGNALS, ['traffic_pct']);
  assert.equal(directionOfBetter('traffic_pct'), null, 'excluded signal not in the directional table');
});

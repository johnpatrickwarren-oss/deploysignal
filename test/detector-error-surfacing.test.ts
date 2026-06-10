// test/detector-error-surfacing.test.ts — Remediation M2 regression guard.
//
// evaluateSignals historically wrapped every detector check in
// `try { ... } catch(e) {}` — a crashed detector was indistinguishable
// from a detector that cleanly declined to fire (fail-open; this masked
// the H1 gpu_eff TypeError for the detector's entire life). The wrapper
// must now (a) log the failure with the detector id, and (b) surface a
// `detector_errors` entry on the health result so replay/audit can
// distinguish "clean" from "errored".

import { test } from 'node:test';
import assert from 'node:assert/strict';

const engine = require('../shared');
const { evaluateSignals, ROLLBACK_DEFS, EXTEND_DEFS, TrendBuffer, SCENARIOS } = engine;

function makeTb(sc: any, ticks: number): InstanceType<typeof TrendBuffer> {
  const tb = new TrendBuffer();
  for (let i = 0; i < ticks; i++) {
    for (const k of Object.keys(sc.baseline)) tb.push(k, sc.baseline[k]);
  }
  return tb;
}

test('evaluateSignals reports crashed detectors via detector_errors and logs them', () => {
  const sc = SCENARIOS.find((s: any) => s.id === 'clean');
  const tb = makeTb(sc, 8);

  const boomRollback = {
    id: '__test_boom_rollback', label: 'Boom (rollback)',
    check: () => { throw new TypeError('intentional test detector crash'); },
  };
  const boomExtend = {
    id: '__test_boom_extend', label: 'Boom (extend)',
    check: () => { throw new RangeError('intentional extend crash'); },
  };

  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

  ROLLBACK_DEFS.push(boomRollback);
  EXTEND_DEFS.push(boomExtend);
  try {
    const result = evaluateSignals(sc.baseline, sc, 24, tb);

    assert.ok(Array.isArray(result.detector_errors),
      'health result must carry a detector_errors array');
    const ids = result.detector_errors.map((e: any) => e.id);
    assert.ok(ids.includes('__test_boom_rollback'), 'rollback detector crash must be surfaced');
    assert.ok(ids.includes('__test_boom_extend'), 'extend detector crash must be surfaced');

    const rb = result.detector_errors.find((e: any) => e.id === '__test_boom_rollback');
    assert.equal(rb.kind, 'rollback');
    assert.match(rb.error, /intentional test detector crash/);

    // Crashed detector must not count as fired.
    assert.ok(!result.rollback.some((s: any) => s.id === '__test_boom_rollback'));
    assert.ok(!result.extend.some((s: any) => s.id === '__test_boom_extend'));

    // And the failure must be logged with the detector id.
    assert.ok(logged.some((l) => l.includes('__test_boom_rollback')),
      'detector error must be logged with detector id');
  } finally {
    console.error = origError;
    ROLLBACK_DEFS.pop();
    EXTEND_DEFS.pop();
  }
});

test('evaluateSignals returns an empty detector_errors array on a clean pass', () => {
  const sc = SCENARIOS.find((s: any) => s.id === 'clean');
  const tb = makeTb(sc, 8);
  const result = evaluateSignals(sc.baseline, sc, 24, tb);
  assert.ok(Array.isArray(result.detector_errors));
  assert.equal(result.detector_errors.length, 0);
});

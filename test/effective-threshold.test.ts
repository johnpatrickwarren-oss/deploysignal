// test/effective-threshold.test.ts — Remediation M3 regression guard.
//
// effectiveThreshold documents "applies trend discount to base threshold",
// but the implementation computed `discount = trendDiscount * strength` and
// then returned `baseThreshold - discount * strength` — i.e. the discount
// scaled with strength², a refactor slip that systematically weakened the
// trend discount (at strength 0.5 the applied discount was half the
// intended value), making every ratio detector that uses it slightly less
// sensitive to trending regressions. The intended formula applies strength
// exactly once: `baseThreshold - trendDiscount * strength`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { effectiveThreshold, trendStrength, TrendBuffer } = require('../dist/engine/core');

function risingTrend(slopePerTick: number, ticks = 10) {
  const tb = new TrendBuffer();
  for (let i = 0; i < ticks; i++) tb.push('x', 100 * (1 + slopePerTick * i));
  return tb.get('x');
}

test('effectiveThreshold applies the trend discount linearly in strength (once, not squared)', () => {
  // Sweep trend shapes so strength takes several values strictly inside (0, 1) —
  // where linear and quadratic application diverge.
  let sawPartialStrength = false;
  for (const slope of [0.002, 0.004, 0.008, 0.015, 0.03]) {
    const t = risingTrend(slope);
    const strength = trendStrength(t, 'rise');
    if (strength > 0.05 && strength < 0.95) sawPartialStrength = true;
    const got = effectiveThreshold(1.20, 0.06, t, 'rise', null);
    const want = 1.20 - 0.06 * strength;
    assert.ok(Math.abs(got - want) < 1e-12,
      `slope=${slope}: expected baseThreshold - trendDiscount*strength = ${want}, got ${got} ` +
      `(strength=${strength}; quadratic would give ${1.20 - 0.06 * strength * strength})`);
  }
  assert.ok(sawPartialStrength, 'sweep must include strengths strictly between 0 and 1');
});

test('effectiveThreshold edge cases: insufficient data and roc bypass return base threshold', () => {
  assert.equal(effectiveThreshold(1.20, 0.06, null, 'rise', 0.025), 1.20);
  const tb = new TrendBuffer();
  tb.push('x', 100); tb.push('x', 101);
  assert.equal(effectiveThreshold(1.20, 0.06, tb.get('x'), 'rise', 0.025), 1.20);
  // Fast roc bypasses the discount entirely.
  const spiky = new TrendBuffer();
  for (const v of [100, 100, 100, 100, 100, 130, 170]) spiky.push('x', v);
  const t = spiky.get('x');
  assert.ok(Math.abs(t.roc) >= 0.025, 'fixture must trip the roc bypass');
  assert.equal(effectiveThreshold(1.20, 0.06, t, 'rise', 0.025), 1.20);
});

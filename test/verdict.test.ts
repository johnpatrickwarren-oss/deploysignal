// test/verdict.test.ts — W4 §4.1.b fusion layer coverage.
//
// Tests `fuseVerdict` across the three portfolio outcomes (rollback, extend,
// proceed), the multi-family first-fire ordering, and α_spent union-bound
// accounting. Adversarial parity vs cascade lives in family-a-parity /
// family-c-parity / scenarios-unique-ids; this suite isolates the fusion
// math on synthetic HealthResult inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseVerdict } from '../dist/engine/verdict';
import type { HealthResult, DetectorVerdict } from '../dist/engine/types';

function emptyHealth(): HealthResult {
  return {
    rollback: [],
    extend: [],
    warmup: { active: false, grace: false, pct: 100, suppressedIds: [] },
    suppressed: [],
  };
}

function cleanA(signal: string): DetectorVerdict {
  return {
    verdict: 'clean', statistic: 0, threshold: 9.6,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'reset_to_zero', family: 'A', signal,
  };
}

function fireA(signal: string, alpha = 6.67e-5): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 10, threshold: 9.6,
    alpha_consumed: alpha, alpha_spent: alpha,
    reason_code: 'cusum_exceeded_threshold', family: 'A', signal,
  };
}

function indeterminateA(signal: string): DetectorVerdict {
  return {
    verdict: 'indeterminate', statistic: 4, threshold: 9.6,
    alpha_consumed: 1e-5, alpha_spent: 0,
    reason_code: 'accumulating', family: 'A', signal,
  };
}

function fireC(alpha = 2e-4): DetectorVerdict {
  return {
    verdict: 'fire', statistic: 40, threshold: 35.88,
    alpha_consumed: alpha, alpha_spent: alpha,
    reason_code: 'hotelling_exceeded_threshold', family: 'C',
  };
}

// ────────────────────────────────────────────────────────────────────
// Outcome: proceed
test('fuseVerdict: proceed when all families clean (last tick, no extend)', () => {
  const h = emptyHealth();
  h.family_A_shadow = [cleanA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 31, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'proceed');
  assert.deepEqual(v.firing_families, []);
  assert.equal(v.total_alpha_spent, 0);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: extend (Family A indeterminate, no fires)
test('fuseVerdict: extend when Family A indeterminate and no fires', () => {
  const h = emptyHealth();
  h.family_A_shadow = [indeterminateA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'extend');
  assert.deepEqual(v.firing_families, []);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: extend (Family B extend signal present)
test('fuseVerdict: extend when Family B extend signal fires', () => {
  const h = emptyHealth();
  h.extend = [{ id: 'borderline', label: 'Borderline Latency' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'extend');
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family A only)
test('fuseVerdict: rollback on Family A fire alone', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['A']);
  assert.ok(v.total_alpha_spent > 0);
  // Family A synthetic ID must not leak into the Family B partition.
  assert.equal(v.per_family_verdicts.B, null);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family C only)
test('fuseVerdict: rollback on Family C fire alone', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_C', label: 'Family C (multivariate)' }];
  h.family_C_verdict = fireC();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['C']);
  assert.ok(v.total_alpha_spent > 0);
  assert.equal(v.per_family_verdicts.B, null);
});

// ────────────────────────────────────────────────────────────────────
// Outcome: rollback (Family B structural rule)
test('fuseVerdict: rollback on Family B structural rule', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['B']);
  // Family B doesn't spend Ville budget.
  assert.equal(v.total_alpha_spent, 0);
});

// ────────────────────────────────────────────────────────────────────
// First-fire attribution when multiple families fire simultaneously.
// Portfolio preserves family order A < B < C < D < E in `firing_families`.
test('fuseVerdict: multiple fires preserve A<B<C<D<E family order', () => {
  const h = emptyHealth();
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
    { id: 'slowbleed',            label: 'Slow Bleed' },
    { id: 'family_C',             label: 'Family C (multivariate)' },
  ];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  h.family_C_verdict = fireC();
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['A', 'B', 'C']);
  // α sum should equal Family A's single-signal α + Family C's α (B is 0).
  const expected = 6.67e-5 + 2e-4;
  assert.ok(Math.abs(v.total_alpha_spent - expected) < 1e-12,
    `α_spent sum mismatch: got ${v.total_alpha_spent}, expected ${expected}`);
});

// ────────────────────────────────────────────────────────────────────
// α_spent is the union bound across families: sums Family A + C (not B).
test('fuseVerdict: α_spent union-bound accounting', () => {
  const h = emptyHealth();
  h.family_A_shadow = [fireA('p99_latency', 6.67e-5), fireA('ttft', 6.67e-5)];
  h.family_C_verdict = fireC(2e-4);
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' },
    { id: 'family_A_ttft',        label: 'Family A ttft' },
    { id: 'family_C',             label: 'Family C (multivariate)' },
  ];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test' });
  // Family A fires 2 signals × 6.67e-5 + Family C 2e-4.
  const expected = 2 * 6.67e-5 + 2e-4;
  assert.ok(Math.abs(v.total_alpha_spent - expected) < 1e-12);
});

// ────────────────────────────────────────────────────────────────────
// Cascade-topology output produces the same verdict shape.
test('fuseVerdict: cascade topology also aggregates, with fusion_topology=cascade', () => {
  const h = emptyHealth();
  h.rollback = [{ id: 'family_A_p99_latency', label: 'Family A p99_latency' }];
  h.family_A_shadow = [fireA('p99_latency'), cleanA('ttft')];
  const v = fuseVerdict(h, { topology: 'cascade', tick: 15, totalTicks: 32, deployRef: 'test' });
  assert.equal(v.verdict, 'rollback');
  assert.equal(v.fusion_topology, 'cascade');
});

// ────────────────────────────────────────────────────────────────────
// Injected Family D/E are aggregated correctly when present.
test('fuseVerdict: injected Family D fire drives rollback and alpha accounting', () => {
  const h = emptyHealth();
  const familyD: DetectorVerdict = {
    verdict: 'fire', statistic: 0.9, threshold: 0.5,
    alpha_consumed: 1e-4, alpha_spent: 1e-4,
    reason_code: 'spectral_peak', family: 'D',
  };
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 15, totalTicks: 32, deployRef: 'test', familyD });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['D']);
  assert.equal(v.total_alpha_spent, 1e-4);
});

test('fuseVerdict: injected Family E indeterminate drives extend', () => {
  const h = emptyHealth();
  const familyE: DetectorVerdict = {
    verdict: 'indeterminate', statistic: 1.5, threshold: 2.0,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'conformal_marginal', family: 'E',
  };
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 10, totalTicks: 32, deployRef: 'test', familyE });
  assert.equal(v.verdict, 'extend');
});

// test/defect-override-vs-configured.test.ts — review finding on the 2026-09-25 direction fix.
// Once a profile's configured direction was read before the table, a store whose
// informational_direction_overrides named cost_req (the documented way to fold an informational
// signal in) threw "direction override for 'cost_req' is not permitted", because every shipped
// profile configures cost_req 'lower'. classifyCandidate's catch-all then returned 'mixed' with
// per_signal_direction {} on every recalibration.
//
// Precedence now: an operator override on a table-'informational' signal wins over the configured
// direction; an override on any other signal that the profile configures is ignored in favour of
// the configured direction. Either way the disagreement is recorded, not thrown.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig } from '../dist/engine/types';
import { directionOfBetter, resolveDirection } from '../engine/recalibration/direction-metadata';
import { classifyRecalibration } from '../engine/recalibration/classify';
import { classifyCandidate } from '../tools/recalibrate/_recalibrate-candidate';

const CONFIGURED = {
  p99_latency: { direction_of_better: 'lower' as const, delta_min: 0.01 },
  cost_req: { direction_of_better: 'lower' as const, delta_min: 0.01 },
};

test('override on an informational table signal wins over the configured direction, conflict recorded', () => {
  assert.equal(directionOfBetter('cost_req', { cost_req: 'higher' }, CONFIGURED), 'higher');
  assert.deepEqual(resolveDirection('cost_req', { cost_req: 'higher' }, CONFIGURED), {
    direction: 'higher',
    conflict: { signal: 'cost_req', override: 'higher', configured: 'lower', applied: 'override' },
  });
  // Agreement is not a conflict.
  assert.deepEqual(resolveDirection('cost_req', { cost_req: 'lower' }, CONFIGURED), { direction: 'lower' });
});

test('override on a configured non-informational signal is ignored, conflict recorded, no throw', () => {
  const configured = { ...CONFIGURED, http_5xx: { direction_of_better: 'lower' as const, delta_min: 0.05 } };
  assert.deepEqual(resolveDirection('p99_latency', { p99_latency: 'higher' }, configured), {
    direction: 'lower',
    conflict: { signal: 'p99_latency', override: 'higher', configured: 'lower', applied: 'configured' },
  });
  assert.deepEqual(resolveDirection('http_5xx', { http_5xx: 'higher' }, configured), {
    direction: 'lower',
    conflict: { signal: 'http_5xx', override: 'higher', configured: 'lower', applied: 'configured' },
  });
  // Unconfigured and non-informational: still refused, as on main.
  assert.throws(() => directionOfBetter('mfu', { mfu: 'lower' }, configured), /not permitted/);
});

test('classifyRecalibration with overrides and configured together keeps every per-signal verdict', () => {
  const r = classifyRecalibration(
    { cost_req: 1.0, p99_latency: 100 },
    { cost_req: 1.2, p99_latency: 90 },
    { overrides: { cost_req: 'lower' }, configured: CONFIGURED },
  );
  assert.deepEqual(r.per_signal_direction, { cost_req: 'degraded', p99_latency: 'improved' });
  assert.deepEqual(r.direction_conflicts, []);

  const flipped = classifyRecalibration(
    { cost_req: 1.0, p99_latency: 100 },
    { cost_req: 1.2, p99_latency: 90 },
    { overrides: { cost_req: 'higher' }, configured: CONFIGURED },
  );
  assert.deepEqual(flipped.per_signal_direction, { cost_req: 'improved', p99_latency: 'improved' });
  assert.deepEqual(flipped.direction_conflicts, [
    { signal: 'cost_req', override: 'higher', configured: 'lower', applied: 'override' },
  ]);
});

function cfg(means: Record<string, number>, sliMeta?: object): CompiledConfig {
  const per_signal = Object.fromEntries(Object.entries(means).map(([s, m]) => [s, { baseline_mean: m }]));
  return {
    baseline_cells: { cells: [], aggregate_fallback: { family_A: { per_signal } } },
    ...(sliMeta ? { sli_meta: sliMeta } : {}),
  } as unknown as CompiledConfig;
}

test('classifyCandidate: overrides + configured classify per signal (no silent mixed/{} fallback)', () => {
  const meta = { unchanged_epsilon_rel: 0.01, informational_direction_overrides: { cost_req: 'lower' as const } };
  const out = classifyCandidate(cfg({ cost_req: 1.0, p99_latency: 100 }, CONFIGURED), cfg({ cost_req: 1.2, p99_latency: 90 }, CONFIGURED), meta);
  assert.deepEqual(out.per_signal_direction, { cost_req: 'degraded', p99_latency: 'improved' });
});

test('classifyCandidate: only the empty-intersection error falls back to mixed; other errors propagate', () => {
  const meta = { unchanged_epsilon_rel: 0.01, informational_direction_overrides: {} };
  const empty = classifyCandidate(cfg({ a: 1 }), cfg({ b: 1 }), meta);
  assert.equal(empty.direction_classification, 'mixed');
  assert.deepEqual(empty.per_signal_direction, {});
  const bad = { unchanged_epsilon_rel: 0.01, informational_direction_overrides: { mfu: 'lower' as const } };
  assert.throws(() => classifyCandidate(cfg({ mfu: 1 }), cfg({ mfu: 2 }), bad), /not permitted/);
});

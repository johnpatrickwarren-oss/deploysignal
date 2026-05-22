// test/q29-anvil-profile-validates.test.ts — Q29 / Addition #29 profile
// + schema validation.
//
// Closes PRD-29 AC-3 (profile loads via tools/profile-loader.ts), AC-4
// (schema accepts the optional expected_failure_pattern_defaults), and
// the AC-11 second case (pre-Anvil profiles validate unchanged).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadProfile } from '../tools/profile-loader';

test('Q29 / AC-3 — anvil-chaos-experiment@1.0.0 resolves via loadProfile', () => {
  const profile = loadProfile('anvil-chaos-experiment@1.0.0');
  assert.equal(profile.id, 'anvil-chaos-experiment');
  assert.equal(profile.version, '1.0.0');
});

test('Q29 / AC-3 — anvil profile alpha_allocation: A + C only, B/D/E zero, sum = total', () => {
  const profile = loadProfile('anvil-chaos-experiment@1.0.0');
  const pf = profile.alpha_allocation.per_family;
  assert.ok(pf.A > 0, 'Family A enabled');
  assert.ok(pf.C > 0, 'Family C enabled');
  assert.equal(pf.B, 0, 'Family B default-off per Q29.3');
  assert.equal(pf.D, 0, 'Family D default-off per Q29.3');
  assert.equal(pf.E, 0, 'Family E default-off per Q29.3');
  const sum = pf.A + pf.B + pf.C + pf.D + pf.E;
  assert.ok(Math.abs(sum - profile.alpha_allocation.total) < 1e-12,
    'alpha_allocation invariant holds');
});

test('Q29 / AC-4 — anvil profile carries expected_failure_pattern_defaults block', () => {
  const profile = loadProfile('anvil-chaos-experiment@1.0.0');
  assert.ok(profile.expected_failure_pattern_defaults,
    'expected_failure_pattern_defaults present');
  const defaults = profile.expected_failure_pattern_defaults!;
  assert.deepEqual(defaults.default_suppress_families, ['A']);
  assert.equal(defaults.default_recovery_seconds, 60);
  assert.equal(defaults.default_magnitude_unit, 'relative_fraction');
});

test('Q29 / AC-11 — pre-Anvil profiles still validate (no expected_failure_pattern_defaults)', () => {
  // generic-microservice + the two LLM profiles all predate Anvil and
  // must continue to load cleanly with the schema extension.
  const generic = loadProfile('generic-microservice@1.0.0');
  assert.equal(generic.id, 'generic-microservice');
  assert.equal(generic.expected_failure_pattern_defaults, undefined,
    'pre-Anvil profile has no defaults block');

  const streaming = loadProfile('llm-inference-streaming@1.0.0');
  assert.equal(streaming.id, 'llm-inference-streaming');
  assert.equal(streaming.expected_failure_pattern_defaults, undefined);

  const batch = loadProfile('llm-inference-batch@1.0.0');
  assert.equal(batch.id, 'llm-inference-batch');
  assert.equal(batch.expected_failure_pattern_defaults, undefined);
});

test('Q29 / AC-3 — anvil profile extends generic-microservice (inheritance chain)', () => {
  // Anvil's YAML declares `extends: generic-microservice` — verify the
  // inheritance resolved (profile carries fields the parent declared,
  // e.g. cell_dimensions defaults the anvil profile doesn't override).
  const profile = loadProfile('anvil-chaos-experiment@1.0.0');
  assert.equal(typeof profile.cell_dimensions.hour_of_day, 'boolean');
  assert.equal(typeof profile.cell_dimensions.day_of_week, 'boolean');
  // Joint vector is anvil-overridden (parent has empty signals; anvil
  // declares p99_latency + downstream_err).
  assert.ok(profile.joint_vector.signals.length >= 2);
  assert.equal(profile.joint_vector.include_in_family_c, true);
  assert.equal(profile.joint_vector.include_in_family_e, false);
});

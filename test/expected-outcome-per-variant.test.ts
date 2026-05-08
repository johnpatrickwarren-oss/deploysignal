// test/expected-outcome-per-variant.test.ts — End-phase slice 2a (D-54-5).
//
// Per ARCHITECT-REPLY-54 D-54-5: demo expected_outcome schema extended
// with `min_compiler_version` + `per_variant` map. Test-harness logic:
//
//   1. Read CompiledConfig to determine the compiled variant.
//   2. Lookup per_variant[variant] for variant-specific expectations.
//   3. Assert against the per-variant expectation.
//   4. Fallback to the top-level legacy fields when per_variant is
//      absent or the requested variant isn't listed.
//
// This file covers the resolver in isolation + asserts the
// demo-github-2020 per_variant invariant (+7-tick drift between
// spectral_bootstrap_null and spectral_e_detector per NS-ARCH
// Addition #21 empirical note).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEMOS_DIR = path.resolve(__dirname, '..', 'demos', 'scripts');

/** Shape of an expected_outcome block after D-54-5 extension. All
 *  fields optional — legacy pre-#54 demos don't carry `per_variant`
 *  or `min_compiler_version`. */
interface ExpectedOutcomePerVariant {
  min_compiler_version?: string;
  per_variant?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Resolve an expected_outcome against the compiled variant.
 *
 *  When `per_variant[variant]` exists, its fields override the
 *  top-level legacy fields. When absent (either because the outcome
 *  has no `per_variant` block, or because the requested variant isn't
 *  listed), the top-level legacy fields are returned unchanged.
 *
 *  Exported so downstream demo-parity tests + D-54-4 slice-2b
 *  consumers can re-use the resolution rule. */
export function resolveExpectedOutcome(
  expected: ExpectedOutcomePerVariant,
  variant: string | null,
): Record<string, unknown> {
  const pv = expected.per_variant;
  if (!pv || !variant || !pv[variant]) return { ...expected };
  // Variant overrides win over legacy top-level fields.
  return { ...expected, ...pv[variant] };
}

// ── Resolver behavior ─────────────────────────────────────────────

test('expected-outcome: per_variant override wins over legacy fields', () => {
  const base: ExpectedOutcomePerVariant = {
    fire_tick: 26,
    firing_family: 'D',
    per_variant: {
      spectral_bootstrap_null: { fire_tick: 19 },
      spectral_e_detector: { fire_tick: 26 },
    },
  };
  assert.equal(resolveExpectedOutcome(base, 'spectral_bootstrap_null').fire_tick, 19);
  assert.equal(resolveExpectedOutcome(base, 'spectral_e_detector').fire_tick, 26);
});

test('expected-outcome: legacy fire_tick fallback when per_variant absent', () => {
  const legacy: ExpectedOutcomePerVariant = { fire_tick: 10, firing_family: 'A' };
  assert.equal(resolveExpectedOutcome(legacy, 'any_variant').fire_tick, 10);
  assert.equal(resolveExpectedOutcome(legacy, null).fire_tick, 10);
});

test('expected-outcome: unknown variant under per_variant falls back to legacy', () => {
  const partial: ExpectedOutcomePerVariant = {
    fire_tick: 26,
    per_variant: { spectral_e_detector: { fire_tick: 26 } },
  };
  const resolved = resolveExpectedOutcome(partial, 'spectral_bootstrap_null');
  assert.equal(resolved.fire_tick, 26,
    'unknown variant → legacy top-level fire_tick preserved');
});

test('expected-outcome: null variant arg falls back to legacy (pre-compile paths)', () => {
  const withVariants: ExpectedOutcomePerVariant = {
    fire_tick: 100,
    per_variant: { spectral_e_detector: { fire_tick: 26 } },
  };
  assert.equal(resolveExpectedOutcome(withVariants, null).fire_tick, 100);
});

test('expected-outcome: legacy fields not in per_variant persist through override', () => {
  const base: ExpectedOutcomePerVariant = {
    verdict: 'rollback',
    firing_family: 'D',
    fire_tick: 26,
    per_variant: { spectral_bootstrap_null: { fire_tick: 19 } },
  };
  const resolved = resolveExpectedOutcome(base, 'spectral_bootstrap_null');
  assert.equal(resolved.fire_tick, 19, 'per_variant override applied');
  assert.equal(resolved.verdict, 'rollback', 'legacy verdict passes through');
  assert.equal(resolved.firing_family, 'D', 'legacy firing_family passes through');
});

// ── demo-github-2020 specific per_variant invariant ───────────────

test('expected-outcome: demo-github-2020 carries per_variant + min_compiler_version', () => {
  const demo = JSON.parse(
    fs.readFileSync(path.join(DEMOS_DIR, 'demo-github-2020.json'), 'utf8'),
  );
  const exp = demo.expected_outcome as ExpectedOutcomePerVariant;
  assert.ok(exp.per_variant,
    'demo-github-2020 must carry a per_variant block post-D-54-5');
  assert.ok(exp.min_compiler_version,
    'demo-github-2020 must carry min_compiler_version when per_variant is set');
});

test('expected-outcome: demo-github-2020 spectral variants recorded per Addition #21 empirical', () => {
  const demo = JSON.parse(
    fs.readFileSync(path.join(DEMOS_DIR, 'demo-github-2020.json'), 'utf8'),
  );
  const pv = demo.expected_outcome.per_variant as Record<string, { fire_tick: number }>;
  assert.equal(pv.spectral_bootstrap_null?.fire_tick, 19,
    'spectral_bootstrap_null Family D fire_tick must be 19 per NS-ARCH #21 empirical');
  assert.equal(pv.spectral_e_detector?.fire_tick, 26,
    'spectral_e_detector Family D fire_tick must be 26 per NS-ARCH #21 empirical');
});

test('expected-outcome: demo-github-2020 asserts +7-tick e-detector drift', () => {
  const demo = JSON.parse(
    fs.readFileSync(path.join(DEMOS_DIR, 'demo-github-2020.json'), 'utf8'),
  );
  const pv = demo.expected_outcome.per_variant as Record<string, { fire_tick: number }>;
  const drift = pv.spectral_e_detector.fire_tick - pv.spectral_bootstrap_null.fire_tick;
  assert.equal(drift, 7,
    '+7-tick e-detector drift per Addition #21 sufficiency-gate (≤25-tick ' +
    'horizon on 2σ₀ oscillation + ≈0.956×/tick healthy drift)');
});

// ── Legacy demos remain resolver-compatible without per_variant ───

test('expected-outcome: non-github demos without per_variant resolve cleanly', () => {
  const demos = fs.readdirSync(DEMOS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of demos) {
    const demo = JSON.parse(fs.readFileSync(path.join(DEMOS_DIR, f), 'utf8'));
    const exp = demo.expected_outcome as ExpectedOutcomePerVariant;
    // Call resolver with an arbitrary variant — pre-#54 demos without
    // per_variant must return the untouched legacy fields.
    const resolved = resolveExpectedOutcome(exp, 'spectral_e_detector');
    if (!exp.per_variant) {
      assert.deepEqual(resolved, { ...exp },
        `${f}: legacy expected_outcome must pass through resolver unchanged`);
    }
  }
});

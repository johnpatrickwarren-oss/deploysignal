// test/q29-orchestrator-suppression.test.ts — Q29 / Addition #29
// orchestrator expected_failure_pattern suppression acceptance.
//
// Closes PRD-29 FR-5 (suppress_families honored inside the fault window;
// suppression releases after recovery_seconds) and AC-11 first case
// (orchestrator behavior byte-identical when expectedFailurePattern
// absent — verified by the existing regression suite continuing to pass;
// here we also do a direct same-params round-trip).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyExpectedFailurePatternSuppression } from '../dist/engine/o0/anvil/suppression';
import type {
  ExpectedFailurePattern,
} from '../dist/engine/o0/anvil/types';
import type {
  HealthResult, DetectorVerdict,
} from '../dist/engine/types';

function detector(family: 'A' | 'B' | 'C' | 'D' | 'E', signal?: string): DetectorVerdict {
  return {
    verdict: 'fire',
    statistic: 1.0,
    threshold: 0.5,
    alpha_consumed: 1e-4,
    alpha_spent: 1e-4,
    reason_code: 'page_cusum_fire',
    family,
    signal,
  };
}

function baseHealthResult(): HealthResult {
  return {
    rollback: [],
    extend: [],
    warmup: { active: false, grace: false, pct: 1.0, suppressedIds: [] },
    suppressed: [],
    family_A_shadow: [detector('A', 'p99_latency'), detector('A', 'downstream_err')],
    family_C_verdict: detector('C'),
    family_D_shadow: [detector('D', 'p99_latency')],
    family_E_verdict: detector('E'),
  };
}

function pattern(overrides: Partial<ExpectedFailurePattern> = {}): ExpectedFailurePattern {
  return {
    kind: 'latency_injection',
    affected_signals: ['p99_latency'],
    magnitude: 0.3,
    magnitude_unit: 'relative_fraction',
    recovery_seconds: 60,
    suppress_families: ['A'],
    fault_start_unix: 1_700_000_000,
    ...overrides,
  };
}

test('Q29 / FR-5 — inside fault window, suppress_families rewrites named family to suppressed', () => {
  const hr = baseHealthResult();
  const p = pattern();
  const out = applyExpectedFailurePatternSuppression(hr, p, 1_700_000_030);

  // Family A — was firing; now all suppressed with reason_code 'expected_failure_pattern'.
  const fa = out.family_A_shadow!;
  for (const v of fa) {
    assert.equal(v.verdict, 'suppressed', `family A signal ${v.signal} must suppress`);
    assert.equal(v.reason_code, 'expected_failure_pattern');
    assert.equal(v.alpha_consumed, 0);
    assert.equal(v.alpha_spent, 0);
  }
  // Family C/D/E unaffected — not in suppress_families.
  assert.equal(out.family_C_verdict!.verdict, 'fire');
  assert.equal(out.family_D_shadow![0].verdict, 'fire');
  assert.equal(out.family_E_verdict!.verdict, 'fire');
});

test('Q29 / FR-5 — outside fault window, suppression releases (no rewrite)', () => {
  const hr = baseHealthResult();
  const p = pattern();
  // 1 second past the window end (start + recovery_seconds = 1_700_000_060)
  const out = applyExpectedFailurePatternSuppression(hr, p, 1_700_000_061);

  // No family rewritten.
  assert.equal(out.family_A_shadow![0].verdict, 'fire');
  assert.equal(out.family_A_shadow![0].reason_code, 'page_cusum_fire');
  assert.equal(out.family_C_verdict!.verdict, 'fire');
});

test('Q29 / FR-5 — multi-family suppress_families', () => {
  const hr = baseHealthResult();
  const p = pattern({ suppress_families: ['A', 'C', 'E'] });
  const out = applyExpectedFailurePatternSuppression(hr, p, 1_700_000_030);

  assert.equal(out.family_A_shadow![0].verdict, 'suppressed');
  assert.equal(out.family_C_verdict!.verdict, 'suppressed');
  assert.equal(out.family_E_verdict!.verdict, 'suppressed');
  // D not listed — still firing.
  assert.equal(out.family_D_shadow![0].verdict, 'fire');
});

test('Q29 / FR-5 — empty suppress_families is a no-op', () => {
  const hr = baseHealthResult();
  const p = pattern({ suppress_families: [] });
  const out = applyExpectedFailurePatternSuppression(hr, p, 1_700_000_030);
  // Returns input unchanged.
  assert.equal(out, hr);
});

test('Q29 / AC-11 — pure function does not mutate input HealthResult', () => {
  const hr = baseHealthResult();
  const beforeA0Verdict = hr.family_A_shadow![0].verdict;
  const beforeA0Reason  = hr.family_A_shadow![0].reason_code;
  const p = pattern();
  applyExpectedFailurePatternSuppression(hr, p, 1_700_000_030);
  // Input hr untouched.
  assert.equal(hr.family_A_shadow![0].verdict, beforeA0Verdict);
  assert.equal(hr.family_A_shadow![0].reason_code, beforeA0Reason);
});

test('Q29 / FR-5 — Family B in suppress_families is a documented no-op (HealthResult has no Family B detector array)', () => {
  // Family B is non-α-consuming structural per Q60 V2; HealthResult does
  // not expose a family_B_shadow / family_B_verdict surface for
  // detector-level suppression. The Anvil suppression helper silently
  // skips Family B; the test asserts the function returns without error
  // and leaves the other families untouched.
  const hr = baseHealthResult();
  const p = pattern({ suppress_families: ['B'] });
  const out = applyExpectedFailurePatternSuppression(hr, p, 1_700_000_030);
  // Nothing rewritten — A/C/D/E all still firing.
  assert.equal(out.family_A_shadow![0].verdict, 'fire');
  assert.equal(out.family_C_verdict!.verdict, 'fire');
  assert.equal(out.family_D_shadow![0].verdict, 'fire');
  assert.equal(out.family_E_verdict!.verdict, 'fire');
});

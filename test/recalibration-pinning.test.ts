// test/recalibration-pinning.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 4.
//
// Exercises engine/recalibration/pinning.ts: validateDeployPinning
// checks that a set of in-flight audit records stayed pinned to a
// declared baseline version, across BOTH the top-level
// compiled_config_version and every detector trip's per-trip
// provenance.baseline_version (D4 — deploys already carry both; this
// module is a pure validation helper, no orchestrator change).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDeployPinning } from '../engine/recalibration/pinning';
import type { AuditRecordV2, FamilyVerdictV2, DetectorTripV2 } from '../engine/types';

function makeProvenance(baselineVersion: string): DetectorTripV2['provenance'] {
  return {
    cell_key: { hour_of_day: 0 },
    cell_confidence: 'strict',
    variance_inflated: false,
    covariate_freshness: 0,
    baseline_version: baselineVersion,
    schema_continuity: 'continuous',
  };
}

function makeTrip(baselineVersion: string): DetectorTripV2 {
  return {
    family_id: 'A',
    detector_id: 'mSPRT_p99_latency',
    statistic: 12,
    threshold: 9.6,
    alpha_spent: 6.67e-5,
    reason_code: 'cusum_exceeded_threshold',
    gate: 'health_rollback',
    label: 'Family A p99_latency',
    provenance: makeProvenance(baselineVersion),
  };
}

function cleanFamily(): FamilyVerdictV2 {
  return { verdict: 'clean', detectors: [], alpha_spent: 0, suppression_reason: null };
}

function makeRecord(overrides: {
  ts?: string;
  compiledConfigVersion: string;
  familyABaselineVersion?: string;
}): AuditRecordV2 {
  const families: Record<string, FamilyVerdictV2> = {
    A: overrides.familyABaselineVersion
      ? { verdict: 'fire', detectors: [makeTrip(overrides.familyABaselineVersion)], alpha_spent: 6.67e-5, suppression_reason: null }
      : cleanFamily(),
    B: cleanFamily(),
    C: cleanFamily(),
    D: cleanFamily(),
    E: cleanFamily(),
  };
  return {
    schema_version: '2',
    ts: overrides.ts ?? '2026-07-01T00:00:00.000Z',
    service: 'svc-demo',
    tick: 0,
    total_ticks: 32,
    hours_elapsed: 0,
    verdict: overrides.familyABaselineVersion ? 'rollback' : 'proceed',
    reason: 'test',
    short_circuit: null,
    tripped: [],
    inputs: {} as never,
    baseline: {},
    scenario_ctx: {},
    trend_snapshot: null,
    policy_ctx_digest: 'digest',
    mode: 'act',
    gate_results: {} as never,
    fusion_topology: 'portfolio',
    compiled_config_version: overrides.compiledConfigVersion,
    families: families as AuditRecordV2['families'],
    reversibility: null,
    reversibility_source: null,
    total_alpha_spent: overrides.familyABaselineVersion ? 6.67e-5 : 0,
  };
}

test('validateDeployPinning: clean deploy pinned to one version -> no violations', () => {
  const records = [
    makeRecord({ compiledConfigVersion: 'v5', familyABaselineVersion: 'v5' }),
    makeRecord({ compiledConfigVersion: 'v5' }),
    makeRecord({ compiledConfigVersion: 'v5', familyABaselineVersion: 'v5' }),
  ];
  assert.deepEqual(validateDeployPinning(records, 'v5'), []);
});

test('validateDeployPinning: top-level compiled_config_version flip is a violation', () => {
  const records = [
    makeRecord({ compiledConfigVersion: 'v5' }),
    makeRecord({ compiledConfigVersion: 'v6' }), // mid-deploy flip
  ];
  const violations = validateDeployPinning(records, 'v5');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'compiled_config_version');
  assert.equal(violations[0].expected, 'v5');
  assert.equal(violations[0].actual, 'v6');
  assert.equal(violations[0].record_index, 1);
});

test('validateDeployPinning: per-trip provenance.baseline_version flip is a violation, independent of the top-level field', () => {
  const records = [
    makeRecord({ compiledConfigVersion: 'v5', familyABaselineVersion: 'v5' }),
    // Top-level field stayed pinned, but the trip's provenance shows a
    // mid-deploy baseline swap underneath it — must still be caught.
    makeRecord({ compiledConfigVersion: 'v5', familyABaselineVersion: 'v6' }),
  ];
  const violations = validateDeployPinning(records, 'v5');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'trip_provenance_baseline_version');
  assert.equal(violations[0].expected, 'v5');
  assert.equal(violations[0].actual, 'v6');
  assert.equal(violations[0].record_index, 1);
  assert.equal(violations[0].family_id, 'A');
  assert.equal(violations[0].detector_id, 'mSPRT_p99_latency');
});

test('validateDeployPinning: both surfaces flipping on the same record report two violations', () => {
  const records = [
    makeRecord({ compiledConfigVersion: 'v6', familyABaselineVersion: 'v6' }),
  ];
  const violations = validateDeployPinning(records, 'v5');
  assert.equal(violations.length, 2);
  const kinds = violations.map((v) => v.kind).sort();
  assert.deepEqual(kinds, ['compiled_config_version', 'trip_provenance_baseline_version']);
});

test('validateDeployPinning: empty records array -> no violations', () => {
  assert.deepEqual(validateDeployPinning([], 'v5'), []);
});

// test/srm-short-circuit.integration.test.ts — Addition #10 acceptance.
//
// End-to-end verification that a 'breaking' L0 traffic-allocation class
// short-circuits the orchestrator with shortCircuit='srm', top-level
// verdict 'rollback', the canonical SRM reason string, and every family
// block empty (all detectors suppressed — the health gate never runs).
// Also asserts the `traffic_allocation_continuity` audit field emits on
// every tick regardless of short-circuit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  OrchestrateParams, AuditRecord, AuditRecordV2, FamilyId, Metrics, VerdictResult,
} from '../dist/engine/types';
import {
  classifyContinuity, initialState,
} from '../dist/engine/l0/traffic-allocation-continuity';
import type {
  TrafficAllocationState,
} from '../dist/engine/l0/traffic-allocation-continuity';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');

const EXPECTED_CANARY_WEIGHT = 0.10;

function makeScenario(): OrchestrateParams['scenario'] {
  return {
    id: 'sci-srm-integration',
    riskLevel: 'critical',
    bakeHours: 6,
    author: 'human',
    changeType: 'model_weights',
    timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: {
      p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
      cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
      collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: EXPECTED_CANARY_WEIGHT,
    },
  };
}

// Metrics at the current tick; traffic_pct is driven by the per-test
// trajectory, all other signals pin to baseline so no Family detector
// would legitimately fire (isolates SRM as the cause of short-circuit).
function makeLive(baseline: Metrics, trafficPct: number): Metrics {
  return { ...baseline, traffic_pct: trafficPct };
}

interface RunResult {
  audits: (AuditRecord | AuditRecordV2)[];
  verdicts: VerdictResult[];
  statuses: Array<'stable' | 'drifting' | 'breaking'>;
}

function runTrajectory(trafficTrajectory: number[]): RunResult {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  let srmState: TrafficAllocationState = initialState(EXPECTED_CANARY_WEIGHT);

  const audits: (AuditRecord | AuditRecordV2)[] = [];
  const verdicts: VerdictResult[] = [];
  const statuses: Array<'stable' | 'drifting' | 'breaking'> = [];

  for (let i = 0; i < trafficTrajectory.length; i++) {
    const trafficPct = trafficTrajectory[i];
    const live = makeLive(sc.baseline, trafficPct);
    for (const k of Object.keys(live)) tb.push(k, live[k]);

    const classify = classifyContinuity(trafficPct, srmState);
    srmState = classify.newState;
    statuses.push(classify.status);

    const params: OrchestrateParams = {
      liveMetrics: live,
      scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb,
      tick: i,
      totalTicks: trafficTrajectory.length,
      trafficAllocationContinuity: classify.status,
      expectedCanaryWeight: EXPECTED_CANARY_WEIGHT,
    };
    const result = orchestrate(params);
    verdicts.push(result);
    const record = buildAuditRecord(params, result, { service: 'srm-test' });
    audits.push(record);
  }
  return { audits, verdicts, statuses };
}

// ─────────────────────────────────────────────────────────────────────
test('srm integration: diverging trajectory — stable → drifting → breaking → short-circuit', () => {
  // Ticks 0–4 stable at 0.10, then sustained drift at 0.15 for ≥ 5 ticks to
  // trip the drifting-to-breaking escalation (non-catastrophic).
  const traj = [0.10, 0.10, 0.10, 0.10, 0.10, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15];
  const { audits, verdicts, statuses } = runTrajectory(traj);

  // Stable prefix.
  for (let i = 0; i < 5; i++) {
    assert.equal(statuses[i], 'stable', `tick ${i} expected 'stable'; got ${statuses[i]}`);
    assert.notEqual(verdicts[i].shortCircuit, 'srm', `tick ${i} must not short-circuit SRM`);
  }

  // Sustained drift escalation: drifting for DRIFTING_TO_BREAKING_TICKS-1
  // ticks (the counter runs 1..4), then breaking at the 5th consecutive.
  const firstBreak = statuses.indexOf('breaking');
  assert.ok(firstBreak >= 9, `breaking expected at or after tick 9 (5 sustained drifts); got ${firstBreak}`);

  // On breaking: short-circuit fires with the canonical reason.
  const breakTickAudit = audits[firstBreak];
  assert.equal(breakTickAudit.short_circuit, 'srm', 'short_circuit must be "srm" at breaking tick');
  assert.equal(breakTickAudit.verdict, 'rollback', 'verdict must be "rollback" on SRM short-circuit');
  assert.match(
    breakTickAudit.reason,
    /Sample Ratio Mismatch — observed canary fraction \d+\.\d%.* diverged from expected \d+\.\d%/,
    'reason must match canonical SRM format',
  );
});

test('srm integration: traffic_allocation_continuity field emitted on every tick', () => {
  const traj = [0.10, 0.10, 0.10, 0.10, 0.10, 0.00];
  const { audits, statuses } = runTrajectory(traj);
  assert.equal(audits.length, statuses.length);
  for (let i = 0; i < audits.length; i++) {
    assert.equal(
      audits[i].traffic_allocation_continuity,
      statuses[i],
      `tick ${i} audit field must equal classifier status`,
    );
  }
});

test('srm integration: catastrophic traffic collapse — breaking at the outlier tick', () => {
  // Stable at expected for 5 ticks, then traffic_pct drops to 0. zScore on
  // floor-σ: |0 − 0.10| / 0.02 = 5.0 ≥ CATASTROPHIC_SIGMA_THRESHOLD →
  // immediate breaking (no 5-tick wait).
  const traj = [0.10, 0.10, 0.10, 0.10, 0.10, 0.00];
  const { verdicts, statuses } = runTrajectory(traj);
  assert.equal(statuses[5], 'breaking', 'catastrophic drop → breaking at outlier tick');
  assert.equal(verdicts[5].shortCircuit, 'srm');
  assert.equal(verdicts[5].verdict, 'rollback');
});

test('srm integration: family suppression — no health gate runs on short-circuit', () => {
  // When SRM short-circuits, the orchestrator skips evaluateHealth entirely.
  // healthResult must be null on that verdict and the audit record's
  // `tripped` array must be empty (no detector fires).
  const traj = [0.10, 0.10, 0.10, 0.10, 0.10, 0.00];
  const { audits, verdicts, statuses } = runTrajectory(traj);
  const breakIdx = statuses.indexOf('breaking');
  assert.ok(breakIdx >= 0, 'trajectory must reach breaking');
  assert.equal(verdicts[breakIdx].healthResult, null, 'healthResult must be null on SRM short-circuit');
  assert.equal(audits[breakIdx].tripped.length, 0, 'no tripped detectors on SRM short-circuit');
});

test('srm integration: stable trajectory — no short-circuit, full gate path runs', () => {
  // Baseline holds at expected for the full run — no SRM fire, health
  // result must be populated.
  const traj = Array(8).fill(EXPECTED_CANARY_WEIGHT);
  const { audits, verdicts, statuses } = runTrajectory(traj);
  for (const s of statuses) assert.equal(s, 'stable');
  for (let i = 0; i < verdicts.length; i++) {
    assert.notEqual(verdicts[i].shortCircuit, 'srm', `tick ${i} stable must not short-circuit`);
    assert.ok(verdicts[i].healthResult !== null, `tick ${i} health gate must evaluate`);
    assert.equal(audits[i].traffic_allocation_continuity, 'stable');
  }
});

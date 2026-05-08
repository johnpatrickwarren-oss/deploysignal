// test/reversibility-integration.test.ts — Addition #5 end-to-end.
//
// Drives the orchestrator through synthetic scenarios with different
// reversibility annotations; asserts audit-field propagation, the O0
// translator's concrete-action output on terminal verdicts, and the
// backward-compat default-fallback path.
//
// Brief: coordination/ARCHITECT-REPLY-32.md §"Integration tests". Flat
// layout per #10/#13/#14 precedent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InlineReversibilitySource, ScenarioReversibilitySource,
} from '../dist/engine/o0/reversibility-source';
import type {
  OrchestrateParams, Metrics, AuditRecord, AuditRecordV2,
  ReversibilityClassification,
} from '../dist/engine/types';
import type { Reversibility } from '../dist/engine/o0/reversibility-source';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sci-reversibility'): OrchestrateParams['scenario'] {
  return {
    id, riskLevel: 'critical', bakeHours: 6,
    author: 'human', changeType: 'model_weights', timeWindow: 'ok',
    flags: {
      security: false, artifact_content: false, provenance: false,
      contract: false, toolchain: false, zeta: true, approval: true,
    },
    baseline: BASELINE,
  };
}

function makeLive(overrides: Partial<Metrics> = {}): Metrics {
  return { ...BASELINE, ...overrides };
}

/** Drive a synthetic rollback via fail-fast so the scenario reaches a
 *  terminal rollback verdict deterministically without depending on
 *  bake profiles or compiled configs. */
function runRollbackDeploy(opts: {
  reversibilitySource?: OrchestrateParams['reversibilitySource'];
  deployId?: string;
}): {
  audits: (AuditRecord | AuditRecordV2)[];
  classification: ReversibilityClassification | undefined;
  terminalResult: ReturnType<typeof orchestrate>;
} {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const audits: (AuditRecord | AuditRecordV2)[] = [];
  const ticks = 6;
  let failFastState = undefined as OrchestrateParams['failFastState'];
  let classification: ReversibilityClassification | undefined;
  let terminalResult: ReturnType<typeof orchestrate> | undefined;
  for (let i = 0; i < ticks; i++) {
    const live = makeLive({ downstream_err: i < 2 ? 0.02 : 0.08 });
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: ticks,
      deployId: opts.deployId ?? 'rev-test',
      fusionTopology: 'portfolio',
      reversibilitySource: opts.reversibilitySource,
      reversibilityClassification: classification,
      failFastState,
      failFastThresholds: { downstream_err: 0.05 },
    };
    const result = orchestrate(params);
    audits.push(buildAuditRecord(params, result, { service: 'rev-test' }));
    failFastState = result.failFastState;
    classification = result.reversibilityClassification;
    if (result.shortCircuit === 'policy_fail_fast') {
      terminalResult = result;
      break;
    }
  }
  return { audits, classification, terminalResult: terminalResult! };
}

// ────────────────────────────────────────────────────────────────────
// Per-classification rollback behavior.
// ────────────────────────────────────────────────────────────────────

test('integration 1: reversible deploy → final_action is rollback; audit source=platform_annotation', () => {
  const { audits, classification, terminalResult } = runRollbackDeploy({
    reversibilitySource: new InlineReversibilitySource('reversible'),
  });
  assert.equal(classification?.reversibility, 'reversible');
  assert.equal(classification?.reversibility_source, 'platform_annotation');
  for (const rec of audits) {
    if (rec.schema_version === '2') {
      assert.equal(rec.reversibility, 'reversible');
      assert.equal(rec.reversibility_source, 'platform_annotation');
    }
  }
  assert.ok(terminalResult.finalAction);
  assert.equal(terminalResult.finalAction!.action, 'rollback');
});

test('integration 2: forward_only deploy → final_action is pause_and_alarm', () => {
  const { classification, terminalResult } = runRollbackDeploy({
    reversibilitySource: new InlineReversibilitySource('forward_only'),
  });
  assert.equal(classification?.reversibility, 'forward_only');
  assert.equal(classification?.reversibility_source, 'platform_annotation');
  assert.equal(terminalResult.finalAction!.action, 'pause_and_alarm');
  assert.match(
    (terminalResult.finalAction as { reason: string }).reason,
    /forward_only/,
  );
});

test('integration 3: conditional deploy → final_action is human_confirmation_required', () => {
  const { classification, terminalResult } = runRollbackDeploy({
    reversibilitySource: new InlineReversibilitySource('conditional'),
  });
  assert.equal(classification?.reversibility, 'conditional');
  assert.equal(terminalResult.finalAction!.action, 'human_confirmation_required');
});

test('integration 4: default-fallback deploy (no source) → forward_only / default_fallback + pause_and_alarm', () => {
  const { audits, classification, terminalResult } = runRollbackDeploy({});
  assert.equal(classification?.reversibility, 'forward_only', 'architect-set default');
  assert.equal(classification?.reversibility_source, 'default_fallback');
  for (const rec of audits) {
    if (rec.schema_version === '2') {
      assert.equal(rec.reversibility, 'forward_only');
      assert.equal(rec.reversibility_source, 'default_fallback');
    }
  }
  // Same translator action as annotated forward_only, but audit source differs.
  assert.equal(terminalResult.finalAction!.action, 'pause_and_alarm');
});

// ────────────────────────────────────────────────────────────────────
// Constancy + non-rollback paths + backward compat.
// ────────────────────────────────────────────────────────────────────

test('integration 5: clean deploy — reversibility fields populate; no rollback; final_action passes through', () => {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const ticks = 5;
  let classification: ReversibilityClassification | undefined;
  let lastResult: ReturnType<typeof orchestrate> | undefined;
  for (let i = 0; i < ticks; i++) {
    const live = makeLive();
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * 0.25,
      trendBuffer: tb, tick: i, totalTicks: ticks,
      deployId: 'clean-annotated',
      fusionTopology: 'portfolio',
      reversibilitySource: new InlineReversibilitySource('reversible'),
      reversibilityClassification: classification,
    };
    const result = orchestrate(params);
    classification = result.reversibilityClassification;
    lastResult = result;
    // Reversibility fields must be constant across ticks (deploy-level property).
    assert.equal(result.reversibilityClassification!.reversibility, 'reversible');
    assert.equal(result.reversibilityClassification!.reversibility_source, 'platform_annotation');
    // Non-rollback verdict → finalAction passes through.
    assert.notEqual(result.finalAction!.action, 'rollback');
    assert.notEqual(result.finalAction!.action, 'pause_and_alarm');
  }
  assert.ok(lastResult);
});

test('integration 6: scenario-keyed source threads per-deploy annotations correctly', () => {
  const source = new ScenarioReversibilitySource({
    'deploy-a': 'reversible',
    'deploy-b': 'conditional',
    // deploy-c intentionally omitted → default_fallback applies.
  });
  const a = runRollbackDeploy({ reversibilitySource: source, deployId: 'deploy-a' });
  const b = runRollbackDeploy({ reversibilitySource: source, deployId: 'deploy-b' });
  const c = runRollbackDeploy({ reversibilitySource: source, deployId: 'deploy-c' });
  assert.equal(a.classification?.reversibility, 'reversible');
  assert.equal(a.classification?.reversibility_source, 'platform_annotation');
  assert.equal(b.classification?.reversibility, 'conditional');
  assert.equal(b.classification?.reversibility_source, 'platform_annotation');
  assert.equal(c.classification?.reversibility, 'forward_only');
  assert.equal(c.classification?.reversibility_source, 'default_fallback');
  assert.equal(a.terminalResult.finalAction!.action, 'rollback');
  assert.equal(b.terminalResult.finalAction!.action, 'human_confirmation_required');
  assert.equal(c.terminalResult.finalAction!.action, 'pause_and_alarm');
});

test('integration 7: backward compat — deploys without reversibilitySource emit populated audit fields', () => {
  // Pre-#5 behavior: caller passes no source at all; engine must still
  // produce valid values (not null/null) on v2 records and a sensible
  // finalAction on the terminal verdict. Architect-set defaults apply.
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const live = makeLive({ downstream_err: 0.005 });
  for (const k of Object.keys(live)) tb.push(k, live[k]);
  const params: OrchestrateParams = {
    liveMetrics: live, scenario: sc,
    hoursElapsed: 0,
    trendBuffer: tb, tick: 0, totalTicks: 1,
    deployId: 'no-source',
    fusionTopology: 'portfolio',
  };
  const result = orchestrate(params);
  const rec = buildAuditRecord(params, result, { service: 'bc-test' }) as AuditRecordV2;
  assert.equal(rec.schema_version, '2');
  assert.equal(rec.reversibility, 'forward_only');
  assert.equal(rec.reversibility_source, 'default_fallback');
  assert.ok(result.finalAction);
});

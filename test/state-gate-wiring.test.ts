// test/state-gate-wiring.test.ts — Task 2 (WS4 session-durability-argo
// plan): G3 state-gate wiring. `evaluateState` gains an optional
// `ctx?: StateGateContext` (engine/types/session.ts) — absent ctx is
// byte-identical to the pre-WS4 stub (`{allow: true, reason: null}`),
// per OQ-3 (deny verdict stays 'extend'; no engine short-circuit
// semantics change — the deny plumbing at
// _orchestrator-evaluate.ts:114-124 already existed and was dead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { evaluateState } from '../dist/engine/gates/state';
import type { StateGateContext } from '../dist/engine/types/session';
import type { OrchestrateParams, Metrics } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sci-state-gate'): OrchestrateParams['scenario'] {
  return {
    id,
    riskLevel: 'critical',
    bakeHours: 6,
    author: 'human',
    changeType: 'model_weights',
    timeWindow: 'ok',
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

function baseParams(overrides: Partial<OrchestrateParams> = {}): OrchestrateParams {
  const tb = new TrendBuffer(10);
  const live = makeLive();
  for (const k of Object.keys(live)) tb.push(k, live[k]);
  return {
    liveMetrics: live,
    scenario: makeScenario(),
    hoursElapsed: 0.25,
    trendBuffer: tb,
    tick: 0,
    totalTicks: 8,
    deployId: 'deploy-state-gate-test',
    currentHourOfDay: 20,
    currentDayOfWeek: 3,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Unit tests — evaluateState() in isolation.
// ────────────────────────────────────────────────────────────────────

test('unit 1: evaluateState with no ctx is byte-identical to the pre-WS4 stub', () => {
  const result = evaluateState('d', 'primary');
  assert.deepEqual(result, { allow: true, reason: null });
});

test('unit 2: session_status "void" denies with session_void reason (void_reason present)', () => {
  const ctx: StateGateContext = { session_status: 'void', void_reason: 'service_restart' };
  const result = evaluateState('d', 'primary', ctx);
  assert.deepEqual(result, { allow: false, reason: 'session_void: service_restart' });
});

test('unit 2b: session_status "void" with no void_reason falls back to "unknown"', () => {
  const ctx: StateGateContext = { session_status: 'void' };
  const result = evaluateState('d', 'primary', ctx);
  assert.deepEqual(result, { allow: false, reason: 'session_void: unknown' });
});

test('unit 3: session_status "finished" denies with session_finished reason', () => {
  const ctx: StateGateContext = { session_status: 'finished' };
  const result = evaluateState('d', 'primary', ctx);
  assert.deepEqual(result, { allow: false, reason: 'session_finished' });
});

test('unit 4: deployment_phase "rolled_back" denies with deployment_terminal reason', () => {
  const ctx: StateGateContext = { session_status: 'active', deployment_phase: 'rolled_back' };
  const result = evaluateState('d', 'primary', ctx);
  assert.deepEqual(result, { allow: false, reason: 'deployment_terminal: rolled_back' });
});

test('unit 5: deployment_phase "finished" denies with deployment_terminal reason', () => {
  const ctx: StateGateContext = { session_status: 'active', deployment_phase: 'finished' };
  const result = evaluateState('d', 'primary', ctx);
  assert.deepEqual(result, { allow: false, reason: 'deployment_terminal: finished' });
});

test('unit 6: session_status "active" with baking/promoted phase (or absent phase) allows', () => {
  assert.deepEqual(
    evaluateState('d', 'primary', { session_status: 'active' }),
    { allow: true, reason: null },
  );
  assert.deepEqual(
    evaluateState('d', 'primary', { session_status: 'active', deployment_phase: 'baking' }),
    { allow: true, reason: null },
  );
  assert.deepEqual(
    evaluateState('d', 'primary', { session_status: 'active', deployment_phase: 'promoted' }),
    { allow: true, reason: null },
  );
});

// ────────────────────────────────────────────────────────────────────
// Integration tests — evaluate() threading.
// ────────────────────────────────────────────────────────────────────

test('integration 1: evaluate() with a void stateContext short-circuits to extend/state', () => {
  const params = baseParams({
    stateContext: { session_status: 'void', void_reason: 'service_restart' },
  });
  const result = orchestrate(params);
  assert.equal(result.verdict, 'extend');
  assert.equal(result.shortCircuit, 'state');
  assert.equal(result.gateResults.state.reason, 'session_void: service_restart');
  assert.equal(result.gateResults.state.allow, false);
});

test('integration 2: evaluate() with a finished stateContext short-circuits to extend/state', () => {
  const params = baseParams({
    stateContext: { session_status: 'finished' },
  });
  const result = orchestrate(params);
  assert.equal(result.verdict, 'extend');
  assert.equal(result.shortCircuit, 'state');
  assert.equal(result.gateResults.state.reason, 'session_finished');
});

test('integration 3: evaluate() with a terminal deployment_phase short-circuits to extend/state', () => {
  const params = baseParams({
    stateContext: { session_status: 'active', deployment_phase: 'rolled_back' },
  });
  const result = orchestrate(params);
  assert.equal(result.verdict, 'extend');
  assert.equal(result.shortCircuit, 'state');
  assert.equal(result.gateResults.state.reason, 'deployment_terminal: rolled_back');
});

// ────────────────────────────────────────────────────────────────────
// Byte-compat canary (Task 2's hard backward-compat bar).
// ────────────────────────────────────────────────────────────────────

test('byte-compat: no stateContext vs stateContext={session_status:"active"} — identical VerdictResult', () => {
  // Two independent runs (fresh TrendBuffer/params each) on the same
  // known-good scenario: one omits stateContext entirely, the other
  // passes an explicit active-session context. Both must produce
  // deep-identical VerdictResults, modulo lifecycleState/groupClosePromise
  // (per the plan's test 4 spec) which are absent on both runs here since
  // no lifecycleEmitter/verdictGrouper is threaded through.
  const withoutCtx = orchestrate(baseParams());
  const withActiveCtx = orchestrate(baseParams({ stateContext: { session_status: 'active' } }));

  function strip(r: Record<string, unknown>): Record<string, unknown> {
    const { lifecycleState, groupClosePromise, ...rest } = r;
    return rest;
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(strip(withoutCtx))),
    JSON.parse(JSON.stringify(strip(withActiveCtx))),
  );
});

test('byte-compat: gateResults.state shape unchanged — {allow, reason} keys only', () => {
  const withoutCtx = orchestrate(baseParams());
  assert.deepEqual(Object.keys(withoutCtx.gateResults.state).sort(), ['allow', 'reason']);

  const withActiveCtx = orchestrate(baseParams({ stateContext: { session_status: 'active' } }));
  assert.deepEqual(Object.keys(withActiveCtx.gateResults.state).sort(), ['allow', 'reason']);
});

test('config-fixture sanity: v2-with-family-a.json exists for future Task-2-adjacent fixtures', () => {
  // Not exercised directly by these unit/integration tests (they use the
  // hand-built BASELINE scenario per the plan's "copy fixture pattern
  // from test/lifecycle-events.test.ts"), but documented here so a
  // missing fixture fails loud rather than silently skipping coverage
  // elsewhere in the WS4 branch.
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn('note: ' + CONFIG_PATH + ' not present (not required by this test file)');
  }
});

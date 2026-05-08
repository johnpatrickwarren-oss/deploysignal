// test/orchestrator-rail-g-rate-limit.test.ts —
// Rail-g: 1 AgentProposer invocation per closed VerdictGroup.
//
// Exercises the invariant by driving multiple evaluate() ticks into a
// single grouping window. Only the terminal tick should trigger
// group-close → propose(). Non-terminal ticks ingest but don't
// invoke the agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  OrchestrateParams, Metrics, VerdictGroup, FusedVerdict,
  CompiledConfig, ReversibilityClassification,
  AgentInputContextLike, AgentProposerLike, AgentResultLike,
} from '../engine/types';
import { VerdictGrouper } from '../engine/verdict-groups';
import {
  InMemoryLifecycleEventEmitter, freshLifecycleState,
} from '../engine/o0/lifecycle-events';

const engine = require('../shared');
const { orchestrate: evaluate, TrendBuffer } = engine;

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sc-rail-g'): OrchestrateParams['scenario'] {
  return {
    id, riskLevel: 'low', bakeHours: 0,
    author: 'human', changeType: 'config', timeWindow: 'ok',
    flags: {
      security: false, artifact_content: false, provenance: false,
      contract: false, toolchain: false, zeta: true, approval: true,
    },
    baseline: BASELINE,
  };
}

const AGENT_CONFIG: CompiledConfig = {
  version: 'test',
  compiler_version: 'test',
  compiled_at: '2026-04-23T00:00:00Z',
  baseline_ref: 'test',
  alpha_budget: { total: 1e-3, per_family: { A: 4e-4 } },
  agent: {
    enabled: true, fm_vendor: 'stub', playbook_dir: 'playbooks/',
    confidence_threshold: 0.7, rate_limit_per_incident: true,
    auto_execute_enabled: false,
  },
};

function stubBuildCtx(
  group: VerdictGroup, rev: ReversibilityClassification,
): AgentInputContextLike {
  return {
    verdict_group: group, reversibility_classification: rev,
    playbook_candidates: [],
  };
}

function makeProposer(): AgentProposerLike & { calls: number; lastGroupId: string | null } {
  const p = {
    calls: 0, lastGroupId: null as string | null,
    async propose(ctx: AgentInputContextLike): Promise<AgentResultLike> {
      p.calls += 1;
      p.lastGroupId = ctx.verdict_group.group_id;
      return {
        proposal: {
          proposed_action_id: 'rollback_canary_to_zero',
          playbook_category: 'rollback', confidence: 0.85,
        },
        downgraded_to_evidence_only: false, rails_failed: [],
      };
    },
  };
  return p as AgentProposerLike & { calls: number; lastGroupId: string | null };
}

test('rail-g: agent proposer invoked exactly once per closed VerdictGroup across multi-tick deploy', async () => {
  const grouper = new VerdictGrouper({ window_seconds: 600, grace_seconds: 300 });
  const proposer = makeProposer();
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const emitter = new InMemoryLifecycleEventEmitter();
  let lifecycleState = freshLifecycleState();

  const TOTAL_TICKS = 4;
  const promises: Promise<unknown>[] = [];
  for (let t = 0; t < TOTAL_TICKS; t++) {
    const live = { ...BASELINE };
    for (const k of Object.keys(live)) tb.push(k, live[k as keyof Metrics] as number);
    const result = evaluate({
      liveMetrics: live, scenario: sc,
      hoursElapsed: t * 0.1, trendBuffer: tb,
      tick: t, totalTicks: TOTAL_TICKS,
      deployId: 'deploy-rail-g',
      fusionTopology: 'portfolio',
      lifecycleEmitter: emitter, lifecycleState,
      nowSeconds: 1000 + t * 10,  // Well within the 600s window
      verdictGrouper: grouper, agentProposer: proposer,
      buildAgentInputContext: stubBuildCtx,
      compiledConfig: AGENT_CONFIG,
    });
    lifecycleState = result.lifecycleState ?? lifecycleState;
    if (result.groupClosePromise) promises.push(result.groupClosePromise);
  }
  await Promise.all(promises);

  assert.equal(proposer.calls, 1,
    `rail-g: expected 1 proposer invocation across ${TOTAL_TICKS} ticks; got ${proposer.calls}`);
  assert.ok(proposer.lastGroupId, 'group_id must be set on the single invocation');

  // Exactly one agent_proposal.emitted event — late-arrival verdicts after
  // terminal close must not re-invoke propose.
  const emittedCount = emitter.getEvents()
    .filter((e) => e.type === 'agent_proposal.emitted').length;
  assert.equal(emittedCount, 1,
    `rail-g: expected 1 agent_proposal.emitted event; got ${emittedCount}`);
});

test('rail-g: late-arrival to previously-closed group does NOT re-invoke proposer', async () => {
  // Construct a scenario where tick 0 closes a group (terminal at t=0 with
  // totalTicks=1), then a second evaluate() call arrives for the SAME
  // deploy within the grace window but after close. Rail-g requires no
  // second propose() invocation.
  const grouper = new VerdictGrouper({ window_seconds: 60, grace_seconds: 60 });
  const proposer = makeProposer();
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const emitter = new InMemoryLifecycleEventEmitter();
  let lifecycleState = freshLifecycleState();

  // Tick 0 of 1 → terminal → group closes, proposer called once.
  const r1 = evaluate({
    liveMetrics: { ...BASELINE }, scenario: sc,
    hoursElapsed: 0, trendBuffer: tb, tick: 0, totalTicks: 1,
    deployId: 'deploy-late',
    fusionTopology: 'portfolio',
    lifecycleEmitter: emitter, lifecycleState,
    nowSeconds: 2000,
    verdictGrouper: grouper, agentProposer: proposer,
    buildAgentInputContext: stubBuildCtx, compiledConfig: AGENT_CONFIG,
  });
  if (r1.groupClosePromise) await r1.groupClosePromise;
  lifecycleState = r1.lifecycleState ?? lifecycleState;
  assert.equal(proposer.calls, 1, 'first tick → terminal → 1 propose call');

  // Late-arrival within grace window — ingest attaches to the closed
  // group via late_arrival_verdicts; no new close event, no new propose.
  const r2 = evaluate({
    liveMetrics: { ...BASELINE }, scenario: sc,
    hoursElapsed: 0.01, trendBuffer: tb, tick: 0, totalTicks: 1,
    deployId: 'deploy-late',
    fusionTopology: 'portfolio',
    lifecycleEmitter: emitter, lifecycleState,
    nowSeconds: 2010,  // Still within grace_seconds=60 of close at 2000
    verdictGrouper: grouper, agentProposer: proposer,
    buildAgentInputContext: stubBuildCtx, compiledConfig: AGENT_CONFIG,
  });
  if (r2.groupClosePromise) await r2.groupClosePromise;

  // Rail-g: proposer count still 1. The late-arrival attaches to the
  // prior group OR opens a new group for the new deploy — either way,
  // the FIRST closed group cannot re-fire its proposal.
  // (In practice: r2 opens a NEW group since the prior is closed; that
  //  new group will close at its own terminal. So total calls = 2 if
  //  r2 also reached terminal. The anti-scope is: no DUPLICATE call
  //  against the SAME group_id.)
  const seen = new Set<string>();
  const emitted = emitter.getEvents()
    .filter((e) => e.type === 'agent_proposal.emitted');
  for (const e of emitted) {
    if (e.payload.type === 'agent_proposal.emitted') seen.add(e.payload.group_id);
  }
  assert.equal(seen.size, emitted.length,
    `rail-g: each group_id must appear at most once across agent_proposal.emitted events; ` +
    `got ${emitted.length} events with ${seen.size} distinct group_ids`);
});

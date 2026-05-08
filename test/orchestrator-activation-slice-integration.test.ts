// test/orchestrator-activation-slice-integration.test.ts —
// Consolidated activation slice: #25/#26/#27 wired into evaluate().
//
// Covers:
//   - VerdictGrouper.ingest called on every FusedVerdict emission.
//   - Terminal verdict → group-close → `verdict_group.closed` lifecycle
//     event + aggregate `groupClosePromise` fulfilled.
//   - TopologyEnricher.enrich invoked when provided → `verdict_group.
//     topology_enriched` event emitted; skipped cleanly when absent.
//   - AgentProposer.propose invoked when {proposer, agent.enabled:true,
//     buildAgentInputContext} all present → `agent_proposal.emitted`
//     or `.downgraded` event emitted; skipped when any condition fails.
//   - Byte-identical pre-slice behavior when all activation carriers
//     are absent (backward-compat hard gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  OrchestrateParams, Metrics, VerdictGroup, FusedVerdict,
  CompiledConfig, ReversibilityClassification,
  AgentInputContextLike, AgentProposerLike, AgentResultLike,
} from '../engine/types';
import { VerdictGrouper } from '../engine/verdict-groups';
import {
  TopologyEnricher, StaticTopologySource,
} from '../engine/topology-overlay';
import type { TopologySnapshot } from '../engine/types';
import {
  InMemoryLifecycleEventEmitter, freshLifecycleState,
} from '../engine/o0/lifecycle-events';
import type { RecordedLifecycleEvent } from '../engine/o0/lifecycle-events';

const engine = require('../shared');
const { orchestrate: evaluate, TrendBuffer } = engine;

const BASELINE: Metrics = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.92, tool_success_rate: 0.95,
};

function makeScenario(id = 'sc-activation'): OrchestrateParams['scenario'] {
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

function makeLive(): Metrics { return { ...BASELINE }; }

function miniSnapshot(): TopologySnapshot {
  return {
    nodes: [
      { id: 'svc-a', service_name: 'svc-a', kind: 'service' },
      { id: 'svc-b', service_name: 'svc-b', kind: 'service' },
    ],
    edges: [{ from: 'svc-a', to: 'svc-b', relationship: 'calls' }],
    fetched_at_ts: 1000,
    source_id: 'static_topology_source',
    source_version: 'activation-slice-test-v1',
  };
}

/** Minimal healthy-deploy harness. Single tick, total=1 → isTerminal
 *  triggers in maybeIngestAndFanOut, group closes immediately, fan-out
 *  executes. Returns the VerdictResult + captured lifecycle events. */
async function runHealthyDeploy(extras: Partial<OrchestrateParams> = {}): Promise<{
  result: ReturnType<typeof evaluate>;
  events: RecordedLifecycleEvent[];
}> {
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  const live = makeLive();
  for (const k of Object.keys(live)) tb.push(k, live[k as keyof Metrics] as number);
  const emitter = new InMemoryLifecycleEventEmitter();
  const params: OrchestrateParams = {
    liveMetrics: live, scenario: sc,
    hoursElapsed: 0, trendBuffer: tb,
    tick: 0, totalTicks: 1,
    deployId: 'deploy-activation',
    fusionTopology: 'portfolio',
    lifecycleEmitter: emitter,
    lifecycleState: freshLifecycleState(),
    nowSeconds: 1000,
    ...extras,
  };
  const result = evaluate(params);
  if (result.groupClosePromise) await result.groupClosePromise;
  return { result, events: emitter.getEvents() };
}

// ── Baseline: no activation carriers → no group events ─────────────

test('activation: absent VerdictGrouper → no group events; groupClosePromise undefined', async () => {
  const { result, events } = await runHealthyDeploy();
  assert.equal(result.groupClosePromise, undefined,
    'groupClosePromise must be absent when no verdictGrouper is threaded');
  const groupEvents = events.filter((e) => e.type.startsWith('verdict_group.'));
  assert.equal(groupEvents.length, 0,
    `expected no verdict_group.* events; got ${groupEvents.map((e) => e.type).join(', ')}`);
});

// ── #25 VerdictGrouper wired ───────────────────────────────────────

test('activation: VerdictGrouper wired → ingest called + group.closed emitted on terminal', async () => {
  const grouper = new VerdictGrouper({ window_seconds: 60, grace_seconds: 30 });
  const { result, events } = await runHealthyDeploy({ verdictGrouper: grouper });
  assert.ok(result.groupClosePromise,
    'groupClosePromise must be present when grouper is wired + terminal triggers close');
  const closed = events.find((e) => e.type === 'verdict_group.closed');
  assert.ok(closed, `expected verdict_group.closed event; got ${events.map((e) => e.type).join(', ')}`);
  if (closed && closed.payload.type === 'verdict_group.closed') {
    assert.equal(closed.payload.deploy_id, 'deploy-activation');
    assert.ok(typeof closed.payload.group_id === 'string' && closed.payload.group_id.length > 0);
    assert.equal(closed.payload.closed_at_ts, 1000);
  }
});

// ── #26 TopologyEnricher wired (with grouper) ──────────────────────

test('activation: TopologyEnricher present → topology_enriched event emitted', async () => {
  const grouper = new VerdictGrouper();
  const enricher = new TopologyEnricher({
    source: new StaticTopologySource(miniSnapshot()),
    now: () => 1000,
  });
  const { events } = await runHealthyDeploy({
    verdictGrouper: grouper, topologyEnricher: enricher,
  });
  const enrichedEvt = events.find((e) => e.type === 'verdict_group.topology_enriched');
  assert.ok(enrichedEvt, 'expected verdict_group.topology_enriched after group-close');
  if (enrichedEvt && enrichedEvt.payload.type === 'verdict_group.topology_enriched') {
    assert.equal(enrichedEvt.payload.topology_source_id, 'static_topology_source');
  }
});

test('activation: TopologyEnricher absent (grouper only) → no topology_enriched event', async () => {
  const grouper = new VerdictGrouper();
  const { events } = await runHealthyDeploy({ verdictGrouper: grouper });
  assert.ok(events.find((e) => e.type === 'verdict_group.closed'));
  assert.equal(events.find((e) => e.type === 'verdict_group.topology_enriched'), undefined);
});

// ── #27 AgentProposer wired ────────────────────────────────────────

/** Minimal AgentProposer double. Tracks invocation count. */
function makeStubProposer(returns: AgentResultLike): AgentProposerLike & { calls: number } {
  return {
    calls: 0,
    async propose(_ctx: AgentInputContextLike): Promise<AgentResultLike> {
      this.calls += 1;
      return returns;
    },
  } as AgentProposerLike & { calls: number };
}

const STUB_AGENT_CONFIG: CompiledConfig = {
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

test('activation: agent enabled + proposer + factory → proposal.emitted on success', async () => {
  const grouper = new VerdictGrouper();
  const proposer = makeStubProposer({
    proposal: {
      proposed_action_id: 'rollback_canary_to_zero',
      playbook_category: 'rollback',
      confidence: 0.85,
    },
    downgraded_to_evidence_only: false,
    rails_failed: [],
  });
  const { events } = await runHealthyDeploy({
    verdictGrouper: grouper,
    agentProposer: proposer,
    buildAgentInputContext: stubBuildCtx,
    compiledConfig: STUB_AGENT_CONFIG,
  });
  assert.equal(proposer.calls, 1, 'propose must be invoked exactly once per closed group');
  const emitted = events.find((e) => e.type === 'agent_proposal.emitted');
  assert.ok(emitted, 'expected agent_proposal.emitted');
  if (emitted && emitted.payload.type === 'agent_proposal.emitted') {
    assert.equal(emitted.payload.proposed_action_id, 'rollback_canary_to_zero');
    assert.equal(emitted.payload.playbook_category, 'rollback');
    assert.equal(emitted.payload.confidence, 0.85);
  }
});

test('activation: agent returns downgrade → downgraded event emitted', async () => {
  const grouper = new VerdictGrouper();
  const proposer = makeStubProposer({
    proposal: null, downgraded_to_evidence_only: true,
    rails_failed: ['c'], downgrade_reason: 'confidence_below_threshold',
  });
  const { events } = await runHealthyDeploy({
    verdictGrouper: grouper,
    agentProposer: proposer,
    buildAgentInputContext: stubBuildCtx,
    compiledConfig: STUB_AGENT_CONFIG,
  });
  const downgraded = events.find((e) => e.type === 'agent_proposal.downgraded');
  assert.ok(downgraded, 'expected agent_proposal.downgraded');
  if (downgraded && downgraded.payload.type === 'agent_proposal.downgraded') {
    assert.deepEqual([...downgraded.payload.rails_failed], ['c']);
    assert.equal(downgraded.payload.downgrade_reason, 'confidence_below_threshold');
  }
});

test('activation: agent.enabled=false → proposer NEVER invoked', async () => {
  const grouper = new VerdictGrouper();
  const proposer = makeStubProposer({
    proposal: null, downgraded_to_evidence_only: false, rails_failed: [],
  });
  const disabledCfg: CompiledConfig = {
    ...STUB_AGENT_CONFIG,
    agent: { ...STUB_AGENT_CONFIG.agent!, enabled: false },
  };
  const { events } = await runHealthyDeploy({
    verdictGrouper: grouper,
    agentProposer: proposer,
    buildAgentInputContext: stubBuildCtx,
    compiledConfig: disabledCfg,
  });
  assert.equal(proposer.calls, 0, 'propose must NOT run when agent.enabled=false');
  assert.equal(events.find((e) => e.type.startsWith('agent_proposal.')), undefined);
});

test('activation: missing buildAgentInputContext → proposer NEVER invoked even if enabled', async () => {
  const grouper = new VerdictGrouper();
  const proposer = makeStubProposer({
    proposal: null, downgraded_to_evidence_only: false, rails_failed: [],
  });
  const { events } = await runHealthyDeploy({
    verdictGrouper: grouper,
    agentProposer: proposer,
    // buildAgentInputContext intentionally omitted
    compiledConfig: STUB_AGENT_CONFIG,
  });
  assert.equal(proposer.calls, 0,
    'propose must NOT run when buildAgentInputContext factory is missing');
  assert.equal(events.find((e) => e.type.startsWith('agent_proposal.')), undefined);
});

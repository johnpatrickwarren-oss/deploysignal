// test/orchestrator-parallel-fanout.test.ts —
// Topology + Agent fan-out legs run in parallel (Promise.all), not
// serially. Total wall-time for a group-close should approximate
// max(topology_ms, agent_ms) rather than their sum.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  OrchestrateParams, Metrics, VerdictGroup, ReversibilityClassification,
  CompiledConfig, AgentInputContextLike, AgentProposerLike, AgentResultLike,
  TopologySnapshot,
} from '../engine/types';
import { VerdictGrouper } from '../engine/verdict-groups';
import { TopologyEnricher } from '../engine/topology-overlay';
import type { TopologySource } from '../engine/topology-overlay';
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

function makeScenario(): OrchestrateParams['scenario'] {
  return {
    id: 'sc-parallel', riskLevel: 'low', bakeHours: 0,
    author: 'human', changeType: 'config', timeWindow: 'ok',
    flags: {
      security: false, artifact_content: false, provenance: false,
      contract: false, toolchain: false, zeta: true, approval: true,
    },
    baseline: BASELINE,
  };
}

/** A TopologySource that takes LATENCY_MS ms to return its snapshot. */
class SlowTopologySource implements TopologySource {
  readonly id = 'slow_source';
  readonly version = 'v1';
  constructor(private readonly latencyMs: number) {}
  async fetchSnapshot(): Promise<TopologySnapshot> {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return {
      nodes: [{ id: 'n1', service_name: 'n1', kind: 'service' }],
      edges: [], fetched_at_ts: 1, source_id: this.id, source_version: this.version,
    };
  }
  snapshotHash(_s: TopologySnapshot): string { return 'h'; }
}

const AGENT_CONFIG: CompiledConfig = {
  version: 'test', compiler_version: 'test',
  compiled_at: '2026-04-23T00:00:00Z', baseline_ref: 'test',
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

/** AgentProposer that takes LATENCY_MS ms to propose. */
function slowProposer(latencyMs: number): AgentProposerLike {
  return {
    async propose(_ctx: AgentInputContextLike): Promise<AgentResultLike> {
      await new Promise((r) => setTimeout(r, latencyMs));
      return {
        proposal: {
          proposed_action_id: 'rollback_canary_to_zero',
          playbook_category: 'rollback', confidence: 0.85,
        },
        downgraded_to_evidence_only: false, rails_failed: [],
      };
    },
  };
}

test('fan-out: topology + agent legs run in parallel (wall-time ≈ max, not sum)', async () => {
  const LATENCY_MS = 120;
  const grouper = new VerdictGrouper();
  const enricher = new TopologyEnricher({
    source: new SlowTopologySource(LATENCY_MS),
    now: () => 1000,
  });
  const proposer = slowProposer(LATENCY_MS);
  const sc = makeScenario();
  const tb = new TrendBuffer(10);
  for (const k of Object.keys(BASELINE)) tb.push(k, BASELINE[k as keyof Metrics] as number);
  const emitter = new InMemoryLifecycleEventEmitter();

  const t0 = Date.now();
  const result = evaluate({
    liveMetrics: { ...BASELINE }, scenario: sc,
    hoursElapsed: 0, trendBuffer: tb,
    tick: 0, totalTicks: 1,
    deployId: 'deploy-parallel',
    fusionTopology: 'portfolio',
    lifecycleEmitter: emitter, lifecycleState: freshLifecycleState(),
    nowSeconds: 1000,
    verdictGrouper: grouper, topologyEnricher: enricher,
    agentProposer: proposer, buildAgentInputContext: stubBuildCtx,
    compiledConfig: AGENT_CONFIG,
  });
  assert.ok(result.groupClosePromise, 'group close should trigger on terminal tick');
  await result.groupClosePromise;
  const elapsed = Date.now() - t0;

  // Serial execution ≈ 2 × LATENCY_MS; parallel ≈ 1 × LATENCY_MS.
  // Allow generous slack for node scheduling + test overhead (150% of
  // single leg). 2× would definitely fail this bound.
  const upperBound = Math.floor(LATENCY_MS * 1.8);
  assert.ok(elapsed < upperBound,
    `expected parallel fan-out (~${LATENCY_MS}ms); serial would be ~${2 * LATENCY_MS}ms; ` +
    `observed ${elapsed}ms (bound ${upperBound}ms)`);

  // Both legs completed successfully.
  assert.ok(emitter.getEvents().find((e) => e.type === 'verdict_group.topology_enriched'),
    'topology leg must have completed');
  assert.ok(emitter.getEvents().find((e) => e.type === 'agent_proposal.emitted'),
    'agent leg must have completed');
});

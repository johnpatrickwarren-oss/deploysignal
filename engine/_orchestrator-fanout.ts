// engine/_orchestrator-fanout.ts — post-L3 grouping + parallel fan-out.
// Extracted verbatim from engine/orchestrator.ts (god-file split). The
// activation slice: VerdictGrouper.ingest + TopologyEnricher/AgentProposer
// fan-out. Orchestrator-internal; not part of the public facade surface.

import { safeEmit } from './o0/lifecycle-events';
import type { LifecycleEventEmitter } from './o0/lifecycle-events';
import type {
  OrchestrateParams, ReversibilityClassification,
  GroupCloseFanoutResult, VerdictGroup, FusedVerdict, AgentResultLike,
} from './types';

/** Count distinct firing families across the group's verdicts. Used by
 *  the verdict_group.closed lifecycle payload. */
function _countFiringFamilies(group: VerdictGroup): number {
  const set = new Set<string>();
  for (const v of group.firing_verdicts) {
    for (const f of v.firing_families) set.add(f);
  }
  return set.size;
}

// Topology-enrichment leg of the fan-out. Emits verdict_group.topology_enriched
// on success and folds an enrichment error into the aggregate shape. Resolves
// to an empty partial when no enricher is wired.
function runTopologyLeg(
  params: OrchestrateParams,
  deployId: string,
  lifecycleEmitter: LifecycleEventEmitter,
  closed: VerdictGroup,
): Promise<Partial<GroupCloseFanoutResult>> {
  return params.topologyEnricher
    ? params.topologyEnricher.enrich(closed).then(
        (enriched) => {
          safeEmit(lifecycleEmitter, 'verdict_group.topology_enriched', {
            type: 'verdict_group.topology_enriched',
            deploy_id: deployId,
            group_id: enriched.group_id,
            topology_source_id: enriched.topology_source_id,
            topology_snapshot_hash: enriched.topology_snapshot_hash,
            candidate_count: enriched.candidates.length,
            ...(enriched.enrichment_error
              ? { enrichment_error: enriched.enrichment_error }
              : {}),
          });
          return { enriched };
        },
        (err: unknown) => ({
          enrichment_error: err instanceof Error ? err.message : String(err),
        }),
      )
    : Promise.resolve({});
}

// Agent-proposal leg of the fan-out. Gated on the proposer + compiled-config
// flag + context builder. Emits agent_proposal.emitted / .downgraded and
// folds an agent error into the aggregate shape.
function runAgentLeg(
  params: OrchestrateParams,
  deployId: string,
  lifecycleEmitter: LifecycleEventEmitter,
  reversibility: ReversibilityClassification,
  closed: VerdictGroup,
): Promise<Partial<GroupCloseFanoutResult>> {
  const agentEnabled =
    params.agentProposer !== undefined &&
    params.compiledConfig?.agent?.enabled === true &&
    params.buildAgentInputContext !== undefined;
  return agentEnabled
    ? (async () => {
        const ctx = params.buildAgentInputContext!(closed, reversibility);
        const result: AgentResultLike = await params.agentProposer!.propose(ctx);
        if (result.proposal) {
          safeEmit(lifecycleEmitter, 'agent_proposal.emitted', {
            type: 'agent_proposal.emitted',
            deploy_id: deployId,
            group_id: closed.group_id,
            proposed_action_id: result.proposal.proposed_action_id,
            playbook_category: result.proposal.playbook_category,
            confidence: result.proposal.confidence,
          });
        } else {
          safeEmit(lifecycleEmitter, 'agent_proposal.downgraded', {
            type: 'agent_proposal.downgraded',
            deploy_id: deployId,
            group_id: closed.group_id,
            rails_failed: [...result.rails_failed],
            ...(result.downgrade_reason ? { downgrade_reason: result.downgrade_reason } : {}),
          });
        }
        return { agent: result } satisfies Partial<GroupCloseFanoutResult>;
      })().catch((err: unknown) => ({
        agent_error: err instanceof Error ? err.message : String(err),
      }))
    : Promise.resolve({});
}

/** Post-L3 grouping + parallel fan-out. Returns the aggregate Promise
 *  only when a group closed on this tick; `undefined` otherwise.
 *  Absence of `verdictGrouper` on `params` short-circuits to `undefined`
 *  → backward-compatible byte-identical behavior for callers who don't
 *  opt into activation. */
export function maybeIngestAndFanOut(
  params: OrchestrateParams,
  deployId: string,
  lifecycleEmitter: LifecycleEventEmitter,
  reversibility: ReversibilityClassification,
  fused: FusedVerdict,
  tick: number,
  total: number,
): Promise<GroupCloseFanoutResult> | undefined {
  const grouper = params.verdictGrouper;
  if (!grouper) return undefined;

  const tsSeconds = params.nowSeconds ?? Date.now() / 1000;
  const isTerminal =
    tick === total - 1 ||
    fused.verdict === 'rollback' ||
    fused.verdict === 'proceed';
  const ingestResult = grouper.ingest(fused, tsSeconds, { terminal: isTerminal });

  if (ingestResult.late_arrival) {
    safeEmit(lifecycleEmitter, 'verdict_group.updated', {
      type: 'verdict_group.updated',
      deploy_id: deployId,
      group_id: ingestResult.attributed_group.group_id,
      late_arrival_count: ingestResult.attributed_group.late_arrival_verdicts.length,
      late_arrival_at_ts: tsSeconds,
    });
  }

  const closed = ingestResult.closed;
  if (!closed) return undefined;

  safeEmit(lifecycleEmitter, 'verdict_group.closed', {
    type: 'verdict_group.closed',
    deploy_id: deployId,
    group_id: closed.group_id,
    window_start_ts: closed.window_start_ts,
    window_end_ts: closed.window_end_ts,
    verdict_count: closed.verdicts.length,
    firing_family_count: _countFiringFamilies(closed),
    root_cause_detector_id: closed.root_cause ? `tick_${closed.root_cause.tick}` : null,
    confidence: closed.confidence,
    closed_at_ts: closed.closed_at_ts,
  });

  // Parallel fan-out. Each leg emits its own lifecycle event on
  // resolution and folds errors into the aggregate result shape.
  const topoLeg = runTopologyLeg(params, deployId, lifecycleEmitter, closed);
  const agentLeg = runAgentLeg(params, deployId, lifecycleEmitter, reversibility, closed);

  return Promise.all([topoLeg, agentLeg]).then(([topo, ag]) => ({
    group_id: closed.group_id,
    ...topo,
    ...ag,
  }));
}

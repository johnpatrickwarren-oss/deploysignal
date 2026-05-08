// engine/orchestrator.ts — five-gate orchestrator.
// Sequence: G4 (blast radius) → G2 (policy) → G5 (approval) → G3 (state) → G1 (health).
// Each gate may short-circuit and emit a verdict via the audit writer.

import { classifyRisk } from './gates/blast_radius';
import {
  evaluatePolicy, evaluateTrafficAllocation,
  classifyFailFast, classifyIgnoredSignals,
} from './gates/policy';
import { evaluateApproval } from './gates/approval';
import { evaluateState } from './gates/state';
import { evaluateHealth } from './gates/health';
import { computeVerdict } from './core';
import { fuseVerdict } from './verdict';
import { buildAuditRecord } from './audit';
import { NoReversibilitySource } from './o0/reversibility-source';
import { classifyReversibility } from './g0/reversibility-classifier';
import { translateVerdict } from './o0/reversibility-translator';
import {
  NoOpLifecycleEventEmitter, freshLifecycleState, safeEmit,
} from './o0/lifecycle-events';
import type {
  LifecycleEventEmitter, LifecycleDeployState,
} from './o0/lifecycle-events';

import type {
  OrchestrateParams, VerdictResult, GateResults, PolicyContext, AuditWriter, AuditOpts, CompiledConfig,
  FailFastState, ReversibilityClassification, AuditRecord, AuditRecordV2, HealthResult, FamilyId,
  GroupCloseFanoutResult, VerdictGroup, FusedVerdict, AgentResultLike,
} from './types';

// Week-1 NS keystone adapter. Overlays Family B cutoffs from a CompiledConfig
// onto the resolved PolicyContext after policy resolution. Intentionally does
// NOT touch engine/gates/** — the handoff freezes detector logic this week.
// Only threshold values change; detector behavior is otherwise identical.
function applyCompiledConfig(pol: PolicyContext, cfg: CompiledConfig): void {
  const co = cfg.family_B && cfg.family_B.cutoffs;
  if (!co) return;
  const th = pol.thresholds;
  if (co.p99        !== undefined && th.p99)        th.p99        = { ...th.p99,        base: co.p99 };
  if (co.ttft       !== undefined && th.ttft)       th.ttft       = { ...th.ttft,       base: co.ttft };
  if (co.compound   !== undefined && th.compound)   th.compound   = { ...th.compound,   base: co.compound };
  if (co.behavioral !== undefined && th.behavioral) th.behavioral = { ...th.behavioral, base: co.behavioral };
  if (co.cost       !== undefined && th.cost)       th.cost       = { ...th.cost,       base: co.cost };
  if (co.tokens     !== undefined && th.tokens)     th.tokens     = { ...th.tokens,     base: co.tokens };
  if ((co.tok_econ_tok !== undefined || co.tok_econ_cost !== undefined) && th.tok_econ) {
    th.tok_econ = {
      ...th.tok_econ,
      baseTok:  co.tok_econ_tok  !== undefined ? co.tok_econ_tok  : th.tok_econ.baseTok,
      baseCost: co.tok_econ_cost !== undefined ? co.tok_econ_cost : th.tok_econ.baseCost,
    };
  }
  if (co.downstream !== undefined && pol.downstreamRule) {
    pol.downstreamRule = { ...pol.downstreamRule, base: co.downstream };
  }
}

export function evaluate(params: OrchestrateParams): VerdictResult {
  const sc = params.scenario;
  const live = params.liveMetrics;
  const hrs = params.hoursElapsed;
  const tb = params.trendBuffer ?? null;
  const tick = params.tick;
  const total = params.totalTicks;
  const auditWriter: AuditWriter | null = params.auditWriter || null;
  const auditOpts: AuditOpts | null = params.auditOpts || null;
  const gateResults: GateResults = {};

  // Addition #5 (ARCHITECT-REPLY-32): classify reversibility once per
  // deploy at tick 0; thread through subsequent ticks via
  // `params.reversibilityClassification`. When the caller supplies the
  // classification we use it directly; otherwise we classify through
  // the provided source (or NoReversibilitySource → default-fallback).
  // Values stay constant across all ticks — anti-scope rule forbids
  // mid-deploy reclassification. `paramsWithClassification` reuses the
  // object downstream so `buildAuditRecord` picks up the classification.
  // Classification happens BEFORE the #14 triggered emit so the audit
  // record the emit carries has the reversibility fields populated.
  let reversibilityClassification: ReversibilityClassification | undefined =
    params.reversibilityClassification;
  if (!reversibilityClassification) {
    const source = params.reversibilitySource ?? new NoReversibilitySource();
    reversibilityClassification = classifyReversibility(
      params.deployId ?? 'default',
      source,
    );
  }
  const paramsWithClassification: OrchestrateParams =
    params.reversibilityClassification === reversibilityClassification
      ? params
      : { ...params, reversibilityClassification };

  // Addition #14 lifecycle setup. Default to NoOp + fresh state so the
  // rest of the flow can emit unconditionally. When the caller threads
  // a real emitter + state through, emissions flow to subscribers.
  const lifecycleEmitter: LifecycleEventEmitter = params.lifecycleEmitter ?? new NoOpLifecycleEventEmitter();
  const lifecycleState: LifecycleDeployState = params.lifecycleState ?? freshLifecycleState();
  const deployId = params.deployId || 'default';

  // evaluation.triggered fires once, before any gate runs, on the first
  // tick of the deploy. Uses a latch on lifecycleState so re-entry
  // (e.g., sticky fail-fast over subsequent ticks) doesn't re-emit.
  if (tick === 0 && !lifecycleState.triggeredEmitted) {
    safeEmit(lifecycleEmitter, 'evaluation.triggered', {
      type: 'evaluation.triggered',
      deploy_id: deployId,
      service_id: sc.id ?? 'default',
      compiled_config_version: params.compiledConfig?.version ?? 'legacy',
      expected_window_ticks: total,
      risk_tier: sc.riskLevel ?? 'medium',
    });
    lifecycleState.triggeredEmitted = true;
  }

  function _emit(result: VerdictResult): VerdictResult {
    // Addition #5: attach classification + translated action on every
    // result so the caller + audit writer + lifecycle emitter all see
    // populated fields. Translator derives the concrete orchestrator
    // action from the verdict × reversibility pair.
    result.reversibilityClassification = reversibilityClassification;
    result.finalAction = translateVerdict(
      result.verdict,
      reversibilityClassification!.reversibility,
      result.reason,
    );

    // Audit record is built unconditionally when a lifecycle emitter is
    // wired (even in-memory tests want the `evaluation.tick` payload).
    // Fall back to "only when auditWriter is present" when no lifecycle
    // emitter is attached, preserving pre-#14 behavior (no wasted work).
    // `paramsWithClassification` ensures the audit record picks up the
    // reversibility fields even when the caller only supplied a source.
    const wantsRecord = auditWriter !== null || params.lifecycleEmitter !== undefined;
    const record: AuditRecord | AuditRecordV2 | null = wantsRecord
      ? buildAuditRecord(paramsWithClassification, result, auditOpts)
      : null;
    if (auditWriter && record) auditWriter.write(record);

    // Lifecycle emissions. Order within a tick:
    //   started (tick 0 only) → tick → suppressed (on transitions) → finished (terminal).
    if (tick === 0 && !lifecycleState.startedEmitted) {
      emitStarted(lifecycleEmitter, deployId, params, result);
      lifecycleState.startedEmitted = true;
    }
    if (record) {
      safeEmit(lifecycleEmitter, 'evaluation.tick', {
        type: 'evaluation.tick',
        deploy_id: deployId,
        tick,
        audit_record: record,
      });
    }
    emitSuppressionTransitions(lifecycleEmitter, deployId, tick, result.healthResult, lifecycleState);
    if (!lifecycleState.finishedEmitted && isTerminal(result, tick, total)) {
      safeEmit(lifecycleEmitter, 'evaluation.finished', {
        type: 'evaluation.finished',
        deploy_id: deployId,
        final_verdict: result.verdict,
        total_alpha_spent: result.gateResults?.fusion?.total_alpha_spent ?? 0,
        families_summary: summarizeFamilies(result.healthResult),
      });
      lifecycleState.finishedEmitted = true;
    }

    result.lifecycleState = lifecycleState;
    return result;
  }

  const blastResult = classifyRisk({
    riskLevel: sc.riskLevel,
    changeType: sc.changeType,
    author: sc.author,
    filePaths: sc.filePaths || null,
  });
  gateResults.blastRadius = blastResult;
  const effectiveRisk = blastResult.riskLevel;

  const policyResult = evaluatePolicy({
    riskLevel: effectiveRisk,
    changeType: sc.changeType,
    author: sc.author,
    timeWindow: sc.timeWindow,
  }, hrs);
  gateResults.policy = policyResult;
  if (!policyResult.allow) {
    return _emit({
      verdict: 'rollback',
      reason: policyResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'policy',
    });
  }

  const policyCtx: PolicyContext = policyResult.policyContext as PolicyContext;
  policyCtx._tick = tick;
  if (params.compiledConfig) applyCompiledConfig(policyCtx, params.compiledConfig);

  const approvalResult = evaluateApproval({
    riskLevel: effectiveRisk,
    author: sc.author,
    flags: sc.flags || {},
  });
  gateResults.approval = approvalResult;
  if (!approvalResult.approved) {
    return _emit({
      verdict: 'extend',
      reason: approvalResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'approval',
    });
  }

  const stateResult = evaluateState(params.deployId || 'default', params.targetCloud || 'primary');
  gateResults.state = stateResult;
  if (!stateResult.allow) {
    return _emit({
      verdict: 'extend',
      reason: stateResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'state',
    });
  }

  // Week 6+ Addition #10 (SRM check). Consult the L0 traffic-allocation
  // continuity classification for the current tick. When 'breaking', all
  // detector families suppress because the comparison population is invalid
  // — short-circuit with verdict=rollback, shortCircuit='srm', and the
  // canonical reason string. Health gate never runs; v2 family blocks stay
  // absent (clean default) in the audit record.
  const srmDecision = evaluateTrafficAllocation(
    params.trafficAllocationContinuity,
    live.traffic_pct,
    params.expectedCanaryWeight,
  );
  if (srmDecision.shortCircuit) {
    return _emit({
      verdict: 'rollback',
      reason: srmDecision.reason,
      gateResults,
      healthResult: null,
      shortCircuit: 'srm',
      policyCtx,
    });
  }

  // Week 6+ Addition #13 (fail-fast / ignore thresholds). Fail-fast
  // evaluated first: if any observed signal crosses its absolute panic
  // bound, short-circuit L2 with verdict=rollback, shortCircuit=
  // 'policy_fail_fast'. Sticky: once tripped, stays tripped for the
  // deploy's remaining ticks. Ignore evaluated second: produces a set of
  // signals whose live observation sits in the operator's skip band; the
  // health gate threads it to detector-family eligibility (A/C/E) where
  // they suppress with suppression_reason='ignore_threshold'.
  const ffResult = classifyFailFast(params.failFastThresholds, live, params.failFastState);
  if (ffResult.shortCircuit) {
    return _emit({
      verdict: 'rollback',
      reason: ffResult.reason ?? 'Fail-fast threshold exceeded',
      gateResults,
      healthResult: null,
      shortCircuit: 'policy_fail_fast',
      policyCtx,
      failFastState: ffResult.newState,
    });
  }
  const ignoredSignals = classifyIgnoredSignals(params.ignoreThresholds, live);
  const failFastState: FailFastState = ffResult.newState;

  const healthResult = evaluateHealth(live, sc.baseline, sc.flags || {}, policyCtx, tb, {
    compiledConfig:    params.compiledConfig,
    currentHourOfDay:  params.currentHourOfDay,
    currentDayOfWeek:  params.currentDayOfWeek,
    ticksSinceDeploy:  params.ticksSinceDeploy ?? tick,
    deployAgeDays:     params.deployAgeDays    ?? (hrs / 24),
    schemaContinuityClass: params.schemaContinuityClass,
    ignoredSignals,
    tenantId:          params.tenantId,
  });
  gateResults.health = healthResult;

  // Week 4 fusion: always emit the portfolio verdict for audit + promote
  // to primary when `fusionTopology === 'portfolio'`. Cascade is the W3
  // default until adversarial parity confirms portfolio is drop-in.
  const deployRef = params.deployId || 'default';
  const topology: 'cascade' | 'portfolio' = params.fusionTopology ?? 'cascade';
  const fused = fuseVerdict(healthResult, {
    topology,
    tick,
    totalTicks: total,
    deployRef,
  });
  gateResults.fusion = fused;

  // Consolidated activation slice — post-L3 grouping + fan-out.
  // VerdictGrouper.ingest determines whether this tick closes a group
  // or attaches to one within its grace window. On close, fan out to
  // TopologyEnricher + AgentProposer in parallel (fire-and-forget from
  // evaluate()'s perspective; aggregate Promise exposed via
  // VerdictResult.groupClosePromise for tests). Rail-g is enforced
  // naturally: a closed group emits exactly once.
  const groupClosePromise = maybeIngestAndFanOut(
    params, deployId, lifecycleEmitter, reversibilityClassification!,
    fused, tick, total,
  );

  const cascadeVerdict = computeVerdict(healthResult, tick, total);
  const verdict = topology === 'portfolio' ? fused.verdict : cascadeVerdict;

  let reason = '';
  if (verdict === 'rollback' && healthResult.rollback.length > 0) {
    reason = healthResult.rollback.map((s) => s.label).join(', ');
  } else if (verdict === 'extend' && healthResult.extend.length > 0) {
    reason = healthResult.extend.map((s) => s.label).join(', ');
  } else {
    reason = verdict === 'proceed' ? 'All signals nominal.' : 'Baking.';
  }

  return _emit({
    verdict, reason, gateResults, healthResult,
    shortCircuit: null, policyCtx, failFastState,
    ...(groupClosePromise ? { groupClosePromise } : {}),
  });
}

/** Count distinct firing families across the group's verdicts. Used by
 *  the verdict_group.closed lifecycle payload. */
function _countFiringFamilies(group: VerdictGroup): number {
  const set = new Set<string>();
  for (const v of group.firing_verdicts) {
    for (const f of v.firing_families) set.add(f);
  }
  return set.size;
}

/** Post-L3 grouping + parallel fan-out. Returns the aggregate Promise
 *  only when a group closed on this tick; `undefined` otherwise.
 *  Absence of `verdictGrouper` on `params` short-circuits to `undefined`
 *  → backward-compatible byte-identical behavior for callers who don't
 *  opt into activation. */
function maybeIngestAndFanOut(
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
  const topoLeg: Promise<Partial<GroupCloseFanoutResult>> = params.topologyEnricher
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

  const agentEnabled =
    params.agentProposer !== undefined &&
    params.compiledConfig?.agent?.enabled === true &&
    params.buildAgentInputContext !== undefined;
  const agentLeg: Promise<Partial<GroupCloseFanoutResult>> = agentEnabled
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

  return Promise.all([topoLeg, agentLeg]).then(([topo, ag]) => ({
    group_id: closed.group_id,
    ...topo,
    ...ag,
  }));
}

// ── Addition #14 lifecycle emission helpers ──────────────────────────

function emitStarted(
  emitter: LifecycleEventEmitter,
  deployId: string,
  params: OrchestrateParams,
  result: VerdictResult,
): void {
  const cfg = params.compiledConfig;
  // cell_key uses the hour/day the orchestrator was called with; null
  // when the caller didn't thread cell coordinates through. cell_confidence
  // looks up the compiled-config cell; falls back to 'aggregate' when we
  // can't identify a cell (plain runtime without compiled_config).
  let cellKey: { hour_of_day?: number; day_of_week?: number } | null = null;
  if (params.currentHourOfDay !== undefined) {
    cellKey = { hour_of_day: params.currentHourOfDay };
    if (params.currentDayOfWeek !== undefined) cellKey.day_of_week = params.currentDayOfWeek;
  }
  let cellConfidence = 'aggregate';
  if (cfg?.baseline_cells && cellKey) {
    const match = cfg.baseline_cells.cells.find((c) => {
      if (c.key.hour_of_day !== cellKey!.hour_of_day) return false;
      if (cellKey!.day_of_week !== undefined && c.key.day_of_week !== undefined) {
        return c.key.day_of_week === cellKey!.day_of_week;
      }
      return true;
    });
    if (match) cellConfidence = match.confidence;
  }
  const families: FamilyId[] = ['B'];  // structural signatures always eligible
  if (cfg?.baseline_cells?.cells.some((c) => c.family_A)) families.push('A');
  if (cfg?.baseline_cells?.cells.some((c) => c.family_C)) families.push('C');
  if (cfg?.baseline_cells?.aggregate_fallback.family_D) families.push('D');
  if (cfg?.baseline_cells?.aggregate_fallback.family_E) families.push('E');
  families.sort();
  safeEmit(emitter, 'evaluation.started', {
    type: 'evaluation.started',
    deploy_id: deployId,
    cell_key: cellKey,
    cell_confidence: cellConfidence,
    families_eligible: families,
  });
  // Silence the unused-var warning from `result` — the parameter is
  // there for future extensions (e.g., surfacing the first tick's
  // verdict in the started event) but isn't consumed today.
  void result;
}

/** Compute the per-family "is this family suppressed right now" map.
 *  Family B structural signatures don't emit a suppression verdict, so
 *  B stays `false` for transition purposes. Families A/C/D/E use the
 *  health-result's shadow/verdict fields to determine suppression. */
function computeFamilySuppression(hr: HealthResult | null): Record<FamilyId, boolean> {
  const out: Record<FamilyId, boolean> = { A: false, B: false, C: false, D: false, E: false };
  if (!hr) return out;
  if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    out.A = hr.family_A_shadow.every((v) => v.verdict === 'suppressed');
  }
  if (hr.family_C_verdict) out.C = hr.family_C_verdict.verdict === 'suppressed';
  if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    out.D = hr.family_D_shadow.every((v) => v.verdict === 'suppressed');
  }
  if (hr.family_E_verdict) out.E = hr.family_E_verdict.verdict === 'suppressed';
  return out;
}

function suppressionReasonFor(hr: HealthResult | null, fam: FamilyId): string {
  if (!hr) return 'unknown';
  if (fam === 'A' && hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    return hr.family_A_shadow[0].reason_code;
  }
  if (fam === 'C' && hr.family_C_verdict) return hr.family_C_verdict.reason_code;
  if (fam === 'D' && hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    return hr.family_D_shadow[0].reason_code;
  }
  if (fam === 'E' && hr.family_E_verdict) return hr.family_E_verdict.reason_code;
  return 'unknown';
}

function emitSuppressionTransitions(
  emitter: LifecycleEventEmitter,
  deployId: string,
  tick: number,
  hr: HealthResult | null,
  state: LifecycleDeployState,
): void {
  const now = computeFamilySuppression(hr);
  const families: FamilyId[] = ['A', 'B', 'C', 'D', 'E'];
  // Tick 0 is the baseline: record the initial per-family state but do
  // not emit `evaluation.suppressed` events. The spec is "emit when a
  // family transitions into a suppressed state MID-EVALUATION"; tick 0
  // is the initial state, not a transition. Otherwise deploys whose
  // bake-profile gates start a family off suppressed would spam an
  // uninformative tick-0 event on every run.
  if (tick === 0) {
    for (const fam of families) state.perFamilySuppressionState[fam] = now[fam];
    return;
  }
  for (const fam of families) {
    const was = state.perFamilySuppressionState[fam];
    const is = now[fam];
    if (!was && is) {
      safeEmit(emitter, 'evaluation.suppressed', {
        type: 'evaluation.suppressed',
        deploy_id: deployId,
        tick,
        family_id: fam,
        suppression_reason: suppressionReasonFor(hr, fam),
      });
    }
    state.perFamilySuppressionState[fam] = is;
  }
}

function isTerminal(result: VerdictResult, tick: number, total: number): boolean {
  if (result.shortCircuit !== null) return true;
  if (result.verdict === 'rollback' || result.verdict === 'proceed') return true;
  return tick >= total - 1;
}

function summarizeFamilies(hr: HealthResult | null): Record<string, { verdict: string; alpha_spent: number }> {
  const out: Record<string, { verdict: string; alpha_spent: number }> = {};
  if (!hr) return out;
  if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    const anyFire = hr.family_A_shadow.some((v) => v.verdict === 'fire');
    const allSupp = hr.family_A_shadow.every((v) => v.verdict === 'suppressed');
    const alpha = hr.family_A_shadow.reduce((s, v) => s + v.alpha_spent, 0);
    out.A = { verdict: anyFire ? 'fire' : allSupp ? 'suppressed' : 'clean', alpha_spent: alpha };
  }
  if (hr.family_C_verdict) {
    out.C = { verdict: hr.family_C_verdict.verdict, alpha_spent: hr.family_C_verdict.alpha_spent };
  }
  if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    const anyFire = hr.family_D_shadow.some((v) => v.verdict === 'fire');
    const alpha = hr.family_D_shadow.reduce((s, v) => s + v.alpha_spent, 0);
    out.D = { verdict: anyFire ? 'fire' : 'clean', alpha_spent: alpha };
  }
  if (hr.family_E_verdict) {
    out.E = { verdict: hr.family_E_verdict.verdict, alpha_spent: hr.family_E_verdict.alpha_spent };
  }
  out.B = { verdict: hr.rollback.length > 0 ? 'fire' : 'clean', alpha_spent: 0 };
  return out;
}

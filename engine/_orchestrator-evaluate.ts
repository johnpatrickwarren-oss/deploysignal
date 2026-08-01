// engine/_orchestrator-evaluate.ts — five-gate orchestrator entrypoint.
// Sequence: G4 (blast radius) → G2 (policy) → G5 (approval) → G3 (state) → G1 (health).
// Each gate may short-circuit and emit a verdict via the audit writer.
//
// Extracted from engine/orchestrator.ts (god-file split). `evaluate` is
// re-exported by the engine/orchestrator facade; behavior is preserved
// byte-for-byte. The former single ~280-line `evaluate` body is now
// decomposed into <100-line gate-stage helpers (`runGateSequence`,
// `computeFinalVerdict`) called in the same order.

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
import { NoReversibilitySource } from '@johnpatrickwarren-oss/deploysignal-engine/o0/reversibility-source';
import { classifyReversibility } from './g0/reversibility-classifier';
import { translateVerdict } from '@johnpatrickwarren-oss/deploysignal-engine/o0/reversibility-translator';
import {
  NoOpLifecycleEventEmitter, freshLifecycleState, safeEmit,
} from './o0/lifecycle-events';
import type {
  LifecycleEventEmitter, LifecycleDeployState,
} from './o0/lifecycle-events';
import { applyExpectedFailurePatternSuppression } from './o0/anvil/suppression';

import { applyCompiledConfig } from './_orchestrator-config';
import { maybeIngestAndFanOut } from './_orchestrator-fanout';
import { emitTickLifecycle } from './_orchestrator-lifecycle';

import type {
  OrchestrateParams, VerdictResult, GateResults, PolicyContext, AuditWriter, AuditOpts,
  FailFastState, ReversibilityClassification, AuditRecord, AuditRecordV2,
} from './types';

/** Either a short-circuit verdict draft (passed straight to `_emit`) or
 *  the resolved gate state needed to run the health + fusion stage. */
type GateSequenceResult =
  | { kind: 'shortCircuit'; draft: VerdictResult }
  | {
      kind: 'continue';
      policyCtx: PolicyContext;
      failFastState: FailFastState;
      ignoredSignals: ReturnType<typeof classifyIgnoredSignals>;
      effectiveRisk: OrchestrateParams['scenario']['riskLevel'];
    };

// Runs the pre-policy admission gates G4→G2→G5→G3 in order, mutating
// `gateResults` exactly as the inline body did. Returns a short-circuit
// draft on the first failing gate, otherwise the resolved policy context
// + effective risk for the SRM / fail-fast stage.
function runAdmissionGates(
  params: OrchestrateParams,
  gateResults: GateResults,
  tick: number,
):
  | { kind: 'shortCircuit'; draft: VerdictResult }
  | { kind: 'continue'; policyCtx: PolicyContext; effectiveRisk: OrchestrateParams['scenario']['riskLevel'] } {
  const sc = params.scenario;
  const hrs = params.hoursElapsed;

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
    return { kind: 'shortCircuit', draft: {
      verdict: 'rollback',
      reason: policyResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'policy',
    } };
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
    return { kind: 'shortCircuit', draft: {
      verdict: 'extend',
      reason: approvalResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'approval',
    } };
  }

  const stateResult = evaluateState(params.deployId || 'default', params.targetCloud || 'primary', params.stateContext);
  gateResults.state = stateResult;
  if (!stateResult.allow) {
    return { kind: 'shortCircuit', draft: {
      verdict: 'extend',
      reason: stateResult.reason ?? '',
      gateResults,
      healthResult: null,
      shortCircuit: 'state',
    } };
  }

  return { kind: 'continue', policyCtx, effectiveRisk };
}

// Runs the gate cascade G4→G2→G5→G3→SRM→fail-fast/ignore in order,
// mutating `gateResults` exactly as the inline body did. Returns a
// short-circuit draft on the first failing gate, otherwise the resolved
// policy context + fail-fast state + ignore set for the health stage.
function runGateSequence(
  params: OrchestrateParams,
  gateResults: GateResults,
  tick: number,
): GateSequenceResult {
  const live = params.liveMetrics;

  const admission = runAdmissionGates(params, gateResults, tick);
  if (admission.kind === 'shortCircuit') return admission;
  const { policyCtx, effectiveRisk } = admission;

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
    return { kind: 'shortCircuit', draft: {
      verdict: 'rollback',
      reason: srmDecision.reason,
      gateResults,
      healthResult: null,
      shortCircuit: 'srm',
      policyCtx,
    } };
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
    return { kind: 'shortCircuit', draft: {
      verdict: 'rollback',
      reason: ffResult.reason ?? 'Fail-fast threshold exceeded',
      gateResults,
      healthResult: null,
      shortCircuit: 'policy_fail_fast',
      policyCtx,
      failFastState: ffResult.newState,
    } };
  }
  const ignoredSignals = classifyIgnoredSignals(params.ignoreThresholds, live);
  const failFastState: FailFastState = ffResult.newState;

  return { kind: 'continue', policyCtx, failFastState, ignoredSignals, effectiveRisk };
}

// Runs the health gate → Anvil suppression → fusion → group fan-out →
// cascade/portfolio verdict + reason, mutating `gateResults` exactly as
// the inline body did. Returns the final (pre-`_emit`) verdict draft.
function computeFinalVerdict(
  params: OrchestrateParams,
  gateResults: GateResults,
  gate: Extract<GateSequenceResult, { kind: 'continue' }>,
  deployId: string,
  lifecycleEmitter: LifecycleEventEmitter,
  reversibilityClassification: ReversibilityClassification,
  tick: number,
  total: number,
): VerdictResult {
  const sc = params.scenario;
  const live = params.liveMetrics;
  const hrs = params.hoursElapsed;
  const tb = params.trendBuffer ?? null;
  const { policyCtx, failFastState, ignoredSignals } = gate;

  const rawHealthResult = evaluateHealth(live, sc.baseline, sc.flags || {}, policyCtx, tb, {
    compiledConfig:    params.compiledConfig,
    currentHourOfDay:  params.currentHourOfDay,
    currentDayOfWeek:  params.currentDayOfWeek,
    ticksSinceDeploy:  params.ticksSinceDeploy ?? tick,
    deployAgeDays:     params.deployAgeDays    ?? (hrs / 24),
    schemaContinuityClass: params.schemaContinuityClass,
    ignoredSignals,
    tenantId:          params.tenantId,
  });
  // Addition #29 / Q29 — Anvil expected-failure-pattern suppression. Gated
  // on params.expectedFailurePattern !== undefined so the pre-Anvil path
  // is byte-identical (PRD-29 NFR-2 / AC-11). The pattern declares which
  // detector families the operator expects to fire because of the injected
  // fault; those families are rewritten to suppressed during the fault
  // window. Non-suppressed families still fire on unexpected blast.
  const healthResult = params.expectedFailurePattern
    ? applyExpectedFailurePatternSuppression(
        rawHealthResult,
        params.expectedFailurePattern,
        params.nowSeconds ?? Date.now() / 1000,
      )
    : rawHealthResult;
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
    params, deployId, lifecycleEmitter, reversibilityClassification,
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

  return {
    verdict, reason, gateResults, healthResult,
    shortCircuit: null, policyCtx, failFastState,
    ...(groupClosePromise ? { groupClosePromise } : {}),
  };
}

export function evaluate(params: OrchestrateParams): VerdictResult {
  const sc = params.scenario;
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
    emitTickLifecycle(
      lifecycleEmitter, lifecycleState, params, result, record, deployId, tick, total,
    );

    result.lifecycleState = lifecycleState;
    return result;
  }

  const gate = runGateSequence(params, gateResults, tick);
  if (gate.kind === 'shortCircuit') return _emit(gate.draft);

  return _emit(computeFinalVerdict(
    params, gateResults, gate, deployId, lifecycleEmitter,
    reversibilityClassification!, tick, total,
  ));
}

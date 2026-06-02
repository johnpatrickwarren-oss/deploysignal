// engine/_audit-record.ts — schema-v1/v2 audit record builder.
// Split verbatim from engine/audit.ts; buildAuditRecord decomposed into
// <100-line helpers. Behavior is identical.

import * as crypto from 'crypto';

import type {
  AuditOpts, AuditRecord, AuditRecordV2, OrchestrateParams,
  VerdictResult, TrippedEntry, Mode, Verdict, HealthResult,
} from './types';
import { buildFamilyVerdictsV2, buildFlatTripped } from './_audit-families';

// Policy digest cache (per-scenario, resets naturally when context changes)
let _lastPolicyStr = '';
let _lastPolicyDigest = '';

/** Collect the v1 `tripped[]` from the health rollback/extend surfaces. */
function buildTripped(hr: HealthResult | null): TrippedEntry[] {
  const tripped: TrippedEntry[] = [];
  if (hr) {
    if (hr.rollback) {
      for (let i = 0; i < hr.rollback.length; i++) {
        tripped.push({ id: hr.rollback[i].id, label: hr.rollback[i].label, gate: 'health_rollback' });
      }
    }
    if (hr.extend) {
      for (let j = 0; j < hr.extend.length; j++) {
        tripped.push({ id: hr.extend[j].id, label: hr.extend[j].label, gate: 'health_extend' });
      }
    }
  }
  return tripped;
}

/** Snapshot raw TrendBuffer arrays (cheap) — defer stats to flush. */
function snapshotRawTrend(params: OrchestrateParams): { [key: string]: number[] } | null {
  if (!params.trendBuffer || !params.trendBuffer.data) return null;
  const rawTrend: { [key: string]: number[] } = {};
  const keys = Object.keys(params.trendBuffer.data);
  for (let k = 0; k < keys.length; k++) {
    rawTrend[keys[k]] = params.trendBuffer.data[keys[k]].slice();
  }
  return rawTrend;
}

/** Cache policy digest — same context across ticks in a scenario. */
function computePolicyDigest(result: VerdictResult): string {
  const ctx = result.policyCtx ||
              (result.gateResults && result.gateResults.policy && result.gateResults.policy.policyContext);
  if (!ctx) return '';
  const ctxStr = JSON.stringify(ctx);
  if (ctxStr === _lastPolicyStr) return _lastPolicyDigest;
  const policyDigest = crypto.createHash('sha1').update(ctxStr).digest('hex');
  _lastPolicyStr = ctxStr;
  _lastPolicyDigest = policyDigest;
  return policyDigest;
}

function buildBaseRecord(
  params: OrchestrateParams,
  result: VerdictResult,
  opts: AuditOpts | null | undefined,
  tripped: TrippedEntry[],
  rawTrend: { [key: string]: number[] } | null,
  policyDigest: string,
): AuditRecord {
  const verdict: Verdict = result.verdict;
  const mode: Mode = (opts && opts.mode) || 'shadow';
  const baseRecord: AuditRecord = {
    schema_version: '1',
    ts: new Date().toISOString(),
    service: (opts && opts.service) || '',
    tick: params.tick,
    total_ticks: params.totalTicks,
    hours_elapsed: params.hoursElapsed || 0,
    verdict,
    reason: result.reason,
    short_circuit: result.shortCircuit || null,
    tripped,
    inputs: params.liveMetrics,
    baseline: params.scenario ? params.scenario.baseline : {},
    scenario_ctx: params.scenario ? {
      riskLevel: params.scenario.riskLevel || 'medium',
      changeType: params.scenario.changeType || 'serving_code',
      author: params.scenario.author || 'human',
      timeWindow: params.scenario.timeWindow || 'ok',
      flags: params.scenario.flags || {},
    } : {},
    trend_snapshot: null, // filled by _finalize
    policy_ctx_digest: policyDigest,
    mode,
    gate_results: result.gateResults || {},
    // W6+ Addition #10: emit L0 SRM classification on every record (null
    // when caller doesn't thread one through). Pulled from params, not
    // result — the field is independent of the short-circuit, so clean
    // ticks still carry the current status for downstream analytics.
    traffic_allocation_continuity: params.trafficAllocationContinuity ?? null,
  };
  baseRecord._rawTrend = rawTrend;
  baseRecord._tsFn = (opts && opts.trendStrength) || null;
  return baseRecord;
}

function buildV2Record(
  params: OrchestrateParams,
  result: VerdictResult,
  hr: HealthResult | null,
  baseRecord: AuditRecord,
  fusion: NonNullable<NonNullable<VerdictResult['gateResults']>['fusion']>,
): AuditRecordV2 {
  // v2 extension: flatten v1 tripped[] to use canonical detector_ids and
  // append the new per-family block. v1 readers consuming a v2 record
  // still see a valid `tripped` array (strict-additive invariant).
  const families = buildFamilyVerdictsV2(params, result, hr);
  const flatTripped = buildFlatTripped(families);
  const v2Record: AuditRecordV2 = {
    ...baseRecord,
    schema_version: '2',
    tripped: flatTripped,
    fusion_topology: fusion.fusion_topology,
    compiled_config_version: params.compiledConfig?.version ?? 'legacy',
    families,
    // Addition #5 (shipped 2026-04-20 per ARCHITECT-REPLY-32): reversibility
    // is classified once per deploy at deploy start by the G0 classifier.
    // `result.reversibilityClassification` is populated by the orchestrator
    // in `_emit`; fall back to `params.reversibilityClassification` so
    // direct callers of `buildAuditRecord` (test harnesses that built their
    // own classification) still emit populated fields. Absent in both →
    // null (backward-compat for pre-#5 test fixtures).
    reversibility:
      result.reversibilityClassification?.reversibility
      ?? params.reversibilityClassification?.reversibility
      ?? null,
    reversibility_source:
      result.reversibilityClassification?.reversibility_source
      ?? params.reversibilityClassification?.reversibility_source
      ?? null,
    total_alpha_spent: fusion.total_alpha_spent,
  };
  return v2Record;
}

/**
 * buildAuditRecord(params, result, opts)
 *
 * Constructs a schema-v1 audit record from orchestrator inputs and output.
 * Called by the _emit() wrapper in orchestrator.ts.
 *
 * Perf-critical: trend_snapshot is built from a frozen copy of the raw
 * TrendBuffer arrays (cheap slice) rather than recomputing get() stats.
 * Stats are computed lazily during flush via _rawTrend + _computeStats().
 */
export function buildAuditRecord(
  params: OrchestrateParams,
  result: VerdictResult,
  opts?: AuditOpts | null,
): AuditRecord | AuditRecordV2 {
  const hr = result.healthResult;
  const tripped = buildTripped(hr);
  const rawTrend = snapshotRawTrend(params);
  const policyDigest = computePolicyDigest(result);

  const baseRecord = buildBaseRecord(params, result, opts, tripped, rawTrend, policyDigest);

  // W4 §4.1.h — emit v2 records when fusion_topology === 'portfolio';
  // v1 records on cascade (preserves replay-regression against v1
  // fixture). Every v1 field present in v2 with identical semantics
  // per audit/SCHEMA.md v2 §Backward compatibility.
  const fusion = result.gateResults?.fusion;
  const useV2 = fusion?.fusion_topology === 'portfolio';
  if (!useV2 || !fusion) return baseRecord;

  return buildV2Record(params, result, hr, baseRecord, fusion);
}

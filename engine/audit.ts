// engine/audit.ts — Audit log writer + record builder.
// Buffered append-only JSONL with daily rotation. Hot path is allocation-only
// (lazy stat computation deferred to flush) so the decision loop stays cheap.

// Node built-ins via ES-compatible import form so audit.ts compiles under
// both `module: commonjs` (Node test runtime) and `module: es2020`
// (browser-bundle generator). The browser bundle shims these at the top
// of the concatenated output; createAuditWriter is the only fs/path
// consumer and demos never invoke it.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type {
  AuditWriter, AuditOpts, AuditRecord, AuditRecordV2, OrchestrateParams,
  VerdictResult, TrendSnapshot, TrippedEntry, Mode, Verdict, FamilyId,
  DetectorId, DetectorTripV2, FamilyVerdictV2, Provenance, DetectorVerdict,
  FiredSignal, HealthResult, CompiledConfig, BaselineCellEntry,
} from './types';
import { DETECTOR_REGISTRY } from './types';

interface AuditWriterOpts {
  dir?: string | null;
  service?: string;
  rotateDaily?: boolean;
}

/**
 * createAuditWriter({dir, service, rotateDaily})
 *
 * Returns {write(record), close()} for appending JSONL audit records.
 * Buffered — flushes every 500ms and on close().
 * Daily rotation by UTC date.
 * No-op if dir is falsy.
 */
export function createAuditWriter(opts?: AuditWriterOpts): AuditWriter {
  if (!opts || !opts.dir) return { write: noop, close: noop };

  const dir = opts.dir;
  const service = opts.service || 'default';
  const rotate = opts.rotateDaily !== false;

  const serviceDir = path.join(dir, service);
  fs.mkdirSync(serviceDir, { recursive: true });

  let buffer: Array<AuditRecord | AuditRecordV2> = [];
  let currentDate = utcDate();
  let flushTimer: ReturnType<typeof setInterval> | null = setInterval(flush, 500);

  function utcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function filePath(date: string): string {
    return path.join(serviceDir, date + '.jsonl');
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const today = rotate ? utcDate() : currentDate;
    if (today !== currentDate) currentDate = today;
    let lines = '';
    for (let i = 0; i < buffer.length; i++) {
      const rec = _finalize(buffer[i]);
      const replacer = rec.schema_version === '2' ? _schemaV2Replacer : _schemaV1Replacer;
      lines += JSON.stringify(rec, replacer) + '\n';
    }
    buffer = [];
    try {
      fs.appendFileSync(filePath(currentDate), lines, 'utf8');
    } catch (_e) {
      // Best-effort — don't crash the decision path
    }
  }

  function write(record: AuditRecord | AuditRecordV2): void {
    buffer.push(record);
  }

  function close(): void {
    if (flushTimer !== null) clearInterval(flushTimer);
    flushTimer = null;
    flush();
  }

  return { write, close };
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
  const tripped: TrippedEntry[] = [];
  const hr = result.healthResult;
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

  // Snapshot raw TrendBuffer arrays (cheap) — defer stats to flush
  let rawTrend: { [key: string]: number[] } | null = null;
  if (params.trendBuffer && params.trendBuffer.data) {
    rawTrend = {};
    const keys = Object.keys(params.trendBuffer.data);
    for (let k = 0; k < keys.length; k++) {
      rawTrend[keys[k]] = params.trendBuffer.data[keys[k]].slice();
    }
  }

  // Cache policy digest — same context across ticks in a scenario
  let policyDigest = '';
  const ctx = result.policyCtx ||
              (result.gateResults && result.gateResults.policy && result.gateResults.policy.policyContext);
  if (ctx) {
    const ctxStr = JSON.stringify(ctx);
    if (ctxStr === _lastPolicyStr) {
      policyDigest = _lastPolicyDigest;
    } else {
      policyDigest = crypto.createHash('sha1').update(ctxStr).digest('hex');
      _lastPolicyStr = ctxStr;
      _lastPolicyDigest = policyDigest;
    }
  }

  const verdict: Verdict = result.verdict;
  const mode: Mode = (opts && opts.mode) || 'shadow';

  // W4 §4.1.h — emit v2 records when fusion_topology === 'portfolio';
  // v1 records on cascade (preserves replay-regression against v1
  // fixture). Every v1 field present in v2 with identical semantics
  // per audit/SCHEMA.md v2 §Backward compatibility.
  const fusion = result.gateResults?.fusion;
  const useV2 = fusion?.fusion_topology === 'portfolio';

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

  if (!useV2) return baseRecord;

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

// ── v2 record construction helpers (W4 §4.1.h) ──────────────────────

/** Map a synthetic rollback[] id to the canonical {family_id, detector_id}
 *  pair in DETECTOR_REGISTRY. Returns null for unknown ids — the writer
 *  skips them to satisfy "no unknown_detector_id values in shipped
 *  records" (audit/SCHEMA.md v2 acceptance). */
function resolveDetectorId(id: string): { family_id: FamilyId; detector_id: DetectorId } | null {
  // Addition #17 (ARCHITECT-REPLY-34 D2) — betting-e-process fires come
  // through with a `family_A_betting_` prefix so the audit writer can
  // distinguish them from Page-CUSUM fires (both share `family === 'A'`).
  // Must be checked before the broader `family_A_` branch.
  if (id.startsWith('family_A_betting_')) {
    const signal = id.slice('family_A_betting_'.length);
    const did = ('betting_e_process_' + signal) as DetectorId;
    if ((DETECTOR_REGISTRY.A as readonly string[]).indexOf(did) >= 0) return { family_id: 'A', detector_id: did };
    return null;
  }
  if (id.startsWith('family_A_')) {
    const signal = id.slice('family_A_'.length);
    const did = ('mSPRT_' + signal) as DetectorId;
    if ((DETECTOR_REGISTRY.A as readonly string[]).indexOf(did) >= 0) return { family_id: 'A', detector_id: did };
    return null;
  }
  if (id === 'family_C') return { family_id: 'C', detector_id: 'hotelling_t2_joint_vector' };
  if (id === 'family_C_mmd') return { family_id: 'C', detector_id: 'sequential_mmd' };
  if (id.startsWith('family_D_')) {
    const signal = id.slice('family_D_'.length);
    const did = ('spectral_peak_acf_' + signal) as DetectorId;
    if ((DETECTOR_REGISTRY.D as readonly string[]).indexOf(did) >= 0) return { family_id: 'D', detector_id: did };
    return null;
  }
  if (id === 'family_E') return { family_id: 'E', detector_id: 'mahalanobis_conformal_baseline' };
  // Family B: registry IDs are 1:1 with rollback[] ids on the portfolio path.
  if ((DETECTOR_REGISTRY.B as readonly string[]).indexOf(id) >= 0) {
    return { family_id: 'B', detector_id: id as DetectorId };
  }
  return null;
}

/** Look up the cell consulted at detector evaluation time. Returns
 *  null-filled provenance when cells don't apply (Family B structural). */
function cellProvenance(
  cfg: CompiledConfig | null | undefined,
  hourOfDay?: number,
  dayOfWeek?: number,
): Pick<Provenance, 'cell_key' | 'cell_confidence' | 'variance_inflated'> {
  if (!cfg?.baseline_cells || hourOfDay === undefined) {
    return { cell_key: null, cell_confidence: null, variance_inflated: false };
  }
  const match = findCell(cfg.baseline_cells.cells, hourOfDay, dayOfWeek);
  if (!match) {
    return { cell_key: null, cell_confidence: 'aggregate', variance_inflated: false };
  }
  return {
    cell_key: match.key,
    cell_confidence: match.confidence,
    variance_inflated: match.variance_inflated === true,
  };
}

function findCell(cells: BaselineCellEntry[], hour: number, day?: number): BaselineCellEntry | undefined {
  return cells.find((c) => {
    if (c.key.hour_of_day !== hour) return false;
    if (day !== undefined && c.key.day_of_week !== undefined) return c.key.day_of_week === day;
    return true;
  });
}

/** Produce the per-detector trip from a structured DetectorVerdict +
 *  synthetic rollback id + label. Pulls cell provenance server-side so
 *  the detector-side API stays unchanged. */
function tripFromVerdict(
  params: OrchestrateParams,
  rid: { family_id: FamilyId; detector_id: DetectorId },
  v: DetectorVerdict,
  label: string,
  gate: 'health_rollback' | 'health_extend',
  provExtras?: Partial<Pick<Provenance, 'family_c_shrink_fraction_used'>>,
): DetectorTripV2 {
  const prov = cellProvenance(params.compiledConfig, params.currentHourOfDay, params.currentDayOfWeek);
  const baselineVersion = params.compiledConfig?.version ?? 'legacy';
  const provenance: Provenance = {
    ...prov,
    covariate_freshness: 0,  // no CUPAC in current scope
    baseline_version: baselineVersion,
    // W5 §S6 (Addition #8 runtime consumer): pull the continuity class from
    // the detector-evaluation context the caller threaded through. Null when
    // the caller didn't emit an L0 continuity record (runway synthetic data).
    schema_continuity: params.schemaContinuityClass ?? null,
    ...(provExtras?.family_c_shrink_fraction_used !== undefined
      ? { family_c_shrink_fraction_used: provExtras.family_c_shrink_fraction_used }
      : {}),
  };
  const trip: DetectorTripV2 = {
    family_id: rid.family_id,
    detector_id: rid.detector_id,
    statistic: v.statistic,
    threshold: v.threshold,
    alpha_spent: v.alpha_spent,
    reason_code: v.reason_code,
    gate,
    label,
    provenance,
  };
  if (rid.family_id === 'A' && v.threshold && v.statistic !== null) {
    trip.cusum_progress = v.threshold > 0 ? v.statistic / v.threshold : 0;
  }
  return trip;
}

/** Structural-rule Family B trip — no DetectorVerdict shape; fill stats
 *  as null and reason_code via the synthetic signal id. */
function tripFromFamilyB(
  params: OrchestrateParams,
  fired: FiredSignal,
  gate: 'health_rollback' | 'health_extend',
): DetectorTripV2 | null {
  const rid = resolveDetectorId(fired.id);
  if (!rid || rid.family_id !== 'B') return null;
  const prov = cellProvenance(params.compiledConfig, params.currentHourOfDay, params.currentDayOfWeek);
  // Family B structural detectors don't consult cells at today's
  // implementation; null out the cell fields for honesty. `variance_inflated`
  // flag still flows from the Family-A/C-consulted cell iff the scenario
  // happens to hit a pooled cell — emit `false` here since B didn't use it.
  const provenance: Provenance = {
    cell_key: null,
    cell_confidence: null,
    variance_inflated: false,
    covariate_freshness: 0,
    baseline_version: params.compiledConfig?.version ?? 'legacy',
    // W5 §S6: Family B is not suppressed by schema-continuity (per
    // Addition #8 — structural signatures don't depend on continuous metric
    // semantics), but the continuity class still attaches to provenance so
    // downstream consumers can see the L0 signal Family B evaluated against.
    schema_continuity: params.schemaContinuityClass ?? null,
  };
  return {
    family_id: 'B',
    detector_id: rid.detector_id,
    statistic: null,  // ratio-detector statistic not tracked in the v1 health surface
    threshold: null,
    alpha_spent: 0,   // Family B hand-tuned thresholds don't spend Ville budget
    reason_code: fired.id,
    gate,
    label: fired.label,
    provenance,
    // Keep the provenance variable from being flagged as unused when
    // consumers stop reading it. No-op.
    ...(prov ? {} : {}),
  };
}

function buildFamilyVerdictsV2(
  params: OrchestrateParams,
  result: VerdictResult,
  hr: HealthResult | null,
): Record<FamilyId, FamilyVerdictV2> {
  const empty = (): FamilyVerdictV2 => ({ verdict: 'clean', detectors: [], alpha_spent: 0, suppression_reason: null });
  const out: Record<FamilyId, FamilyVerdictV2> = {
    A: empty(), B: empty(), C: empty(), D: empty(), E: empty(),
  };
  if (!hr) return out;

  // Map a suppressed DetectorVerdict.reason_code to the family-level
  // suppression_reason vocabulary per audit/SCHEMA.md v2. W5 §S6 adds the
  // two Addition-#8 codes; Addition #13 adds 'ignore_threshold';
  // everything else is bake_profile.
  const mapSuppression = (codes: string[]): FamilyVerdictV2['suppression_reason'] => {
    if (codes.indexOf('observability_stack_deploy') >= 0) return 'observability_stack_deploy';
    if (codes.indexOf('schema_continuity_breaking') >= 0) return 'schema_continuity_breaking';
    if (codes.indexOf('expected_failure_pattern') >= 0) return 'expected_failure_pattern';
    if (codes.indexOf('ignore_threshold') >= 0) return 'ignore_threshold';
    return 'bake_profile';
  };

  // Family A — per-signal shadow verdicts.
  if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
    const fa = out.A;
    let anyFire = false, anyIndet = false, allSuppressed = true, anyEvaluated = false;
    let alphaSum = 0;
    const suppressCodes: string[] = [];
    for (const v of hr.family_A_shadow) {
      anyEvaluated = true;
      if (v.verdict !== 'suppressed') allSuppressed = false;
      else suppressCodes.push(v.reason_code);
      if (v.verdict === 'fire' && v.signal) {
        anyFire = true;
        const rid = resolveDetectorId('family_A_' + v.signal);
        if (rid) {
          fa.detectors.push(tripFromVerdict(params, rid, v, 'Family A ' + v.signal, 'health_rollback'));
          alphaSum += v.alpha_spent;
        }
      } else if (v.verdict === 'indeterminate') {
        anyIndet = true;
      }
    }
    if (!anyEvaluated) fa.verdict = 'clean';
    else if (anyFire) fa.verdict = 'fire';
    else if (allSuppressed) { fa.verdict = 'suppressed'; fa.suppression_reason = mapSuppression(suppressCodes); }
    else if (anyIndet) fa.verdict = 'indeterminate';
    else fa.verdict = 'clean';
    fa.alpha_spent = alphaSum;
  }

  // Family B — structural rule detectors from rollback[] (post-Family-A-promotion).
  if (hr.rollback.length > 0) {
    const fb = out.B;
    for (const fired of hr.rollback) {
      const rid = resolveDetectorId(fired.id);
      if (!rid || rid.family_id !== 'B') continue;
      const trip = tripFromFamilyB(params, fired, 'health_rollback');
      if (trip) fb.detectors.push(trip);
    }
    if (fb.detectors.length > 0) fb.verdict = 'fire';
  }

  // Family C — per-detector verdict(s). Hotelling T² is primary; Addition
  // #18 adds Sequential MMD as a second detector running alongside. Both
  // contribute to the family-level verdict; either firing flips the
  // family to 'fire' and appends a DetectorTripV2.
  const familyCVerdicts: Array<{ v: DetectorVerdict; rid: 'family_C' | 'family_C_mmd'; label: string }> = [];
  if (hr.family_C_verdict) {
    familyCVerdicts.push({
      v: hr.family_C_verdict, rid: 'family_C', label: 'Family C (multivariate)',
    });
  }
  if (hr.family_C_mmd_verdict) {
    familyCVerdicts.push({
      v: hr.family_C_mmd_verdict, rid: 'family_C_mmd', label: 'Family C (Sequential MMD)',
    });
  }
  if (familyCVerdicts.length > 0) {
    const fc = out.C;
    let anyFire = false;
    let anySuppressed = false, allSuppressed = true;
    let anyIndet = false;
    let alphaSum = 0;
    const suppressCodes: string[] = [];
    for (const { v, rid, label } of familyCVerdicts) {
      if (v.verdict === 'fire') {
        anyFire = true;
        allSuppressed = false;
        const rr = resolveDetectorId(rid)!;
        // Addition #20 — variant-aware detector_id. When the verdict carries
        // a Family-C-registered signal (`hotelling_t2_safe` /
        // `sequential_mmd_e_process`), use it as detector_id instead of
        // the default chi_square / bootstrap_null mapping. Preserves
        // audit distinction between legacy + new e-process variants.
        const sig = v.signal as DetectorId | undefined;
        const ridResolved = (sig && (DETECTOR_REGISTRY.C as readonly string[]).indexOf(sig) >= 0)
          ? { family_id: 'C' as const, detector_id: sig }
          : rr;
        // Addition #20 (REPLY-43b) — on safe-Hotelling fires, surface the
        // cell's shrink_fraction in Provenance so replay consumers can
        // reproduce fire timings across different c values.
        let provExtras: { family_c_shrink_fraction_used?: number } | undefined;
        if (sig === 'hotelling_t2_safe' && params.compiledConfig?.baseline_cells
            && params.currentHourOfDay !== undefined) {
          const matchedCell = findCell(
            params.compiledConfig.baseline_cells.cells,
            params.currentHourOfDay, params.currentDayOfWeek,
          );
          const shrink = matchedCell?.family_C?.safe_hotelling_params?.shrink_fraction
            ?? params.compiledConfig.baseline_cells.aggregate_fallback.family_C?.safe_hotelling_params?.shrink_fraction;
          if (shrink !== undefined) provExtras = { family_c_shrink_fraction_used: shrink };
        }
        fc.detectors.push(tripFromVerdict(params, ridResolved, v, label, 'health_rollback', provExtras));
        alphaSum += v.alpha_spent;
      } else if (v.verdict === 'suppressed') {
        anySuppressed = true;
        suppressCodes.push(v.reason_code);
      } else if (v.verdict === 'indeterminate') {
        anyIndet = true;
        allSuppressed = false;
      } else {
        allSuppressed = false;  // 'clean'
      }
    }
    if (anyFire) fc.verdict = 'fire';
    else if (allSuppressed && anySuppressed) {
      fc.verdict = 'suppressed';
      fc.suppression_reason = mapSuppression(suppressCodes);
    } else if (anyIndet) fc.verdict = 'indeterminate';
    fc.alpha_spent = alphaSum;
  }

  // Family D — per-signal array (kv_cache in W4 registry).
  if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
    const fd = out.D;
    let anyFire = false, anySuppressed = false, allSuppressed = true;
    let alphaSum = 0;
    const suppressCodes: string[] = [];
    for (const v of hr.family_D_shadow) {
      if (v.verdict !== 'suppressed') allSuppressed = false;
      else suppressCodes.push(v.reason_code);
      if (v.verdict === 'fire' && v.signal) {
        anyFire = true;
        const rid = resolveDetectorId('family_D_' + v.signal);
        if (rid) {
          // Addition #21 — variant-aware detector_id projection. When the
          // e-detector fired (reason_code matches its wealth-exceeded
          // code), override the default `spectral_peak_acf_*` id with
          // `spectral_e_detector_*` so audit records distinguish the
          // two variants. Bootstrap-null reason codes include
          // `spectral_peak_at_lag_*` per evaluateFamilyD legacy path.
          let ridResolved = rid;
          if (v.reason_code === 'spectral_e_detector_wealth_exceeded') {
            const did = ('spectral_e_detector_' + v.signal) as DetectorId;
            if ((DETECTOR_REGISTRY.D as readonly string[]).indexOf(did) >= 0) {
              ridResolved = { family_id: 'D' as const, detector_id: did };
            }
          }
          fd.detectors.push(tripFromVerdict(params, ridResolved, v, 'Family D ' + v.signal, 'health_rollback'));
          alphaSum += v.alpha_spent;
        }
      } else if (v.verdict === 'suppressed') anySuppressed = true;
    }
    if (anyFire) fd.verdict = 'fire';
    else if (allSuppressed && anySuppressed) { fd.verdict = 'suppressed'; fd.suppression_reason = mapSuppression(suppressCodes); }
    fd.alpha_spent = alphaSum;
  }

  // Family E — single conformal verdict.
  if (hr.family_E_verdict) {
    const v = hr.family_E_verdict;
    const fe = out.E;
    if (v.verdict === 'fire') {
      const rid = resolveDetectorId('family_E')!;
      fe.detectors.push(tripFromVerdict(params, rid, v, 'Family E (novelty)', 'health_rollback'));
      fe.verdict = 'fire';
      fe.alpha_spent = v.alpha_spent;
    } else if (v.verdict === 'suppressed') {
      fe.verdict = 'suppressed';
      fe.suppression_reason = mapSuppression([v.reason_code]);
    } else if (v.verdict === 'indeterminate') {
      fe.verdict = 'indeterminate';
    }
  }

  return out;
}

/** Flattened `tripped[]` projection for v2 records — family-then-detector
 *  ordered, uses canonical detector_id as the v1-compat `id` field. */
function buildFlatTripped(families: Record<FamilyId, FamilyVerdictV2>): TrippedEntry[] {
  const out: TrippedEntry[] = [];
  const order: FamilyId[] = ['A', 'B', 'C', 'D', 'E'];
  for (const fam of order) {
    const fv = families[fam];
    for (const t of fv.detectors) {
      out.push({ id: t.detector_id, label: t.label, gate: t.gate });
    }
  }
  return out;
}

// Policy digest cache (per-scenario, resets naturally when context changes)
let _lastPolicyStr = '';
let _lastPolicyDigest = '';

/**
 * Finalize a record before serialization: compute trend_snapshot from
 * raw buffer data. Called during flush, not in the hot decision path.
 */
function _finalize(record: AuditRecord | AuditRecordV2): AuditRecord | AuditRecordV2 {
  if (record._rawTrend) {
    const snapshot: { [key: string]: TrendSnapshot } = {};
    const keys = Object.keys(record._rawTrend);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const hist = record._rawTrend[key];
      snapshot[key] = _computeStats(hist, record._tsFn ?? null);
    }
    record.trend_snapshot = snapshot;
  } else {
    record.trend_snapshot = {};
  }
  delete record._rawTrend;
  delete record._tsFn;
  return record;
}

function _computeStats(
  hist: number[] | null | undefined,
  tsFn: ((t: TrendSnapshot, direction: 'rise' | 'fall') => number) | null,
): TrendSnapshot {
  if (!hist || hist.length < 4) {
    const empty: TrendSnapshot = {
      slope: 0, slopeNorm: 0, cv: 1, mean: 0, min: 0, max: 0, range: 0, roc: 0,
      n: hist ? hist.length : 0, stable: false, insufficient: true, trendStrength: 0,
    };
    return empty;
  }
  const n = hist.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += hist[i]; sumXY += i * hist[i]; sumX2 += i * i; }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const mean = sumY / n;
  const slopeNorm = mean !== 0 ? slope / Math.abs(mean) : 0;
  let variance = 0;
  for (let j = 0; j < n; j++) variance += Math.pow(hist[j] - mean, 2);
  const stdDev = Math.sqrt(variance / n);
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : 1;
  let roc = 0;
  if (n >= 3) {
    const rc = hist.slice(-3);
    roc = (rc[rc.length - 1] - rc[0]) / (rc.length - 1);
    roc = mean !== 0 ? roc / Math.abs(mean) : 0;
  }
  const stable = cv < 0.04 && Math.abs(slopeNorm) > 0.002;
  let tmin = hist[0], tmax = hist[0];
  for (let k = 1; k < n; k++) { if (hist[k] < tmin) tmin = hist[k]; if (hist[k] > tmax) tmax = hist[k]; }
  const t: TrendSnapshot = {
    slope, slopeNorm, stable, cv, mean, roc, min: tmin, max: tmax, range: tmax - tmin, n, insufficient: false,
  };
  t.trendStrength = tsFn ? tsFn(t, 'rise') : 0;
  return t;
}

function noop(): void { /* no-op */ }

// Schema-v1 serialization guard. The in-process VerdictResult may carry
// W2/W3/W4 provenance fields (family_A_shadow / family_C_verdict /
// family_D_shadow / family_E_verdict / fusion) that the on-disk v1 schema
// does not describe. Drop those at write time for v1 records; v2 records
// adopt them formally per audit/SCHEMA.md v2.
const SCHEMA_V1_STRIP_KEYS = new Set<string>([
  'family_A_shadow',
  'family_A_legacy_shadow',
  'family_C_verdict',
  'family_C_mmd_verdict',
  'family_D_shadow',
  'family_E_verdict',
  'fusion',
]);
function _schemaV1Replacer(key: string, value: unknown): unknown {
  if (SCHEMA_V1_STRIP_KEYS.has(key)) return undefined;
  return value;
}

// Schema-v2 serialization guard. v2 surfaces `families` as the normative
// per-family block; the in-process `family_*_shadow` / `family_*_verdict`
// keys and raw `fusion` are redundant projections, so strip them from
// gate_results.health to keep the on-disk record canonical (matches v2
// spec — fields live in top-level `families`, not inside gate_results).
const SCHEMA_V2_STRIP_KEYS = new Set<string>([
  'family_A_shadow',
  'family_A_legacy_shadow',
  'family_C_verdict',
  'family_C_mmd_verdict',
  'family_D_shadow',
  'family_E_verdict',
  'fusion',
]);
function _schemaV2Replacer(key: string, value: unknown): unknown {
  if (SCHEMA_V2_STRIP_KEYS.has(key)) return undefined;
  return value;
}

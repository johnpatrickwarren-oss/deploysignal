// engine/types/audit.ts — Audit writer contract, v1+v2 record shapes,
// detector registry, per-trip provenance, audit-event payloads.

import type {
  Verdict, Mode, RiskLevel, Author, ChangeType, TimeWindow, FamilyId,
} from './primitives';
import type { Metrics, Baseline, Flags, TrendSnapshot } from './metrics';
import type { GateResults } from './policy';
import type { VerdictGroupId, TopologyCandidate } from './verdict';
import type { ProposedAction } from './agent';
import type { CellKey } from './primitives';
import type { RecalibrationEventRecord } from './recalibration';

/** Audit writer contract — see engine/audit.ts. Accepts both v1 and v2
 *  records; writer dispatches serialization based on `schema_version`. */
export interface AuditWriter {
  write(record: AuditRecord | AuditRecordV2): void;
  close(): void;
}

/** Per-call options for audit-record construction. */
export interface AuditOpts {
  service?: string;
  mode?: Mode;
  trendStrength?: (t: TrendSnapshot, direction: 'rise' | 'fall') => number;
}

// ── Audit record (schema v1) ──────────────────────────────────────

/** A single tripped-signal entry in the audit record. */
export interface TrippedEntry {
  id: string;
  label: string;
  gate: 'health_rollback' | 'health_extend';
}

// ── Audit schema v2 registry + types (W4 §4.1.h) ──────────────────
//
// Per audit/SCHEMA.md v2. Shipped-in-W4 canonical detector_ids only; reserved
// entries live in the spec but aren't emitted. Readers that see an
// unknown_detector_id emit a warning and preserve the record.

/** Canonical detector_ids per family, as shipped in W4. Normative —
 *  audit writers pull from here; readers validate against it. */
export const DETECTOR_REGISTRY = {
  A: [
    // Legacy `mSPRT_*` ids — Page-CUSUM's canonical emission path
    // through W5. ARCHITECT-REPLY-34 D2 rewrites to `page_cusum_*` at
    // the REPLY-36 cleanup alongside demo expected_outcome updates;
    // kept as read-time aliases indefinitely for v1 replay compat.
    'mSPRT_p99_latency', 'mSPRT_ttft', 'mSPRT_eval_score',
    'mSPRT_tool_success_rate', 'mSPRT_downstream_err', 'mSPRT_cost_req',
    // Addition #17 (ARCHITECT-REPLY-34 D2) — forward-compat aliases
    // for the Page-CUSUM detector. Reserved for the REPLY-36 emission-
    // side rename; not produced by the audit writer in this PR.
    'page_cusum_p99_latency', 'page_cusum_ttft', 'page_cusum_eval_score',
    'page_cusum_tool_success_rate', 'page_cusum_downstream_err', 'page_cusum_cost_req',
    // Addition #17 — betting-based e-processes (Waudby-Smith & Ramdas
    // 2024 GRAPA + ONS fallback). Co-shipped alongside Page-CUSUM
    // under a 50/50 per-signal α split; fires emit
    // `betting_e_process_{signal}` in audit records.
    'betting_e_process_p99_latency', 'betting_e_process_ttft',
    'betting_e_process_eval_score', 'betting_e_process_tool_success_rate',
    'betting_e_process_downstream_err', 'betting_e_process_cost_req',
  ] as const,
  B: [
    'kv_saturation', 'hbm_elevation', 'hbm_spill_roll', 'mfu_collapse',
    'slowbleed', 'collective', 'capacity', 'gpu_eff', 'compound_lat',
    'tok_econ', 'behavioral', 'eval_quality_drop', 'refusal_spike',
    'output_len_drift', 'tool_call_degradation', 'quality_warning',
  ] as const,
  C: [
    'hotelling_t2_joint_vector', 'sequential_mmd', 'hotelling_t2_safe', 'sequential_mmd_e_process',
    // Q67 v2 canonical Shekhar-Ramdas-2023 betting-e-process (Addition #20).
    // Was previously unregistered — engine/_audit-families.ts's registry-
    // membership check fell through to the legacy `sequential_mmd` id for
    // its fires; see engine/guarantees.ts file header for the finding.
    'sequential_mmd_betting_e_process',
  ] as const,
  D: ['spectral_peak_acf_kv_cache', 'spectral_e_detector_kv_cache'] as const,
  E: ['mahalanobis_conformal_baseline'] as const,
} as const;

export type DetectorIdA = typeof DETECTOR_REGISTRY.A[number];
export type DetectorIdB = typeof DETECTOR_REGISTRY.B[number];
export type DetectorIdC = typeof DETECTOR_REGISTRY.C[number];
export type DetectorIdD = typeof DETECTOR_REGISTRY.D[number];
export type DetectorIdE = typeof DETECTOR_REGISTRY.E[number];
export type DetectorId = DetectorIdA | DetectorIdB | DetectorIdC | DetectorIdD | DetectorIdE;

/** Per-trip provenance (audit/SCHEMA.md v2 §Provenance). Populated from
 *  the cell consulted at detector evaluation time. */
export interface Provenance {
  cell_key: CellKey | null;
  cell_confidence: 'strict' | 'pooled' | 'aggregate' | 'none' | null;
  variance_inflated: boolean;
  /** Age in hours of CUPAC predictor applied; 0 when CUPAC isn't applied
   *  (current scope — no CUPAC in shipped detectors). */
  covariate_freshness: number;
  baseline_version: string;
  schema_continuity: 'continuous' | 'extended' | 'breaking' | 'observability_stack' | null;
  /** Addition #20 (REPLY-43b) — shrink fraction `c` used to derive
   *  τ² = c · trace(Σ) / p for Family C safe-Hotelling on the cell
   *  consulted. Populated only on records where safe-Hotelling fired
   *  (`detector_id === 'hotelling_t2_safe'`); absent otherwise. Replay
   *  consumers need this value to reproduce fire timings across
   *  different compiler runs. */
  family_c_shrink_fraction_used?: number;
}

/** v2 DetectorTrip. Replaces v1 TripEntry for v2 records; backward-compat
 *  projection lives in the top-level `tripped` array (flattened,
 *  family-then-detector-ordered). */
export interface DetectorTripV2 {
  family_id: FamilyId;
  detector_id: DetectorId;
  statistic: number | null;
  threshold: number | null;
  alpha_spent: number;
  reason_code: string;
  gate: 'health_rollback' | 'health_extend';
  label: string;
  provenance: Provenance;
  /** Family-A-only diagnostic: `S_n / threshold` normalized CUSUM progress.
   *  Absent on non-A families — they are per-tick single-shot tests. */
  cusum_progress?: number;
  /** Addition #13 audit enrichment — populated on Family A suppression
   *  records when `reason_code === 'ignore_threshold'`; names the signal
   *  whose in-band observation triggered the suppression. Family C/E do
   *  NOT emit this field (per ARCHITECT-REPLY-31 multivariate semantic:
   *  C/E evaluate the full joint vector regardless of ignore_thresholds,
   *  so there is no trigger signal to name). */
  ignore_threshold_trigger_signal?: string;
}

/** Per-family verdict record. One per family per tick, keyed off FamilyId. */
export interface FamilyVerdictV2 {
  verdict: 'fire' | 'indeterminate' | 'clean' | 'suppressed';
  detectors: DetectorTripV2[];
  alpha_spent: number;
  suppression_reason:
    | 'bake_profile'
    | 'cell_confidence_none'
    | 'schema_continuity_breaking'
    | 'observability_stack_deploy'
    | 'structural_mismatch'
    | 'ignore_threshold'
    | 'expected_failure_pattern'
    | null;
}

/** v2 audit record. Strict-additive over v1. v1 readers treat the v2
 *  fields as unknown and ignore; v2 readers consume them. */
export interface AuditRecordV2 extends Omit<AuditRecord, 'schema_version'> {
  schema_version: '2';
  fusion_topology: 'cascade' | 'portfolio';
  compiled_config_version: string;
  families: Record<FamilyId, FamilyVerdictV2>;
  reversibility: 'reversible' | 'forward_only' | 'conditional' | null;
  reversibility_source: 'platform_annotation' | 'default_fallback' | null;
  total_alpha_spent: number;
  /** Addition #15 (OQ-8) — type-only optional field mirroring the
   *  store's authoritative events.jsonl decision-log entry shape
   *  (engine/types/recalibration.ts's RecalibrationEventRecord) onto
   *  the per-tick audit record. audit/SCHEMA.md v2.1 documents this
   *  under "no writer-side commitment": no `AuditWriter` / `buildAuditRecord`
   *  code path populates this field in this project. The
   *  candidate-lifecycle store's events.jsonl (Task 6+) remains the
   *  authoritative decision log; this field exists so a FUTURE writer
   *  can attach the field without a schema-version bump, and so
   *  readers/tooling that join audit records against recalibration
   *  decisions have a stable optional field to look for. */
  recalibration_event?: RecalibrationEventRecord;
}

/** Persisted audit record — matches audit/SCHEMA.md v1. */
export interface AuditRecord {
  schema_version: '1';
  ts: string;
  service: string;
  tick: number;
  total_ticks: number;
  hours_elapsed: number;
  verdict: Verdict;
  reason: string;
  short_circuit: string | null;
  tripped: TrippedEntry[];
  inputs: Metrics;
  baseline: Baseline | {};
  scenario_ctx: {
    riskLevel?: RiskLevel;
    changeType?: ChangeType;
    author?: Author;
    timeWindow?: TimeWindow;
    flags?: Flags;
  };
  trend_snapshot: { [key: string]: TrendSnapshot } | null;
  policy_ctx_digest: string;
  mode: Mode;
  gate_results: GateResults;
  /** Week 6+ Addition #10 (SRM check): emitted at top level alongside the
   *  per-family blocks. `null` when the caller doesn't thread a
   *  `trafficAllocationContinuity` through OrchestrateParams (runway
   *  scenarios with fixed traffic_pct = 1.0 don't exercise SRM). Audit
   *  readers treat absence and explicit `null` identically. */
  traffic_allocation_continuity?: 'stable' | 'drifting' | 'breaking' | null;
  /** Raw history slices, computed-stats deferred to flush. Stripped before serialization. */
  _rawTrend?: { [key: string]: number[] } | null;
  /** Optional trendStrength fn passed through for lazy stat computation. */
  _tsFn?: ((t: TrendSnapshot, direction: 'rise' | 'fall') => number) | null;
}

// ── Addition #27 audit-event payloads ─────────────────────────────

/** Addition #27 audit-event payload — successful proposal emission.
 *  Strict-additive top-level event per REPLY-49 D6(d); parallels
 *  REPLY-47's VerdictGroup audit-event pattern. */
export interface AgentProposalEmittedAuditEvent {
  type: 'agent_proposal_emitted';
  verdict_group_id: string;
  proposal: ProposedAction;
  emitted_at_ts: number;
}

/** Addition #27 audit-event payload — downgrade (rail failure
 *  routes to evidence-only mode; no ProposedAction rendered). */
export interface AgentProposalDowngradedAuditEvent {
  type: 'agent_proposal_downgraded';
  verdict_group_id: string;
  /** Short identifier for downgrade cause — e.g., 'confidence_below_threshold',
   *  'schema_validation_failed_after_requery', 'rate_limit_hit'. */
  reason: string;
  rails_failed: Array<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'>;
  /** When the downgrade still ran the FM (e.g., low-confidence path),
   *  an evidence summary is included for oncall visibility. Absent on
   *  rail-f / rail-g failures where no FM invocation completed. */
  evidence_only_summary?: string;
  emitted_at_ts: number;
}

/** Audit-event payload emitted after a successful (or degraded)
 *  enrichment pass. Top-level audit event per REPLY-48 D4 (strict-
 *  additive, parallel to REPLY-47 D4 pattern — VerdictGroup record
 *  stays unchanged).
 *
 *  `top_candidate` is projected from `VerdictGroupWithTopology.
 *  candidates[0]` (highest-ranked per the overlap-desc / distance-asc /
 *  node-id-asc sort). `null` when the candidate list is empty. */
export interface VerdictGroupEnrichedWithTopologyAuditEvent {
  type: 'verdict_group_enriched_with_topology';
  group_id: VerdictGroupId;
  topology_source_id: string;
  topology_snapshot_hash: string | null;
  n_candidates: number;
  top_candidate: TopologyCandidate | null;
  enriched_at_ts: number;
  enrichment_error: string | null;
}

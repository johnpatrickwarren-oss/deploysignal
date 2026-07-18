// engine/types/recalibration.ts — Addition #15 baseline-maintenance
// lifecycle. Contract types for the candidate-recalibration flow: a
// drift/calendar/operator trigger proposes a CANDIDATE baseline; it
// moves through readiness -> shadow validation -> review before ever
// touching the active baseline (plan §B D3 — triggers create
// candidates, never mutate the active baseline directly).
//
// Types below are transcribed verbatim per the approved implementation
// plan (deploysignal-addition-15-IMPLEMENTATION_PLAN.md §C Task 2) —
// exact field names/shapes, not paraphrased. Pure type/const contract:
// no fs, no I/O (D6 — engine/tools split; file I/O lives in
// tools/recalibrate/ per a later task).
//
// See engine/recalibration/state-machine.ts for the pure lifecycle
// transition function operating on CandidateRecord.

/** Aggregate verdict comparing a candidate's signal means against the
 *  active baseline (engine/recalibration/classify.ts, Task 3). */
export type DirectionClassification = 'improvement' | 'degradation' | 'mixed';

/** Per-signal verdict feeding the aggregate DirectionClassification. */
export type PerSignalDirection = 'improved' | 'degraded' | 'unchanged';

/** Closed set of terminal-decision outcomes recorded on a
 *  CandidateRecord once review_status reaches 'decided'. */
export type RecalibrationOutcome =
  | 'auto_promoted'
  | 'operator_approved'
  | 'operator_rejected'
  | 'timeout_rejected'
  | 'shadow_mode_failed';

/** Candidate's position relative to the active baseline pointer. */
export type CandidateStatus = 'candidate' | 'active' | 'rejected' | 'superseded';

/** Candidate's position in the review pipeline, independent of
 *  CandidateStatus (e.g. a 'candidate' can be 'pending_readiness',
 *  'pending_shadow', or 'reviewable'; 'decided' applies once a
 *  terminal CandidateStatus — active/rejected — is reached). */
export type ReviewStatus = 'pending_readiness' | 'pending_shadow' | 'reviewable' | 'decided';

/** What triggered candidate creation (plan §B D1/D2/D3). */
export type CreationReason = 'drift_detected' | 'calendar_safety_net' | 'operator_manual';

/** Closed set of operator-facing reason codes for why a recalibration
 *  is legitimate (approve/reject) or is suggested by degradation/mixed
 *  classification (CandidateRecord.suggested_reason_codes). */
export const RECALIBRATION_REASON_CODES = [
  'feature_complexity_growth',
  'hardware_cohort_shift',
  'traffic_mix_change',
  'safety_check_addition',
  'upstream_dependency',
  'other_legitimate',
  'regression',
] as const;

/** A reason code drawn from the closed RECALIBRATION_REASON_CODES set. */
export type RecalibrationReasonCode = typeof RECALIBRATION_REASON_CODES[number];

export interface RecalibrationCandidate {
  candidate_id: string;
  proposed_baseline_version: string;
  current_baseline_version: string;
  direction_classification: DirectionClassification;
  per_signal_direction: Record<string, PerSignalDirection>;
  suggested_reason_codes: string[];
  shadow_mode_validated_at: string | null;
  timeout_at: string;
}

export interface RecalibrationApproval {
  candidate_id: string;
  operator_id: string;
  reason_code: string;
  approved_at: string;
}

/** Authoritative decision-log entry shape (store's events.jsonl, plan
 *  §B store layout — RecalibrationLifecycleEvent). Also the type-only
 *  optional field mirrored onto AuditRecordV2 (plan §A7/OQ-8). */
export interface RecalibrationEventRecord {
  candidate_id: string;
  outcome: RecalibrationOutcome;
  operator_id?: string;
  reason_code?: string;
}

/** One append-only entry in CandidateRecord.history. `action` is a
 *  superset of the state machine's transition events — 'created' and
 *  'rolled_back' are appended by the store (Task 6), not the state
 *  machine itself. */
export interface ReviewHistoryEntry {
  at: string;
  actor: string;
  action:
    | 'created'
    | 'readiness_passed'
    | 'readiness_failed'
    | 'shadow_validated'
    | 'shadow_failed'
    | 'approved'
    | 'rejected'
    | 'timeout_rejected'
    | 'auto_promoted'
    | 'superseded'
    | 'rolled_back';
  reason_code?: string;
  comment?: string;
}

/** The full persisted candidate record (candidates/<id>.json, plan §B
 *  store layout). Extends RecalibrationCandidate with storage/lifecycle
 *  metadata. `drift_output` / `readiness` / `comparison` are `object`
 *  at this layer deliberately — they're populated by later tasks
 *  (drift-detector output, Task 4 readiness gates, Task 4 comparison)
 *  and this module must not import tools/ or take on those shapes as a
 *  dependency (D6). */
export interface CandidateRecord extends RecalibrationCandidate {
  schema_version: '1';
  service_id: string;
  status: CandidateStatus;
  review_status: ReviewStatus;
  creation_reason: CreationReason;
  created_at: string;
  source_window: {
    start: string;
    end: string;
    n_samples: number;
    excluded_windows_applied: number;
  };
  compiled_config_path: string;
  drift_output?: object;
  readiness?: object;
  comparison?: object;
  shadow_report_path?: string;
  /** R5 live shadow soak — ADDITIONAL evidence only (R-Q4: complements,
   *  never replaces, replay shadow validation; never gates reviewable).
   *  Written exclusively by the recalibrate CLI (soak stop fold). */
  soak?: CandidateSoakEvidence;
  outcome: RecalibrationOutcome | null;
  history: ReviewHistoryEntry[];
}

// ── R5 live shadow soak (plan §3 Task 1) ───────────────────────────────
// Additive-only types for the candidate-shadow-soak flow: a service-side
// SoakController (service/gate-http/_gate-soak.ts) shadow-evaluates a
// candidate CompiledConfig alongside every served tick and accumulates
// disagreement/coverage stats into a per-candidate sidecar; the
// recalibrate CLI (tools/recalibrate/_recalibrate-soak.ts) owns the
// soak.json manifest and folds the sidecar onto CandidateRecord.soak at
// `soak stop`. See §1 of the implementation plan for the per-file
// single-writer doctrine governing which side writes which file.

export interface SoakWindow { target_ticks: number; max_duration_seconds?: number; }

export type SoakManifestStatus = 'requested' | 'stopped';
export interface SoakManifest {          // soak.json — CLI-owned
  schema_version: '1';
  candidate_id: string;
  requested_at: string;
  requested_by: string;
  window: SoakWindow;
  status: SoakManifestStatus;
  stopped_at?: string;
  stopped_by?: string;
}

export interface SoakVoidEntry { at: string; reason: 'service_restart'; note?: string; }

export interface SoakDisagreementStats {
  total_compared: number;              // ticks where BOTH evaluations succeeded
  verdict_disagreements: number;
  by_pair: Record<string, number>;     // "active->candidate", e.g. "extend->rollback"
  would_be_rollback: { active_only: number; candidate_only: number; both: number };
}

export interface SoakFamilyAttribution { active_fires: number; candidate_fires: number; }

export interface SoakCoverageStats {
  sessions_enrolled: number;
  sessions_skipped_midstream: number;  // soak started mid-session; skipped for warm-up fairness
  first_tick_ts: number | null;
  last_tick_ts: number | null;
  active_errored_ticks: number;
  candidate_errored_ticks: number;
}

export interface SoakAccumulation {
  ticks_observed: number;
  disagreement: SoakDisagreementStats;
  per_family: Record<'A' | 'B' | 'C' | 'D' | 'E', SoakFamilyAttribution>;
  alpha_spent: { active_total: number; candidate_total: number };
  coverage: SoakCoverageStats;
}

export type SoakSidecarStatus = 'accumulating' | 'complete';
export interface SoakSidecar {           // soak/<id>.state.json — service-owned
  schema_version: '1';
  candidate_id: string;
  window: SoakWindow;
  started_at: string;
  last_updated_at: string;
  status: SoakSidecarStatus;
  completed_at: string | null;
  stats: SoakAccumulation;
  voids: SoakVoidEntry[];
}

export interface CandidateSoakEvidence { // CandidateRecord.soak — CLI-folded snapshot
  sidecar: SoakSidecar;
  folded_at: string;
  folded_by: string;
  stopped_early: boolean;                // stopped before window.target_ticks reached
}

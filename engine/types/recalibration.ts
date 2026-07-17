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
  outcome: RecalibrationOutcome | null;
  history: ReviewHistoryEntry[];
}

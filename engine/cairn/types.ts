// engine/cairn/types.ts — Cairn (Addition #30 / PRD-30 / Q30) typed contracts.
//
// Structured RCA / postmortem attribution layer of the DS bundle. Closes
// the lifecycle loop: DS catches at gate-time, Tessera observes during
// steady state, Cairn attributes when a regression escapes both.

/** A single cause-event candidate that Cairn considers. */
export interface AttributionCandidate {
  cause_id: string;
  cause_kind: CandidateKind;
  /** Unix-seconds when the cause-event happened. */
  timestamp_unix: number;
  /** Provenance — pointer back to the source audit record / experiment /
   *  webhook payload. Replay/postmortem trace artifact. */
  evidence_ref: string;
  /** Optional metadata that ingest helpers populate when available. */
  metadata?: CandidateMetadata;
}

export type CandidateKind =
  | 'deploy'              // DS audit record
  | 'chaos_experiment'    // Anvil ExpectedFailurePattern
  | 'dependency_change'   // generic external event
  | 'env_change'          // generic external event (config rollout, infra)
  | 'shard_event'         // Tessera per-shard observation
  | 'generic';            // catch-all for external webhooks

export interface CandidateMetadata {
  /** When the candidate came from a DS audit record, the engine's verdict
   *  drives the evidence-quality boost (Q30.3 architect-pick). */
  ds_verdict?: 'proceed' | 'extend' | 'rollback' | 'baking';
  /** When DS evaluated the candidate, fraction of the deploy's α budget
   *  the engine consumed. Used in negative-evidence sharpening. */
  ds_alpha_consumed_ratio?: number;
  /** Anvil-only: pattern.kind of the chaos experiment. */
  expected_failure_kind?: string;
  /** Free-form passthrough — Tessera VerdictGroupId, incident-mgmt
   *  payload, descriptions, source identifiers, etc. */
  extra?: Record<string, unknown>;
}

/** Operator's description of the incident under attribution. */
export interface IncidentDefinition {
  incident_id: string;
  /** Best-known onset time (incident-mgmt alert ts, oncall report). */
  onset_time_unix: number;
  /** Signal(s) that exhibited the regression. */
  affected_signals: string[];
  regression_magnitude_unit?: 'relative_fraction' | 'absolute' | 'sigma';
  regression_magnitude?: number;
  /** Optional engine-inferred onset distribution (DS audit record's
   *  Page-CUSUM fire-tick + confidence band, or BOCPD run-length
   *  posterior). When present, supersedes onset_time_unix for kernel
   *  evaluation per Q30.1 architect-pick. */
  engine_onset_estimate?: {
    center_unix: number;
    sigma_seconds: number;
  };
}

export interface CairnScoringConfig {
  /** Gaussian-kernel bandwidth per cause-kind, in seconds. Per Q30.2. */
  kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>;
  /** Per-kind prior. */
  kind_prior?: Partial<Record<CandidateKind, number>>;
  /** Grace window post-incident; candidates with timestamp in
   *  [onset, onset + grace_seconds] are still considered (clock skew,
   *  delayed event-recording). Default 60 seconds. */
  grace_seconds?: number;
  /** Operator-tunable evidence-quality boost (Q30.3). */
  evidence_boost?: Partial<Record<'proceed' | 'extend' | 'rollback' | 'baking', number>>;
}

export interface ScoredCandidate {
  candidate: AttributionCandidate;
  /** Normalized posterior (sums to 1.0 across the ranked set). */
  posterior: number;
  /** Raw unnormalized score (kernel × prior × evidence). */
  raw_score: number;
  /** Per-component breakdown for audit + UI. */
  kernel_value: number;
  kind_prior: number;
  evidence_boost: number;
}

export interface SuppressedCandidate {
  candidate: AttributionCandidate;
  suppression_reason:
    | 'post_incident_timestamp'   // timestamp after onset + grace
    | 'kernel_underflow';         // kernel value below numerical threshold
}

export interface RankedAttribution {
  /** Sorted by posterior descending; ties broken by timestamp ascending
   *  for replay determinism. */
  ranked: ScoredCandidate[];
  /** Excluded from posterior normalization. */
  suppressed: SuppressedCandidate[];
  /** Echo of the incident under attribution. */
  incident: IncidentDefinition;
  /** Echo of the effective config (defaults filled in). */
  config_used: {
    kernel_sigma_seconds: Record<CandidateKind, number>;
    kind_prior: Record<CandidateKind, number>;
    grace_seconds: number;
    evidence_boost: Record<'proceed' | 'extend' | 'rollback' | 'baking', number>;
  };
}

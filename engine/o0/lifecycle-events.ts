// engine/o0/lifecycle-events.ts — Addition #14 O0 lifecycle event contract.
//
// Per NORTH-STAR-ARCHITECTURE.md Addition #14 and ARCHITECT-REPLY-31
// implementation brief. Five event types emitted at well-defined
// gate-lifecycle transitions:
//
//   evaluation.triggered  — deploy starts; emitted once per deploy.
//   evaluation.started    — first tick cell identified; emitted once.
//   evaluation.tick       — per-tick verdict + audit record. High-frequency.
//   evaluation.suppressed — emitted only on non-suppressed → suppressed
//                           per-family transition (NOT every tick a
//                           family is suppressed). Prevents event spam.
//   evaluation.finished   — final verdict; emitted once per deploy.
//
// Runway ships the contract plus two minimal implementations:
//   - NoOpLifecycleEventEmitter: default; zero side effects. Backward
//     compat hard gate — deploys with the emitter unset observe zero
//     behavior change vs pre-#14.
//   - InMemoryLifecycleEventEmitter: testing fixture. Records events,
//     fans out to registered listeners, isolates listener errors
//     per-listener (a throwing listener does not break the deploy flow
//     nor prevent other listeners from receiving the event).
//
// Real-orchestrator adapters (Argo Kubernetes Events, Spinnaker pipeline
// notifications, MLflow tags, webhook POSTs) are for follow-on or follow-up
// briefs — NOT shipped in the project per brief anti-scope.

import type {
  AuditRecord, AuditRecordV2, CellKey, FamilyId, Verdict,
} from '../types';
import type { DirectionClassification } from '../types/recalibration';

/** Five-value enum of lifecycle event types. */
export type LifecycleEventType =
  | 'evaluation.triggered'
  | 'evaluation.started'
  | 'evaluation.tick'
  | 'evaluation.suppressed'
  | 'evaluation.finished'
  // Consolidated activation slice — post-L3 events:
  | 'verdict_group.closed'
  | 'verdict_group.updated'
  | 'verdict_group.topology_enriched'
  | 'agent_proposal.emitted'
  | 'agent_proposal.downgraded'
  // Addition #15 — baseline-maintenance candidate lifecycle events.
  // Strict-additive (plan §C Task 5); test/lifecycle-events.test.ts's
  // local 5-element array is unaffected.
  | 'recalibration.proposed'
  | 'recalibration.shadow_validated'
  | 'recalibration.operator_approved'
  | 'recalibration.operator_rejected'
  | 'recalibration.auto_promoted'
  | 'recalibration.timeout_rejected';

export interface TriggeredPayload {
  type: 'evaluation.triggered';
  deploy_id: string;
  service_id: string;
  compiled_config_version: string;
  expected_window_ticks: number;
  risk_tier: string;
}

export interface StartedPayload {
  type: 'evaluation.started';
  deploy_id: string;
  cell_key: CellKey | null;
  cell_confidence: string;
  families_eligible: FamilyId[];
}

export interface TickPayload {
  type: 'evaluation.tick';
  deploy_id: string;
  tick: number;
  audit_record: AuditRecord | AuditRecordV2;
}

export interface SuppressedPayload {
  type: 'evaluation.suppressed';
  deploy_id: string;
  tick: number;
  family_id: FamilyId;
  suppression_reason: string;
}

export interface FinishedPayload {
  type: 'evaluation.finished';
  deploy_id: string;
  final_verdict: Verdict;
  total_alpha_spent: number;
  families_summary: Record<string, { verdict: string; alpha_spent: number }>;
  divergence_from_spec?: string;
}

// Consolidated activation slice — post-L3 event payloads. Strict-
// additive alongside the original five evaluation.* events.

export interface VerdictGroupClosedPayload {
  type: 'verdict_group.closed';
  deploy_id: string;
  group_id: string;
  window_start_ts: number;
  window_end_ts: number;
  verdict_count: number;
  firing_family_count: number;
  root_cause_detector_id: string | null;
  confidence: number;
  closed_at_ts: number | null;
}

export interface VerdictGroupUpdatedPayload {
  type: 'verdict_group.updated';
  deploy_id: string;
  group_id: string;
  late_arrival_count: number;
  late_arrival_at_ts: number;
}

export interface VerdictGroupTopologyEnrichedPayload {
  type: 'verdict_group.topology_enriched';
  deploy_id: string;
  group_id: string;
  topology_source_id: string;
  topology_snapshot_hash: string | null;
  candidate_count: number;
  enrichment_error?: string;
}

export interface AgentProposalEmittedPayload {
  type: 'agent_proposal.emitted';
  deploy_id: string;
  group_id: string;
  proposed_action_id: string;
  playbook_category: string;
  confidence: number;
}

export interface AgentProposalDowngradedPayload {
  type: 'agent_proposal.downgraded';
  deploy_id: string;
  group_id: string;
  rails_failed: string[];
  downgrade_reason?: string;
}

// Addition #15 — baseline-maintenance candidate lifecycle event
// payloads. Strict-additive alongside the evaluation.* / verdict_group.*
// / agent_proposal.* events above (plan §C Task 5).
//
// Base fields shared by every recalibration.* payload: which candidate,
// which service, which baseline versions are in play, and the
// classification (engine/recalibration/classify.ts, Task 3) that drove
// the candidate's path. `RecalibrationEventBasePayload` is not itself a
// union member — each concrete payload below extends it with its own
// `type` discriminant plus event-specific extras.
interface RecalibrationEventBasePayload {
  service_id: string;
  candidate_id: string;
  proposed_baseline_version: string;
  current_baseline_version: string;
  direction_classification: DirectionClassification;
  at: string;
}

export interface RecalibrationProposedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.proposed';
}

export interface RecalibrationShadowValidatedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.shadow_validated';
  shadow_report_path: string;
}

export interface RecalibrationOperatorApprovedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.operator_approved';
  operator_id: string;
  reason_code: string;
}

export interface RecalibrationOperatorRejectedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.operator_rejected';
  operator_id: string;
  reason_code: string;
}

export interface RecalibrationAutoPromotedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.auto_promoted';
}

/** OQ-6: escalation is an embedded object on the timeout_rejected
 *  payload rather than a seventh event type — D1's lazy-timeout sweep
 *  (Task 7) always escalates a default-rejected candidate to
 *  engineering leadership, so the escalation fact and the rejection
 *  fact are one event, not two. */
export interface RecalibrationEscalation {
  escalated: boolean;
  escalated_to: string;
}

export interface RecalibrationTimeoutRejectedPayload extends RecalibrationEventBasePayload {
  type: 'recalibration.timeout_rejected';
  escalation: RecalibrationEscalation;
}

/** Tagged union discriminated on `type`. Payload shape is statically
 *  guaranteed consistent with the `type` field — subscribers can narrow
 *  via `if (event.payload.type === 'evaluation.tick') { ... }`. */
export type LifecycleEventPayload =
  | TriggeredPayload
  | StartedPayload
  | TickPayload
  | SuppressedPayload
  | FinishedPayload
  | VerdictGroupClosedPayload
  | VerdictGroupUpdatedPayload
  | VerdictGroupTopologyEnrichedPayload
  | AgentProposalEmittedPayload
  | AgentProposalDowngradedPayload
  | RecalibrationProposedPayload
  | RecalibrationShadowValidatedPayload
  | RecalibrationOperatorApprovedPayload
  | RecalibrationOperatorRejectedPayload
  | RecalibrationAutoPromotedPayload
  | RecalibrationTimeoutRejectedPayload;

/** The contract. Real adapters (Argo, Spinnaker, MLflow, webhooks) and
 *  the test-fixture in-memory adapter both implement this. Returns a
 *  Promise so adapters that do I/O can await their transport; the
 *  orchestrator emits fire-and-forget (no await in the hot decision
 *  path). */
export interface LifecycleEventEmitter {
  emit(event_type: LifecycleEventType, payload: LifecycleEventPayload): Promise<void>;
}

/** Default emitter. Every method is a no-op. Used by the orchestrator
 *  when a caller doesn't pass a real emitter — backward compat hard
 *  gate. */
export class NoOpLifecycleEventEmitter implements LifecycleEventEmitter {
  async emit(_event_type: LifecycleEventType, _payload: LifecycleEventPayload): Promise<void> {
    // intentional no-op
  }
}

export interface RecordedLifecycleEvent {
  type: LifecycleEventType;
  payload: LifecycleEventPayload;
  at: number;
}

type Listener = (event: RecordedLifecycleEvent) => void;

/** In-memory emitter for tests and any harness that wants to inspect
 *  emitted events programmatically.
 *
 *  - `emit()` appends the event to an internal list and fans it out to
 *    registered listeners. Listener errors are isolated per-listener via
 *    try/catch — a throwing listener does NOT prevent other listeners
 *    from receiving the event nor break the deploy flow.
 *  - Listeners are invoked in registration order (predictable for
 *    debugging per ARCHITECT-REPLY-31 Open Q3 architect default).
 *  - `reset()` clears both the event buffer and the listener list —
 *    convenient for test isolation. */
export class InMemoryLifecycleEventEmitter implements LifecycleEventEmitter {
  private events: RecordedLifecycleEvent[] = [];
  private listeners: Listener[] = [];

  async emit(event_type: LifecycleEventType, payload: LifecycleEventPayload): Promise<void> {
    const event: RecordedLifecycleEvent = { type: event_type, payload, at: Date.now() };
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (_err) {
        // Isolate listener-side errors — one throwing listener must not
        // prevent other listeners from receiving the event, nor break
        // the deploy flow. Brief anti-scope: no third persistence path
        // for errors; subscribers own their own error channels.
      }
    }
  }

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  getEvents(): RecordedLifecycleEvent[] {
    return [...this.events];
  }

  reset(): void {
    this.events = [];
    this.listeners = [];
  }
}

/** Per-deploy lifecycle state threaded across ticks. The orchestrator
 *  is single-tick; this object carries the "once-per-deploy emit
 *  latches" and the per-family suppression state needed to fire
 *  `evaluation.suppressed` only on non-suppressed → suppressed
 *  transitions rather than every tick. Caller creates fresh per deploy. */
export interface LifecycleDeployState {
  triggeredEmitted: boolean;
  startedEmitted: boolean;
  finishedEmitted: boolean;
  /** Previous tick's per-family suppression state. Keys are the five
   *  canonical family IDs; value is `true` if the family-level verdict
   *  was `'suppressed'` on the most recent tick. Used to detect the
   *  non-suppressed → suppressed transition. */
  perFamilySuppressionState: Record<FamilyId, boolean>;
}

export function freshLifecycleState(): LifecycleDeployState {
  return {
    triggeredEmitted: false,
    startedEmitted: false,
    finishedEmitted: false,
    perFamilySuppressionState: { A: false, B: false, C: false, D: false, E: false },
  };
}

/** Fire-and-forget wrapper so the orchestrator hot path doesn't await
 *  the emitter's Promise. Catches both synchronous throws and async
 *  rejections to avoid unhandled-rejection warnings. Visible for
 *  testing but primarily an internal helper. */
export function safeEmit(
  emitter: LifecycleEventEmitter,
  event_type: LifecycleEventType,
  payload: LifecycleEventPayload,
): void {
  try {
    const result = emitter.emit(event_type, payload);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => { /* swallow */ });
    }
  } catch (_err) {
    // Synchronous throw from emit() — swallow. Real adapters are
    // expected to handle their own error paths; the engine must not
    // crash on emitter failures.
  }
}

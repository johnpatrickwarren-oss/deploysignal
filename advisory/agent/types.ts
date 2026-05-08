// advisory/agent/types.ts — Addition #27 agentic rollback module.
//
// Module-internal types for the agent layer (FM adapters, playbook
// entries, propose() I/O). Cross-module audit-visible types
// (ProposedAction, ConfiguredAgent, AgentProposalEmittedAuditEvent,
// AgentProposalDowngradedAuditEvent) live in `engine/types.ts` so
// audit consumers can import them without pulling the agent module.

import type {
  ProposedAction, ReversibilityClassification, VerdictGroup,
  VerdictGroupWithTopology,
} from '../../engine/types';

export type RailName = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

/** Mirror of `playbooks/schema/playbook.schema.json`. Loaded from
 *  YAML by `advisory/agent/playbook.ts`. */
export interface Playbook {
  id: string;
  version: string;
  applies_when: {
    firing_families: Array<'A' | 'B' | 'C' | 'D' | 'E'>;
    min_family_count: number;
    verdict_class: 'rollback' | 'extend' | 'both';
  };
  reversibility_required: 'reversible' | 'forward_only' | 'any';
  confidence_threshold: number;
  orchestrator_command_template: string;
  human_description: string;
  expected_effect: string;
  category: 'rollback' | 'pause' | 'suppress' | 'scale' | 'widen_budget';
}

/** Input handed to the FM adapter at propose() time. Assembled by
 *  `AgentProposer.propose()` from the VerdictGroup (+ optional
 *  topology enrichment) + deploy context + the rail-e-filtered
 *  playbook subset. */
export interface AgentInputContext {
  verdict_group: VerdictGroup;
  /** Optional enrichment provenance (from #26 TopologyEnricher).
   *  Absent when topology overlay is disabled or enrichment failed. */
  verdict_group_with_topology?: VerdictGroupWithTopology;
  reversibility_classification: ReversibilityClassification;
  /** Playbook list AFTER rail (e) filter — FM never sees inapplicable
   *  entries. This is the HARD invariant boundary; downstream rails
   *  can only tighten further, not re-introduce filtered entries. */
  playbook_candidates: Playbook[];
  /** Optional service metadata for template rendering (rollout name,
   *  namespace, escalation policy, etc.). */
  service_metadata?: Record<string, string>;
}

export interface AgentResult {
  /** `null` when downgraded to evidence-only mode. */
  proposal: ProposedAction | null;
  downgraded_to_evidence_only: boolean;
  /** Rail names that failed evaluation and triggered downgrade.
   *  Empty when `proposal` is non-null and no downgrade occurred. */
  rails_failed: RailName[];
  /** Populated on downgrade paths; short identifier matching
   *  `AgentProposalDowngradedAuditEvent.reason`. */
  downgrade_reason?: string;
  /** Present on downgrade paths when the FM ran but the proposal
   *  failed a rail; renders as evidence-only in oncall UI. */
  evidence_only_summary?: string;
}

// ── FmAdapter contract ──────────────────────────────────────────────

/** Abstract adapter for foundation-model invocation. Parallels
 *  REPLY-48's `TopologySource` interface pattern (new concrete impls
 *  land without AgentProposer changes). v1 concrete adapters:
 *  `StubAdapter` (tests + v1 acceptance), `MosaicNativeAdapter`
 *  (contract-only stub for MLflow/UC v1), `ClaudeBedrockAdapter`
 *  (contract-only stub for Bedrock v1). Real wiring is deferred
 *  per D5. */
export interface FmAdapter {
  readonly id: string;
  readonly vendor: 'mosaic_native' | 'claude_bedrock' | 'stub';
  /** Invoke the FM with a system prompt + structured-output schema
   *  describing the `ProposedAction` contract. Returns the raw
   *  structured-output JSON (caller runs rail-f validation). */
  invokeStructured(
    ctx: AgentInputContext,
    schema: unknown,
  ): Promise<unknown>;
}

/** Stub FM adapter — returns pre-scripted responses from a simple
 *  request → response mapping injected at construction. Used across
 *  the test harness + as the v1 default when `agent.fm_vendor` is
 *  unset or explicitly `'stub'`. */
export interface StubScript {
  /** Function that computes the response from the input context.
   *  Lets tests script behavior like "return malformed output for
 *  the first two calls, then valid" without mutating global state. */
  respond(ctx: AgentInputContext, callCount: number): unknown;
}

// ── ProposerOpts ────────────────────────────────────────────────────

export interface ProposerOpts {
  adapter: FmAdapter;
  playbooks: Playbook[];
  /** Confidence threshold floor per rail (c). Default 0.7. */
  confidence_threshold?: number;
  /** Rail (f) — allow one re-query on schema validation failure before
   *  downgrading to evidence-only. Default true. */
  allow_requery_on_schema_failure?: boolean;
  /** Injected clock for deterministic audit timestamps in tests. */
  now?: () => number;
}

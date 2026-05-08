// advisory/agent/proposer.ts — Addition #27 AgentProposer orchestrator.
//
// Composes FM adapter + playbook library + safety rails into a single
// propose() entry point. Orchestrator integration (slice-2) calls
// propose() async post-VerdictGroup-close; v1 adapter is StubAdapter
// or the contract-only MosaicNative/ClaudeBedrock stubs.
//
// Rail ordering within propose():
//   1. Caller pre-filters playbook via filterPlaybookByReversibility
//      (rail e, HARD invariant, enforced at AgentInputContext
//      construction).
//   2. Rate-limit (rail g) enforced at call-site (orchestrator keyed
//      by VerdictGroup.group_id); propose() assumes the caller
//      cleared the gate.
//   3. FM invocation via adapter.invokeStructured(ctx, schema).
//   4. Rail (f) schema validation on the adapter response. On
//      failure, re-query once (if allow_requery_on_schema_failure);
//      second failure → downgrade to evidence-only.
//   5. evaluateRails (a, b, c, d) on the parsed ProposedAction.
//      Any failure → downgrade to evidence-only; mark rails_failed.
//   6. Return AgentResult.

import type { ProposedAction } from '../../engine/types';
import { validateAgainstSchema } from './schema-validator';
import type { SchemaNode } from './schema-validator';
import { evaluateRails } from './safety-rails';
import type {
  AgentInputContext, AgentResult, FmAdapter, Playbook, ProposerOpts,
  RailName,
} from './types';

/** Schema used to validate the FM's structured output at rail (f).
 *  Narrower than the full `engine/types.ts` ProposedAction type
 *  (schema-level — no TS compile-time guarantees on runtime values).
 *  Draft-07 subset covered by `advisory/agent/schema-validator.ts`.
 *
 *  Exported for tests that want to exercise schema-validation paths
 *  directly without building a full AgentProposer. */
export const PROPOSED_ACTION_SCHEMA: SchemaNode = {
  type: 'object',
  required: [
    'proposed_action_id', 'playbook_category', 'cited_evidence',
    'confidence', 'human_summary', 'orchestrator_command',
    'rails_passed',
  ],
  additionalProperties: false,
  properties: {
    proposed_action_id: { type: 'string', minLength: 1 },
    playbook_category: {
      enum: ['rollback', 'pause', 'suppress', 'scale', 'widen_budget'],
    },
    cited_evidence: {
      type: 'object',
      required: [
        'cited_verdict_group_id', 'cited_reversibility',
        'cited_firing_families', 'cited_alpha_consumed_per_family',
        'cited_cell_keys',
      ],
      additionalProperties: false,
      properties: {
        cited_verdict_group_id: { type: 'string', minLength: 1 },
        cited_topology_candidate_ids: { type: 'array', items: { type: 'string' } },
        cited_reversibility: {
          enum: ['reversible', 'forward_only', 'conditional'],
        },
        cited_firing_families: {
          type: 'array',
          items: { enum: ['A', 'B', 'C', 'D', 'E'] },
        },
        cited_alpha_consumed_per_family: {
          type: 'object',
          additionalProperties: false,
          properties: {
            A: { type: 'number', minimum: 0 },
            B: { type: 'number', minimum: 0 },
            C: { type: 'number', minimum: 0 },
            D: { type: 'number', minimum: 0 },
            E: { type: 'number', minimum: 0 },
          },
        },
        cited_cell_keys: { type: 'array', items: { type: 'string' } },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    human_summary: { type: 'string', minLength: 1 },
    orchestrator_command: { type: 'string', minLength: 1 },
    rails_passed: {
      type: 'array',
      items: { enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    },
  },
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export class AgentProposer {
  private readonly adapter: FmAdapter;
  private readonly playbooks: Playbook[];
  private readonly playbooksById: Map<string, Playbook>;
  private readonly confidence_threshold: number;
  private readonly allow_requery_on_schema_failure: boolean;
  private readonly now: () => number;

  constructor(opts: ProposerOpts) {
    this.adapter = opts.adapter;
    this.playbooks = opts.playbooks;
    this.playbooksById = new Map(opts.playbooks.map((p) => [p.id, p]));
    this.confidence_threshold = opts.confidence_threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.allow_requery_on_schema_failure = opts.allow_requery_on_schema_failure ?? true;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Public for tests + orchestrator integration-level visibility. */
  adapterForTest(): FmAdapter { return this.adapter; }
  playbookByIdForTest(id: string): Playbook | undefined { return this.playbooksById.get(id); }

  /** Propose a recovery action for the given input context. Async;
   *  orchestrator fires without awaiting per REPLY-49 post-close hook.
   *  Never throws — any rail failure (including adapter error) maps
   *  to a downgraded AgentResult that the caller audits via
   *  `agent_proposal_downgraded`. */
  async propose(ctx: AgentInputContext): Promise<AgentResult> {
    // Rail (f) first attempt.
    let rawOutput: unknown;
    try {
      rawOutput = await this.adapter.invokeStructured(ctx, PROPOSED_ACTION_SCHEMA);
    } catch (err) {
      return this._downgrade(
        ['f'],
        'fm_invocation_failed',
        `FM adapter threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let validationResult = validateAgainstSchema(rawOutput, PROPOSED_ACTION_SCHEMA);

    // Rail (f) single re-query on schema failure (architect Q1 lean).
    if (!validationResult.valid && this.allow_requery_on_schema_failure) {
      try {
        rawOutput = await this.adapter.invokeStructured(ctx, PROPOSED_ACTION_SCHEMA);
        validationResult = validateAgainstSchema(rawOutput, PROPOSED_ACTION_SCHEMA);
      } catch (err) {
        return this._downgrade(
          ['f'],
          'fm_requery_failed',
          `FM adapter threw on re-query: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!validationResult.valid) {
      return this._downgrade(
        ['f'],
        'schema_validation_failed_after_requery',
        `FM output failed schema validation after re-query: ${validationResult.errors.join('; ')}`,
      );
    }

    const proposal = rawOutput as ProposedAction;
    // Evaluate post-FM rails (a, b, c, d). Rails e/f/g are marked
    // passed by evaluateRails since the proposer-side gates cleared
    // them already.
    const railResult = evaluateRails(
      proposal,
      ctx,
      this.playbooksById,
      this.confidence_threshold,
    );
    if (railResult.failed.length > 0) {
      return {
        proposal: null,
        downgraded_to_evidence_only: true,
        rails_failed: railResult.failed,
        downgrade_reason: railResult.downgrade_reason ?? 'rails_failed',
        evidence_only_summary: proposal.human_summary,
      };
    }

    // All rails cleared — stamp rails_passed on the emitted proposal.
    // The FM's own `rails_passed` field is advisory; we overwrite
    // with our post-evaluation result so audit consumers see the
    // authoritative rail set.
    return {
      proposal: { ...proposal, rails_passed: railResult.passed },
      downgraded_to_evidence_only: false,
      rails_failed: [],
    };
  }

  private _downgrade(
    rails_failed: RailName[],
    reason: string,
    evidence_only_summary: string,
  ): AgentResult {
    return {
      proposal: null,
      downgraded_to_evidence_only: true,
      rails_failed,
      downgrade_reason: reason,
      evidence_only_summary,
    };
  }
}

// advisory/agent/safety-rails.ts — Addition #27 D6 rail evaluation.
//
// Evaluates rails (a) through (g) per REPLY-49 D6 on a candidate
// proposal against the rail-e-filtered playbook context. Rail (e)
// itself is NOT evaluated here — it ran at AgentInputContext
// construction time (hard invariant pre-FM). This function checks
// post-FM rails: (a)/(b) playbook + reversibility consistency,
// (c) confidence, (d) audit-record emission path, (f) schema
// validation (evaluated before rails here by the proposer), and
// (g) rate-limit (enforced by the proposer call-site).

import type { ProposedAction } from '../../engine/types';
import type { AgentInputContext, Playbook, RailName } from './types';

export interface RailsEvaluationResult {
  passed: RailName[];
  failed: RailName[];
  /** First rail-failure downgrade reason — keyed to
   *  AgentProposalDowngradedAuditEvent.reason values. `null` when
   *  all post-FM rails pass. */
  downgrade_reason: string | null;
}

/** Evaluate post-FM rails on a `ProposedAction` candidate.
 *
 *  Rail (e) is treated as already-passed when this function runs —
 *  the FM only saw the filtered playbook list, so any proposed
 *  action_id that exists in the playbook map is by construction
 *  rail-e-compatible. We include 'e' in `passed` for audit
 *  completeness.
 *
 *  Rail (f) schema validation is gated by the proposer before this
 *  function runs; we include 'f' in `passed` when called (otherwise
 *  the proposer would have returned an evidence-only AgentResult
 *  without invoking rail evaluation).
 *
 *  Rail (g) rate limit is enforced at the orchestrator call-site
 *  keyed by VerdictGroup.group_id; when this function runs, the
 *  agent is permitted to propose. We include 'g' in `passed`. */
export function evaluateRails(
  proposal: ProposedAction,
  ctx: AgentInputContext,
  playbooksById: Map<string, Playbook>,
  confidence_threshold: number,
): RailsEvaluationResult {
  const passed: RailName[] = [];
  const failed: RailName[] = [];
  let downgrade_reason: string | null = null;

  // Rail (a) — proposed action_id must exist in loaded playbook library.
  const entry = playbooksById.get(proposal.proposed_action_id);
  if (!entry) {
    failed.push('a');
    downgrade_reason = downgrade_reason ?? 'unknown_action_id';
  } else {
    passed.push('a');
  }

  // Rail (b) — playbook entry's reversibility_required must match
  // deploy's reversibility tag. Subsumed by rail (e) filter — if the
  // entry made it through rail (e), the reversibility matches. We
  // still check here for audit completeness + defensive pin-down.
  if (entry) {
    const tag = ctx.reversibility_classification.reversibility;
    const effectiveTag = tag === 'conditional' ? 'forward_only' : tag;
    const rev = entry.reversibility_required;
    if (rev !== 'any' && rev !== effectiveTag) {
      failed.push('b');
      downgrade_reason = downgrade_reason ?? 'reversibility_mismatch';
    } else {
      passed.push('b');
    }
  }

  // Rail (c) — confidence floor. Per-entry threshold (when set on
  // the playbook) is the max of the entry's value and the global
  // threshold — entries may tighten, not loosen.
  const entryThreshold = entry?.confidence_threshold ?? confidence_threshold;
  const effectiveThreshold = Math.max(entryThreshold, confidence_threshold);
  if (proposal.confidence < effectiveThreshold) {
    failed.push('c');
    downgrade_reason = downgrade_reason ?? 'confidence_below_threshold';
  } else {
    passed.push('c');
  }

  // Rail (d) — ProposedAction structure is emit-ready for the audit
  // pipeline. Passing means the shape is valid; the orchestrator is
  // responsible for the actual write. Always passes when we reach
  // this function (proposer guarantees a well-formed ProposedAction).
  passed.push('d');

  // Rail (e) pre-filtered at input-construction; mark as passed for
  // audit completeness. If the proposed action_id matched a playbook
  // entry (rail a passed), it's by construction rail-e-compatible.
  if (entry) passed.push('e');

  // Rail (f) — schema validation is the proposer's gate before this
  // function runs. Reaching here implies pass.
  passed.push('f');

  // Rail (g) — rate-limit enforced at call-site. Reaching here implies
  // the agent was allowed to invoke for this VerdictGroup.
  passed.push('g');

  return { passed, failed, downgrade_reason };
}

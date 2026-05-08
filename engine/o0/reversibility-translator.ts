// engine/o0/reversibility-translator.ts — Addition #5 O0 verdict translator.
//
// Per NORTH-STAR-ARCHITECTURE.md Addition #5 and ARCHITECT-REPLY-32
// implementation brief. Pure function mapping L3 verdict × reversibility
// classification to a concrete orchestrator-side action. Keeps L3
// semantics orthogonal to downstream action selection: L3 emits
// `'rollback'` regardless of reversibility; this translator decides
// whether that rollback actually invokes orchestrator-native rollback,
// a pause-and-alarm escalation, or a human-confirmation-required
// pause.
//
// Action mapping (anti-scope: don't change this without architect
// sign-off):
//
//   verdict=rollback,   reversibility=reversible   → action=rollback
//   verdict=rollback,   reversibility=forward_only → action=pause_and_alarm
//   verdict=rollback,   reversibility=conditional  → action=human_confirmation_required
//   verdict=proceed                                → action=proceed
//   verdict=extend                                 → action=extend
//   verdict=baking                                 → action=baking
//   verdict=<anything else>                        → passthrough as the action name

import type { Reversibility } from './reversibility-source';
import type { Verdict } from '../types';

/** Discriminated union of concrete orchestrator-side actions that the
 *  translator can produce. Rollback-class actions carry a human-readable
 *  reason so downstream consumers (ticketing, Slack approval, etc.)
 *  have context without re-computing it. */
export type ReversibilityAction =
  | { action: 'rollback' }
  | { action: 'pause_and_alarm'; reason: string }
  | { action: 'human_confirmation_required'; reason: string }
  | { action: 'proceed' }
  | { action: 'extend' }
  | { action: 'baking' }
  | { action: 'suppressed'; reason: string };

/**
 * Translate verdict × reversibility into a concrete orchestrator
 * action. Pure function — no state, no I/O. Easy to unit-test every
 * combination in isolation.
 *
 * Non-rollback verdicts pass through unchanged — reversibility only
 * affects the rollback interpretation. `'baking'` is the engine's
 * internal pre-terminal state; consumers typically filter it out, but
 * passing it through keeps the translator total rather than partial.
 */
export function translateVerdict(
  verdict: Verdict,
  reversibility: Reversibility,
  verdict_reason?: string,
): ReversibilityAction {
  if (verdict === 'rollback') {
    switch (reversibility) {
      case 'reversible':
        return { action: 'rollback' };
      case 'forward_only':
        return {
          action: 'pause_and_alarm',
          reason: appendReason(
            'Deploy classified forward_only; rollback verdict converted to pause_and_alarm.',
            verdict_reason,
          ),
        };
      case 'conditional':
        return {
          action: 'human_confirmation_required',
          reason: appendReason(
            'Deploy classified conditional; rollback verdict requires human confirmation.',
            verdict_reason,
          ),
        };
    }
  }
  if (verdict === 'proceed') return { action: 'proceed' };
  if (verdict === 'extend') return { action: 'extend' };
  if (verdict === 'baking') return { action: 'baking' };
  // Future verdict classes (e.g., Addition #11 'suppressed_insufficient_samples')
  // land here as a suppressed action with the verdict name as the reason.
  return { action: 'suppressed', reason: verdict };
}

function appendReason(prefix: string, detail?: string): string {
  if (!detail) return prefix;
  return prefix + ' ' + detail;
}

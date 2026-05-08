// test/agent-rail-reversibility.test.ts — Addition #27 slice-1.
//
// Per REPLY-49 §Tests for rail (e) HARD invariant:
//   - Deploy reversibility='reversible': playbook filter returns
//     entries with rev_required in {reversible, any}.
//   - Deploy reversibility='forward_only': filter returns
//     {forward_only, any}. rollback_canary_to_zero
//     (rev_required='reversible') is FILTERED OUT.
//   - Deploy reversibility='conditional': treated as forward_only
//     conservatively (P4 semantic comparability table).
//
// Rail (e) runs at AgentInputContext construction — FM never sees
// inapplicable entries. Not a confidence threshold; not a post-hoc
// validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  loadPlaybook, filterPlaybookByReversibility,
} from '../advisory/agent/playbook';

const PLAYBOOKS_DIR = path.resolve(__dirname, '..', 'playbooks');

test('rail-e: reversible deploy → all 10 entries accessible', () => {
  const all = loadPlaybook(PLAYBOOKS_DIR);
  const filtered = filterPlaybookByReversibility(all, 'reversible');
  assert.equal(filtered.length, all.length,
    `reversible deploy must see all entries; got ${filtered.length}/${all.length}`);
  const ids = new Set(filtered.map((e) => e.id));
  for (const required of [
    'rollback_canary_to_zero', 'pause_and_alarm_oncall',
    'scale_down_affected_cell', 'widen_alpha_budget_temp',
  ]) {
    assert.ok(ids.has(required), `reversible filter should include ${required}`);
  }
});

test('rail-e: forward_only deploy → rollback-class entries filtered out', () => {
  const all = loadPlaybook(PLAYBOOKS_DIR);
  const filtered = filterPlaybookByReversibility(all, 'forward_only');
  const ids = new Set(filtered.map((e) => e.id));

  // Rollback-class entries with rev_required='reversible' must NOT
  // appear.
  const rollbackClassReversible = [
    'rollback_canary_to_zero',        // reversible
    'scale_down_affected_cell',        // reversible
    'revert_tenant_tier_isolation',    // reversible
    'rollback_to_previous_version',    // reversible
  ];
  for (const excluded of rollbackClassReversible) {
    assert.ok(
      !ids.has(excluded),
      `forward_only filter should exclude ${excluded} (rev_required=reversible)`,
    );
  }

  // any-compatible entries must remain.
  for (const kept of [
    'pause_and_alarm_oncall', 'widen_alpha_budget_temp',
    'suppress_family_a_signal_x', 'freeze_deploy_rollout',
    'enable_shadow_mode_only', 'escalate_to_sre_team',
  ]) {
    assert.ok(ids.has(kept), `forward_only filter should keep ${kept} (rev_required=any)`);
  }
});

test('rail-e: conditional deploy treated as forward_only (P4 conservative)', () => {
  const all = loadPlaybook(PLAYBOOKS_DIR);
  const conditional = filterPlaybookByReversibility(all, 'conditional');
  const forwardOnly = filterPlaybookByReversibility(all, 'forward_only');

  // Conservative semantic: conditional produces exactly the same
  // filter result as forward_only.
  const condIds = new Set(conditional.map((e) => e.id));
  const foIds = new Set(forwardOnly.map((e) => e.id));
  assert.equal(condIds.size, foIds.size);
  for (const id of condIds) {
    assert.ok(foIds.has(id), `conditional filter includes ${id} not in forward_only`);
  }
});

test('rail-e: explicit synthetic entries exercise all three rev_required values', () => {
  const synthetic = [
    {
      id: 'p_rev',
      version: '1.0.0',
      applies_when: { firing_families: [], min_family_count: 0, verdict_class: 'both' as const },
      reversibility_required: 'reversible' as const,
      confidence_threshold: 0.7,
      orchestrator_command_template: 'noop',
      human_description: 'd', expected_effect: 'e',
      category: 'rollback' as const,
    },
    {
      id: 'p_fwd',
      version: '1.0.0',
      applies_when: { firing_families: [], min_family_count: 0, verdict_class: 'both' as const },
      reversibility_required: 'forward_only' as const,
      confidence_threshold: 0.7,
      orchestrator_command_template: 'noop',
      human_description: 'd', expected_effect: 'e',
      category: 'pause' as const,
    },
    {
      id: 'p_any',
      version: '1.0.0',
      applies_when: { firing_families: [], min_family_count: 0, verdict_class: 'both' as const },
      reversibility_required: 'any' as const,
      confidence_threshold: 0.7,
      orchestrator_command_template: 'noop',
      human_description: 'd', expected_effect: 'e',
      category: 'pause' as const,
    },
  ];
  const revIds = new Set(filterPlaybookByReversibility(synthetic, 'reversible').map((e) => e.id));
  assert.deepEqual(revIds, new Set(['p_rev', 'p_any']));

  const fwdIds = new Set(filterPlaybookByReversibility(synthetic, 'forward_only').map((e) => e.id));
  assert.deepEqual(fwdIds, new Set(['p_fwd', 'p_any']));

  const condIds = new Set(filterPlaybookByReversibility(synthetic, 'conditional').map((e) => e.id));
  assert.deepEqual(condIds, new Set(['p_fwd', 'p_any']),
    'conditional must match forward_only set exactly (P4 conservative)');
});

test('rail-e: empty playbook list filters to empty list (safe boundary)', () => {
  assert.deepEqual(filterPlaybookByReversibility([], 'reversible'), []);
  assert.deepEqual(filterPlaybookByReversibility([], 'forward_only'), []);
  assert.deepEqual(filterPlaybookByReversibility([], 'conditional'), []);
});

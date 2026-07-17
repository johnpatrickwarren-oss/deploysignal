// test/agent-proposer-stub-adapter.test.ts — Addition #27 slice-1.
//
// Per REPLY-49 §Tests for proposer end-to-end:
//   - StubAdapter returns scripted valid ProposedAction; AgentProposer
//     emits it + rails_passed includes all seven.
//   - Low-confidence → rail (c) fails; downgrade to evidence-only;
//     `downgrade_reason === 'confidence_below_threshold'`.
//   - Unknown action_id → rail (a) fails; downgrade.
//   - Malformed FM output first call → rail (f) triggers re-query;
//     second valid call → proposal emitted.
//   - Persistently malformed → rail (f) downgrades to evidence-only
//     after one re-query (`schema_validation_failed_after_requery`).
//   - FM adapter throws → graceful downgrade without crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import type {
  FusedVerdict, ProposedAction, ReversibilityClassification,
  VerdictGroup,
} from '../engine/types';
import { loadPlaybook, filterPlaybookByReversibility } from '../advisory/agent/playbook';
import { AgentProposer } from '../advisory/agent/proposer';
import { StubAdapter } from '../advisory/agent/fm-adapter';
import type { AgentInputContext, StubScript } from '../advisory/agent/types';

const PLAYBOOKS_DIR = path.resolve(__dirname, '..', 'playbooks');

function makeFusedVerdict(overrides: Partial<FusedVerdict> = {}): FusedVerdict {
  return {
    verdict: 'rollback',
    firing_families: ['A'],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 1e-4,
    fusion_topology: 'portfolio',
    tick: 10,
    deploy_ref: 'test-deploy',
    verdict_rationale: 'Rollback triggered: Family A fired.',
    evidence_outlook: [],
    ...overrides,
  };
}

function makeVerdictGroup(firing: FusedVerdict['firing_families'] = ['A']): VerdictGroup {
  const fire = makeFusedVerdict({ firing_families: firing });
  return {
    group_id: 'group-test-deploy-100',
    deploy_id: 'test-deploy',
    window_start_ts: 100,
    window_end_ts: 400,
    verdicts: [fire],
    firing_verdicts: [fire],
    root_cause: fire,
    confidence: 1 / 3,
    late_arrival_verdicts: [],
    closed: true,
    closed_at_ts: 400,
  };
}

function makeCtx(
  tag: 'reversible' | 'forward_only' | 'conditional' = 'reversible',
  firing: FusedVerdict['firing_families'] = ['A'],
): AgentInputContext {
  const playbooks = loadPlaybook(PLAYBOOKS_DIR);
  const filtered = filterPlaybookByReversibility(playbooks, tag);
  const revClass: ReversibilityClassification = {
    reversibility: tag, reversibility_source: 'default_fallback',
  };
  return {
    verdict_group: makeVerdictGroup(firing),
    reversibility_classification: revClass,
    playbook_candidates: filtered,
  };
}

function validProposal(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    proposed_action_id: 'rollback_canary_to_zero',
    playbook_category: 'rollback',
    cited_evidence: {
      cited_verdict_group_id: 'group-test-deploy-100',
      cited_reversibility: 'reversible',
      cited_firing_families: ['A'],
      cited_alpha_consumed_per_family: { A: 1e-4 },
      cited_cell_keys: ['hour_of_day=14'],
    },
    confidence: 0.85,
    human_summary: 'Set canary weight to 0; investigate before resume.',
    orchestrator_command: 'argo rollouts set weight test-deploy 0',
    rails_passed: [],
    ...overrides,
  };
}

function scriptedAdapter(
  responder: (ctx: AgentInputContext, callCount: number) => unknown,
): StubAdapter {
  const script: StubScript = { respond: responder };
  return new StubAdapter(script);
}

test('proposer: happy path — scripted valid ProposedAction emitted with all 7 rails passed', async () => {
  const adapter = scriptedAdapter(() => validProposal());
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const ctx = makeCtx('reversible');
  const result = await proposer.propose(ctx);

  assert.equal(result.downgraded_to_evidence_only, false);
  assert.ok(result.proposal !== null);
  assert.equal(result.proposal!.proposed_action_id, 'rollback_canary_to_zero');
  assert.deepEqual(
    [...result.proposal!.rails_passed].sort(),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
  assert.deepEqual(result.rails_failed, []);
});

test('proposer: low confidence (rail c) → downgrade to evidence-only', async () => {
  const adapter = scriptedAdapter(() => validProposal({ confidence: 0.5 }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
    confidence_threshold: 0.7,
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.equal(result.downgraded_to_evidence_only, true);
  assert.equal(result.proposal, null);
  assert.deepEqual(result.rails_failed, ['c']);
  assert.equal(result.downgrade_reason, 'confidence_below_threshold');
  assert.ok(result.evidence_only_summary?.length ?? 0 > 0,
    'evidence-only summary must carry FM human_summary for oncall visibility');
});

test('proposer: unknown action_id (rail a) → downgrade', async () => {
  const adapter = scriptedAdapter(() => validProposal({
    proposed_action_id: 'no_such_playbook_entry',
  }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.equal(result.downgraded_to_evidence_only, true);
  assert.equal(result.proposal, null);
  assert.ok(result.rails_failed.includes('a'));
  assert.equal(result.downgrade_reason, 'unknown_action_id');
});

test('proposer: malformed FM first call → re-query; second valid call → emit', async () => {
  const adapter = scriptedAdapter((_ctx, callCount) => {
    if (callCount === 0) return { malformed: true };  // fails schema
    return validProposal();
  });
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
    allow_requery_on_schema_failure: true,
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.equal(result.downgraded_to_evidence_only, false);
  assert.ok(result.proposal !== null);
  assert.equal(adapter.callCountForTest(), 2,
    'rail (f) must trigger exactly one re-query before success');
});

test('proposer: persistently malformed → downgrade after one re-query', async () => {
  const adapter = scriptedAdapter(() => ({ still: 'malformed' }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
    allow_requery_on_schema_failure: true,
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.equal(result.downgraded_to_evidence_only, true);
  assert.equal(result.proposal, null);
  assert.deepEqual(result.rails_failed, ['f']);
  assert.equal(result.downgrade_reason, 'schema_validation_failed_after_requery');
  assert.equal(adapter.callCountForTest(), 2,
    'rail (f) re-queries exactly once before downgrade');
});

test('proposer: adapter throws → graceful downgrade without rethrow', async () => {
  const adapter = scriptedAdapter(() => {
    throw new Error('FM endpoint unreachable');
  });
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.equal(result.downgraded_to_evidence_only, true);
  assert.equal(result.proposal, null);
  assert.deepEqual(result.rails_failed, ['f']);
  assert.equal(result.downgrade_reason, 'fm_invocation_failed');
});

test('proposer: forward_only deploy + rollback proposal — rail e filter already excluded it', async () => {
  // If FM tries to propose rollback_canary_to_zero on a forward_only
  // deploy, rail (a) will fail because the rail-e-filtered playbook
  // list doesn't contain it — playbook map is built from ALL playbooks
  // in the AgentProposer's constructor, though, not just the filtered
  // subset. Rail (b) defensive check catches this case.
  const adapter = scriptedAdapter(() => validProposal({
    proposed_action_id: 'rollback_canary_to_zero',  // rev_required=reversible
    cited_evidence: {
      cited_verdict_group_id: 'group-test-deploy-100',
      cited_reversibility: 'forward_only',
      cited_firing_families: ['A'],
      cited_alpha_consumed_per_family: { A: 1e-4 },
      cited_cell_keys: [],
    },
  }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('forward_only'));

  assert.equal(result.downgraded_to_evidence_only, true);
  // Rail (b) catches the reversibility mismatch defensively even
  // though rail (e) pre-filtering should have prevented the FM from
  // receiving this entry in the first place.
  assert.ok(result.rails_failed.includes('b'));
  assert.equal(result.downgrade_reason, 'reversibility_mismatch');
});

test('proposer: conditional deploy treated as forward_only for rail (b) — rollback proposal rejected', async () => {
  const adapter = scriptedAdapter(() => validProposal({
    proposed_action_id: 'rollback_canary_to_zero',
    cited_evidence: {
      cited_verdict_group_id: 'group-test-deploy-100',
      cited_reversibility: 'conditional',
      cited_firing_families: ['A'],
      cited_alpha_consumed_per_family: { A: 1e-4 },
      cited_cell_keys: [],
    },
  }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('conditional'));

  assert.equal(result.downgraded_to_evidence_only, true);
  assert.ok(result.rails_failed.includes('b'),
    'conditional deploy + rollback entry must trip rail (b) conservative check');
});

test('proposer: pause-class entry OK on forward_only deploy', async () => {
  const adapter = scriptedAdapter(() => validProposal({
    proposed_action_id: 'pause_and_alarm_oncall',
    playbook_category: 'pause',
    cited_evidence: {
      cited_verdict_group_id: 'group-test-deploy-100',
      cited_reversibility: 'forward_only',
      cited_firing_families: ['A'],
      cited_alpha_consumed_per_family: { A: 1e-4 },
      cited_cell_keys: [],
    },
  }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('forward_only'));

  assert.equal(result.downgraded_to_evidence_only, false);
  assert.ok(result.proposal !== null);
  assert.equal(result.proposal!.proposed_action_id, 'pause_and_alarm_oncall');
});

test('proposer: rails_passed emitted on proposal is authoritative (overrides FM-reported)', async () => {
  // FM might pretend to have run rails that it didn't; proposer
  // overwrites rails_passed with authoritative evaluation result.
  const adapter = scriptedAdapter(() => validProposal({
    rails_passed: ['a'],  // FM claims only 'a'
  }));
  const proposer = new AgentProposer({
    adapter,
    playbooks: loadPlaybook(PLAYBOOKS_DIR),
  });
  const result = await proposer.propose(makeCtx('reversible'));

  assert.ok(result.proposal !== null);
  assert.deepEqual(
    [...result.proposal!.rails_passed].sort(),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    'rails_passed must come from post-evaluation, not FM self-report',
  );
});

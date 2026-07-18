// test/verdict-grouper-basic.test.ts — Addition #25 slice-1 foundation.
//
// Covers the four basic scenarios from ARCHITECT-REPLY-47 brief:
//   1. Single-deploy single-tick: group stays open, no close.
//   2. Single-deploy sequence across > window_seconds: window-elapsed
//      close fires on the post-window ingest.
//   3. Multi-deploy interleave: groups keyed by deploy_id remain
//      independent.
//   4. Terminal-verdict close: ingest with `{ terminal: true }` closes
//      the open group immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FusedVerdict } from '../engine/types';
import { VerdictGrouper } from '../engine/verdict-groups';

const WINDOW_SECONDS = 300;
const GRACE_SECONDS = 300;

function makeVerdict(overrides: Partial<FusedVerdict> = {}): FusedVerdict {
  return {
    verdict: 'proceed',
    firing_families: [],
    per_family_verdicts: { A: null, B: null, C: null, D: null, E: null },
    total_alpha_spent: 0,
    fusion_topology: 'portfolio',
    tick: 0,
    deploy_ref: 'deploy-1',
    verdict_rationale: 'Proceed: observation window closed with no rollback signals across all families.',
    evidence_outlook: [],
    ...overrides,
  };
}

test('verdict-grouper-basic: single-deploy single-tick fire — no close, group stays open', () => {
  const grouper = new VerdictGrouper();
  const v = makeVerdict({ verdict: 'rollback', firing_families: ['A'], tick: 10 });
  const r = grouper.ingest(v, /* ts_seconds */ 50);

  assert.equal(r.closed, null);
  assert.equal(r.late_arrival, false);
  assert.equal(r.attributed_group.deploy_id, 'deploy-1');
  assert.equal(r.attributed_group.closed, false);
  assert.equal(r.attributed_group.verdicts.length, 1);
  assert.equal(r.attributed_group.firing_verdicts.length, 1);
  assert.equal(r.attributed_group.window_start_ts, 50);
  assert.equal(r.attributed_group.group_id, 'group-deploy-1-50');

  // The grouper still exposes the open group.
  const open = grouper.openGroupForDeploy('deploy-1');
  assert.ok(open && !open.closed);
});

test('verdict-grouper-basic: 60-tick deploy sequence — window-elapsed close on post-window ingest', () => {
  const grouper = new VerdictGrouper({ window_seconds: WINDOW_SECONDS });
  // Seed 60 verdicts at 5s tick cadence, ts in [0, 295]s. All within
  // the 300s window; none trigger close.
  for (let tick = 0; tick < 60; tick++) {
    const ts = tick * 5;
    const r = grouper.ingest(makeVerdict({ tick, deploy_ref: 'd-A' }), ts);
    assert.equal(r.closed, null, `tick ${tick} @ts=${ts} should not close`);
  }
  const openMid = grouper.openGroupForDeploy('d-A')!;
  assert.equal(openMid.verdicts.length, 60);
  assert.equal(openMid.closed, false);

  // Next ingest at ts=301s is just past window_start(0)+300; triggers
  // window-elapsed close of the prior group and opens a new one.
  const post = grouper.ingest(makeVerdict({ tick: 60, deploy_ref: 'd-A' }), 301);
  assert.ok(post.closed, 'post-window ingest should close prior group');
  assert.equal(post.closed!.closed, true);
  assert.equal(post.closed!.verdicts.length, 60);
  assert.equal(post.closed!.closed_at_ts, 301);

  // The new group for the same deploy has just the one verdict.
  assert.equal(post.attributed_group.verdicts.length, 1);
  assert.equal(post.attributed_group.window_start_ts, 301);
  assert.notEqual(post.attributed_group.group_id, post.closed!.group_id);
});

test('verdict-grouper-basic: multi-deploy interleave — groups keyed by deploy_id are independent', () => {
  const grouper = new VerdictGrouper();
  const sequence: Array<[string, number]> = [
    ['d-1', 0], ['d-2', 5], ['d-1', 10], ['d-2', 15], ['d-1', 20], ['d-2', 25],
  ];
  for (const [deploy_ref, ts] of sequence) {
    grouper.ingest(makeVerdict({ deploy_ref, tick: ts / 5 }), ts);
  }
  const g1 = grouper.openGroupForDeploy('d-1')!;
  const g2 = grouper.openGroupForDeploy('d-2')!;

  assert.equal(g1.verdicts.length, 3);
  assert.equal(g2.verdicts.length, 3);
  assert.notEqual(g1.group_id, g2.group_id);
  assert.equal(g1.window_start_ts, 0);
  assert.equal(g2.window_start_ts, 5);
  for (const v of g1.verdicts) assert.equal(v.deploy_ref, 'd-1');
  for (const v of g2.verdicts) assert.equal(v.deploy_ref, 'd-2');
});

test('verdict-grouper-basic: terminal verdict — ingest {terminal:true} closes group', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ tick: 0 }), 0);
  grouper.ingest(makeVerdict({ tick: 5, verdict: 'rollback', firing_families: ['A'] }), 25);
  // Final verdict marks deploy finalized (evaluation.finished lifecycle).
  const r = grouper.ingest(makeVerdict({ tick: 10 }), 50, { terminal: true });

  assert.ok(r.closed, 'terminal ingest should close the group');
  assert.equal(r.closed!.closed, true);
  assert.equal(r.closed!.closed_at_ts, 50);
  assert.equal(r.closed!.verdicts.length, 3);
  assert.equal(r.closed!.firing_verdicts.length, 1);
  assert.equal(r.attributed_group.group_id, r.closed!.group_id);

  // No open group remains for the deploy.
  assert.equal(grouper.openGroupForDeploy('deploy-1'), undefined);
});

test('verdict-grouper-basic: flush() force-closes all open groups', () => {
  const grouper = new VerdictGrouper();
  grouper.ingest(makeVerdict({ deploy_ref: 'a', tick: 0 }), 0);
  grouper.ingest(makeVerdict({ deploy_ref: 'b', tick: 0 }), 10);
  grouper.ingest(makeVerdict({ deploy_ref: 'c', tick: 0 }), 20);

  const closed = grouper.flush(100);
  assert.equal(closed.length, 3);
  for (const g of closed) {
    assert.equal(g.closed, true);
    assert.equal(g.closed_at_ts, 100);
  }
  assert.equal(grouper.openGroupForDeploy('a'), undefined);
  assert.equal(grouper.openGroupForDeploy('b'), undefined);
  assert.equal(grouper.openGroupForDeploy('c'), undefined);
});

test('verdict-grouper-basic: late-arrival within grace attaches to prior closed group', () => {
  const grouper = new VerdictGrouper({ window_seconds: WINDOW_SECONDS, grace_seconds: GRACE_SECONDS });
  // Open, then terminal-close at ts=80 (scenario parallels P5 Scenario 4).
  grouper.ingest(makeVerdict({ deploy_ref: 'd-late', tick: 0 }), 0);
  const closeRes = grouper.ingest(
    makeVerdict({ deploy_ref: 'd-late', tick: 15, verdict: 'rollback', firing_families: ['A'] }),
    80,
    { terminal: true },
  );
  assert.ok(closeRes.closed);
  const priorGroupId = closeRes.closed!.group_id;

  // Late spectral fire arrives at ts=100s; delta=20s well within grace (300s).
  const late = grouper.ingest(
    makeVerdict({ deploy_ref: 'd-late', tick: 20, verdict: 'rollback', firing_families: ['D'] }),
    100,
  );
  assert.equal(late.late_arrival, true);
  assert.equal(late.attributed_group.group_id, priorGroupId);
  assert.equal(late.attributed_group.late_arrival_verdicts.length, 1);
  assert.equal(late.attributed_group.firing_verdicts.length, 2);

  // Beyond-grace arrival: new ingest at ts=500s (delta=420s > 300s grace).
  const beyond = grouper.ingest(
    makeVerdict({ deploy_ref: 'd-late', tick: 100 }),
    500,
  );
  assert.equal(beyond.late_arrival, false);
  assert.notEqual(beyond.attributed_group.group_id, priorGroupId);
  assert.equal(beyond.attributed_group.closed, false);
});

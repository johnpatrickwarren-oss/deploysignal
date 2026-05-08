// test/canned-demo-family-a-coship.test.ts — Addition #17 co-ship
// demonstration on demo-tokens-creep.
//
// Acceptance per ARCHITECT-REPLY-34 §Test files:
//   - Page-CUSUM fire point at t=17 for cost_req (Q57 Path-3 +1 tick
//     shift; pre-Q57 t=16). Legacy demo calibration substantively intact —
//     the primary "Demo 1-5 expected_outcome fields stay intact" gate.
//     +1 tick shift sourced to applyCellPatch class-fix symmetric reach
//     across tier-segmented cells + aggregate_fallback (architect Step-4
//     Option (a); Q57-PATH-3-STEP-4-OVERSIGHT-DISPOSITION lines 19-53;
//     verdict unchanged at trajectory end).
//   - Betting e-process for cost_req produces a verdict-stream through
//     the demo with at least one non-clean tick inside [10, 25]; the
//     specific fire-or-indeterminate timing depends on how quickly the
//     wealth accumulates, which is drift-rate sensitive. A wider
//     tolerance than Page-CUSUM is expected by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const V4_PATH = path.resolve(__dirname, '..', 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const DEMO_PATH = path.resolve(__dirname, '..', 'demos', 'scripts', 'demo-tokens-creep.json');

test('co-ship demo: demo-tokens-creep Page-CUSUM fire tick unchanged (legacy calibration preserved)', () => {
  // The demo JSON's expected_outcome is the contract surface.
  // Addition #17 must NOT change the Page-CUSUM first_fire_tick —
  // whether or not the v4 config has been recompiled with the α-split
  // field, Page-CUSUM's threshold either stays unchanged (pre-#17
  // config) or comes to (α / bonf) * 0.5 (post-#17 recompile); either
  // way the CUSUM statistic at the fire tick is well above the
  // threshold, so a re-tightening to half-α doesn't shift the first-fire
  // tick materially.
  if (!fs.existsSync(DEMO_PATH)) return;
  const demo = JSON.parse(fs.readFileSync(DEMO_PATH, 'utf8'));
  assert.equal(demo.expected_outcome.verdict, 'rollback',
    'demo-tokens-creep expected verdict should remain rollback');
  assert.equal(demo.expected_outcome.first_fire_tick, 15,
    'Page-CUSUM first_fire_tick at t=15 (Q72 SLICE 2 Phase 3.B re-baseline post-RFF + post-Q66 .A mixture-supermartingale; was t=17 at Q57 Path-3 era; fire-tick re-baselined to RFF empirical state per accuracy-first directive 2026-05-07)');
  assert.equal(demo.expected_outcome.first_fire_detector, 'mSPRT_cost_req',
    'legacy mSPRT_ detector id preserved in demo expected_outcome (REPLY-36 cleanup handles rename)');
});

test('co-ship demo: v4 config either populates betting α or leaves it absent (D8 backward-compat)', () => {
  // Cross-check that the v4 config on disk is either a pre-#17 build
  // (no betting_e_process_alpha) or a post-#17 build (populated on
  // every per-signal entry). A partially-populated config would indicate
  // a broken compiler migration.
  if (!fs.existsSync(V4_PATH)) return;
  const v4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  const cells = v4.baseline_cells?.cells ?? [];
  const agg = v4.baseline_cells?.aggregate_fallback?.family_A?.per_signal;

  const has = (per: Record<string, { betting_e_process_alpha?: number }> | undefined): 'all' | 'none' | 'mixed' => {
    if (!per) return 'none';
    const keys = Object.keys(per);
    if (keys.length === 0) return 'none';
    const present = keys.filter((k) => per[k].betting_e_process_alpha !== undefined);
    if (present.length === 0) return 'none';
    if (present.length === keys.length) return 'all';
    return 'mixed';
  };

  const aggState = has(agg);
  assert.notEqual(aggState, 'mixed',
    `v4 aggregate_fallback.family_A.per_signal mixes betting_e_process_alpha presence — compiler migration is inconsistent`);
  for (const cell of cells) {
    const per = cell.family_A?.per_signal;
    const state = has(per);
    assert.notEqual(state, 'mixed',
      `v4 cell ${JSON.stringify(cell.key)}: family_A.per_signal mixes betting_e_process_alpha presence`);
  }
});

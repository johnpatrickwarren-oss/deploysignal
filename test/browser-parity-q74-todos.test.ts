// test/browser-parity-q74-todos.test.ts —
// Q72 SLICE 2 Phase 3.B architect-pick: explicit {todo} markers for the 4
// browser-parity bundle-wiring mismatches deferred to Q74 follow-on.
//
// Mirrors the §C1/§C2 right-reasons TODO pattern from
// test/canned-demo-right-reasons.test.ts: each known-deferred mismatch
// gets a node:test `test(..., { todo: '...' }, ...)` annotation so the
// suite ✔ todo emits in test summaries while preserving no-skip
// discipline (the architect-scope fix is tracked, not silently skipped).
//
// Architect disposition (2026-05-07): divergence is on bundle-wiring
// (orchestrator-dispatch in IIFE/__NS__ bundle pattern), NOT on Ville-
// bound detector math. Cross-engine numerical-precision-class is
// EQUIVALENT on detector COMPUTATION — same engine .ts source compiled
// to both Node (dist/) and browser (dist-browser/ → engine/index.browser.js
// IIFE bundle); the IIFE/__NS__ pattern fails to publish Family A
// page_cusum mixture-supermartingale + Family C MMD betting-e-process +
// Family E conformal into the orchestrator's dispatch surface at runtime.
// Phase D core thesis (anytime-valid Ville-bounded determinism)
// PRESERVED — divergence in bundle infrastructure, not detector
// computation.
//
// Q72 SLICE 2 close PROCEEDS with this caveat per architect-pick. Q74
// follow-on topic SPAWNED for orchestrator-dispatch fix in IIFE/NS
// bundle pattern (TAGGED post-Phase-D-close architect-direct emit
// forward-cycle).
//
// Empirical state captured at PR #136 close (Phase 3.B Surface #1
// architect-intake):
//
//   Test C: portfolio + v2 audit-record parity (3 scenarios)
//   ─────────────────────────────────────────────────────────────────
//     adv_slowbleed:           node=rollback browser=extend  [shape-mismatch]
//     adv_slow_downstream:     node=rollback browser=extend  [shape-mismatch]
//     adv_mfu_drop_no_lat_corr: node=rollback browser=baking  [shape-mismatch]
//
//     Per-family diagnostic (uniform across all 3):
//       fam A: node[v=fire   α=3.33e-5 detectors=mSPRT_*]   (artifact CUSUM)
//       fam A: brws[v=clean  α=0       detectors=(none)]    (NOT WIRED)
//       fam C: node[v=suppressed (schema-continuity gate)]
//       fam C: brws[v=clean]                                  (NOT WIRED)
//       fam E: node[v=suppressed (schema-continuity gate)]
//       fam E: brws[v=clean]                                  (NOT WIRED)
//       fam B: clean on both  ✓
//       fam D: clean on both  ✓
//
//   Test D: schema-continuity suppression parity (1 scenario)
//   ─────────────────────────────────────────────────────────────────
//     schema-break A/C/D/E suppress: fam C node=suppressed browser=clean
//
// All 4 mismatches share the SAME ROOT CAUSE: browser bundle's
// orchestrator-dispatch is missing Family A/C/E detector evaluation
// at the IIFE/NS publish layer. Q74 architect-direct emit will repair
// the dispatch wiring; this PR ships the bundle re-built with current
// canonical detector source (engine/detectors/page-cusum.js +
// betting-e-process.js + family-c-betting-e-process.js + family-c-rff.js
// + family-a-mixture-supermartingale.js + sequential-mmd.js) so Q74
// has fewer moving parts.

import { test } from 'node:test';

test('Q74 follow-on: browser-parity Test C adv_slowbleed bundle-wiring (Family A/C/E orchestrator-dispatch)',
  { todo: 'Q74 architect-scope: orchestrator-dispatch in IIFE/NS bundle pattern divergence' },
  () => { /* tracked at test/browser-parity.test.js Test C; see file header */ });

test('Q74 follow-on: browser-parity Test C adv_slow_downstream bundle-wiring (Family A/C/E orchestrator-dispatch)',
  { todo: 'Q74 architect-scope: orchestrator-dispatch in IIFE/NS bundle pattern divergence' },
  () => { /* tracked at test/browser-parity.test.js Test C; see file header */ });

test('Q74 follow-on: browser-parity Test C adv_mfu_drop_no_lat_corr bundle-wiring (Family A/C/E orchestrator-dispatch)',
  { todo: 'Q74 architect-scope: orchestrator-dispatch in IIFE/NS bundle pattern divergence' },
  () => { /* tracked at test/browser-parity.test.js Test C; see file header */ });

test('Q74 follow-on: browser-parity Test D schema-continuity Family C suppression bundle-wiring',
  { todo: 'Q74 architect-scope: orchestrator-dispatch in IIFE/NS bundle pattern divergence (Family C suppression not propagated through IIFE/__NS__ publish layer)' },
  () => { /* tracked at test/browser-parity.test.js Test D; see file header */ });

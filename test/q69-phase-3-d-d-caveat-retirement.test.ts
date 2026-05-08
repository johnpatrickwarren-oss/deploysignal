// test/q69-phase-3-d-d-caveat-retirement.test.ts — Q69 Phase-3.d.D
// CAVEAT retirement + schema deprecation + Phase D BATCH close acceptance.
//
// Per Q69 SPEC § Tests (~10 cases):
//   - Q69.1 CAVEAT_EXEMPT_FAMILIES set retired
//   - Q69.2 fpr_classical_epoch.methodology_note + console.error retired
//   - Q69.2 + Q69.7 ASK A pick (i) fpr_classical_epoch object FULL DEPRECATION
//   - Q69.4 Q58 spec § AC #5 RETIRED-SPEC-SIDE stamp
//   - Q69.5 ANTI-SCOPE-LEDGER ADR walk + Phase-3.d ACTIVE → CLOSED
//   - Q69.6 CHEAT-SHEET.md Family A + Family C unified Ville-bounded framing
//   - Q69.8 α-budget arithmetic preserved across Phase D close
//   - Phase D BATCH architecturally CLOSED stamp
//
// These are spec-side / schema-side / docs-side acceptance checks; runtime
// detector code retired at Q66 + Q67 + Q68 close upstream. Q69 close stamps
// the retirement at documentation + schema deprecation level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

test('Q69.1 — CAVEAT_EXEMPT_FAMILIES set retired in test/q58-per-detector-iid-bootstrap-pool.test.ts', () => {
  const src = read('test/q58-per-detector-iid-bootstrap-pool.test.ts');
  assert.ok(!/const CAVEAT_EXEMPT_FAMILIES\s*:/.test(src),
    'CAVEAT_EXEMPT_FAMILIES set declaration should be retired post-Q69');
  assert.ok(!/CAVEAT_EXEMPT_FAMILIES\.has\(/.test(src),
    'CAVEAT_EXEMPT_FAMILIES.has() guard should be retired post-Q69');
  assert.match(src, /CAVEAT.*RETIRED.*Q69/i,
    'CAVEAT retirement should be documented in test header');
});

test('Q69.2 — methodology_note schema field removed from fpr_classical_epoch in tools/build-report-card.js', () => {
  const src = read('tools/build-report-card.js');
  assert.ok(!/methodology_note:\s*'Classical-epoch-α/.test(src),
    'fpr_classical_epoch.methodology_note string field should be retired post-Q69');
});

test('Q69.2 — CAVEAT console.error emission removed from tools/build-report-card.js', () => {
  const src = read('tools/build-report-card.js');
  assert.ok(!/CAVEAT: Classical-epoch FPR=/.test(src),
    'CAVEAT classical-epoch console.error should be retired post-Q69');
  assert.ok(!/const classicalBound\s*=/.test(src),
    'classicalBound computation should be retired post-Q69');
});

test('Q69.2 + Q69.7 ASK A — fpr_classical_epoch object FULLY DEPRECATED (pick (i))', () => {
  const src = read('tools/build-report-card.js');
  // The fpr_classical_epoch return-value block at runFprSweep should be retired.
  // Only expected mention is the deprecation comment + scope_note retirement
  // language (post-Q69).
  assert.ok(!/fpr_classical_epoch:\s*\{\s*alpha_classical_bound/.test(src),
    'fpr_classical_epoch return-value block should be retired post-Q69');
  assert.ok(!/fpr\.fpr_classical_epoch\.fp_count/.test(src),
    'summary should not reference fpr_classical_epoch.fp_count post-Q69');
});

test('Q69.4 — Q58 spec § Acceptance criterion #5 RETIRED-SPEC-SIDE stamp present', () => {
  const src = read('coordination/Q58-PER-DETECTOR-IID-BOOTSTRAP-POOL-SPEC.md');
  assert.match(src, /Status post-Phase-3\.d\.D close \(Q69\):.*CAVEAT clause RETIRED-SPEC-SIDE/,
    'Q58 spec § AC #5 should carry RETIRED-SPEC-SIDE stamp');
  // Cross-reference chain (Q66 + Q67 + Q68 + Q69) should be inline.
  assert.match(src, /Q66 Phase-3\.d\.A close/, 'Q66 cross-reference required');
  assert.match(src, /Q67 Phase-3\.d\.B SLICE 1 close/, 'Q67 cross-reference required');
  assert.match(src, /Q68 Phase-3\.d\.C close/, 'Q68 cross-reference required');
  assert.match(src, /Q69 Phase-3\.d\.D close/, 'Q69 cross-reference required');
});

test('Q69.5 — ANTI-SCOPE-LEDGER Q58 + Q59 ADR clauses stamped CLOSED-RETIRED-FULL / PRESERVED-PERMANENT', () => {
  const src = read('coordination/ANTI-SCOPE-LEDGER.md');
  // Q58 + Q59 retiring clauses → CLOSED-RETIRED-FULL.
  assert.match(src, /CLOSED-RETIRED-FULL.*Phase-3\.d\.D walk closure/,
    'Q58 clause 1 should stamp CLOSED-RETIRED-FULL at Q69 walk');
  // Q58 clause 2 + Q59 clause 3 → PRESERVED-PERMANENT-POST-PHASE-D.
  assert.match(src, /PRESERVED-PERMANENT-POST-PHASE-D/,
    'Q58 clause 2 / Q59 clause 3 should stamp PRESERVED-PERMANENT-POST-PHASE-D per Q69.7 ASK B pick (ii)');
});

test('Q69.5 — ANTI-SCOPE-LEDGER Phase-3.d sub-track ACTIVE → CLOSED transition stamped', () => {
  const src = read('coordination/ANTI-SCOPE-LEDGER.md');
  assert.match(src,
    /### Phase-3\.d — Ville-bounded re-engineering[^\n]*\n\n\*\*Status:\*\* \*\*CLOSED 2026-05-07\*\*/,
    'Phase-3.d sub-track should stamp CLOSED 2026-05-07 (Q69 PR merge)');
  assert.match(src, /Phase D BATCH architecturally CLOSED/,
    'Phase D BATCH architectural close stamp required');
});

test('Q69.6 — CHEAT-SHEET.md Family A + Family C unified Ville-bounded framing', () => {
  const src = read('CHEAT-SHEET.md');
  assert.match(src, /Phase D BATCH closed 2026-05-07/,
    'Phase D close stamp should appear in CHEAT-SHEET');
  assert.match(src, /mixture-supermartingale.*Howard-Ramdas-McAuliffe-Sekhon-2021/,
    'Family A unified Ville-bounded framing should cite Howard-Ramdas-McAuliffe-Sekhon-2021');
  assert.match(src, /betting-e-process.*Shekhar-Ramdas-2023/,
    'Family C unified Ville-bounded framing should cite Shekhar-Ramdas-2023');
  assert.match(src, /α_total = α_ville/,
    'α-budget unification should appear in CHEAT-SHEET');
});

test('Q69 — Q58 CAVEAT semantic FULLY RETIRED post-Phase-3.d.D close (cross-reference chain consistency)', () => {
  const q58Spec = read('coordination/Q58-PER-DETECTOR-IID-BOOTSTRAP-POOL-SPEC.md');
  const ledger = read('coordination/ANTI-SCOPE-LEDGER.md');
  const q58Test = read('test/q58-per-detector-iid-bootstrap-pool.test.ts');
  // All three artifacts should consistently reference Phase-3.d.D close.
  assert.match(q58Spec, /Phase-3\.d\.D close/,
    'Q58 spec must reference Phase-3.d.D close');
  assert.match(ledger, /Phase-3\.d\.D/,
    'ANTI-SCOPE-LEDGER must reference Phase-3.d.D');
  assert.match(q58Test, /Q69.*Phase-3\.d\.D/i,
    'Q58 test must reference Q69 Phase-3.d.D close');
});

test('Q69.8 — α-budget arithmetic preserved across Phase D close (ALPHA constants canonical)', () => {
  const src = read('tools/build-report-card.js');
  // ALPHA_VILLE = 5e-4 (Ville-bounded portion).
  assert.match(src, /const ALPHA_VILLE\s*=\s*5e-4;/,
    'ALPHA_VILLE = 5e-4 should be canonical post-Q69');
  // ALPHA_VILLE_BOUNDED_PAGE_CUSUM = 3e-4 (Q68.3 rename canonical).
  assert.match(src, /const ALPHA_VILLE_BOUNDED_PAGE_CUSUM\s*=\s*3e-4;/,
    'ALPHA_VILLE_BOUNDED_PAGE_CUSUM = 3e-4 should be canonical post-Q69');
  // Total α-budget arithmetic preserved (5e-4 + 3e-4 = 8e-4).
  // Q66 spec stamp confirms this at α-budget transition path Phase-3.d.D close.
  const q66Spec = read('coordination/Q66-PHASE-3-D-A-PAGE-CUSUM-MIXTURE-SUPERMARTINGALE-SPEC.md');
  assert.match(q66Spec, /CONFIRMED at Q69 close PR merge/,
    'Q66 spec should stamp Phase-3.d.D close confirmation');
});

test('Q69 close — Phase D BATCH architecturally CLOSED stamp consistency across artifacts', () => {
  const ledger = read('coordination/ANTI-SCOPE-LEDGER.md');
  const cheatSheet = read('CHEAT-SHEET.md');
  const q66Spec = read('coordination/Q66-PHASE-3-D-A-PAGE-CUSUM-MIXTURE-SUPERMARTINGALE-SPEC.md');
  const q67Spec = read('coordination/Q67-PHASE-3-D-B-MMD-BETTING-E-PROCESS-SPEC.md');
  // All four artifacts carry Phase D close stamp.
  assert.match(ledger, /Phase D BATCH architecturally CLOSED/,
    'ANTI-SCOPE-LEDGER Phase D BATCH close stamp required');
  assert.match(cheatSheet, /Phase D BATCH closed 2026-05-07/,
    'CHEAT-SHEET Phase D close stamp required');
  assert.match(q66Spec, /Phase D BATCH architecturally CLOSED/,
    'Q66 spec Phase D close stamp required');
  assert.match(q67Spec, /Phase D BATCH architecturally CLOSED/,
    'Q67 spec Phase D close stamp required');
});

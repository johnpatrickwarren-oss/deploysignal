// test/profile-generic-characterized-diff.test.ts — REPLY-51a D7(b) spec.
//
// Verifies generic-microservice@1.0.0 compile produces the expected
// characterized diff vs streaming:
//   - Family A sli_list: 3 signals (p99_latency, downstream_err, cost_req)
//     → family_a_signals emitted as 3-entry array.
//   - bonferroni_factor = 3.
//   - Family B absent (structural_detectors.enabled=false).
//   - Family C/D/E absent from aggregate_fallback (joint_vector
//     .include_in_family_c=false; aggregate_fallback.family_D absent
//     because Family D needs sli_list signals to iterate).
//   - baseline_cells shape: 168 cells when tenant_tier disabled
//     via profile (generic profile has tenant_tier: false). NOTE:
//     tenant_tier dispatch is R4-2 bundle-loader scope; cell-matrix
//     dimension is currently driven by bundle metadata not profile
//     field. Test validates what ships post-v2 (tenant_tier NOT
//     profile-driven until R4-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--families A --profile_ref generic-microservice@1.0.0 --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

test('D7(b) generic: family_a_signals has 3 entries (p99 + downstream_err + cost_req)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7b-fam-a-signals.json');
  compile(out);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(Array.isArray(cfg.family_a_signals));
  assert.equal(cfg.family_a_signals.length, 3, 'generic profile: Family A has 3 signals');
  assert.deepEqual(cfg.family_a_signals.sort(),
    ['cost_req', 'downstream_err', 'p99_latency'],
    'generic sli_list matches profile: p99_latency, downstream_err, cost_req');
  assert.equal(cfg.bonferroni_factor, 3);
});

test('D7(b) generic: Families B, C, D, E absent', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7b-families-absent.json');
  compile(out);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  // Top-level family_B absent per R4-4 (structural:false).
  assert.equal(cfg.family_B, undefined, 'top-level family_B absent (R4-4)');
  // aggregate_fallback Families absent (C/E disabled; D skipped by CLI
  // --families not including D; C skipped by joint_vector.include_in_
  // family_c=false).
  const agg = cfg.baseline_cells.aggregate_fallback;
  assert.equal(agg.family_C, undefined, 'aggregate_fallback.family_C absent');
  assert.equal(agg.family_E, undefined, 'aggregate_fallback.family_E absent');
  assert.equal(agg.family_D, undefined, 'aggregate_fallback.family_D absent');
  // Per-cell family_C absent on every cell.
  const cellsWithFamC = cfg.baseline_cells.cells.filter(
    (c: { family_C?: unknown }) => c.family_C !== undefined,
  );
  assert.equal(cellsWithFamC.length, 0, 'no per-cell family_C when disabled');
});

test('D7(b) generic: alpha_budget only A populated', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7b-alpha.json');
  compile(out);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  const pf = cfg.alpha_budget.per_family;
  assert.equal(pf.A, 1e-3, 'generic: Family A gets full budget');
  assert.equal(pf.B, 0);
  assert.equal(pf.C, 0);
  assert.equal(pf.D, 0);
  assert.equal(pf.E, 0);
});

test('D7(b) generic: family_c_signals emitted as empty array', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7b-fam-c-empty.json');
  compile(out);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  // Profile's joint_vector.signals = [] for generic; dispatch layer
  // emits the empty array; runtime detectors that would iterate it
  // simply don't enter their loop.
  assert.deepEqual(cfg.family_c_signals, [], 'generic joint_vector.signals is empty');
});

test('D7(b) generic: policy_defaults emitted + profile_ref threaded', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7b-provenance.json');
  compile(out);
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cfg.profile_ref, 'generic-microservice@1.0.0');
  assert.ok(cfg.policy_defaults, 'policy_defaults emitted on profile-routed compile');
});

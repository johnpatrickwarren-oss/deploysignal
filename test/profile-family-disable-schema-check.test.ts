// test/profile-family-disable-schema-check.test.ts — REPLY-51a §D5.
//
// Family-disable gates for Family C/E via profile's
// `joint_vector.include_in_family_c/e`. When disabled, the emitted
// CompiledConfig's per-cell family_C and aggregate_fallback.family_C/E
// stay absent (per TS optional-field convention). All-families-disabled
// → compile-time error.
//
// Slice-51a scope: Family C + E disable via per-cell optional fields
// (schema already carries them as optional; no engine/types.ts change
// required). Family B (structural) top-level disable + Family D
// per-cell disable defer to a follow-up slice — they require schema
// changes to make `family_B` optional at top-level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string, extra: string[] = []): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--out ${outPath} ${extra.join(' ')}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

test('D5: generic-microservice disables Family C + E → per-cell family_C absent', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-d5-generic.json');
  compile(outPath, [
    '--profile_ref generic-microservice@1.0.0',
    '--families A,B',
  ]);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const cells = cfg.baseline_cells.cells;

  // Profile has include_in_family_c=false → buildFamilyCPerCell
  // skipped entirely → every cell's family_C stays undefined.
  const cellsWithFamC = cells.filter((c: { family_C?: unknown }) => c.family_C !== undefined);
  assert.equal(cellsWithFamC.length, 0,
    `expected 0 cells with family_C when Family C disabled; got ${cellsWithFamC.length}`);

  // aggregate_fallback shouldn't carry family_C either.
  assert.equal(cfg.baseline_cells.aggregate_fallback.family_C, undefined,
    'aggregate_fallback.family_C must be absent when Family C disabled');
  assert.equal(cfg.baseline_cells.aggregate_fallback.family_E, undefined,
    'aggregate_fallback.family_E must be absent when Family E disabled');
});

test('D5: generic-microservice α_budget: A=1e-3, others zeroed (post-R4-4)', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-d5-alpha-zeroed.json');
  compile(outPath, [
    '--profile_ref generic-microservice@1.0.0',
    '--families A',  // R4-4: --families B with generic profile fails all-disabled invariant
  ]);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const perFam = cfg.alpha_budget.per_family;
  // R4-4: Family B disabled at profile layer → α reallocated to A.
  // Generic profile allocates 1e-3 to A (all budget) + 0 to others.
  assert.equal(perFam.A, 1e-3, 'generic profile (post-R4-4): Family A gets full 1e-3');
  assert.equal(perFam.B, 0, 'R4-4: Family B disabled → α=0');
  assert.equal(perFam.C, 0, 'Family C disabled → α=0');
  assert.equal(perFam.D, 0, 'Family D disabled (CLI omit) → α=0');
  assert.equal(perFam.E, 0, 'Family E disabled → α=0');
});

test('D5: streaming profile with --families A,B,C,D,E keeps all families enabled', () => {
  // Regression: streaming profile does NOT disable any family
  // (structural_detectors.enabled: true, joint_vector.include_in_
  // family_c: true, joint_vector.include_in_family_e: true). So all
  // enable gates pass; byte-identity vs legacy holds (covered by
  // profile-streaming-byte-identity test; this test is a narrower
  // "family enables propagate correctly" check).
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-d5-streaming-all.json');
  compile(outPath, [
    '--profile_ref llm-inference-streaming@1.0.0',
    '--families A,B,C,D,E',
  ]);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const cells = cfg.baseline_cells.cells;
  // Streaming keeps Family C enabled; some cells (strict/pooled paths)
  // emit family_C, others inherit aggregate_fallback.
  const cellsWithFamC = cells.filter((c: { family_C?: unknown }) => c.family_C !== undefined);
  assert.ok(cellsWithFamC.length > 0,
    `streaming profile must keep Family C populated; got ${cellsWithFamC.length}/${cells.length}`);
  assert.ok(cfg.baseline_cells.aggregate_fallback.family_C,
    'streaming profile must carry aggregate_fallback.family_C');
});

test('D5: generic profile + --families B → all-disabled error (post-R4-4)', () => {
  // REPLY-51b R4-4 flipped generic-microservice.yaml's
  // structural_detectors.enabled to false per brief §D7(b). With
  // --families B as the only CLI-enabled family, the profile gate
  // disables B → intersection zeroes all families → compile throws
  // the all-disabled-families invariant error.
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-d5-all-disabled.json');
  let threw = false;
  let errMsg = '';
  try {
    execSync(
      `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
      + `--profile_ref generic-microservice@1.0.0 --families B --out ${outPath}`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    threw = true;
    errMsg = String((err as { stderr?: Buffer }).stderr ?? err);
  }
  assert.ok(threw, 'compile must throw on all-families-disabled invariant');
  assert.ok(
    errMsg.includes('disables all detector families'),
    `expected all-disabled error message; got: ${errMsg.slice(0, 300)}`,
  );
});

test('D5: generic profile + --families A keeps Family A only', () => {
  // Complement of the above — exercising the legitimate path:
  // CLI includes A; profile disables C/D/E/B via structural +
  // joint_vector; intersection leaves only A active. Compile
  // succeeds with Family A cells but no family_B top-level.
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-d5-a-only.json');
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--profile_ref generic-microservice@1.0.0 --families A --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(cfg.family_B, undefined, 'R4-4: family_B absent on generic profile (structural disabled)');
  assert.ok(cfg.baseline_cells, 'Family A → baseline_cells emitted');
});

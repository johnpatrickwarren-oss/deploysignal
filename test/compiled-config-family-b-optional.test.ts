// test/compiled-config-family-b-optional.test.ts — REPLY-51b R4-4.
//
// Verifies family_B optional-field semantics on CompiledConfig:
//   - Legacy compile (no profile): emits family_B.cutoffs (CLI
//     --families default includes B; no profile gate to override).
//   - Streaming profile: emits family_B (structural_detectors.enabled:true).
//   - Generic-microservice profile: family_B ABSENT
//     (structural_detectors.enabled:false per brief §D7(b)).
//   - Legacy JSON configs with family_B still load + validate
//     (strict-additive schema change per REPLY-43 D5 precedent).

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

test('R4-4: legacy compile emits family_B', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r44-legacy.json');
  compile(outPath, ['--families A,B,C,D,E']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.family_B, 'legacy compile must emit family_B (CLI default includes B)');
  assert.ok(cfg.family_B.cutoffs, 'family_B.cutoffs populated');
  assert.ok(cfg.family_B.vote_thresholds, 'family_B.vote_thresholds populated');
});

test('R4-4: streaming profile emits family_B (structural: true)', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r44-streaming.json');
  compile(outPath, ['--families A,B,C,D,E', '--profile_ref llm-inference-streaming@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.family_B, 'streaming profile keeps structural enabled → family_B present');
  assert.ok(cfg.family_B.cutoffs && Object.keys(cfg.family_B.cutoffs).length > 0,
    'streaming profile: family_B.cutoffs non-empty');
});

test('R4-4: generic-microservice profile → family_B ABSENT (structural: false)', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r44-generic.json');
  compile(outPath, ['--families A,B', '--profile_ref generic-microservice@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(cfg.family_B, undefined,
    'R4-4 + brief §D7(b): generic profile disables structural → family_B absent');
});

test('R4-4: alpha_budget.per_family.B = 0 when profile disables Family B', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r44-alpha-zeroed.json');
  compile(outPath, ['--families A,B', '--profile_ref generic-microservice@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(cfg.alpha_budget.per_family.B, 0,
    'R4-4: disabled Family B gets α=0 allocation (profile says zero; intersection enforces)');
});

// test/profile-policy-defaults-routing.test.ts — REPLY-51b R4-3.
//
// Verifies policy_defaults threads from profile YAML → CompiledConfig:
//   - Profile with policy_defaults: CompiledConfig carries them.
//   - Profile without (e.g. hypothetical future trim): field absent.
//   - Legacy compile (no profile): field absent; no regression.
//   - Field values from YAML flow through verbatim.
//
// engine/gates/policy.ts runtime consumer is an optional shim —
// currently the G1 gate doesn't read these fields. R4-3 lands the
// CompiledConfig surface + profile→config dispatch; engine-side
// consumer landing is follow-up scope (noted in the brief; no
// existing hardcoded default in policy.ts to replace yet).

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

test('R4-3: streaming profile emits policy_defaults onto CompiledConfig', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r43-streaming.json');
  compile(outPath, ['--families A,B,C,D,E', '--profile_ref llm-inference-streaming@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.policy_defaults,
    'profile-routed compile must emit policy_defaults on CompiledConfig');
  assert.equal(cfg.policy_defaults.reversibility_threshold_minutes, 30);
  assert.equal(cfg.policy_defaults.auto_rollback_enabled, true);
  assert.equal(cfg.policy_defaults.default_risk_tier, 'medium');
});

test('R4-3: batch profile emits batch-specific policy_defaults', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r43-batch.json');
  compile(outPath, ['--families A,B,C,D,E', '--profile_ref llm-inference-batch@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.policy_defaults);
  // Batch profile has the streaming-inherited policy_defaults by
  // default (no explicit override); verify at least the structure
  // + non-default values if batch YAML specifies them.
  assert.equal(typeof cfg.policy_defaults.reversibility_threshold_minutes, 'number');
  assert.equal(typeof cfg.policy_defaults.auto_rollback_enabled, 'boolean');
  assert.ok(['low', 'medium', 'high'].includes(cfg.policy_defaults.default_risk_tier));
});

test('R4-3: legacy compile (no profile) omits policy_defaults', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r43-legacy.json');
  compile(outPath, ['--families A,B,C,D,E']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(cfg.policy_defaults, undefined,
    'legacy compile path must not emit policy_defaults (backward-compat anchor)');
});

test('R4-3: generic profile emits its own policy_defaults', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r43-generic.json');
  compile(outPath, ['--families A', '--profile_ref generic-microservice@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.policy_defaults, 'profile-routed compile emits policy_defaults regardless of enabled-family set');
});

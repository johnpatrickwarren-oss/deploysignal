// test/ville-preservation-per-profile.test.ts — REPLY-51b v2 §P4 check.
//
// Ville-preservation under dynamic signal routing:
//   - Per-family e-process validity preserved under profile-specific
//     dimension.
//   - Cross-family sum-bound holds per-profile: α_total ≥ sum of enabled
//     family α allocations.
//   - Disabled families contribute 0 to the sum; Ville bound reduces
//     correspondingly.
//
// Architect §P4 invariant: "per-family e-process validity preserved under
// profile-specific dimension; cross-family sum-bound per-profile." This
// is a compile-time arithmetic check — not a runtime statistical one.
// The brief's Ville-preservation check at dimension level is implicit
// in the τ²=c·trace(Σ)/p scale-invariance (REPLY-43b) which holds for
// any compiled covariance shape.

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

function readAlphaSum(cfgPath: string): { total: number; sum: number; perFamily: Record<string, number> } {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const pf = cfg.alpha_budget.per_family;
  const sum = pf.A + pf.B + pf.C + pf.D + pf.E;
  return { total: cfg.alpha_budget.total, sum, perFamily: pf };
}

test('Ville per-profile: streaming profile α_total == sum(per_family)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-ville-streaming.json');
  compile(out, ['--families A,B,C,D,E', '--profile_ref llm-inference-streaming@1.0.0']);
  const { total, sum, perFamily } = readAlphaSum(out);
  assert.ok(Math.abs(total - sum) < 1e-9,
    `Ville sum-bound invariant: total=${total} vs sum=${sum} (diff ${Math.abs(total - sum)}); ` +
    `per_family=${JSON.stringify(perFamily)}`);
  // Per-family budgets are non-negative.
  for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
    assert.ok(perFamily[k] >= 0, `per_family.${k} must be ≥ 0; got ${perFamily[k]}`);
  }
});

test('Ville per-profile: batch α_total == sum(per_family) at different dimension', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-ville-batch.json');
  compile(out, ['--families A,B,C,D,E', '--profile_ref llm-inference-batch@1.0.0']);
  const { total, sum } = readAlphaSum(out);
  assert.ok(Math.abs(total - sum) < 1e-9,
    `batch Ville invariant: total=${total} vs sum=${sum}`);
  // Batch's Family C dimension is 10 (not 11); safe-Hotelling
  // τ²=c·trace(Σ)/p scale-invariance preserves Ville bound at p=10
  // per REPLY-43b derivation (architect pair-review concur #2).
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cfg.family_c_signals.length, 10);
});

test('Ville per-profile: generic profile — disabled families contribute 0 to sum', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-ville-generic.json');
  compile(out, ['--families A', '--profile_ref generic-microservice@1.0.0']);
  const { total, sum, perFamily } = readAlphaSum(out);
  assert.ok(Math.abs(total - sum) < 1e-9, `generic Ville invariant: total=${total} sum=${sum}`);
  assert.equal(perFamily.B, 0, 'disabled Family B contributes 0 to Ville sum');
  assert.equal(perFamily.C, 0, 'disabled Family C contributes 0');
  assert.equal(perFamily.D, 0, 'disabled Family D contributes 0');
  assert.equal(perFamily.E, 0, 'disabled Family E contributes 0');
  assert.equal(perFamily.A, 1e-3, 'generic routes full α to enabled Family A');
});

test('Ville per-profile: legacy compile α invariant (no profile)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-ville-legacy.json');
  compile(out, ['--families A,B,C,D,E']);
  const { total, sum } = readAlphaSum(out);
  assert.ok(Math.abs(total - sum) < 1e-9,
    `legacy Ville invariant: total=${total} sum=${sum}`);
});

test('Ville per-profile: per-family α ≤ total for every family (no single family exceeds budget)', () => {
  // Regression guard: if dispatch layer ever allowed per_family.X >
  // total (mis-allocation), runtime Ville bound would be invalid.
  // Verify across all v1 profiles + legacy.
  const configs: Array<{ label: string; extra: string[] }> = [
    { label: 'legacy', extra: ['--families A,B,C,D,E'] },
    { label: 'streaming', extra: ['--families A,B,C,D,E', '--profile_ref llm-inference-streaming@1.0.0'] },
    { label: 'batch', extra: ['--families A,B,C,D,E', '--profile_ref llm-inference-batch@1.0.0'] },
    { label: 'generic', extra: ['--families A', '--profile_ref generic-microservice@1.0.0'] },
  ];
  for (const cfg of configs) {
    const out = path.join(REPO_ROOT, `runs/compiled-configs/test-ville-${cfg.label}.json`);
    compile(out, cfg.extra);
    const { total, perFamily } = readAlphaSum(out);
    for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
      assert.ok(perFamily[k] <= total,
        `${cfg.label}: per_family.${k}=${perFamily[k]} exceeds total=${total}`);
    }
  }
});

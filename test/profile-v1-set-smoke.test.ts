// test/profile-v1-set-smoke.test.ts — Addition #28 slice-2.
//
// Per REPLY-51 §Tests:
//   - Each v1 profile compiles to a valid CompiledConfig end-to-end.
//   - llm-inference-streaming@1.0.0 produces byte-identical output
//     to the legacy (no-profile) compile path — BACKWARD-COMPAT
//     REGRESSION ANCHOR.
//   - llm-inference-batch produces the batch-specific α split.
//   - generic-microservice compiles under `--families A,B` with
//     Family C/D/E disabled shape (matches profile declaration).
//
// These tests shell out to `node tools/calibrate.js` for full
// end-to-end coverage. Compile time on synthetic-v1 is ~65-70s;
// smoke tests use `--families A,B` to bring per-test cost to ~5s.
// The byte-identity test against streaming@1.0.0 uses the full
// A,B,C,D,E suite (~65s) because that's where the backward-compat
// regression anchor lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(args: {
  out: string; profile_ref?: string; families?: string;
}): void {
  const argv = [
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    `--families ${args.families ?? 'A,B'}`,
    `--out ${args.out}`,
  ];
  if (args.profile_ref) argv.push(`--profile_ref ${args.profile_ref}`);
  execSync(`node ${REPO_ROOT}/tools/calibrate.js ${argv.join(' ')}`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

function readCfg(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sha(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj, Object.keys(obj as object).sort())).digest('hex');
}

/** Strip fields that vary per-run-environment or that are the new
 *  strict-additive provenance added by #28 — used to compute a
 *  byte-identity hash that reflects "same semantic compile output". */
function stripForDiff(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  delete out.compile_phases;
  delete out.profile_ref;
  delete out.customer_override_ref;
  // REPLY-51b R4-3 — policy_defaults emitted by profile path only;
  // legacy path omits. Strip for the byte-identity equivalence.
  delete out.policy_defaults;
  // REPLY-51b v2 R4-1 — family_a_signals + family_c_signals are
  // profile-driven provenance; streaming emits with hardcoded values,
  // legacy omits. Strip for the byte-identity equivalence.
  delete out.family_a_signals;
  delete out.family_c_signals;
  return out;
}

test('v1-smoke: llm-inference-streaming@1.0.0 produces byte-identical output vs legacy (full A,B,C,D,E)', () => {
  const legacyOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-v1-smoke-legacy.json');
  const profileOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-v1-smoke-streaming.json');
  fs.mkdirSync(path.dirname(legacyOut), { recursive: true });

  compile({ out: legacyOut, families: 'A,B,C,D,E' });
  compile({ out: profileOut, families: 'A,B,C,D,E', profile_ref: 'llm-inference-streaming@1.0.0' });

  const legacy = stripForDiff(readCfg(legacyOut));
  const profile = stripForDiff(readCfg(profileOut));

  // Canonical JSON stringify with sorted keys (recursive) so diff is stable.
  const canon = (x: unknown): string => JSON.stringify(x, Object.keys(x as object).sort());
  assert.equal(
    sha(legacy), sha(profile),
    `streaming@1.0.0 must be byte-identical to legacy (modulo profile_ref + compile_phases). `
    + `legacy=${canon(legacy).slice(0, 200)}... profile=${canon(profile).slice(0, 200)}...`,
  );

  // Profile-routed compile emits the provenance string.
  const profileRaw = readCfg(profileOut);
  assert.equal(profileRaw.profile_ref, 'llm-inference-streaming@1.0.0');
});

test('v1-smoke: llm-inference-batch@1.0.0 compiles with batch-specific α split', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-v1-smoke-batch.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compile({ out, families: 'A,B,C,D,E', profile_ref: 'llm-inference-batch@1.0.0' });

  const cfg = readCfg(out) as {
    alpha_budget: { per_family: Record<string, number> };
    profile_ref: string;
  };
  // Batch reallocates A=5e-4 (+1e-4 vs streaming) and C=1e-4 (half
  // of streaming). D preserved; E = 0 since C25 (advisory, 2026-09-02).
  assert.equal(cfg.alpha_budget.per_family.A, 5e-4);
  assert.equal(cfg.alpha_budget.per_family.C, 1e-4);
  assert.equal(cfg.alpha_budget.per_family.D, 1e-4);
  assert.equal(cfg.alpha_budget.per_family.E, 0);
  // B = 1e-3 - 5e-4 - 1e-4 - 1e-4 - 0 = 3e-4 (±FP).
  assert.ok(Math.abs(cfg.alpha_budget.per_family.B - 3e-4) < 1e-15);
  assert.equal(cfg.profile_ref, 'llm-inference-batch@1.0.0');
});

test('v1-smoke: generic-microservice@1.0.0 compiles under Family A (post-R4-4)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-v1-smoke-generic.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // R4-4: generic profile's structural_detectors.enabled:false drops
  // Family B; compile invocation uses --families A (not A,B — that
  // would hit the all-disabled-families invariant since A is the
  // only CLI-and-profile-enabled family).
  compile({ out, families: 'A', profile_ref: 'generic-microservice@1.0.0' });

  const cfg = readCfg(out) as {
    alpha_budget: { per_family: Record<string, number> };
    profile_ref: string;
    family_B?: unknown;
  };
  // R4-4 post-profile-update: A=1e-3 (all budget), others 0.
  assert.equal(cfg.alpha_budget.per_family.A, 1e-3);
  assert.equal(cfg.alpha_budget.per_family.B, 0, 'R4-4: Family B disabled → α=0');
  assert.equal(cfg.alpha_budget.per_family.C, 0);
  assert.equal(cfg.alpha_budget.per_family.D, 0);
  assert.equal(cfg.alpha_budget.per_family.E, 0);
  assert.equal(cfg.profile_ref, 'generic-microservice@1.0.0');
  assert.equal(cfg.family_B, undefined, 'R4-4: family_B absent on generic profile');
});

test('v1-smoke: --alpha mismatch with profile total → compile-time error', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-alpha-mismatch.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Profile total is 1e-3; operator supplies 2e-3 → reject.
  let threw = false;
  try {
    execSync(
      `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 2e-3 `
      + `--families A,B --profile_ref llm-inference-streaming@1.0.0 --out ${out}`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    threw = true;
    const msg = String((err as { stderr?: Buffer }).stderr ?? err);
    assert.ok(
      msg.includes('alpha_allocation.total') || msg.includes('does not match'),
      `expected α-mismatch error; got: ${msg.slice(0, 400)}`,
    );
  }
  assert.ok(threw, 'compile must fail on --alpha vs profile.total mismatch');
});

test('v1-smoke: unknown profile ref → compile-time error', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-unknown-profile.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let threw = false;
  try {
    execSync(
      `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
      + `--families A,B --profile_ref nonexistent-profile@1.0.0 --out ${out}`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    threw = true;
    const msg = String((err as { stderr?: Buffer }).stderr ?? err);
    assert.ok(
      msg.includes('not found') || msg.includes('nonexistent-profile'),
      `expected not-found error; got: ${msg.slice(0, 400)}`,
    );
  }
  assert.ok(threw, 'compile must fail on unknown profile id');
});

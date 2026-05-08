// test/profile-audit-reproducibility.test.ts — Addition #28 slice-2.
//
// Per REPLY-51 §Tests:
//   - Given profile_ref + customer_override_ref from a CompiledConfig,
//     re-compile produces byte-identical output (modulo compile
//     timestamp / compile_phases timing).
//   - Recorded profile_ref version matches actual loaded profile
//     version.
//   - CompiledConfig audit fields populate correctly:
//       * both profile_ref + customer_override_ref when both present
//       * only profile_ref when override absent
//       * neither on legacy compile path (pre-#28 baseline)
//
// Uses Family A,B to keep compile time manageable (~5-6s per run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as crypto from 'node:crypto';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compileArgv(args: string[]): void {
  execSync(`node ${REPO_ROOT}/tools/calibrate.js ${args.join(' ')}`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

function readCfg(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function canonicalize(cfg: Record<string, unknown>): string {
  // Strip timing-variable fields. Preserve profile_ref + _override_ref
  // so the reproducibility check detects any profile-routing drift.
  const out = { ...cfg };
  delete out.compile_phases;
  return JSON.stringify(sortKeys(out));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return v;
}

test('audit: legacy compile emits neither profile_ref nor customer_override_ref', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-legacy.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compileArgv([
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B',
    `--out ${out}`,
  ]);
  const cfg = readCfg(out);
  assert.equal(cfg.profile_ref, undefined,
    'legacy compile must not emit profile_ref');
  assert.equal(cfg.customer_override_ref, undefined,
    'legacy compile must not emit customer_override_ref');
});

test('audit: profile_ref only → profile_ref populates, customer_override_ref absent', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-profile-only.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compileArgv([
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B',
    '--profile_ref llm-inference-streaming@1.0.0',
    `--out ${out}`,
  ]);
  const cfg = readCfg(out);
  assert.equal(cfg.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(cfg.customer_override_ref, undefined,
    'customer_override_ref must be absent when no override supplied');
});

test('audit: profile_ref + customer_override_ref both emit when both supplied', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-audit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const overridePath = path.join(tmp, 'acme.yaml');
  fs.writeFileSync(overridePath, yaml.dump({
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'acme',
    overrides: {},  // no-op override — exercise threading, not merge logic.
  }));
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-both-refs.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compileArgv([
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B',
    '--profile_ref llm-inference-streaming@1.0.0',
    `--customer_override_ref ${overridePath}`,
    `--out ${out}`,
  ]);
  const cfg = readCfg(out);
  assert.equal(cfg.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(cfg.customer_override_ref, 'acme@1.0.0');
});

test('audit: re-compile with same profile_ref is byte-identical (modulo compile_phases)', () => {
  const run1 = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-run1.json');
  const run2 = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-run2.json');
  fs.mkdirSync(path.dirname(run1), { recursive: true });
  const argv = [
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B',
    '--profile_ref llm-inference-streaming@1.0.0',
  ];
  compileArgv([...argv, `--out ${run1}`]);
  compileArgv([...argv, `--out ${run2}`]);

  const c1 = canonicalize(readCfg(run1));
  const c2 = canonicalize(readCfg(run2));
  const h1 = crypto.createHash('sha256').update(c1).digest('hex');
  const h2 = crypto.createHash('sha256').update(c2).digest('hex');
  assert.equal(h1, h2,
    're-compile with same profile_ref must produce byte-identical config');
});

test('audit: profile_ref in emitted config matches the requested version exactly', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-version.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compileArgv([
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B',
    '--profile_ref llm-inference-batch@1.0.0',
    `--out ${out}`,
  ]);
  const cfg = readCfg(out);
  assert.equal(cfg.profile_ref, 'llm-inference-batch@1.0.0',
    'profile_ref must recorded with the requested id@version exactly');
});

test('audit: override with non-trivial deltas surfaces in emitted α values', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-audit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const overridePath = path.join(tmp, 'custom.yaml');
  fs.writeFileSync(overridePath, yaml.dump({
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'custom-corp',
    overrides: {
      alpha_allocation: {
        per_family: { A: 2.0e-4, B: 5.0e-4, C: 2.0e-4, D: 5.0e-5, E: 5.0e-5 },
        total: 1.0e-3,
      },
    },
  }));
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-audit-override-deltas.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  compileArgv([
    `--baseline ${BASELINE}`,
    '--alpha 1e-3',
    '--families A,B,C,D,E',
    '--profile_ref llm-inference-streaming@1.0.0',
    `--customer_override_ref ${overridePath}`,
    `--out ${out}`,
  ]);

  const cfg = readCfg(out) as {
    profile_ref: string;
    customer_override_ref: string;
    alpha_budget: { per_family: Record<string, number> };
  };
  assert.equal(cfg.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(cfg.customer_override_ref, 'custom-corp@1.0.0');
  // Override's α values surface on emitted config.
  assert.equal(cfg.alpha_budget.per_family.A, 2.0e-4);
  assert.equal(cfg.alpha_budget.per_family.C, 2.0e-4);
  assert.equal(cfg.alpha_budget.per_family.D, 5.0e-5);
  assert.equal(cfg.alpha_budget.per_family.E, 5.0e-5);
});

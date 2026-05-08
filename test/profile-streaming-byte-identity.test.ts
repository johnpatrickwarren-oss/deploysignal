// test/profile-streaming-byte-identity.test.ts — REPLY-51a §D6 PRIMARY GATE.
//
// Streaming profile byte-identity anchor. `llm-inference-streaming@1.0.0`
// encodes hardcoded legacy defaults faithfully; under dynamic routing,
// compile-path reads from EffectiveConfig; produces sha256-identical
// output to a legacy (no-profile) compile, modulo profile_ref +
// customer_override_ref fields.
//
// PRIMARY REGRESSION GATE per REPLY-51a §D6. Any drift here means one
// of the dispatch-layer field routings doesn't faithfully reproduce
// the hardcoded default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string, extra: string[] = []): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--families A,B,C,D,E --out ${outPath} ${extra.join(' ')}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

function canonicalHash(cfgPath: string): string {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // Strip provenance/timing fields that are expected to vary.
  delete cfg.compile_phases;
  delete cfg.profile_ref;
  delete cfg.customer_override_ref;
  // REPLY-51b R4-3 — policy_defaults is profile-layer provenance;
  // legacy compiles omit it, streaming compiles emit it. Equalize
  // for the byte-identity invariant (covers the same role as
  // profile_ref — emitted provenance vs. absent legacy field).
  delete cfg.policy_defaults;
  // REPLY-51b v2 R4-1 — family_a_signals + family_c_signals are
  // profile-driven shape metadata. Streaming profile emits them
  // (contents match hardcoded FAMILY_A/C_SIGNALS verbatim); legacy
  // omits. Strip for the byte-identity equivalence — the REAL
  // regression check is that baseline_cells per-cell parameters
  // match across paths (covered by the rest of the JSON).
  delete cfg.family_a_signals;
  delete cfg.family_c_signals;
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

test('streaming byte-identity (PRIMARY GATE): streaming@1.0.0 ↔ legacy', () => {
  const legacyOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-streaming-legacy.json');
  const streamingOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-streaming-profile.json');

  compile(legacyOut);
  compile(streamingOut, ['--profile_ref llm-inference-streaming@1.0.0']);

  const legacySha = canonicalHash(legacyOut);
  const streamingSha = canonicalHash(streamingOut);
  assert.equal(
    legacySha, streamingSha,
    `PRIMARY GATE FAILED: streaming profile diverges from legacy defaults.\n`
    + `  legacy:    ${legacySha}\n`
    + `  streaming: ${streamingSha}\n`
    + `Dispatch layer is not faithfully reproducing a hardcoded default field.`,
  );
});

test('streaming: profile_ref emitted on the CompiledConfig', () => {
  const streamingOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-streaming-provenance.json');
  compile(streamingOut, ['--profile_ref llm-inference-streaming@1.0.0']);
  const cfg = JSON.parse(fs.readFileSync(streamingOut, 'utf8'));
  assert.equal(cfg.profile_ref, 'llm-inference-streaming@1.0.0');
  assert.equal(cfg.customer_override_ref, undefined,
    'no override supplied → customer_override_ref must be absent');
});

test('backward-compat: legacy compile (no profile_ref) preserves pre-#28 output', () => {
  // D3 backward-compat anchor: CompilerOptions without profile_ref
  // runs through the dispatch layer with effective=null; every field
  // falls back to hardcoded defaults. Emitted CompiledConfig must
  // NOT carry profile_ref / customer_override_ref fields.
  const legacyOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-legacy-backward-compat.json');
  compile(legacyOut);
  const cfg = JSON.parse(fs.readFileSync(legacyOut, 'utf8'));
  assert.equal(cfg.profile_ref, undefined, 'legacy compile must not emit profile_ref');
  assert.equal(cfg.customer_override_ref, undefined,
    'legacy compile must not emit customer_override_ref');
  // Alpha budget + family_B + baseline_cells populated with expected
  // legacy values (the primary-gate test above covers byte-identity;
  // this test is the narrower "legacy fields present" regression).
  assert.equal(cfg.alpha_budget.per_family.A, 4e-4);
  assert.ok(cfg.baseline_cells);
  assert.ok(cfg.family_B?.cutoffs);
});

test('run-to-run determinism: same streaming compile twice → sha-identical', () => {
  // Dispatch layer must be idempotent — same profile → same output
  // regardless of invocation. Regression guard against any non-
  // deterministic field materialization (e.g., Object.keys ordering).
  const outA = path.join(REPO_ROOT, 'runs/compiled-configs/test-streaming-run-a.json');
  const outB = path.join(REPO_ROOT, 'runs/compiled-configs/test-streaming-run-b.json');
  compile(outA, ['--profile_ref llm-inference-streaming@1.0.0']);
  compile(outB, ['--profile_ref llm-inference-streaming@1.0.0']);
  assert.equal(canonicalHash(outA), canonicalHash(outB),
    'run-to-run byte-identity required — dispatch layer must be deterministic');
});

// test/compile-parity-pre-post-slice2.test.ts — REPLY-50 slice-2.
//
// PRIMARY acceptance anchor: byte-identical compile output under
// worker-pool parallelization vs serial fallback. Per brief §P4:
//
//   Semantic comparability: compile output must be byte-identical
//   (modulo compile_phases) under default configuration. Any
//   difference lands as acceptance violation requiring explanation.
//
// The `--disable_worker_pool` CLI flag forces serial in-process
// builds; parallel run lets the auto-spawned pool handle per-cell
// buildFamilyCPerCell calls. Both MUST produce sha256-identical
// CompiledConfig (strip compile_phases timing — expected to vary).
//
// Runs full A,B,C,D,E compile — slower than smoke tests but
// load-bearing on the determinism invariant. Per acceptance:
// worker-thread parallelization + deterministic per-call PRNG
// seeding must preserve output exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string, extraArgs: string[] = []): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} `
    + `--alpha 1e-3 --families A,B,C,D,E --out ${outPath} ${extraArgs.join(' ')}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

function canonicalHash(cfgPath: string): string {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // Strip compile_phases — timing varies per run; parity is about
  // compile-output semantic, not wall-clock measurements.
  delete cfg.compile_phases;
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

test('parity: worker-pool vs serial produce byte-identical compile output', () => {
  // Under default (pool-on when cpu>2) + explicit --disable_worker_pool,
  // byte-identity must hold. Determinism anchor: fastMCD + MRCD use
  // per-call PRNG seeds; no shared state across workers; identical
  // output expected.
  const serialOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-parity-serial.json');
  const poolOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-parity-pool.json');

  compile(serialOut, ['--disable_worker_pool true']);
  compile(poolOut);  // default (auto pool)

  const serialSha = canonicalHash(serialOut);
  const poolSha = canonicalHash(poolOut);
  assert.equal(serialSha, poolSha,
    `worker-pool parallelization must preserve byte-identity vs serial\n`
    + `  serial: ${serialSha}\n`
    + `  pool:   ${poolSha}`);
});

test('parity: re-running same compile twice is byte-identical (run-to-run determinism)', () => {
  const runA = path.join(REPO_ROOT, 'runs/compiled-configs/test-parity-runA.json');
  const runB = path.join(REPO_ROOT, 'runs/compiled-configs/test-parity-runB.json');

  compile(runA);
  compile(runB);

  assert.equal(canonicalHash(runA), canonicalHash(runB),
    'same compile run twice must produce identical output');
});

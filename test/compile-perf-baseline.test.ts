// test/compile-perf-baseline.test.ts — REPLY-50 slice-3 perf gate.
//
// Asserts post-slice-3 compile stays under the architect's strict
// 15s primary gate per REPLY-50 §Acceptance. Slice history:
//   slice-1 baseline: 78s (instrumentation-only + D4/D6b dormant)
//   slice-2 (D6b on + workers): 17.5s parallel / 54.7s serial
//   slice-3 (D6a LW-warm-start): ≤2s parallel / ≤7s serial
//     (observed 1.82s / 5.53s on 10-core Mac host)
//
// Gate structure:
//   - 4+ core host (pool engages): assert total_ms ≤ 15000 per
//     REPLY-50 §Acceptance PRIMARY GATE. CI floor same — D6a's 10×
//     speedup gives generous headroom over CI noise.
//   - 2-3 core host (CI serial fallback): assert total_ms ≤ 15000
//     per secondary gate; serial-path D6a + D6b reduces 78s → ≤7s
//     (observed 5.53s local), so 15s floor holds with >2× margin
//     under CI contention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

test('compile-perf: default A,B,C,D,E compile meets slice-2 gate', {
  // Perf gate requires isolated run context — node:test's default
  // concurrent test-file execution causes worker-pool contention
  // when multiple tests fire compiles in parallel (each compile
  // spawns ~9 worker threads; N × 9 threads competing for C cores
  // starves parallelism and inflates wall time). Gate this test
  // behind `DS_PERF_GATE=1` so CI can run it in a dedicated job
  // with `--concurrency=1` to get faithful measurements.
  skip: !process.env.DS_PERF_GATE
    ? 'perf gate opt-in via DS_PERF_GATE=1 (requires --concurrency=1 for isolation)'
    : false,
}, () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-perf-baseline.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--families A,B,C,D,E --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );

  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const total = cfg.compile_phases?.total_ms ?? Infinity;
  const cpu = os.cpus().length;

  // REPLY-50 §Acceptance PRIMARY GATE: ≤15s on default synthetic-v1
  // A,B,C,D,E compile. Slice-3 D6a (LW-warm-start in fastMCD) drops
  // both parallel and serial paths well under the gate:
  //   - pool-enabled local: ~2s (8× margin)
  //   - serial-fallback local: ~5.5s (2.7× margin)
  const gate = 15000;
  assert.ok(total <= gate,
    `compile total_ms=${total}ms exceeds ${gate}ms PRIMARY gate for ${cpu}-core host.`);
});

test('compile-perf: D6b skip counter shows aggregate cell activates', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-perf-d6b-counter.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--families A,B,C,D,E --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const cp = cfg.compile_phases;
  // D6b default-on post-slice-2; synthetic-v1 aggregate cell meets
  // both thresholds (λ ≈ 0.024 < 0.1 and outlier_frac < 5%).
  assert.ok((cp.mcd_skipped_low_variance_cells ?? 0) >= 1,
    `D6b default-on expected to skip ≥1 cell on synthetic-v1; got ${cp.mcd_skipped_low_variance_cells}`);
});

// test/compile-worker-thread-parallelization.test.ts — REPLY-50 slice-2.
//
// Verifies that the D2 worker-thread pool actually engages on multi-
// core hosts + speeds up wall-clock. Compare elapsed wall time
// (serial vs pool) on a full synthetic-v1 A,B,C,D,E compile.
//
// Acceptance: on 4+ cores, pool provides ≥2× speedup (Amdahl-
// conservative — architect projected ~3×). Test skips when
// `os.cpus().length <= 2` (Q1 fallback — serial path is the only
// path on 2-core CI runners).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function timedCompile(outPath: string, extraArgs: string[] = []): number {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const start = Date.now();
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} `
    + `--alpha 1e-3 --families A,B,C,D,E --out ${outPath} ${extraArgs.join(' ')}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  return Date.now() - start;
}

test('worker-pool: emits compile_phases.worker_pool_overhead_ms > 0 when pool engages', {
  skip: os.cpus().length <= 2 ? 'single/2-core host; serial fallback, no pool' : false,
}, () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-pool-overhead.json');
  timedCompile(outPath);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const cp = cfg.compile_phases;
  assert.ok(cp, 'compile_phases field must be present (slice-1 D7 instrumentation)');
  assert.ok(cp.worker_pool_overhead_ms > 0,
    `pool should record non-zero overhead on multi-core host; got ${cp.worker_pool_overhead_ms}ms`);
});

test('worker-pool: ≥2× speedup on 4+ core host (parallel vs serial)', {
  // Perf-gate speedup measurement requires isolated run context —
  // parallel test-harness execution starves the worker pool of cores
  // and inflates wall time for both serial + pool paths (serial faster
  // because it doesn't pay worker-spawn overhead). Opt-in via
  // DS_PERF_GATE=1 + `--concurrency=1`.
  skip: !process.env.DS_PERF_GATE
    ? 'perf gate opt-in via DS_PERF_GATE=1 (requires --concurrency=1 for isolation)'
    : os.cpus().length < 4 ? 'need ≥4 cores for Amdahl-conservative 2× claim' : false,
}, () => {
  // Run serial first to warm filesystem caches; pool runs second.
  // If pool were slower than serial (regression), this would catch it
  // either way — the absolute numbers may be filesystem-cache-biased
  // but the ratio isn't.
  const serialOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-perf-serial.json');
  const poolOut = path.join(REPO_ROOT, 'runs/compiled-configs/test-perf-pool.json');

  const serialMs = timedCompile(serialOut, ['--disable_worker_pool true']);
  const poolMs = timedCompile(poolOut);

  const speedup = serialMs / poolMs;
  assert.ok(speedup >= 2.0,
    `pool must deliver ≥2× speedup on 4+ cores; got serial=${serialMs}ms pool=${poolMs}ms (${speedup.toFixed(2)}×)`);
});

test('worker-pool: serial fallback compile succeeds on --disable_worker_pool', () => {
  // Serial fallback must always succeed regardless of cpu count —
  // CI 2-core runners rely on it.
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-serial-fallback.json');
  timedCompile(outPath, ['--disable_worker_pool true']);
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(cfg.baseline_cells, 'serial compile must produce a full CompiledConfig');
  assert.ok(cfg.compile_phases, 'compile_phases field must be populated on serial path too');
});

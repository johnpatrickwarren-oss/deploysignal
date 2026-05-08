// test/calibrator-extraction-parity.test.ts — End-phase slice 3c (D-54-3).
//
// PRIMARY REGRESSION GATE for slice 3c. Asserts that the compile output
// is byte-identical across two independent compile runs on
// synthetic-v1 — every field except the intrinsically non-deterministic
// `compile_phases` (wall-clock) and `compiled_at` (ISO timestamp) must
// match bit-for-bit.
//
// Two-run invariance stands in for full pre/post extraction parity
// because the extraction is LANDED by the time this test runs: the
// deterministic-seed design of every calibrator (mulberry32 with
// fixed seeds) guarantees same-code → same-output. Any regression
// that breaks determinism (e.g., accidental shared-state mutation, a
// Map iteration-order bug, aggregator arithmetic re-ordering that
// unmasks floating-point non-associativity) shows up here immediately.
//
// Post-refactor additions (follow-up): this test can also diff
// against a committed reference fixture (checked in under
// runs/compiled-configs/parity-reference-synthetic-v1.json) once the
// aggregator refactor (task #12) lands; until then, the two-run
// invariance + the extraction-specific unit tests
// (calibrator-family-{a,c,d,e}-unit) carry the regression signal.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');
const OUT_DIR = path.join(ROOT, 'runs', 'compiled-configs');

/** Strip fields that are legitimately non-deterministic between compile
 *  runs: wall-clock timings (`compile_phases`) and ISO timestamp
 *  (`compiled_at`). Returns a normalized JSON string in sorted-key
 *  form so a trailing newline / insertion-order drift can't mask a
 *  real byte-level divergence. */
function normalize(cfg: Record<string, unknown>): string {
  const { compile_phases, compiled_at, ...rest } = cfg as {
    compile_phases?: unknown;
    compiled_at?: unknown;
    [k: string]: unknown;
  };
  void compile_phases;
  void compiled_at;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function runCompile(outPath: string): Record<string, unknown> {
  execSync(
    `node tools/calibrate.ts --baseline ${BASELINE_DIR} `
    + `--alpha 1e-3 --families A,B,C,D,E --out ${outPath}`,
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  return JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
}

let runA: Record<string, unknown>;
let runB: Record<string, unknown>;

before(() => {
  if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
    execSync(
      'node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 '
      + '--n 500 --ticks 32 --tenants 4 --seed 42',
      { cwd: ROOT, stdio: 'inherit' },
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  runA = runCompile(path.join(OUT_DIR, 'slice-3c-parity-runA.json'));
  runB = runCompile(path.join(OUT_DIR, 'slice-3c-parity-runB.json'));
});

test('calibrator-extraction-parity: synthetic-v1 two-run byte-identity (non-timing fields)', () => {
  const a = normalize(runA);
  const b = normalize(runB);
  assert.equal(a.length, b.length, 'payload lengths differ');
  assert.equal(a, b, 'non-timing fields must be byte-identical across runs');
});

test('calibrator-extraction-parity: synthetic-v1 structural counts match', () => {
  // Sentinel fields that regressions tend to disturb first:
  // bonferroni_factor, family_a_signals length, family_c_signals length,
  // baseline_cells.cells length, alpha_budget.total.
  assert.equal(runA.bonferroni_factor, runB.bonferroni_factor);
  assert.deepEqual(runA.family_a_signals, runB.family_a_signals);
  assert.deepEqual(runA.family_c_signals, runB.family_c_signals);
  assert.equal((runA.alpha_budget as { total: number }).total, 1e-3);
  assert.equal((runA.alpha_budget as { total: number }).total,
              (runB.alpha_budget as { total: number }).total);
  const cellsA = (runA.baseline_cells as { cells: unknown[] }).cells;
  const cellsB = (runB.baseline_cells as { cells: unknown[] }).cells;
  assert.equal(cellsA.length, cellsB.length);
});

test('calibrator-extraction-parity: compile_phases present + totals non-negative', () => {
  const pa = runA.compile_phases as Record<string, number>;
  const pb = runB.compile_phases as Record<string, number>;
  assert.ok(pa, 'run A compile_phases present');
  assert.ok(pb, 'run B compile_phases present');
  // Totals may differ between runs (wall-clock), but both must be
  // non-negative integers.
  for (const key of ['l0_prep_ms', 'cov_estimation_ms', 'mmd_bootstrap_ms',
                     'conformal_calibration_ms', 'tau2_fit_ms', 'total_ms']) {
    assert.ok(pa[key] >= 0, `run A ${key} ≥ 0`);
    assert.ok(pb[key] >= 0, `run B ${key} ≥ 0`);
  }
});

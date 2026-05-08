// test/profile-batch-characterized-diff.test.ts — REPLY-51a D7(a) spec.
//
// Verifies llm-inference-batch@1.0.0 compile produces the expected
// characterized diff vs streaming:
//   - Family A `sli_list` excludes TTFT → 5 signals not 6
//     → family_A.per_signal has 5 entries.
//   - Joint vector (Family C/E) excludes TTFT → 10×10 covariance
//     not 11×11.
//   - α_C = 1e-4 (half of streaming's 2e-4).
//   - bonferroni_factor = 5 (matches Family A signal count).
//   - family_a_signals + family_c_signals emitted with batch-
//     specific inventories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

function compile(outPath: string, profileRef: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--families A,B,C,D,E --profile_ref ${profileRef} --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

test('D7(a) batch: family_a_signals excludes TTFT (5 signals)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7a-fam-a-signals.json');
  compile(out, 'llm-inference-batch@1.0.0');
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(Array.isArray(cfg.family_a_signals), 'family_a_signals must be emitted on profile-routed compile');
  assert.equal(cfg.family_a_signals.length, 5, 'batch sli_list excludes TTFT → 5 signals');
  assert.ok(!cfg.family_a_signals.includes('ttft'),
    `batch family_a_signals must exclude ttft; got ${JSON.stringify(cfg.family_a_signals)}`);
  assert.equal(cfg.bonferroni_factor, 5, 'bonferroni_factor tracks Family A count');
});

test('D7(a) batch: family_C covariance shape is 10×10 (no TTFT)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7a-fam-c-shape.json');
  compile(out, 'llm-inference-batch@1.0.0');
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cfg.family_c_signals.length, 10, 'batch joint_vector.signals: 10 signals (no TTFT)');
  assert.ok(!cfg.family_c_signals.includes('ttft'),
    'batch family_c_signals must exclude ttft');

  // aggregate_fallback.family_C carries compiled covariance at the
  // profile's joint-vector dimension.
  const agg = cfg.baseline_cells.aggregate_fallback.family_C;
  assert.ok(agg, 'aggregate_fallback.family_C must be present');
  assert.equal(agg.mean_vector.length, 10, 'mean_vector dim: 10');
  assert.equal(agg.covariance.length, 10, 'covariance row count: 10');
  assert.equal(agg.covariance[0].length, 10, 'covariance col count: 10');
});

test('D7(a) batch: α_budget.per_family.C = 1e-4 (half of streaming)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7a-alpha-c.json');
  compile(out, 'llm-inference-batch@1.0.0');
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(cfg.alpha_budget.per_family.C, 1e-4,
    'batch halves Family C α vs streaming');
  // Batch also reallocates A to 5e-4 per profile.
  assert.equal(cfg.alpha_budget.per_family.A, 5e-4, 'batch A = 5e-4');
});

test('D7(a) batch: per-cell family_A carries 5-signal Family A params (no ttft)', () => {
  const out = path.join(REPO_ROOT, 'runs/compiled-configs/test-d7a-per-cell-a.json');
  compile(out, 'llm-inference-batch@1.0.0');
  const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
  const cellsWithA = cfg.baseline_cells.cells.filter(
    (c: { family_A?: { per_signal: Record<string, unknown> } }) => c.family_A,
  );
  assert.ok(cellsWithA.length > 0, 'at least one cell must carry family_A');
  const firstCellA = cellsWithA[0].family_A.per_signal;
  const signals = Object.keys(firstCellA);
  assert.equal(signals.length, 5, `per-cell family_A signals: 5; got ${signals.length}`);
  assert.ok(!signals.includes('ttft'), 'per-cell family_A.per_signal must exclude ttft');
});

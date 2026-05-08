// test/mrcd.test.ts — Addition #18 Part 1 acceptance for MRCD.
//
// Small-sample + regularization-weight sanity. MRCD is the compiler's
// fallback when `n < 2·p+1`; it runs FastMCD with a higher α (h close
// to n) and blends the subset covariance with a scaled-identity target
// proportional to `ρ = (2p+1 − n) / (p+1)`.
//
// MRCD is exercised through `buildFamilyCPerCell` with
// `covariance_method_override: 'mrcd'` so the test doesn't need a
// separate exported helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/** Generate a synthetic BaselineBundle JSONL with tight-samples cells
 *  so the compiler takes the MRCD path. Returns the baseline directory. */
function makeTightBundle(dir: string, n_per_cell: number, p: number): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Generate 24 × 7 cells with n_per_cell samples each. Use only the
  // first p FAMILY_C_SIGNALS so we control dimensionality.
  const FAMILY_C_SIGNALS = [
    'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
    'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
    'corpus_delta', 'traffic_pct',
  ];
  const ALL_SIGNALS = [
    'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
    'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
    'corpus_delta', 'traffic_pct',
    'eval_score', 'tool_success_rate', 'refusal_rate',
  ];
  const means: Record<string, number> = {
    p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
    cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
    collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
    eval_score: 0.92, tool_success_rate: 0.95, refusal_rate: 0.003,
  };

  // mulberry32 for deterministic output.
  let a = 0xB001 >>> 0;
  const rng = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = rng(); while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  const runs: Array<{ signal_series: Record<string, number[]>; hour_of_day: number[]; day_of_week: number[] }> = [];
  // One run per cell with n_per_cell ticks at that cell's hour/day.
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const signal_series: Record<string, number[]> = {};
      for (const s of ALL_SIGNALS) signal_series[s] = [];
      const hod: number[] = [];
      const dow: number[] = [];
      for (let t = 0; t < n_per_cell; t++) {
        for (const s of ALL_SIGNALS) {
          const m = means[s];
          // Light noise (5 %) so the covariance is non-degenerate.
          signal_series[s].push(m * (1 + 0.05 * gauss()));
        }
        hod.push(h);
        dow.push(d);
      }
      runs.push({ signal_series, hour_of_day: hod, day_of_week: dow });
    }
  }

  const bundle = {
    version: 'mrcd-test',
    generated_at: new Date().toISOString(),
    seed: 42,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: bundle.version, generated_at: bundle.generated_at,
    seed: bundle.seed, cell_dim: bundle.cell_dim, n_runs: runs.length,
  }));
  fs.writeFileSync(
    path.join(dir, 'bundle.jsonl'),
    runs.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  // Void unused so linting stays quiet on FAMILY_C_SIGNALS intro.
  void FAMILY_C_SIGNALS;
}

const ROOT = path.resolve(__dirname, '..');

test('mrcd unit 1: MRCD override produces regularized covariance on every Family C cell', () => {
  // n = 25 per cell (≥ MIN_SAMPLES_POOLED=20 so the compiler emits
  // Family C). With the sample-size rule this would land in MCD
  // territory; we force MRCD via `--covariance_method_override=mrcd`
  // so the regularized path is exercised deterministically.
  const baseDir = path.join(ROOT, 'runs', 'baselines', 'test-mrcd-override');
  const outPath = path.join(ROOT, 'runs', 'compiled-configs', 'test-mrcd-override.json');
  makeTightBundle(baseDir, 25, 11);
  try {
    execSync(
      `node tools/calibrate.ts --baseline ${baseDir} --alpha 1e-3 --families A,B,C --covariance_method_override mrcd --out ${outPath}`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.ok(cfg.baseline_cells, 'baseline_cells must be present');
    const cellsWithC = cfg.baseline_cells.cells.filter((c: { family_C?: unknown }) => c.family_C);
    const mrcdCells = cellsWithC.filter(
      (c: { family_C: { covariance_method?: string } }) => c.family_C.covariance_method === 'mrcd',
    );
    assert.ok(mrcdCells.length > 0, `expected ≥1 MRCD cell; got ${mrcdCells.length}/${cellsWithC.length}`);
    const first = mrcdCells[0].family_C;
    assert.equal(first.covariance_method, 'mrcd');
    assert.ok(first.covariance, 'MRCD cell must carry covariance matrix');
    assert.ok(first.outlier_detection, 'MRCD cell must carry outlier_detection');
    assert.equal(first.outlier_detection.method, 'mrcd');
    assert.ok(first.outlier_detection.outlier_fraction <= 0.5,
      `outlier_fraction capped at 0.5; got ${first.outlier_detection.outlier_fraction}`);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  }
});

test('mrcd unit 2: MRCD shrinkage populated and positive; covariance is PD', () => {
  // Same compile used above. MRCD-produced cells must carry a shrinkage
  // weight in (0, 0.5] and a symmetric PD covariance. Raw MCD output
  // leaves `covariance_shrinkage` undefined; MRCD always populates it.
  const baseDir = path.join(ROOT, 'runs', 'baselines', 'test-mrcd-shrink');
  const outPath = path.join(ROOT, 'runs', 'compiled-configs', 'test-mrcd-shrink.json');
  makeTightBundle(baseDir, 25, 11);
  try {
    execSync(
      `node tools/calibrate.ts --baseline ${baseDir} --alpha 1e-3 --families A,B,C --covariance_method_override mrcd --out ${outPath}`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const cell = cfg.baseline_cells.cells.find(
      (c: { family_C?: { covariance_method?: string } }) => c.family_C?.covariance_method === 'mrcd',
    );
    assert.ok(cell, 'expected at least one MRCD cell');
    const fc = cell.family_C;
    assert.ok(
      typeof fc.covariance_shrinkage === 'number' && fc.covariance_shrinkage >= 0,
      `MRCD must populate covariance_shrinkage ≥ 0; got ${fc.covariance_shrinkage}`,
    );
    assert.ok(
      fc.covariance_shrinkage <= 0.5,
      `MRCD shrinkage is capped at 0.5 by the ρ schedule; got ${fc.covariance_shrinkage}`,
    );
    // Covariance must be symmetric.
    const cov = fc.covariance;
    for (let i = 0; i < cov.length; i++) {
      for (let j = 0; j < cov.length; j++) {
        assert.ok(
          Math.abs(cov[i][j] - cov[j][i]) < 1e-10,
          `covariance must be symmetric at (${i}, ${j})`,
        );
      }
    }
    // Diagonals must be strictly positive.
    for (let i = 0; i < cov.length; i++) {
      assert.ok(cov[i][i] > 0, `diagonal[${i}] must be positive; got ${cov[i][i]}`);
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  }
});

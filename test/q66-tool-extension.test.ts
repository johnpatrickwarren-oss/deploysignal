// test/q66-tool-extension.test.ts — Q66 item (h) follow-up.
//
// Tests for ergonomics-only extension to tools/run-shadow-compare.ts
// (--modes / --emit flag handling) + standalone tools/analyze-yw-clip-rate.ts
// post-hoc YW phi clip-rate analyzer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  analyzeOneConfig,
  analyzeConfigs,
} from '../tools/analyze-yw-clip-rate';
import type { CompiledConfig } from '../engine/types';

// ── Test fixtures ──────────────────────────────────────────────

function makeConfigWithPhis(
  phisPerSignal: Record<string, number[]>,
): CompiledConfig {
  // One cell per phi value; each cell contributes a single
  // FamilyAPerSignalParams entry per signal. Mirrors compiler output
  // for per-cell ar1_phi stamping (one phi per (cell, signal) pair).
  const cells = [] as NonNullable<CompiledConfig['baseline_cells']>['cells'];
  const allSignals = Object.keys(phisPerSignal);
  const maxLen = Math.max(...Object.values(phisPerSignal).map((a) => a.length));
  for (let i = 0; i < maxLen; i++) {
    const perSignal: Record<string, any> = {};
    for (const sig of allSignals) {
      const phi = phisPerSignal[sig][i];
      if (phi === undefined) continue;
      perSignal[sig] = {
        signal_class: 'gaussian_like',
        baseline_mean: 100,
        baseline_mean_raw: 100,
        baseline_sigma_squared: 25,
        baseline_sigma_squared_raw: 25,
        tau_squared: 6.25,
        delta_min: 5,
        ar1_phi: phi,
      };
    }
    cells.push({
      key: { hour_of_day: i },
      n_samples: 100,
      confidence: 'strict',
      family_A: { per_signal: perSignal },
    });
  }
  return {
    version: '0.1-test',
    compiler_version: '0.1-test',
    compiled_at: '2026-05-05T00:00:00Z',
    baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells,
      aggregate_fallback: { family_A: { per_signal: {} } },
    },
  };
}

function writeTempConfig(cfg: CompiledConfig, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `q66-h-test-${label}-`));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

// ── Test #1: clip-rate counts |phi| >= threshold correctly ──

test('Q66 item h: analyzeOneConfig counts |phi| >= 0.95 as clipped', () => {
  const cfg = makeConfigWithPhis({
    p99_latency: [0.1, 0.5, 0.95, -0.96, 0.2, 0.9499],  // 2 clipped (0.95 + -0.96)
  });
  const cfgPath = writeTempConfig(cfg, 'clip-rate');
  const report = analyzeOneConfig(cfgPath, 0.95, 'test_substrate');
  const stat = report.per_signal.find((s) => s.signal === 'p99_latency');
  assert.ok(stat);
  assert.equal(stat.n_cells, 6);
  assert.equal(stat.n_clipped, 2, 'phi values 0.95 and -0.96 should clip; 0.9499 should not');
  assert.ok(Math.abs(stat.clip_rate - 2 / 6) < 1e-9);
  assert.equal(report.aggregate_n_cells_with_phi, 6);
  assert.equal(report.aggregate_n_clipped, 2);
});

// ── Test #2: cells without ar1_phi are skipped ──

test('Q66 item h: analyzeOneConfig skips cells without ar1_phi (pre-Q66.A.b configs)', () => {
  // Construct a config where some cells have phi and others don't.
  const cfg: CompiledConfig = {
    version: '0.1-test', compiler_version: '0.1-test',
    compiled_at: '2026-05-05T00:00:00Z', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [
        {
          key: { hour_of_day: 0 }, n_samples: 100, confidence: 'strict',
          family_A: { per_signal: { p99_latency: {
            signal_class: 'gaussian_like',
            baseline_mean: 100, baseline_mean_raw: 100,
            baseline_sigma_squared: 25, baseline_sigma_squared_raw: 25,
            tau_squared: 6.25, delta_min: 5, ar1_phi: 0.5,
          } } },
        },
        {
          key: { hour_of_day: 1 }, n_samples: 100, confidence: 'strict',
          // No ar1_phi field on this cell's signal entry.
          family_A: { per_signal: { p99_latency: {
            signal_class: 'gaussian_like',
            baseline_mean: 100, baseline_mean_raw: 100,
            baseline_sigma_squared: 25, baseline_sigma_squared_raw: 25,
            tau_squared: 6.25, delta_min: 5,
          } } },
        },
      ],
      aggregate_fallback: { family_A: { per_signal: {} } },
    },
  };
  const cfgPath = writeTempConfig(cfg, 'no-phi');
  const report = analyzeOneConfig(cfgPath, 0.95, 'mixed');
  assert.equal(report.aggregate_n_cells_with_phi, 1, 'only 1 cell has phi stamped');
  assert.equal(report.aggregate_n_clipped, 0);
});

// ── Test #3: halt-boundary-c PASS at low clip-rate; FAIL at high ──

test('Q66 item h: halt_boundary_c_pass reflects per-substrate < 5% threshold', () => {
  // PASS substrate: 1/100 clipped (1%) is well under 5%.
  const passPhis = Array.from({ length: 100 }, (_, i) => i === 0 ? 0.99 : 0.1);
  const passCfg = makeConfigWithPhis({ p99_latency: passPhis });
  const passPath = writeTempConfig(passCfg, 'pass');
  // FAIL substrate: 10/100 clipped (10%) exceeds 5%.
  const failPhis = Array.from({ length: 100 }, (_, i) => i < 10 ? 0.99 : 0.1);
  const failCfg = makeConfigWithPhis({ p99_latency: failPhis });
  const failPath = writeTempConfig(failCfg, 'fail');

  const passOnly = analyzeConfigs([{ path: passPath, label: 'pass_substrate' }]);
  assert.equal(passOnly.halt_boundary_c_pass, true);

  const mixed = analyzeConfigs([
    { path: passPath, label: 'pass_substrate' },
    { path: failPath, label: 'fail_substrate' },
  ]);
  assert.equal(mixed.halt_boundary_c_pass, false,
    'one fail substrate should drop the global pass to false');
});

// ── Test #4: --threshold flag overrides default ──

test('Q66 item h: clip threshold parameter changes which phi values clip', () => {
  const cfg = makeConfigWithPhis({
    p99_latency: [0.1, 0.5, 0.85, 0.92, 0.97],  // 1 clip at 0.95; 3 clips at 0.80
  });
  const cfgPath = writeTempConfig(cfg, 'threshold');
  const tight = analyzeOneConfig(cfgPath, 0.95, 'tight');
  assert.equal(tight.aggregate_n_clipped, 1, 'only 0.97 clips at threshold 0.95');
  const loose = analyzeOneConfig(cfgPath, 0.80, 'loose');
  assert.equal(loose.aggregate_n_clipped, 3, '0.85 + 0.92 + 0.97 clip at threshold 0.80');
});

// ── Test #5: aggregate fallback per_signal is included ──

test('Q66 item h: aggregate_fallback.family_A.per_signal phi values counted', () => {
  // Strict cell + aggregate fallback both carry phi entries.
  const cfg: CompiledConfig = {
    version: '0.1-test', compiler_version: '0.1-test',
    compiled_at: '2026-05-05T00:00:00Z', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{
        key: { hour_of_day: 0 }, n_samples: 100, confidence: 'strict',
        family_A: { per_signal: { p99_latency: {
          signal_class: 'gaussian_like',
          baseline_mean: 100, baseline_mean_raw: 100,
          baseline_sigma_squared: 25, baseline_sigma_squared_raw: 25,
          tau_squared: 6.25, delta_min: 5, ar1_phi: 0.3,
        } } },
      }],
      aggregate_fallback: { family_A: { per_signal: { p99_latency: {
        signal_class: 'gaussian_like',
        baseline_mean: 100, baseline_mean_raw: 100,
        baseline_sigma_squared: 25, baseline_sigma_squared_raw: 25,
        tau_squared: 6.25, delta_min: 5, ar1_phi: 0.96,  // clipped
      } } } },
    },
  };
  const cfgPath = writeTempConfig(cfg, 'fallback');
  const report = analyzeOneConfig(cfgPath, 0.95, 'fallback_test');
  assert.equal(report.aggregate_n_cells_with_phi, 2,
    'strict cell + aggregate fallback = 2 phi entries');
  assert.equal(report.aggregate_n_clipped, 1,
    'aggregate fallback phi=0.96 clips; strict phi=0.3 does not');
});

// ── Test #6: empty / pre-Q66.A.b config produces zero clip-rate ──

test('Q66 item h: empty / pre-Q66.A.b config yields zero clip-rate (no false positives)', () => {
  const cfg: CompiledConfig = {
    version: '0.1-test', compiler_version: '0.1-test',
    compiled_at: '2026-05-05T00:00:00Z', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [],
      aggregate_fallback: { family_A: { per_signal: {} } },
    },
  };
  const cfgPath = writeTempConfig(cfg, 'empty');
  const report = analyzeOneConfig(cfgPath, 0.95, 'empty');
  assert.equal(report.aggregate_n_cells_with_phi, 0);
  assert.equal(report.aggregate_clip_rate, 0);
  assert.equal(report.n_signals_with_phi, 0);
});

// ── Tests #7-#9: --modes / --emit CLI flag behavior on run-shadow-compare ──

import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_SHADOW_COMPARE = path.join(REPO_ROOT, 'tools', 'run-shadow-compare.js');

test('Q66 item h: --modes accepts known modes; rejects unknown', () => {
  if (!fs.existsSync(RUN_SHADOW_COMPARE)) {
    console.log('  SKIP — dist/tools/run-shadow-compare.js missing; run npm test (pretest builds)');
    return;
  }
  // Unknown mode triggers parseCliArgs error; substrates+scenarios+seeds
  // satisfied so the modes validation is the failure surface.
  let stderr = '';
  try {
    execSync(
      `node ${RUN_SHADOW_COMPARE} `
      + `--substrates v5 --scenarios all-5 --seeds 42 `
      + `--modes iid_bootstrap,bogus_mode --dry-run`,
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.fail('should have thrown on unknown mode');
  } catch (err) {
    stderr = String((err as { stderr?: Buffer }).stderr ?? '');
  }
  assert.match(stderr, /Unknown mode 'bogus_mode'/);
});

test('Q66 item h: --modes valid trio passes parsing', () => {
  if (!fs.existsSync(RUN_SHADOW_COMPARE)) {
    console.log('  SKIP — dist/tools/run-shadow-compare.js missing');
    return;
  }
  // All three known modes parse; --dry-run avoids substrate I/O.
  // Use a non-existent output dir under tmp to avoid polluting repo.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q66-h-modes-'));
  let stdout = '';
  try {
    stdout = String(execSync(
      `node ${RUN_SHADOW_COMPARE} `
      + `--substrates v5 --scenarios all-5 --seeds 42 `
      + `--modes iid_bootstrap,parametric_gaussian,parametric_ar1 `
      + `--output-dir ${tmpDir} --dry-run`,
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    ));
  } catch (err) {
    assert.fail(`parser rejected valid modes: ${(err as Error).message}`);
  }
  assert.match(stdout, /\[run-shadow-compare\]/);
});

test('Q66 item h: --emit writes single-summary JSON with sweep meta + modes_declared', () => {
  if (!fs.existsSync(RUN_SHADOW_COMPARE)) {
    console.log('  SKIP — dist/tools/run-shadow-compare.js missing');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q66-h-emit-'));
  const summaryPath = path.join(tmpDir, 'summary.json');
  execSync(
    `node ${RUN_SHADOW_COMPARE} `
    + `--substrates v5 --scenarios all-5 --seeds 42 `
    + `--modes iid_bootstrap,parametric_gaussian,parametric_ar1 `
    + `--emit ${summaryPath} `
    + `--output-dir ${tmpDir} --dry-run`,
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.ok(fs.existsSync(summaryPath), 'summary file should be emitted');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.ok(summary.sweep_meta);
  assert.deepEqual(summary.sweep_meta.modes_declared,
    ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1']);
  // Q66 Phase-3.d.A close item (h) schema 2.3.0 — modes_note describes
  // per-mode pool emission + halt criterion (a) (no longer flags as
  // architect-scope; per-mode FPR aggregation now delivered via schema
  // bump 2.3.0 in this PR).
  assert.ok(summary.sweep_meta.modes_note.includes('Halt criterion (a)'),
    'note should describe per-mode halt criterion');
  assert.equal(summary.sweep_meta.report_card_schema_version, '2.3.0');
  assert.ok(summary.acceptance_gates !== undefined);
  assert.ok(summary.per_substrate_detector_fpr_iid_bootstrap !== undefined);
  // Schema 2.3.0 — per-mode FPR breakdowns present alongside iid.
  assert.ok(summary.per_substrate_detector_fpr_parametric_gaussian !== undefined);
  assert.ok(summary.per_substrate_detector_fpr_parametric_ar1 !== undefined);
});

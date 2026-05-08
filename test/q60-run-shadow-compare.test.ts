// test/q60-run-shadow-compare.test.ts — Q60 Slice 1 shadow-compare
// orchestrator + V2 incremental emission discipline tests.
//
// Per Q60 spec § Tests describe block 2 + V2 incremental emission
// tests per ARCHITECT-REPLY-Q60-SLICE-1-PHASE-1-1-DISPOSITION-V2 §
// Architect-required addition.
//
// Tests use --dry-run mode (orchestrator stub-emits zeros for
// per-detector counts) so empirical sweep wiring (Phase 3 build-
// report-card --profile delegation) is not required at unit-test
// time. Phase 3 empirical sweep happens on B4 Mac mini compute target
// (out of test scope).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runShadowCompare,
  type SubstrateRef,
  type ShadowCompareOpts,
} from '../tools/run-shadow-compare';
import type { SweepCheckpoint } from '../engine/types/config';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'q60-shadow-test-'));
}

const STUB_SUBSTRATE: SubstrateRef = {
  name: 'synthetic_v1',
  baselineDir: 'runs/baselines/synthetic-v1',
  compiledConfig: 'runs/compiled-configs/v5-sequential-e-process.json',
};

const TEST_SCENARIOS = [
  'anthropic_tpu_output_corruption_step_2025_09',
  'openai_routing_error_ramp_2024_12_11',
];

const TEST_SEEDS = [42, 43];

function dryRunOpts(outputDir: string): ShadowCompareOpts {
  return {
    substrates: [STUB_SUBSTRATE],
    scenarios: TEST_SCENARIOS,
    seeds: TEST_SEEDS,
    outputDir,
    dryRun: true,
    healthyWindows: 131,
  };
}

// ── V2 incremental emission discipline ──────────────────────────

test('q60 shadow-compare V2: per-(substrate × scenario × seed) checkpoint emitted', () => {
  const outDir = tmpdir();
  runShadowCompare(dryRunOpts(outDir));
  // Expected checkpoints: 1 substrate × 2 scenarios × 2 seeds = 4 files.
  const checkpointDir = path.join(outDir, 'checkpoints');
  assert.ok(fs.existsSync(checkpointDir), 'checkpoints/ subdirectory missing');
  const files = fs.readdirSync(checkpointDir);
  assert.equal(files.length, 4, `expected 4 checkpoints; got ${files.length}: [${files.join(', ')}]`);
});

test('q60 shadow-compare V2: checkpoint schema includes status + timestamps + firing counts', () => {
  const outDir = tmpdir();
  runShadowCompare(dryRunOpts(outDir));
  const sample = path.join(
    outDir, 'checkpoints',
    `synthetic_v1--${TEST_SCENARIOS[0]}--${TEST_SEEDS[0]}.json`,
  );
  const cp = JSON.parse(fs.readFileSync(sample, 'utf8')) as SweepCheckpoint;
  assert.equal(cp.substrate, 'synthetic_v1');
  assert.equal(cp.scenario, TEST_SCENARIOS[0]);
  assert.equal(cp.seed, TEST_SEEDS[0]);
  assert.equal(cp.status, 'completed');
  assert.ok(typeof cp.start_timestamp === 'number');
  assert.ok(typeof cp.end_timestamp === 'number');
  assert.ok(cp.per_detector_firing_counts);
  // V2 dry-run: stub zero counts for all 10 detector families.
  assert.equal(Object.keys(cp.per_detector_firing_counts).length, 10);
});

test('q60 shadow-compare V2: resume semantic — completed checkpoints skipped on re-run', () => {
  const outDir = tmpdir();
  // First run: emit 4 checkpoints.
  runShadowCompare(dryRunOpts(outDir));
  const checkpointDir = path.join(outDir, 'checkpoints');
  const sample = path.join(
    checkpointDir,
    `synthetic_v1--${TEST_SCENARIOS[0]}--${TEST_SEEDS[0]}.json`,
  );
  const beforeMtime = fs.statSync(sample).mtimeMs;

  // Sleep briefly to ensure mtime difference is detectable.
  const start = Date.now();
  while (Date.now() - start < 10) { /* spin */ }

  // Second run: completed checkpoints should NOT be re-written.
  runShadowCompare(dryRunOpts(outDir));
  const afterMtime = fs.statSync(sample).mtimeMs;
  assert.equal(beforeMtime, afterMtime,
    'completed checkpoint mtime should not change on re-run');
});

test('q60 shadow-compare V2: malformed checkpoint treated as missing + re-run', () => {
  const outDir = tmpdir();
  const checkpointDir = path.join(outDir, 'checkpoints');
  fs.mkdirSync(checkpointDir, { recursive: true });
  // Pre-populate a malformed checkpoint.
  const badPath = path.join(
    checkpointDir,
    `synthetic_v1--${TEST_SCENARIOS[0]}--${TEST_SEEDS[0]}.json`,
  );
  fs.writeFileSync(badPath, 'malformed json {');
  // Run should NOT crash; should overwrite malformed checkpoint.
  runShadowCompare(dryRunOpts(outDir));
  const cp = JSON.parse(fs.readFileSync(badPath, 'utf8')) as SweepCheckpoint;
  assert.equal(cp.status, 'completed');
});

// ── Per-profile report card emission ──────────────────────────────

test('q60 shadow-compare: emits per-profile report card per (substrate × scenario)', () => {
  const outDir = tmpdir();
  runShadowCompare(dryRunOpts(outDir));
  for (const scenario of TEST_SCENARIOS) {
    const reportPath = path.join(outDir, `synthetic_v1--${scenario}.json`);
    assert.ok(fs.existsSync(reportPath), `missing report card: ${reportPath}`);
    const rc = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    // ProfileReportCardBlock
    assert.equal(rc.profile.scenario, scenario);
    assert.ok(rc.profile.dataset);
    assert.ok(rc.profile.compiled_config_version);
    // Per-detector aggregates
    assert.ok(rc.per_detector_firing_counts_mean);
    assert.ok(rc.per_detector_firing_counts_per_seed);
    assert.ok(rc.per_detector_fpr_mean);
    // Stub zeros from dry-run
    assert.equal(rc.per_detector_firing_counts_mean.family_E_conformal, 0);
  }
});

// ── Cross-substrate diff ─────────────────────────────────────────

test('q60 shadow-compare: cross-substrate diff omitted for single-substrate run', () => {
  const outDir = tmpdir();
  runShadowCompare(dryRunOpts(outDir));
  // With single substrate (synthetic_v1 = reference), no cross-
  // substrate pairs to diff; aggregate file emitted but per-profile
  // diffs object empty.
  const diffPath = path.join(outDir, 'shadow-compare-cross-substrate.json');
  const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
  assert.equal(diff.reference_substrate, 'synthetic_v1');
  assert.equal(Object.keys(diff.per_profile_diffs).length, 0);
});

test('q60 shadow-compare: cross-substrate diff emitted for multi-substrate run', () => {
  const outDir = tmpdir();
  // Stub two substrates (both synthetic_v1 pointing at same paths;
  // dry-run won't actually read substrate files for FPR sweep).
  const opts: ShadowCompareOpts = {
    substrates: [
      STUB_SUBSTRATE,
      { name: 'real_burstgpt', baselineDir: STUB_SUBSTRATE.baselineDir, compiledConfig: STUB_SUBSTRATE.compiledConfig },
    ],
    scenarios: TEST_SCENARIOS,
    seeds: TEST_SEEDS,
    outputDir: outDir,
    dryRun: true,
  };
  runShadowCompare(opts);
  const diff = JSON.parse(fs.readFileSync(path.join(outDir, 'shadow-compare-cross-substrate.json'), 'utf8'));
  // Reference = synthetic_v1; diff entries for real_burstgpt × 2 scenarios.
  assert.equal(Object.keys(diff.per_profile_diffs).length, 2);
  for (const key of Object.keys(diff.per_profile_diffs)) {
    assert.ok(key.startsWith('real_burstgpt--'));
    const block = diff.per_profile_diffs[key];
    assert.equal(block.reference_substrate, 'synthetic_v1');
    assert.ok(block.delta_FPR_per_detector);
    assert.ok(block.acceptance_gates_passed);
  }
});

// ── Pitch summary ────────────────────────────────────────────────

test('q60 shadow-compare: aggregate pitch summary emitted', () => {
  const outDir = tmpdir();
  const result = runShadowCompare(dryRunOpts(outDir));
  assert.ok(fs.existsSync(result.pitch_summary_path));
  const summary = JSON.parse(fs.readFileSync(result.pitch_summary_path, 'utf8'));
  assert.equal(summary.n_substrates, 1);
  assert.equal(summary.n_scenarios, 2);
  assert.equal(summary.n_seeds, 2);
  assert.equal(summary.n_per_profile_report_cards, 2);
  assert.equal(summary.reference_substrate, 'synthetic_v1');
});

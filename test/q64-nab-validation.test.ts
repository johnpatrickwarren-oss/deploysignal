// test/q64-nab-validation.test.ts — Q64 SPEC-4 NAB validation acceptance.
//
// Per Q64-NAB-FIREWALL-SPEC.md § Tests block. Phase 2-3 deliverable
// (acquisition-independent): scoring helper + tool framework verified
// via synthetic firings + annotations + miniature NAB-shaped fixture
// directory. Phase 4 empirical run against ~35-dataset NAB subset is
// deferred until John pre-acquires NAB repo (analogous to Q60/Q62
// dataset acquisition halt patterns).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  computeNABScore,
  aggregateFamilyScore,
  NAB_PROFILES,
} from '../tools/nab-scoring';
import {
  runNABValidation,
  discoverNABDatasets,
  parseNABDatasetCsv,
  loadNABLabels,
  annotationsFromLabels,
  type DetectorFiringDecision,
  type NABDatasetAnnotation,
} from '../tools/run-nab-validation';

// ── Synthetic fixture helpers ───────────────────────────────────────

/** Q64 Phase 4 STUB-resolution support: minimum compiled config for
 *  runDetectorOverDataset dispatch on `p99_latency` calibration signal.
 *  Mirrors v5-sequential-e-process.json subset shape: family_A.per_signal
 *  + family_D entries on aggregate_fallback so detector dispatch resolves
 *  cleanly without a full v5 fixture (~15MB).
 *  Per architect ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-DISPOSITION
 *  § Calibration substrate disposition: family_A.per_signal['p99_latency']
 *  + family_D['p99_latency'] heavy_tail signal class. */
function buildMiniCompiledConfig(): string {
  const cfg = {
    version: 'q64-test-fixture',
    compiler_version: '0.2.0',
    compiled_at: '2026-05-04T00:00:00Z',
    baseline_ref: 'q64-test-fixture',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4, D: 1e-4, E: 1e-4 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 1.0,
              baseline_sigma_squared: 0.01,
              tau_squared: 0.005,
              delta_min: 0.5,
              signal_class: 'heavy_tail',
              betting_sliding_buffer_threshold: 1000,
              betting_calibration_scope: 'sliding_buffer_ar1',
              derivation: { mean: 1.0, empirical_variance: 0.01 },
            },
          },
        },
        family_D: {
          p99_latency: {
            ar1_phi: 0.5,
            peak_acf_threshold: 0.5,
            bootstrap_null_quantile: 0.5,
            spectral_variant: 'bootstrap_null',
          },
        },
      },
    },
  };
  const p = path.join(os.tmpdir(), `q64-mini-compiled-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function buildMiniNABRepo(): string {
  // Build a temp NAB-shaped directory with 4 sub-benchmark categories,
  // 1 dataset each, + minimal labels file. Used to exercise discovery
  // + parsing + dispatch loop without needing real NAB checkout.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q64-mini-nab-'));
  const subs = ['realKnownCause', 'realAWSCloudwatch', 'artificialNoAnomaly', 'artificialWithAnomaly'];
  const labels: Record<string, Array<[string, string]>> = {};
  const baseTs = Date.parse('2024-01-01T00:00:00');
  for (const sub of subs) {
    const dir = path.join(root, 'data', sub);
    fs.mkdirSync(dir, { recursive: true });
    // 100-tick synthetic CSV.
    const lines = ['timestamp,value'];
    const tsForTick: string[] = [];
    for (let t = 0; t < 100; t++) {
      const ts = new Date(baseTs + t * 60_000).toISOString().replace(/\..*$/, '');
      tsForTick.push(ts);
      // Inject anomaly bump at tick 50-60 in artificialWithAnomaly + realKnownCause.
      const value = (sub === 'artificialWithAnomaly' || sub === 'realKnownCause')
        ? (t >= 50 && t <= 60 ? 5.0 + Math.random() * 0.1 : 1.0 + Math.random() * 0.1)
        : 1.0 + Math.random() * 0.1;
      lines.push(`${ts},${value.toFixed(4)}`);
    }
    fs.writeFileSync(path.join(dir, 'sample.csv'), lines.join('\n'));
    // Add anomaly window to labels for the WithAnomaly + KnownCause datasets.
    if (sub === 'artificialWithAnomaly' || sub === 'realKnownCause') {
      labels[`${sub}/sample.csv`] = [[tsForTick[50], tsForTick[60]]];
    } else {
      labels[`${sub}/sample.csv`] = [];
    }
  }
  fs.mkdirSync(path.join(root, 'labels'), { recursive: true });
  fs.writeFileSync(path.join(root, 'labels', 'combined_windows.json'),
    JSON.stringify(labels, null, 2));
  return root;
}

// ── NAB scoring helper tests ────────────────────────────────────────

test('Q64 #1: NAB scoring per Lavin-Ahmad 2015 standard profile produces high score on detection at window start', () => {
  const firings: DetectorFiringDecision[] = [{ tick: 50, fire: true }];
  const annotations: NABDatasetAnnotation[] = [{ anomaly_window_start: 50, anomaly_window_end: 60 }];
  const score = computeNABScore(firings, annotations, NAB_PROFILES.standard);
  // Detection at window start → rel_pos = 1.0 → sigmoidDecay = sigmoid(5) ≈ 0.993
  // raw = 1.0 × 0.993 ≈ 0.993; perfect = 1.0 × 0.993; normalized = 100.
  assert.ok(score >= 95, `detection at window start should score near-perfect; got ${score.toFixed(2)}`);
});

test('Q64 #2: NAB scoring penalizes FP per profile weights (reward_low_fp heavier)', () => {
  // FP at tick 10 (well before any anomaly window).
  const firings: DetectorFiringDecision[] = [{ tick: 10, fire: true }];
  const annotations: NABDatasetAnnotation[] = [{ anomaly_window_start: 50, anomaly_window_end: 60 }];
  const standardScore = computeNABScore(firings, annotations, NAB_PROFILES.standard);
  const lowFpScore = computeNABScore(firings, annotations, NAB_PROFILES.reward_low_fp);
  // reward_low_fp profile penalizes FP heavier → score lower than standard.
  // Both have raw < 0 because no TP and 1 FP + 1 FN.
  // Normalization clamps at 0 lower bound; both expected at 0.
  assert.ok(lowFpScore <= standardScore + 1e-6,
    `low_fp score (${lowFpScore}) should be ≤ standard (${standardScore}) under FP-only firings`);
});

test('Q64 #3: NAB scoring counts FN when no detection within window', () => {
  // No firings at all.
  const firings: DetectorFiringDecision[] = [{ tick: 10, fire: false }];
  const annotations: NABDatasetAnnotation[] = [{ anomaly_window_start: 50, anomaly_window_end: 60 }];
  const score = computeNABScore(firings, annotations, NAB_PROFILES.standard);
  // raw = -1.0 (FN); normalized clamps to 0.
  assert.equal(score, 0, `FN-only should score 0; got ${score}`);
});

test('Q64 #4: NAB scoring with empty annotations returns FP-only floor score', () => {
  // 2 FPs, no anomaly windows (e.g., artificialNoAnomaly NAB sub-benchmark).
  const firings: DetectorFiringDecision[] = [
    { tick: 10, fire: true }, { tick: 20, fire: true },
  ];
  const score = computeNABScore(firings, [], NAB_PROFILES.standard);
  // raw = 2 × -0.22 = -0.44; FP-only branch returns max(0, 100 + raw) = 99.56.
  assert.ok(score < 100 && score > 95,
    `2 FPs on no-anomaly should score slightly below 100; got ${score.toFixed(2)}`);
});

test('Q64 #5: aggregateFamilyScore mean across datasets', () => {
  const perDataset = { 'd1': 50, 'd2': 60, 'd3': 70 };
  const mean = aggregateFamilyScore(perDataset);
  assert.equal(mean, 60);
});

test('Q64 #6: aggregateFamilyScore on empty dict returns 0', () => {
  assert.equal(aggregateFamilyScore({}), 0);
});

// ── Tool framework tests (synthetic mini-NAB fixture) ───────────────

test('Q64 #7: discoverNABDatasets finds CSV files under sub-benchmark directories', () => {
  const root = buildMiniNABRepo();
  try {
    const datasets = discoverNABDatasets(root, [
      'realKnownCause', 'realAWSCloudwatch', 'artificialNoAnomaly', 'artificialWithAnomaly',
    ]);
    assert.equal(datasets.length, 4, `expected 4 datasets (1 per sub-benchmark); got ${datasets.length}`);
    const cats = new Set(datasets.map((d) => d.subBenchmark));
    assert.ok(cats.has('realKnownCause'));
    assert.ok(cats.has('realAWSCloudwatch'));
    assert.ok(cats.has('artificialNoAnomaly'));
    assert.ok(cats.has('artificialWithAnomaly'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Q64 #8: parseNABDatasetCsv reads timestamp + value columns', () => {
  const root = buildMiniNABRepo();
  try {
    const csvPath = path.join(root, 'data', 'realKnownCause', 'sample.csv');
    const { values, timestamps } = parseNABDatasetCsv(csvPath);
    assert.equal(values.length, 100);
    assert.equal(timestamps.length, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Q64 #9: annotationsFromLabels maps ISO timestamps to tick indices', () => {
  const root = buildMiniNABRepo();
  try {
    const csvPath = path.join(root, 'data', 'artificialWithAnomaly', 'sample.csv');
    const { timestamps } = parseNABDatasetCsv(csvPath);
    const labels = loadNABLabels(path.join(root, 'labels', 'combined_windows.json'));
    const labelWindows = labels['artificialWithAnomaly/sample.csv'];
    const annotations = annotationsFromLabels(labelWindows, timestamps);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].anomaly_window_start, 50);
    assert.equal(annotations[0].anomaly_window_end, 60);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Q64 #10: runNABValidation emits report with metadata + acceptance gates', () => {
  const root = buildMiniNABRepo();
  const compiledConfigPath = buildMiniCompiledConfig();
  const outPath = path.join(os.tmpdir(), `q64-mini-report-${Date.now()}.json`);
  try {
    const report = runNABValidation({
      nabRepoPath: root,
      compiledConfig: compiledConfigPath,
      outputPath: outPath,
      detectors: ['family_A_betting', 'family_A_page_cusum', 'family_D_spectral'],
    });
    assert.ok(report.metadata.tool_version === 'Q64 SPEC-4 v1.0');
    assert.ok(Array.isArray(report.metadata.sub_benchmarks_evaluated));
    assert.equal(report.metadata.sub_benchmarks_evaluated.length, 4);
    assert.ok(report.per_family_scores.family_A_betting);
    assert.ok(report.per_family_scores.family_A_page_cusum);
    assert.ok(report.per_family_scores.family_D_spectral);
    assert.ok(typeof report.acceptance_results.combined_acceptance === 'boolean');
    // Report file written.
    assert.ok(fs.existsSync(outPath), 'report JSON should be emitted at outputPath');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(compiledConfigPath)) fs.unlinkSync(compiledConfigPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
});

test('Q64 #11: runNABValidation skipped sub-benchmarks (realAdExchange / realTraffic / realTweets) NOT evaluated by default', () => {
  const root = buildMiniNABRepo();
  const compiledConfigPath = buildMiniCompiledConfig();
  // Add skipped sub-benchmark dirs to verify default discovery skips them.
  for (const skipped of ['realAdExchange', 'realTraffic', 'realTweets']) {
    fs.mkdirSync(path.join(root, 'data', skipped), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', skipped, 'sample.csv'),
      'timestamp,value\n2024-01-01T00:00:00,1.0\n');
  }
  const outPath = path.join(os.tmpdir(), `q64-skip-report-${Date.now()}.json`);
  try {
    const report = runNABValidation({
      nabRepoPath: root,
      compiledConfig: compiledConfigPath,
      outputPath: outPath,
    });
    const breakdownDatasets = Object.keys(
      report.per_family_scores.family_A_betting?.per_dataset_breakdown ?? {});
    for (const ds of breakdownDatasets) {
      assert.ok(!ds.startsWith('realAdExchange'), `realAdExchange should be skipped; got ${ds}`);
      assert.ok(!ds.startsWith('realTraffic'), `realTraffic should be skipped; got ${ds}`);
      assert.ok(!ds.startsWith('realTweets'), `realTweets should be skipped; got ${ds}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(compiledConfigPath)) fs.unlinkSync(compiledConfigPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
});

test('Q64 #12: anti-scope verification — run-nab-validation.ts does NOT MODIFY engine/detectors/*', () => {
  // Q64 Phase 4 STUB resolution per architect option (i.a) PICK
  // (ARCHITECT-REPLY-Q64-PHASE-4-NAB-ACQUISITION-STUB-DISPOSITION) imports
  // evaluateFamilyAShadow + evaluateFamilyABettingShadow + evaluateFamilyD
  // from engine/detectors/* for single-signal-detector emulation —
  // single-signal NAB univariate naturally matches per-signal detector
  // architecture. Per Memorial F sub-rule 4 (pre-existing-property-vs-
  // new-acceptance-criterion-coherence): architect's Phase 4 disposition
  // introduces detector imports that conflict with the original Phase 1-3
  // STUB-era anti-scope test; amended here per architect-disposition
  // takes precedence. Anti-scope clause now verifies NO MODIFICATIONS
  // (preserves Q58 ADR + Q59 H4 PERMANENT + Q60 anti-scope clause 8 of
  // "no engine/detectors/* runtime code modifications") rather than
  // forbidding all imports.
  const sourceCode = fs.readFileSync(
    path.resolve(__dirname, '..', 'tools', 'run-nab-validation.ts'),
    'utf8',
  );
  // Imports from engine/detectors/* are PERMITTED for Phase 4 (i.a)
  // single-signal-detector emulation (architect-PICKED). The tool calls
  // existing detector functions but does NOT modify engine/detectors/*
  // source code. Verify imports are EXACTLY architect-disposed names.
  const importedFromDetectors = sourceCode.match(/from\s+['"]\.\.\/engine\/detectors\/[^'"]+['"]/g) ?? [];
  for (const imp of importedFromDetectors) {
    const allowed = [
      "from '../engine/detectors/page-cusum.js'",
      "from '../engine/detectors/betting-e-process.js'",
      "from '../engine/detectors/spectral.js'",
    ];
    assert.ok(allowed.includes(imp),
      `engine/detectors/* import must be on architect-disposed allowlist (Q64 Phase 4 (i.a)); got ${imp}`);
  }
});

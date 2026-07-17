// test/comparator-baseline-real-trace.test.ts — tests for the v8/v9
// real-trace healthy-FP-only SECONDARY study (ENDPOINTS.md Open Question
// 4's deferred follow-up): (a) CLI flag parsing + frozen-param
// interaction (--healthy-fp-only must NOT require
// --allow-nonregistered-params at the frozen defaults — it IS registered
// via OQ-4 — but still inherits the same hard-fail-on-mismatch behavior
// for any CLI override); (b) the window-generation feasibility gate's
// skip path, both the literal OQ-4 text (listPopulatedCells) and the
// deeper collectCellRows-completeness precondition the frozen generator
// itself requires; (c) determinism of the secondary report, at both the
// CLI level and the pure-function level; (d) the secondary report's
// per-arm shape never carries the primary-only metric keys
// (escaped_regressions / detection_delay_ticks) — the secondary-shape
// analog of the primary endpoint-freeze test's exact-keys assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  checkSubstrateFeasibility,
  restrictTunedThresholdForSubstrate,
  restrictCanaryForSubstrate,
  evaluateSubstrateHealthyFp,
  REAL_TRACE_ARM_IDS,
  REAL_TRACE_SUBSTRATES,
  type RealTraceArmResult,
} from '../tools/_comparator-baseline-real-trace';
import type { Baseline, CompiledConfig, EndpointsSpec } from '../tools/_comparator-baseline-types';
import type { ThresholdParams } from '../tools/_comparator-baseline-threshold';
import type { CanaryParams } from '../tools/_comparator-baseline-canary';

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'tools', 'run-comparator-baseline.ts');

function loadEndpointsSpec(): EndpointsSpec {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'runs', 'comparator-baseline', 'ENDPOINTS.md'), 'utf8');
  const match = md.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, 'ENDPOINTS.md must contain a fenced json block');
  return JSON.parse(match![1]) as EndpointsSpec;
}

function scratchPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparator-baseline-real-trace-'));
  return path.join(dir, name);
}

function runCli(extraArgs: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CLI, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── Fixture: a small in-memory substrate with COMPLETE per-tick signal
//    coverage — unlike all four real v8/v9 bundles (verified empirically:
//    each carries real data for only 1-3 of 15 manifest signals, so
//    collectCellRows never resolves a row for any of them — see (b)
//    below), this fixture exercises the actual arm-evaluation "happy
//    path" that the real bundles currently never reach. ──────────────

function buildFixtureBaseline(): Baseline {
  const n = 40;
  const sigA: number[] = [];
  const sigB: number[] = [];
  const hourOfDay: number[] = [];
  const dayOfWeek: number[] = [];
  for (let i = 0; i < n; i++) {
    sigA.push(10 + (i % 5) * 0.1);
    sigB.push(20 + (i % 7) * 0.1);
    hourOfDay.push(0);
    dayOfWeek.push(0);
  }
  return {
    manifest: { signals: ['sig_a', 'sig_b'] },
    runs: [{ hour_of_day: hourOfDay, day_of_week: dayOfWeek, signal_series: { sig_a: sigA, sig_b: sigB } }],
    signalMeans: { sig_a: 10.2, sig_b: 20.3 },
  };
}

function buildFixtureCompiledConfig(): CompiledConfig {
  return {
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: { family_A: { per_signal: { sig_a: { baseline_mean: 10.2, baseline_sigma_squared: 0.04 } } } },
    },
  };
}

function buildFixtureSpec(overrides: Partial<EndpointsSpec['frozen_params']> = {}): EndpointsSpec {
  const base = loadEndpointsSpec();
  return {
    ...base,
    frozen_params: {
      ...base.frozen_params,
      healthy_windows: 20,
      tuning_windows: 0,
      eval_seed: 42,
      canary_ticks: 20,
      injection_tick: 5,
      bake_hours: 1,
      resampler: 'iid_bootstrap',
      direction_table: { up_bad: ['sig_a', 'sig_b', 'sig_c'], down_bad: [], two_sided: [] },
      ...overrides,
    },
  };
}

const FIXTURE_TUNED_THRESHOLD: ThresholdParams = {
  kPerSignal: { sig_a: 3, sig_b: 3 },
  consecutiveTicks: 2,
  directions: { sig_a: 'up', sig_b: 'up', sig_c: 'up' },
};

const FIXTURE_TUNED_CANARY: CanaryParams = {
  alpha: 0.05,
  lookScheduleTicks: [10, 15, 19],
  windowTicks: 5,
  directions: { sig_a: 'up', sig_b: 'up', sig_c: 'up' },
  signals: ['sig_a', 'sig_b', 'sig_c'],
};

// ── (a) CLI flag parsing + frozen-param interaction ─────────────────

test('healthy-fp-only: registered run at frozen defaults exits 0 without --allow-nonregistered-params', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');
  const result = runCli(['--healthy-fp-only', '--out', outPath, '--summary', summaryPath]);
  assert.equal(result.status, 0, `expected success; stderr:\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(report.non_registered_run, undefined, 'a registered (no-override) run must not be stamped non_registered_run');
  assert.equal(report.window_generation.healthy_windows, 131, 'must use the frozen healthy_windows=131');
  assert.equal(report.window_generation.seed, 42, 'must use the frozen eval_seed=42');
  assert.equal(report.secondary, true);
  assert.equal(report.metric_scope, 'real_trace_healthy_fp');
});

test('healthy-fp-only: a frozen-param mismatch without --allow-nonregistered-params exits non-zero and writes nothing', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');
  const result = runCli(['--healthy-fp-only', '--healthy-windows', '5', '--out', outPath, '--summary', summaryPath]);
  assert.notEqual(result.status, 0, 'CLI must exit non-zero on an unacknowledged frozen-param mismatch');
  assert.ok(/frozen/i.test(result.stderr), 'stderr should explain the frozen-param disagreement');
  assert.ok(!fs.existsSync(outPath), 'no report should be written when the run is refused');
});

test('healthy-fp-only: --allow-nonregistered-params with an override runs and stamps non_registered_run:true', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');
  const result = runCli([
    '--healthy-fp-only', '--healthy-windows', '5', '--allow-nonregistered-params',
    '--out', outPath, '--summary', summaryPath,
  ]);
  assert.equal(result.status, 0, `expected success; stderr:\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(report.non_registered_run, true);
  assert.equal(report.window_generation.healthy_windows, 5);
});

test('healthy-fp-only: --tuned-params provenance is echoed with a path and a sha256', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');
  const result = runCli([
    '--healthy-fp-only', '--tuned-params', 'runs/comparator-baseline/report-synthetic-v1.json',
    '--out', outPath, '--summary', summaryPath,
  ]);
  assert.equal(result.status, 0, `expected success; stderr:\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(report.tuned_params_provenance.source_report, 'runs/comparator-baseline/report-synthetic-v1.json');
  assert.match(report.tuned_params_provenance.sha256, /^[0-9a-f]{64}$/);
});

// ── (b) window-generation feasibility gate skip path ────────────────

test('feasibility gate: a baseline with no hour_of_day/day_of_week arrays is infeasible', () => {
  const baseline: Baseline = {
    manifest: { signals: ['sig_a'] },
    runs: [{ signal_series: { sig_a: [1, 2, 3] } }],
    signalMeans: { sig_a: 2 },
  };
  const f = checkSubstrateFeasibility(baseline);
  assert.equal(f.feasible, false);
  assert.match(f.reason!, /hour_of_day\/day_of_week/);
});

test('feasibility gate: a baseline with hour/day metadata but under minSamples per cell is infeasible', () => {
  const baseline: Baseline = {
    manifest: { signals: ['sig_a'] },
    runs: [{ hour_of_day: [0, 0, 1], day_of_week: [0, 0, 0], signal_series: { sig_a: [1, 2, 3] } }],
    signalMeans: { sig_a: 2 },
  };
  const f = checkSubstrateFeasibility(baseline, 20);
  assert.equal(f.feasible, false);
  assert.match(f.reason!, /listPopulatedCells/);
});

test('feasibility gate: all four real v8/v9 substrates fail the deeper collectCellRows-completeness precondition today', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ioModule = require('../tools/_build-report-card-io');
  for (const substrate of REAL_TRACE_SUBSTRATES) {
    const baseline: Baseline = ioModule.loadBaseline(path.join(REPO_ROOT, substrate.baselineDir));
    const f = checkSubstrateFeasibility(baseline);
    assert.equal(f.feasible, false, `expected ${substrate.id} to fail the completeness precondition`);
    assert.match(f.reason!, /zero rows with ALL baseline\.manifest\.signals defined/, `${substrate.id}: reason should name the completeness failure, not a different one`);
  }
});

test('feasibility gate: a fixture with complete per-tick signal coverage IS feasible', () => {
  const f = checkSubstrateFeasibility(buildFixtureBaseline());
  assert.equal(f.feasible, true);
  assert.equal(f.populatedCells, 1);
});

test('healthy-fp-only: the registered CLI run documents an explicit skipped_substrates entry per real substrate (all four skip today)', () => {
  const outPath = scratchPath('report.json');
  const summaryPath = scratchPath('summary.md');
  const result = runCli(['--healthy-fp-only', '--out', outPath, '--summary', summaryPath]);
  assert.equal(result.status, 0);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(report.substrates.length, 0);
  assert.equal(report.skipped_substrates.length, REAL_TRACE_SUBSTRATES.length);
  const skippedIds = report.skipped_substrates.map((s: { id: string }) => s.id).sort();
  const expectedIds = REAL_TRACE_SUBSTRATES.map((s) => s.id).sort();
  assert.deepEqual(skippedIds, expectedIds);
  for (const s of report.skipped_substrates) {
    assert.equal(typeof s.reason, 'string');
    assert.ok(s.reason.length > 0);
  }
});

// ── (c) determinism of the secondary report ──────────────────────────

function stripGeneratedAt(reportJson: string): string {
  const parsed = JSON.parse(reportJson) as Record<string, unknown>;
  delete parsed.generated_at;
  return JSON.stringify(parsed, null, 2);
}

test('determinism: two identical registered CLI runs produce byte-identical reports (minus generated_at)', () => {
  const outA = scratchPath('report.json');
  const outB = scratchPath('report.json');
  const summaryA = scratchPath('summary.md');
  const summaryB = scratchPath('summary.md');
  runCli(['--healthy-fp-only', '--out', outA, '--summary', summaryA]);
  runCli(['--healthy-fp-only', '--out', outB, '--summary', summaryB]);
  const a = fs.readFileSync(outA, 'utf8');
  const b = fs.readFileSync(outB, 'utf8');
  assert.equal(stripGeneratedAt(a), stripGeneratedAt(b));
});

test('determinism: two evaluateSubstrateHealthyFp calls against the same fixture produce deeply equal results', () => {
  const baseline = buildFixtureBaseline();
  const compiledConfig = buildFixtureCompiledConfig();
  const spec = buildFixtureSpec();
  const resultA = evaluateSubstrateHealthyFp('fixture', baseline, compiledConfig, spec, FIXTURE_TUNED_THRESHOLD, FIXTURE_TUNED_CANARY);
  const resultB = evaluateSubstrateHealthyFp('fixture', baseline, compiledConfig, spec, FIXTURE_TUNED_THRESHOLD, FIXTURE_TUNED_CANARY);
  assert.deepEqual(resultA, resultB);
});

// ── (d) secondary report shape never carries primary-only metric keys ──

test('secondary shape: evaluateSubstrateHealthyFp restricts reused tuned params per substrate and reports false_rollbacks only (no escaped_regressions/detection_delay_ticks)', () => {
  const baseline = buildFixtureBaseline();
  const compiledConfig = buildFixtureCompiledConfig();
  const spec = buildFixtureSpec();
  const outcome = evaluateSubstrateHealthyFp('fixture', baseline, compiledConfig, spec, FIXTURE_TUNED_THRESHOLD, FIXTURE_TUNED_CANARY);
  assert.equal(outcome.skipped, false, 'fixture must be feasible');
  if (outcome.skipped) return; // unreachable; narrows the type for TS below

  assert.equal(outcome.window_count, 20);
  assert.deepEqual(Object.keys(outcome.arms).sort(), [...REAL_TRACE_ARM_IDS].sort());

  // threshold_tuned: only sig_a survives (sig_b has no family_A calibration
  // in the fixture's aggregate_fallback — mirrors v8a's real cost_req-only
  // coverage).
  assert.deepEqual(outcome.arms.threshold_tuned.usable_signals, ['sig_a']);
  assert.deepEqual(outcome.arms.threshold_tuned.dropped_signals, ['sig_b']);

  // canary_tuned: sig_a + sig_b survive (both in the fixture's manifest);
  // sig_c is dropped (not in the manifest at all).
  assert.deepEqual(outcome.arms.canary_tuned.usable_signals!.slice().sort(), ['sig_a', 'sig_b']);
  assert.deepEqual(outcome.arms.canary_tuned.dropped_signals, ['sig_c']);
  assert.equal(outcome.arms.canary_tuned.skipped, undefined, 'canary has usable signals, so it must not be skipped');

  for (const armId of REAL_TRACE_ARM_IDS) {
    const arm: RealTraceArmResult = outcome.arms[armId];
    assert.ok('false_rollbacks' in arm, `${armId} must report false_rollbacks`);
    assert.equal(arm.false_rollbacks.total, 20);
    assert.ok(arm.false_rollbacks.count >= 0 && arm.false_rollbacks.count <= 20);
    assert.equal(arm.false_rollbacks.rate, arm.false_rollbacks.count / 20);

    // The primary endpoints' exact-keys assertion (ARM_REPORT_KEYS in
    // _comparator-baseline-report.ts) applies to ComparatorBaselineReport,
    // a DIFFERENT type from RealTraceArmResult — structurally verify here,
    // at runtime, that the secondary shape never carries either primary-
    // only key, rather than relying on the type system alone.
    const keys = Object.keys(arm);
    assert.ok(!keys.includes('escaped_regressions'), `${armId} must not carry the primary escaped_regressions key`);
    assert.ok(!keys.includes('detection_delay_ticks'), `${armId} must not carry the primary detection_delay_ticks key`);
    const allowedKeys = new Set(['false_rollbacks', 'usable_signals', 'dropped_signals', 'skipped', 'skip_reason']);
    for (const k of keys) assert.ok(allowedKeys.has(k), `${armId}: unexpected key "${k}"`);
  }
});

test('secondary shape: a canary arm with zero usable signals is marked skipped with a reason, not reported as a vacuous 0% row', () => {
  const baseline = buildFixtureBaseline(); // manifest: sig_a, sig_b only
  const compiledConfig = buildFixtureCompiledConfig();
  const spec = buildFixtureSpec();
  const tunedCanaryAllForeign: CanaryParams = {
    ...FIXTURE_TUNED_CANARY,
    signals: ['sig_x', 'sig_y'], // neither present in the fixture's manifest
  };
  const outcome = evaluateSubstrateHealthyFp('fixture', baseline, compiledConfig, spec, FIXTURE_TUNED_THRESHOLD, tunedCanaryAllForeign);
  assert.equal(outcome.skipped, false);
  if (outcome.skipped) return;
  assert.equal(outcome.arms.canary_tuned.skipped, true);
  assert.equal(outcome.arms.canary_tuned.usable_signals?.length, 0);
  assert.ok(outcome.arms.canary_tuned.skip_reason && outcome.arms.canary_tuned.skip_reason.length > 0);
});

// ── restriction-function unit tests (isolated from the full evaluation) ──

test('restrictTunedThresholdForSubstrate: verifies against v8a\'s real cost_req-only family_A coverage', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compiledConfig: CompiledConfig = require(path.join(REPO_ROOT, 'runs', 'compiled-configs', 'v8a-real-burstgpt-v1.json'));
  const primaryReport = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'runs', 'comparator-baseline', 'report-synthetic-v1.json'), 'utf8'),
  ) as { tuning: { threshold: { params: ThresholdParams } } };
  const restricted = restrictTunedThresholdForSubstrate(primaryReport.tuning.threshold.params, compiledConfig);
  assert.deepEqual(restricted.usableSignals, ['cost_req'], 'v8a compiled config only calibrates cost_req via family_A');
  assert.deepEqual(Object.keys(restricted.params.kPerSignal), ['cost_req']);
  assert.equal(restricted.params.kPerSignal.cost_req, primaryReport.tuning.threshold.params.kPerSignal.cost_req);
  assert.ok(restricted.droppedSignals.length > 0, 'the other primary-tuned signals must be reported as dropped, not silently vanish');
});

test('restrictCanaryForSubstrate: drops signals absent from the substrate manifest, keeps the rest', () => {
  const baseline = buildFixtureBaseline();
  const restricted = restrictCanaryForSubstrate(FIXTURE_TUNED_CANARY, baseline);
  assert.deepEqual(restricted.usableSignals.slice().sort(), ['sig_a', 'sig_b']);
  assert.deepEqual(restricted.droppedSignals, ['sig_c']);
  assert.equal(restricted.skipped, false);
});

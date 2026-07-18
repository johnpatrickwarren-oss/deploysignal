// test/recalibration-refresh-cli.test.ts — R2 Task 9. `refresh` handler
// + CLI-wiring matrix. Imports handlers directly (no child_process, per
// the established q60/Task-8 pattern), mkdtemp roots, tiny hand-written
// timestamped bundle fixtures written straight to disk (loadBundle reads
// off fs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runPropose, main, parseArgv,
} from '../tools/recalibrate/_recalibrate-cli';
import { runRefresh } from '../tools/recalibrate/_recalibrate-refresh';
import { buildProposedCandidate } from '../tools/recalibrate/_recalibrate-candidate';
import { RecalibrationStore, type ActivePointer } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import type { CompiledConfig } from '../engine/types';
import type { BaselineBundle } from '../engine/types';
import type { CandidateRecord } from '../engine/types/recalibration';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-refresh-cli-test-'));
}

// ── fixture bundle: 4 runs x 60 hourly ticks, 2 signals ────────────────

const BUNDLE_VERSION = 'fixture-refresh-source-v1';
const RUN_STARTS = [
  '2026-06-01T00:00:00.000Z',
  '2026-06-04T00:00:00.000Z',
  '2026-06-07T00:00:00.000Z',
  '2026-06-10T00:00:00.000Z',
];
const TICKS_PER_RUN = 60;
const TICK_SECONDS = 3600;
const NOW_ISO = '2026-06-15T00:00:00.000Z';

function makeTimestampedRun(startIso: string): BaselineBundle['runs'][number] {
  const p99: number[] = [];
  const ttft: number[] = [];
  const hod: number[] = [];
  for (let t = 0; t < TICKS_PER_RUN; t++) {
    p99.push(100 + t);
    ttft.push(0.5 + t * 0.01);
    hod.push(t % 24);
  }
  return {
    tenant_id: 'aggregate',
    start_iso: startIso,
    hour_of_day: hod,
    signal_series: { p99_latency: p99, ttft },
  };
}

function makeTimestampedBundle(): BaselineBundle {
  return {
    version: BUNDLE_VERSION,
    generated_at: '2026-06-01T00:00:00.000Z',
    seed: 11,
    cell_dim: 'hour_of_day',
    tick_seconds: TICK_SECONDS,
    runs: RUN_STARTS.map(makeTimestampedRun),
  };
}

function writeSourceBundleDir(dir: string, bundle: BaselineBundle): string {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    version: bundle.version,
    generated_at: bundle.generated_at,
    seed: bundle.seed,
  };
  if (bundle.cell_dim !== undefined) manifest.cell_dim = bundle.cell_dim;
  if (bundle.tick_seconds !== undefined) manifest.tick_seconds = bundle.tick_seconds;
  if (bundle.baseline_provenance !== undefined) manifest.baseline_provenance = bundle.baseline_provenance;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'bundle.jsonl'), bundle.runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

// ── active CompiledConfig fixture: family_A only, alpha total 1e-3 ─────

function makeActiveConfig(overrides: Partial<CompiledConfig> = {}): CompiledConfig {
  return {
    version: 'v-active@seed=42',
    compiler_version: '0.3.0',
    compiled_at: '2026-05-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=42',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 130, baseline_sigma_squared: 400, tau_squared: 400, delta_min: 20,
            },
            ttft: {
              baseline_mean: 0.8, baseline_sigma_squared: 0.05, tau_squared: 0.02, delta_min: 0.1,
            },
          },
        },
      },
    },
    ...overrides,
  } as CompiledConfig;
}

function seedActiveConfig(root: string, store: RecalibrationStore): { activeConfigPath: string; pointer: ActivePointer } {
  const activeConfigPath = path.join(root, 'active-config.json');
  fs.writeFileSync(activeConfigPath, JSON.stringify(makeActiveConfig()));
  const pointer: ActivePointer = {
    schema_version: '1',
    version_id: 'v-active@seed=42',
    candidate_id: null,
    compiled_config_path: activeConfigPath,
    baseline_ref: 'v-active@seed=42',
    promoted_at: '2026-05-01T00:00:00.000Z',
    predecessor_version_id: null,
    promotion_history: [],
  };
  fs.writeFileSync(path.join(store.dir, 'active.json'), JSON.stringify(pointer));
  return { activeConfigPath, pointer };
}

function readCandidateConfig(p: string): CompiledConfig {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CompiledConfig;
}

// ── happy path ───────────────────────────────────────────────────────

test('refresh: happy path -> pending_shadow, compiled config with all ten D1-D10 diagnostics + suffixed version', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-refresh');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO,
  });

  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  const candidateId = 'refresh-20260615T000000Z';
  const rec = store.readCandidate(candidateId);
  assert.equal(rec.review_status, 'pending_shadow');
  assert.equal(rec.creation_reason, 'operator_manual');
  assert.equal(rec.source_window.n_samples, 240);
  assert.equal(rec.source_window.excluded_windows_applied, 0);

  const candidateConfig = readCandidateConfig(rec.compiled_config_path);
  assert.ok(candidateConfig.version.endsWith(`+refresh-${candidateId}`), candidateConfig.version);
  const diagnostics = candidateConfig.baseline_curation_pipeline_diagnostics ?? {};
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']) {
    assert.ok(diagnostics[id as keyof typeof diagnostics], `missing diagnostic ${id}`);
  }
});

// ── exclusion-drop counting (load-bearing) ──────────────────────────

const EXCLUSION_IN_RUN1 = {
  start: '2026-06-04T10:00:00.000Z', end: '2026-06-04T20:00:00.000Z', reason: 'incident',
};

function writeExclusions(store: RecalibrationStore, windows: object[]): void {
  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify({ schema_version: '1', windows }));
}

test('refresh: exclusion-drop counting — mid-run exclusion drops exact ticks, splits a segment, and PASSES the gate (Task-1 threading)', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-excl');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());
  writeExclusions(store, [EXCLUSION_IN_RUN1]);

  const emitter = new InMemoryLifecycleEventEmitter();
  const candidateId = 'cand-excl-1';
  const result = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId,
  });

  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  const rec = store.readCandidate(candidateId);
  assert.equal(rec.review_status, 'pending_shadow');
  assert.equal(rec.source_window.n_samples, 230); // 240 - 10 excluded ticks
  assert.equal(rec.source_window.excluded_windows_applied, 1);

  const outDir = path.join(store.dir, 'refresh', candidateId);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'selection-report.json'), 'utf8'));
  assert.equal(report.n_ticks_in, 240);
  assert.equal(report.n_ticks_excluded, 10);
  assert.equal(report.n_ticks_selected, 230);
  assert.equal(report.n_segments_out, 5); // run1 split into 2 segments
  assert.equal(report.excluded_spans.length, 1);
  assert.equal(report.excluded_spans[0].n_ticks_dropped, 10);
  assert.equal(report.excluded_spans[0].n_runs_affected, 1);
  assert.equal(report.exclusions_applied_at_selection, true);
});

// ── backstop intact (direct propose, no refresh) ────────────────────

test('refresh: backstop intact — direct runPropose with the same overlapping window (no selectionAppliedExclusions) fails the gate', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-backstop');
  seedActiveConfig(root, store);
  const candidateConfigPath = path.join(root, 'candidate.json');
  fs.writeFileSync(candidateConfigPath, JSON.stringify(makeActiveConfig({ version: 'v-candidate@seed=99' })));
  writeExclusions(store, [EXCLUSION_IN_RUN1]);

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runPropose(store, emitter, {
    candidateId: 'cand-backstop',
    candidateConfigPath,
    creationReason: 'operator_manual',
    sourceWindow: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-15T00:00:00.000Z', n_samples: 240 },
    now: NOW_ISO,
  });
  assert.equal(result.exitCode, 2);
  assert.ok(result.lines.some((l) => l.includes('source_window_outside_exclusions: FAIL')));
  const rec = store.readCandidate('cand-backstop');
  assert.equal(rec.status, 'rejected');
});

// ── late-declared exclusion race ────────────────────────────────────

test('refresh: late-declared exclusion race — a second exclusion unknown to the selection still fails the gate', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-race');
  seedActiveConfig(root, store);
  const candidateConfigPath = path.join(root, 'candidate.json');
  fs.writeFileSync(candidateConfigPath, JSON.stringify(makeActiveConfig({ version: 'v-candidate@seed=99' })));

  // Selection step "applied" exclusion1 only (captured at selection time).
  const selectionAppliedExclusions = [EXCLUSION_IN_RUN1];
  // An operator declares a SECOND overlapping exclusion after selection
  // ran but before propose is called -- both now live in the store.
  const lateExclusion = { start: '2026-06-05T00:00:00.000Z', end: '2026-06-05T06:00:00.000Z', reason: 'incident-2-late' };
  writeExclusions(store, [EXCLUSION_IN_RUN1, lateExclusion]);

  const outcome = buildProposedCandidate({
    store,
    candidateId: 'cand-race',
    candidateConfigPath,
    creationReason: 'operator_manual',
    sourceWindow: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-15T00:00:00.000Z', n_samples: 240 },
    nowIso: NOW_ISO,
    selectionAppliedExclusions,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.readiness.source_window_outside_exclusions, false);
});

// ── dry-run: zero store mutation ────────────────────────────────────

function staleReviewableCandidate(id: string): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-dryrun',
    candidate_id: id,
    proposed_baseline_version: 'v-old@seed=1',
    current_baseline_version: 'v-active@seed=42',
    direction_classification: 'mixed',
    per_signal_direction: {},
    suggested_reason_codes: [],
    shadow_mode_validated_at: '2026-05-01T00:00:00.000Z',
    shadow_report_path: 'x.json',
    timeout_at: '2026-06-10T00:00:00.000Z',
    status: 'candidate',
    review_status: 'reviewable',
    creation_reason: 'operator_manual',
    created_at: '2026-05-01T00:00:00.000Z',
    source_window: {
      start: '2026-04-01T00:00:00.000Z', end: '2026-05-01T00:00:00.000Z', n_samples: 100, excluded_windows_applied: 0,
    },
    compiled_config_path: 'x.json',
    outcome: null,
    history: [],
  };
}

test('refresh: --dry-run performs zero store mutation; out-dir artifacts still materialize; a later real refresh does sweep', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-dryrun');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());

  const staleId = 'cand-stale-dryrun';
  store.writeCandidate(staleReviewableCandidate(staleId));

  const eventsBefore = store.readEvents().length;
  const candidatesBefore = store.listCandidates().length;

  const emitter = new InMemoryLifecycleEventEmitter();
  const dryRunCandidateId = 'cand-dryrun-preview';
  const result = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO, dryRun: true, candidateId: dryRunCandidateId,
  });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));

  assert.equal(store.readEvents().length, eventsBefore, 'no event growth under dry-run');
  assert.equal(store.listCandidates().length, candidatesBefore, 'no candidate write under dry-run');
  assert.equal(store.readCandidate(staleId).review_status, 'reviewable', 'stale candidate NOT auto-rejected under dry-run');

  const outDir = path.join(store.dir, 'refresh', dryRunCandidateId);
  assert.ok(fs.existsSync(path.join(outDir, 'selected-bundle', 'bundle.jsonl')));
  assert.ok(fs.existsSync(path.join(outDir, 'selected-bundle', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'selection-report.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'candidate-config.json')));

  // A real (non-dry-run) refresh afterwards DOES sweep -- the stale
  // candidate is timeout-rejected as part of it.
  const realResult = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: '2026-06-16T00:00:00.000Z', candidateId: 'cand-real-after-dryrun',
  });
  assert.equal(realResult.exitCode, 0, realResult.lines.join('\n'));
  assert.equal(store.readCandidate(staleId).outcome, 'timeout_rejected');
});

// ── alpha default / divergence ──────────────────────────────────────

test('refresh: alpha default inherits active total (gate passes); explicit divergent --alpha fails alpha_total_unchanged', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-alpha');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());

  const emitter = new InMemoryLifecycleEventEmitter();
  const inherited = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId: 'cand-alpha-default',
  });
  assert.equal(inherited.exitCode, 0, inherited.lines.join('\n'));
  assert.equal(store.readCandidate('cand-alpha-default').review_status, 'pending_shadow');

  const diverged = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId: 'cand-alpha-diverge', alpha: 5e-3,
  });
  assert.equal(diverged.exitCode, 2);
  assert.ok(diverged.lines.some((l) => l.includes('alpha_total_unchanged: FAIL')));
  assert.equal(store.readCandidate('cand-alpha-diverge').status, 'rejected');
});

// ── non-timestamped bundle + full-bundle mode ───────────────────────

function makeNonTimestampedBundle(): BaselineBundle {
  const p99: number[] = [];
  const ttft: number[] = [];
  const hod: number[] = [];
  for (let t = 0; t < 240; t++) {
    p99.push(100 + (t % 60));
    ttft.push(0.5 + (t % 60) * 0.01);
    hod.push(t % 24);
  }
  return {
    version: 'fixture-nontimestamped-v1',
    generated_at: '2026-06-01T00:00:00.000Z',
    seed: 5,
    cell_dim: 'hour_of_day',
    runs: [{ tenant_id: 'aggregate', signal_series: { p99_latency: p99, ttft }, hour_of_day: hod }],
  };
}

test('refresh: non-timestamped bundle + --window -> clear error naming tick_seconds/start_iso + --full-bundle remedy', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-nots');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeNonTimestampedBundle());
  const emitter = new InMemoryLifecycleEventEmitter();
  await assert.rejects(
    runRefresh(store, emitter, { bundleDir, window: 'trailing-7d', now: NOW_ISO }),
    /tick_seconds/,
  );
  await assert.rejects(
    runRefresh(store, emitter, { bundleDir, window: 'trailing-7d', now: NOW_ISO }),
    /--full-bundle/,
  );
});

test('refresh: --full-bundle without a declared window on a non-timestamped bundle -> error', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-fb-nowindow');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeNonTimestampedBundle());
  const emitter = new InMemoryLifecycleEventEmitter();
  await assert.rejects(
    runRefresh(store, emitter, { bundleDir, fullBundle: true, now: NOW_ISO }),
    /--window-start/,
  );
});

test('refresh: --full-bundle + declared window overlapping an exclusion -> exit 2 (backstop)', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-fb-excl');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeNonTimestampedBundle());
  writeExclusions(store, [{ start: '2026-05-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', reason: 'wide' }]);

  const emitter = new InMemoryLifecycleEventEmitter();
  const candidateId = 'cand-fb-excl';
  const result = await runRefresh(store, emitter, {
    bundleDir, fullBundle: true, windowStart: '2026-06-01T00:00:00.000Z', windowEnd: '2026-06-10T00:00:00.000Z',
    now: NOW_ISO, candidateId,
  });
  assert.equal(result.exitCode, 2);
  const rec = store.readCandidate(candidateId);
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.review_status, 'decided');
});

test('refresh: --full-bundle + declared window NOT overlapping an exclusion -> success, exclusions_applied_at_selection:false surfaced', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-fb-ok');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeNonTimestampedBundle());
  writeExclusions(store, [{ start: '2099-01-01T00:00:00.000Z', end: '2099-01-02T00:00:00.000Z', reason: 'future-no-overlap' }]);

  const emitter = new InMemoryLifecycleEventEmitter();
  const candidateId = 'cand-fb-ok';
  const result = await runRefresh(store, emitter, {
    bundleDir, fullBundle: true, windowStart: '2026-06-01T00:00:00.000Z', windowEnd: '2026-06-10T00:00:00.000Z',
    now: NOW_ISO, candidateId,
  });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  const outDir = path.join(store.dir, 'refresh', candidateId);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'selection-report.json'), 'utf8'));
  assert.equal(report.exclusions_applied_at_selection, false);
  assert.equal(report.window_mode, 'full_bundle');
});

// ── creation-reason / candidate-id collision / argv ─────────────────

test('refresh: --creation-reason calendar_safety_net lands on the record', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-reason');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());
  const emitter = new InMemoryLifecycleEventEmitter();
  const candidateId = 'cand-calendar';
  const result = await runRefresh(store, emitter, {
    bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId, creationReason: 'calendar_safety_net',
  });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.equal(store.readCandidate(candidateId).creation_reason, 'calendar_safety_net');
});

test('refresh: --creation-reason drift_detected is explicitly rejected by the CLI dispatch', async () => {
  const root = tmpRoot();
  RecalibrationStore.init(root, 'svc-drift');
  await assert.rejects(
    main([
      'refresh', '--service', 'svc-drift', '--root', root,
      '--bundle-dir', 'unused', '--window', 'trailing-14d', '--creation-reason', 'drift_detected',
    ]),
    /does not perform drift detection/,
  );
});

test('refresh: candidate-id collision is an error', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-collide');
  seedActiveConfig(root, store);
  const bundleDir = writeSourceBundleDir(path.join(root, 'source-bundle'), makeTimestampedBundle());
  const emitter = new InMemoryLifecycleEventEmitter();
  const candidateId = 'cand-dup';
  const first = await runRefresh(store, emitter, { bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId });
  assert.equal(first.exitCode, 0, first.lines.join('\n'));
  await assert.rejects(
    runRefresh(store, emitter, { bundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId }),
    /already exists/,
  );
});

test('refresh: unknown flag -> usage error (parseArgv, shared across subcommands)', () => {
  assert.throws(() => parseArgv(['refresh', '--nope', 'x']), /Unknown flag/);
});

test('parseArgv: refresh flags parse, --full-bundle is a bare boolean (no value consumed)', () => {
  const { subcommand, flags } = parseArgv([
    'refresh', '--service', 'svc-demo', '--bundle-dir', 'runs/x', '--window', 'trailing-14d', '--full-bundle',
  ]);
  assert.equal(subcommand, 'refresh');
  assert.equal(flags['bundle-dir'], 'runs/x');
  assert.equal(flags.window, 'trailing-14d');
  assert.equal(flags['full-bundle'], 'true');
});

// ── determinism ──────────────────────────────────────────────────────

test('refresh: determinism — two full refreshes with the same fixtures + --now produce byte-identical artifacts (compile_phases excluded)', async () => {
  const sharedBundleDir = writeSourceBundleDir(
    path.join(tmpRoot(), 'shared-source-bundle'), makeTimestampedBundle(),
  );
  const candidateId = 'refresh-determinism-1';

  async function runOnce(): Promise<{ storeDir: string; outDir: string }> {
    const root = tmpRoot();
    const store = RecalibrationStore.init(root, 'svc-det');
    seedActiveConfig(root, store);
    const emitter = new InMemoryLifecycleEventEmitter();
    const result = await runRefresh(store, emitter, {
      bundleDir: sharedBundleDir, window: 'trailing-14d', now: NOW_ISO, candidateId,
    });
    assert.equal(result.exitCode, 0, result.lines.join('\n'));
    return { storeDir: store.dir, outDir: path.join(store.dir, 'refresh', candidateId) };
  }

  const run1 = await runOnce();
  const run2 = await runOnce();

  const bundle1 = fs.readFileSync(path.join(run1.outDir, 'selected-bundle', 'bundle.jsonl'), 'utf8');
  const bundle2 = fs.readFileSync(path.join(run2.outDir, 'selected-bundle', 'bundle.jsonl'), 'utf8');
  assert.equal(bundle1, bundle2);

  const report1 = fs.readFileSync(path.join(run1.outDir, 'selection-report.json'), 'utf8');
  const report2 = fs.readFileSync(path.join(run2.outDir, 'selection-report.json'), 'utf8');
  assert.equal(report1, report2);

  // candidate-config.json: byte-identical except compile_phases (real
  // elapsed timing, expected to vary -- same convention as
  // test/compile-parity-pre-post-slice2.test.ts).
  const cfg1 = JSON.parse(fs.readFileSync(path.join(run1.outDir, 'candidate-config.json'), 'utf8'));
  const cfg2 = JSON.parse(fs.readFileSync(path.join(run2.outDir, 'candidate-config.json'), 'utf8'));
  delete cfg1.compile_phases;
  delete cfg2.compile_phases;
  assert.deepEqual(cfg1, cfg2);

  // compiled_config_path legitimately differs -- it embeds each run's own
  // (distinct) mkdtemp root, not a source of nondeterminism in the
  // refresh computation itself. Every other field must match exactly.
  const rec1 = JSON.parse(fs.readFileSync(path.join(run1.storeDir, 'candidates', `${candidateId}.json`), 'utf8'));
  const rec2 = JSON.parse(fs.readFileSync(path.join(run2.storeDir, 'candidates', `${candidateId}.json`), 'utf8'));
  delete rec1.compiled_config_path;
  delete rec2.compiled_config_path;
  assert.deepEqual(rec1, rec2);
});

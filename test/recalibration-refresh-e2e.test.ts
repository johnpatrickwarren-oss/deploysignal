// test/recalibration-refresh-e2e.test.ts — R2 Task 9. Full lifecycle:
// init -> compile a real active config -> refresh (window + one
// exclusion) -> shadow (--dry-run orchestrator mode) -> approve ->
// rollback. All steps --now-pinned; imports handlers directly (no
// child_process).
//
// Classification is engineered to land on 'mixed' (bootstrap p99/ttft
// constants clearly worse on one signal, better on the other than the
// refresh source's constants) so shadow validation reaches 'reviewable'
// rather than auto-promoting -- letting this test actually exercise
// runApprove.
//
// The bootstrap active version and the refreshed candidate's version
// are DELIBERATELY compiled from the same `--families A` selection (so
// they'd derive the identical enum string 'v2-with-family-a' without
// Task 3's --version_suffix) — promotion_history ends up with two
// distinct version_id entries only because runRefresh always threads
// `--version_suffix refresh-<candidateId>` through. Without that fix,
// rollback's `promotion_history.find(version_id === ...)` lookup would
// be ambiguous; this test exercises that directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runInit, runShadow, runApprove, runRollback,
} from '../tools/recalibrate/_recalibrate-cli';
import { runRefresh } from '../tools/recalibrate/_recalibrate-refresh';
import { RecalibrationStore } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import { RECALIBRATION_REASON_CODES } from '../engine/types/recalibration';
import { main as calibrateMain } from '../tools/calibrate/_calibrate-main';
import type { CompiledConfig } from '../engine/types';
import type { BaselineBundle } from '../engine/types';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-refresh-e2e-test-'));
}

function writeBundleDir(dir: string, bundle: BaselineBundle): string {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    version: bundle.version, generated_at: bundle.generated_at, seed: bundle.seed,
  };
  if (bundle.cell_dim !== undefined) manifest.cell_dim = bundle.cell_dim;
  if (bundle.tick_seconds !== undefined) manifest.tick_seconds = bundle.tick_seconds;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'bundle.jsonl'), bundle.runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

/** Constant-valued run (no time variation) -- the compiled aggregate
 *  mean is exactly `p99`/`ttft` regardless of which ticks a window
 *  selection keeps or drops, isolating the classification outcome from
 *  exclusion-driven mean shift. */
function makeConstantRun(
  startIso: string | undefined, nTicks: number, p99: number, ttft: number,
): BaselineBundle['runs'][number] {
  const run: BaselineBundle['runs'][number] = {
    tenant_id: 'aggregate',
    hour_of_day: Array.from({ length: nTicks }, (_, t) => t % 24),
    signal_series: {
      p99_latency: new Array(nTicks).fill(p99),
      ttft: new Array(nTicks).fill(ttft),
    },
  };
  if (startIso !== undefined) run.start_iso = startIso;
  return run;
}

const BOOTSTRAP_P99 = 100;
const BOOTSTRAP_TTFT = 0.5;
// Refresh source: p99 clearly worse (higher -> degraded), ttft clearly
// better (lower -> improved) than bootstrap -> guaranteed 'mixed'.
const REFRESH_P99 = 140;
const REFRESH_TTFT = 0.2;

function makeBootstrapBundle(): BaselineBundle {
  return {
    version: 'fixture-bootstrap-v1',
    generated_at: '2026-05-01T00:00:00.000Z',
    seed: 1,
    cell_dim: 'hour_of_day',
    runs: [makeConstantRun(undefined, 24, BOOTSTRAP_P99, BOOTSTRAP_TTFT)],
  };
}

const REFRESH_RUN_STARTS = [
  '2026-06-01T00:00:00.000Z',
  '2026-06-04T00:00:00.000Z',
  '2026-06-07T00:00:00.000Z',
  '2026-06-10T00:00:00.000Z',
];

function makeRefreshSourceBundle(): BaselineBundle {
  return {
    version: 'fixture-refresh-source-e2e-v1',
    generated_at: '2026-06-01T00:00:00.000Z',
    seed: 2,
    cell_dim: 'hour_of_day',
    tick_seconds: 3600,
    runs: REFRESH_RUN_STARTS.map((startIso) => makeConstantRun(startIso, 60, REFRESH_P99, REFRESH_TTFT)),
  };
}

function readConfig(p: string): CompiledConfig {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CompiledConfig;
}

test('refresh e2e: init -> compile active -> refresh -> shadow(dry-run) -> approve -> rollback', async () => {
  const root = tmpRoot();
  const serviceId = 'svc-refresh-e2e';
  const emitter = new InMemoryLifecycleEventEmitter();

  // ── init ──────────────────────────────────────────────────────────
  const initResult = runInit({ root, serviceId });
  assert.equal(initResult.exitCode, 0);
  const store = new RecalibrationStore(path.join(root, serviceId));

  // ── compile + bootstrap the active baseline ─────────────────────
  const bootstrapDir = writeBundleDir(path.join(root, 'bootstrap-bundle'), makeBootstrapBundle());
  const activeConfigPath = path.join(root, 'active-config.json');
  await calibrateMain(['--baseline', bootstrapDir, '--alpha', '1e-3', '--families', 'A', '--out', activeConfigPath]);
  const bootstrapConfig = readConfig(activeConfigPath);

  const bootstrapNow = '2026-05-15T00:00:00.000Z';
  const bootstrapCandidateId = 'cand-bootstrap';
  store.writeCandidate({
    schema_version: '1',
    service_id: serviceId,
    candidate_id: bootstrapCandidateId,
    proposed_baseline_version: bootstrapConfig.version,
    current_baseline_version: bootstrapConfig.version,
    direction_classification: 'improvement',
    per_signal_direction: {},
    suggested_reason_codes: [],
    shadow_mode_validated_at: bootstrapNow,
    timeout_at: bootstrapNow,
    status: 'active',
    review_status: 'decided',
    creation_reason: 'operator_manual',
    created_at: bootstrapNow,
    source_window: {
      start: bootstrapNow, end: bootstrapNow, n_samples: 24, excluded_windows_applied: 0,
    },
    compiled_config_path: activeConfigPath,
    outcome: 'auto_promoted',
    history: [],
  });
  store.promote(bootstrapCandidateId, 'auto_promoted', bootstrapNow);
  assert.equal(store.readActive()!.version_id, bootstrapConfig.version);
  assert.equal(store.readActive()!.promotion_history.length, 1);

  // ── refresh (window + one exclusion) ────────────────────────────
  const refreshSourceDir = writeBundleDir(path.join(root, 'refresh-source-bundle'), makeRefreshSourceBundle());
  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify({
    schema_version: '1',
    windows: [{ start: '2026-06-04T10:00:00.000Z', end: '2026-06-04T20:00:00.000Z', reason: 'incident' }],
  }));

  const refreshNow = '2026-06-15T00:00:00.000Z';
  const candidateId = 'refresh-e2e-1';
  const refreshResult = await runRefresh(store, emitter, {
    bundleDir: refreshSourceDir, window: 'trailing-14d', now: refreshNow, candidateId,
  });
  assert.equal(refreshResult.exitCode, 0, refreshResult.lines.join('\n'));

  const proposed = store.readCandidate(candidateId);
  assert.equal(proposed.review_status, 'pending_shadow');
  assert.equal(proposed.direction_classification, 'mixed');
  assert.equal(proposed.per_signal_direction.p99_latency, 'degraded');
  assert.equal(proposed.per_signal_direction.ttft, 'improved');
  assert.equal(proposed.source_window.n_samples, 230); // 240 - 10 excluded
  assert.notEqual(proposed.proposed_baseline_version, bootstrapConfig.version);

  // ── shadow (--dry-run orchestrator mode: stub gates trivially pass) ─
  const shadowNow = '2026-06-16T00:00:00.000Z';
  const shadowResult = await runShadow(store, emitter, {
    candidateId,
    scenarios: ['anthropic_tpu_output_corruption_step_2025_09'],
    seeds: [42],
    outputDir: path.join(store.dir, 'shadow-out'),
    dryRun: true,
    now: shadowNow,
  });
  assert.equal(shadowResult.exitCode, 0, shadowResult.lines.join('\n'));
  const shadowed = store.readCandidate(candidateId);
  assert.equal(shadowed.review_status, 'reviewable', 'mixed classification must not auto-promote');
  assert.equal(shadowed.status, 'candidate');

  // ── approve ──────────────────────────────────────────────────────
  const approveNow = '2026-06-17T00:00:00.000Z';
  const approveResult = await runApprove(store, emitter, {
    candidateId, reviewer: 'op-1', reasonCode: RECALIBRATION_REASON_CODES[0], now: approveNow,
  });
  assert.equal(approveResult.exitCode, 0, approveResult.lines.join('\n'));

  const activeAfterApprove = store.readActive()!;
  assert.equal(activeAfterApprove.compiled_config_path, proposed.compiled_config_path);
  assert.equal(activeAfterApprove.version_id, proposed.proposed_baseline_version);
  assert.ok(activeAfterApprove.version_id.endsWith(`+refresh-${candidateId}`));
  assert.equal(activeAfterApprove.promotion_history.length, 2);
  assert.deepEqual(
    activeAfterApprove.promotion_history.map((e) => e.version_id),
    [bootstrapConfig.version, activeAfterApprove.version_id],
  );
  assert.notEqual(activeAfterApprove.promotion_history[0].version_id, activeAfterApprove.promotion_history[1].version_id);

  // ── rollback to the original (pre-refresh) version ──────────────
  const rollbackNow = '2026-06-18T00:00:00.000Z';
  const rollbackResult = await runRollback(store, emitter, {
    versionId: bootstrapConfig.version, reviewer: 'op-1', reasonCode: 'regression', now: rollbackNow,
  });
  assert.equal(rollbackResult.exitCode, 0, rollbackResult.lines.join('\n'));

  const activeAfterRollback = store.readActive()!;
  assert.equal(activeAfterRollback.version_id, bootstrapConfig.version);
  assert.equal(activeAfterRollback.compiled_config_path, activeConfigPath);
  assert.equal(activeAfterRollback.predecessor_version_id, activeAfterApprove.version_id);
});

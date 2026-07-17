// test/recalibration-shadow.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 9.
//
// Exercises tools/recalibrate/_recalibrate-shadow.ts's `runCandidateShadow`:
// wraps the EXISTING tools/run-shadow-compare.ts orchestrator with
// active + candidate SubstrateRefs. 'reviewable' is reachable ONLY via
// this path (plan §C Task 9 / Task 2's state machine: pending_shadow
// -(shadow_validated)-> reviewable). All dry-run, per the q60 test
// pattern (test/q60-run-shadow-compare.test.ts) — dry-run stub-emits
// zero firing counts for every substrate, so the real orchestrator's
// acceptance gates trivially pass; the "failed gate" case below injects
// a fake shadowCompareFn instead of trying to coax a genuine ΔFPR
// breach out of the stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runCandidateShadow } from '../tools/recalibrate/_recalibrate-shadow';
import { RecalibrationStore, type ActivePointer } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import type { CompiledConfig } from '../engine/types';
import type { CandidateRecord } from '../engine/types/recalibration';
import type { ShadowCompareReport } from '../tools/run-shadow-compare';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-shadow-test-'));
}

function makeConfig(overrides: Partial<CompiledConfig> = {}): CompiledConfig {
  return {
    version: 'v-unset@seed=42',
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=42',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['p99_latency', 'mfu'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 200, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 20,
            },
            mfu: {
              baseline_mean: 0.70, baseline_sigma_squared: 0.01, tau_squared: 0.0025, delta_min: 0.05,
            },
          },
        },
        family_C: { mean_vector: [200, 0.70], covariance: [[100, 0], [0, 0.01]] },
      },
    },
    ...overrides,
  } as CompiledConfig;
}

function writeConfig(dir: string, name: string, cfg: CompiledConfig): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

function seedActive(store: RecalibrationStore, pointer: ActivePointer): void {
  fs.writeFileSync(path.join(store.dir, 'active.json'), JSON.stringify(pointer));
}

function pendingShadowCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-demo',
    candidate_id: 'cand-shadow-000',
    proposed_baseline_version: 'v7@seed=43',
    current_baseline_version: 'v6@seed=42',
    direction_classification: 'degradation',
    per_signal_direction: { mfu: 'degraded' },
    suggested_reason_codes: ['other_legitimate'],
    shadow_mode_validated_at: null,
    timeout_at: '2026-08-01T00:00:00.000Z',
    status: 'candidate',
    review_status: 'pending_shadow',
    creation_reason: 'drift_detected',
    created_at: '2026-07-01T00:00:00.000Z',
    source_window: {
      start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80, excluded_windows_applied: 0,
    },
    compiled_config_path: 'runs/compiled-configs/v7-candidate.json',
    outcome: null,
    history: [{ at: '2026-07-01T00:00:00.000Z', actor: 'system', action: 'created' }],
    ...overrides,
  };
}

interface Fixture {
  root: string;
  store: RecalibrationStore;
  activePath: string;
  candidatePath: string;
}

function setupFixture(): Fixture {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const activePath = writeConfig(root, 'active-config.json', makeConfig({ version: 'v6@seed=42' }));
  seedActive(store, {
    schema_version: '1',
    version_id: 'v6@seed=42',
    candidate_id: null,
    compiled_config_path: activePath,
    baseline_ref: 'v6@seed=42',
    promoted_at: '2026-06-01T00:00:00.000Z',
    predecessor_version_id: null,
    promotion_history: [],
  });
  const candidatePath = writeConfig(root, 'candidate-config.json', makeConfig({ version: 'v7@seed=43' }));
  return { root, store, activePath, candidatePath };
}

const SCENARIOS = ['anthropic_tpu_output_corruption_step_2025_09'];
const SEEDS = [42];

// ── dry-run: marks reviewable + stores diff path ────────────────────

test('runCandidateShadow (dry-run, degradation): marks reviewable + stores diff path', async () => {
  const { store, candidatePath } = setupFixture();
  const outputDir = path.join(store.dir, 'shadow-out');
  const candidate = pendingShadowCandidate({ compiled_config_path: candidatePath, direction_classification: 'degradation' });
  store.writeCandidate(candidate);

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCandidateShadow(store, emitter, candidate, {
    scenarios: SCENARIOS,
    seeds: SEEDS,
    outputDir,
    dryRun: true,
    nowIso: '2026-07-02T00:00:00.000Z',
  });

  assert.equal(result.gatesPassed, true);
  assert.equal(result.autoPromoted, false);
  assert.equal(result.record.review_status, 'reviewable');
  assert.equal(result.record.status, 'candidate');
  assert.equal(result.record.shadow_mode_validated_at, '2026-07-02T00:00:00.000Z');
  assert.ok(fs.existsSync(result.shadowReportPath), 'shadow report file must be written');
  const stored = store.readCandidate(candidate.candidate_id);
  assert.equal(stored.shadow_report_path, result.shadowReportPath);

  const reportOnDisk = JSON.parse(fs.readFileSync(result.shadowReportPath, 'utf8')) as ShadowCompareReport;
  assert.ok(reportOnDisk.cross_substrate_diff_path, 'stored report must carry cross_substrate_diff_path');
  assert.ok(fs.existsSync(reportOnDisk.cross_substrate_diff_path), 'cross-substrate diff file must exist on disk');

  const events = emitter.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.shadow_validated');

  // Pointer untouched — degradation never auto-promotes.
  assert.equal(store.readActive()!.version_id, 'v6@seed=42');
});

// ── improvement auto-promotes + updates pointer ──────────────────────

test('runCandidateShadow (dry-run, improvement): auto-promotes + updates active pointer', async () => {
  const { store, candidatePath } = setupFixture();
  const outputDir = path.join(store.dir, 'shadow-out');
  const candidate = pendingShadowCandidate({
    candidate_id: 'cand-shadow-improve',
    compiled_config_path: candidatePath,
    direction_classification: 'improvement',
    proposed_baseline_version: 'v7@seed=43',
    suggested_reason_codes: [],
  });
  store.writeCandidate(candidate);

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCandidateShadow(store, emitter, candidate, {
    scenarios: SCENARIOS,
    seeds: SEEDS,
    outputDir,
    dryRun: true,
    nowIso: '2026-07-02T00:00:00.000Z',
  });

  assert.equal(result.gatesPassed, true);
  assert.equal(result.autoPromoted, true);
  assert.equal(result.record.status, 'active');
  assert.equal(result.record.review_status, 'decided');
  assert.equal(result.record.outcome, 'auto_promoted');

  const active = store.readActive()!;
  assert.equal(active.version_id, 'v7@seed=43');
  assert.equal(active.candidate_id, 'cand-shadow-improve');
  assert.equal(active.predecessor_version_id, 'v6@seed=42');
  assert.equal(active.promotion_history.length, 1);
  assert.equal(active.promotion_history[0].outcome, 'auto_promoted');

  // No operator identity anywhere in the promotion trail.
  assert.equal(active.promotion_history[0].actor, undefined);

  const types = emitter.getEvents().map((e) => e.type);
  assert.deepEqual(types, ['recalibration.shadow_validated', 'recalibration.auto_promoted']);
});

// ── degradation stays reviewable, pointer untouched ──────────────────

test('runCandidateShadow (dry-run, degradation): stays reviewable, active pointer untouched', async () => {
  const { store, candidatePath } = setupFixture();
  const outputDir = path.join(store.dir, 'shadow-out');
  const beforeActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');
  const candidate = pendingShadowCandidate({ compiled_config_path: candidatePath, direction_classification: 'degradation' });
  store.writeCandidate(candidate);

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCandidateShadow(store, emitter, candidate, {
    scenarios: SCENARIOS,
    seeds: SEEDS,
    outputDir,
    dryRun: true,
    nowIso: '2026-07-02T00:00:00.000Z',
  });

  assert.equal(result.autoPromoted, false);
  assert.equal(result.record.review_status, 'reviewable');
  const afterActiveBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');
  assert.equal(afterActiveBytes, beforeActiveBytes, 'active.json must be byte-identical when a candidate stays reviewable');
});

// ── failed gate -> shadow_mode_failed ─────────────────────────────────

test('runCandidateShadow: failed acceptance gate -> shadow_mode_failed, pointer untouched', async () => {
  const { store, candidatePath } = setupFixture();
  const outputDir = path.join(store.dir, 'shadow-out');
  const candidate = pendingShadowCandidate({
    candidate_id: 'cand-shadow-fail', compiled_config_path: candidatePath, direction_classification: 'improvement',
  });
  store.writeCandidate(candidate);

  const fakeReport: ShadowCompareReport = {
    per_profile_report_cards: {},
    cross_substrate_diff_path: path.join(outputDir, 'fake-cross-substrate.json'),
    acceptance_gates: { cross_substrate_delta_fpr_within_bound: false, cross_substrate_delta_tpr_within_bound: true },
    pitch_summary_path: path.join(outputDir, 'fake-pitch-summary.json'),
  };

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCandidateShadow(store, emitter, candidate, {
    scenarios: SCENARIOS,
    seeds: SEEDS,
    outputDir,
    dryRun: true,
    nowIso: '2026-07-02T00:00:00.000Z',
    shadowCompareFn: () => fakeReport,
  });

  assert.equal(result.gatesPassed, false);
  assert.equal(result.autoPromoted, false);
  assert.equal(result.record.status, 'rejected');
  assert.equal(result.record.review_status, 'decided');
  assert.equal(result.record.outcome, 'shadow_mode_failed');

  // No typed lifecycle event for shadow_failed (Task 5 locked the union
  // at six members) — but the store's events.jsonl still carries an
  // untyped audit trace, mirroring rollback's 'recalibration.rolled_back'
  // pattern (_recalibrate-store.ts header note).
  assert.equal(emitter.getEvents().length, 0);
  const storedEvents = store.readEvents();
  assert.equal(storedEvents.length, 1);
  assert.equal(storedEvents[0].type, 'recalibration.shadow_failed');

  // Pointer untouched.
  assert.equal(store.readActive()!.version_id, 'v6@seed=42');
});

// ── error: no active baseline ─────────────────────────────────────────

test('runCandidateShadow: throws when service has no active baseline yet', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-empty');
  const candidatePath = writeConfig(root, 'candidate.json', makeConfig({ version: 'v1@seed=1' }));
  const candidate = pendingShadowCandidate({ service_id: 'svc-empty', compiled_config_path: candidatePath });
  store.writeCandidate(candidate);

  const emitter = new InMemoryLifecycleEventEmitter();
  await assert.rejects(() => runCandidateShadow(store, emitter, candidate, {
    scenarios: SCENARIOS,
    seeds: SEEDS,
    outputDir: path.join(root, 'shadow-out'),
    dryRun: true,
    nowIso: '2026-07-02T00:00:00.000Z',
  }), /no active baseline/);
});

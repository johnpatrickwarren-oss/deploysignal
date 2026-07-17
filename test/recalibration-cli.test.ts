// test/recalibration-cli.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 8.
//
// Exercises tools/recalibrate/_recalibrate-cli.ts's handlers directly
// (no child_process, per plan §C Task 8 test note / q60 pattern) against
// fixture RecalibrationStores + CompiledConfig JSON files under
// fs.mkdtempSync roots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runInit, runPropose, runList, runApprove, runReject, runCheck, runRollback, parseArgv,
} from '../tools/recalibrate/_recalibrate-cli';
import { RecalibrationStore, type ActivePointer } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import { RECALIBRATION_REASON_CODES } from '../engine/types/recalibration';
import type { CompiledConfig } from '../engine/types';
import type { CandidateRecord } from '../engine/types/recalibration';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-cli-test-'));
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

const VALID_REASON = RECALIBRATION_REASON_CODES[0];

// ── propose ───────────────────────────────────────────────────────────

test('propose: happy path -> pending_shadow with classification/comparison/timeout_at populated + event', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const activePath = writeConfig(root, 'active.json', makeConfig({ version: 'v6@seed=42' }));
  seedActive(store, {
    schema_version: '1', version_id: 'v6@seed=42', candidate_id: null, compiled_config_path: activePath,
    baseline_ref: 'v6@seed=42', promoted_at: '2026-06-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });
  // Candidate: p99_latency down (lower is better -> improved), mfu up
  // (higher is better -> improved) -> overall improvement.
  const candidatePath = writeConfig(root, 'candidate.json', makeConfig({
    version: 'v7@seed=43',
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 150, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 20,
            },
            mfu: {
              baseline_mean: 0.85, baseline_sigma_squared: 0.01, tau_squared: 0.0025, delta_min: 0.05,
            },
          },
        },
        family_C: { mean_vector: [150, 0.85], covariance: [[100, 0], [0, 0.01]] },
      },
    },
  }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runPropose(store, emitter, {
    candidateId: 'cand-001',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80 },
    now: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(result.exitCode, 0);
  const rec = store.readCandidate('cand-001');
  assert.equal(rec.review_status, 'pending_shadow');
  assert.equal(rec.status, 'candidate');
  assert.equal(rec.direction_classification, 'improvement');
  assert.equal(rec.per_signal_direction.p99_latency, 'improved');
  assert.equal(rec.per_signal_direction.mfu, 'improved');
  assert.equal(rec.timeout_at, '2026-07-15T00:00:00.000Z'); // +14 default days
  assert.ok(rec.comparison, 'comparison must be populated');
  assert.equal((rec.comparison as { extraction_basis: string }).extraction_basis, 'aggregate_fallback_only');
  assert.equal(rec.current_baseline_version, 'v6@seed=42');
  assert.equal(rec.proposed_baseline_version, 'v7@seed=43');

  const events = emitter.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.proposed');
});

test('propose: readiness fail on exclusion overlap -> exit 2, decided/rejected, no outcome', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const activePath = writeConfig(root, 'active.json', makeConfig({ version: 'v6@seed=42' }));
  seedActive(store, {
    schema_version: '1', version_id: 'v6@seed=42', candidate_id: null, compiled_config_path: activePath,
    baseline_ref: 'v6@seed=42', promoted_at: '2026-06-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });
  const candidatePath = writeConfig(root, 'candidate.json', makeConfig({ version: 'v7@seed=43' }));

  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify({
    schema_version: '1',
    windows: [{ start: '2026-06-25T00:00:00.000Z', end: '2026-06-27T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }],
  }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runPropose(store, emitter, {
    candidateId: 'cand-002',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80 },
    now: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(result.exitCode, 2);
  assert.ok(result.lines.some((l) => l.includes('source_window_outside_exclusions: FAIL')));

  const rec = store.readCandidate('cand-002');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.review_status, 'decided');
  assert.equal(rec.outcome, null); // readiness_failed sets no RecalibrationOutcome
  assert.equal(emitter.getEvents().length, 0, 'no proposed event on readiness failure');
});

// ── approve ───────────────────────────────────────────────────────────

test('approve: non-reviewable candidate errors', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(pendingShadowCandidate({ candidate_id: 'cand-003' }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runApprove(store, emitter, {
    candidateId: 'cand-003', reviewer: 'op-1', reasonCode: VALID_REASON, now: '2026-07-02T00:00:00.000Z',
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines[0].includes('not reviewable'));
});

test('approve: past timeout -> sweep rejects first, approve fails (load-bearing lazy-enforcement)', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(reviewableCandidate({ timeout_at: '2026-07-10T00:00:00.000Z' }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runApprove(store, emitter, {
    candidateId: 'cand-004', reviewer: 'op-1', reasonCode: VALID_REASON, now: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(result.exitCode, 1);

  const rec = store.readCandidate('cand-004');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.outcome, 'timeout_rejected');

  // The sweep's own timeout_rejected event landed; approve did NOT also
  // emit an operator_approved event.
  const types = emitter.getEvents().map((e) => e.type);
  assert.deepEqual(types, ['recalibration.timeout_rejected']);
});

// ── reject ────────────────────────────────────────────────────────────

test('reject: leaves active.json byte-identical', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const bootstrapPath = writeConfig(root, 'bootstrap.json', makeConfig({ version: 'v5@seed=41' }));
  const bootstrapPointer: ActivePointer = {
    schema_version: '1', version_id: 'v5@seed=41', candidate_id: null, compiled_config_path: bootstrapPath,
    baseline_ref: 'v5@seed=41', promoted_at: '2026-05-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  };
  seedActive(store, bootstrapPointer);
  const beforeBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');

  store.writeCandidate(reviewableCandidate({ candidate_id: 'cand-005', timeout_at: '2026-08-01T00:00:00.000Z' }));

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runReject(store, emitter, {
    candidateId: 'cand-005', reviewer: 'op-1', reasonCode: VALID_REASON, now: '2026-07-02T00:00:00.000Z',
  });
  assert.equal(result.exitCode, 0);

  const rec = store.readCandidate('cand-005');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.outcome, 'operator_rejected');

  const afterBytes = fs.readFileSync(path.join(store.dir, 'active.json'), 'utf8');
  assert.equal(afterBytes, beforeBytes, 'active.json must be byte-identical after a reject');

  const events = emitter.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.operator_rejected');
});

// ── check ─────────────────────────────────────────────────────────────

test('check: month rollover with no open candidate -> exit 3 (due)', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate({
    ...pendingShadowCandidate(), review_status: 'decided', status: 'active', outcome: 'auto_promoted', created_at: '2026-07-01T00:00:00.000Z',
  });
  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCheck(store, emitter, '2026-08-05T00:00:00.000Z');
  assert.equal(result.exitCode, 3);
  assert.ok(result.lines.some((l) => l.includes('DUE')));
});

test('check: an open candidate -> exit 0 (not due), even past a month rollover', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(pendingShadowCandidate({ created_at: '2026-07-01T00:00:00.000Z' }));
  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runCheck(store, emitter, '2026-08-05T00:00:00.000Z');
  assert.equal(result.exitCode, 0);
  assert.ok(result.lines.some((l) => l.includes('not due')));
});

// ── rollback ─────────────────────────────────────────────────────────

test('rollback: restores predecessor version', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');

  store.writeCandidate({
    ...pendingShadowCandidate({ candidate_id: 'cand-A', proposed_baseline_version: 'v6@seed=42' }),
    status: 'active', review_status: 'decided', outcome: 'auto_promoted',
  });
  store.promote('cand-A', 'auto_promoted', '2026-07-02T00:00:00.000Z');

  store.writeCandidate({
    ...pendingShadowCandidate({ candidate_id: 'cand-B', proposed_baseline_version: 'v7@seed=43' }),
    status: 'active', review_status: 'decided', outcome: 'operator_approved',
  });
  store.promote('cand-B', 'operator_approved', '2026-07-10T00:00:00.000Z');

  const emitter = new InMemoryLifecycleEventEmitter();
  const result = await runRollback(store, emitter, {
    versionId: 'v6@seed=42', reviewer: 'op-1', reasonCode: 'regression', now: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(store.readActive()!.version_id, 'v6@seed=42');
  assert.equal(store.readActive()!.predecessor_version_id, 'v7@seed=43');
});

// ── init smoke test ──────────────────────────────────────────────────

test('init: creates a usable store', () => {
  const root = tmpRoot();
  const result = runInit({ root, serviceId: 'svc-demo' });
  assert.equal(result.exitCode, 0);
  const store = new RecalibrationStore(path.join(root, 'svc-demo'));
  assert.equal(store.readMeta().service_id, 'svc-demo');
});

// ── argv parsing ─────────────────────────────────────────────────────

test('parseArgv: unknown flag -> usage error', () => {
  assert.throws(() => parseArgv(['propose', '--nope', 'x']), /Unknown flag/);
});

test('parseArgv: no subcommand -> usage error', () => {
  assert.throws(() => parseArgv([]));
});

test('parseArgv: known flags parse into a flat map', () => {
  const { subcommand, flags } = parseArgv(['approve', '--service', 'svc-demo', '--candidate-id', 'cand-001']);
  assert.equal(subcommand, 'approve');
  assert.equal(flags.service, 'svc-demo');
  assert.equal(flags['candidate-id'], 'cand-001');
});

// ── fixtures ─────────────────────────────────────────────────────────

function pendingShadowCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-demo',
    candidate_id: 'cand-000',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=41',
    direction_classification: 'improvement',
    per_signal_direction: { mfu: 'improved' },
    suggested_reason_codes: [],
    shadow_mode_validated_at: null,
    timeout_at: '2026-08-01T00:00:00.000Z',
    status: 'candidate',
    review_status: 'pending_shadow',
    creation_reason: 'drift_detected',
    created_at: '2026-07-01T00:00:00.000Z',
    source_window: {
      start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80, excluded_windows_applied: 0,
    },
    compiled_config_path: 'runs/compiled-configs/v6-candidate.json',
    outcome: null,
    history: [],
    ...overrides,
  };
}

function reviewableCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return pendingShadowCandidate({
    candidate_id: 'cand-004',
    review_status: 'reviewable',
    shadow_mode_validated_at: '2026-07-05T00:00:00.000Z',
    shadow_report_path: 'runs/shadow/cand-004.json',
    ...overrides,
  });
}

// test/recalibrate-soak-cli.test.ts — R5 live shadow soak, Task 8.
//
// Exercises tools/recalibrate/_recalibrate-soak-cli.ts's handlers
// directly (no child_process, per plan §C Task 8 test note / q60
// pattern — same convention as test/recalibration-cli.test.ts) against
// fixture RecalibrationStores under fs.mkdtempSync roots. Sidecars are
// hand-written JSON (the "service side" of the soak file contract is
// exercised end-to-end separately in test/gate-soak-e2e.test.ts) —
// here we're testing the CLI's own start/status/stop semantics and its
// two hooks into _recalibrate-cli.ts (`main`'s early branch, `runShow`'s
// appended lines).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runSoakStart, runSoakStatus, runSoakStop, soakMain,
} from '../tools/recalibrate/_recalibrate-soak-cli';
import { readSoakManifest, soakSidecarPath } from '../tools/recalibrate/_recalibrate-soak';
import { RecalibrationStore } from '../tools/recalibrate/_recalibrate-store';
import { runShow, main } from '../tools/recalibrate/_recalibrate-cli';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import type { CandidateRecord, SoakSidecar } from '../engine/types/recalibration';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibrate-soak-cli-test-'));
}

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

// ── fixtures (mirrors test/recalibration-cli.test.ts's local pattern) ──

function pendingShadowCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-soak',
    candidate_id: 'cand-000',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=41',
    direction_classification: 'improvement',
    per_signal_direction: { mfu: 'improved' },
    suggested_reason_codes: [],
    shadow_mode_validated_at: null,
    timeout_at: '2026-09-01T00:00:00.000Z',
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

function decidedCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return pendingShadowCandidate({
    candidate_id: 'cand-decided',
    status: 'active',
    review_status: 'decided',
    outcome: 'operator_approved',
    ...overrides,
  });
}

function freshSidecar(candidateId: string, overrides: Partial<SoakSidecar> = {}): SoakSidecar {
  return {
    schema_version: '1',
    candidate_id: candidateId,
    window: { target_ticks: 10 },
    started_at: '2026-07-10T00:00:00.000Z',
    last_updated_at: '2026-07-10T00:05:00.000Z',
    status: 'accumulating',
    completed_at: null,
    stats: {
      ticks_observed: 4,
      disagreement: {
        total_compared: 4,
        verdict_disagreements: 2,
        by_pair: { 'extend->rollback': 2 },
        would_be_rollback: { active_only: 0, candidate_only: 2, both: 0 },
      },
      per_family: {
        A: { active_fires: 0, candidate_fires: 0 },
        B: { active_fires: 0, candidate_fires: 0 },
        C: { active_fires: 0, candidate_fires: 2 },
        D: { active_fires: 0, candidate_fires: 0 },
        E: { active_fires: 0, candidate_fires: 0 },
      },
      alpha_spent: { active_total: 0.0012, candidate_total: 0.0021 },
      coverage: {
        sessions_enrolled: 2,
        sessions_skipped_midstream: 0,
        first_tick_ts: 1_700_000_000,
        last_tick_ts: 1_700_000_120,
        active_errored_ticks: 0,
        candidate_errored_ticks: 0,
      },
    },
    voids: [],
    ...overrides,
  };
}

// ── start ────────────────────────────────────────────────────────────

test('soak start: happy path writes a requested manifest + soak_started event', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate());

  const result = runSoakStart(store, {
    candidateId: 'cand-000', requestedBy: 'op-1', targetTicks: 100, now: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(result.exitCode, 0);

  const manifest = readSoakManifest(store.dir);
  assert.ok(manifest);
  assert.equal(manifest!.candidate_id, 'cand-000');
  assert.equal(manifest!.status, 'requested');
  assert.equal(manifest!.requested_by, 'op-1');
  assert.equal(manifest!.window.target_ticks, 100);
  assert.equal(manifest!.requested_at, '2026-07-10T00:00:00.000Z');

  const events = store.readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.soak_started');
});

test('soak start: default target_ticks is 200 when --target-ticks is omitted', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate());
  runSoakStart(store, { candidateId: 'cand-000', requestedBy: 'op-1', now: '2026-07-10T00:00:00.000Z' });
  assert.equal(readSoakManifest(store.dir)!.window.target_ticks, 200);
});

test('soak start: a decided candidate is not eligible -> exit 1, no manifest written', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(decidedCandidate());

  const result = runSoakStart(store, { candidateId: 'cand-decided', requestedBy: 'op-1', now: '2026-07-10T00:00:00.000Z' });
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines[0].includes('not eligible'));
  assert.equal(readSoakManifest(store.dir), null);
});

test('soak start: an unknown candidate id throws (RecalibrationStore.readCandidate\'s own not-found error, same convention as every other handler)', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  assert.throws(() => runSoakStart(store, { candidateId: 'nope', requestedBy: 'op-1' }));
});

test('soak start: a second start for a DIFFERENT candidate while one is already requested -> exit 1, original manifest untouched', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate({ candidate_id: 'cand-A' }));
  store.writeCandidate(pendingShadowCandidate({ candidate_id: 'cand-B' }));

  const first = runSoakStart(store, { candidateId: 'cand-A', requestedBy: 'op-1', now: '2026-07-10T00:00:00.000Z' });
  assert.equal(first.exitCode, 0);

  const second = runSoakStart(store, { candidateId: 'cand-B', requestedBy: 'op-1', now: '2026-07-10T00:01:00.000Z' });
  assert.equal(second.exitCode, 1);
  assert.ok(second.lines[0].includes('already active'));

  assert.equal(readSoakManifest(store.dir)!.candidate_id, 'cand-A');
});

test('soak start: a second start for the SAME candidate is allowed (one-soak-per-service refuses only a DIFFERENT candidate)', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate({ candidate_id: 'cand-A' }));

  const first = runSoakStart(store, {
    candidateId: 'cand-A', requestedBy: 'op-1', targetTicks: 10, now: '2026-07-10T00:00:00.000Z',
  });
  assert.equal(first.exitCode, 0);
  const second = runSoakStart(store, {
    candidateId: 'cand-A', requestedBy: 'op-2', targetTicks: 20, now: '2026-07-10T00:05:00.000Z',
  });
  assert.equal(second.exitCode, 0);

  const manifest = readSoakManifest(store.dir);
  assert.equal(manifest!.window.target_ticks, 20, 'the manifest reflects the latest start request');
  assert.equal(manifest!.requested_by, 'op-2');
});

// ── status ───────────────────────────────────────────────────────────

test('soak status: no manifest -> informational line, exit 0', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const result = runSoakStatus(store);
  assert.equal(result.exitCode, 0);
  assert.ok(result.lines[0].includes('no soak manifest'));
});

test('soak status: manifest present, no sidecar yet -> informational line', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate());
  runSoakStart(store, { candidateId: 'cand-000', requestedBy: 'op-1', now: '2026-07-10T00:00:00.000Z' });

  const result = runSoakStatus(store);
  assert.equal(result.exitCode, 0);
  assert.ok(result.lines.some((l) => l.includes("candidate='cand-000'")));
  assert.ok(result.lines.some((l) => l.includes('no live sidecar yet')));
});

test('soak status: renders the live sidecar summary once one exists', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate());
  runSoakStart(store, {
    candidateId: 'cand-000', requestedBy: 'op-1', targetTicks: 10, now: '2026-07-10T00:00:00.000Z',
  });
  writeJson(soakSidecarPath(store.dir, 'cand-000'), freshSidecar('cand-000'));

  const result = runSoakStatus(store);
  assert.equal(result.exitCode, 0);
  const summaryLine = result.lines.find((l) => l.startsWith('SOAK (live):'));
  assert.ok(summaryLine);
  assert.ok(summaryLine!.includes('4/10 ticks'));
  assert.ok(summaryLine!.includes('sessions_enrolled=2'));
});

// ── stop ─────────────────────────────────────────────────────────────

test('soak stop: folds the live sidecar onto CandidateRecord.soak; history + review_status untouched (soak never gates)', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const before = reviewableCandidate();
  store.writeCandidate(before);
  runSoakStart(store, {
    candidateId: before.candidate_id, requestedBy: 'op-1', targetTicks: 10, now: '2026-07-10T00:00:00.000Z',
  });
  const sidecar = freshSidecar(before.candidate_id, { status: 'accumulating' });
  writeJson(soakSidecarPath(store.dir, before.candidate_id), sidecar);

  const result = runSoakStop(store, { candidateId: before.candidate_id, reviewer: 'op-2', now: '2026-07-11T00:00:00.000Z' });
  assert.equal(result.exitCode, 0);

  const after = store.readCandidate(before.candidate_id);
  assert.ok(after.soak);
  assert.deepEqual(after.soak!.sidecar, sidecar, 'the folded sidecar snapshot matches the live sidecar exactly');
  assert.equal(after.soak!.stopped_early, true, 'accumulating (not complete) at stop time -> stopped_early');
  assert.equal(after.soak!.folded_by, 'op-2');
  assert.equal(after.soak!.folded_at, '2026-07-11T00:00:00.000Z');
  assert.deepEqual(after.history, before.history, 'soak never appends a ReviewHistoryEntry — R-Q4');
  assert.equal(after.review_status, before.review_status, 'soak never gates review_status — R-Q4');
  assert.equal(after.status, before.status);

  const manifest = readSoakManifest(store.dir);
  assert.equal(manifest!.status, 'stopped');
  assert.equal(manifest!.stopped_by, 'op-2');

  const eventTypes = store.readEvents().map((e) => e.type);
  assert.ok(eventTypes.includes('recalibration.soak_stopped'));
});

test('soak stop: stopped_early is false when the sidecar already reached status complete', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const before = reviewableCandidate({ candidate_id: 'cand-complete' });
  store.writeCandidate(before);
  runSoakStart(store, {
    candidateId: before.candidate_id, requestedBy: 'op-1', targetTicks: 4, now: '2026-07-10T00:00:00.000Z',
  });
  const sidecar = freshSidecar(before.candidate_id, { status: 'complete', completed_at: '2026-07-10T00:10:00.000Z' });
  writeJson(soakSidecarPath(store.dir, before.candidate_id), sidecar);

  const result = runSoakStop(store, { candidateId: before.candidate_id, reviewer: 'op-2', now: '2026-07-11T00:00:00.000Z' });
  assert.equal(result.exitCode, 0);
  const after = store.readCandidate(before.candidate_id);
  assert.equal(after.soak!.stopped_early, false);
});

test('soak stop: no manifest for this candidate -> exit 1', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(reviewableCandidate({ candidate_id: 'cand-never-soaked' }));
  const result = runSoakStop(store, { candidateId: 'cand-never-soaked', reviewer: 'op-2' });
  assert.equal(result.exitCode, 1);
});

test('soak stop: no sidecar yet (soak controller never observed a tick) -> exit 0, manifest stopped, nothing folded', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const before = reviewableCandidate({ candidate_id: 'cand-no-tick' });
  store.writeCandidate(before);
  runSoakStart(store, { candidateId: before.candidate_id, requestedBy: 'op-1', now: '2026-07-10T00:00:00.000Z' });

  const result = runSoakStop(store, { candidateId: before.candidate_id, reviewer: 'op-2', now: '2026-07-11T00:00:00.000Z' });
  assert.equal(result.exitCode, 0);
  assert.ok(result.lines.some((l) => l.includes('no live sidecar to fold')));
  const after = store.readCandidate(before.candidate_id);
  assert.equal(after.soak, undefined);
  assert.equal(readSoakManifest(store.dir)!.status, 'stopped');
});

test('soak stop: idempotent — stopping an already-stopped soak refreshes the fold and exits 0', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const before = reviewableCandidate({ candidate_id: 'cand-idem' });
  store.writeCandidate(before);
  runSoakStart(store, {
    candidateId: before.candidate_id, requestedBy: 'op-1', targetTicks: 10, now: '2026-07-10T00:00:00.000Z',
  });
  writeJson(
    soakSidecarPath(store.dir, before.candidate_id),
    freshSidecar(before.candidate_id, { stats: { ...freshSidecar(before.candidate_id).stats, ticks_observed: 3 } }),
  );

  const firstStop = runSoakStop(store, { candidateId: before.candidate_id, reviewer: 'op-2', now: '2026-07-11T00:00:00.000Z' });
  assert.equal(firstStop.exitCode, 0);
  assert.equal(readSoakManifest(store.dir)!.status, 'stopped');

  // The service keeps flushing the sidecar on its own cadence regardless
  // of the manifest's status (it only reconciles the manifest on its own
  // next refresh) — simulate one more flushed tick landing before the
  // operator re-runs stop.
  writeJson(
    soakSidecarPath(store.dir, before.candidate_id),
    freshSidecar(before.candidate_id, { stats: { ...freshSidecar(before.candidate_id).stats, ticks_observed: 4 } }),
  );

  const secondStop = runSoakStop(store, { candidateId: before.candidate_id, reviewer: 'op-3', now: '2026-07-12T00:00:00.000Z' });
  assert.equal(secondStop.exitCode, 0);

  const after = store.readCandidate(before.candidate_id);
  assert.equal(after.soak!.sidecar.stats.ticks_observed, 4, 'the second stop refreshed the fold with the latest sidecar');
  assert.equal(after.soak!.folded_by, 'op-3');

  assert.equal(readSoakManifest(store.dir)!.stopped_by, 'op-2', 'the manifest itself is only stopped once — a second stop does not rewrite stopped_by');
});

// ── runShow hook (Task 6) ────────────────────────────────────────────

test('runShow: byte-identical to pre-soak output when there is no soak evidence, appends a SOAK line once folded', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  const emitter = new InMemoryLifecycleEventEmitter();
  const rec = reviewableCandidate({ candidate_id: 'cand-show' });
  store.writeCandidate(rec);

  const beforeSoak = await runShow(store, emitter, 'cand-show', '2026-07-11T00:00:00.000Z');
  assert.equal(beforeSoak.lines.length, 1, 'no soak data -> soakEvidenceLines is [] -> byte-identical to pre-soak show output');
  assert.equal(beforeSoak.lines[0], JSON.stringify(rec, null, 2));

  runSoakStart(store, {
    candidateId: 'cand-show', requestedBy: 'op-1', targetTicks: 10, now: '2026-07-10T00:00:00.000Z',
  });
  writeJson(soakSidecarPath(store.dir, 'cand-show'), freshSidecar('cand-show'));
  runSoakStop(store, { candidateId: 'cand-show', reviewer: 'op-2', now: '2026-07-11T00:05:00.000Z' });

  const afterSoak = await runShow(store, emitter, 'cand-show', '2026-07-11T00:10:00.000Z');
  assert.equal(afterSoak.lines.length, 2);
  assert.ok(afterSoak.lines[1].startsWith('SOAK (folded):'));
});

// ── argv parsing ─────────────────────────────────────────────────────

test('soakMain: unknown flag -> usage error', async () => {
  await assert.rejects(() => soakMain(['start', '--nope', 'x']), /Unknown flag/);
});

test('soakMain: no action -> usage error', async () => {
  await assert.rejects(() => soakMain([]));
});

test('soakMain: unknown action -> usage error', async () => {
  await assert.rejects(() => soakMain(['launch', '--service', 'svc-soak']), /Unknown soak action/);
});

// ── main() early branch (Task 6) ────────────────────────────────────

test("main: argv[0] === 'soak' dispatches through the early branch before parseArgv", async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-soak');
  store.writeCandidate(pendingShadowCandidate({ candidate_id: 'cand-main' }));

  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await main([
      'soak', 'start', '--root', root, '--service', 'svc-soak',
      '--candidate-id', 'cand-main', '--requested-by', 'op-1',
    ]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(process.exitCode, undefined, 'exit code stays unset on success');
  process.exitCode = originalExitCode;

  assert.ok(logged.some((l) => l.includes('soak started for candidate')));
  assert.equal(readSoakManifest(store.dir)!.candidate_id, 'cand-main');
});

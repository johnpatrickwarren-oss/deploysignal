// test/recalibrate-exclusions-cli.test.ts — R3 self-sourced exclusion-
// window inference, `exclusions` subcommand family. Exercises
// tools/recalibrate/_recalibrate-exclusions-cli.ts's handlers directly
// (no child_process, matching test/recalibration-cli.test.ts's own
// convention) against fixture stores under fs.mkdtempSync roots.
//
// Covers: suggest writes ONLY exclusion-suggestions.json (exclusion-
// windows.json byte-identical before/after) + appends
// recalibration.exclusions_suggested; apply moves confirmed suggestions
// into exclusion-windows.json (stamped declared_by), removes them from
// the suggestions file, and is a clear no-mutation error on an unknown/
// already-applied id (idempotent-safe); list prints declared + pending;
// the `exclusions` hook in _recalibrate-cli.ts's main() routes to this
// module; and the readiness-gate integration proving an applied
// suggestion actually feeds the EXISTING propose gate (not a parallel
// mechanism).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  runExclusionsSuggest, runExclusionsApply, runExclusionsList, readSuggestionsFile,
} from '../tools/recalibrate/_recalibrate-exclusions-cli';
import { runPropose, main } from '../tools/recalibrate/_recalibrate-cli';
import { RecalibrationStore, type ActivePointer } from '../tools/recalibrate/_recalibrate-store';
import { InMemoryLifecycleEventEmitter } from '../engine/o0/lifecycle-events';
import { SessionStore } from '../service/session/session-store';
import type { BeginSessionInput } from '../service/session/types';
import type { CompiledConfig } from '../engine/types';

function tmpRoot(prefix = 'excl-cli-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = '2026-07-15T00:00:00.000Z';

function beginInput(overrides: Partial<BeginSessionInput> = {}): BeginSessionInput {
  const deployRef = overrides.deploy_ref ?? 'deploy-ref-1';
  const begunRequestTs = overrides.begun_request_ts ?? 1_700_000_000;
  return {
    session_id: overrides.session_id ?? `sess-${deployRef}-${begunRequestTs}`,
    service_id: overrides.service_id ?? 'svc-demo',
    deploy_id: overrides.deploy_id ?? deployRef,
    deploy_ref: deployRef,
    mode: overrides.mode ?? 'enforce',
    fail_policy: overrides.fail_policy ?? 'fail_closed',
    active_calibration_version: overrides.active_calibration_version ?? 'v1',
    compiled_config_path: overrides.compiled_config_path ?? null,
    baseline_ref: overrides.baseline_ref ?? null,
    total_ticks: overrides.total_ticks ?? 60,
    begun_request_ts: begunRequestTs,
    begun_at: overrides.begun_at ?? '2026-07-01T00:00:00.000Z',
    deployment: overrides.deployment ?? { phase: 'baking', start_time_ms: begunRequestTs * 1000, cloud: 'primary' },
    scenario: overrides.scenario ?? {
      risk_level: 'medium', change_type: 'serving_code', author: 'human', time_window: 'ok', flags: {}, baseline: {},
    },
  };
}

/** Seeds one rollback session in a fresh SessionStore under
 *  `<sessionsRoot>/<serviceId>` — the layout `runExclusionsSuggest`
 *  scans via `--sessions-root`. */
function seedRollbackSession(sessionsRoot: string, serviceId: string, sessionId: string, begunAt: string, endedAt: string): void {
  const store = SessionStore.init(sessionsRoot, serviceId);
  const rec = store.beginSession(beginInput({ session_id: sessionId, service_id: serviceId, begun_at: begunAt }));
  store.updateSession(rec.session_id, {
    ended_at: endedAt,
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 1, alpha_consumed: 0, fires: [],
    },
  });
}

// ── suggest ──────────────────────────────────────────────────────────

test('exclusions suggest: writes ONLY exclusion-suggestions.json; exclusion-windows.json byte-identical before/after', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');

  // Seed a pre-existing declared exclusion-windows.json to prove
  // `suggest` never touches it.
  const declaredBefore = { schema_version: '1', windows: [{ start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z', reason: 'pre-existing' }] };
  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify(declaredBefore));
  const beforeBytes = fs.readFileSync(path.join(store.dir, 'exclusion-windows.json'), 'utf8');

  const result = runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, padMinutes: 30, now: NOW });
  assert.equal(result.exitCode, 0);

  const afterBytes = fs.readFileSync(path.join(store.dir, 'exclusion-windows.json'), 'utf8');
  assert.equal(afterBytes, beforeBytes, 'exclusion-windows.json must be byte-identical');

  const suggestions = readSuggestionsFile(store.dir);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].reason, 'rollback_session');
  assert.deepEqual(suggestions[0].evidence, ['sess-a']);

  const events = store.readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'recalibration.exclusions_suggested');
  assert.deepEqual(events[0].payload, { service_id: 'svc-demo', count: 1 });
});

test('exclusions suggest: no source records -> empty suggestions file, event count 0', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');

  const result = runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(readSuggestionsFile(store.dir), []);
  assert.deepEqual(store.readEvents()[0].payload, { service_id: 'svc-demo', count: 0 });
});

test('exclusions suggest: re-running REPLACES the suggestions file wholesale', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');

  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  assert.equal(readSuggestionsFile(store.dir).length, 1);

  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-b', '2026-08-01T00:00:00.000Z', '2026-08-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  assert.equal(readSuggestionsFile(store.dir).length, 2);
});

// ── apply ────────────────────────────────────────────────────────────

test('exclusions apply --ids: moves confirmed suggestion into exclusion-windows.json, stamps declared_by, removes from queue, appends event', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  const [suggestion] = readSuggestionsFile(store.dir);

  const result = runExclusionsApply(store, { ids: [suggestion.id], declaredBy: 'op-1', now: '2026-07-16T00:00:00.000Z' });
  assert.equal(result.exitCode, 0);

  const declared = store.readExclusionWindows();
  assert.equal(declared.length, 1);
  assert.equal(declared[0].start, suggestion.start);
  assert.equal(declared[0].end, suggestion.end);
  assert.equal(declared[0].reason, suggestion.reason);
  assert.equal(declared[0].declared_by, 'op-1');

  assert.deepEqual(readSuggestionsFile(store.dir), [], 'applied suggestion removed from the queue');

  const events = store.readEvents().filter((e) => e.type === 'recalibration.exclusions_applied');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { service_id: 'svc-demo', count: 1, ids: [suggestion.id] });
});

test('exclusions apply --all: applies every pending suggestion, preserves pre-existing declared windows', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify({
    schema_version: '1',
    windows: [{ start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z', reason: 'pre-existing', declared_by: 'op-0' }],
  }));
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-b', '2026-08-01T00:00:00.000Z', '2026-08-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  assert.equal(readSuggestionsFile(store.dir).length, 2);

  const result = runExclusionsApply(store, { all: true, declaredBy: 'op-2', now: NOW });
  assert.equal(result.exitCode, 0);

  const declared = store.readExclusionWindows();
  assert.equal(declared.length, 3); // pre-existing + 2 applied
  assert.ok(declared.some((w) => w.declared_by === 'op-0'));
  assert.equal(declared.filter((w) => w.declared_by === 'op-2').length, 2);
  assert.deepEqual(readSuggestionsFile(store.dir), []);
});

test('exclusions apply: neither --ids nor --all -> clear error, no mutation', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const result = runExclusionsApply(store, { declaredBy: 'op-1', now: NOW });
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines[0].includes('--ids or --all'));
  assert.deepEqual(store.readExclusionWindows(), []);
});

test('exclusions apply: unknown id -> clear error, NOTHING applied (no partial apply)', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  const [real] = readSuggestionsFile(store.dir);

  const result = runExclusionsApply(store, { ids: [real.id, 'excl-doesnotexist'], declaredBy: 'op-1', now: NOW });
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines[0].includes('excl-doesnotexist'));
  assert.deepEqual(store.readExclusionWindows(), [], 'no partial apply');
  assert.equal(readSuggestionsFile(store.dir).length, 1, 'queue untouched');
});

test('exclusions apply: idempotent-safe — re-applying an already-applied id is a clear error, not a crash', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });
  const [suggestion] = readSuggestionsFile(store.dir);

  const first = runExclusionsApply(store, { ids: [suggestion.id], declaredBy: 'op-1', now: NOW });
  assert.equal(first.exitCode, 0);

  const second = runExclusionsApply(store, { ids: [suggestion.id], declaredBy: 'op-1', now: NOW });
  assert.equal(second.exitCode, 1);
  assert.ok(second.lines[0].includes(suggestion.id));
  assert.equal(store.readExclusionWindows().length, 1, 'still exactly one applied window, not duplicated');
});

test('exclusions apply --all with nothing pending is a no-op success', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const result = runExclusionsApply(store, { all: true, declaredBy: 'op-1', now: NOW });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(store.readExclusionWindows(), []);
});

// ── list ─────────────────────────────────────────────────────────────

test('exclusions list: prints declared windows + pending suggestions', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  fs.writeFileSync(path.join(store.dir, 'exclusion-windows.json'), JSON.stringify({
    schema_version: '1',
    windows: [{ start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }],
  }));
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:10:00.000Z');
  runExclusionsSuggest(store, { serviceId: 'svc-demo', sessionsRoot, now: NOW });

  const result = runExclusionsList(store);
  assert.equal(result.exitCode, 0);
  assert.ok(result.lines.some((l) => l.includes('declared exclusion windows (1)')));
  assert.ok(result.lines.some((l) => l.includes('pending suggestions (1)')));
});

// ── main() hook ──────────────────────────────────────────────────────

test('main(): argv[0]===\'exclusions\' routes to exclusionsMain before parseArgv (own usage error, not the top-level one)', async () => {
  await assert.rejects(
    main(['exclusions']),
    /usage: recalibrate exclusions <suggest\|apply\|list>/,
  );
});

// ── readiness-gate integration: proves the applied suggestion feeds the
//    EXISTING gate, not a parallel mechanism ──────────────────────────

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

test('pipeline integration: an applied suggestion then fails a propose whose source window overlaps it', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const activePath = writeConfig(root, 'active.json', makeConfig({ version: 'v6@seed=42' }));
  seedActive(store, {
    schema_version: '1', version_id: 'v6@seed=42', candidate_id: null, compiled_config_path: activePath,
    baseline_ref: 'v6@seed=42', promoted_at: '2026-06-01T00:00:00.000Z', predecessor_version_id: null, promotion_history: [],
  });
  const candidatePath = writeConfig(root, 'candidate.json', makeConfig({ version: 'v7@seed=43' }));

  // Source-of-truth: a rollback session whose derived window overlaps
  // the propose sourceWindow below.
  const sessionsRoot = tmpRoot('excl-sessions-');
  seedRollbackSession(sessionsRoot, 'svc-demo', 'sess-a', '2026-06-25T00:00:00.000Z', '2026-06-25T00:10:00.000Z');

  const suggestResult = runExclusionsSuggest(store, {
    serviceId: 'svc-demo', sessionsRoot, padMinutes: 30, now: '2026-07-15T00:00:00.000Z',
  });
  assert.equal(suggestResult.exitCode, 0);
  const [suggestion] = readSuggestionsFile(store.dir);

  // Sanity: the proposed source window below DOES overlap the suggested
  // (padded) window before we apply it.
  assert.ok(suggestion.start < '2026-07-01T00:00:00.000Z' && suggestion.end > '2026-06-24T00:00:00.000Z');

  const applyResult = runExclusionsApply(store, { ids: [suggestion.id], declaredBy: 'op-1', now: '2026-07-15T01:00:00.000Z' });
  assert.equal(applyResult.exitCode, 0);

  const emitter = new InMemoryLifecycleEventEmitter();
  const proposeResult = await runPropose(store, emitter, {
    candidateId: 'cand-overlap',
    candidateConfigPath: candidatePath,
    creationReason: 'drift_detected',
    sourceWindow: { start: '2026-06-24T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', n_samples: 80 },
    now: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(proposeResult.exitCode, 2, 'propose must fail readiness — the applied suggestion feeds the existing gate');
  assert.ok(proposeResult.lines.some((l) => l.includes('source_window_outside_exclusions: FAIL')));
  const rec = store.readCandidate('cand-overlap');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.review_status, 'decided');
});

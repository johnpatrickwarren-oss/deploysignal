// test/recalibration-store.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 6.
//
// Exercises tools/recalibrate/_recalibrate-store.ts: RecalibrationStore
// (file-based candidate store, plan §B store layout — store-meta.json,
// candidates/<id>.json, active.json, events.jsonl, exclusion-windows.json)
// plus JsonlLifecycleEventEmitter (recalibrate-scoped; see that module's
// header for the WS4-convergence note).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  RecalibrationStore, RecalibrationStoreSchemaError, JsonlLifecycleEventEmitter,
} from '../tools/recalibrate/_recalibrate-store';
import type { CandidateRecord } from '../engine/types/recalibration';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recalibration-store-test-'));
}

function makeCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    schema_version: '1',
    service_id: 'svc-demo',
    candidate_id: 'cand-001',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=42',
    direction_classification: 'improvement',
    per_signal_direction: { mfu: 'improved' },
    suggested_reason_codes: [],
    shadow_mode_validated_at: null,
    timeout_at: '2026-08-01T00:00:00.000Z',
    status: 'candidate',
    review_status: 'pending_readiness',
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

// ── init / read round-trip ───────────────────────────────────────────

test('init: creates store dir, store-meta.json defaults, empty candidates + null active', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const meta = store.readMeta();
  assert.equal(meta.schema_version, '1');
  assert.equal(meta.service_id, 'svc-demo');
  assert.equal(typeof meta.timeout_days, 'number');
  assert.equal(typeof meta.unchanged_epsilon_rel, 'number');
  assert.deepEqual(meta.informational_direction_overrides, {});
  assert.deepEqual(store.listCandidates(), []);
  assert.equal(store.readActive(), null);
});

test('init: honors explicit opts overrides', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo', {
    timeoutDays: 21,
    unchangedEpsilonRel: 0.02,
    informationalDirectionOverrides: { cost_req: 'higher' },
  });
  const meta = store.readMeta();
  assert.equal(meta.timeout_days, 21);
  assert.equal(meta.unchanged_epsilon_rel, 0.02);
  assert.deepEqual(meta.informational_direction_overrides, { cost_req: 'higher' });
});

test('writeCandidate / readCandidate: round-trip preserves full record', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const rec = makeCandidate();
  store.writeCandidate(rec);
  const loaded = store.readCandidate('cand-001');
  assert.deepEqual(loaded, rec);
});

test('listCandidates: returns every written candidate', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeCandidate(makeCandidate({ candidate_id: 'cand-001' }));
  store.writeCandidate(makeCandidate({ candidate_id: 'cand-002' }));
  const all = store.listCandidates();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((c) => c.candidate_id).sort(), ['cand-001', 'cand-002']);
});

test('readCandidate: unknown id throws', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  assert.throws(() => store.readCandidate('no-such-id'));
});

// ── atomic promote ────────────────────────────────────────────────────

test('promote: bootstrap promote (no prior active) sets active.json + promotion_history[0]', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const rec = makeCandidate({
    status: 'active', review_status: 'decided', outcome: 'auto_promoted',
  });
  store.writeCandidate(rec);

  store.promote('cand-001', 'auto_promoted', '2026-07-02T00:00:00.000Z');

  const active = store.readActive();
  assert.ok(active);
  assert.equal(active!.schema_version, '1');
  assert.equal(active!.version_id, 'v6@seed=42');
  assert.equal(active!.candidate_id, 'cand-001');
  assert.equal(active!.compiled_config_path, 'runs/compiled-configs/v6-candidate.json');
  assert.equal(active!.predecessor_version_id, null);
  assert.equal(active!.promotion_history.length, 1);
  assert.equal(active!.promotion_history[0].version_id, 'v6@seed=42');
  assert.equal(active!.promotion_history[0].outcome, 'auto_promoted');
});

test('promote: second promote marks prior active candidate superseded + preserves history', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');

  const first = makeCandidate({
    candidate_id: 'cand-001',
    proposed_baseline_version: 'v6@seed=42',
    status: 'active',
    review_status: 'decided',
    outcome: 'auto_promoted',
  });
  store.writeCandidate(first);
  store.promote('cand-001', 'auto_promoted', '2026-07-02T00:00:00.000Z');

  const second = makeCandidate({
    candidate_id: 'cand-002',
    proposed_baseline_version: 'v7@seed=43',
    current_baseline_version: 'v6@seed=42',
    compiled_config_path: 'runs/compiled-configs/v7-candidate.json',
    status: 'active',
    review_status: 'decided',
    outcome: 'operator_approved',
  });
  store.writeCandidate(second);
  store.promote('cand-002', 'operator_approved', '2026-07-10T00:00:00.000Z', {
    actor: 'operator-1', reasonCode: 'traffic_mix_change',
  });

  const active = store.readActive();
  assert.equal(active!.version_id, 'v7@seed=43');
  assert.equal(active!.candidate_id, 'cand-002');
  assert.equal(active!.predecessor_version_id, 'v6@seed=42');
  assert.equal(active!.promotion_history.length, 2);
  assert.equal(active!.promotion_history[1].actor, 'operator-1');
  assert.equal(active!.promotion_history[1].reason_code, 'traffic_mix_change');

  const priorCandidate = store.readCandidate('cand-001');
  assert.equal(priorCandidate.status, 'superseded');
  assert.equal(priorCandidate.history[priorCandidate.history.length - 1].action, 'superseded');
});

// ── rollback ──────────────────────────────────────────────────────────

test('rollbackTo: restores predecessor version + appends promotion_history + event', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');

  const first = makeCandidate({
    candidate_id: 'cand-001', proposed_baseline_version: 'v6@seed=42', status: 'active', review_status: 'decided', outcome: 'auto_promoted',
  });
  store.writeCandidate(first);
  store.promote('cand-001', 'auto_promoted', '2026-07-02T00:00:00.000Z');

  const second = makeCandidate({
    candidate_id: 'cand-002',
    proposed_baseline_version: 'v7@seed=43',
    compiled_config_path: 'runs/compiled-configs/v7-candidate.json',
    status: 'active',
    review_status: 'decided',
    outcome: 'operator_approved',
  });
  store.writeCandidate(second);
  store.promote('cand-002', 'operator_approved', '2026-07-10T00:00:00.000Z');

  store.rollbackTo('v6@seed=42', 'operator-1', 'regression', '2026-07-11T00:00:00.000Z');

  const active = store.readActive();
  assert.equal(active!.version_id, 'v6@seed=42');
  assert.equal(active!.predecessor_version_id, 'v7@seed=43');
  assert.equal(active!.compiled_config_path, 'runs/compiled-configs/v6-candidate.json');
  assert.equal(active!.promotion_history.length, 3);
  const last = active!.promotion_history[2];
  assert.equal(last.version_id, 'v6@seed=42');
  assert.equal(last.outcome, 'rollback');
  assert.equal(last.actor, 'operator-1');
  assert.equal(last.reason_code, 'regression');

  const events = store.readEvents();
  const rollbackEvent = events.find((e) => e.type === 'recalibration.rolled_back');
  assert.ok(rollbackEvent, 'rollbackTo should append a store event');
});

test('rollbackTo: unknown target version throws', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const rec = makeCandidate({ status: 'active', review_status: 'decided', outcome: 'auto_promoted' });
  store.writeCandidate(rec);
  store.promote('cand-001', 'auto_promoted', '2026-07-02T00:00:00.000Z');
  assert.throws(() => store.rollbackTo('v-does-not-exist', 'operator-1', 'regression', '2026-07-11T00:00:00.000Z'));
});

test('rollbackTo: no active pointer throws', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  assert.throws(() => store.rollbackTo('v6@seed=42', 'operator-1', 'regression', '2026-07-11T00:00:00.000Z'));
});

// ── exclusion windows ─────────────────────────────────────────────────

test('readExclusionWindows: absent file -> []', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  assert.deepEqual(store.readExclusionWindows(), []);
});

test('readExclusionWindows: reads declared windows', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const dir = path.join(root, 'svc-demo');
  fs.writeFileSync(
    path.join(dir, 'exclusion-windows.json'),
    JSON.stringify({
      schema_version: '1',
      windows: [{
        start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1',
      }],
    }),
  );
  const windows = store.readExclusionWindows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].reason, 'incident');
});

// R3 (exclusion-window inference) — writeExclusionWindows, added
// alongside readExclusionWindows since no writer existed before.
test('writeExclusionWindows: round-trips through readExclusionWindows; atomic (no .tmp- sibling left behind)', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeExclusionWindows([
    { start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' },
  ]);
  assert.deepEqual(store.readExclusionWindows(), [
    { start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' },
  ]);
  const leftoverTmp = fs.readdirSync(store.dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftoverTmp, []);
});

test('writeExclusionWindows: full replace, not append — second call overwrites the first', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.writeExclusionWindows([{ start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' }]);
  store.writeExclusionWindows([{ start: '2026-02-01T00:00:00.000Z', end: '2026-02-02T00:00:00.000Z' }]);
  const windows = store.readExclusionWindows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, '2026-02-01T00:00:00.000Z');
});

// ── schema-version guard ──────────────────────────────────────────────

test('readMeta: unknown schema_version throws typed error', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const dir = path.join(root, 'svc-demo');
  fs.writeFileSync(
    path.join(dir, 'store-meta.json'),
    JSON.stringify({
      schema_version: '2', service_id: 'svc-demo', timeout_days: 14, informational_direction_overrides: {}, unchanged_epsilon_rel: 0.01,
    }),
  );
  assert.throws(() => store.readMeta(), RecalibrationStoreSchemaError);
});

test('readCandidate: unknown schema_version throws typed error', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const dir = path.join(root, 'svc-demo', 'candidates');
  fs.writeFileSync(
    path.join(dir, 'bad.json'),
    JSON.stringify({ ...makeCandidate({ candidate_id: 'bad' }), schema_version: '2' }),
  );
  assert.throws(() => store.readCandidate('bad'), RecalibrationStoreSchemaError);
});

test('readActive: unknown schema_version throws typed error', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const dir = path.join(root, 'svc-demo');
  fs.writeFileSync(
    path.join(dir, 'active.json'),
    JSON.stringify({
      schema_version: '2', version_id: 'v1', candidate_id: null, compiled_config_path: 'x', baseline_ref: 'x', promoted_at: 'x', predecessor_version_id: null, promotion_history: [],
    }),
  );
  assert.throws(() => store.readActive(), RecalibrationStoreSchemaError);
});

// ── events round-trip ──────────────────────────────────────────────────

test('JsonlLifecycleEventEmitter: emit + store.readEvents round-trip in order', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const emitter = new JsonlLifecycleEventEmitter(store);

  const base = {
    service_id: 'svc-demo',
    candidate_id: 'cand-001',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=42',
    direction_classification: 'improvement' as const,
    at: '2026-07-01T00:00:00.000Z',
  };
  await emitter.emit('recalibration.proposed', { type: 'recalibration.proposed', ...base });
  await emitter.emit('recalibration.auto_promoted', { type: 'recalibration.auto_promoted', ...base });

  const events = store.readEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'recalibration.proposed');
  assert.equal(events[1].type, 'recalibration.auto_promoted');
  assert.equal((events[0].payload as typeof base & { type: string }).candidate_id, 'cand-001');
  // Fix 3 (Tasks 6-8 review) — the envelope's `at` must equal the
  // deterministic payload `at` threaded from the caller, not a fresh
  // wall-clock read at emit time.
  assert.equal(events[0].at, base.at);
  assert.equal(events[1].at, base.at);
});

test('JsonlLifecycleEventEmitter: envelope `at` falls back to wall clock only when payload has no `at`', async () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  const emitter = new JsonlLifecycleEventEmitter(store);

  const before = Date.now();
  // Cast past the typed payload contract to exercise the defensive
  // fallback branch — every real LifecycleEventPayload variant does
  // carry `at`, but the emitter must not crash if one somehow didn't.
  await emitter.emit('recalibration.proposed', {
    type: 'recalibration.proposed',
    service_id: 'svc-demo',
    candidate_id: 'cand-002',
    proposed_baseline_version: 'v6@seed=42',
    current_baseline_version: 'v5@seed=42',
    direction_classification: 'improvement',
  } as unknown as Parameters<typeof emitter.emit>[1]);
  const after = Date.now();

  const [event] = store.readEvents();
  const atMs = new Date(event.at).getTime();
  assert.ok(atMs >= before && atMs <= after, `expected wall-clock fallback 'at', got ${event.at}`);
});

test('appendEvent / readEvents: empty log before any events', () => {
  const root = tmpRoot();
  const store = RecalibrationStore.init(root, 'svc-demo');
  assert.deepEqual(store.readEvents(), []);
});

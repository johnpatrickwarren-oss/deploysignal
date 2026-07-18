// test/recalibrate-exclusions.test.ts — R3 self-sourced exclusion-window
// inference (SUGGEST-ONLY). Exercises
// tools/recalibrate/_recalibrate-exclusions.ts's pure derivation:
// scanSessionStore (rollback + voided sessions), scanRecalEvents
// (recalibration.rolled_back StoredEvents), mergeSuggestions
// (overlap/adjacent-within-pad + evidence concatenation), and
// deriveSuggestedExclusions determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  scanSessionStore, scanRecalEvents, mergeSuggestions, deriveSuggestedExclusions,
  type SuggestedExclusion,
} from '../tools/recalibrate/_recalibrate-exclusions';
import { RecalibrationStore } from '../tools/recalibrate/_recalibrate-store';
import { SessionStore } from '../service/session/session-store';
import type { BeginSessionInput } from '../service/session/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

const NOW = '2026-07-15T00:00:00.000Z';

// ── scanSessionStore: rollback sessions ─────────────────────────────

test('scanSessionStore: rollback session -> padded window with exact ISO arithmetic', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-a', begun_at: '2026-07-01T00:00:00.000Z' }));
  store.updateSession(rec.session_id, {
    status: 'finished',
    ended_at: '2026-07-01T00:10:00.000Z',
    last_tick_at: '2026-07-01T00:09:00.000Z',
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 5, alpha_consumed: 0.001, fires: ['A'],
    },
  });

  const suggestions = scanSessionStore(path.join(root, 'svc-demo'), 30, NOW);
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];
  assert.equal(s.start, '2026-06-30T23:30:00.000Z'); // begun_at - 30m
  assert.equal(s.end, '2026-07-01T00:40:00.000Z'); // ended_at + 30m
  assert.equal(s.reason, 'rollback_session');
  assert.deepEqual(s.evidence, ['sess-a']);
  assert.equal(s.suggested_at, NOW);
  assert.ok(s.id.startsWith('excl-'));
});

test('scanSessionStore: rollback session with no ended_at falls back to last_tick_at', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-b', begun_at: '2026-07-01T00:00:00.000Z' }));
  store.updateSession(rec.session_id, {
    last_tick_at: '2026-07-01T00:05:00.000Z',
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 3, alpha_consumed: 0.001, fires: [],
    },
  });

  const suggestions = scanSessionStore(path.join(root, 'svc-demo'), 30, NOW);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].end, '2026-07-01T00:35:00.000Z'); // last_tick_at + 30m
});

test('scanSessionStore: rollback session with neither ended_at nor last_tick_at falls back to begun_at', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-c', begun_at: '2026-07-01T00:00:00.000Z' }));
  store.updateSession(rec.session_id, {
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 0, alpha_consumed: 0, fires: [],
    },
  });

  const suggestions = scanSessionStore(path.join(root, 'svc-demo'), 30, NOW);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].start, '2026-06-30T23:30:00.000Z');
  assert.equal(suggestions[0].end, '2026-07-01T00:30:00.000Z'); // begun_at + 30m
});

// ── scanSessionStore: voided sessions ───────────────────────────────

test('scanSessionStore: voided session -> padded window with exact ISO arithmetic (same treatment as rollback — ended_at is a declaration stamp, not a precise boundary)', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-d', begun_at: '2026-07-02T00:00:00.000Z' }));
  store.voidSession(rec.session_id, 'declare_void_and_restart');
  // voidSession stamps ended_at with a live wall-clock timestamp; pin it
  // for a deterministic assertion.
  store.updateSession(rec.session_id, { ended_at: '2026-07-02T00:20:00.000Z' });

  const suggestions = scanSessionStore(path.join(root, 'svc-demo'), 30, NOW);
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];
  assert.equal(s.start, '2026-07-01T23:30:00.000Z'); // begun_at - 30m
  assert.equal(s.end, '2026-07-02T00:50:00.000Z'); // ended_at + 30m
  assert.equal(s.reason, 'voided_session:declare_void_and_restart');
  assert.deepEqual(s.evidence, ['sess-d']);
});

test('scanSessionStore: session that is neither rollback nor voided yields nothing', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-e' }));
  store.updateSession(rec.session_id, {
    status: 'finished',
    ended_at: '2026-07-01T00:10:00.000Z',
    last_verdict: {
      verdict: 'proceed', verdict_code: 0, tick: 5, alpha_consumed: 0, fires: [],
    },
  });

  assert.deepEqual(scanSessionStore(path.join(root, 'svc-demo'), 30, NOW), []);
});

test('scanSessionStore: a session that is BOTH voided and last-verdict-rollback yields two suggestions', () => {
  const root = tmpDir('excl-sessions-');
  const store = SessionStore.init(root, 'svc-demo');
  const rec = store.beginSession(beginInput({ session_id: 'sess-f', begun_at: '2026-07-03T00:00:00.000Z' }));
  store.updateSession(rec.session_id, {
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 2, alpha_consumed: 0, fires: [],
    },
  });
  store.voidSession(rec.session_id, 'manual');
  store.updateSession(rec.session_id, { ended_at: '2026-07-03T00:05:00.000Z' });

  const suggestions = scanSessionStore(path.join(root, 'svc-demo'), 30, NOW);
  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map((s) => s.reason).sort(), ['rollback_session', 'voided_session:manual']);
});

test('scanSessionStore: absent sessions dir -> []', () => {
  const root = tmpDir('excl-sessions-');
  assert.deepEqual(scanSessionStore(path.join(root, 'no-such-service'), 30, NOW), []);
});

// ── scanRecalEvents ──────────────────────────────────────────────────

test('scanRecalEvents: recalibration.rolled_back event -> padded window, evidence = recal-event:<at>', () => {
  const root = tmpDir('excl-recal-');
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.appendEvent({
    type: 'recalibration.rolled_back',
    payload: {
      service_id: 'svc-demo', rolled_back_to: 'v5@seed=1', rolled_back_from: 'v6@seed=1', actor: 'op-1', reason_code: 'regression',
    },
    at: '2026-07-04T12:00:00.000Z',
  });

  const suggestions = scanRecalEvents(store, 30, NOW);
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];
  assert.equal(s.start, '2026-07-04T11:30:00.000Z');
  assert.equal(s.end, '2026-07-04T12:30:00.000Z');
  assert.equal(s.reason, 'baseline_rollback');
  assert.deepEqual(s.evidence, ['recal-event:2026-07-04T12:00:00.000Z']);
  assert.equal(s.suggested_at, NOW);
});

test('scanRecalEvents: non-rollback events are ignored', () => {
  const root = tmpDir('excl-recal-');
  const store = RecalibrationStore.init(root, 'svc-demo');
  store.appendEvent({ type: 'recalibration.calendar_due', payload: {}, at: '2026-07-04T12:00:00.000Z' });
  assert.deepEqual(scanRecalEvents(store, 30, NOW), []);
});

test('scanRecalEvents: no events file -> []', () => {
  const root = tmpDir('excl-recal-');
  const store = RecalibrationStore.init(root, 'svc-demo');
  assert.deepEqual(scanRecalEvents(store, 30, NOW), []);
});

// ── mergeSuggestions ─────────────────────────────────────────────────

function mk(start: string, end: string, reason: string, evidence: string[]): SuggestedExclusion {
  return {
    id: `excl-${start}`, start, end, reason, evidence, suggested_at: NOW,
  };
}

test('mergeSuggestions: overlapping windows merge, union of bounds, evidence concatenated', () => {
  const a = mk('2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'rollback_session', ['sess-a']);
  const b = mk('2026-07-01T00:30:00.000Z', '2026-07-01T02:00:00.000Z', 'rollback_session', ['sess-b']);
  const merged = mergeSuggestions([a, b], 30);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, '2026-07-01T00:00:00.000Z');
  assert.equal(merged[0].end, '2026-07-01T02:00:00.000Z');
  assert.deepEqual(merged[0].evidence, ['sess-a', 'sess-b']);
  assert.equal(merged[0].reason, 'rollback_session');
});

test('mergeSuggestions: adjacent-within-pad windows merge; reasons deduplicated as a union', () => {
  const a = mk('2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'rollback_session', ['sess-a']);
  // gap between a.end and b.start is exactly 20 minutes <= 30-minute pad tolerance
  const b = mk('2026-07-01T01:20:00.000Z', '2026-07-01T02:00:00.000Z', 'baseline_rollback', ['recal-event:x']);
  const merged = mergeSuggestions([a, b], 30);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, '2026-07-01T00:00:00.000Z');
  assert.equal(merged[0].end, '2026-07-01T02:00:00.000Z');
  assert.deepEqual(merged[0].evidence, ['sess-a', 'recal-event:x']);
  assert.equal(merged[0].reason, 'rollback_session, baseline_rollback');
});

test('mergeSuggestions: windows farther apart than pad tolerance stay separate', () => {
  const a = mk('2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'rollback_session', ['sess-a']);
  const b = mk('2026-07-01T02:00:00.000Z', '2026-07-01T03:00:00.000Z', 'rollback_session', ['sess-b']);
  const merged = mergeSuggestions([a, b], 30);
  assert.equal(merged.length, 2);
});

test('mergeSuggestions: identical reason merged twice does not duplicate in the reason string', () => {
  const a = mk('2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'rollback_session', ['sess-a']);
  const b = mk('2026-07-01T00:10:00.000Z', '2026-07-01T01:10:00.000Z', 'rollback_session', ['sess-b']);
  const merged = mergeSuggestions([a, b], 30);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].reason, 'rollback_session');
});

test('mergeSuggestions: empty input -> []', () => {
  assert.deepEqual(mergeSuggestions([], 30), []);
});

// ── deriveSuggestedExclusions: determinism ──────────────────────────

test('deriveSuggestedExclusions: deterministic given identical inputs + nowIso', () => {
  const sessionsRoot = tmpDir('excl-sessions-');
  const sessStore = SessionStore.init(sessionsRoot, 'svc-demo');
  const rec = sessStore.beginSession(beginInput({ session_id: 'sess-det', begun_at: '2026-07-05T00:00:00.000Z' }));
  sessStore.updateSession(rec.session_id, {
    ended_at: '2026-07-05T00:10:00.000Z',
    last_verdict: {
      verdict: 'rollback', verdict_code: 2, tick: 1, alpha_consumed: 0, fires: [],
    },
  });

  const recalRoot = tmpDir('excl-recal-');
  const recalStore = RecalibrationStore.init(recalRoot, 'svc-demo');
  recalStore.appendEvent({
    type: 'recalibration.rolled_back',
    payload: { service_id: 'svc-demo', rolled_back_to: 'v1', rolled_back_from: 'v2' },
    at: '2026-07-06T00:00:00.000Z',
  });

  const input = {
    sessionsServiceDir: path.join(sessionsRoot, 'svc-demo'), store: recalStore, padMinutes: 30, nowIso: NOW,
  };
  const first = deriveSuggestedExclusions(input);
  const second = deriveSuggestedExclusions(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  // sorted by start
  assert.ok(first[0].start < first[1].start);
});

test('deriveSuggestedExclusions: no source records -> []', () => {
  const sessionsRoot = tmpDir('excl-sessions-');
  SessionStore.init(sessionsRoot, 'svc-demo');
  const recalRoot = tmpDir('excl-recal-');
  const recalStore = RecalibrationStore.init(recalRoot, 'svc-demo');

  const result = deriveSuggestedExclusions({
    sessionsServiceDir: path.join(sessionsRoot, 'svc-demo'), store: recalStore, padMinutes: 30, nowIso: NOW,
  });
  assert.deepEqual(result, []);
});

// ── deriveSuggestedExclusions: containment filter against declared
//    windows (resurrection guard) ─────────────────────────────────────

test('deriveSuggestedExclusions: a suggestion exactly matching a declared window is filtered out', () => {
  const sessionsRoot = tmpDir('excl-sessions-');
  const sessStore = SessionStore.init(sessionsRoot, 'svc-demo');
  const rec = sessStore.beginSession(beginInput({ session_id: 'sess-cov', begun_at: '2026-07-01T00:00:00.000Z' }));
  sessStore.updateSession(rec.session_id, {
    ended_at: '2026-07-01T00:10:00.000Z',
    last_verdict: { verdict: 'rollback', verdict_code: 2, tick: 1, alpha_consumed: 0, fires: [] },
  });

  const recalRoot = tmpDir('excl-recal-');
  const recalStore = RecalibrationStore.init(recalRoot, 'svc-demo');
  const input = {
    sessionsServiceDir: path.join(sessionsRoot, 'svc-demo'), store: recalStore, padMinutes: 30, nowIso: NOW,
  };

  // Pin down the exact window the source record derives to (padded
  // begun_at/ended_at, see the rollback-session arithmetic test above),
  // then declare it verbatim — the shape a suggestion has after it was
  // already applied once.
  recalStore.writeExclusionWindows([{
    start: '2026-06-30T23:30:00.000Z', end: '2026-07-01T00:40:00.000Z', reason: 'rollback_session', declared_by: 'op-1',
  }]);

  assert.deepEqual(deriveSuggestedExclusions(input), []);
});

test('deriveSuggestedExclusions: a suggestion fully inside a WIDER declared window is filtered out', () => {
  const sessionsRoot = tmpDir('excl-sessions-');
  const sessStore = SessionStore.init(sessionsRoot, 'svc-demo');
  const rec = sessStore.beginSession(beginInput({ session_id: 'sess-wide', begun_at: '2026-07-01T00:00:00.000Z' }));
  sessStore.updateSession(rec.session_id, {
    ended_at: '2026-07-01T00:10:00.000Z',
    last_verdict: { verdict: 'rollback', verdict_code: 2, tick: 1, alpha_consumed: 0, fires: [] },
  });

  const recalRoot = tmpDir('excl-recal-');
  const recalStore = RecalibrationStore.init(recalRoot, 'svc-demo');
  // A wide operator-declared incident window that fully contains the
  // (padded) session-derived suggestion.
  recalStore.writeExclusionWindows([{
    start: '2026-06-30T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z', reason: 'known_incident', declared_by: 'op-1',
  }]);

  const result = deriveSuggestedExclusions({
    sessionsServiceDir: path.join(sessionsRoot, 'svc-demo'), store: recalStore, padMinutes: 30, nowIso: NOW,
  });
  assert.deepEqual(result, []);
});

test('deriveSuggestedExclusions: a suggestion only PARTIALLY overlapping a declared window is still suggested', () => {
  const sessionsRoot = tmpDir('excl-sessions-');
  const sessStore = SessionStore.init(sessionsRoot, 'svc-demo');
  const rec = sessStore.beginSession(beginInput({ session_id: 'sess-partial', begun_at: '2026-07-01T00:00:00.000Z' }));
  sessStore.updateSession(rec.session_id, {
    ended_at: '2026-07-01T00:10:00.000Z',
    last_verdict: { verdict: 'rollback', verdict_code: 2, tick: 1, alpha_consumed: 0, fires: [] },
  });

  const recalRoot = tmpDir('excl-recal-');
  const recalStore = RecalibrationStore.init(recalRoot, 'svc-demo');
  // Declared window overlaps only the tail of the (padded) suggestion
  // [2026-06-30T23:30, 2026-07-01T00:40) — it does NOT contain it.
  recalStore.writeExclusionWindows([{
    start: '2026-07-01T00:35:00.000Z', end: '2026-07-01T02:00:00.000Z', reason: 'later_incident', declared_by: 'op-1',
  }]);

  const result = deriveSuggestedExclusions({
    sessionsServiceDir: path.join(sessionsRoot, 'svc-demo'), store: recalStore, padMinutes: 30, nowIso: NOW,
  });
  assert.equal(result.length, 1, 'partially-overlapping declared window must not suppress the suggestion');
  assert.equal(result[0].reason, 'rollback_session');
});

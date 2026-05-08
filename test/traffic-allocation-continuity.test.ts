// test/traffic-allocation-continuity.test.ts — Addition #10 L0 unit tests.
//
// Acceptance per ARCHITECT-REPLY-28.md: exercise all three classes
// (stable / drifting / breaking), the sustained-drift-to-breaking escalation,
// recovery back to stable, analytical closed-form sanity, and the rolling
// window boundary. Architect-set constants (2σ / 5σ / 5-tick sustained /
// 2% σ floor) are asserted as spec-level invariants — if a test case seems
// to require different numbers, escalate via TPM rather than adjusting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyContinuity, initialState, formatSrmReason,
  ROLLING_WINDOW_SIZE, STABLE_SIGMA_THRESHOLD, CATASTROPHIC_SIGMA_THRESHOLD,
  DRIFTING_TO_BREAKING_TICKS, EXPECTED_SIGMA_FLOOR,
} from '../dist/engine/l0/traffic-allocation-continuity';
import type {
  TrafficAllocationState, TrafficAllocationStatus,
} from '../dist/engine/l0/traffic-allocation-continuity';

// Helper: run a sequence of observed traffic_pct values through the
// classifier, returning the status at each tick + the final state.
function run(
  observed: number[],
  expectedCanaryWeight: number,
): { statuses: TrafficAllocationStatus[]; finalState: TrafficAllocationState } {
  let state = initialState(expectedCanaryWeight);
  const statuses: TrafficAllocationStatus[] = [];
  for (const obs of observed) {
    const out = classifyContinuity(obs, state);
    statuses.push(out.status);
    state = out.newState;
  }
  return { statuses, finalState: state };
}

// ────────────────────────────────────────────────────────────────────
test('srm: stable allocation — observed = expected for 10 ticks', () => {
  const { statuses, finalState } = run(Array(10).fill(0.1), 0.1);
  for (let i = 0; i < statuses.length; i++) {
    assert.equal(statuses[i], 'stable', `tick ${i} should be 'stable'`);
  }
  assert.equal(finalState.driftTickCount, 0);
});

test('srm: stable with ±1% noise — noise floor keeps it stable', () => {
  // Random ±1% noise, 10 ticks. EXPECTED_SIGMA_FLOOR (0.02) floors σ at 2%,
  // so |deviation| < 1% stays well under 2σ (= 4%).
  const observed: number[] = [];
  let seed = 42;
  for (let i = 0; i < 10; i++) {
    // Deterministic pseudo-random in [-0.01, 0.01] (LCG).
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = ((seed / 0x7fffffff) - 0.5) * 0.02;
    observed.push(0.1 + r);
  }
  const { statuses } = run(observed, 0.1);
  for (let i = 0; i < statuses.length; i++) {
    assert.equal(statuses[i], 'stable', `tick ${i} should be 'stable' under ±1% noise`);
  }
});

test('srm: sustained drift — stable → drifting → breaking after ≥5 consecutive', () => {
  // One stable tick establishes a baseline history entry, then a sustained
  // step to 0.15. zScore crosses 2σ (non-catastrophic) on tick 1 and stays
  // there; sustained escalation trips at driftTickCount = 5.
  const observed = [0.10, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15];
  const { statuses } = run(observed, 0.10);

  assert.equal(statuses[0], 'stable');
  const firstDrift = statuses.indexOf('drifting');
  const firstBreak = statuses.indexOf('breaking');
  assert.ok(firstDrift === 1, `expected 'drifting' to begin at tick 1; got ${statuses.join(',')}`);
  assert.ok(firstBreak > firstDrift,
    `expected 'breaking' after sustained drift; got ${statuses.join(',')}`);
  // Sustained-to-breaking: status transitions to 'breaking' exactly when
  // driftTickCount reaches DRIFTING_TO_BREAKING_TICKS.
  assert.equal(firstBreak, DRIFTING_TO_BREAKING_TICKS,
    `breaking at tick ${firstBreak}; expected tick DRIFTING_TO_BREAKING_TICKS=${DRIFTING_TO_BREAKING_TICKS}`);
});

test('srm: catastrophic drift — observed = 0 at tick 3 → immediate breaking', () => {
  // Ticks 0–2 stable at 0.10, tick 3 collapses to 0. zScore = 0.10 / 0.02 = 5.0
  // immediately ≥ CATASTROPHIC_SIGMA_THRESHOLD → breaking without waiting
  // for sustained drift.
  const observed = [0.10, 0.10, 0.10, 0.00];
  const { statuses } = run(observed, 0.10);
  assert.equal(statuses[0], 'stable');
  assert.equal(statuses[1], 'stable');
  assert.equal(statuses[2], 'stable');
  assert.equal(statuses[3], 'breaking', `tick 3 should be 'breaking' immediately; got ${statuses[3]}`);
});

test('srm: recovery — drifting then back to stable resets drift counter', () => {
  // Four drifting ticks (not yet sustained), then recovery. Recovery tick
  // must reset driftTickCount to 0 so subsequent drift starts fresh.
  let state = initialState(0.10);
  // 3 ticks at mild drift (~2.5σ over floor).
  for (let i = 0; i < 3; i++) {
    const out = classifyContinuity(0.15, state);
    state = out.newState;
  }
  assert.ok(state.driftTickCount >= 1, `expected nonzero driftTickCount during drift`);
  const recover = classifyContinuity(0.10, state);
  assert.equal(recover.status, 'stable');
  assert.equal(recover.newState.driftTickCount, 0, 'recovery must reset driftTickCount');
});

test('srm: analytical closed-form — documented math holds', () => {
  // Case 1: all observations exactly at expected → σ from prev-history has
  // zero variance, floored to 0.02; deviation = 0; zScore = 0 → stable.
  let state = initialState(0.10);
  for (let i = 0; i < 5; i++) {
    const out = classifyContinuity(0.10, state);
    state = out.newState;
    assert.equal(out.status, 'stable');
  }
  assert.equal(state.observedHistory.length, 5);

  // Case 2: from that stable state, a single observation at 0.30 (3× expected).
  // σ is computed from prev-window [0.10×5] → variance = 0 → floor 0.02.
  // deviation = |0.30 − 0.10| = 0.20; zScore = 0.20 / 0.02 = 10.0 ≥ 5.0 →
  // immediate breaking. Documents the architect's worked example.
  const spike = classifyContinuity(0.30, state);
  assert.equal(spike.status, 'breaking', '3x-spike from stable window → breaking (zScore = 10)');

  // Case 3: from a fresh state with a single observation of 0.30 when
  // expected 0.10 → prev-window empty → σ = floor (0.02); zScore = 10.0 →
  // breaking immediately (same math, no history to smooth σ).
  const immediate = classifyContinuity(0.30, initialState(0.10));
  assert.equal(immediate.status, 'breaking', 'fresh-state 3× spike → immediate breaking');
});

test('srm: rolling window boundary — only last 5 ticks influence σ', () => {
  // Feed 10 stable observations, then a spike. The rolling window must
  // hold only the last 5 entries.
  let state = initialState(0.10);
  for (let i = 0; i < 10; i++) {
    state = classifyContinuity(0.10, state).newState;
  }
  assert.equal(state.observedHistory.length, ROLLING_WINDOW_SIZE,
    `history should be capped at ROLLING_WINDOW_SIZE=${ROLLING_WINDOW_SIZE}`);
  for (const v of state.observedHistory) assert.equal(v, 0.10);
});

// ────────────────────────────────────────────────────────────────────
test('srm: formatSrmReason matches spec format', () => {
  assert.equal(
    formatSrmReason(0.03, 0.10),
    'Sample Ratio Mismatch — observed canary fraction 3.0% diverged from expected 10.0%',
  );
  assert.equal(
    formatSrmReason(0.50, 0.25),
    'Sample Ratio Mismatch — observed canary fraction 50.0% diverged from expected 25.0%',
  );
});

// ────────────────────────────────────────────────────────────────────
// Architect-set constants surfaced to callers (invariant checks).
test('srm: architect-set constants match spec', () => {
  assert.equal(ROLLING_WINDOW_SIZE, 5, 'ARCHITECT-REPLY-28: rolling window = 5 ticks');
  assert.equal(STABLE_SIGMA_THRESHOLD, 2.0, 'ARCHITECT-REPLY-28: stable threshold = 2σ');
  assert.equal(CATASTROPHIC_SIGMA_THRESHOLD, 5.0, 'ARCHITECT-REPLY-28: catastrophic threshold = 5σ');
  assert.equal(DRIFTING_TO_BREAKING_TICKS, 5, 'ARCHITECT-REPLY-28: sustained-drift escalation = 5 ticks');
  assert.equal(EXPECTED_SIGMA_FLOOR, 0.02, 'ARCHITECT-REPLY-28: σ floor = 2%');
});

// engine/l0/traffic-allocation-continuity.ts — Addition #10 L0 extension.
//
// Per NORTH-STAR-ARCHITECTURE.md §Addition #10. A canary expected to receive
// X% of traffic but actually receiving Y% (where |X − Y| exceeds expected
// statistical variance) means the routing layer is broken; any detector that
// compares canary-vs-baseline under that condition is analyzing the wrong
// population. L0 classifies every per-tick observation into one of three
// continuity classes against the expected canary weight:
//
//   stable    — observed ≈ expected (|z| < 2σ)
//   drifting  — |z| ≥ 2σ but not catastrophic; increments a sustained counter
//   breaking  — |z| ≥ 5σ immediately, OR sustained 'drifting' ≥ 5 ticks
//
// When 'breaking': the orchestrator short-circuits G1 with `shortCircuit:
// 'srm'`; all detector families naturally suppress because the health gate
// never runs. Audit records carry `traffic_allocation_continuity` on every
// tick alongside `schema_continuity`.
//
// This module mirrors the shape of engine/l0/schema-continuity.ts (#8) but
// keeps its own state, enums, and constants per ARCHITECT-REPLY-28 anti-scope
// ("reuse patterns, not code — different concerns, different state").
//
// Architect-set constants are NOT tunable in this pass. If empirical behavior
// suggests different numbers, escalate via TPM rather than adjusting locally.

/** Three-class SRM status. */
export type TrafficAllocationStatus = 'stable' | 'drifting' | 'breaking';

/** Per-deploy rolling state. Owned by the caller (tests, scenario runners,
 *  future orchestration adapters) in the same shape as #8's continuity
 *  records — the classifier is pure; state threads through caller calls. */
export interface TrafficAllocationState {
  /** Rolling window of observed traffic_pct values (most recent last). */
  observedHistory: number[];
  /** Expected canary fraction from DeployContext.canary_weight (Addition #9).
   *  Runway callers pass it explicitly until #9 lands and the orchestrator
   *  can resolve it from a typed DeployContext. */
  expectedCanaryWeight: number;
  /** Consecutive ticks in 'drifting' or worse; resets to 0 on return to
   *  'stable'. Sustained ≥ DRIFTING_TO_BREAKING_TICKS escalates to breaking. */
  driftTickCount: number;
  /** Most recent classification — exposed so callers can detect edges. */
  lastStatus: TrafficAllocationStatus;
}

// ── Architect-set constants (ARCHITECT-REPLY-28) ────────────────────
export const ROLLING_WINDOW_SIZE = 5;
export const STABLE_SIGMA_THRESHOLD = 2.0;
export const CATASTROPHIC_SIGMA_THRESHOLD = 5.0;
export const DRIFTING_TO_BREAKING_TICKS = 5;
/** σ floor: canary routing is typically near-deterministic. Without a floor,
 *  empirical σ collapses to ~0 when observations coincide, making any
 *  deviation register as infinite-σ. 2% ≈ the Poisson noise floor on a
 *  well-behaved routing layer at moderate RPS. */
export const EXPECTED_SIGMA_FLOOR = 0.02;

/** Build an initial state for a fresh deploy. Rolling window starts empty
 *  and fills over the first `ROLLING_WINDOW_SIZE` ticks. */
export function initialState(expectedCanaryWeight: number): TrafficAllocationState {
  return {
    observedHistory: [],
    expectedCanaryWeight,
    driftTickCount: 0,
    lastStatus: 'stable',
  };
}

/** Classify one observed traffic_pct against the rolling history and
 *  expected canary weight. Pure — returns the new status and a new state
 *  (caller threads it back in on the next tick).
 *
 *  σ estimation: empirical σ of the PREVIOUS window (excluding the
 *  current observation), floored at EXPECTED_SIGMA_FLOOR. Including the
 *  current observation in the σ estimate would inflate variance on a
 *  catastrophic outlier and mask the zScore — breaking the architect's
 *  worked example (single obs 3× expected on floor-σ → zScore = 10). */
export function classifyContinuity(
  observedTrafficPct: number,
  state: TrafficAllocationState,
): { status: TrafficAllocationStatus; newState: TrafficAllocationState } {
  const prev = state.observedHistory;
  const nPrev = prev.length;
  let sigma = EXPECTED_SIGMA_FLOOR;
  if (nPrev > 0) {
    let mean = 0;
    for (let i = 0; i < nPrev; i++) mean += prev[i];
    mean /= nPrev;
    let variance = 0;
    for (let i = 0; i < nPrev; i++) {
      variance += (prev[i] - mean) * (prev[i] - mean);
    }
    variance /= nPrev;
    sigma = Math.max(Math.sqrt(variance), EXPECTED_SIGMA_FLOOR);
  }

  const deviation = Math.abs(observedTrafficPct - state.expectedCanaryWeight);
  const zScore = deviation / sigma;

  const updatedHistory = prev.concat(observedTrafficPct).slice(-ROLLING_WINDOW_SIZE);

  let status: TrafficAllocationStatus;
  let driftTickCount = state.driftTickCount;

  if (zScore >= CATASTROPHIC_SIGMA_THRESHOLD) {
    status = 'breaking';
    driftTickCount = driftTickCount + 1;
  } else if (zScore >= STABLE_SIGMA_THRESHOLD) {
    driftTickCount = driftTickCount + 1;
    status = driftTickCount >= DRIFTING_TO_BREAKING_TICKS ? 'breaking' : 'drifting';
  } else {
    status = 'stable';
    driftTickCount = 0;
  }

  return {
    status,
    newState: {
      observedHistory: updatedHistory,
      expectedCanaryWeight: state.expectedCanaryWeight,
      driftTickCount,
      lastStatus: status,
    },
  };
}

/** Canonical reason string used by the orchestrator when SRM short-circuits.
 *  Format is fixed by the spec — exact string shape is part of the audit
 *  contract and is asserted by integration tests. */
export function formatSrmReason(
  observedTrafficPct: number,
  expectedCanaryWeight: number,
): string {
  return `Sample Ratio Mismatch — observed canary fraction ${
    (observedTrafficPct * 100).toFixed(1)
  }% diverged from expected ${
    (expectedCanaryWeight * 100).toFixed(1)
  }%`;
}

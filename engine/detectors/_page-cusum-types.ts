// engine/detectors/_page-cusum-types.ts — shared types and constants for
// the Page-CUSUM detector family. Split out of page-cusum.ts (god-file
// refactor) so the classical core, params lookup, and shadow evaluators
// can share these declarations without importing from the facade
// (avoids circular imports).

import type { BakeProfile } from '../types';

// Family A default bake profile (Addition #4 table). Used when the
// compiled config doesn't carry a profile for a signal — guards against
// partially-populated configs and legacy (W2) configs without the
// `bake_profiles` block.
export const DEFAULT_BAKE: BakeProfile = {
  min_ticks_before_eligible: 3,
  min_observation_window: 3,
  max_deploy_window_days: 1,
};

/** Per-(signal) CUSUM state. One scalar per signal per deploy; carries
 *  across cell boundaries. Initialized to 0. */
export interface CUSUMState {
  /** Current S_n. Non-negative by construction (max(0, ...)). */
  S: number;
  /** Samples observed for this signal so far this deploy. Not gating — the
   *  CUSUM has no minimum-n requirement — but useful for diagnostics and
   *  bake-profile comparisons. */
  n: number;
  /** Running sum of per-tick α contributions, for audit provenance. */
  alphaConsumed: number;
}

/** Per-deploy per-signal state store. Health gate reads/mutates through
 *  this map; caller (orchestrator / test harness) owns the lifetime. */
export type CUSUMStates = Record<string, CUSUMState>;

/** Per-tick CUSUM evaluation input. */
export interface CUSUMInput {
  signal: string;
  params: import('../types').MSPRTParams;
  state: CUSUMState;
  trafficPct: number;
  /** min_traffic_pct_for_fire from CompiledConfig.traffic_pct_gate. Absent
   *  → 0 (no gate). */
  trafficGate: number;
  ticksSinceDeploy: number;
  deployAgeDays: number;
}

/** Per-tick shadow-evaluator context, shared by the classical and
 *  mixture-supermartingale Page-CUSUM paths. */
export interface FamilyAShadowCtx {
  hourOfDay: number;
  dayOfWeek?: number;
  ticksSinceDeploy: number;
  deployAgeDays: number;
  trafficPct: number;
  schemaContinuityClass?: import('../types').SchemaContinuityRecord['schema_continuity'];
  /** Addition #13: signals in the operator's ignore band; this detector
   *  emits `reason_code: 'ignore_threshold'` for any matching signal
   *  BEFORE cell/bake-profile/traffic checks and skips the CUSUM
   *  update — an "ignored" signal is not an observation the comparative
   *  test should consume. */
  ignoredSignals?: Set<string>;
  /** Addition #23 — tenant_id for the current request(s). Resolved to
   *  `tenant_tier` via `cfg.tenant_tier_map` and threaded into cell
   *  lookup. Absent → `'aggregate'` tier (pre-#23 semantics). */
  tenantId?: string;
}

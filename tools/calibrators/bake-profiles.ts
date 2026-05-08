// tools/calibrators/bake-profiles.ts — End-phase slice 3 (D-54-3).
//
// Per-signal bake-profile defaults + buildBakeProfiles helper. Extracted
// from tools/calibrate.ts (Addition #4, NORTH-STAR-ARCHITECTURE.md
// §Additions, landed 2026-04-18). min_ticks_before_eligible /
// min_observation_window / max_deploy_window_days per signal.
// Architect-specified starting points; SRE policy overrides in
// production. Supersede the W2 values (2 ticks / 7 days).

import type { BakeProfile } from '../../engine/types';

/** Per-signal bake-profile defaults. Pure config — zero cross-family
 *  dependency. Consumed by:
 *    - calibrate.ts main() → writes to config.bake_profiles.
 *    - family-a.ts bake-profile lookup for detector gating. */
export const BAKE_PROFILE: Record<string, { min_ticks: number; min_obs: number; max_days: number }> = {
  p99_latency:       { min_ticks: 3, min_obs: 3, max_days: 1 },
  ttft:              { min_ticks: 3, min_obs: 3, max_days: 1 },
  downstream_err:    { min_ticks: 4, min_obs: 4, max_days: 1 },
  tool_success_rate: { min_ticks: 6, min_obs: 6, max_days: 2 },
  eval_score:        { min_ticks: 6, min_obs: 6, max_days: 3 },
  refusal_rate:      { min_ticks: 6, min_obs: 6, max_days: 3 },
  cost_req:          { min_ticks: 8, min_obs: 8, max_days: 7 },
  tokens_turn:       { min_ticks: 8, min_obs: 8, max_days: 3 },
  mfu:               { min_ticks: 4, min_obs: 4, max_days: 1 },
  hbm_spill:         { min_ticks: 4, min_obs: 4, max_days: 1 },
  kv_cache:          { min_ticks: 4, min_obs: 4, max_days: 1 },
  collective_ops:    { min_ticks: 4, min_obs: 4, max_days: 1 },
  corpus_delta:      { min_ticks: 4, min_obs: 4, max_days: 1 },
  // _default: applied for unlisted signals.
};

/** Resolve a signal's bake profile, falling back to the unlisted-signal
 *  default (3 ticks / 1 day). */
export function getBakeProfile(
  signal: string,
): { min_ticks: number; min_obs: number; max_days: number } {
  return BAKE_PROFILE[signal] ?? { min_ticks: 3, min_obs: 3, max_days: 1 };
}

/** W3 §3.1.c — top-level `bake_profiles` table per Addition #4. 13 signals
 *  covered + a `_default` fallback. `min_observation_window` comes from
 *  the table directly (architect's default is equal to
 *  `min_ticks_before_eligible` for most signals; compiler would derive
 *  from baseline autocorrelation in production — deferred). */
export function buildBakeProfiles(): Record<string, BakeProfile> {
  const out: Record<string, BakeProfile> = {};
  for (const signal of Object.keys(BAKE_PROFILE)) {
    const p = BAKE_PROFILE[signal];
    out[signal] = {
      min_ticks_before_eligible: p.min_ticks,
      min_observation_window: p.min_obs,
      max_deploy_window_days: p.max_days,
    };
  }
  out._default = {
    min_ticks_before_eligible: 3,
    min_observation_window: 3,
    max_deploy_window_days: 1,
  };
  return out;
}

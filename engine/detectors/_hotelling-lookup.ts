// engine/detectors/_hotelling-lookup.ts — Family C param/cell lookup +
// signal vector + bake-profile gate. Extracted VERBATIM from
// engine/detectors/hotelling.ts (god-file split). No behavior change.

import type {
  CompiledConfig, BaselineCellEntry, FamilyCPerCell, TenantTier,
} from '../types';

// Primary SLI vector for Family C — must agree with tools/calibrate.ts
// FAMILY_C_SIGNALS order. The covariance matrix's row/column indices are
// this list's positions.
export const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
] as const;

/** Retrieve the Family C params for the cell matching `cell`. Falls back
 *  to `aggregate_fallback.family_C` when the cell's confidence is
 *  aggregate/none. Returns null if Family C isn't compiled.
 *
 *  Addition #23 — `cell.tenant_tier` routes the lookup through the tiered
 *  matrix. Two-stage match: exact tier first, then `'aggregate'` tier,
 *  then `aggregate_fallback.family_C` as the last resort. Pre-#23 configs
 *  (no tenant_tier on cells) match any tier query. */
function matchFamilyCCell(
  bc: NonNullable<CompiledConfig['baseline_cells']>,
  cell: { hour_of_day: number; day_of_week?: number; tenant_tier?: TenantTier },
  tier: TenantTier | undefined,
): BaselineCellEntry | undefined {
  return bc.cells.find((c) => {
    if (c.key.hour_of_day !== cell.hour_of_day) return false;
    if (cell.day_of_week !== undefined && c.key.day_of_week !== undefined) {
      if (c.key.day_of_week !== cell.day_of_week) return false;
    }
    if (tier !== undefined && c.key.tenant_tier !== undefined) {
      if (c.key.tenant_tier !== tier) return false;
    }
    return true;
  });
}

export function lookupFamilyCParams(
  cfg: CompiledConfig,
  cell: { hour_of_day: number; day_of_week?: number; tenant_tier?: TenantTier },
): { params: FamilyCPerCell; source: BaselineCellEntry | 'aggregate' } | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  let match = matchFamilyCCell(bc, cell, cell.tenant_tier);
  if ((!match || !match.family_C) && cell.tenant_tier !== undefined && cell.tenant_tier !== 'aggregate') {
    match = matchFamilyCCell(bc, cell, 'aggregate');
  }
  if (match?.family_C) return { params: match.family_C, source: match };
  if (bc.aggregate_fallback.family_C) return { params: bc.aggregate_fallback.family_C, source: 'aggregate' };
  return null;
}

/** Lookup the per-signal Family A bake profile as the Family C proxy —
 *  architect spec §Addition #4: bake profile is signal-level, not
 *  cell-level, and applies to Families A/C/D/E. Family C uses the
 *  most-constrained profile across its signals (max of each field)
 *  so the joint test only fires when every component signal is ready.
 *
 *  W4 §4.1.h (ARCHITECT-REPLY-12 S2 landing): adds `min_obs` as the
 *  joint `min_observation_window` clause-2 bound. */
export function familyCBakeProfile(cfg: CompiledConfig): { min_ticks: number; min_obs: number; max_days: number } {
  const profiles = cfg.bake_profiles ?? {};
  let maxMinTicks = 0, maxMinObs = 0, maxMaxDays = Infinity;
  let any = false;
  // REPLY-51b v2 R4-1 — prefer config-provided signals (set when
  // compiled under a profile); fall back to hardcoded for legacy
  // configs. Same pattern at every runtime FAMILY_C_SIGNALS site.
  const signals = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
  for (const sig of signals) {
    const p = profiles[sig];
    if (!p) continue;
    any = true;
    if (p.min_ticks_before_eligible > maxMinTicks) maxMinTicks = p.min_ticks_before_eligible;
    if (p.min_observation_window > maxMinObs) maxMinObs = p.min_observation_window;
    if (p.max_deploy_window_days < maxMaxDays) maxMaxDays = p.max_deploy_window_days;
  }
  if (!any) return { min_ticks: 3, min_obs: 3, max_days: 1 };
  return {
    min_ticks: maxMinTicks,
    min_obs: maxMinObs,
    max_days: Number.isFinite(maxMaxDays) ? maxMaxDays : 1,
  };
}

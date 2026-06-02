// engine/detectors/_page-cusum-params.ts — cell matching and per-signal
// param resolution for the Page-CUSUM detector family. Split out of
// page-cusum.ts (god-file refactor). Logic is VERBATIM from the original.

import type {
  MSPRTParams, CompiledConfig, BaselineCell,
  BaselineCellEntry, FamilyAPerSignalParams, TenantTier,
} from '../types';
import { DEFAULT_BAKE } from './_page-cusum-types';

/** Primary SLIs covered by Week-2 Family A. Kept in one place so health.ts,
 *  the compiler, and the parity test agree on the set. */
export const FAMILY_A_PRIMARY_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

/** Match a cell by `hour_of_day` (and `day_of_week` when present). Returns
 *  the first cell whose key agrees on every dimension supplied in `query`.
 *  Extra dimensions on the stored cell are ignored; extra dimensions on
 *  the query are respected (strict subset match).
 *
 *  Addition #23 — `tenant_tier` on the query participates in the match when
 *  the stored cell also carries a `tenant_tier`. Two-stage match: first
 *  attempt the requested tier; if no cell carries it, fall back to
 *  `'aggregate'` tier (pre-#23 backward compat). Cells without a
 *  `tenant_tier` key compare equal to any query tier (pre-#23 config
 *  shape keeps working). */
export function matchCellByHour(
  cells: BaselineCellEntry[],
  query: BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier },
): BaselineCellEntry | undefined {
  const matchOne = (tier: TenantTier | undefined): BaselineCellEntry | undefined =>
    cells.find((c) => {
      if (c.key.hour_of_day !== query.hour_of_day) return false;
      if (query.day_of_week !== undefined && c.key.day_of_week !== undefined) {
        if (c.key.day_of_week !== query.day_of_week) return false;
      }
      if (tier !== undefined && c.key.tenant_tier !== undefined) {
        if (c.key.tenant_tier !== tier) return false;
      }
      return true;
    });
  const direct = matchOne(query.tenant_tier);
  if (direct) return direct;
  if (query.tenant_tier !== undefined && query.tenant_tier !== 'aggregate') {
    return matchOne('aggregate');
  }
  return undefined;
}

/** Build an `MSPRTParams` view-model from the unified `baseline_cells`
 *  entry + signal-level bake profile + per-family α. Returns null if the
 *  config has no Family A block for this cell/signal. When the cell's
 *  `confidence ∈ {aggregate, none}`, falls back to
 *  `baseline_cells.aggregate_fallback.family_A`. */
function buildMSPRTParams(
  cfg: CompiledConfig,
  cell: BaselineCellEntry,
  signal: string,
): MSPRTParams | null {
  let perSig: FamilyAPerSignalParams | undefined = cell.family_A?.per_signal[signal];
  let pooled = cell.confidence === 'pooled';
  const aggregateFallback = cell.confidence === 'aggregate' || cell.confidence === 'none';
  if (!perSig && aggregateFallback) {
    perSig = cfg.baseline_cells?.aggregate_fallback.family_A?.per_signal[signal];
    pooled = true;
  }
  if (!perSig) return null;

  const bake = cfg.bake_profiles?.[signal] ?? DEFAULT_BAKE;
  const alphaFamilyA = cfg.alpha_budget.per_family.A ?? 4e-4;
  const bonf = cfg.bonferroni_factor ?? 6;
  // Addition #17 (ARCHITECT-REPLY-34 D7) — Family A α-split when the
  // compiled config carries a betting-e-process co-ship allocation. Pre-
  // #17 configs (no `betting_e_process_alpha` field) keep the full
  // per-signal Bonferroni α for Page-CUSUM so demo fire timing calibrated
  // against that threshold stays intact. Post-#17 configs give Page-CUSUM
  // whatever is left of the per-signal budget after the betting half.
  const perSigBudget = alphaFamilyA / bonf;
  const alpha = perSig.betting_e_process_alpha !== undefined
    ? Math.max(perSigBudget - perSig.betting_e_process_alpha, perSigBudget * 0.5)
    : perSigBudget;

  return {
    signal,
    tau_squared: perSig.tau_squared,
    delta_min: perSig.delta_min,
    min_samples: 0,  // CUSUM is perpetual; field retained for schema stability
    min_ticks_before_eligible: bake.min_ticks_before_eligible,
    min_observation_window: bake.min_observation_window,
    max_deploy_window_days: bake.max_deploy_window_days,
    alpha,
    derivation: {
      tau_multiplier: 0,  // Week-2 legacy; retained for audit provenance
      empirical_variance: perSig.baseline_sigma_squared,
      // Q2.B.5 — propagate raw-space σ² for Page-CUSUM consumption.
      // Optional in MSPRTParams.derivation for backward compatibility.
      empirical_variance_raw: perSig.baseline_sigma_squared_raw,
      mean: perSig.baseline_mean,
      // Q2.A — propagate raw-space μ for Page-CUSUM consumption (Q2.B.5).
      mean_raw: perSig.baseline_mean_raw,
      std: Math.sqrt(perSig.baseline_sigma_squared),
      pooled,
      n_samples: cell.n_samples,
    },
  };
}

/** Retrieve the per-signal `MSPRTParams` for the cell matching `cell`.
 *  Navigates the Week-3 `baseline_cells` schema; returns null if Family A
 *  isn't compiled or the signal is absent.
 *
 *  Addition #23 — `cell.tenant_tier` routes the lookup through the tiered
 *  cell matrix. On miss, falls back to `'aggregate'` tier (handled by
 *  `matchCellByHour` internally). */
export function lookupCellParams(
  cfg: CompiledConfig,
  cell: BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier },
  signal: string,
): MSPRTParams | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  const match = matchCellByHour(bc.cells, cell);
  if (!match) return null;
  return buildMSPRTParams(cfg, match, signal);
}

/** `traffic_pct_gate.min_traffic_pct_for_fire` or 0 if gate not compiled. */
export function trafficGateMin(cfg: CompiledConfig): number {
  return cfg.traffic_pct_gate?.min_traffic_pct_for_fire ?? 0;
}

/** Resolve `FamilyAPerSignalParams` for the mixture-supermartingale path.
 *  Mirrors `lookupCellParams` cell-matching but returns the raw per-signal
 *  shape (mixture_supermartingale_params + ar1_phi + baseline_*_raw) rather
 *  than the classical-CUSUM `MSPRTParams` view-model. */
export function lookupFamilyAPerSignal(
  cfg: CompiledConfig,
  cell: BaselineCell & { day_of_week?: number; tenant_tier?: TenantTier },
  signal: string,
): FamilyAPerSignalParams | null {
  const bc = cfg.baseline_cells;
  if (!bc) return null;
  const match = matchCellByHour(bc.cells, cell);
  if (!match) return null;
  let perSig: FamilyAPerSignalParams | undefined = match.family_A?.per_signal[signal];
  const aggregateFallback = match.confidence === 'aggregate' || match.confidence === 'none';
  if (!perSig && aggregateFallback) {
    perSig = bc.aggregate_fallback.family_A?.per_signal[signal];
  }
  return perSig ?? null;
}

// engine/types/_config-tenant.ts — tenant-tier configuration + runtime
// resolution. Split out of the engine/types/config.ts god-file; re-exported
// verbatim from there to preserve the facade export surface.

// ── North-Star runway types ──────────────────────────────────────
// Week-1 NS foundations. No runtime consumers yet this week — the compiler
// (tools/calibrate.ts) emits CompiledConfig, the generator (tools/gen-synthetic-
// baseline.ts) emits BaselineBundle, and the compiler-equivalence gate
// (test/compiler-equivalence.test.js) wires both in. Detectors still read the
// medium TrendBuffer view during Week 1; multi-scale detector rewiring lands
// in later weeks.

/** Addition #23 — coarse tenant-traffic tier bucket used as a cell-matrix
 *  dimension. Assigned at compile time from per-tenant traffic fraction
 *  over the baseline window (defaults: ≥0.50 'dominant', ≥0.10 'large',
 *  ≥0.01 'medium', <0.01 'small'). `'aggregate'` is the backward-compat
 *  tier emitted on pre-#23 (no-tenant-id) bundles so existing cell
 *  lookups continue to match. `string` escape allows operator-custom
 *  tier labels via `CompilerOptions.tenant_tier_config.manual_overrides`. */
export type TenantTier =
  | 'dominant'
  | 'large'
  | 'medium'
  | 'small'
  | 'aggregate'
  | string;

/** Addition #23 — compiler-time tenant-tier configuration. Boundaries are
 *  traffic-fraction cutoffs (each tier label ≥ its cutoff); defaults are
 *  D1 architect values. `manual_overrides` is an escape hatch for
 *  platforms with known-VIP tenants that should be treated as 'large'
 *  even at low traffic fraction. */
export interface TenantTierConfig {
  boundaries: {
    dominant: number;
    large: number;
    medium: number;
  };
  manual_overrides?: Record<string, TenantTier>;
}

/** Addition #23 — resolve a request's tenant_id to a tenant_tier using
 *  the compiled config's `tenant_tier_map`. Returns `'aggregate'` when
 *  no tenant_id is supplied, when the map is absent (pre-#23 configs),
 *  or when the tenant is unknown to the map — matches runtime fallback
 *  semantics in the detector cell-lookup path. */
export function resolveTenantTier(
  cfg: { tenant_tier_map?: Record<string, TenantTier> } | null | undefined,
  tenantId: string | undefined | null,
): TenantTier {
  if (!tenantId || !cfg?.tenant_tier_map) return 'aggregate';
  return cfg.tenant_tier_map[tenantId] ?? 'aggregate';
}

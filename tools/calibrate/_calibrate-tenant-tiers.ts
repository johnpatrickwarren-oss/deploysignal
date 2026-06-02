// tools/calibrate/_calibrate-tenant-tiers.ts — Addition #23 tenant-tier
// bucketing. Extracted VERBATIM from the pre-split tools/calibrate.ts
// god-file (D-54-3 god-file decomposition). No behavior change.

import type {
  BaselineBundle, TenantTier, TenantTierConfig,
} from '../../engine/types';
import { DEFAULT_TENANT_TIER_CONFIG } from './_calibrate-constants.js';

/** Assign a tier to a single traffic fraction per D1 boundaries. */
export function assignTier(fraction: number, boundaries: TenantTierConfig['boundaries']): TenantTier {
  if (fraction >= boundaries.dominant) return 'dominant';
  if (fraction >= boundaries.large)    return 'large';
  if (fraction >= boundaries.medium)   return 'medium';
  return 'small';
}

/** Build the tenant_tier_map by computing per-tenant traffic fraction
 *  over the baseline bundle. When no run carries `tenant_id`, returns
 *  `null` — the emitted CompiledConfig omits `tenant_tier_map` and every
 *  sample routes to the 'aggregate' tier (pre-#23 shape). */
export function buildTenantTierMap(
  bundle: BaselineBundle,
  cfg: TenantTierConfig = DEFAULT_TENANT_TIER_CONFIG,
): Record<string, TenantTier> | null {
  const tenantSampleCounts: Record<string, number> = {};
  let totalSamples = 0;
  let anyTenantIdPresent = false;
  for (const run of bundle.runs) {
    if (run.tenant_id === undefined) continue;
    anyTenantIdPresent = true;
    const n = firstSignalLength(run);
    tenantSampleCounts[run.tenant_id] = (tenantSampleCounts[run.tenant_id] ?? 0) + n;
    totalSamples += n;
  }
  if (!anyTenantIdPresent || totalSamples === 0) return null;
  const map: Record<string, TenantTier> = {};
  const overrides = cfg.manual_overrides ?? {};
  for (const tenantId of Object.keys(tenantSampleCounts)) {
    if (overrides[tenantId]) { map[tenantId] = overrides[tenantId]; continue; }
    const fraction = tenantSampleCounts[tenantId] / totalSamples;
    map[tenantId] = assignTier(fraction, cfg.boundaries);
  }
  return map;
}

function firstSignalLength(run: BaselineBundle['runs'][number]): number {
  for (const k of Object.keys(run.signal_series)) {
    const arr = run.signal_series[k];
    if (arr) return arr.length;
  }
  return 0;
}

/** Stable SHA-like short hash for `tenant_tier_config`. Audit provenance:
 *  lets operators verify the boundaries+overrides didn't change silently.
 *  Uses the same mulberry-derived LCG as the per-cell seeds so the hash
 *  is deterministic across environments without a crypto dependency. */
export function hashTenantTierConfig(cfg: TenantTierConfig): string {
  const canonical = JSON.stringify({
    boundaries: {
      dominant: cfg.boundaries.dominant,
      large: cfg.boundaries.large,
      medium: cfg.boundaries.medium,
    },
    manual_overrides: cfg.manual_overrides
      ? Object.keys(cfg.manual_overrides).sort().reduce<Record<string, TenantTier>>((acc, k) => {
          acc[k] = cfg.manual_overrides![k]; return acc;
        }, {})
      : null,
  });
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

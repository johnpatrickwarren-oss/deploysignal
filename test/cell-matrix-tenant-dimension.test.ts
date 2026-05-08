// test/cell-matrix-tenant-dimension.test.ts — Addition #23 D3+D4+D5
// coverage on the runtime cell-lookup paths.
//
// Per ARCHITECT-REPLY-39:
//   D3 — sparse-tier covariance falls back to 'aggregate_fallback' (new
//        FamilyCPerCell.covariance_method enum value) when pooled n < MCD
//        floor (max(5p, 200)).
//   D4 — runtime lookup by (hour, day, tenant_tier); falls back to
//        'aggregate' tier on miss.
//   D5 — pre-#23 configs (no tenant_tier on cell keys) match runtime
//        lookups regardless of the query's tenant_tier (backward compat).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, FamilyCPerCell, TenantTier } from '../engine/types';
import { resolveTenantTier, conformalSampleCount } from '../engine/types';
import { lookupCellParams } from '../engine/detectors/page-cusum';
import { lookupFamilyCParams } from '../engine/detectors/hotelling';
import { lookupFamilyEParams } from '../engine/detectors/conformal';

const FAM_C: FamilyCPerCell = {
  mean_vector: [185, 220, 418, 0.89, 0.0042, 0.0012, 0.72, 0.02, 0.9997, 0.04, 1.0],
  covariance: Array.from({ length: 11 }, (_, i) => Array.from({ length: 11 }, (_, j) => (i === j ? 1.0 : 0))),
  covariance_method: 'ledoit_wolf',
  covariance_shrinkage: 0.5,
  outlier_detection: null,
  mmd_params: null,
};

function makeCfg(opts: {
  tenantTierMap?: Record<string, TenantTier>;
  cells: Array<{ hour: number; day: number; tier?: TenantTier; covMethod?: FamilyCPerCell['covariance_method'] }>;
}): CompiledConfig {
  const cells = opts.cells.map((c) => {
    const key: Record<string, string | number> = { hour_of_day: c.hour, day_of_week: c.day };
    if (c.tier !== undefined) key.tenant_tier = c.tier;
    return {
      key,
      n_samples: 250,
      confidence: 'strict' as const,
      family_A: {
        per_signal: {
          eval_score: { baseline_mean: 0.85, baseline_sigma_squared: 0.0002, tau_squared: 0.000452, delta_min: 0.0425 },
        },
      },
      family_C: { ...FAM_C, covariance_method: c.covMethod ?? 'ledoit_wolf' },
    };
  });
  return {
    version: 'test', compiler_version: '0.2.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 0, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: { eval_score: { min_ticks_before_eligible: 6, min_observation_window: 6, max_deploy_window_days: 3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: opts.tenantTierMap ? ['hour_of_day', 'day_of_week', 'tenant_tier'] : ['hour_of_day', 'day_of_week'],
      cells,
      aggregate_fallback: {
        family_A: { per_signal: { eval_score: { baseline_mean: 0.85, baseline_sigma_squared: 0.001, tau_squared: 0.0005, delta_min: 0.0425 } } },
        family_C: FAM_C,
        family_E: { calibration_scores: new Array(20000).fill(0).map((_, i) => i / 20000 + 1) },
      },
    },
    ...(opts.tenantTierMap ? { tenant_tier_map: opts.tenantTierMap, tenant_tier_config: { boundaries: { dominant: 0.5, large: 0.1, medium: 0.01 } } } : {}),
  };
}

test('resolveTenantTier: returns aggregate when no map, no tenant_id, or unknown tenant', () => {
  assert.equal(resolveTenantTier(undefined, 'X'), 'aggregate');
  assert.equal(resolveTenantTier({}, 'X'), 'aggregate');
  assert.equal(resolveTenantTier({ tenant_tier_map: { Y: 'large' } }, 'X'), 'aggregate');
  assert.equal(resolveTenantTier({ tenant_tier_map: { X: 'dominant' } }, undefined), 'aggregate');
  assert.equal(resolveTenantTier({ tenant_tier_map: { X: 'dominant' } }, 'X'), 'dominant');
});

test('D5 pre-#23 config (no tenant_tier on cells): runtime lookup matches any tier', () => {
  const cfg = makeCfg({ cells: [{ hour: 14, day: 2 }] });
  const params = lookupCellParams(cfg, { hour_of_day: 14, day_of_week: 2, tenant_tier: 'large' }, 'eval_score');
  assert.ok(params, 'pre-#23 cell should match large-tier query (key has no tenant_tier dim)');
  assert.equal(params!.derivation!.mean, 0.85);
});

test('D4 post-#23 config: requested tier matches its own per-tier cell', () => {
  const cfg = makeCfg({
    tenantTierMap: { A: 'dominant', B: 'large' },
    cells: [
      { hour: 14, day: 2, tier: 'aggregate' },
      { hour: 14, day: 2, tier: 'large' },
      { hour: 14, day: 2, tier: 'dominant' },
    ],
  });
  const fcLarge = lookupFamilyCParams(cfg, { hour_of_day: 14, day_of_week: 2, tenant_tier: 'large' });
  assert.ok(fcLarge);
  assert.equal(fcLarge!.source, (cfg.baseline_cells!.cells.find((c) => c.key.tenant_tier === 'large'))!);
});

test('D4 post-#23 config: tier missing from matrix → falls back to aggregate-tier cell', () => {
  const cfg = makeCfg({
    tenantTierMap: { A: 'dominant' },
    cells: [
      { hour: 14, day: 2, tier: 'aggregate' },
      { hour: 14, day: 2, tier: 'dominant' },
    ],
  });
  const params = lookupCellParams(cfg, { hour_of_day: 14, day_of_week: 2, tenant_tier: 'small' }, 'eval_score');
  assert.ok(params, 'small-tier query with no small-tier cell should fall back');
});

test('D4 Family E: per-cell μ/Σ via tenant tier; calibration always aggregate', () => {
  const cfg = makeCfg({
    tenantTierMap: { B: 'large' },
    cells: [
      { hour: 14, day: 2, tier: 'aggregate' },
      { hour: 14, day: 2, tier: 'large' },
    ],
  });
  const fe = lookupFamilyEParams(cfg, { hour_of_day: 14, day_of_week: 2, tenant_tier: 'large' });
  assert.ok(fe, 'Family E should resolve under tenant_tier large');
  // Calibration scores: always from aggregate_fallback (per architect REPLY-16 Q2 + REPLY-39 inheritance).
  assert.equal(conformalSampleCount(fe!.params), 20000);
});

test('D3 covariance_method enum accepts aggregate_fallback', () => {
  const cfg = makeCfg({
    tenantTierMap: { B: 'large' },
    cells: [
      { hour: 14, day: 2, tier: 'aggregate' },
      { hour: 14, day: 2, tier: 'large', covMethod: 'aggregate_fallback' },
    ],
  });
  const fc = lookupFamilyCParams(cfg, { hour_of_day: 14, day_of_week: 2, tenant_tier: 'large' });
  assert.ok(fc);
  assert.equal(fc!.params.covariance_method, 'aggregate_fallback');
});

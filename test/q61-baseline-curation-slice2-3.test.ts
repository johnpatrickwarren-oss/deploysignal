// test/q61-baseline-curation-slice2-3.test.ts — R2 Task 4 (SLICE 2:
// D5 sparse-cell fallback, D6 multi-tenant tier aggregation, D7 ar1_phi
// calibration) + R2 Task 5 (SLICE 3: D8 substrate-specific adjustment,
// D9 cross-substrate consistency, D10 honest provenance stamping).
//
// Fixture bundle+config reuses the fixture-builder style of
// test/q61-baseline-curation-pipeline.test.ts, extended with the
// cell/aggregate-fallback shapes SLICE 2/3 inspect: multiple confidence
// tiers, tenant_tier keys, family_D ar1_phi, tenant_tier_map/config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runBaselineCurationPipeline,
} from '../tools/curate-baseline-pipeline.js';
import { hashTenantTierConfig } from '../tools/calibrate.js';
import type {
  BaselineBundle,
  CompiledConfig,
} from '../engine/types/config.js';

function makeFixtureBundle(): BaselineBundle {
  return {
    version: 'fixture-v1',
    generated_at: '2026-05-03T00:00:00Z',
    seed: 42,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [{
      tenant_id: 'aggregate',
      hour_of_day: [0, 1, 2],
      day_of_week: [0, 0, 0],
      signal_series: {
        p99_latency: [1.0, 1.1, 1.2],
        ttft: [0.5, 0.55, 0.6],
        cost_req: [0.001, 0.0011, 0.0012],
      },
    }],
  };
}

const TENANT_TIER_CONFIG = { boundaries: { dominant: 0.5, large: 0.1, medium: 0.01 } };

function makeFixtureCompiledConfig(): CompiledConfig {
  return {
    version: 'fixture-v1',
    compiler_version: '0.2.0',
    compiled_at: '2026-05-03T00:00:00Z',
    baseline_ref: 'fixture-v1',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4, D: 1e-4, E: 1e-4 } },
    signal_classes: {
      p99_latency: 'gaussian_like',
      ttft: 'gaussian_like',
      cost_req: 'gaussian_like',
    },
    tenant_tier_map: { tenant1: 'dominant', tenant2: 'small' },
    tenant_tier_config: TENANT_TIER_CONFIG,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week', 'tenant_tier'],
      cells: [
        {
          // D5: strict confidence, no pooling/inflation.
          key: { hour_of_day: 0, day_of_week: 0, tenant_tier: 'dominant' },
          n_samples: 720,
          confidence: 'strict',
          family_A: {
            per_signal: {
              p99_latency: {
                baseline_mean: 1.0, baseline_sigma_squared: 0.01,
                tau_squared: 0.005, delta_min: 0.1, signal_class: 'gaussian_like',
                ar1_phi: 0.3, betting_calibration_scope: 'sliding_buffer_ar1',
              },
              cost_req: {
                baseline_mean: 0.001, baseline_sigma_squared: 0.000001,
                tau_squared: 5e-7, delta_min: 0.0001, signal_class: 'gaussian_like',
                ar1_phi: 0.95, betting_calibration_scope: 'single_window',
              },
            },
          },
          family_D: {
            p99_latency: {
              bootstrap_null_quantile: 2.5, min_peak_lag: 3, max_peak_lag: 10,
              ar1_phi: -0.97,
            },
          },
        },
        {
          // D5: pooled + variance_inflated.
          key: { hour_of_day: 1, day_of_week: 0, tenant_tier: 'small' },
          n_samples: 40,
          confidence: 'pooled',
          pooled_from: [{ hour_of_day: 0, day_of_week: 0 }],
          variance_inflated: true,
          family_A: {
            per_signal: {
              p99_latency: {
                baseline_mean: 1.0, baseline_sigma_squared: 0.02,
                tau_squared: 0.01, delta_min: 0.1, signal_class: 'gaussian_like',
                ar1_phi: 0.5, betting_calibration_scope: 'sliding_buffer_ar1',
              },
            },
          },
        },
        {
          // D5: aggregate confidence.
          key: { hour_of_day: 2, day_of_week: 0, tenant_tier: 'aggregate' },
          n_samples: 0,
          confidence: 'aggregate',
        },
        {
          // D5: none confidence.
          key: { hour_of_day: 3, day_of_week: 0, tenant_tier: 'aggregate' },
          n_samples: 0,
          confidence: 'none',
        },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 1.0, baseline_sigma_squared: 0.01,
              tau_squared: 0.005, delta_min: 0.1, signal_class: 'gaussian_like',
              ar1_phi: 0.1, betting_calibration_scope: 'single_window',
            },
          },
        },
        family_D: {
          p99_latency: {
            bootstrap_null_quantile: 2.5, min_peak_lag: 3, max_peak_lag: 10,
            ar1_phi: 0.2,
          },
        },
      },
    },
  } as unknown as CompiledConfig;
}

// ── SLICE 2 (R2 Task 4): D5, D6, D7 ────────────────────────────────

test('Q61 SLICE 2: runBaselineCurationPipeline executes D1-D7 with SLICE_1+SLICE_2', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1', 'SLICE_2'],
    verifyDecisions: true,
  });
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'] as const) {
    assert.ok(state.decisions[id], `${id} emitted`);
  }
  assert.equal(state.decisions.D8, undefined, 'D8 not emitted (SLICE 3 deferred)');
});

test('Q61 SLICE 2: D5 sparse-cell fallback output_summary — confidence-tier counts + variance_inflated + aggregate_fallback_present', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_2'],
  });
  assert.deepEqual(state.decisions.D5!.output_summary, {
    n_cells_strict: 1,
    n_cells_pooled: 1,
    n_cells_aggregate: 1,
    n_cells_none: 1,
    n_cells_variance_inflated: 1,
    aggregate_fallback_present: true,
  });
  assert.deepEqual(state.decisions.D5!.inputs.upstream_decisions, ['D1', 'D2']);
  assert.equal(state.decisions.D5!.verification.diagnostic_path,
    'CompiledConfig.baseline_curation_pipeline_diagnostics.D5');
});

test('Q61 SLICE 2: D6 multi-tenant tier aggregation output_summary — tenant_tier_map + distinct cell tiers + config hash', () => {
  const config = makeFixtureCompiledConfig();
  const state = runBaselineCurationPipeline(makeFixtureBundle(), config, {
    slices: ['SLICE_2'],
  });
  assert.equal(state.decisions.D6!.output_summary.multi_tenant, true);
  assert.equal(state.decisions.D6!.output_summary.n_tenants_mapped, 2);
  assert.equal(state.decisions.D6!.output_summary.n_tiers_in_cells, 3); // dominant, small, aggregate
  assert.equal(state.decisions.D6!.output_summary.tenant_tier_config_hash,
    hashTenantTierConfig(TENANT_TIER_CONFIG));
});

test('Q61 SLICE 2: D6 — no tenant_tier_map/config -> multi_tenant false, hash "unset"', () => {
  const config = makeFixtureCompiledConfig();
  delete config.tenant_tier_map;
  delete config.tenant_tier_config;
  const state = runBaselineCurationPipeline(makeFixtureBundle(), config, {
    slices: ['SLICE_2'],
  });
  assert.equal(state.decisions.D6!.output_summary.multi_tenant, false);
  assert.equal(state.decisions.D6!.output_summary.n_tenants_mapped, 0);
  assert.equal(state.decisions.D6!.output_summary.tenant_tier_config_hash, 'unset');
});

test('Q61 SLICE 2: D7 ar1_phi calibration output_summary — hand-computed across family_A + family_D, cells + aggregate_fallback', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_2'],
  });
  // phi values: cellA {0.3, 0.95, -0.97}, cellB {0.5}, agg {0.1, 0.2} => n=6
  assert.equal(state.decisions.D7!.output_summary.n_signal_entries_with_phi, 6);
  assert.equal(state.decisions.D7!.output_summary.phi_abs_max, 0.97);
  const mean = state.decisions.D7!.output_summary.phi_mean as number;
  assert.ok(Math.abs(mean - (0.3 + 0.95 - 0.97 + 0.5 + 0.1 + 0.2) / 6) < 1e-12);
  assert.equal(state.decisions.D7!.output_summary.n_phi_at_clip_bound, 2); // 0.95, -0.97
  assert.equal(state.decisions.D7!.output_summary.n_sliding_buffer_ar1_scope, 2); // cellA.p99, cellB.p99
  assert.deepEqual(state.decisions.D7!.inputs.upstream_decisions, ['D1', 'D2']);
});

test('Q61 SLICE 2: D7 — no baseline_cells at all -> zeroed output_summary, no throw', () => {
  const config = makeFixtureCompiledConfig();
  delete config.baseline_cells;
  const state = runBaselineCurationPipeline(makeFixtureBundle(), config, {
    slices: ['SLICE_2'],
    verifyDecisions: true,
  });
  assert.equal(state.decisions.D7!.output_summary.n_signal_entries_with_phi, 0);
  assert.equal(state.decisions.D7!.output_summary.phi_mean, 0);
});

test('Q61 SLICE 2: byte-identical regression — SLICE 2 does NOT mutate input CompiledConfig or BaselineBundle', () => {
  const config = makeFixtureCompiledConfig();
  const bundle = makeFixtureBundle();
  const beforeConfig = JSON.stringify(config);
  const beforeBundle = JSON.stringify(bundle);
  runBaselineCurationPipeline(bundle, config, { slices: ['SLICE_1', 'SLICE_2'] });
  assert.equal(JSON.stringify(config), beforeConfig, 'pipeline must not mutate input config');
  assert.equal(JSON.stringify(bundle), beforeBundle, 'pipeline must not mutate input bundle');
});

test('Q61 SLICE 2: verifyDecisions=true passes for D5-D7 audit emission', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_2'],
    verifyDecisions: true,
  });
  for (const id of ['D5', 'D6', 'D7'] as const) {
    assert.equal(state.decisions[id]!.verification.audit_emitted, true);
    assert.ok(state.decisions[id]!.source_memorialization.length > 0);
  }
});

test('Q61 SLICE 2: SLICE_3 still throws when requested standalone (deferred to R2 Task 5)', () => {
  assert.throws(
    () => runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), { slices: ['SLICE_3'] }),
    /SLICE_3.*not yet implemented/,
  );
});

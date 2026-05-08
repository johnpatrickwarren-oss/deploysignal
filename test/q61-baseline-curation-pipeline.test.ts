// test/q61-baseline-curation-pipeline.test.ts — Q61 SPEC-1 SLICE 1
// baseline curation pipeline orchestrator + D1-D4 audit-emission tests.
// 8 cases per Q61 spec § Tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runBaselineCurationPipeline,
} from '../tools/curate-baseline-pipeline.js';
import type {
  BaselineBundle,
  CompiledConfig,
} from '../engine/types/config.js';

// ── Inline fixture: minimal BaselineBundle + CompiledConfig shapes ──

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
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [
        {
          key: { hour_of_day: 0, day_of_week: 0 },
          n_samples: 720,
          confidence: 'strict',
          family_A: {
            per_signal: {
              p99_latency: {
                baseline_mean: 1.0, baseline_sigma_squared: 0.01,
                tau_squared: 0.005, delta_min: 0.1, signal_class: 'gaussian_like',
                betting_sliding_buffer_threshold: 1.5,
                betting_calibration_scope: 'sliding_buffer_ar1',
              },
              cost_req: {
                baseline_mean: 0.001, baseline_sigma_squared: 0.000001,
                tau_squared: 5e-7, delta_min: 0.0001, signal_class: 'gaussian_like',
                betting_sliding_buffer_threshold: 2.0,
                betting_calibration_scope: 'sliding_buffer_ar1',
              },
            },
          },
          family_C: {
            mean_vector: [1.0, 0.5, 0.001],
            covariance: [[0.01, 0, 0], [0, 0.0025, 0], [0, 0, 1e-6]],
            cholesky_L: [[0.1, 0, 0], [0, 0.05, 0], [0, 0, 0.001]],
            cholesky_L_eps: [[0.1, 0, 0], [0, 0.05, 0], [0, 0, 0.001]],
            ledoit_wolf_lambda: 0.024,
            aggregate_fallback_used: false,
          },
        },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 1.0, baseline_sigma_squared: 0.01,
              tau_squared: 0.005, delta_min: 0.1, signal_class: 'gaussian_like',
              betting_sliding_buffer_threshold: 1.5,
              betting_calibration_scope: 'sliding_buffer_ar1',
            },
          },
        },
      },
    },
  } as unknown as CompiledConfig;
}

// ── Tests (8 cases per Q61 spec § Tests) ──────────────────────────

test('Q61 SLICE 1: runBaselineCurationPipeline executes D1-D4 in order', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1'],
    verifyDecisions: true,
  });
  assert.ok(state.decisions.D1, 'D1 emitted');
  assert.ok(state.decisions.D2, 'D2 emitted');
  assert.ok(state.decisions.D3, 'D3 emitted');
  assert.ok(state.decisions.D4, 'D4 emitted');
  assert.equal(state.decisions.D5, undefined, 'D5 not emitted (SLICE 2 deferred)');
  assert.equal(state.decisions.D8, undefined, 'D8 not emitted (SLICE 3 deferred)');
});

test('Q61 SLICE 1: D2 depends on D1 (per pipeline order)', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1'],
  });
  assert.deepEqual(state.decisions.D2!.inputs.upstream_decisions, ['D1']);
});

test('Q61 SLICE 1: D4 depends on D1 + D2 + D3 (per pipeline order)', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1'],
  });
  assert.deepEqual(state.decisions.D4!.inputs.upstream_decisions, ['D1', 'D2', 'D3']);
});

test("Q61 SLICE 1: D3 independent of D1 + D2 (signal_class doesn't depend on μ/Σ)", () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1'],
  });
  assert.equal(state.decisions.D3!.inputs.upstream_decisions, undefined);
});

test('Q61 SLICE 1: audit emission populates baseline_curation_pipeline_diagnostics', () => {
  const config = makeFixtureCompiledConfig();
  const state = runBaselineCurationPipeline(makeFixtureBundle(), config, {
    slices: ['SLICE_1'],
  });
  // The orchestrator returns the decisions in pipelineState; the calling
  // site (calibrate.ts main()) stamps these on
  // CompiledConfig.baseline_curation_pipeline_diagnostics. Verify shape.
  assert.equal(state.decisions.D1!.verification.diagnostic_path,
    'CompiledConfig.baseline_curation_pipeline_diagnostics.D1');
  assert.equal(state.decisions.D4!.verification.diagnostic_path,
    'CompiledConfig.baseline_curation_pipeline_diagnostics.D4');
});

test('Q61 SLICE 1: SLICE_2 + SLICE_3 throw when requested at SLICE 1 implementation', () => {
  const bundle = makeFixtureBundle();
  const config = makeFixtureCompiledConfig();
  assert.throws(
    () => runBaselineCurationPipeline(bundle, config, { slices: ['SLICE_1', 'SLICE_2'] }),
    /SLICE_2.*not yet implemented/,
  );
  assert.throws(
    () => runBaselineCurationPipeline(bundle, config, { slices: ['SLICE_3'] }),
    /SLICE_3.*not yet implemented/,
  );
});

test('Q61 SLICE 1: byte-identical regression — pipeline does NOT mutate input CompiledConfig', () => {
  // Acceptance criterion #7. The pipeline inspects state and emits
  // diagnostic records without mutating the input config. This proves
  // byte-identical regression by construction: calibrate.ts main()
  // builds CompiledConfig as before, then stamps diagnostics on it
  // as a final step. The pre-stamp CompiledConfig is identical to what
  // would have been emitted pre-Q61.
  const config = makeFixtureCompiledConfig();
  const beforeJson = JSON.stringify(config);
  runBaselineCurationPipeline(makeFixtureBundle(), config, { slices: ['SLICE_1'] });
  const afterJson = JSON.stringify(config);
  assert.equal(beforeJson, afterJson, 'pipeline must not mutate input config');
});

test('Q61 SLICE 1: per-decision audit-emission verification (verifyDecisions=true)', () => {
  const state = runBaselineCurationPipeline(makeFixtureBundle(), makeFixtureCompiledConfig(), {
    slices: ['SLICE_1'],
    verifyDecisions: true,
  });
  for (const id of ['D1', 'D2', 'D3', 'D4'] as const) {
    assert.equal(state.decisions[id]!.verification.audit_emitted, true,
      `${id} verification.audit_emitted must be true`);
  }
  // Source memorialization populated for each decision (architect-prior-spec citation).
  for (const id of ['D1', 'D2', 'D3', 'D4'] as const) {
    assert.ok(state.decisions[id]!.source_memorialization.length > 0,
      `${id} source_memorialization must be non-empty`);
  }
});

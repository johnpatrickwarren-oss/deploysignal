// test/family-c-alpha-split.test.ts — Addition #18 D8 acceptance.
//
// Long-run α bookkeeping for Family C under the 50/50 split: Hotelling
// T² and Sequential MMD each consume half of `alpha_budget.per_family.C`.
// Neither detector alone may exceed its allocation on a healthy deploy;
// the family-level total stays ≤ per_family.C.
//
// Uses a minimal handcrafted CompiledConfig instead of a full compiled
// bundle so the test runs in well under a second. The calibration path
// is exercised separately by mcd/mrcd tests; this test's job is to
// verify the runtime α-budget invariant across both detectors.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CompiledConfig, OrchestrateParams, Metrics, FamilyCPerCell,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

/** Compact CompiledConfig with Family A and Family C (both detectors
 *  enabled via mmd_params). Single cell at hour=20, day=3; aggregate
 *  fallback carries both too. */
function makeConfig(): CompiledConfig {
  const mean_vector = [
    185,       // p99_latency
    220,       // ttft
    418,       // tokens_turn
    0.89,      // kv_cache
    0.0042,    // cost_req
    0.12,      // downstream_err
    0.72,      // mfu
    0.02,      // hbm_spill
    0.9997,    // collective_ops
    0.04,      // corpus_delta
    1.0,       // traffic_pct
  ];
  const p = mean_vector.length;
  // Identity-ish covariance; dimensions are dimensionless relative-
  // deviation units so the scale doesn't matter. Keeps Hotelling
  // threshold in a reasonable regime.
  const covariance: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 0.01 : 0)),
  );
  const famC: FamilyCPerCell = {
    mean_vector,
    covariance,
    covariance_method: 'ledoit_wolf',
    covariance_shrinkage: 0.1,
    outlier_detection: null,
    // MMD params: deliberately wide bandwidth + astronomical
    // null_quantile so a healthy deploy can't fire the MMD detector.
    // The α-split invariant (Hotelling α + MMD α ≤ per_family.C) is
    // still pinned because the detector still runs and emits a
    // verdict (clean); fire-rate calibration against the null is
    // exercised by test/sequential-mmd.test.ts instead.
    mmd_params: {
      kernel: 'gaussian_rbf',
      bandwidth: 5.0,
      window_size: 5,
      baseline_baseline_sum: 500 * 499,  // kernel ≈ 1 on nearby pairs at wide bandwidth
      null_quantile: 1e6,                 // unreachable under healthy traffic
      null_quantile_bootstraps: 2000,
      alpha: 1e-4,                        // half of per_family.C = 2e-4
    },
    // Q72 SLICE 2 Phase 3.B re-baseline post-RFF architectural-fix:
    // Q67 §Q67.4-ter v1 biased streaming-witness retired; v2 RFF
    // unbiased-by-linearity is the canonical Family C MMD detector
    // post-Q68 sequential-mmd retirement. The α-split semantic
    // becomes: per_family.C = 2e-4 split as Hotelling 1e-4 +
    // canonical betting-e-process 1e-4 (single canonical Family C
    // MMD detector; e-MMD Option-B retired alongside sequential-mmd
    // at Q68 cleanup; Q67 §Q67.4-ter v1 biased streaming-witness
    // retired at Q72 SLICE 2). RFF fields omitted (baseline_rff_mean
    // absent) so detector falls back to legacy biased streaming for
    // backward-compat replay; healthy-deploy verdicts stay clean
    // over 40 ticks regardless of witness-construction variant.
    betting_e_process_params: {
      kernel_bandwidth_sigma: 5.0,
      lambda_max: 0.5,
      betting_strategy: 'ons',
      ons_initial_lambda: 0,
      alpha: 1e-4,                        // half of per_family.C = 2e-4
      baseline_sample_size: 500,
    },
  };
  return {
    version: 'alpha-split-test',
    compiler_version: '0.1.0',
    compiled_at: new Date().toISOString(),
    baseline_ref: 'handcrafted',
    alpha_budget: {
      total: 1e-3,
      per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 0, E: 0 },
    },
    bonferroni_factor: 6,
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [
        { key: { hour_of_day: 20, day_of_week: 3 }, n_samples: 600, confidence: 'strict', family_C: famC },
      ],
      aggregate_fallback: { family_C: famC },
    },
    bake_profiles: {
      p99_latency:  { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      ttft:         { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      tokens_turn:  { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      kv_cache:     { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      cost_req:     { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      downstream_err: { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      mfu:          { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      hbm_spill:    { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      collective_ops: { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      corpus_delta: { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
      traffic_pct:  { min_ticks_before_eligible: 3, min_observation_window: 3, max_deploy_window_days: 1 },
    },
  };
}

test('family-c-alpha-split: healthy deploy — both detectors present, total α_spent ≤ per_family.C', (t) => {
  const cfg = makeConfig();
  const familyCBudget = cfg.alpha_budget.per_family.C;

  const baseline: Metrics = {
    p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
    cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
    collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
    eval_score: 0.92, tool_success_rate: 0.95,
  };
  const scenario: OrchestrateParams['scenario'] = {
    id: 'alpha-split-test',
    riskLevel: 'critical', bakeHours: 6, author: 'human',
    changeType: 'model_weights', timeWindow: 'ok',
    flags: { security: false, zeta: true, approval: true },
    baseline,
  };

  const tb = new TrendBuffer(10);
  let sawHotelling = false;
  let sawMMD = false;
  let totalAlpha = 0;
  const ticks = 40;
  for (let i = 0; i < ticks; i++) {
    for (const k of Object.keys(baseline)) tb.push(k, baseline[k]);
    const result = orchestrate({
      liveMetrics: baseline, scenario,
      hoursElapsed: i * 0.1,
      trendBuffer: tb, tick: i, totalTicks: ticks,
      compiledConfig: cfg,
      currentHourOfDay: 20,
      currentDayOfWeek: 3,
      ticksSinceDeploy: i + 50,  // past bake profile
      deployAgeDays: 0,
      fusionTopology: 'portfolio',
    });
    const hr = result.healthResult;
    if (hr?.family_C_verdict) sawHotelling = true;
    if (hr?.family_C_mmd_verdict) sawMMD = true;
    const aH = hr?.family_C_verdict?.alpha_spent ?? 0;
    const aM = hr?.family_C_mmd_verdict?.alpha_spent ?? 0;
    totalAlpha += aH + aM;
    assert.ok(
      aH + aM <= familyCBudget + 1e-12,
      `tick ${i}: Hotelling α + MMD α = ${aH + aM} must stay ≤ per_family.C = ${familyCBudget}`,
    );
  }
  assert.ok(sawHotelling, 'Hotelling T² must produce verdicts over the run');
  assert.ok(sawMMD, 'Sequential MMD must produce verdicts over the run');
  assert.equal(totalAlpha, 0, 'healthy deploy must spend 0 α across both detectors');
  t.diagnostic(`per_family.C budget = ${familyCBudget}; total α_spent = ${totalAlpha}`);
});

test('family-c-alpha-split: Hotelling α halved when mmd_params present', () => {
  // Sanity check the D8 rule: when `mmd_params` is populated on the
  // cell, Hotelling's α threshold uses half of per_family.C. When
  // `mmd_params` is absent (pre-#18 config), Hotelling uses the full
  // budget for backward-compat.
  const cfg = makeConfig();
  const baseline: Metrics = {
    p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
    cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
    collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
    eval_score: 0.92, tool_success_rate: 0.95,
  };
  const tb = new TrendBuffer(10);
  for (const k of Object.keys(baseline)) tb.push(k, baseline[k]);
  const params: OrchestrateParams = {
    liveMetrics: baseline,
    scenario: {
      id: 'hot-alpha-test',
      riskLevel: 'critical', bakeHours: 6, author: 'human',
      changeType: 'model_weights', timeWindow: 'ok',
      flags: { security: false, zeta: true, approval: true },
      baseline,
    },
    hoursElapsed: 0, trendBuffer: tb, tick: 10, totalTicks: 40,
    compiledConfig: cfg,
    currentHourOfDay: 20, currentDayOfWeek: 3,
    ticksSinceDeploy: 100, deployAgeDays: 0,
    fusionTopology: 'portfolio',
  };
  const r1 = orchestrate(params);
  const thrWithMmd = r1.healthResult?.family_C_verdict?.threshold ?? 0;
  // Now strip mmd_params and re-run.
  const cfg2 = JSON.parse(JSON.stringify(cfg));
  cfg2.baseline_cells.cells[0].family_C.mmd_params = null;
  cfg2.baseline_cells.aggregate_fallback.family_C.mmd_params = null;
  const r2 = orchestrate({ ...params, compiledConfig: cfg2, trendBuffer: new TrendBuffer(10) });
  const thrWithoutMmd = r2.healthResult?.family_C_verdict?.threshold ?? 0;
  // Hotelling threshold under half budget > threshold under full budget
  // (smaller α → larger quantile). Invariant the test pins.
  assert.ok(
    thrWithMmd > thrWithoutMmd,
    `Hotelling threshold should increase under half-budget; got thrWithMmd=${thrWithMmd} thrWithoutMmd=${thrWithoutMmd}`,
  );
});

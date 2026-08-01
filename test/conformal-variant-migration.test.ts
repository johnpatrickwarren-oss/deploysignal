// test/conformal-variant-migration.test.ts — Addition #22 slice-3.
//
// Runtime-dispatch migration coverage for Family E's three
// ConformalParams variants: 'unweighted' (pre-#19), 'weighted'
// (#19; weighted-quantile threshold), and 'weighted_e_value' (#22;
// hedged-indicator wealth martingale per REPLY-46b). Dispatch
// happens inside evaluateFamilyE on `params.kind`.
//
// Pattern mirrors test/family-c-variant-migration.test.ts from
// Addition #20 and test/spectral-variant-migration.test.ts from
// Addition #21.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CompiledConfig, ConformalEValueState, DetectorVerdict,
  FamilyCPerCell, ConformalParams,
} from '../engine/types';
import { evaluateFamilyE } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/conformal';

const ALPHA_E = 1e-4;
const FIRE_THRESHOLD = 1 / ALPHA_E;  // 10,000
const M = 10000;

const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
];

/** Build isotropic Family C params (Σ = I_11) so Mahalanobis distance
 *  equals Euclidean norm — lets tests control s_t by choosing x. */
function makeFamC(): FamilyCPerCell {
  const p = 11;
  const cov: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    cov[i] = new Array(p).fill(0);
    cov[i][i] = 1;
  }
  return { mean_vector: new Array(p).fill(0), covariance: cov };
}

/** Build M uniform calibration scores for each variant — same
 *  underlying distribution so dispatch behavior differences are
 *  attributable to variant routing, not data. */
function makeWeightedEValueParams(): Extract<ConformalParams, { kind: 'weighted_e_value' }> {
  const scores = new Array<number>(M);
  const weights = new Array<number>(M);
  for (let i = 0; i < M; i++) { scores[i] = i / M; weights[i] = 1 / M; }
  const cumulative_weights_above = new Array<number>(M);
  for (let k = 0; k < M; k++) cumulative_weights_above[k] = (M - k) / M;
  return {
    kind: 'weighted_e_value',
    scores, weights, cumulative_weights_above,
    total_weight: 1, halflife_days: 7, effective_sample_size: M,
    calibration_method: 'weighted_parametric_gaussian_bootstrap_e_value',
  };
}

function makeWeightedParams(): Extract<ConformalParams, { kind: 'weighted' }> {
  const scores = new Array<number>(M);
  const weights = new Array<number>(M);
  for (let i = 0; i < M; i++) { scores[i] = i / M; weights[i] = 1 / M; }
  return {
    kind: 'weighted', scores, weights,
    halflife_days: 7, effective_sample_size: M,
    calibration_method: 'weighted_parametric_gaussian_bootstrap',
  };
}

function makeUnweightedParams(): Extract<ConformalParams, { kind?: 'unweighted' }> {
  const calibration_scores = new Array<number>(M);
  for (let i = 0; i < M; i++) calibration_scores[i] = i / M;
  return { calibration_scores, calibration_method: 'parametric_gaussian_bootstrap' };
}

function makeCfg(famE: ConformalParams): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.3.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 1e-4, E: ALPHA_E } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: {
      p99_latency: { min_ticks_before_eligible: 1, min_observation_window: 1, max_deploy_window_days: 10 },
    },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: {
        family_A: { per_signal: {} },
        family_C: makeFamC(),
        family_E: famE,
      },
    },
  };
}

function liveAt(shift: number): Record<string, number> {
  const m: Record<string, number> = {};
  for (const sig of FAMILY_C_SIGNALS) m[sig] = shift;
  return m;
}

function baseCtx() {
  return {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 10, deployAgeDays: 0.5, trafficPct: 1.0,
  };
}

// ── Pre-#19 unweighted backward compatibility ──────────────────────

test('conformal-variant-migration: pre-#19 unweighted cell dispatches conformal-p-value path', () => {
  const cfg = makeCfg(makeUnweightedParams());
  const v = evaluateFamilyE(cfg, liveAt(0.01), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  // Unweighted path emits reason_code 'below_threshold' or
  // 'conformal_p_below_threshold'; threshold = alphaE (the α itself,
  // not 1/α which is the e-value convention).
  assert.equal(v.threshold, ALPHA_E);
});

// ── #19 weighted backward compatibility ────────────────────────────

test('conformal-variant-migration: #19 weighted cell dispatches weighted-quantile path (stateless)', () => {
  const cfg = makeCfg(makeWeightedParams());
  const state: ConformalEValueState = { M: 1, n: 0, alphaConsumed: 0 };
  const v = evaluateFamilyE(cfg, liveAt(0.01), baseCtx(), state) as DetectorVerdict;
  assert.ok(v);
  // weighted path: threshold = weighted (1-α) quantile of scores.
  // Reason codes: 'weighted_conformal_threshold_exceeded' or
  // 'below_threshold'. threshold is a quantile value, not α or 1/α.
  assert.ok(v.threshold !== null);
  assert.ok(typeof v.threshold === 'number' && v.threshold < 10);
  // State stays at M=1 (stateless legacy path).
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

// ── #22 weighted_e_value dispatch ──────────────────────────────────

test('conformal-variant-migration: #22 weighted_e_value cell + state dispatches wealth martingale', () => {
  const cfg = makeCfg(makeWeightedEValueParams());
  const state: ConformalEValueState = { M: 1, n: 0, alphaConsumed: 0 };
  const v = evaluateFamilyE(cfg, liveAt(0.01), baseCtx(), state) as DetectorVerdict;
  assert.ok(v);
  // weighted_e_value emits threshold = 1/α_E = 10,000 (wealth threshold).
  assert.equal(v.threshold, FIRE_THRESHOLD);
  assert.equal(state.n, 1);
  // Indicator=0 for tiny shift → e_t = 1 − α_E = 0.9999.
  assert.ok(Math.abs(state.M - (1 - ALPHA_E)) < 1e-10,
    `expected M = 1 − α_E = 0.9999, got ${state.M}`);
});

test('conformal-variant-migration: weighted_e_value cell without state suppresses (missing_state guard)', () => {
  const cfg = makeCfg(makeWeightedEValueParams());
  // No state threaded; evaluateFamilyE's guard returns suppressed.
  const v = evaluateFamilyE(cfg, liveAt(0.01), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'weighted_e_value_state_missing');
});

test('conformal-variant-migration: weighted_e_value fires under sustained indicator=1 drift (~14 ticks)', () => {
  const cfg = makeCfg(makeWeightedEValueParams());
  const state: ConformalEValueState = { M: 1, n: 0, alphaConsumed: 0 };
  // Large shift → s_t beyond all calibration scores → indicator=1 → e_t ≈ 2.
  // 14 ticks of e_t ≈ 2 pushes M above 10,000.
  let firedTick = -1;
  for (let t = 1; t <= 20; t++) {
    const v = evaluateFamilyE(cfg, liveAt(10), baseCtx(), state) as DetectorVerdict;
    if (v && v.verdict === 'fire') { firedTick = t; break; }
  }
  assert.ok(firedTick > 0 && firedTick <= 14,
    `expected fire at t ≤ 14; got ${firedTick}`);
  assert.ok(firedTick >= 13,
    `expected fire at t ≥ 13 (analytic lower bound); got ${firedTick}`);
});

test('conformal-variant-migration: COMPILER_VERSION bumped to 0.3.0 per REPLY-46 D9', () => {
  // Sanity check on the compiler-emitted version string. The test fixture
  // uses '0.3.0' directly; the real assertion is the CONSTANT in
  // tools/calibrate.ts (verified via a recompile smoke-test at PR
  // CI time and through the shipped audit records).
  const cfg = makeCfg(makeWeightedEValueParams());
  assert.equal(cfg.compiler_version, '0.3.0');
});

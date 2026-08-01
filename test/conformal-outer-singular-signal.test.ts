// test/conformal-outer-singular-signal.test.ts — regression coverage for
// the "unreachable inner covariance_singular tag" finding (2026-07-17).
//
// evaluateFamilyE (engine/detectors/conformal.ts) is the SOLE production
// entry point for Family E. It computes the Mahalanobis distance itself
// first, and returns its own `covariance_singular` suppressed verdict
// (no `signal` field, `threshold: alphaE`) BEFORE ever dispatching into
// CONFORMAL_EVALUATORS — so the per-variant evaluators' own
// `covariance_singular` branches (e.g. `evaluateConformalWeightedEValue`'s,
// which DOES carry `signal: 'weighted_conformal_e_value'`) never run in
// production. Prior to this fix, a live covariance-singular event on a
// `weighted_e_value`-kind cell was misclassified 'linear' by
// `engine/verdict.ts`'s `progressScaleFor` magnitude fallback (threshold
// = alphaE, always far below the 50-magnitude floor) — wrong for a
// wealth-martingale detector.
//
// The fix tags evaluateFamilyE's OUTER covariance_singular branch with
// `signal: 'weighted_conformal_e_value'` when (and only when) the
// resolved Family E params are the `weighted_e_value` kind; the
// classical `unweighted`/`weighted` kinds get no signal tag (matching
// their fire/clean siblings elsewhere in this file, which also never
// set `.signal`).
//
// This test drives `evaluateFamilyE` directly (not the inner evaluator)
// with a singular Family C covariance, for both kinds, and checks the
// resulting `progress_scale` classification via
// `engine/verdict.ts`'s `_progressScaleForTest` (exported for exactly
// this purpose — see its doc comment for why a `fuseVerdict`
// `evidence_outlook` round-trip can't observe this: a null-`statistic`
// verdict never contributes a non-null `progress`, and
// `pickScaleAndProgress` only reports `progress_scale` alongside a
// non-null `progress`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, ConformalParams, FamilyCPerCell } from '../dist/engine/types';
import { evaluateFamilyE } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/conformal';
import { _progressScaleForTest } from '../dist/engine/verdict';

const ALPHA_E = 1e-4;
const M = 10000;  // ≥ 1/α_E so the underpowered guard doesn't preempt.

const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
];

/** Singular (all-zero) Family C covariance — `cholesky` returns null on
 *  the first diagonal entry, so `mahalanobisDistance` returns null and
 *  `evaluateFamilyE`'s outer `s === null` branch fires. */
function makeSingularFamC(): FamilyCPerCell {
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  return { mean_vector: new Array(p).fill(0), covariance: cov };
}

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

function makeUnweightedParams(): Extract<ConformalParams, { kind?: 'unweighted' }> {
  const calibration_scores = new Array<number>(M);
  for (let i = 0; i < M; i++) calibration_scores[i] = i / M;
  return { calibration_scores, calibration_method: 'parametric_gaussian_bootstrap' };
}

function makeCfg(famE: ConformalParams, famC: FamilyCPerCell): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.3.0', compiled_at: '0', baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 1e-4, E: ALPHA_E } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: { family_C: famC, family_E: famE },
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

// ── (a) weighted_e_value kind ───────────────────────────────────────

test('evaluateFamilyE: covariance_singular on a weighted_e_value cell tags signal + classifies wealth', () => {
  const famC = makeSingularFamC();
  const cfg = makeCfg(makeWeightedEValueParams(), famC);
  const state = { M: 1, n: 0, alphaConsumed: 0 };
  const v = evaluateFamilyE(cfg, liveAt(1), baseCtx(), state)!;
  assert.ok(v, 'expected a verdict, not null');
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'covariance_singular');
  assert.equal(v.family, 'E');
  assert.equal(v.signal, 'weighted_conformal_e_value',
    'weighted_e_value kind must carry the wealth signal tag on the outer (reachable) branch');
  assert.equal(_progressScaleForTest(v), 'wealth',
    'a weighted_e_value covariance_singular verdict must classify wealth, not linear, ' +
    'post-#51 progressScaleFor');
});

// ── (b) unweighted kind ─────────────────────────────────────────────

test('evaluateFamilyE: covariance_singular on an unweighted cell carries no wealth signal tag', () => {
  const famC = makeSingularFamC();
  const cfg = makeCfg(makeUnweightedParams(), famC);
  const v = evaluateFamilyE(cfg, liveAt(1), baseCtx())!;
  assert.ok(v, 'expected a verdict, not null');
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'covariance_singular');
  assert.equal(v.family, 'E');
  assert.equal(v.signal, undefined,
    'classical unweighted kind must NOT borrow the weighted_e_value wealth signal tag');
  // No wealth-marking signal or reason_code, and threshold = alphaE
  // (1e-4) sits far below the magnitude-fallback floor (50) — correctly
  // classifies 'linear' via the fallback, same as this kind's fire/clean
  // siblings (which also carry no signal tag).
  assert.equal(_progressScaleForTest(v), 'linear');
});

test('evaluateFamilyE: covariance_singular on a weighted (non-e-value) cell also carries no wealth signal tag', () => {
  const M2 = 10000;
  const scores = new Array<number>(M2);
  const weights = new Array<number>(M2);
  for (let i = 0; i < M2; i++) { scores[i] = i / M2; weights[i] = 1 / M2; }
  const weightedParams: Extract<ConformalParams, { kind: 'weighted' }> = {
    kind: 'weighted', scores, weights,
    halflife_days: 7, effective_sample_size: M2,
    calibration_method: 'weighted_parametric_gaussian_bootstrap',
  };
  const famC = makeSingularFamC();
  const cfg = makeCfg(weightedParams, famC);
  const v = evaluateFamilyE(cfg, liveAt(1), baseCtx())!;
  assert.ok(v, 'expected a verdict, not null');
  assert.equal(v.verdict, 'suppressed');
  assert.equal(v.reason_code, 'covariance_singular');
  assert.equal(v.signal, undefined,
    'classical weighted (quantile) kind must NOT borrow the weighted_e_value wealth signal tag');
  assert.equal(_progressScaleForTest(v), 'linear');
});

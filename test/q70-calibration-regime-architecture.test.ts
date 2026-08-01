// test/q70-calibration-regime-architecture.test.ts —
// Q70 Phase-3.d.E SLICE 1 — cross-detector calibration regime architecture.
//
// SLICE 1 scope (this file):
//   - Q70.1 dispatch-table integrity: per-detector predicates registered;
//     unknown detectors fall through to no-exemption; family_A_page_cusum
//     compound predicate behavior preserved exactly (regression vs Q66
//     .A.c.γ.c).
//   - Q70.2 §7 EmpiricalProcessLILBound closed-form runtime math.
//   - Q70.2 §6 BetaBinomialMixture hyperparameter validation; SLICE 1
//     evaluation stub raises not-implemented.
//   - Schema additions are accessible from each family per-cell /
//     per-signal type.
//
// SLICE 2 scope (deferred follow-on):
//   - Substantive per-detector predicate logic (family_A_betting +
//     family_C_safe_test + family_E_conformal + family_D_kv_cache).
//   - §7 LIL C calibration constant bisection-and-solve.
//   - §6 BetaBinomial find_mixture_bound runtime bisection.
//   - Per-cell calibrator stamping; detector consumption; sweep validation.
//
// Test count this slice: ~12 cases (subset of spec § Tests ~25 cases).
// Spec full-scope tests land alongside SLICE 2 substantive logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  isSweepModeCalibrationRegimeMatched,
  type SweepMode,
} from '../tools/run-shadow-compare';
import type { Q60DetectorFamily } from '../engine/types';
import {
  evaluateLilBound,
  evaluateBetaBinomialBound,
  evaluateSelfNormalizedBound,
  assertLilBoundHyperparams,
  assertBetaBinomialHyperparams,
  assertSelfNormalizedHyperparams,
  LIL_A_DEFAULT,
  LIL_T_MIN_DEFAULT,
  BETA_BINOMIAL_ALPHA_OPT_DEFAULT,
} from '../engine/detectors/self-normalized-e-process-fallback';
import type {
  LilBoundHyperparams,
  BetaBinomialMixtureHyperparams,
  SelfNormalizedEProcessFallback,
} from '@johnpatrickwarren-oss/deploysignal-engine/types/self-normalized-fallback';

// ── Helpers (mirrored from Q66 test file) ──────────────────────────

interface CellCfg {
  hour_of_day: number;
  family_A_per_signal: Record<string, {
    signal_class?: string;
    ar1_phi?: number;
  }>;
}

function writeTempCompiledConfig(label: string, cells: CellCfg[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `q70-slice1-${label}-`));
  const cfgPath = path.join(dir, 'config.json');
  const cfg = {
    version: '0.1-test',
    compiler_version: '0.1-test',
    compiled_at: '2026-05-07T00:00:00Z',
    baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 1e-3 } },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: cells.map((c) => ({
        key: { hour_of_day: c.hour_of_day },
        n_samples: 100,
        confidence: 'strict',
        family_A: { per_signal: Object.fromEntries(
          Object.entries(c.family_A_per_signal).map(([sig, params]) => [sig, {
            baseline_mean: 100, baseline_mean_raw: 100,
            baseline_sigma_squared: 25, baseline_sigma_squared_raw: 25,
            tau_squared: 6.25, delta_min: 5,
            ...params,
          }]),
        ) },
      })),
      aggregate_fallback: { family_A: { per_signal: {} } },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return cfgPath;
}

function makeSubstrateRef(name: string, configPath: string) {
  return {
    name,
    baselineDir: '/tmp/test-baseline-stub',
    compiledConfig: configPath,
  };
}

// ── Q70.1 dispatch-table integrity ──────────────────────────────────

test('Q70.1 #1: dispatch table covers all 10 Q60 detector families', () => {
  // Sanity: every Q60DetectorFamily literal returns a well-formed result.
  const cfg = writeTempCompiledConfig('dispatch', [
    { hour_of_day: 0, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.6 },
    } },
  ]);
  const sub = makeSubstrateRef('any', cfg);
  const allDetectors: Q60DetectorFamily[] = [
    'family_A_betting', 'family_A_page_cusum',
    'family_C_safe_test', 'family_C_chi_square',
    'family_D_spectral', 'family_D_kv_cache',
    'family_E_conformal',
    'mmd_betting', 'mmd_bootstrap_null',
    'family_B_pattern_match',
  ];
  for (const det of allDetectors) {
    for (const mode of ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as SweepMode[]) {
      const r = isSweepModeCalibrationRegimeMatched(sub, mode, det);
      assert.equal(typeof r.matched, 'boolean',
        `${det} × ${mode} must return matched: boolean`);
      if (!r.matched) {
        assert.equal(typeof r.reason, 'string',
          `${det} × ${mode} unmatched must include reason text`);
      }
    }
  }
});

test('Q70.1 #2: SLICE 1 stub predicates (family_A_betting / family_C_safe_test / family_E_conformal / family_D_kv_cache) return matched=true', () => {
  // SLICE 1 intent: stubs preserve no-exemption behavior; substantive
  // predicate logic lands at SLICE 2 with empirical-sweep validation.
  const cfg = writeTempCompiledConfig('stubs', [
    { hour_of_day: 0, family_A_per_signal: {
      p99_latency: { signal_class: 'heavy_tail', ar1_phi: 0.001 },
    } },
  ]);
  const sub = makeSubstrateRef('synthetic_v1', cfg);
  const stubDetectors: Q60DetectorFamily[] = [
    'family_A_betting', 'family_C_safe_test',
    'family_E_conformal', 'family_D_kv_cache',
  ];
  for (const det of stubDetectors) {
    for (const mode of ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as SweepMode[]) {
      const r = isSweepModeCalibrationRegimeMatched(sub, mode, det);
      assert.equal(r.matched, true,
        `SLICE 1 stub: ${det} × ${mode} must return matched=true (substantive logic deferred to SLICE 2)`);
      assert.equal(r.reason, undefined,
        `SLICE 1 stub: ${det} × ${mode} reason must be absent`);
    }
  }
});

test('Q70.1 #3: family_A_page_cusum compound predicate preserved (regression vs Q66 .A.c.γ.c)', () => {
  // Real_hf shape: heavy_tail without gaussian_like ballast → exempt
  // uniformly across all 3 sweep modes per Q66 .A.c.γ.c compound predicate.
  const cfg = writeTempCompiledConfig('hf-shape', [
    { hour_of_day: 0, family_A_per_signal: {
      p99_latency: { signal_class: 'heavy_tail', ar1_phi: 0.05 },
      eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.05 },
    } },
  ]);
  const sub = makeSubstrateRef('real_hf', cfg);
  for (const mode of ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as SweepMode[]) {
    const r = isSweepModeCalibrationRegimeMatched(sub, mode, 'family_A_page_cusum');
    assert.equal(r.matched, false,
      `Q66 .A.c.γ.c compound predicate: real_hf shape must exempt family_A_page_cusum on ${mode}`);
    assert.match(r.reason ?? '', /heavy_tail without gaussian_like ballast/,
      `Q66 .A.c.γ.c reason text preserved on ${mode}`);
  }
});

test('Q70.1 #4: family_A_page_cusum parametric_ar1 phi-distribution check preserved', () => {
  // Synthetic-v1-shaped: gaussian_like ballast PASSES compound predicate;
  // falls through to parametric_ar1 phi-distribution Layer 1 check;
  // sampling-noise phi → exempt.
  const cells = Array.from({ length: 50 }, (_, i) => ({
    hour_of_day: i,
    family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: (i % 2 ? 0.0008 : -0.0008) },
      eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.001 },
    },
  }));
  const cfg = writeTempCompiledConfig('synthetic-v1-iid', cells);
  const sub = makeSubstrateRef('synthetic_v1', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, false,
    'parametric_ar1 + iid baseline (sampling-noise phi) must exempt family_A_page_cusum');
  assert.match(r.reason ?? '', /lacks AR\(1\) structure/);
});

test('Q70.1 #5: non-stub detectors (family_C_chi_square / family_D_spectral / mmd_betting / mmd_bootstrap_null / family_B_pattern_match) never exempted at SLICE 1', () => {
  // These detectors have NO active predicate (Q67 SLICE 1 PASS preserved
  // for mmd_betting; structural for family_B_pattern_match; out-of-Phase-D-
  // scope for the rest). Defaults to no-exemption.
  const cfg = writeTempCompiledConfig('non-stub', [
    { hour_of_day: 0, family_A_per_signal: {
      p99_latency: { signal_class: 'heavy_tail', ar1_phi: 0.001 },
    } },
  ]);
  const sub = makeSubstrateRef('any', cfg);
  const noPredicateDetectors: Q60DetectorFamily[] = [
    'family_C_chi_square', 'family_D_spectral',
    'mmd_betting', 'mmd_bootstrap_null', 'family_B_pattern_match',
  ];
  for (const det of noPredicateDetectors) {
    for (const mode of ['iid_bootstrap', 'parametric_gaussian', 'parametric_ar1'] as SweepMode[]) {
      const r = isSweepModeCalibrationRegimeMatched(sub, mode, det);
      assert.equal(r.matched, true,
        `${det} × ${mode} must default to matched=true (no active predicate)`);
    }
  }
});

// ── Q70.2 §7 EmpiricalProcessLILBound closed-form ──────────────────

test('Q70.2 #6: §7 LIL closed-form matches paper formula at canonical defaults', () => {
  // Library reference impl operator():
  //   bound(t) = A * sqrt( (log(1 + log(t / t_min)) + C) / t )
  // Verify the closed-form evaluation matches at A=0.85, t_min=1, C=2.0
  // (architect-default placeholder; production C from library bisection).
  const p: LilBoundHyperparams = {
    variant: 'lil_bound',
    alpha: 1e-4,
    t_min: LIL_T_MIN_DEFAULT,
    A: LIL_A_DEFAULT,
    C: 2.0,
  };
  const t = 100;
  const expected = LIL_A_DEFAULT * Math.sqrt((Math.log(1 + Math.log(t / 1)) + 2.0) / t);
  const actual = evaluateLilBound(p, t);
  assert.equal(actual, expected,
    'LIL closed-form must match library operator() formula exactly at canonical defaults');
  // Bound should decrease as t increases (LIL property).
  assert.ok(evaluateLilBound(p, 1000) < evaluateLilBound(p, 100),
    'LIL bound must decrease with t');
});

test('Q70.2 #7: §7 LIL hyperparameter validation per library asserts', () => {
  // alpha must be in (0, 1).
  assert.throws(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 0, t_min: 1, A: 0.85, C: 2.0,
  }), /alpha must be in/);
  assert.throws(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 1.5, t_min: 1, A: 0.85, C: 2.0,
  }), /alpha must be in/);
  // t_min >= 1.
  assert.throws(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 1e-4, t_min: 0.5, A: 0.85, C: 2.0,
  }), /t_min must be >= 1/);
  // A > 1/sqrt(2) ≈ 0.7071.
  assert.throws(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 1e-4, t_min: 1, A: 0.7, C: 2.0,
  }), /A must be > 1\/sqrt\(2\)/);
  // C must be finite.
  assert.throws(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 1e-4, t_min: 1, A: 0.85, C: NaN,
  }), /C must be finite/);
  // Valid hyperparams pass.
  assert.doesNotThrow(() => assertLilBoundHyperparams({
    variant: 'lil_bound', alpha: 1e-4, t_min: 1, A: LIL_A_DEFAULT, C: 2.0,
  }));
});

test('Q70.2 #8: §7 LIL evaluation rejects t < t_min', () => {
  const p: LilBoundHyperparams = {
    variant: 'lil_bound', alpha: 1e-4, t_min: 10, A: LIL_A_DEFAULT, C: 2.0,
  };
  assert.throws(() => evaluateLilBound(p, 5), /t .* must be >= t_min/);
  // At t = t_min, log(t/t_min) = 0, so logTerm = log(1) = 0.
  assert.equal(evaluateLilBound(p, 10), LIL_A_DEFAULT * Math.sqrt(2.0 / 10));
});

test('Q70.2 #9: §7 LIL canonical A=0.85 default exposed', () => {
  assert.equal(LIL_A_DEFAULT, 0.85,
    'Library canonical A=0.85 default per Q70.4 ASK A architect-pick');
  assert.equal(LIL_T_MIN_DEFAULT, 1, 'Library canonical t_min=1 default');
  assert.ok(LIL_A_DEFAULT > 1 / Math.SQRT2,
    'Canonical A must satisfy A > 1/sqrt(2) for LIL bound validity');
});

// ── Q70.2 §6 BetaBinomialMixture (SLICE 1 stub + validation) ───────

test('Q70.2 #10: §6 BetaBinomial hyperparameter validation enforces architect-picks', () => {
  // alpha_opt default exposed.
  assert.equal(BETA_BINOMIAL_ALPHA_OPT_DEFAULT, 0.05,
    'Library canonical alpha_opt=0.05 default per Q70.4 ASK A');
  // v_opt > 0.
  assert.throws(() => assertBetaBinomialHyperparams({
    variant: 'beta_binomial_mixture', alpha: 1e-4, v_opt: 0,
    alpha_opt: 0.05, g: 0.5, h: 0.5, is_one_sided: true,
  }), /v_opt must be > 0/);
  // Asymmetric p-locked g/h must be positive (Q70.4 ASK B).
  assert.throws(() => assertBetaBinomialHyperparams({
    variant: 'beta_binomial_mixture', alpha: 1e-4, v_opt: 100,
    alpha_opt: 0.05, g: 0, h: 0.5, is_one_sided: true,
  }), /g\/h must be positive/);
  // Valid hyperparams pass.
  assert.doesNotThrow(() => assertBetaBinomialHyperparams({
    variant: 'beta_binomial_mixture', alpha: 1e-4, v_opt: 100,
    alpha_opt: BETA_BINOMIAL_ALPHA_OPT_DEFAULT,
    g: 0.7, h: 0.3, is_one_sided: true,
  }));
});

test('Q70.2 #11: §6 BetaBinomial evaluation throws not-implemented at SLICE 1', () => {
  // SLICE 1 stub per spec LS-2 (Mac-Claude-implementation-time-gap-hunting):
  // library find_mixture_bound bisection helpers deferred.
  const p: BetaBinomialMixtureHyperparams = {
    variant: 'beta_binomial_mixture', alpha: 1e-4, v_opt: 100,
    alpha_opt: BETA_BINOMIAL_ALPHA_OPT_DEFAULT,
    g: 0.7, h: 0.3, is_one_sided: true,
  };
  assert.throws(() => evaluateBetaBinomialBound(p, 50),
    /SLICE 1.*BetaBinomialMixture.*not implemented/);
});

// ── Variant dispatch ───────────────────────────────────────────────

test('Q70.2 #12: evaluateSelfNormalizedBound dispatches LIL vs BetaBinomial by variant', () => {
  const lil: SelfNormalizedEProcessFallback = {
    variant: 'lil_bound', alpha: 1e-4, t_min: 1, A: LIL_A_DEFAULT, C: 2.0,
  };
  const bb: SelfNormalizedEProcessFallback = {
    variant: 'beta_binomial_mixture', alpha: 1e-4, v_opt: 100,
    alpha_opt: BETA_BINOMIAL_ALPHA_OPT_DEFAULT,
    g: 0.7, h: 0.3, is_one_sided: true,
  };
  // LIL dispatches to closed-form.
  assert.equal(evaluateSelfNormalizedBound(lil, 100), evaluateLilBound(lil, 100));
  // BetaBinomial dispatches to SLICE 1 stub.
  assert.throws(() => evaluateSelfNormalizedBound(bb, 50), /SLICE 1/);
  // Variant-agnostic validation routes by tag.
  assert.doesNotThrow(() => assertSelfNormalizedHyperparams(lil));
  assert.doesNotThrow(() => assertSelfNormalizedHyperparams(bb));
});

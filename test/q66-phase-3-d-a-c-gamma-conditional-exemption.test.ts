// test/q66-phase-3-d-a-c-gamma-conditional-exemption.test.ts —
// Q66 Phase-3.d.A.c.γ conditional exemption mechanism.
//
// Per ARCHITECT-REPLY-Q66-PHASE-3-D-A-c-gamma-DISPOSITION.md § (b.2):
// extends Q60 L3b detector_exemption_reason mechanism to handle
// calibration-regime-vs-sweep-regime mismatch class. Tests verify
// isSweepModeCalibrationRegimeMatched returns matched={true|false}
// per architect-specified rules across substrate × mode × detector
// triples.

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

// ── Helpers — synthesize per-test compiled config + substrate ref ──

interface CellCfg {
  hour_of_day: number;
  family_A_per_signal: Record<string, {
    signal_class?: string;
    ar1_phi?: number;
  }>;
}

function writeTempCompiledConfig(label: string, cells: CellCfg[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `q66-acg-${label}-`));
  const cfgPath = path.join(dir, 'config.json');
  const cfg = {
    version: '0.1-test',
    compiler_version: '0.1-test',
    compiled_at: '2026-05-06T00:00:00Z',
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

// ── Test #1: iid_bootstrap mode + non-heavy_tail substrate → matched ──
// (Post-.A.c.γ.b refinement: iid_bootstrap mode applies heavy_tail check;
// gaussian_like-only substrate stays matched.)

test('Q66 .A.c.γ.b #1: iid_bootstrap matched for gaussian_like substrate (no heavy_tail)', () => {
  const cfg = writeTempCompiledConfig('iid-test', [
    { hour_of_day: 0, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.0001 },
    } },
  ]);
  const sub = makeSubstrateRef('any', cfg);
  // family_A_page_cusum: heuristic now applies; gaussian_like passes.
  const pageCusumResult = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', 'family_A_page_cusum');
  assert.equal(pageCusumResult.matched, true,
    'iid_bootstrap + gaussian_like should match for family_A_page_cusum');
  assert.equal(pageCusumResult.reason, undefined);
  // Other detectors NOT in .A.c.γ.b scope (Phase-3.d.E future).
  for (const det of ['family_A_betting', 'family_E_conformal'] as Q60DetectorFamily[]) {
    const r = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', det);
    assert.equal(r.matched, true, `iid_bootstrap should match for ${det} (Phase-3.d.E future scope)`);
  }
});

// ── Test #2: parametric_ar1 + iid baseline (low phi) → exempt ──

test('Q66 .A.c.γ #2: parametric_ar1 + iid baseline (sampling-noise phi) exempts family_A_page_cusum', () => {
  // Synthetic-v1-shaped: 50 cells with phi values dominated by sampling noise
  // (mean ~0; max ~0.15). Mirrors empirical .A.c.α post-recompile distribution.
  const cells: CellCfg[] = [];
  const rng = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  for (let i = 0; i < 50; i++) {
    cells.push({ hour_of_day: i, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: (rng() - 0.5) * 0.3 },
    } });
  }
  const cfg = writeTempCompiledConfig('iid-baseline', cells);
  const sub = makeSubstrateRef('synthetic_v1_iid', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, false, 'iid-baseline phi distribution should fail AR(1) regime match');
  assert.match(r.reason ?? '', /calibration_baseline_correlation_structure_does_not_match_sweep_mode_correlation_structure/);
  assert.match(r.reason ?? '', /lacks AR\(1\) structure/);
});

// ── Test #3: parametric_ar1 + AR(1)-baseline (high phi) → matched ──

test('Q66 .A.c.γ #3: parametric_ar1 + AR(1) baseline (|max| > 0.5) matches family_A_page_cusum', () => {
  // Synthesize cells with |phi| > 0.5 — production-AR(1)-data shape.
  const cells: CellCfg[] = [];
  for (let i = 0; i < 20; i++) {
    cells.push({ hour_of_day: i, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.6 },
    } });
  }
  const cfg = writeTempCompiledConfig('ar1-baseline-strong', cells);
  const sub = makeSubstrateRef('production_ar1', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, true, 'phi=0.6 should pass AR(1) regime match');
});

// ── Test #4: parametric_ar1 + |mean phi| > 0.2 → matched ──

test('Q66 .A.c.γ #4: parametric_ar1 + baseline mean phi > 0.2 matches family_A_page_cusum', () => {
  // Mean above threshold even if individual phis below 0.5.
  const cells: CellCfg[] = [];
  for (let i = 0; i < 20; i++) {
    cells.push({ hour_of_day: i, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.3 },
    } });
  }
  const cfg = writeTempCompiledConfig('ar1-baseline-mean', cells);
  const sub = makeSubstrateRef('mean_ar1', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, true, 'mean phi=0.3 should pass AR(1) regime match');
});

// ── Test #5: parametric_gaussian + single-signal heavy-tail → exempt ──

test('Q66 .A.c.γ #5: parametric_gaussian + single-signal heavy-tail substrate exempts family_A_page_cusum', () => {
  // real_burstgpt-shaped: 1 signal (cost_req); heavy_tail signal class.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.05 },
  } }];
  const cfg = writeTempCompiledConfig('single-signal-ht', cells);
  const sub = makeSubstrateRef('real_burstgpt_shape', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_page_cusum');
  assert.equal(r.matched, false, 'single-signal heavy_tail should fail parametric_gaussian regime match');
  assert.match(r.reason ?? '', /calibration_baseline_correlation_structure_does_not_match_sweep_mode_correlation_structure/);
  assert.match(r.reason ?? '', /heavy_tail/);
});

// ── Test #6: parametric_gaussian + heavy_tail-without-ballast → exempt ──
// .A.c.γ.c refinement: compound predicate `hasHeavyTail && !hasGaussianLike`.
// Real_hf shape (bounded_probability + heavy_tail; NO gaussian_like ballast).
// Empirical motivation: real_hf parametric_gaussian FPR=1.000.

test('Q66 .A.c.γ.c #6: parametric_gaussian + heavy_tail-without-ballast (real_hf shape) exempts', () => {
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.0 },
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('real-hf-shape-ht-no-ballast', cells);
  const sub = makeSubstrateRef('real_hf_shape', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_page_cusum');
  assert.equal(r.matched, false,
    'heavy_tail-without-gaussian_like-ballast should fail parametric_gaussian regime match (.A.c.γ.c)');
  assert.match(r.reason ?? '', /heavy_tail without gaussian_like ballast/);
});

// ── Test #7: parametric_gaussian + single-signal gaussian_like → matched ──

test('Q66 .A.c.γ #7: parametric_gaussian + single-signal gaussian_like substrate matches (NOT heavy_tail)', () => {
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    tokens_turn: { signal_class: 'gaussian_like', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('single-signal-gauss', cells);
  const sub = makeSubstrateRef('real_azure_shape', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'single-signal gaussian_like (not heavy_tail) should pass — sub-Gaussianity holds');
});

// ── Test #8: empty config (no cells with phi) → matched (no exemption signal) ──

test('Q66 .A.c.γ #8: empty config / no ar1_phi stamping (pre-Q66.A.b config) does not exempt', () => {
  // Pre-Q66.A.b configs have no ar1_phi; phi distribution count=0.
  // Should not trigger exemption because we can't establish iid-baseline
  // diagnostic from absent data; defaults to matched=true (architect spec
  // line 110-114 requires phiStats.count > 0 for exemption).
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    p99_latency: { signal_class: 'gaussian_like' },  // no ar1_phi
  } }];
  const cfg = writeTempCompiledConfig('no-phi', cells);
  const sub = makeSubstrateRef('legacy_no_phi', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, true, 'empty phi distribution should not trigger regime mismatch');
});

// ── Test #9: missing config file → matched (graceful degradation) ──

test('Q66 .A.c.γ #9: missing compiled config file gracefully matched (no false-positive exemption)', () => {
  const sub = makeSubstrateRef('nonexistent', '/tmp/does-not-exist-q66-acg.json');
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'missing config should default to matched (graceful) — no false-positive exemption');
});

// ── Test #10: non-family_A_page_cusum detector + parametric_ar1 → matched ──

test('Q66 .A.c.γ #10: non-family_A_page_cusum detectors NOT exempted at .A.c.γ (Phase-3.d.E future)', () => {
  // family_A_betting / family_C_* / family_E_conformal exemption rules
  // tagged FUTURE Phase-3.d.E per architect § 7. At .A.c.γ scope, these
  // detectors don't get the regime-mismatch exemption — they remain
  // subject to halt-boundary (a) gate.
  const cells: CellCfg[] = [];
  for (let i = 0; i < 20; i++) {
    cells.push({ hour_of_day: i, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.01 },
    } });
  }
  const cfg = writeTempCompiledConfig('iid-other-det', cells);
  const sub = makeSubstrateRef('iid_other', cfg);
  for (const det of ['family_A_betting', 'family_C_safe_test', 'family_E_conformal'] as Q60DetectorFamily[]) {
    const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', det);
    assert.equal(r.matched, true,
      `${det} should NOT be exempted at .A.c.γ scope (Phase-3.d.E future)`);
  }
});

// ── Test #11: parametric_gaussian + non-page-cusum detector → matched ──

test('Q66 .A.c.γ #11: parametric_gaussian + non-page-cusum detector unaffected at .A.c.γ scope', () => {
  // Same shape as Test #5 (single-signal heavy_tail) but for non-page-cusum
  // detector — should NOT get the .A.c.γ exemption (it's family_A_page_cusum-
  // specific at this sub-track scope).
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.05 },
  } }];
  const cfg = writeTempCompiledConfig('ht-other-det', cells);
  const sub = makeSubstrateRef('ht_other', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_betting');
  assert.equal(r.matched, true,
    'family_A_betting NOT exempted at .A.c.γ — Phase-3.d.E future cycle');
});

// ── Test #12: borderline phi distribution (mean ~0; max ~0.5) → matched ──

// ── Tests #13-#16: Q66 .A.c.γ.b refinement coverage ──

test('Q66 .A.c.γ.b #13: iid_bootstrap + heavy_tail substrate NOW exempted (post-refinement)', () => {
  // Empirical motivation: real_hf × iid_bootstrap × family_A_page_cusum
  // FPR=0.0124 (~103× over α × 1.2). Architect Q2 pick: extend heuristic
  // to iid_bootstrap mode.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('ht-iid-test', cells);
  const sub = makeSubstrateRef('ht_iid', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', 'family_A_page_cusum');
  assert.equal(r.matched, false,
    'iid_bootstrap + heavy_tail substrate should fail regime match per .A.c.γ.b refinement');
  assert.match(r.reason ?? '', /heavy_tail/);
  assert.match(r.reason ?? '', /iid_bootstrap/);
});

test('Q66 .A.c.γ.c #14: iid_bootstrap + real_hf shape (heavy_tail-without-ballast) exempted', () => {
  // real_hf actual signal classes: bounded_probability + heavy_tail; no gaussian_like.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.0 },
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('iid-real-hf-actual', cells);
  const sub = makeSubstrateRef('real_hf_actual_shape', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', 'family_A_page_cusum');
  assert.equal(r.matched, false,
    '.A.c.γ.c: real_hf shape (heavy_tail-without-ballast) iid_bootstrap should be exempted');
  assert.match(r.reason ?? '', /without gaussian_like ballast/);
});

test('Q66 .A.c.γ.b #15: iid_bootstrap + gaussian-only substrate NOT exempted (no over-exemption)', () => {
  // Substrate with NO heavy_tail signals — should remain matched at iid_bootstrap.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.0 },
    ttft: { signal_class: 'gaussian_like', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('iid-gauss-only', cells);
  const sub = makeSubstrateRef('synthetic_gauss_only', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'iid_bootstrap + gaussian-only substrate should NOT trigger over-exemption');
  assert.equal(r.reason, undefined);
});

test('Q66 .A.c.γ.c #15a: synthetic_v1 mixed-class shape (heavy_tail WITH gaussian_like ballast) NOT exempted on iid', () => {
  // Regression check for .A.c.γ.b over-exemption — synthetic_v1 has cost_req
  // (heavy_tail) + downstream_err (heavy_tail) BUT also p99_latency/ttft
  // (gaussian_like) + tool_success_rate/eval_score (bounded_probability).
  // The gaussian_like ballast should prevent ballast-check exemption.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.01 },
    ttft: { signal_class: 'gaussian_like', ar1_phi: 0.02 },
    eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.01 },
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.01 },
    downstream_err: { signal_class: 'heavy_tail', ar1_phi: 0.01 },
  } }];
  const cfg = writeTempCompiledConfig('synthetic-v1-shape-ballast', cells);
  const sub = makeSubstrateRef('synthetic_v1_shape', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'iid_bootstrap', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'synthetic_v1 mixed-class shape (heavy_tail + gaussian_like ballast) should NOT trigger over-exemption on iid_bootstrap');
});

test('Q66 .A.c.γ.c #15b: synthetic_v1 mixed-class shape NOT exempted on parametric_gaussian (regression check)', () => {
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.01 },
    cost_req: { signal_class: 'heavy_tail', ar1_phi: 0.01 },
  } }];
  const cfg = writeTempCompiledConfig('mixed-with-ballast-pg', cells);
  const sub = makeSubstrateRef('mixed_with_ballast', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'gaussian_like ballast (even single signal) should prevent compound-predicate exemption');
});

test('Q66 .A.c.γ.b #16: parametric_gaussian + bounded_probability-only NOT exempted (no over-exemption)', () => {
  // bounded_probability is post-Q2.A logit-transformed; NOT heavy_tail.
  // Should remain matched.
  const cells: CellCfg[] = [{ hour_of_day: 0, family_A_per_signal: {
    eval_score: { signal_class: 'bounded_probability', ar1_phi: 0.0 },
  } }];
  const cfg = writeTempCompiledConfig('bp-only', cells);
  const sub = makeSubstrateRef('bp_only', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_gaussian', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'parametric_gaussian + bounded_probability (no heavy_tail) should NOT trigger over-exemption');
});

test('Q66 .A.c.γ #12: borderline phi distribution at threshold matches (architect-tuned)', () => {
  // Mix of values whose absMax just exceeds 0.5 — architect's threshold
  // boundary. Should pass regime match (boundary inclusive).
  const cells: CellCfg[] = [];
  for (let i = 0; i < 19; i++) {
    cells.push({ hour_of_day: i, family_A_per_signal: {
      p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.0 },
    } });
  }
  cells.push({ hour_of_day: 19, family_A_per_signal: {
    p99_latency: { signal_class: 'gaussian_like', ar1_phi: 0.51 },
  } });
  const cfg = writeTempCompiledConfig('borderline', cells);
  const sub = makeSubstrateRef('borderline', cfg);
  const r = isSweepModeCalibrationRegimeMatched(sub, 'parametric_ar1', 'family_A_page_cusum');
  assert.equal(r.matched, true,
    'absMax=0.51 > 0.5 should pass AR(1) regime match (architect threshold)');
});

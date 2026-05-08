// test/conformal.test.ts — Family E (conformal novelty) unit tests.
//
// Acceptance per WEEK4-HANDOFF.md §4.1.c:
//   - p-value computation is a valid conformal rank
//   - fires when p < α_family_E
//   - cell-matched baseline lookup returns the expected cell
//   - Mahalanobis scoring is symmetric to Family C (same metric)
//
// The "≥ 1 of 3 novelty catches" gate lives in test/family-e-parity.test.ts
// (subtask 4.1.c acceptance, alongside 4.1.f scenarios + compiler bump).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mahalanobisDistance, conformalPValue, lookupFamilyEParams, evaluateFamilyE,
} from '../dist/engine/detectors/conformal';
import { FAMILY_C_SIGNALS } from '../dist/engine/detectors/hotelling';
import type { CompiledConfig, FamilyCPerCell, ConformalParams } from '../dist/engine/types';
import { conformalSampleCount, isWeightedConformal } from '../dist/engine/types';

// ────────────────────────────────────────────────────────────────────
// Mahalanobis distance sanity.
test('conformal: mahalanobisDistance matches hand-computed value on 2×2', () => {
  // Σ = [[4, 1], [1, 9]]; r = [2, 3]. T² = 60/35; distance = sqrt(60/35).
  const cov = [[4, 1], [1, 9]];
  const r = [2, 3];
  const d = mahalanobisDistance(r, cov)!;
  const expected = Math.sqrt(60 / 35);
  assert.ok(Math.abs(d - expected) < 1e-9, `got ${d}, expected ${expected}`);
});

test('conformal: mahalanobisDistance returns null on singular covariance', () => {
  const cov = [[0, 0], [0, 0]];
  const r = [1, 1];
  assert.equal(mahalanobisDistance(r, cov), null);
});

// ────────────────────────────────────────────────────────────────────
// p-value computation.
test('conformal: p-value is (#{ s_c ≥ s_q } + 1) / (n + 1)', () => {
  const cal = [0.1, 0.5, 0.9, 1.2, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];  // n=10
  // Query at 0 → all 10 calibration scores ≥ 0 → p = (10+1)/(10+1) = 1.
  assert.equal(conformalPValue(0, cal), 1);
  // Query at 5 → none ≥ 5 → p = (0+1)/(10+1) = 1/11.
  assert.ok(Math.abs(conformalPValue(5, cal) - 1/11) < 1e-12);
  // Query at 2.0 → 5 calibration scores ≥ 2.0 → p = (5+1)/(10+1) = 6/11.
  assert.ok(Math.abs(conformalPValue(2.0, cal) - 6/11) < 1e-12);
});

test('conformal: p-value with empty calibration returns 1', () => {
  assert.equal(conformalPValue(5.0, []), 1);
});

// ────────────────────────────────────────────────────────────────────
// End-to-end fire on a synthetic cfg.
test('conformal: fires when live score exceeds all calibration scores', () => {
  const p = FAMILY_C_SIGNALS.length;
  // Diagonal covariance with small variance → any non-tiny deviation is
  // a high-Mahalanobis score.
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 0.01 : 0)));
  const mean = Array.from({ length: p }, (_, i) => (i === 0 ? 100 : 1));
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov, covariance_shrinkage: 0 };
  // Calibration scores: "typical" scores drawn from N(0, Σ) land near
  // sqrt(p) — use deterministic values below 5 for simplicity.
  const calibration = Array.from({ length: 20000 }, (_, i) => 0.5 + (i / 20000) * 3);
  const cfg: CompiledConfig = {
    version: 'test', compiler_version: '0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: 1e-4 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: calibration.length, confidence: 'strict',
        family_C: famC,
        family_E: { calibration_scores: calibration },
      }],
      aggregate_fallback: { family_C: famC, family_E: { calibration_scores: calibration } },
    },
  };

  // Live value well past calibration max — should fire.
  const liveHigh: Record<string, number> = {};
  for (let i = 0; i < FAMILY_C_SIGNALS.length; i++) {
    liveHigh[FAMILY_C_SIGNALS[i]] = mean[i] * (1 + 0.5);  // 50% off → huge score
  }
  const vHigh = evaluateFamilyE(cfg, liveHigh, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vHigh!.verdict, 'fire', `expected fire at large deviation; got ${vHigh!.verdict}`);
  assert.equal(vHigh!.reason_code, 'conformal_p_below_threshold');
  assert.equal(vHigh!.family, 'E');
  assert.ok(vHigh!.alpha_spent > 0);

  // Live value = mean → score 0 → all calibration scores ≥ 0 → p = 1 → clean.
  const liveNull: Record<string, number> = {};
  for (let i = 0; i < FAMILY_C_SIGNALS.length; i++) liveNull[FAMILY_C_SIGNALS[i]] = mean[i];
  const vLow = evaluateFamilyE(cfg, liveNull, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(vLow!.verdict, 'clean');
});

test('conformal: underpowered calibration (<1/α) emits suppressed', () => {
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  const mean = Array.from({ length: p }, (_, i) => i + 1);
  const famC: FamilyCPerCell = { mean_vector: mean, covariance: cov, covariance_shrinkage: 0 };
  const cfg: CompiledConfig = {
    version: 'test', compiler_version: '0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: 1e-4 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: 10, confidence: 'strict',
        family_C: famC,
        family_E: { calibration_scores: [0.5, 1.0, 1.5] },  // only 3 — well below 1/1e-4 = 10000
      }],
      aggregate_fallback: { family_C: famC, family_E: { calibration_scores: [0.5, 1.0, 1.5] } },
    },
  };
  const live: Record<string, number> = {};
  for (let i = 0; i < p; i++) live[FAMILY_C_SIGNALS[i]] = mean[i] + 1;
  const v = evaluateFamilyE(cfg, live, {
    hourOfDay: 14, dayOfWeek: 3, ticksSinceDeploy: 100, deployAgeDays: 0, trafficPct: 1.0,
  });
  assert.equal(v!.verdict, 'suppressed');
  assert.equal(v!.reason_code, 'calibration_underpowered');
});

// ────────────────────────────────────────────────────────────────────
// Cell-matched lookup.
test('conformal: lookupFamilyEParams takes per-cell μ/Σ but always uses aggregate calibration (W5 §REPLY-16 Q2)', () => {
  const p = FAMILY_C_SIGNALS.length;
  const cov: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  const fb: FamilyCPerCell = { mean_vector: new Array(p).fill(1), covariance: cov };
  const cellC: FamilyCPerCell = { mean_vector: new Array(p).fill(2), covariance: cov };
  const cfg: CompiledConfig = {
    version: 'test', compiler_version: '0', compiled_at: '', baseline_ref: 'test',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 2e-4, D: 0, E: 1e-4 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 3 },
        n_samples: 100, confidence: 'strict',
        family_C: cellC,
        // Per-cell calibration ignored post-Q2 flip — aggregate is the
        // sole calibration source.
        family_E: { calibration_scores: [1, 2, 3] },
      }],
      aggregate_fallback: { family_C: fb, family_E: { calibration_scores: [0.1, 0.2, 0.3] } },
    },
  };
  // Per-cell match: μ/Σ are per-cell (mean=2), calibration is aggregate.
  const match = lookupFamilyEParams(cfg, { hour_of_day: 14, day_of_week: 3 });
  assert.ok(match);
  assert.equal(match!.famC.mean_vector[0], 2);  // per-cell μ
  assert.ok(!isWeightedConformal(match!.params));  // legacy unweighted fixture
  assert.deepEqual((match!.params as Extract<ConformalParams, { kind?: 'unweighted' }>).calibration_scores, [0.1, 0.2, 0.3]);  // aggregate calibration
  assert.equal(match!.source, 'aggregate');  // calibration source identifier
  // Unknown cell: μ/Σ also fall back to aggregate.
  const miss = lookupFamilyEParams(cfg, { hour_of_day: 23, day_of_week: 6 });
  assert.ok(miss);
  assert.equal(miss!.famC.mean_vector[0], 1);  // aggregate μ
  assert.ok(!isWeightedConformal(miss!.params));
  assert.deepEqual((miss!.params as Extract<ConformalParams, { kind?: 'unweighted' }>).calibration_scores, [0.1, 0.2, 0.3]);
  assert.equal(miss!.source, 'aggregate');
});

test('conformal: α_E=1e-4 against v4 aggregate calibration clears underpowered guard (W5 §REPLY-16 Q2)', () => {
  // Architect REPLY-16 Q2: Family E now consults aggregate_fallback.family_E
  // (~16K-20K pooled baseline samples). At α_E=1e-4, conformal underpowered
  // guard requires ≥ ⌈1/α_E⌉ - 1 = 9999 calibration scores. v4's aggregate
  // ships 20000 — guard must NOT trip on a clean live vector at the
  // patched cell.
  const fs = require('node:fs');
  const path = require('node:path');
  const V4_PATH = path.join(__dirname, '..', 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
  if (!fs.existsSync(V4_PATH)) {
    // Skip cleanly when v4 hasn't been generated (e.g., fresh CI clone
    // before w4-full-sweep runs).
    return;
  }
  const v4: CompiledConfig = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  const aggE = v4.baseline_cells!.aggregate_fallback!.family_E!;
  const aggN = conformalSampleCount(aggE);
  assert.ok(aggN >= 9999,
    `aggregate calibration size ${aggN} < 9999 — α_E=1e-4 will trip underpowered guard`);

  // End-to-end: live metrics at the cell mean (zero deviation) should
  // produce a 'clean' verdict, NOT 'suppressed/calibration_underpowered'.
  const cell = v4.baseline_cells!.cells.find((c) =>
    c.key.hour_of_day === 14 && c.key.day_of_week === 2);
  assert.ok(cell && cell.family_C, 'v4 missing target cell');
  const liveAtMean: Record<string, number> = {};
  for (let i = 0; i < FAMILY_C_SIGNALS.length; i++) {
    liveAtMean[FAMILY_C_SIGNALS[i]] = cell!.family_C!.mean_vector[i];
  }
  const verdict = evaluateFamilyE(v4, liveAtMean, {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 100, deployAgeDays: 0.1, trafficPct: 1.0,
  });
  assert.ok(verdict, 'evaluateFamilyE returned null — Family E not configured');
  assert.notEqual(verdict!.reason_code, 'calibration_underpowered',
    'Family E suppressed by underpowered guard at α=1e-4 — Q2 flip broken');
  assert.equal(verdict!.verdict, 'clean',
    `Family E verdict on live-at-mean should be clean, got ${verdict!.verdict}/${verdict!.reason_code}`);
});

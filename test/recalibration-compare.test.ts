// test/recalibration-compare.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 4 + the per-cell-weighted-extraction follow-up.
//
// Exercises engine/recalibration/compare.ts: extractSignalMeans,
// extractSignalMeansPerCellWeighted, compareCandidateVsActive,
// evaluateReadinessGates.
//
// Synthetic mini-configs shaped like runs/compiled-configs/v4-fusion-
// novelty.json's baseline_cells block (aggregate_fallback.family_A.
// per_signal + aggregate_fallback.family_C.mean_vector), trimmed to a
// couple of signals for test legibility rather than the full 11/13-
// signal production shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSignalMeans, extractSignalMeansPerCellWeighted, compareCandidateVsActive, evaluateReadinessGates,
} from '../engine/recalibration/compare';
import { classifyRecalibration } from '../engine/recalibration/classify';
import type { CompiledConfig } from '../engine/types';
import { DRIFT_SAMPLE_WINDOW_MAX } from '../engine/drift/baseline-drift-detector';

function makeConfig(overrides: Partial<CompiledConfig> = {}): CompiledConfig {
  return {
    version: 'v-active@seed=42',
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=42',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['p99_latency', 'mfu'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [
        { key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 200, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 20,
            },
            mfu: {
              baseline_mean: 0.70, baseline_sigma_squared: 0.01, tau_squared: 0.0025, delta_min: 0.05,
            },
          },
        },
        family_C: {
          mean_vector: [200, 0.70],
          covariance: [[100, 0], [0, 0.01]],
        },
      },
    },
    ...overrides,
  } as CompiledConfig;
}

// ── extractSignalMeans ───────────────────────────────────────────────

test('extractSignalMeans: union of family_A baseline_mean + family_C mean_vector', () => {
  const cfg = makeConfig();
  const means = extractSignalMeans(cfg);
  assert.equal(means.p99_latency, 200);
  assert.equal(means.mfu, 0.70);
  assert.deepEqual(Object.keys(means).sort(), ['mfu', 'p99_latency']);
});

test('extractSignalMeans: absent baseline_cells -> empty map', () => {
  const cfg = makeConfig({ baseline_cells: undefined });
  assert.deepEqual(extractSignalMeans(cfg), {});
});

test('extractSignalMeans: family_c_signals absent falls back to FAMILY_C_SIGNALS order', () => {
  const cfg = makeConfig({ family_c_signals: undefined });
  // Default FAMILY_C_SIGNALS order starts p99_latency, ttft, tokens_turn, ...
  // — with only a 2-element mean_vector, only index 0 (p99_latency) maps.
  const means = extractSignalMeans(cfg);
  assert.equal(means.p99_latency, 200);
});

test('extractSignalMeans: divergent family_A vs family_C values on an overlapping signal -> family_C wins', () => {
  // Hand-built divergence (real compiled configs should agree to near
  // float precision per Q2.B.4 coherence) — exercises the documented
  // "Family C's mean_vector is the multivariate joint-calibration source
  // of truth for cross-family-covered signals" tie-break explicitly.
  const cfg = makeConfig({
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 999, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 20,
            },
          },
        },
        family_C: {
          mean_vector: [200],
          covariance: [[100]],
        },
      },
    },
    family_c_signals: ['p99_latency'],
  });
  const means = extractSignalMeans(cfg);
  assert.equal(means.p99_latency, 200, 'family_C mean_vector must win over the divergent family_A baseline_mean');
});

// ── extractSignalMeansPerCellWeighted ─────────────────────────────────

/** 3-cell fixture: two 'strict' cells with their OWN family_A/family_C
 *  values + n_samples, plus a third 'aggregate'-confidence cell (no
 *  family data of its own — routes to aggregate_fallback exactly like
 *  runtime's buildMSPRTParams does when cell.confidence is 'aggregate').
 *  family_A signal ('p99_latency') and family_C signal ('mfu') are kept
 *  disjoint (family_c_signals: ['mfu']) so this exercises both
 *  averaging code paths independently, with no family_C-wins-on-overlap
 *  tie-break in play. */
function makeWeightedConfig(): CompiledConfig {
  return {
    version: 'v-weighted@seed=1',
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=1',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['mfu'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [
        {
          key: { hour_of_day: 0 }, n_samples: 100, confidence: 'strict',
          family_A: { per_signal: { p99_latency: { baseline_mean: 100, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
          family_C: { mean_vector: [100], covariance: [[10]] },
        },
        {
          key: { hour_of_day: 1 }, n_samples: 300, confidence: 'strict',
          family_A: { per_signal: { p99_latency: { baseline_mean: 300, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
          family_C: { mean_vector: [300], covariance: [[10]] },
        },
        // 'aggregate' confidence, no per-cell family data of its own —
        // contributes aggregate_fallback's value (500), weighted by ITS
        // OWN n_samples (200), same as runtime would consult for this
        // cell/signal.
        { key: { hour_of_day: 2 }, n_samples: 200, confidence: 'aggregate' },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: { baseline_mean: 500, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 },
          },
        },
        family_C: { mean_vector: [500], covariance: [[10]] },
      },
    },
  } as CompiledConfig;
}

test('extractSignalMeansPerCellWeighted: weighted average across strict + aggregate-confidence cells matches hand computation exactly', () => {
  const cfg = makeWeightedConfig();
  const means = extractSignalMeansPerCellWeighted(cfg);
  // (100*100 + 300*300 + 500*200) / (100+300+200) = 200000/600 = 333.333...
  const expected = 200000 / 600;
  assert.ok(Math.abs(means.p99_latency - expected) < 1e-9, `p99_latency: got ${means.p99_latency}, want ${expected}`);
  assert.ok(Math.abs(means.mfu - expected) < 1e-9, `mfu: got ${means.mfu}, want ${expected}`);
  // Sanity: this must differ from the old aggregate-only extraction,
  // which would report the aggregate_fallback value (500) untouched by
  // any per-cell weighting.
  const oldMeans = extractSignalMeans(cfg);
  assert.equal(oldMeans.p99_latency, 500);
  assert.equal(oldMeans.mfu, 500);
  assert.notEqual(means.p99_latency, oldMeans.p99_latency);
});

test('extractSignalMeansPerCellWeighted: cell missing per-cell data for a signal contributes nothing (falls through to remaining cells, not to aggregate)', () => {
  const cfg = makeWeightedConfig();
  // Strip cell 1's family_A block entirely — a 'strict' cell with no
  // per-signal data at all is a legacy/malformed shape; runtime's
  // buildMSPRTParams returns null for it (no fallback to aggregate,
  // since confidence isn't 'aggregate'/'none'), so this extraction must
  // likewise just skip it rather than substituting the aggregate value.
  delete cfg.baseline_cells!.cells[0].family_A;
  const means = extractSignalMeansPerCellWeighted(cfg);
  // Only cell 1 (n=300, value=300) and cell 2 (aggregate-routed, n=200,
  // value=500) contribute now: (300*300 + 500*200) / (300+200) = 190000/500 = 380.
  const expected = (300 * 300 + 500 * 200) / (300 + 200);
  assert.ok(Math.abs(means.p99_latency - expected) < 1e-9, `got ${means.p99_latency}, want ${expected}`);
});

test('extractSignalMeansPerCellWeighted: no baseline_cells -> empty map (same as extractSignalMeans)', () => {
  const cfg = makeWeightedConfig();
  cfg.baseline_cells = undefined;
  assert.deepEqual(extractSignalMeansPerCellWeighted(cfg), {});
});

test('extractSignalMeansPerCellWeighted: cells carry no per-cell family data at all -> degenerates exactly to the aggregate value', () => {
  // Shape used throughout this file's other fixtures and the CLI/
  // invariant test suites: bare key/n_samples/confidence cells, no
  // family_A/family_C blocks of their own. No cell has anything to
  // contribute, so every signal's mean falls through to the aggregate
  // value untouched — identical output to extractSignalMeans.
  const cfg = makeConfig();
  const weighted = extractSignalMeansPerCellWeighted(cfg);
  const aggregate = extractSignalMeans(cfg);
  assert.deepEqual(weighted, aggregate);
});

// ── Family A vs Family C gating split (per-cell-weighted-follow-up-2) ─
//
// The runtime confirms the two families gate differently:
//   - engine/detectors/_page-cusum-params.ts's buildMSPRTParams (Family
//     A) routes an 'aggregate'/'none'-confidence cell to
//     aggregate_fallback.family_A REGARDLESS of whether the cell itself
//     carries a family_A block.
//   - engine/detectors/_hotelling-lookup.ts's lookupFamilyCParams
//     (Family C) never inspects cell.confidence at all: it uses the
//     matched cell's family_C block whenever PRESENT, falling back to
//     aggregate_fallback.family_C only when the cell has no family_C
//     block. tools/calibrate/_calibrate-derive-cells-helpers.ts's
//     stitchAggregateFallback stitches exactly this shape onto
//     low-confidence cells in real compiled configs — a real,
//     cell-specific family_C block on an 'aggregate'/'none'-confidence
//     cell is the NORMAL case, not a hand-built edge case.
//
// This single cell (confidence 'aggregate', carrying BOTH its own
// family_A per-signal value AND its own family_C mean_vector entry,
// both sharply divergent from aggregate_fallback) proves the rule split
// in one fixture: the Family A signal must still read the aggregate
// value (ignoring the cell's own 999), while the Family C signal must
// read the cell's own value (777, ignoring aggregate_fallback's 100).
// Signals are kept disjoint (family_c_signals: ['mfu'] only) so there's
// no family-C-wins-on-overlap tie-break muddying which rule produced
// which number.
function makeConfidenceSplitConfig(): CompiledConfig {
  return {
    version: 'v-split@seed=1',
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=1',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 2e-4 } },
    family_c_signals: ['mfu'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [
        {
          key: { hour_of_day: 0 },
          n_samples: 100,
          confidence: 'aggregate',
          // Family A: present on the cell, but confidence 'aggregate'
          // means buildMSPRTParams routes to aggregate_fallback anyway —
          // this 999 must NOT show up in the result.
          family_A: {
            per_signal: {
              p99_latency: {
                baseline_mean: 999, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5,
              },
            },
          },
          // Family C: a present, divergent per-cell block — exactly the
          // stitchAggregateFallback shape a real compiler produces for a
          // low-confidence cell. lookupFamilyCParams would consult THIS
          // value at serve time (it never checks confidence), so the
          // extraction must too.
          family_C: { mean_vector: [777], covariance: [[10]] },
        },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 100, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5,
            },
          },
        },
        family_C: { mean_vector: [100], covariance: [[10]] },
      },
    },
  } as CompiledConfig;
}

test('extractSignalMeansPerCellWeighted: Family C reads an aggregate-confidence cell\'s own present family_C value; Family A on the same cell still reads aggregate (rule split proof)', () => {
  const cfg = makeConfidenceSplitConfig();
  const means = extractSignalMeansPerCellWeighted(cfg);
  assert.equal(means.mfu, 777, 'Family C is presence-gated: the cell\'s own family_C value must win despite \'aggregate\' confidence');
  assert.equal(means.p99_latency, 100, 'Family A is confidence-gated: an \'aggregate\'-confidence cell must still route to aggregate_fallback, even though it carries its own family_A value');
});

test('compareCandidateVsActive: extraction_basis is per_cell_weighted when only Family C carries real per-cell data on an aggregate-confidence cell', () => {
  const active = makeConfig(); // bare cells, no per-cell family data
  const candidate = makeConfidenceSplitConfig();
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.extraction_basis, 'per_cell_weighted');
});

test('compareCandidateVsActive: extraction_basis is per_cell_weighted when either config carries real per-cell data', () => {
  const active = makeConfig(); // bare cells, no per-cell family data
  const candidate = makeWeightedConfig();
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.extraction_basis, 'per_cell_weighted');
});

test('compareCandidateVsActive: extraction_basis is aggregate_fallback_only when neither config carries per-cell data', () => {
  const active = makeConfig();
  const candidate = makeConfig({ version: 'v-candidate@seed=42' });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.extraction_basis, 'aggregate_fallback_only');
});

// ── divergent per-cell vs aggregate: proving the fix matters ──────────

test('per-cell-weighted extraction flips the direction classification vs the old aggregate-only extraction when they disagree', () => {
  // active: single 'strict' cell and aggregate_fallback AGREE at 100
  // (nothing to diverge on for active).
  const active: CompiledConfig = {
    version: 'v-active@seed=1',
    compiler_version: '0.3.0',
    compiled_at: '2026-07-01T00:00:00.000Z',
    baseline_ref: 'synthetic-v1@seed=1',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, C: 0 } },
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{
        key: { hour_of_day: 0 }, n_samples: 100, confidence: 'strict',
        family_A: { per_signal: { p99_latency: { baseline_mean: 100, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
      }],
      aggregate_fallback: {
        family_A: { per_signal: { p99_latency: { baseline_mean: 100, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
      },
    },
  } as CompiledConfig;

  // candidate: the 'strict' cell's OWN value is WORSE (150, +50% —
  // p99_latency is lower-is-better) but aggregate_fallback is
  // deliberately engineered to look BETTER (50, -50%) — a hand-built
  // divergence exercising exactly the gap the per-cell-weighted follow-
  // up closes. Real compiled configs shouldn't diverge this starkly,
  // but the whole point of this test is that when they do, the two
  // extractions must disagree.
  const candidate: CompiledConfig = {
    ...active,
    version: 'v-candidate@seed=2',
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{
        key: { hour_of_day: 0 }, n_samples: 100, confidence: 'strict',
        family_A: { per_signal: { p99_latency: { baseline_mean: 150, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
      }],
      aggregate_fallback: {
        family_A: { per_signal: { p99_latency: { baseline_mean: 50, baseline_sigma_squared: 10, tau_squared: 10, delta_min: 5 } } },
      },
    },
  } as CompiledConfig;

  const oldActiveMeans = extractSignalMeans(active);
  const oldCandidateMeans = extractSignalMeans(candidate);
  const oldClassification = classifyRecalibration(oldActiveMeans, oldCandidateMeans);
  assert.equal(oldClassification.per_signal_direction.p99_latency, 'improved',
    'sanity: the old aggregate-only extraction reads the engineered aggregate_fallback improvement');

  const newActiveMeans = extractSignalMeansPerCellWeighted(active);
  const newCandidateMeans = extractSignalMeansPerCellWeighted(candidate);
  const newClassification = classifyRecalibration(newActiveMeans, newCandidateMeans);
  assert.equal(newClassification.per_signal_direction.p99_latency, 'degraded',
    'the per-cell-weighted extraction reads the real per-cell degradation instead');

  // And compareCandidateVsActive (the actual production entry point)
  // reflects the new per-cell-weighted numbers, not the old ones.
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.per_signal_deltas.p99_latency.active_mean, 100);
  assert.equal(result.per_signal_deltas.p99_latency.candidate_mean, 150);
  assert.equal(result.extraction_basis, 'per_cell_weighted');
});

// ── compareCandidateVsActive ────────────────────────────────────────

test('compareCandidateVsActive: per_signal_deltas + cell counts + alpha_budget_changed', () => {
  const active = makeConfig();
  const candidate = makeConfig({
    version: 'v-candidate@seed=42',
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [
        { key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' },
        { key: { hour_of_day: 1 }, n_samples: 200, confidence: 'strict' },
      ],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 150, baseline_sigma_squared: 100, tau_squared: 100, delta_min: 20,
            },
            mfu: {
              baseline_mean: 0.80, baseline_sigma_squared: 0.01, tau_squared: 0.0025, delta_min: 0.05,
            },
          },
        },
        family_C: {
          mean_vector: [150, 0.80],
          covariance: [[100, 0], [0, 0.01]],
        },
      },
    },
  });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.cells_active, 1);
  assert.equal(result.cells_candidate, 2);
  assert.equal(result.alpha_budget_changed, false);
  assert.equal(result.per_signal_deltas.p99_latency.active_mean, 200);
  assert.equal(result.per_signal_deltas.p99_latency.candidate_mean, 150);
  assert.equal(result.per_signal_deltas.p99_latency.delta_absolute, -50);
  assert.ok(Math.abs(result.per_signal_deltas.p99_latency.delta_relative - -0.25) < 1e-9);
  assert.equal(result.extraction_basis, 'aggregate_fallback_only');
});

test('compareCandidateVsActive: alpha_budget_changed true on total-budget delta', () => {
  const active = makeConfig();
  const candidate = makeConfig({ alpha_budget: { total: 2e-3, per_family: { A: 8e-4, C: 4e-4 } } });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.alpha_budget_changed, true);
});

test('compareCandidateVsActive: predicted_fp_behavior "looser" when delta_min and sigma^2 both rise', () => {
  const active = makeConfig();
  const candidate = makeConfig({
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 200, baseline_sigma_squared: 200, tau_squared: 200, delta_min: 40,
            },
            mfu: {
              baseline_mean: 0.70, baseline_sigma_squared: 0.02, tau_squared: 0.005, delta_min: 0.10,
            },
          },
        },
        family_C: { mean_vector: [200, 0.70], covariance: [[200, 0], [0, 0.02]] },
      },
    },
  });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.predicted_fp_behavior, 'looser');
});

test('compareCandidateVsActive: predicted_fp_behavior "tighter" when delta_min and sigma^2 both fall', () => {
  const active = makeConfig();
  const candidate = makeConfig({
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            p99_latency: {
              baseline_mean: 200, baseline_sigma_squared: 50, tau_squared: 50, delta_min: 10,
            },
            mfu: {
              baseline_mean: 0.70, baseline_sigma_squared: 0.005, tau_squared: 0.001, delta_min: 0.02,
            },
          },
        },
        family_C: { mean_vector: [200, 0.70], covariance: [[50, 0], [0, 0.005]] },
      },
    },
  });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.predicted_fp_behavior, 'tighter');
});

test('compareCandidateVsActive: predicted_fp_behavior "unchanged" when signals disagree / identical', () => {
  const active = makeConfig();
  const candidate = makeConfig(); // byte-identical family_A block
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.predicted_fp_behavior, 'unchanged');
});

test('compareCandidateVsActive: predicted_fp_behavior "unchanged" on a genuine tie (1 looser + 1 tighter signal)', () => {
  // dominantFpBehavior's tie-break path: one Family A signal moves
  // strictly looser (delta_min + sigma^2 both rise), another moves
  // strictly tighter (both fall) — a 1-1 count tie must resolve to the
  // conservative 'unchanged' default, not pick either non-tied verdict.
  const active = makeConfig();
  const candidate = makeConfig({
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_A: {
          per_signal: {
            // Looser: both delta_min and sigma^2 rise vs active's 20 / 100.
            p99_latency: {
              baseline_mean: 200, baseline_sigma_squared: 200, tau_squared: 200, delta_min: 40,
            },
            // Tighter: both delta_min and sigma^2 fall vs active's 0.05 / 0.01.
            mfu: {
              baseline_mean: 0.70, baseline_sigma_squared: 0.005, tau_squared: 0.001, delta_min: 0.02,
            },
          },
        },
        family_C: { mean_vector: [200, 0.70], covariance: [[200, 0], [0, 0.005]] },
      },
    },
  });
  const result = compareCandidateVsActive(active, candidate);
  assert.equal(result.predicted_fp_behavior, 'unchanged');
});

// ── evaluateReadinessGates ───────────────────────────────────────────

const SOURCE_WINDOW = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-08T00:00:00.000Z', n_samples: 80 };

test('evaluateReadinessGates: all gates pass on a clean candidate', () => {
  const active = makeConfig();
  const candidate = makeConfig({ version: 'v-candidate@seed=42' });
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, []);
  assert.equal(result.compiler_version_compatible, true);
  assert.equal(result.alpha_total_unchanged, true);
  assert.equal(result.signals_comparable, true);
  assert.equal(result.source_window_outside_exclusions, true);
  assert.equal(result.min_source_samples, true);
  assert.equal(result.all_passed, true);
});

test('evaluateReadinessGates: compiler_version_compatible fails on a major-version mismatch', () => {
  const active = makeConfig({ compiler_version: '0.3.0' });
  const candidate = makeConfig({ compiler_version: '1.0.0' });
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, []);
  assert.equal(result.compiler_version_compatible, false);
  assert.equal(result.all_passed, false);
});

test('evaluateReadinessGates: compiler_version_compatible passes on a same-major minor bump', () => {
  const active = makeConfig({ compiler_version: '0.3.0' });
  const candidate = makeConfig({ compiler_version: '0.4.0' });
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, []);
  assert.equal(result.compiler_version_compatible, true);
});

test('evaluateReadinessGates: alpha_total_unchanged fails on a budget delta', () => {
  const active = makeConfig();
  const candidate = makeConfig({ alpha_budget: { total: 5e-3, per_family: { A: 2e-3, C: 1e-3 } } });
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, []);
  assert.equal(result.alpha_total_unchanged, false);
  assert.equal(result.all_passed, false);
});

test('evaluateReadinessGates: signals_comparable fails on zero signal overlap', () => {
  const active = makeConfig();
  const candidate = makeConfig({
    family_c_signals: ['kv_cache'],
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{ key: { hour_of_day: 0 }, n_samples: 200, confidence: 'strict' }],
      aggregate_fallback: {
        family_C: { mean_vector: [0.5], covariance: [[0.01]] },
      },
    },
  });
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, []);
  assert.equal(result.signals_comparable, false);
  assert.equal(result.all_passed, false);
});

test('evaluateReadinessGates: source_window_outside_exclusions fails on partial overlap', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions);
  assert.equal(result.source_window_outside_exclusions, false);
  assert.equal(result.all_passed, false);
});

test('evaluateReadinessGates: source_window_outside_exclusions fails when the exclusion fully contains the source window', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-06-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions);
  assert.equal(result.source_window_outside_exclusions, false);
});

test('evaluateReadinessGates: source_window_outside_exclusions passes on exact boundary touch (half-open, no overlap)', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  // Exclusion starts exactly when the source window ends — touching but
  // not overlapping under the half-open [start, end) convention.
  const exclusions = [{ start: SOURCE_WINDOW.end, end: '2026-07-15T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions);
  assert.equal(result.source_window_outside_exclusions, true);
});

test('evaluateReadinessGates: source_window_outside_exclusions passes when there is no temporal overlap at all', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions);
  assert.equal(result.source_window_outside_exclusions, true);
});

test('evaluateReadinessGates: selectionAppliedExclusions — overlap fully applied passes', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions, {
    selectionAppliedExclusions: [{ start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z' }],
  });
  assert.equal(result.source_window_outside_exclusions, true);
  assert.equal(result.all_passed, true);
});

test('evaluateReadinessGates: selectionAppliedExclusions — partially applied (second unapplied overlapping window) fails', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const applied = { start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' };
  const unapplied = { start: '2026-07-02T00:00:00.000Z', end: '2026-07-03T00:00:00.000Z', reason: 'incident-2', declared_by: 'op-2' };
  const exclusions = [applied, unapplied];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions, {
    selectionAppliedExclusions: [{ start: applied.start, end: applied.end }],
  });
  assert.equal(result.source_window_outside_exclusions, false);
  assert.equal(result.all_passed, false);
});

test('evaluateReadinessGates: selectionAppliedExclusions — non-empty but no overlap passes', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions, {
    selectionAppliedExclusions: [{ start: '2099-01-01T00:00:00.000Z', end: '2099-01-02T00:00:00.000Z' }],
  });
  assert.equal(result.source_window_outside_exclusions, true);
});

test('evaluateReadinessGates: selectionAppliedExclusions — endpoint-touching window still not an overlap', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: SOURCE_WINDOW.end, end: '2026-07-15T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const result = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions, {
    selectionAppliedExclusions: [],
  });
  assert.equal(result.source_window_outside_exclusions, true);
});

test('evaluateReadinessGates: option absent — behavior byte-identical to default (backstop)', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const exclusions = [{ start: '2026-07-05T00:00:00.000Z', end: '2026-07-10T00:00:00.000Z', reason: 'incident', declared_by: 'op-1' }];
  const withOpt = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions, {});
  const withoutOpt = evaluateReadinessGates(active, candidate, SOURCE_WINDOW, exclusions);
  assert.deepEqual(withOpt, withoutOpt);
  assert.equal(withoutOpt.source_window_outside_exclusions, false);
});

test('evaluateReadinessGates: min_source_samples defaults to DRIFT_SAMPLE_WINDOW_MAX (50, OQ-7)', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  assert.equal(DRIFT_SAMPLE_WINDOW_MAX, 50);
  const tooFew = evaluateReadinessGates(active, candidate, { ...SOURCE_WINDOW, n_samples: 10 }, []);
  assert.equal(tooFew.min_source_samples, false);
  assert.equal(tooFew.all_passed, false);
  const enough = evaluateReadinessGates(active, candidate, { ...SOURCE_WINDOW, n_samples: 50 }, []);
  assert.equal(enough.min_source_samples, true);
});

test('evaluateReadinessGates: min_source_samples honors an explicit override', () => {
  const active = makeConfig();
  const candidate = makeConfig();
  const result = evaluateReadinessGates(
    active, candidate, { ...SOURCE_WINDOW, n_samples: 10 }, [], { minSourceSamples: 5 },
  );
  assert.equal(result.min_source_samples, true);
});

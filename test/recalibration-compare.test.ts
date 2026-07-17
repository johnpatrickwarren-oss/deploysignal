// test/recalibration-compare.test.ts — Addition #15 baseline-maintenance
// lifecycle, Task 4.
//
// Exercises engine/recalibration/compare.ts: extractSignalMeans,
// compareCandidateVsActive, evaluateReadinessGates.
//
// Synthetic mini-configs shaped like runs/compiled-configs/v4-fusion-
// novelty.json's baseline_cells block (aggregate_fallback.family_A.
// per_signal + aggregate_fallback.family_C.mean_vector), trimmed to a
// couple of signals for test legibility rather than the full 11/13-
// signal production shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSignalMeans, compareCandidateVsActive, evaluateReadinessGates,
} from '../engine/recalibration/compare';
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

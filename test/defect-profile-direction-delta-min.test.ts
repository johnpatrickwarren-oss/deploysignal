// test/defect-profile-direction-delta-min.test.ts — defect found 2026-09-25: a profile's
// sli_list[].direction_of_better and δ_min were never read. The only direction source was the
// hand-transcribed 13-signal LLM table (engine/recalibration/direction-metadata.ts
// DIRECTION_OF_BETTER), so a profile's own signals (http_5xx, success, …) were unclassifiable
// and silently skipped by the recalibration classifier, and δ_min reached nothing.
//
// The fix carries the sli_list into the compile defaults and CompiledConfig as `sli_meta`
// ({signal: {direction_of_better, delta_min}}); directionOfBetter reads a configured direction
// before the table; the classifier uses the configured δ_min as that signal's unchanged dead-band;
// the recalibrate CLI passes both configs' sli_meta to the classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig } from '../dist/engine/types';
import { directionOfBetter } from '../engine/recalibration/direction-metadata';
import { classifyRecalibration, classifySignal } from '../engine/recalibration/classify';
import { classificationOptionsFor } from '../tools/recalibrate/_recalibrate-candidate';
import { loadProfile, resolveEffectiveConfig } from '../tools/profile-loader';
import { effectiveOrDefaults } from '../tools/calibrators/effective-config';

const LEGACY = {
  family_a_signals: ['p99_latency'], family_c_signals: [], family_a_alpha_fraction: 0.4, family_c_alpha_fraction: 0,
  family_d_alpha_fraction: 0, family_e_alpha_fraction: 0, alpha_total: 1e-3,
  family_enabled_from_cli: { A: true, B: true, C: true, D: true, E: true },
  cell_dimensions_from_bundle: { hour_of_day: true, day_of_week: false, workload_class: false, tenant_tier: false, region: false },
} as never;

test('defect 2026-09-25: the profile sli_list reaches the compile defaults as sli_meta', () => {
  const d = effectiveOrDefaults(resolveEffectiveConfig(loadProfile('generic-microservice@1.0.0'), null), LEGACY);
  assert.deepEqual(d.sli_meta, {
    p99_latency: { direction_of_better: 'lower', delta_min: 0.01 },
    downstream_err: { direction_of_better: 'lower', delta_min: 0.05 },
    cost_req: { direction_of_better: 'lower', delta_min: 0.01 },
  });
  assert.equal('sli_meta' in effectiveOrDefaults(null, LEGACY), false, 'legacy compiles carry none');
});

test('defect 2026-09-25: a configured direction is read before the table', () => {
  const configured = { http_5xx: { direction_of_better: 'higher' as const, delta_min: 0.05 }, cost_req: { direction_of_better: 'lower' as const, delta_min: 0.01 } };
  assert.equal(directionOfBetter('http_5xx'), null, 'the table does not know it');
  assert.equal(directionOfBetter('http_5xx', undefined, configured), 'higher');
  assert.equal(directionOfBetter('cost_req'), 'informational');
  assert.equal(directionOfBetter('cost_req', undefined, configured), 'lower');
  assert.equal(directionOfBetter('mfu', undefined, configured), 'higher', 'unconfigured signals keep the table');
});

test('defect 2026-09-25: the classifier classifies a configured signal and uses its δ_min as the dead-band', () => {
  const configured = {
    http_5xx: { direction_of_better: 'higher' as const, delta_min: 0.05 },
    p99_latency: { direction_of_better: 'lower' as const, delta_min: 0.05 },
  };
  // Without configuration http_5xx is skipped; with it a 20% rise is an improvement for 'higher'.
  assert.equal(classifySignal('http_5xx', 0.10, 0.12), null);
  assert.equal(classifySignal('http_5xx', 0.10, 0.12, { configured }), 'improved');
  // A 3% p99 rise: past the default 1% dead-band, inside the configured δ_min of 5%.
  assert.equal(classifySignal('p99_latency', 100, 103), 'degraded');
  assert.equal(classifySignal('p99_latency', 100, 103, { configured }), 'unchanged');
  const r = classifyRecalibration({ http_5xx: 0.10, p99_latency: 100 }, { http_5xx: 0.12, p99_latency: 103 }, { configured });
  assert.deepEqual(r.per_signal_direction, { http_5xx: 'improved', p99_latency: 'unchanged' });
});

test('defect 2026-09-25: the recalibrate CLI passes both configs\' sli_meta (candidate wins) to the classifier', () => {
  const active = { sli_meta: { a: { direction_of_better: 'lower', delta_min: 0.02 }, b: { direction_of_better: 'lower', delta_min: 0.02 } } } as unknown as CompiledConfig;
  const candidate = { sli_meta: { b: { direction_of_better: 'higher', delta_min: 0.03 } } } as unknown as CompiledConfig;
  const opts = classificationOptionsFor(active, candidate, { unchanged_epsilon_rel: 0.01, informational_direction_overrides: {} });
  assert.deepEqual(opts.configured, {
    a: { direction_of_better: 'lower', delta_min: 0.02 },
    b: { direction_of_better: 'higher', delta_min: 0.03 },
  });
  assert.equal(opts.epsilon, 0.01);
  const none = classificationOptionsFor({} as CompiledConfig, {} as CompiledConfig, { unchanged_epsilon_rel: 0.01, informational_direction_overrides: {} });
  assert.equal(none.configured, undefined);
});

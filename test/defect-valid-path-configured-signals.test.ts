// test/defect-valid-path-configured-signals.test.ts — defect found 2026-09-25:
// engine/gates/_health-valid-path.ts runFamilyAValidPath iterated the engine's hardcoded six-signal
// FAMILY_A_PRIMARY_SIGNALS instead of the compiled config's `family_a_signals` (the profile's
// sli_list). A profile-routed config for a non-LLM service got no valid-path verdict on its own
// signals, and a calibration series for one of the six LLM signals was still routed when the
// profile did not monitor it. The fix reads `family_a_signals` and falls back to the six only when
// the config carries none (the fallback the engine's primary Family A loops use).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, FiredSignal, HealthResult, Metrics } from '../dist/engine/types';
import { runFamilyAValidPath, VALID_PATH_ROLLBACK_PREFIX } from '../dist/engine/gates/_health-valid-path';
import { loadCfg, cellSeries, gauss } from './_c64-fixture';

const engine = require('../shared');
const { TrendBuffer } = engine;

function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}

/** Drive `n` canary ticks of `series` through the valid path, reading the terminal look on the last. */
function run(cfg: CompiledConfig, calibration: Record<string, number[]>, live: Record<string, number[]>, n: number) {
  const tb = new TrendBuffer(10);
  let result = emptyHealth();
  let rollback: FiredSignal[] = [];
  for (let i = 0; i < n; i++) {
    result = emptyHealth();
    rollback = [];
    const m = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v[i]])) as unknown as Metrics;
    runFamilyAValidPath(result, rollback, [], m, tb, {
      compiledConfig: cfg, terminalLook: i === n - 1,
      validPath: { calibration, ar1Phi: Object.fromEntries(Object.keys(calibration).map((k) => [k, 0])) },
    });
  }
  return { result, rollback };
}

const LAW = { mean: 0.01, sigma: 0.002 };
const N = 100;

test('defect 2026-09-25: the valid path routes a configured non-LLM signal', () => {
  const cfg = { ...loadCfg(), family_a_signals: ['http_5xx_rate'] } as CompiledConfig;
  const cal = { http_5xx_rate: cellSeries(LAW, 1, 500) };
  const live = { http_5xx_rate: cellSeries(LAW, 2, N, 0, 3) }; // a 3σ step from tick 0
  const { result, rollback } = run(cfg, cal, live, N);
  const v = (result.family_A_shadow ?? []).filter((x) => x.signal === 'http_5xx_rate');
  assert.equal(v.length, 1, 'one terminal verdict for the configured signal');
  assert.equal(v[0].verdict, 'fire');
  assert.ok(rollback.some((r) => r.id === VALID_PATH_ROLLBACK_PREFIX + 'http_5xx_rate'));
});

test('defect 2026-09-25: a calibrated LLM signal the config does not monitor is not routed', () => {
  const cfg = { ...loadCfg(), family_a_signals: ['http_5xx_rate'] } as CompiledConfig;
  const g = gauss(3);
  const cal = { http_5xx_rate: cellSeries(LAW, 1, 500), p99_latency: Array.from({ length: 500 }, () => 180 + g()) };
  const live = { http_5xx_rate: cellSeries(LAW, 4, N), p99_latency: Array.from({ length: N }, () => 400 + g()) };
  const { result } = run(cfg, cal, live, N);
  const signals = (result.family_A_shadow ?? []).map((x) => x.signal);
  assert.deepEqual(signals, ['http_5xx_rate']);
});

test('defect 2026-09-25: a config without family_a_signals keeps the six-signal default', () => {
  const base = loadCfg();
  const cfg = { ...base } as CompiledConfig;
  delete (cfg as { family_a_signals?: string[] }).family_a_signals;
  const g = gauss(5);
  const cal = { p99_latency: Array.from({ length: 500 }, () => 180 + g()), http_5xx_rate: cellSeries(LAW, 1, 500) };
  const live = { p99_latency: Array.from({ length: N }, () => 180 + g()), http_5xx_rate: cellSeries(LAW, 6, N) };
  const { result } = run(cfg, cal, live, N);
  const signals = (result.family_A_shadow ?? []).map((x) => x.signal);
  assert.deepEqual(signals, ['p99_latency']);
});

// test/c62b-e-by-effect-intervals.test.ts — C62 (b): the fused verdict reports e-BY effect-size
// intervals for the Family A mixture signals that fired, at E_BY_DELTA·|S|/K, re-inverted from
// the level-free inputs the engine (≥ v0.6.11-pre, ADR 0030) puts on each mixture verdict's
// evidence surface. Same config and driver as test/evidence-surface-live.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompiledConfig, DetectorVerdict, VerdictResult } from '../dist/engine/types';
import type { FusedVerdict } from '../dist/engine/types/verdict';
import { E_BY_DELTA, FAMILY_A_PLUGIN_ADVISORY_REASON } from '../dist/engine/guarantees';
import { mixtureConfidenceSequenceAt } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/mixture-confidence-sequence';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
const TICKS = 48;
const scenario = {
  id: 'e-by-live', riskLevel: 'critical', bakeHours: 84, author: 'human',
  changeType: 'model_weights', timeWindow: 'ok',
  flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  baseline: { p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0 },
};

function run(shift: (i: number, k: string, v: number) => number): { fused: FusedVerdict; shadow: DetectorVerdict[] } {
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const tb = new TrendBuffer(10);
  let last: VerdictResult | null = null;
  for (let i = 0; i < TICKS; i++) {
    const live: Record<string, number> = {};
    for (const [k, v] of Object.entries(scenario.baseline)) live[k] = shift(i, k, v * (1 + 0.01 * Math.sin(i / 3)));
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    last = orchestrate({
      liveMetrics: live, scenario, hoursElapsed: i * (scenario.bakeHours / TICKS),
      trendBuffer: tb, tick: i, totalTicks: TICKS, compiledConfig: cfg,
      currentHourOfDay: 20, currentDayOfWeek: 3,
    }) as VerdictResult;
  }
  return { fused: last!.gateResults.fusion as unknown as FusedVerdict, shadow: (last!.healthResult?.family_A_shadow ?? []) as DetectorVerdict[] };
}

test('C62 (b): a quiet run reports effect_intervals with K = the mixture signals and no interval', () => {
  const { fused, shadow } = run((_i, _k, v) => v);
  const withCs = shadow.filter((v) => v.evidence?.confidence_sequence);
  assert.ok(withCs.length > 0, 'the mixture verdicts should carry a confidence sequence at this pin');
  assert.ok(fused.effect_intervals, 'effect_intervals should be present');
  assert.equal(fused.effect_intervals!.K, withCs.length);
  assert.equal(fused.effect_intervals!.delta, E_BY_DELTA);
  assert.equal(fused.effect_intervals!.selected_count, withCs.filter((v) => v.verdict === 'fire' && v.reason_code !== FAMILY_A_PLUGIN_ADVISORY_REASON).length);
  assert.equal(fused.effect_intervals!.intervals.length, fused.effect_intervals!.selected_count);
});

test('C62 (b): a fired mixture signal gets its interval at E_BY_DELTA·|S|/K, equal to the re-inversion of its level-free inputs', () => {
  // a large persistent step on p99_latency from tick 8 so the mixture fires
  const { fused, shadow } = run((i, k, v) => (k === 'p99_latency' && i >= 8 ? v * 1.6 : v));
  const withCs = shadow.filter((v) => v.evidence?.confidence_sequence);
  const fired = withCs.filter((v) => v.verdict === 'fire' && v.reason_code !== FAMILY_A_PLUGIN_ADVISORY_REASON);
  assert.ok(fired.some((v) => v.signal === 'p99_latency'), `p99_latency should have fired: ${JSON.stringify(withCs.map((v) => [v.signal, v.verdict, v.reason_code]))}`);
  const ei = fused.effect_intervals!;
  assert.equal(ei.selected_count, fired.length);
  assert.ok(Math.abs(ei.alpha_i - E_BY_DELTA * fired.length / withCs.length) < 1e-15);
  for (const v of fired) {
    const iv = ei.intervals.find((x) => x.signal === v.signal)!;
    const cs = mixtureConfidenceSequenceAt(v.evidence!.confidence_sequence!.level_free, ei.alpha_i);
    assert.ok(Math.abs(iv.half_width - cs.half_width) < 1e-12 && Math.abs(iv.center - cs.center) < 1e-12, v.signal ?? "");
    // wider than the detector's own interval at its fire alpha only when alpha_i < alpha; either way it is the level-free family
    assert.ok(iv.lower < iv.upper);
  }
  assert.match(ei.guarantee, /Thm 13\.7/);
});

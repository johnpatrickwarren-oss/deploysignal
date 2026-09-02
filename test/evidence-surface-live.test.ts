// test/evidence-surface-live.test.ts — the engine half of ADR 0027 is now
// pinned (engine v0.6.8-pre). test/evidence-surface-consumer.test.ts
// proves the consumer with hand-built verdicts; this file drives the
// real Family A betting e-process through the health gate (orchestrate →
// evaluateHealth → engine/gates/_health-detectors.ts runFamilyABetting)
// and checks that the surface arrives on the verdict and reaches
// `evidence_outlook`. Same config and cell pinning as family-a-parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompiledConfig, DetectorVerdict, VerdictResult, FusedVerdict } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
const TICKS = 48;

const scenario = {
  id: 'evidence-live', riskLevel: 'critical', bakeHours: 84, author: 'human',
  changeType: 'model_weights', timeWindow: 'ok',
  flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  baseline: { p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0 },
};

test('ADR 0027 live: Family A betting verdicts carry `evidence`; outlook gains nats_to_threshold', () => {
  const cfg: CompiledConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const tb = new TrendBuffer(10);
  let last: VerdictResult | null = null;
  for (let i = 0; i < TICKS; i++) {
    const live: Record<string, number> = {};
    for (const [k, v] of Object.entries(scenario.baseline)) live[k] = v * (1 + 0.01 * Math.sin(i / 3));
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    last = orchestrate({
      liveMetrics: live, scenario, hoursElapsed: i * (scenario.bakeHours / TICKS),
      trendBuffer: tb, tick: i, totalTicks: TICKS, compiledConfig: cfg,
      currentHourOfDay: 20, currentDayOfWeek: 3,
    }) as VerdictResult;
  }
  const shadow = (last!.healthResult?.family_A_shadow ?? []) as DetectorVerdict[];
  // runFamilyABetting appends the betting block after the Page-CUSUM block,
  // one verdict per signal each, so the second half is the betting detector.
  assert.ok(shadow.length > 0 && shadow.length % 2 === 0, `family_A_shadow length ${shadow.length}`);
  const betting = shadow.slice(shadow.length / 2);
  for (const v of betting) {
    assert.ok(v.evidence, `betting ${v.signal} (${v.verdict}/${v.reason_code}) has no evidence`);
    assert.equal(typeof v.evidence.bet, 'number', `betting ${v.signal} bet should be numeric`);
    assert.equal(typeof v.evidence.nats_to_threshold, 'number');
    assert.ok(['ville', 'bootstrap'].includes(v.evidence.threshold_kind!), String(v.evidence.threshold_kind));
  }
  // gateResults.fusion is typed with the engine package's FusedVerdict;
  // evidence_outlook is this repo's extension (engine/types/verdict.ts).
  const fused = last!.gateResults.fusion as unknown as FusedVerdict;
  const a = fused.evidence_outlook.find((x) => x.family_id === 'A')!;
  assert.equal(a.progress_scale, 'wealth');
  assert.ok('nats_to_threshold' in a, `A outlook lacks nats_to_threshold: ${JSON.stringify(a)}`);
  assert.equal(typeof a.nats_to_threshold, 'number');
});

// test/defect-low-traffic-relative.test.ts — defect found 2026-09-25: the `low_traffic` extend
// rule (engine/gates/_health-defs.ts EXTEND_DEFS) returned `traffic_pct < 0.60`, an absolute
// share. A canary at its planned 10% slice therefore extended on every tick, and computeVerdict
// never reaches `proceed` while an extend signal is present (engine/core.ts computeVerdict), so
// such a canary could never pass. Every other rule in the table compares live against the
// baseline; the fix does the same: low traffic is live traffic_pct below 0.60 × the baseline's,
// and a baseline without a traffic_pct cannot say traffic is low.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Metrics, HealthResult } from '../dist/engine/types';
import { EXTEND_DEFS } from '../dist/engine/gates/_health-defs';
import { evaluateHealth } from '../dist/engine/gates/health';

const rule = EXTEND_DEFS.find((d) => d.id === 'low_traffic')!;
const POL = { thresholds: {}, warmup: { active: false, suppressedIds: [], grace: false, pct: 100 } } as never;
const check = (live: number | undefined, base: number | undefined): boolean =>
  !!rule.check({ traffic_pct: live } as unknown as Metrics, { traffic_pct: base } as unknown as Metrics, {} as never, POL, null);

test('defect 2026-09-25: a canary at its planned share is not low traffic', () => {
  assert.equal(check(0.10, 0.10), false, 'a 10% canary against a 10% plan');
  assert.equal(check(0.50, 0.50), false);
  assert.equal(check(0.07, 0.10), false, '70% of plan is above the 0.60 ratio');
});

test('defect 2026-09-25: traffic below 0.60 of the baseline share extends', () => {
  assert.equal(check(0.50, 1.0), true, 'the full-traffic case keeps its old answer');
  assert.equal(check(0.05, 0.10), true, 'half the planned canary share');
  assert.equal(check(0.59, 1.0), true);
  assert.equal(check(0.60, 1.0), false);
});

test('defect 2026-09-25: no baseline share, or no live share, cannot say traffic is low', () => {
  assert.equal(check(0.10, undefined), false);
  assert.equal(check(undefined, 1.0), false);
  assert.equal(check(0.10, 0), false);
});

test('defect 2026-09-25: the legacy shared.js table agrees with the gate', () => {
  const engine = require('../shared');
  const legacy = (engine.EXTEND_DEFS as Array<{ id: string; check: (m: unknown, b: unknown) => boolean }>).find((d) => d.id === 'low_traffic')!;
  for (const [live, base] of [[0.10, 0.10], [0.5, 1.0], [0.05, 0.10], [0.10, undefined]] as const) {
    assert.equal(!!legacy.check({ traffic_pct: live }, { traffic_pct: base }), check(live, base), `shared.js ${live}/${base}`);
  }
});

/** The clean demo scenario at a planned 10% canary share, every tick, through one engine. */
function runClean10(evaluateFn: (p: unknown) => { verdict: string; healthResult?: HealthResult | null }, TB: new (n: number) => unknown, total: number): { verdict: string; lowTrafficTicks: number } {
  const engine = require('../shared');
  const clean = (engine.SCENARIOS as Array<Record<string, any>>).find((x) => x.id === 'clean')!;
  const sc: Record<string, any> = { ...clean, baseline: { ...clean.baseline, traffic_pct: 0.10 } };
  const tb = new TB(10) as { push: (k: string, v: number) => void };
  let lowTrafficTicks = 0;
  for (let tick = 0; tick < total; tick++) {
    const live: Record<string, number> = { ...sc.baseline };
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const r = evaluateFn({ liveMetrics: live, scenario: sc, hoursElapsed: tick * (sc.bakeHours / total), trendBuffer: tb, tick, totalTicks: total });
    if ((r.healthResult?.extend ?? []).some((e) => e.id === 'low_traffic')) lowTrafficTicks++;
    if (r.verdict === 'proceed' || r.verdict === 'rollback') return { verdict: r.verdict, lowTrafficTicks };
  }
  return { verdict: 'extend', lowTrafficTicks };
}

test('defect 2026-09-25: a clean 10% canary on plan proceeds, in the Node engine and the browser bundle alike', async () => {
  const engine = require('../shared');
  const node = runClean10(engine.orchestrate, engine.TrendBuffer, engine.TOTAL_TICKS);
  assert.equal(node.lowTrafficTicks, 0);
  assert.equal(node.verdict, 'proceed');
  const browser = await import(require('node:path').join(__dirname, '..', 'engine', 'index.browser.js'));
  const b = runClean10(browser.evaluate, browser.TrendBuffer, browser.TOTAL_TICKS);
  assert.deepEqual(b, node, 'browser parity');
});

test('defect 2026-09-25: through evaluateHealth, a 10% canary on plan carries no low_traffic extend', () => {
  const m = { p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 0.10, eval_score: 0.92, tool_success_rate: 0.95 } as unknown as Metrics;
  const hr = evaluateHealth(m, m, { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true } as never, POL, null) as HealthResult;
  assert.ok(!hr.extend.some((e) => e.id === 'low_traffic'), JSON.stringify(hr.extend));
});

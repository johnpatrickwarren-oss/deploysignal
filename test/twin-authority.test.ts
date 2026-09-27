// test/twin-authority.test.ts — Plan B Task 5: TWIN_ARM_AUTHORITY = 'advisory', and no advisory
// twin verdict produces a rollback or a failed rollout on any surface DeploySignal serves.
//
// The same regressed canary (5xx odds ×3, latency +2σ) drives the engine's twin gate to `rollback`
// on every surface, and each surface is checked for the ways a rollback could leak out:
//   1. evaluateHealth — rollback[] stays empty (the report rides on HealthResult.twin_arm).
//   2. orchestrate() — the served verdict is never 'rollback', in cascade and portfolio topology,
//      no firing family and no alpha spent, even with Family A plug-ins, a 6σ LLM-signal shift and a
//      structural flag that roll the same deploy back without twin_arm (the control run).
//   3. the gate service — the tick body says "authority":"advisory"; the record's phase is never
//      rolled_back; GET /v1/verdict serves verdict_code 0 (never 1) at every tick, the real code only
//      on shadow_verdict_code and the twin verdict only on its `twin` block.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledConfig, HealthResult, Metrics, VerdictResult } from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import { TWIN_ARM_AUTHORITY, CONTRAST_ARM_AUTHORITY } from '../dist/engine/guarantees';
import type { TwinArmReport } from '../dist/engine/gates/_health-twin';
import { loadCfg, scenarioFor, canary, metricsAt, FLAGS, POLICY_CTX } from './_c64-fixture';
import { TWIN_PROFILE, twinTicks, toSnake } from './_twin-fixture';
import { start, stop, req, twinBody } from './_twin-http-harness';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const baseCfg = loadCfg();
const REGRESSED = { canaryOdds: 3, latencyShift: 2 };
const T = 60;

test('Plan B: TWIN_ARM_AUTHORITY is advisory, beside CONTRAST_ARM_AUTHORITY', () => {
  assert.equal(TWIN_ARM_AUTHORITY, 'advisory');
  assert.equal(CONTRAST_ARM_AUTHORITY, 'advisory');
});

test('Plan B authority: evaluateHealth never puts a twin rollback on rollback[]', () => {
  const cfg = { ...baseCfg, twin_arm: TWIN_PROFILE } as CompiledConfig;
  const base = scenarioFor(baseCfg).baseline as unknown as Metrics;
  const tb = new TrendBuffer(10);
  const next = twinTicks(11, REGRESSED);
  let seen = false;
  for (let t = 0; t < T; t++) {
    const hr = evaluateHealth(base, base, FLAGS, POLICY_CTX as never, tb, { compiledConfig: cfg, twinArm: next() }) as HealthResult & { twin_arm?: TwinArmReport };
    assert.deepEqual(hr.rollback, []);
    if (hr.twin_arm!.engine_verdict === 'rollback') seen = true;
  }
  assert.ok(seen, 'the engine did reach rollback (else the test proves nothing)');
});

function runOrchestrate(cfg: CompiledConfig, topology: 'cascade' | 'portfolio', withTwin: boolean): VerdictResult[] {
  const sc = { ...scenarioFor(baseCfg), flags: { ...FLAGS, provenance: true } };
  const traj = canary(baseCfg, 3, T, ['p99_latency', 'ttft', 'downstream_err'], 6);
  const tb = new TrendBuffer(10);
  const next = twinTicks(11, REGRESSED);
  const out: VerdictResult[] = [];
  for (let i = 0; i < T; i++) {
    const m = metricsAt(baseCfg, traj, i) as Record<string, number>;
    for (const k of Object.keys(m)) tb.push(k, m[k]);
    out.push(orchestrate({
      liveMetrics: m, scenario: sc, hoursElapsed: i * (sc.bakeHours / T), trendBuffer: tb, tick: i, totalTicks: T,
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, fusionTopology: topology,
      ...(withTwin ? { twinArm: next() } : {}),
    }) as VerdictResult);
  }
  return out;
}

for (const topology of ['cascade', 'portfolio'] as const) {
  test(`Plan B authority: orchestrate (${topology}) never serves a twin rollback; the same deploy rolls back without twin_arm`, () => {
    const control = runOrchestrate(baseCfg, topology, false);
    assert.ok(control.some((r) => r.verdict === 'rollback'), 'control: the deploy rolls back without twin_arm');

    const twin = runOrchestrate({ ...baseCfg, twin_arm: TWIN_PROFILE } as CompiledConfig, topology, true);
    const reports = twin.map((r) => (r.healthResult as HealthResult & { twin_arm?: TwinArmReport } | null)?.twin_arm);
    assert.ok(reports.some((x) => x?.engine_verdict === 'rollback'), 'the twin gate reached rollback');
    for (const r of twin) {
      assert.notEqual(r.verdict, 'rollback');
      if (r.healthResult) assert.deepEqual(r.healthResult.rollback, []);
      const fusion = r.gateResults?.fusion as { firing_families?: string[]; total_alpha_spent?: number } | undefined;
      if (fusion) {
        assert.deepEqual(fusion.firing_families ?? [], []);
        assert.equal(fusion.total_alpha_spent ?? 0, 0);
      }
    }
  });
}

test('Plan B authority: the gate service records a twin rollback without rolling back or failing the rollout', async () => {
  const s = await start();
  try {
    const created = await req(s.baseUrl, 'POST', '/v1/sessions', twinBody(TWIN_PROFILE as never, { deploy_ref: 'rev-auth' }));
    const id = created.json.session_id;
    const next = twinTicks(11, REGRESSED);
    let last: any;
    for (let t = 0; t < T; t++) {
      last = (await req(s.baseUrl, 'POST', `/v1/sessions/${id}/ticks`, toSnake(next()))).json;
      assert.equal(last.authority, 'advisory');
      const v = await req(s.baseUrl, 'GET', '/v1/verdict/rev-auth');
      assert.equal(v.status, 200);
      assert.equal(v.json.verdict_code, 0, 'the served code is never 1 (Failed) or -1');
      assert.notEqual(v.json.verdict, 'rollback');
      assert.equal(v.json.twin.authority, 'advisory');
      assert.notEqual(s.handle.store.getSession(id)!.deployment.phase, 'rolled_back');
      if (last.engine_verdict !== 'extend') break;
    }
    assert.equal(last.verdict, 'rollback');
    const v = await req(s.baseUrl, 'GET', '/v1/verdict/rev-auth');
    assert.equal(v.json.twin.verdict, 'rollback');
    assert.equal(v.json.shadow_verdict_code, 1, 'the real code is recorded on shadow_verdict_code only');
    assert.equal(v.json.verdict_code, 0);
  } finally { await stop(s); }
});

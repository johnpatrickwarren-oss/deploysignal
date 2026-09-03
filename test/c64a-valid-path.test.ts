// test/c64a-valid-path.test.ts — WORKLIST C64 (a): the envelope-valid terminal path.
//
// The C64 (d) power study (studies/valid-path-power, run 2026-09-03T18182Z; knowledge
// stats/valid-path-power-2026-09-03) routed safe-t at known φ: 1.0000 at the K1 canonical 1.5σ
// on the 100-tick canary, 0/524 null crossings at α = 0.05. This file pins the routing:
//   1. Byte-identity: without `validPath` the health gate's output is deep-equal to before.
//   2. Pre-terminal ticks arm the path (`clean` / safe_t_terminal_pending) without extending.
//   3. The terminal look fires on a 3σ step (rollback id family_A_safe_t_{signal}) and stays
//      clean on healthy data; α is the full per-signal Family A allocation.
//   4. An estimated φ below the 100-sample calibration floor is refused, not run.
//   5. The audit record names the fire by the registry id safe_t_e_value_{signal}.
//   6. End to end through orchestrate(): the terminal verdict is `rollback` on a shifted
//      signal and `proceed` on a clean one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompiledConfig, DetectorVerdict, FiredSignal, HealthResult, Metrics, VerdictResult,
} from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import {
  runFamilyAValidPath, terminalSafeTVerdict, validPathAlpha, VALID_PATH_REASON,
  VALID_PATH_ROLLBACK_PREFIX,
} from '../dist/engine/gates/_health-valid-path';
import { buildAuditRecord } from '../dist/engine/audit';
import { fuseVerdict } from '../dist/engine/verdict';
import type { AuditRecordV2 } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v2-with-family-a.json');
const cfg = (): CompiledConfig => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// mulberry32, the calibrators' own primitive — no Math.random in a test that pins a verdict.
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BASE = 185, JIT = 0.008;   // p99_latency, corpus jitter model
function series(seed: number, n: number, shiftAfter = Infinity, shiftSigma = 0): number[] {
  const r = mulberry32(seed);
  const sigma = BASE * JIT / Math.sqrt(12);
  return Array.from({ length: n }, (_, t) => BASE * (1 + JIT * r()) + (t >= shiftAfter ? shiftSigma * sigma : 0));
}
const CAL = series(1, 500);
const scenario = {
  id: 'c64a', riskLevel: 'critical', bakeHours: 84, author: 'human',
  changeType: 'model_weights', timeWindow: 'ok',
  flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  baseline: { p99_latency: BASE, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0 },
};
const policyCtx = { thresholds: {}, warmup: { active: false, suppressedIds: [], grace: false, pct: 100 } } as unknown as Parameters<typeof evaluateHealth>[3];
function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}
const live = (p99: number): Metrics => ({ ...scenario.baseline, p99_latency: p99 } as unknown as Metrics);

// ── 1. byte-identity ────────────────────────────────────────────────

test('C64 (a): without validPath the health gate output is unchanged', () => {
  const c = cfg();
  const run = (withPath: boolean) => {
    const tb = new TrendBuffer(10);
    let last: HealthResult | null = null;
    for (let i = 0; i < 12; i++) {
      const m = live(BASE * (1 + 0.01 * Math.sin(i / 3)));
      for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
      last = evaluateHealth(m, scenario.baseline as unknown as Metrics, scenario.flags, policyCtx, tb, {
        compiledConfig: c, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
        ...(withPath ? { validPath: { calibration: { p99_latency: CAL }, ar1Phi: { p99_latency: 0 } }, terminalLook: i === 11 } : {}),
      });
    }
    return last!;
  };
  const plain = run(false), routed = run(true);
  const plainA = plain.family_A_shadow ?? [], routedA = routed.family_A_shadow ?? [];
  assert.ok(plainA.length > 0, 'Family A is compiled for the cell');
  assert.deepEqual(routedA.slice(0, plainA.length), plainA, 'the plug-in verdicts are byte-identical with the path routed');
  assert.equal(routedA.length, plainA.length + 1, 'exactly one valid-path verdict appended for the one routed signal');
  assert.ok(!plainA.some((v) => v.reason_code.startsWith('safe_t_')), 'no safe-t verdict without validPath');
});

// ── 2–4. the module itself ───────────────────────────────────────────

test('C64 (a): pre-terminal ticks arm the path as clean/pending, never indeterminate', () => {
  const tb = new TrendBuffer(10);
  const result = emptyHealth();
  const rollback: FiredSignal[] = [];
  for (let i = 0; i < 5; i++) {
    runFamilyAValidPath(result, rollback, [], live(BASE), tb, {
      compiledConfig: cfg(), validPath: { calibration: { p99_latency: CAL }, ar1Phi: { p99_latency: 0 } }, terminalLook: false,
    });
  }
  const vs = result.family_A_shadow ?? [];
  assert.equal(vs.length, 5);
  for (const v of vs) {
    assert.equal(v.verdict, 'clean');
    assert.equal(v.reason_code, VALID_PATH_REASON.pending);
    assert.equal(v.statistic, null);
    assert.equal(v.alpha_spent, 0);
  }
  assert.deepEqual(rollback, []);
});

test('C64 (a): the terminal look fires on a 3σ step and stays clean on healthy data; α is the per-signal allocation', () => {
  const c = cfg();
  const alpha = validPathAlpha(c);
  assert.equal(alpha, (c.alpha_budget.per_family.A ?? 4e-4) / (c.bonferroni_factor ?? 6));
  const fired = terminalSafeTVerdict('p99_latency', CAL, series(2, 100, 30, 3), alpha, 0);
  assert.equal(fired.verdict, 'fire');
  assert.equal(fired.reason_code, VALID_PATH_REASON.fire);
  assert.equal(fired.threshold, 1 / alpha);
  assert.ok((fired.statistic ?? 0) >= 1 / alpha);
  assert.equal(fired.alpha_spent, alpha);
  assert.equal(fired.family, 'A');
  const clean = terminalSafeTVerdict('p99_latency', CAL, series(3, 100), alpha, 0);
  assert.equal(clean.verdict, 'clean');
  assert.equal(clean.reason_code, VALID_PATH_REASON.clean);
  assert.equal(clean.alpha_spent, 0);
  assert.ok((clean.statistic ?? 1e9) < 1 / alpha);
});

test('C64 (a): an estimated φ with calibration below the 100-sample floor is refused, not run', () => {
  const alpha = validPathAlpha(cfg());
  const short = terminalSafeTVerdict('p99_latency', CAL.slice(0, 50), series(2, 100, 30, 3), alpha, undefined);
  assert.equal(short.verdict, 'suppressed');
  assert.equal(short.reason_code, VALID_PATH_REASON.belowFloor);
  // the same calibration with a KNOWN φ is inside the envelope (minCalibration 3)
  const known = terminalSafeTVerdict('p99_latency', CAL.slice(0, 50), series(2, 100, 30, 3), alpha, 0);
  assert.equal(known.verdict, 'fire');
});

test('C64 (a): a terminal fire pushes family_A_safe_t_{signal} into rollback and the series persists on the TrendBuffer', () => {
  const tb = new TrendBuffer(10);
  const result = emptyHealth();
  const rollback: FiredSignal[] = [];
  const canary = series(2, 100, 30, 3);
  for (let t = 0; t < 100; t++) {
    runFamilyAValidPath(result, rollback, [], live(canary[t]), tb, {
      compiledConfig: cfg(), validPath: { calibration: { p99_latency: CAL }, ar1Phi: { p99_latency: 0 } }, terminalLook: t === 99,
    });
  }
  const shadow = result.family_A_shadow ?? [];
  const last = shadow[shadow.length - 1];
  assert.equal(last.verdict, 'fire');
  assert.equal(last.signal, 'p99_latency');
  assert.deepEqual(rollback.map((s) => s.id), [VALID_PATH_ROLLBACK_PREFIX + 'p99_latency']);
  const stored = (tb as unknown as { validPathSeries: Record<string, number[]> }).validPathSeries.p99_latency;
  assert.equal(stored.length, 100, 'the full canary, not the 10-tick rolling view');
});

// ── 5. audit attribution ────────────────────────────────────────────

test('C64 (a): the audit record names a valid-path fire by safe_t_e_value_{signal}', () => {
  const alpha = validPathAlpha(cfg());
  const v = terminalSafeTVerdict('p99_latency', CAL, series(2, 100, 30, 3), alpha, 0);
  assert.equal(v.verdict, 'fire');
  const hr: HealthResult = { ...emptyHealth(), family_A_shadow: [v], rollback: [{ id: VALID_PATH_ROLLBACK_PREFIX + 'p99_latency', label: 'Family A safe-t p99_latency' }] };
  const params = {
    liveMetrics: live(BASE), scenario, hoursElapsed: 84, tick: 99, totalTicks: 100, fusionTopology: 'portfolio' as const,
    compiledConfig: cfg(), currentHourOfDay: 20, currentDayOfWeek: 3,
  };
  const fused = fuseVerdict(hr, { topology: 'portfolio', tick: 99, totalTicks: 100, deployRef: 'c64a' });
  assert.equal(fused.verdict, 'rollback');
  assert.deepEqual(fused.firing_families, ['A']);
  assert.equal(fused.total_alpha_spent, alpha);
  const rec = buildAuditRecord(params as unknown as Parameters<typeof buildAuditRecord>[0],
    { verdict: 'rollback', reason: 'x', gateResults: { health: hr, fusion: fused }, healthResult: hr, shortCircuit: null } as unknown as VerdictResult, null) as AuditRecordV2;
  const a = rec.families.A;
  assert.equal(a.verdict, 'fire');
  assert.deepEqual(a.detectors.map((d) => d.detector_id), ['safe_t_e_value_p99_latency']);
  assert.equal(a.detectors[0].alpha_spent, alpha);
  assert.equal(a.alpha_spent, alpha);
});

// ── 6. end to end ───────────────────────────────────────────────────

for (const [label, shift, expected] of [['a 3σ step from tick 30', 3, 'rollback'], ['healthy data', 0, 'proceed']] as const) {
  test(`C64 (a) end to end: orchestrate() with validPath ends ${expected} on ${label}`, () => {
    const c = cfg();
    const tb = new TrendBuffer(10);
    const canary = series(7, 100, shift > 0 ? 30 : Infinity, shift);
    let last: VerdictResult | null = null;
    for (let i = 0; i < 100; i++) {
      const m = live(canary[i]);
      for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
      last = orchestrate({
        liveMetrics: m, scenario, hoursElapsed: i * (scenario.bakeHours / 100),
        trendBuffer: tb, tick: i, totalTicks: 100, compiledConfig: c, fusionTopology: 'portfolio',
        currentHourOfDay: 20, currentDayOfWeek: 3,
        validPath: { calibration: { p99_latency: CAL }, ar1Phi: { p99_latency: 0 } },
      }) as VerdictResult;
      if (i < 99 && last.verdict === 'rollback') {
        // the plug-ins may fire before the terminal look on the 3σ arm; the path itself must not
        const ids = last.healthResult!.rollback.map((s) => s.id);
        assert.ok(!ids.some((id) => id.startsWith(VALID_PATH_ROLLBACK_PREFIX)), `valid path fired before the terminal tick: ${ids}`);
        return;   // an earlier plug-in rollback ends the deploy; nothing more to check here
      }
    }
    const ids = last!.healthResult!.rollback.map((s) => s.id);
    if (expected === 'rollback') {
      assert.ok(ids.includes(VALID_PATH_ROLLBACK_PREFIX + 'p99_latency'), `terminal rollback ids: ${ids}`);
      assert.equal(last!.verdict, 'rollback');
    } else {
      assert.ok(!ids.some((id) => id.startsWith(VALID_PATH_ROLLBACK_PREFIX)));
      assert.equal(last!.verdict, 'proceed');
    }
  });
}

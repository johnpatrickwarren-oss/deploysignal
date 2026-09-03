// test/c64a-valid-path.test.ts — WORKLIST C64 (a): the envelope-valid terminal path.
//
// The C64 (d) power study (studies/valid-path-power, run 2026-09-03T18182Z; knowledge
// stats/valid-path-power-2026-09-03) routed safe-t at known φ: 1.0000 at the K1 canonical 1.5σ
// on the 100-tick canary, 0/524 null crossings at α = 0.05. This file pins the routing:
//   1. Byte-identity: without `validPath` the plug-in block of the health gate is unchanged.
//   2. Pre-terminal ticks arm the path (`clean` / safe_t_terminal_pending) without extending.
//   3. The terminal look fires on a 3σ step (rollback id family_A_safe_t_{signal}) and stays
//      clean on healthy data; α is the full per-signal Family A allocation.
//   4. An estimated φ below the 100-sample calibration floor is refused, not run.
//   5. The audit record names the fire by the registry id safe_t_e_value_{signal}.
//   6. End to end through orchestrate(): healthy data ends `proceed` with the path clean; a
//      3σ step on the routed signal reaches `rollback` at the terminal look, on the valid path
//      (its plug-ins are advisory under C64 b).
// Fixture: every signal drawn from the compiled cell's own law (test/_c64-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DetectorVerdict, FiredSignal, HealthResult, VerdictResult } from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import {
  runFamilyAValidPath, terminalSafeTVerdict, validPathAlpha, VALID_PATH_REASON,
  VALID_PATH_ROLLBACK_PREFIX,
} from '../dist/engine/gates/_health-valid-path';
import { buildAuditRecord } from '../dist/engine/audit';
import { fuseVerdict } from '../dist/engine/verdict';
import type { AuditRecordV2 } from '../dist/engine/types';
import {
  loadCfg, cellLaw, cellSeries, canary, calibration, metricsAt, scenarioFor, FLAGS, POLICY_CTX,
} from './_c64-fixture';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];
const cfg = loadCfg();
const CAL = calibration(cfg);
const LAW = cellLaw(cfg);
const baseline = scenarioFor(cfg).baseline;

function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}
const routedOpts = { validPath: { calibration: { p99_latency: CAL.p99_latency }, ar1Phi: { p99_latency: 0 } } };

// ── 1. byte-identity ────────────────────────────────────────────────

test('C64 (a): without validPath the plug-in block of the health gate is unchanged', () => {
  const run = (withPath: boolean) => {
    const tb = new TrendBuffer(10);
    const traj = canary(cfg, 1, 12, [], 0);
    let last: HealthResult | null = null;
    for (let i = 0; i < 12; i++) {
      const m = metricsAt(cfg, traj, i);
      for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
      last = evaluateHealth(m, baseline as never, FLAGS, policyCtx, tb, {
        compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
        ...(withPath ? { ...routedOpts, terminalLook: i === 11 } : {}),
      });
    }
    return last!;
  };
  const plain = run(false), routed = run(true);
  const plainA = plain.family_A_shadow ?? [], routedA = routed.family_A_shadow ?? [];
  assert.ok(plainA.length > 0, 'Family A is compiled for the cell');
  // Unrouted signals: byte-identical. The routed signal's plug-in verdicts keep verdict /
  // statistic / threshold and may differ only in α and reason_code — C64 (b) makes them
  // advisory where the valid path is routed.
  const strip = (v: DetectorVerdict) => ({ verdict: v.verdict, statistic: v.statistic, threshold: v.threshold, signal: v.signal });
  assert.deepEqual(routedA.slice(0, plainA.length).filter((v) => v.signal !== 'p99_latency'), plainA.filter((v) => v.signal !== 'p99_latency'),
    'unrouted plug-in verdicts are byte-identical with the path routed');
  assert.deepEqual(routedA.slice(0, plainA.length).map(strip), plainA.map(strip), 'routed plug-in verdicts keep their statistics');
  assert.equal(routedA.length, plainA.length + 1, 'exactly one valid-path verdict appended for the one routed signal');
  assert.ok(!plainA.some((v) => v.reason_code.startsWith('safe_t_')), 'no safe-t verdict without validPath');
});

// ── 2–4. the module itself ───────────────────────────────────────────

test('C64 (a): pre-terminal ticks arm the path as clean/pending, never indeterminate', () => {
  const tb = new TrendBuffer(10);
  const result = emptyHealth();
  const rollback: FiredSignal[] = [];
  const traj = canary(cfg, 2, 5, [], 0);
  for (let i = 0; i < 5; i++) {
    runFamilyAValidPath(result, rollback, [], metricsAt(cfg, traj, i), tb, { compiledConfig: cfg, ...routedOpts, terminalLook: false });
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
  const alpha = validPathAlpha(cfg);
  assert.equal(alpha, (cfg.alpha_budget.per_family.A ?? 4e-4) / (cfg.bonferroni_factor ?? 6));
  const fired = terminalSafeTVerdict('p99_latency', CAL.p99_latency, cellSeries(LAW.p99_latency, 3, 100, 30, 3), alpha, 0);
  assert.equal(fired.verdict, 'fire');
  assert.equal(fired.reason_code, VALID_PATH_REASON.fire);
  assert.equal(fired.threshold, 1 / alpha);
  assert.ok((fired.statistic ?? 0) >= 1 / alpha);
  assert.equal(fired.alpha_spent, alpha);
  assert.equal(fired.family, 'A');
  const clean = terminalSafeTVerdict('p99_latency', CAL.p99_latency, cellSeries(LAW.p99_latency, 4, 100), alpha, 0);
  assert.equal(clean.verdict, 'clean');
  assert.equal(clean.reason_code, VALID_PATH_REASON.clean);
  assert.equal(clean.alpha_spent, 0);
  assert.ok((clean.statistic ?? 1e9) < 1 / alpha);
});

test('C64 (a): an estimated φ with calibration below the 100-sample floor is refused, not run', () => {
  const alpha = validPathAlpha(cfg);
  const shifted = cellSeries(LAW.p99_latency, 3, 100, 30, 3);
  const short = terminalSafeTVerdict('p99_latency', CAL.p99_latency.slice(0, 50), shifted, alpha, undefined);
  assert.equal(short.verdict, 'suppressed');
  assert.equal(short.reason_code, VALID_PATH_REASON.belowFloor);
  // the same calibration with a KNOWN φ is inside the envelope (minCalibration 3)
  const known = terminalSafeTVerdict('p99_latency', CAL.p99_latency.slice(0, 50), shifted, alpha, 0);
  assert.equal(known.verdict, 'fire');
});

test('C64 (a): a terminal fire pushes family_A_safe_t_{signal} into rollback and the series persists on the TrendBuffer', () => {
  const tb = new TrendBuffer(10);
  const result = emptyHealth();
  const rollback: FiredSignal[] = [];
  const traj = canary(cfg, 5, 100, ['p99_latency'], 3);
  for (let t = 0; t < 100; t++) {
    runFamilyAValidPath(result, rollback, [], metricsAt(cfg, traj, t), tb, { compiledConfig: cfg, ...routedOpts, terminalLook: t === 99 });
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
  const alpha = validPathAlpha(cfg);
  const v = terminalSafeTVerdict('p99_latency', CAL.p99_latency, cellSeries(LAW.p99_latency, 3, 100, 30, 3), alpha, 0);
  assert.equal(v.verdict, 'fire');
  const hr: HealthResult = { ...emptyHealth(), family_A_shadow: [v], rollback: [{ id: VALID_PATH_ROLLBACK_PREFIX + 'p99_latency', label: 'Family A safe-t p99_latency' }] };
  const params = {
    liveMetrics: metricsAt(cfg, canary(cfg, 6, 1, [], 0), 0), scenario: scenarioFor(cfg), hoursElapsed: 84, tick: 99, totalTicks: 100,
    fusionTopology: 'portfolio' as const, compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3,
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

function driveOrchestrate(seed: number, shift: number): { last: VerdictResult; firstRollback: { tick: number; ids: string[] } | null } {
  const tb = new TrendBuffer(10);
  const traj = canary(cfg, seed, 100, shift > 0 ? ['p99_latency'] : [], shift);
  const scenario = scenarioFor(cfg);
  let last: VerdictResult | null = null, firstRollback: { tick: number; ids: string[] } | null = null;
  for (let i = 0; i < 100; i++) {
    const m = metricsAt(cfg, traj, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    last = orchestrate({
      liveMetrics: m, scenario, hoursElapsed: i * (scenario.bakeHours / 100),
      trendBuffer: tb, tick: i, totalTicks: 100, compiledConfig: cfg, fusionTopology: 'portfolio',
      currentHourOfDay: 20, currentDayOfWeek: 3, ...routedOpts,
    }) as VerdictResult;
    if (firstRollback === null && last.verdict === 'rollback') firstRollback = { tick: i, ids: last.healthResult!.rollback.map((s) => s.id) };
  }
  return { last: last!, firstRollback };
}

test('C64 (a) end to end: healthy data ends proceed with the routed path clean and no rollback anywhere', () => {
  const { last, firstRollback } = driveOrchestrate(8, 0);
  assert.equal(firstRollback, null, `unexpected rollback: ${JSON.stringify(firstRollback)}`);
  assert.equal(last.verdict, 'proceed');
  const shadow = (last.healthResult!.family_A_shadow ?? []) as DetectorVerdict[];
  const st = shadow.find((v) => v.reason_code.startsWith('safe_t_'))!;
  assert.equal(st.verdict, 'clean');
  assert.equal(st.reason_code, VALID_PATH_REASON.clean);
});

test('C64 (a) end to end: a 3σ step on the routed signal is a rollback at the terminal look, on the valid path (its plug-ins are advisory under C64 b)', () => {
  const { last, firstRollback } = driveOrchestrate(9, 3);
  assert.ok(firstRollback !== null, 'the step was detected');
  assert.equal(firstRollback!.tick, 99, `first rollback tick ${firstRollback!.tick}: ${firstRollback!.ids}`);
  assert.ok(firstRollback!.ids.includes(VALID_PATH_ROLLBACK_PREFIX + 'p99_latency'), `rollback ids: ${firstRollback!.ids}`);
  assert.equal(last.verdict, 'rollback');
});

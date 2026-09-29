// test/twin-health-path.test.ts — Plan B Task 3: engine/gates/_health-twin.ts, the gate path that
// wraps the engine's stepTwinGate (engine ADR 0036), and evaluateHealth's twin-only routing.
//
// Pins:
//   1. The verdict map: rollback→rollback, proceed→proceed, extend→extend, inconclusive→hold,
//      invalid_experiment→halt.
//   2. The profile block converts field for field to the engine's TwinGateConfig, and the engine's
//      refusals (a sign metric at weight ≠ 0.5) reach the profile loader.
//   3. A regressed canary reaches engine `rollback`; an A/A pair never does over max_ticks; the
//      report is snake_case, carries authority 'advisory', and ticks_to_detect once computable.
//   4. A compiled config with twin_arm runs ONLY the twin path: the structural rules that fire
//      without it push nothing, Families A/C/D/E write nothing, and the state rides the TrendBuffer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import type { CompiledConfig, HealthResult, Metrics } from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import {
  TWIN_VERDICT_MAP, twinGateConfig, freshTwinArm, stepTwinArm, ticksToDetectFor, type TwinArmReport,
} from '../dist/engine/gates/_health-twin';
import { TWIN_ARM_AUTHORITY } from '../dist/engine/guarantees';
import { loadProfile } from '../tools/profile-loader';
import { ticksToDetect } from '@johnpatrickwarren-oss/deploysignal-engine/per-shard/twin-planning';
import { loadCfg, scenarioFor, FLAGS, POLICY_CTX } from './_c64-fixture';
import { TWIN_PROFILE, twinTicks } from './_twin-fixture';
import { guaranteeFor } from '@johnpatrickwarren-oss/deploysignal-engine/guarantees';

const engine = require('../shared');
const { TrendBuffer } = engine;
const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];

test('Plan B: the twin verdict map is the contract', () => {
  assert.deepEqual({ ...TWIN_VERDICT_MAP }, {
    rollback: 'rollback', proceed: 'proceed', extend: 'extend', inconclusive: 'hold', invalid_experiment: 'halt',
  });
  assert.equal(TWIN_ARM_AUTHORITY, 'advisory');
});

test('Plan B: twinGateConfig converts the profile block field for field', () => {
  const cfg = twinGateConfig({ ...TWIN_PROFILE, allow_unequal_rate_split: true });
  assert.deepEqual(cfg, {
    metrics: TWIN_PROFILE.metrics.map((m) => ({ id: m.id, kind: m.kind, worse: m.worse, tolerance: m.tolerance })),
    alphaRollback: 0.05, alphaProceed: 0.05, alphaSrm: 0.001, canaryWeight: 0.5, maxTicks: 120,
    allowUnequalRateSplit: true,
  });
  assert.equal('allowUnequalRateSplit' in twinGateConfig(TWIN_PROFILE), false);
});

test('Plan B: the loader refuses a twin profile the engine refuses (sign metric at weight 0.3)', () => {
  const dir = path.resolve(__dirname, '..', 'profiles');
  const raw = yaml.load(fs.readFileSync(path.join(dir, 'twin-generic.yaml'), 'utf8')) as Record<string, any>;
  raw.id = 'zz-test-twin-bad-weight';
  raw.twin_arm.canary_weight = 0.3;
  const tmp = path.join(dir, 'zz-test-twin-bad-weight.yaml');
  fs.writeFileSync(tmp, yaml.dump(raw));
  try {
    assert.throws(() => loadProfile('zz-test-twin-bad-weight@1.0.0'), /equal routing weights/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

function drive(seed: number, spec: Parameters<typeof twinTicks>[1], ticks: number): TwinArmReport[] {
  const next = twinTicks(seed, spec);
  let run = freshTwinArm(TWIN_PROFILE);
  const out: TwinArmReport[] = [];
  for (let t = 0; t < ticks; t++) {
    const step = stepTwinArm(TWIN_PROFILE, run, next());
    run = step.run;
    out.push(step.report);
  }
  return out;
}

test('Plan B: a regressed canary (5xx odds ×3, latency +2σ) reaches engine rollback, advisory', () => {
  const reports = drive(11, { canaryOdds: 3, latencyShift: 2 }, 60);
  const hit = reports.find((r) => r.engine_verdict === 'rollback');
  assert.ok(hit, `no rollback in 60 ticks: last ${JSON.stringify(reports[59].engine_verdict)}`);
  assert.equal(hit!.verdict, 'rollback');
  assert.equal(hit!.authority, 'advisory');
  assert.deepEqual(Object.keys(hit!.metrics[0]).sort(),
    ['detector_id', 'id', 'missing', 'proceed_e', 'proceed_threshold', 'rollback_e', 'rollback_threshold', 'skipped', 'ties', 'used'].sort());
  assert.equal(hit!.metrics[0].detector_id, `twin_${TWIN_PROFILE.metrics[0].kind}_${TWIN_PROFILE.metrics[0].id}`);
  assert.deepEqual(guaranteeFor(hit!.metrics[0].detector_id)!.idPrefixes, [`twin_${TWIN_PROFILE.metrics[0].kind}_`]);
  assert.equal(hit!.metrics[0].rollback_threshold, 3 / 0.05);
  // Terminal verdicts are sticky: the tick after returns the same verdict.
  const after = reports[reports.indexOf(hit!) + 1];
  if (after) assert.equal(after.engine_verdict, 'rollback');
});

test('Plan B: an A/A pair never rolls back across max_ticks (seeded)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const reports = drive(seed, {}, TWIN_PROFILE.max_ticks);
    assert.ok(reports.every((r) => r.engine_verdict !== 'rollback'), `seed ${seed} rolled back`);
    assert.ok(['proceed', 'inconclusive', 'extend'].includes(reports[reports.length - 1].engine_verdict));
  }
});

test('Plan B: a missing metric while the canary takes traffic counts as missing (½ penalty)', () => {
  const next = twinTicks(9);
  let run = freshTwinArm(TWIN_PROFILE);
  const tick = next();
  delete tick.observations.p99_latency_ms;
  const { report } = stepTwinArm(TWIN_PROFILE, run, tick);
  const lat = report.metrics.find((m) => m.id === 'p99_latency_ms')!;
  assert.equal(lat.missing, 1);
  assert.equal(lat.rollback_e, 0.5);
  run = freshTwinArm(TWIN_PROFILE);
  assert.equal(run.state.tick, 0);
});

test('Plan B: ticks_to_detect is absent until computable, then the max over metrics at α_rollback / N', () => {
  const run0 = freshTwinArm(TWIN_PROFILE);
  assert.equal(ticksToDetectFor(TWIN_PROFILE, run0), undefined);
  const next = twinTicks(21);
  let run = run0;
  let last: TwinArmReport | undefined;
  for (let t = 0; t < 10; t++) { const s = stepTwinArm(TWIN_PROFILE, run, next()); run = s.run; last = s.report; }
  const alpha = 0.05 / 3;
  const badPerTick = (m: 'http_5xx' | 'success'): number => run.planning[m].badEvents / run.planning[m].ticks;
  const lat = run.state.metrics.p99_latency_ms;
  const expected = Math.ceil(Math.max(
    ticksToDetect({ kind: 'rate', canaryShare: 0.5, oddsRatio: 1.2, badEventsPerTick: badPerTick('http_5xx'), alpha }),
    ticksToDetect({ kind: 'rate', canaryShare: 0.5, oddsRatio: 1.2, badEventsPerTick: badPerTick('success'), alpha }),
    ticksToDetect({ kind: 'sign', excessProbability: 0.15, tieRate: lat.ties / (lat.used + lat.ties), alpha }),
  ));
  assert.equal(last!.ticks_to_detect, expected);
  assert.ok(Number.isFinite(expected) && expected > 0);
});

// ── evaluateHealth: a twin profile runs only the twin path ────────────────────────────────────

const baseCfg = loadCfg();
const baseline = scenarioFor(baseCfg).baseline as unknown as Metrics;

function twinCfg(): CompiledConfig {
  return { ...baseCfg, twin_arm: TWIN_PROFILE } as CompiledConfig;
}

test('Plan B: with twin_arm on the config, the structural rules and Families A/C/D/E do not run', () => {
  const flags = { ...FLAGS, provenance: true, contract: true };
  const tbCtl = new TrendBuffer(10);
  const control = evaluateHealth(baseline, baseline, flags, policyCtx, tbCtl, { compiledConfig: baseCfg, currentHourOfDay: 20, currentDayOfWeek: 3 });
  assert.ok(control.rollback.some((r) => r.id === 'provenance'), 'control: the provenance rule fires without twin_arm');

  const tb = new TrendBuffer(10);
  const next = twinTicks(5, { canaryOdds: 3, latencyShift: 2 });
  let hr: HealthResult | undefined;
  const ticks: number[] = [];
  for (let t = 0; t < 40; t++) {
    hr = evaluateHealth(baseline, baseline, flags, policyCtx, tb, {
      compiledConfig: twinCfg(), currentHourOfDay: 20, currentDayOfWeek: 3, twinArm: next(),
    });
    assert.deepEqual(hr.rollback, [], 'nothing on rollback[]');
    assert.deepEqual(hr.extend, [], 'nothing on extend[]');
    assert.equal(hr.family_A_shadow, undefined);
    assert.equal((hr as any).family_C_verdict, undefined);
    assert.equal((hr as any).family_D_verdict, undefined);
    assert.equal((hr as any).family_E_verdict, undefined);
    ticks.push((hr as HealthResult & { twin_arm: TwinArmReport }).twin_arm.tick);
  }
  const block = (hr as HealthResult & { twin_arm?: TwinArmReport }).twin_arm!;
  assert.ok(block, 'the twin report lands on HealthResult.twin_arm');
  assert.equal(block.authority, 'advisory');
  assert.deepEqual(ticks.slice(0, 3), [1, 2, 3], 'the gate state persists on the TrendBuffer across ticks');
  assert.equal(block.engine_verdict, 'rollback');
  assert.equal(ticks[ticks.length - 1], block.tick, 'rollback is sticky: the tick stops advancing');
});

test('Plan B: twin_arm on the config without a tick input reports nothing and fires nothing', () => {
  const hr = evaluateHealth(baseline, baseline, { ...FLAGS, provenance: true }, policyCtx, new TrendBuffer(10), { compiledConfig: twinCfg() });
  assert.deepEqual(hr.rollback, []);
  assert.equal((hr as HealthResult & { twin_arm?: unknown }).twin_arm, undefined);
});

// Engine ADR 0037 through the wrapper: the margin reaches the engine's scoring.
function driveWith(profile: typeof TWIN_PROFILE, seed: number, spec: Parameters<typeof twinTicks>[1], ticks: number): TwinArmReport[] {
  const next = twinTicks(seed, spec);
  let run = freshTwinArm(profile);
  const out: TwinArmReport[] = [];
  for (let t = 0; t < ticks; t++) { const step = stepTwinArm(profile, run, next()); run = step.run; out.push(step.report); }
  return out;
}
const WITH_MARGIN = { ...TWIN_PROFILE, metrics: TWIN_PROFILE.metrics.map((m) => (m.kind === 'sign' ? { ...m, margin: { relative: 0.10 } } : m)) };

test('ADR 0037: a persistent +5% latency offset rolls back without a margin and holds with a 10% one; +30% still rolls back', () => {
  // fixture p99: control 200 + 10σ noise; canary adds 10·latencyShift ms persistently (shift 1 = +5%, shift 6 = +30%)
  for (const seed of [21, 22, 23]) {
    const without = drive(seed, { latencyShift: 1 }, TWIN_PROFILE.max_ticks);
    assert.ok(without.some((r) => r.engine_verdict === 'rollback'), `seed ${seed}: the unmargined sign kind should roll back on a persistent +5% offset`);
    const withMargin = driveWith(WITH_MARGIN, seed, { latencyShift: 1 }, TWIN_PROFILE.max_ticks);
    assert.ok(withMargin.every((r) => r.engine_verdict !== 'rollback'), `seed ${seed}: a 10% margin should absorb a persistent +5% offset`);
    const regressed = driveWith(WITH_MARGIN, seed, { latencyShift: 6 }, TWIN_PROFILE.max_ticks);
    assert.ok(regressed.some((r) => r.engine_verdict === 'rollback'), `seed ${seed}: +30% past a 10% margin should still roll back`);
  }
});

test('ADR 0037: the loader refuses a margin on a rate metric (the engine checks it)', () => {
  const bad = { ...TWIN_PROFILE, metrics: TWIN_PROFILE.metrics.map((m) => (m.kind === 'rate' ? { ...m, margin: { relative: 0.1 } } : m)) };
  assert.throws(() => freshTwinArm(bad as typeof TWIN_PROFILE), /sign kind only/);
});

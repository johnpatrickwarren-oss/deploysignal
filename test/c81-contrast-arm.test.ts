// test/c81-contrast-arm.test.ts — WORKLIST C81 (Part 2): the control arm, ADVISORY.
//
// Engine ADR 0032 (study 2026-09-contrast-null) refused the contrast null an admitting envelope,
// so the arm reports and never rolls back. This file pins:
//   1. Byte-identity: without `contrastArm` (or without `control_arm` on the config) the health
//      result and the fused verdict are unchanged.
//   2. The per-tick residual step equals the engine's batch `applyContrast`, tick for tick.
//   3. A canary-only 3σ step from tick 30 is SELECTED (under the study flag) on the fused verdict's
//      `contrast_arm` with a margin and an e-BY interval; the arm pushes nothing into rollback[],
//      firing_families or total_alpha_spent, and never touches family_A_shadow.
//   4. A shared step in both units selects nothing (the contrast is identical to the null's).
//   5. A contaminated cohort revokes the signal's monitor: the pair is advisory-by-monitor,
//      excluded from K, reason_code contrast_monitor_revoked.
//   6. The fit-ratio gate: below CONTRAST_FIT_RATIO_FLOOR the selection is refused and the raw
//      e-values still reported; at or above it the assertion is made.
//   7. The profile block: canary-control-arm validates, passes through the loader, and an unknown
//      key inside control_arm is rejected; the compiler passthrough writes it on the config.
//   8. The guarantee table carries the six contrast ids as non-α-participating, and the audit
//      prefix resolves family_A_contrast_{signal} to contrast_null_{signal}.
// Fixture: every signal drawn from the compiled cell's own law (test/_c64-fixture.ts); the pair
// units are independent draws of the same law with a SHARED sinusoidal component so the contrast
// has something to cancel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import type { CompiledConfig, HealthResult, VerdictResult } from '../dist/engine/types';
import type { FusedVerdict } from '../dist/engine/types/verdict';
import { evaluateHealth } from '../dist/engine/gates/health';
import { fuseVerdict } from '../dist/engine/verdict';
import {
  contrastResidualStep, pairId, cohortId, selectContrastArm, type ContrastArmOpts, type ContrastArmHealth,
} from '../dist/engine/gates/_health-contrast';
import {
  DETECTOR_GUARANTEES, CONTRAST_ARM_AUTHORITY, CONTRAST_ARM_Q, CONTRAST_FIT_RATIO_FLOOR, CONTRAST_ARM_REASON,
} from '../dist/engine/guarantees';
import { loadProfile, validateAgainstSchema, resolveEffectiveConfig } from '../tools/profile-loader';
import { profileSchema } from '../tools/_profile-loader-schema';
import { effectiveOrDefaults } from '../tools/calibrators/effective-config';
import { fitContrast, applyContrast } from '@johnpatrickwarren-oss/deploysignal-engine/per-shard/contrast';
import { loadCfg, cellLaw, gauss, metricsAt, canary, scenarioFor, FLAGS, POLICY_CTX, type Signal } from './_c64-fixture';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];
const baseCfg = loadCfg();
const LAW = cellLaw(baseCfg);
const baseline = scenarioFor(baseCfg).baseline;

const SIG: Signal = 'p99_latency';
const PAIR = { signal: SIG, canary: 'p99_latency@canary-a', control: 'p99_latency@control-a' };
const COHORT = { signal: SIG, a: 'p99_latency@control-a', b: 'p99_latency@control-b' };
const FIT = 500, T = 100, ONSET = 30;

function cfgWithArm(fitTicks = FIT): CompiledConfig {
  return { ...baseCfg, control_arm: { fit_ticks: fitTicks, pairs: [PAIR], control_cohort: [COHORT], q: CONTRAST_ARM_Q } } as CompiledConfig;
}

/** Three units of one signal: independent draws of the cell law plus a SHARED sinusoid (2 cell σ),
 *  with per-unit steps (in cell σ) from `onset`. Baseline (FIT ticks) and canary (T ticks). */
function units(seed: number, steps: { canary?: number; controlA?: number; controlB?: number }, onset = ONSET) {
  const g = { c: gauss(seed * 10 + 1), a: gauss(seed * 10 + 2), b: gauss(seed * 10 + 3) };
  const mk = (n: number, phase: number, stepped: boolean) => {
    const out = { canary: [] as number[], controlA: [] as number[], controlB: [] as number[] };
    for (let t = 0; t < n; t++) {
      const shared = 2 * LAW[SIG].sigma * Math.sin((t + phase) / 7);
      const st = (k: keyof typeof steps) => (stepped && t >= onset ? (steps[k] ?? 0) * LAW[SIG].sigma : 0);
      out.canary.push(LAW[SIG].mean + shared + LAW[SIG].sigma * g.c() + st('canary'));
      out.controlA.push(LAW[SIG].mean + shared + LAW[SIG].sigma * g.a() + st('controlA'));
      out.controlB.push(LAW[SIG].mean + shared + LAW[SIG].sigma * g.b() + st('controlB'));
    }
    return out;
  };
  return { base: mk(FIT, 0, false), live: mk(T, FIT, true) };
}

function armOpts(u: ReturnType<typeof units>, extra: Partial<ContrastArmOpts> = {}): ContrastArmOpts {
  return {
    baseline: { [pairId(PAIR)]: { treatment: u.base.canary, control: u.base.controlA } },
    cohortBaseline: { [cohortId(COHORT)]: { treatment: u.base.controlA, control: u.base.controlB } },
    ...extra,
  };
}

/** Drive the health gate for T ticks; returns the last result and the first tick the arm selected. */
function drive(cfg: CompiledConfig, u: ReturnType<typeof units> | null, opts: ContrastArmOpts | undefined, totalTicks = T) {
  const tb = new TrendBuffer(10);
  const traj = canary(baseCfg, 3, T, [], 0);
  let last: HealthResult | null = null, firstSelected: number | null = null, lastBlock: ContrastArmHealth | undefined;
  for (let i = 0; i < T; i++) {
    const m = metricsAt(baseCfg, traj, i) as Record<string, number>;
    if (u) { m[PAIR.canary] = u.live.canary[i]; m[PAIR.control] = u.live.controlA[i]; m[COHORT.b] = u.live.controlB[i]; }
    for (const k of Object.keys(m)) tb.push(k, m[k]);
    last = evaluateHealth(m as never, baseline as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
      ...(opts ? { contrastArm: opts, totalTicks } : {}),
    });
    lastBlock = (last as HealthResult & { contrast_arm?: ContrastArmHealth }).contrast_arm;
    if (firstSelected === null && lastBlock && lastBlock.selected.length > 0) firstSelected = i;
  }
  return { last: last!, block: lastBlock, firstSelected };
}

// ── 1. byte-identity ────────────────────────────────────────────────

test('C81: without contrastArm (or without control_arm on the config) nothing changes', () => {
  const u = units(1, {});
  const plain = drive(baseCfg, u, undefined);
  const noSpec = drive(baseCfg, u, armOpts(u));
  const noOpts = drive(cfgWithArm(), u, undefined);
  assert.equal((plain.last as HealthResult & { contrast_arm?: unknown }).contrast_arm, undefined);
  assert.deepEqual(noSpec.last, plain.last);
  assert.deepEqual(noOpts.last, plain.last);
  const fused = fuseVerdict(plain.last, { topology: 'portfolio', tick: T - 1, totalTicks: T, deployRef: 'd' });
  assert.equal(fused.contrast_arm, undefined);
});

// ── 2. the residual step ────────────────────────────────────────────

test('C81: contrastResidualStep equals the engine\'s applyContrast tick for tick', () => {
  const u = units(2, {});
  const dBase = u.base.canary.map((x, i) => x - u.base.controlA[i]);
  const fit = fitContrast(dBase);
  const dLive = u.live.canary.map((x, i) => x - u.live.controlA[i]);
  const whole = applyContrast(dBase.concat(dLive), fit);
  let prev: number | null = null;
  for (let t = 0; t < dBase.length + dLive.length; t++) {
    const d = t < dBase.length ? dBase[t] : dLive[t - dBase.length];
    const s = contrastResidualStep(d, prev, fit); prev = s.dc;
    assert.ok(Math.abs(s.r - whole[t]) < 1e-12, `tick ${t}: ${s.r} vs ${whole[t]}`);
  }
});

// ── 3. a canary-only step is selected, advisory ─────────────────────

test('C81: a canary-only 3σ step is SELECTED on the fused verdict\'s contrast_arm with a margin and an e-BY interval, and nothing rolls back', () => {
  const u = units(3, { canary: 3 });
  const { last, block, firstSelected } = drive(cfgWithArm(), u, armOpts(u, { assertFitRatio: true }));
  assert.ok(block, 'the arm ran');
  assert.equal(block!.authority, CONTRAST_ARM_AUTHORITY);
  assert.equal(block!.gate, 'asserted_by_study_flag');
  assert.ok(firstSelected !== null && firstSelected >= ONSET, `selected at tick ${firstSelected}`);
  assert.deepEqual(block!.selected, [pairId(PAIR)]);
  const v = block!.verdicts[0];
  assert.equal(v.reason_code, CONTRAST_ARM_REASON.selected);
  assert.equal(v.alpha_spent, 0); assert.equal(v.alpha_consumed, 0);
  assert.ok(block!.log_margins[pairId(PAIR)] > 0, 'a positive log margin');
  assert.ok(block!.monitors[SIG] === true, 'the cohort monitor is passing');
  // nothing from the arm in rollback[] or family_A_shadow
  assert.ok(!last.rollback.some((r) => r.id.includes('contrast')));
  assert.ok(!(last.family_A_shadow ?? []).some((v) => v.reason_code.startsWith('contrast_')));
  const fused: FusedVerdict = fuseVerdict(last, { topology: 'portfolio', tick: T - 1, totalTicks: T, deployRef: 'd' });
  assert.ok(fused.contrast_arm, 'the report is on the fused verdict');
  assert.deepEqual(fused.contrast_arm!.selected, [pairId(PAIR)]);
  assert.equal(fused.contrast_arm!.pairs[0].selected, true);
  assert.ok(fused.contrast_arm!.effect_intervals, 'an e-BY interval');
  const iv = fused.contrast_arm!.effect_intervals!.intervals[0];
  assert.equal(iv.signal, pairId(PAIR));
  assert.ok(iv.lower > 0, `the interval excludes zero on a 3σ step: [${iv.lower}, ${iv.upper}]`);
  assert.ok(!fused.firing_families.includes('A') || (last.family_A_shadow ?? []).some((v) => v.verdict === 'fire'),
    'if A fires it is the plug-ins on the base signals, not the arm');
});

// ── 4. a shared step selects nothing ────────────────────────────────

test('C81: a 3σ step in BOTH units selects nothing — the contrast residual is the null\'s', () => {
  const u = units(3, { canary: 3, controlA: 3, controlB: 3 });
  const { block, firstSelected } = drive(cfgWithArm(), u, armOpts(u, { assertFitRatio: true }));
  assert.equal(firstSelected, null, 'never selected');
  assert.deepEqual(block!.selected, []);
  assert.equal(block!.verdicts[0].reason_code, CONTRAST_ARM_REASON.clean);
  // and the residual really is the null's: same draws, step cancels
  const u0 = units(3, {});
  const b0 = drive(cfgWithArm(), u0, armOpts(u0, { assertFitRatio: true })).block!;
  assert.ok(Math.abs(b0.verdicts[0].log_e - block!.verdicts[0].log_e) < 1e-9, 'identical log-wealth');
});

// ── 5. a contaminated cohort revokes the monitor ────────────────────

test('C81: a step in one cohort member revokes the signal\'s monitor; the pair becomes advisory-by-monitor and leaves K', () => {
  const u = units(4, { controlB: 3 });
  const { block } = drive(cfgWithArm(), u, armOpts(u, { assertFitRatio: true }));
  assert.equal(block!.monitors[SIG], false, 'revoked');
  assert.equal(block!.verdicts[0].reason_code, CONTRAST_ARM_REASON.monitorRevoked);
  assert.equal(block!.verdicts[0].monitor_passing, false);
  assert.equal(block!.K, 0);
  assert.equal(block!.gate, 'no_admissible_pairs');
  assert.deepEqual(block!.selected, []);
});

// ── 6. the fit-ratio gate ───────────────────────────────────────────

test('C81: below the fit-ratio floor the selection is refused and the e-values still reported; at the floor the assertion is made', () => {
  const u = units(3, { canary: 3 });
  const refused = drive(cfgWithArm(FIT), u, armOpts(u)).block!;
  assert.equal(refused.fit_ratio, FIT / T);
  assert.ok(refused.fit_ratio! < CONTRAST_FIT_RATIO_FLOOR);
  assert.equal(refused.gate, 'refused_fit_ratio');
  assert.deepEqual(refused.selected, []);
  assert.ok(refused.verdicts[0].log_e > 3, `the raw log-wealth is reported: ${refused.verdicts[0].log_e}`);
  assert.equal(refused.verdicts[0].reason_code, CONTRAST_ARM_REASON.clean);
  const asserted = drive(cfgWithArm(CONTRAST_FIT_RATIO_FLOOR * T), u, armOpts(u)).block!;
  assert.equal(asserted.gate, 'asserted_m_much_greater_than_n');
  assert.deepEqual(asserted.selected, [pairId(PAIR)]);
  // selectContrastArm itself: refused gate → nothing, asserted → e-BH at q
  assert.deepEqual(selectContrastArm([{ pair: 'x', log_e: 10 }], 0.05, FIT, 'refused_fit_ratio').selected, []);
  assert.deepEqual(selectContrastArm([{ pair: 'x', log_e: 10 }], 0.05, FIT, 'asserted_m_much_greater_than_n').selected, ['x']);
});

// ── through orchestrate() ───────────────────────────────────────────

test('C81: end to end through orchestrate(): the report rides on gateResults.fusion and the verdict is the temporal path\'s', () => {
  const u = units(5, { canary: 3 });
  const cfg = cfgWithArm();
  const tb = new TrendBuffer(10);
  const traj = canary(baseCfg, 3, T, [], 0);
  const sc = scenarioFor(baseCfg);
  let last: VerdictResult | null = null;
  for (let i = 0; i < T; i++) {
    const m = metricsAt(baseCfg, traj, i) as Record<string, number>;
    m[PAIR.canary] = u.live.canary[i]; m[PAIR.control] = u.live.controlA[i]; m[COHORT.b] = u.live.controlB[i];
    for (const k of Object.keys(m)) tb.push(k, m[k]);
    last = orchestrate({
      liveMetrics: m, scenario: sc, hoursElapsed: i * (sc.bakeHours / T), trendBuffer: tb, tick: i, totalTicks: T,
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, fusionTopology: 'portfolio',
      contrastArm: armOpts(u, { assertFitRatio: true }),
    }) as VerdictResult;
    if (last.verdict === 'rollback') break;
  }
  const fused = last!.gateResults.fusion as unknown as FusedVerdict;
  assert.ok(fused.contrast_arm, 'contrast_arm on the fused verdict');
  assert.equal(fused.contrast_arm!.authority, 'advisory');
  assert.ok(!(last!.healthResult?.rollback ?? []).some((r) => r.id.includes('contrast')), 'the arm never rolls back');
});

// ── 7. the profile block ────────────────────────────────────────────

test('C81: canary-control-arm validates, passes through the loader and the compile defaults; an unknown key is rejected', () => {
  const p = loadProfile('canary-control-arm@1.0.0');
  assert.ok(p.control_arm, 'control_arm present');
  assert.equal(p.control_arm!.fit_ticks, 500);
  assert.equal(p.control_arm!.pairs.length, 3);
  assert.equal(p.control_arm!.control_cohort.length, 3);
  assert.equal(p.sli_list.length, 3, 'inherits the generic profile');
  const eff = resolveEffectiveConfig(p, null);
  assert.deepEqual(eff.control_arm, p.control_arm);
  const defaults = effectiveOrDefaults(eff, {
    family_a_signals: ['p99_latency'], family_c_signals: [], family_a_alpha_fraction: 0.4, family_c_alpha_fraction: 0,
    family_d_alpha_fraction: 0, family_e_alpha_fraction: 0, alpha_total: 1e-3,
    family_enabled_from_cli: { A: true, B: false, C: false, D: false, E: false },
    cell_dimensions_from_bundle: { hour_of_day: true, day_of_week: false, workload_class: false, tenant_tier: false, region: false },
  } as never);
  assert.deepEqual(defaults.control_arm, p.control_arm);
  const raw = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'profiles', 'canary-control-arm.yaml'), 'utf8')) as Record<string, unknown>;
  const generic = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', 'profiles', 'generic-microservice.yaml'), 'utf8')) as Record<string, unknown>;
  const merged = { ...generic, ...raw, control_arm: { ...(raw.control_arm as object), unknown_key: 1 } };
  const r = validateAgainstSchema(merged, profileSchema());
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('unknown_key')), r.errors.join('; '));
});

// ── 8. the table and the audit prefix ───────────────────────────────

test('C81: the six contrast ids are in the table, non-α-participating, and the audit prefix resolves them', () => {
  for (const sig of ['p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req']) {
    const g = (DETECTOR_GUARANTEES as Record<string, { alpha_participating: boolean; validity_class: string; id_mapping_note?: string }>)[`contrast_null_${sig}`];
    assert.ok(g, `contrast_null_${sig} in DETECTOR_GUARANTEES`);
    assert.equal(g.alpha_participating, false);
    assert.equal(g.validity_class, 'ville_anytime_valid');
    assert.ok(g.id_mapping_note?.includes('ADVISORY'));
  }
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'engine', '_audit-families.ts'), 'utf8');
  assert.ok(src.includes("['family_A_contrast_', 'contrast_null_']"));
});

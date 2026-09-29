// test/family-a-rollback-authority.test.ts — the Family A rollback-authority rule.
//
// Engine v0.12.1-pre (re-pinned in #112) evaluates Family A's two plug-ins (mixture supermartingale,
// betting e-process) on every signal a profile's sli_list names. Both are
// `validUnderEstimatedBaseline: false` (engine detectors/validity-envelope.ts, the betting and mixture
// envelopes), so a signal outside the engine's six defaults had gained rollback authority on a
// guarantee that does not hold with an estimated baseline. The rule (engine/guarantees.ts
// FAMILY_A_ROLLBACK_AUTHORITY, familyARollbackAuthorized): a plug-in fire reaches rollback[] only when
// its signal is authorized —
//   (i)   one of FAMILY_A_PRIMARY_SIGNALS (shipped profiles unchanged),
//   (ii)  routed through the valid path (OrchestrateParams.validPath calibration; its plug-ins are
//         already advisory under C64 b and the terminal safe-t fire decides), or
//   (iii) listed in the profile's `family_a_rollback_signals` (operator decision).
// Any other plug-in fire is ADVISORY: recorded with reason_code
// FAMILY_A_UNAUTHORIZED_ADVISORY_REASON and alpha_spent 0, never on rollback[] or firing_families.
//
//   (a) a custom-signal fire is advisory — runFamilyA, evaluateHealth + fuseVerdict, orchestrate +
//       audit record, and the HTTP gate's session runtime;
//   (b) the same signal listed in family_a_rollback_signals rolls back;
//   (c) a default-six signal rolls back as before beside an advisory custom signal;
//   (d) schema + loader validation of family_a_rollback_signals, and compile pass-through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AuditRecordV2, CompiledConfig, CustomerOverride, FiredSignal, HealthResult, Metrics, VerdictResult,
} from '../dist/engine/types';
import { runFamilyA } from '../dist/engine/gates/_health-detectors';
import { evaluateHealth } from '../dist/engine/gates/health';
import { fuseVerdict } from '../dist/engine/verdict';
import { buildAuditRecord } from '../dist/engine/audit';
import {
  FAMILY_A_ROLLBACK_AUTHORITY, FAMILY_A_UNAUTHORIZED_ADVISORY_REASON, FAMILY_A_PLUGIN_ADVISORY_REASON,
  familyARollbackAuthorized,
} from '../dist/engine/guarantees';
import { loadProfile, resolveEffectiveConfig, validateAgainstSchema } from '../tools/profile-loader';
import { profileSchema } from '../tools/_profile-loader-schema';
import { effectiveOrDefaults } from '../tools/calibrators/effective-config';
import { GateSessionRuntime } from '../service/gate-http/_gate-session-runtime';
import { summarizeFamilies } from '../dist/engine/_orchestrator-lifecycle';
import { FAMILY_A_PRIMARY_SIGNALS } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_page-cusum-core';
import type { TestContext } from 'node:test';
import * as yaml from 'js-yaml';
import { SessionStore } from '../service/session/session-store';
import { JsonlLifecycleEventEmitter } from '../service/session/jsonl-lifecycle-emitter';
import { loadCfg, cellSeries, scenarioBaseline, FLAGS, POLICY_CTX } from './_c64-fixture';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { createAuditWriter } = require('../dist/engine/_audit-writer');
const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];

const CUSTOM = 'http_5xx_rate';
const N = 100;

/** A compiled config whose cells carry Family A params for `signals` (copies of downstream_err's for
 *  any non-default signal) and whose `family_a_signals` is `signals` — the shape the calibrator emits
 *  for a profile with a custom sli_list (same construction as
 *  test/defect-valid-path-configured-signals.test.ts). */
function cfgFor(signals: string[], rollbackSignals?: string[]): CompiledConfig {
  const cfg = loadCfg();
  const alphaA = cfg.alpha_budget.per_family.A!;
  for (const c of [...cfg.baseline_cells!.cells, cfg.baseline_cells!.aggregate_fallback]) {
    const ps = c.family_A?.per_signal;
    if (!ps?.downstream_err) continue;
    for (const s of signals) {
      if (ps[s] && s !== CUSTOM) continue;
      ps[s] = { ...ps.downstream_err, betting_e_process_alpha: (alphaA / signals.length) * 0.5 };
      delete (ps[s] as { betting_sliding_buffer_threshold?: number }).betting_sliding_buffer_threshold;
    }
  }
  const out = { ...cfg, family_a_signals: signals, bonferroni_factor: signals.length } as CompiledConfig;
  if (rollbackSignals) (out as { family_a_rollback_signals?: string[] }).family_a_rollback_signals = rollbackSignals;
  return out;
}

function lawOf(cfg: CompiledConfig, s: string) {
  const cell = cfg.baseline_cells!.cells.find((c) => c.key.hour_of_day === 20 && c.key.day_of_week === 3)!;
  const p = cell.family_A!.per_signal[s]!;
  return { mean: p.baseline_mean, sigma: Math.sqrt(p.baseline_sigma_squared) };
}

/** Live series: every configured signal from its cell law, `shifted` ones stepped 4σ from tick 30. */
function liveFor(cfg: CompiledConfig, signals: string[], shifted: string[], seed: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  signals.forEach((s, k) => { out[s] = cellSeries(lawOf(cfg, s), seed * 100 + k, N, shifted.includes(s) ? 30 : Infinity, 4); });
  return out;
}

function metricsAt(cfg: CompiledConfig, live: Record<string, number[]>, i: number): Metrics {
  const m: Record<string, number> = { ...scenarioBaseline(cfg) };
  for (const k of Object.keys(live)) m[k] = live[k][i];
  return m as unknown as Metrics;
}

function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}

/** runFamilyA over N ticks; every rollback id seen, and every Family A fire seen with its reason_code. */
function runA(cfg: CompiledConfig, live: Record<string, number[]>) {
  const tb = new TrendBuffer(10);
  const rollbackIds = new Set<string>();
  const fires: Array<{ signal: string; reason_code: string; alpha_spent: number }> = [];
  for (let i = 0; i < N; i++) {
    const result = emptyHealth();
    const rollback: FiredSignal[] = [];
    runFamilyA(result, rollback, [], [], metricsAt(cfg, live, i), tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
    });
    for (const r of rollback) rollbackIds.add(r.id);
    for (const v of result.family_A_shadow ?? []) {
      if (v.verdict === 'fire') fires.push({ signal: v.signal!, reason_code: v.reason_code, alpha_spent: v.alpha_spent });
    }
  }
  return { rollbackIds, fires };
}

const isCustomRollback = (id: string) => id === 'family_A_' + CUSTOM || id === 'family_A_betting_' + CUSTOM;

// ── the rule ────────────────────────────────────────────────────────

test('rule: the constant and the predicate name the three authorizations', () => {
  assert.equal(FAMILY_A_ROLLBACK_AUTHORITY, 'authorized_signals_only');
  assert.equal(FAMILY_A_UNAUTHORIZED_ADVISORY_REASON, 'advisory_signal_not_rollback_authorized');
  assert.notEqual(FAMILY_A_UNAUTHORIZED_ADVISORY_REASON, FAMILY_A_PLUGIN_ADVISORY_REASON);
  for (const s of ['p99_latency', 'ttft', 'eval_score', 'tool_success_rate', 'downstream_err', 'cost_req']) {
    assert.equal(familyARollbackAuthorized(s, undefined, undefined), true, `(i) default ${s}`);
  }
  assert.equal(familyARollbackAuthorized(CUSTOM, undefined, undefined), false);
  assert.equal(familyARollbackAuthorized(CUSTOM, new Set([CUSTOM]), undefined), true, '(ii) routed');
  assert.equal(familyARollbackAuthorized(CUSTOM, undefined, [CUSTOM]), true, '(iii) operator-listed');
  assert.equal(familyARollbackAuthorized(CUSTOM, new Set(['p99_latency']), ['queue_depth']), false);
  assert.equal(familyARollbackAuthorized(undefined, undefined, undefined), false);
});

// ── (a) custom signal: advisory ─────────────────────────────────────

test('(a) runFamilyA: a custom-signal plug-in fire is advisory — recorded, α 0, never on rollback[]', () => {
  const cfg = cfgFor([CUSTOM]);
  const { rollbackIds, fires } = runA(cfg, liveFor(cfg, [CUSTOM], [CUSTOM], 11));
  assert.ok(fires.length > 0, 'the 4σ step makes a plug-in fire');
  for (const f of fires) {
    assert.equal(f.signal, CUSTOM);
    assert.equal(f.reason_code, FAMILY_A_UNAUTHORIZED_ADVISORY_REASON);
    assert.equal(f.alpha_spent, 0);
  }
  assert.deepEqual([...rollbackIds].filter(isCustomRollback), [], `no custom rollback id; saw ${[...rollbackIds].join(', ')}`);
});

test('(a) evaluateHealth + fuseVerdict: the advisory fire never makes Family A fire or the verdict roll back', () => {
  const cfg = cfgFor([CUSTOM]);
  const live = liveFor(cfg, [CUSTOM], [CUSTOM], 12);
  const tb = new TrendBuffer(10);
  let sawAdvisory = false;
  for (let i = 0; i < N; i++) {
    const m = metricsAt(cfg, live, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    const hr = evaluateHealth(m, scenarioBaseline(cfg) as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
    });
    assert.ok(!hr.rollback.some((s) => isCustomRollback(s.id)), `tick ${i}: no custom Family A rollback id`);
    const fused = fuseVerdict(hr, { topology: 'portfolio', tick: i, totalTicks: N, deployRef: 'authority' });
    assert.ok(!fused.firing_families.includes('A'), `tick ${i}: Family A must not fire`);
    const adv = (hr.family_A_shadow ?? []).filter((v) => v.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON);
    if (adv.length > 0) {
      sawAdvisory = true;
      assert.equal(fused.total_alpha_spent, 0);
      const a = fused.evidence_outlook.find((e) => e.family_id === 'A')!;
      assert.equal(a.state, 'accumulating');
      assert.ok(a.note.includes(CUSTOM) && a.note.includes('not authorized for Family A rollback'), a.note);
    }
  }
  assert.ok(sawAdvisory, 'an advisory fire was recorded');
});

/** orchestrate() end to end, portfolio topology; the last result, the first rollback, and the audit
 *  record of the first tick that carried an advisory custom-signal fire. */
function driveOrchestrate(cfg: CompiledConfig, signals: string[], shifted: string[], seed: number) {
  const live = liveFor(cfg, signals, shifted, seed);
  const tb = new TrendBuffer(10);
  const scenario = { id: 'authority', riskLevel: 'critical', bakeHours: 84, author: 'human', changeType: 'model_weights', timeWindow: 'ok', flags: FLAGS, baseline: scenarioBaseline(cfg) };
  let last: VerdictResult | null = null;
  let firstRollback: { tick: number; ids: string[] } | null = null;
  let advisoryAudit: AuditRecordV2 | null = null;
  for (let i = 0; i < N; i++) {
    const m = metricsAt(cfg, live, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    const params = {
      liveMetrics: m, scenario, hoursElapsed: i * (scenario.bakeHours / N),
      trendBuffer: tb, tick: i, totalTicks: N, compiledConfig: cfg, fusionTopology: 'portfolio',
      currentHourOfDay: 20, currentDayOfWeek: 3,
    };
    last = orchestrate(params) as VerdictResult;
    if (firstRollback === null && last.verdict === 'rollback') firstRollback = { tick: i, ids: last.healthResult!.rollback.map((s) => s.id) };
    const adv = (last.healthResult?.family_A_shadow ?? []).some((v) => v.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON);
    if (advisoryAudit === null && adv) advisoryAudit = buildAuditRecord(params as never, last, null) as AuditRecordV2;
  }
  return { last: last!, firstRollback, advisoryAudit };
}

test('(a) orchestrate: a custom-signal step ends proceed with no rollback; the audit record says why the fire is advisory', () => {
  const cfg = cfgFor([CUSTOM]);
  const { last, firstRollback, advisoryAudit } = driveOrchestrate(cfg, [CUSTOM], [CUSTOM], 13);
  assert.equal(firstRollback, null, `unexpected rollback: ${JSON.stringify(firstRollback)}`);
  assert.equal(last.verdict, 'proceed');
  assert.ok(advisoryAudit, 'an advisory fire was recorded on some tick');
  const fa = advisoryAudit!.families.A;
  assert.ok(fa.advisory_fires && fa.advisory_fires.length > 0, JSON.stringify(fa));
  for (const f of fa.advisory_fires!) {
    assert.equal(f.signal, CUSTOM);
    assert.equal(f.reason_code, FAMILY_A_UNAUTHORIZED_ADVISORY_REASON);
  }
  assert.equal(fa.alpha_spent, 0);
  assert.ok(!advisoryAudit!.tripped.some((t) => isCustomRollback(t.id)), 'v1 tripped[] carries no custom id');
});

test('(a) HTTP gate session runtime: a custom-signal step never rolls back or reports a custom Family A fire', () => {
  const cfg = cfgFor([CUSTOM]);
  const live = liveFor(cfg, [CUSTOM], [CUSTOM], 14);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-authority-store-'));
  const baselineHistoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-authority-baseline-'));
  const cfgPath = path.join(storeDir, 'compiled.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const serviceId = 'svc-authority';
  const store = SessionStore.init(storeDir, serviceId);
  const emitter = new JsonlLifecycleEventEmitter(path.join(storeDir, serviceId, 'events.jsonl'));
  const auditWriter = createAuditWriter({ dir: path.join(storeDir, serviceId, 'audit'), service: serviceId });
  const runtime = new GateSessionRuntime({
    storeDir, baselineHistoryDir, serviceId, mode: 'enforce', failPolicy: 'fail_closed',
    totalTicksDefault: N, sessionTtlSeconds: 3600, compiledConfigOverride: cfgPath,
  }, store, emitter, auditWriter);
  try {
    const { record } = runtime.begin({
      deploy_ref: 'authority-1', requested_at_ts: 1_700_000_000, scenario: { baseline: scenarioBaseline(cfg) },
    });
    let last;
    for (let i = 0; i < N; i++) {
      const m = metricsAt(cfg, live, i) as unknown as Record<string, number>;
      last = runtime.ingestTick(record.session_id, { emitted_at_ts: 1_700_000_000 + i * 30, metrics: m, hour_of_day: 20, day_of_week: 3 });
      assert.notEqual(last.verdict, 'rollback', `tick ${i}: ${JSON.stringify(last.fires)}`);
      assert.ok(!last.fires.some(isCustomRollback), `tick ${i}: fires ${last.fires.join(', ')}`);
    }
    assert.equal(last!.verdict, 'proceed');
  } finally {
    runtime.close();
  }
});

// ── (b) operator-listed: rolls back ─────────────────────────────────

test('(b) runFamilyA: the same signal listed in family_a_rollback_signals reaches rollback[]', () => {
  const cfg = cfgFor([CUSTOM], [CUSTOM]);
  const { rollbackIds, fires } = runA(cfg, liveFor(cfg, [CUSTOM], [CUSTOM], 11));
  assert.ok([...rollbackIds].some(isCustomRollback), `saw ${[...rollbackIds].join(', ')}`);
  assert.ok(!fires.some((f) => f.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON));
  assert.ok(fires.some((f) => f.alpha_spent > 0), 'an authorized fire books α');
});

test('(b) orchestrate: an operator-listed custom signal drives the deploy to rollback', () => {
  const cfg = cfgFor([CUSTOM], [CUSTOM]);
  const { firstRollback } = driveOrchestrate(cfg, [CUSTOM], [CUSTOM], 13);
  assert.ok(firstRollback !== null, 'the step rolls the deploy back');
  assert.ok(firstRollback!.ids.some(isCustomRollback), JSON.stringify(firstRollback));
});

// ── (c) default six: unchanged ──────────────────────────────────────

test('(c) a default-six signal still reaches rollback[] beside an advisory custom signal', () => {
  const signals = ['p99_latency', CUSTOM];
  const cfg = cfgFor(signals);
  const { rollbackIds, fires } = runA(cfg, liveFor(cfg, signals, signals, 15));
  assert.ok(rollbackIds.has('family_A_p99_latency') || rollbackIds.has('family_A_betting_p99_latency'),
    `p99_latency rolls back; saw ${[...rollbackIds].join(', ')}`);
  assert.ok(![...rollbackIds].some(isCustomRollback), 'the custom signal does not');
  assert.ok(fires.some((f) => f.signal === CUSTOM && f.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON));
  assert.ok(!fires.some((f) => f.signal === 'p99_latency' && f.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON));
});

test('(c) a config without family_a_signals (legacy, the six) produces no unauthorized-advisory verdict', () => {
  const cfg = loadCfg();
  delete (cfg as { family_a_signals?: string[] }).family_a_signals;
  const law = lawOf(cfg, 'p99_latency');
  const { rollbackIds, fires } = runA(cfg, { p99_latency: cellSeries(law, 16, N, 30, 4) });
  assert.ok(rollbackIds.has('family_A_p99_latency') || rollbackIds.has('family_A_betting_p99_latency'));
  assert.ok(!fires.some((f) => f.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON));
});

// ── (ii) routed: the valid path decides, the plug-ins stay C64 (b) advisory ──

test('(ii) a custom signal routed through the valid path: plug-ins C64 (b) advisory, safe-t rolls back at the terminal look', () => {
  const cfg = cfgFor([CUSTOM]);
  const live = liveFor(cfg, [CUSTOM], [CUSTOM], 17);
  const cal = { [CUSTOM]: cellSeries(lawOf(cfg, CUSTOM), 7100, 500) };
  const tb = new TrendBuffer(10);
  let last: HealthResult | null = null;
  for (let i = 0; i < N; i++) {
    const m = metricsAt(cfg, live, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    last = evaluateHealth(m, scenarioBaseline(cfg) as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
      validPath: { calibration: cal, ar1Phi: { [CUSTOM]: 0 } }, terminalLook: i === N - 1,
    });
    assert.ok(!(last.family_A_shadow ?? []).some((v) => v.reason_code === FAMILY_A_UNAUTHORIZED_ADVISORY_REASON),
      `tick ${i}: a routed signal is authorized`);
    if (i < N - 1) assert.ok(!last.rollback.some((s) => s.id.startsWith('family_A_')), `tick ${i}: plug-ins advisory`);
  }
  assert.deepEqual(last!.rollback.filter((s) => s.id.startsWith('family_A_')).map((s) => s.id), ['family_A_safe_t_' + CUSTOM]);
});

// ── (d) schema + loader + compile pass-through ──────────────────────

const SCHEMA = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'profiles', 'schema', 'profile.schema.json'), 'utf8'));
const P99 = { signal: 'p99_latency', direction_of_better: 'lower', δ_min: 0.05 };
const ERR = { signal: 'downstream_err', direction_of_better: 'lower', δ_min: 0.02 };
const H5XX = { signal: CUSTOM, direction_of_better: 'lower', δ_min: 0.05 };

function override(o: Record<string, unknown>): CustomerOverride {
  return { base_profile: 'generic-microservice@1.0.0', customer_id: 'acme', overrides: o as never };
}

test('(d) schema: family_a_rollback_signals is an optional array of unique non-empty strings, described as an operator decision', () => {
  const f = SCHEMA.properties.family_a_rollback_signals;
  assert.ok(f, 'the field is declared');
  assert.ok(!SCHEMA.required.includes('family_a_rollback_signals'), 'optional');
  assert.equal(f.type, 'array');
  assert.equal(f.uniqueItems, true);
  assert.deepEqual(f.items, { type: 'string', minLength: 1 });
  assert.match(f.description, /operator decision/i);
  assert.match(f.description, /validUnderEstimatedBaseline: false/);
  const p = loadProfile('generic-microservice@1.0.0');
  const ok = (v: unknown) => validateAgainstSchema({ ...p, family_a_rollback_signals: v }, profileSchema()).valid;
  assert.equal(ok(['p99_latency']), true);
  assert.equal(f.minItems, 1);
  assert.equal(ok([]), false, 'an empty list means nothing; omit the field');
  assert.equal(ok(['p99_latency', 'p99_latency']), false, 'duplicates');
  assert.equal(ok(['']), false, 'empty string');
  assert.equal(ok([3]), false, 'non-string');
  assert.equal(ok('p99_latency'), false, 'not an array');
});

test('(d) loader: every family_a_rollback_signals entry must be in sli_list', () => {
  const p = loadProfile('generic-microservice@1.0.0');
  assert.throws(() => resolveEffectiveConfig(p, override({ family_a_rollback_signals: [CUSTOM] })),
    /family_a_rollback_signals names "http_5xx_rate", which sli_list does not/);
  // An override that replaces sli_list and drops a listed signal is refused the same way.
  assert.throws(() => resolveEffectiveConfig(p, override({ sli_list: [P99], family_a_rollback_signals: ['downstream_err'] })),
    /family_a_rollback_signals names "downstream_err", which sli_list does not/);
  assert.throws(() => resolveEffectiveConfig(p, override({ family_a_rollback_signals: ['p99_latency', 'p99_latency'] })),
    /uniqueItems/);
  const eff = resolveEffectiveConfig(p, override({ sli_list: [P99, ERR, H5XX], family_a_rollback_signals: [CUSTOM] }));
  assert.deepEqual(eff.family_a_rollback_signals, [CUSTOM]);
});

test('(d) compile: effectiveOrDefaults passes family_a_rollback_signals through, and omits it when absent', () => {
  const p = loadProfile('generic-microservice@1.0.0');
  const legacy = {
    family_a_signals: [], family_c_signals: [], family_a_alpha_fraction: 0.4, family_c_alpha_fraction: 0.2,
    family_d_alpha_fraction: 0.1, family_e_alpha_fraction: 0.1, alpha_total: 1e-3,
    family_enabled_from_cli: { A: true, B: true, C: true, D: true, E: true },
    cell_dimensions_from_bundle: { hour_of_day: true, day_of_week: false, workload_class: false, tenant_tier: false, region: false },
  };
  const without = effectiveOrDefaults(resolveEffectiveConfig(p, null), legacy);
  assert.ok(!('family_a_rollback_signals' in without), 'absent → key omitted (byte-identical compile)');
  const eff = resolveEffectiveConfig(p, override({ sli_list: [P99, H5XX], family_a_rollback_signals: [CUSTOM] }));
  assert.deepEqual(effectiveOrDefaults(eff, legacy).family_a_rollback_signals, [CUSTOM]);
});

/** Study-only profiles (studies/<id>/PREREGISTRATION.md names each): they exist so a registered study
 *  runs the shipped compiler and gate with no override, and they are not shipped workload profiles.
 *  Each declares `family_a_rollback_signals` for its study signals on purpose (the operator decision
 *  profiles/README.md describes), so (d) skips them; the shipped inventory stays under the rule. */
const STUDY_ONLY_PROFILES = new Set(['gwdg-gpu-node-a', 'gwdg-gpu-node-ac']);

test('(d) no shipped profile declares family_a_rollback_signals or monitors a signal outside the six', () => {
  const dir = path.resolve(__dirname, '..', 'profiles');
  const six = new Set<string>(FAMILY_A_PRIMARY_SIGNALS);
  assert.equal(six.size, 6);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const id = f.replace(/\.yaml$/, '');
    if (STUDY_ONLY_PROFILES.has(id)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const version = /^version:\s*"?([0-9.]+)"?/m.exec(text)![1];
    const prof = loadProfile(`${id}@${version}`);
    assert.equal(prof.family_a_rollback_signals, undefined, id);
    for (const e of prof.sli_list) assert.ok(six.has(e.signal), `${id}: ${e.signal}`);
  }
});

// ── DORMANCY.md and the constant cannot drift apart (the twin-dormancy pattern) ──

test('dormancy: the DORMANCY.md entry is present, and while dormant the rule is authorized_signals_only', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'DORMANCY.md'), 'utf8');
  const start = md.search(/^##\s+Family A rollback authority on custom signals/m);
  assert.ok(start >= 0, 'DORMANCY.md has the Family A rollback authority entry');
  const rest = md.slice(start + 3);
  const end = rest.search(/^##\s+/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const status = body.match(/^-\s*status:\s*([A-Za-z_-]+)/m)?.[1];
  assert.equal(status, 'dormant');
  assert.match(body, /^-\s*activation_mechanism:\s*.*family_a_rollback_signals/m);
  assert.match(body, /^-\s*last_reviewed_ts:\s*2026-09-27/m);
  if (status === 'dormant') assert.equal(FAMILY_A_ROLLBACK_AUTHORITY, 'authorized_signals_only');
});

// ── fix round 1 ─────────────────────────────────────────────────────

/** Serve a virtual base profile (generic-microservice plus `extra`) through a per-test fs mock, the
 *  test/profile-sli-list-validation.test.ts pattern: nothing invalid is written to profiles/. */
function serveVirtualProfile(t: TestContext, id: string, extra: Record<string, unknown>): void {
  const base = yaml.load(fs.readFileSync(
    path.resolve(__dirname, '..', 'profiles', 'generic-microservice.yaml'), 'utf8')) as Record<string, unknown>;
  const text = yaml.dump({ ...base, id, ...extra });
  const suffix = path.join('profiles', `${id}.yaml`);
  const nodeFs = require('node:fs') as typeof fs;
  const realExists = nodeFs.existsSync;
  const realRead = nodeFs.readFileSync;
  t.mock.method(nodeFs, 'existsSync', (p: fs.PathLike) => String(p).endsWith(suffix) || realExists(p));
  t.mock.method(nodeFs, 'readFileSync', ((p: fs.PathOrFileDescriptor, o?: unknown) =>
    String(p).endsWith(suffix) ? text : (realRead as (a: unknown, b?: unknown) => unknown)(p, o)) as typeof fs.readFileSync);
}

test('(d) loadProfile: a base profile listing a family_a_rollback_signals entry outside sli_list is rejected at load', (t) => {
  serveVirtualProfile(t, 'virtual-rollback-outside', { family_a_rollback_signals: [CUSTOM] });
  assert.throws(() => loadProfile('virtual-rollback-outside@1.0.0'),
    /resolved profile "virtual-rollback-outside" family_a_rollback_signals names "http_5xx_rate", which sli_list does not/);
});

test('(d) loadProfile: the same virtual profile loads when sli_list carries the signal (the mock is not what rejects)', (t) => {
  serveVirtualProfile(t, 'virtual-rollback-inside', { sli_list: [P99, H5XX], family_a_rollback_signals: [CUSTOM] });
  assert.deepEqual(loadProfile('virtual-rollback-inside@1.0.0').family_a_rollback_signals, [CUSTOM]);
});

test('lifecycle: summarizeFamilies does not report Family A as fire on an advisory-only tick', () => {
  const v = (signal: string, verdict: 'fire' | 'clean', reason_code: string, alpha_spent = 0) => ({
    verdict, statistic: 1, threshold: 1, alpha_consumed: alpha_spent, alpha_spent, reason_code, family: 'A' as const, signal,
  });
  const hr = { ...emptyHealth(), family_A_shadow: [
    v(CUSTOM, 'fire', FAMILY_A_UNAUTHORIZED_ADVISORY_REASON),
    v('p99_latency', 'fire', FAMILY_A_PLUGIN_ADVISORY_REASON),
    v('ttft', 'clean', 'accumulating'),
  ] } as unknown as HealthResult;
  assert.deepEqual(summarizeFamilies(hr).A, { verdict: 'clean', alpha_spent: 0 });
  // An authorized fire still reports fire.
  const withReal = { ...hr, family_A_shadow: [...hr.family_A_shadow!, v('ttft', 'fire', 'threshold_crossed', 1e-5)] } as HealthResult;
  assert.equal(summarizeFamilies(withReal).A.verdict, 'fire');
});

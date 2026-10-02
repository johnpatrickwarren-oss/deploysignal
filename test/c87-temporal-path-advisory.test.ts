// test/c87-temporal-path-advisory.test.ts — WORKLIST C87 (2026-10-02): the temporal path is advisory.
//
// Families A, C and D test the canary against a baseline fitted from history. On real telemetry
// the gate rolled back 40 of 44 healthy GPU units through Family A (42 of 44 with Family C beside
// it; studies/gwdg-gate/REPORT.md) and 13 of 87 healthy request-stream windows
// (studies/burstgpt-gate/REPORT.md). `TEMPORAL_PATH_AUTHORITY = 'advisory'` (engine/guarantees.ts)
// removes their rollback authority. This file states the contract on each surface:
//
//   1. the constant, its reason code, the families it governs;
//   2. fusion (engine/verdict.ts): every family firing and no policy gate is not a rollback;
//      `firing_families` is empty, `advisory_families` lists them in A<B<C<D<E order, α spent 0,
//      the rationale names them as advisory; with a policy gate the verdict is rollback as before;
//   3. the health gate (engine/gates/health.ts): fires are recorded with `advisory_reason` and
//      `advisory_id`, book no α, and rollback[] carries no temporal id, so the cascade verdict
//      (engine/core.ts computeVerdict) does not roll back either;
//   4. orchestrate() on a recorded incident (demo-github-2020, where A, C, D and E all fire):
//      neither topology with the compiled config rolls back; a policy gate still does;
//   5. the audit record: `families.{A,C,D}.advisory_fires` carry the reason, α 0;
//   6. the valid path's terminal safe-t fire is advisory too;
//   7. DORMANCY.md and the constant cannot drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AuditRecordV2, CompiledConfig, DetectorVerdict, FusedVerdict, HealthResult, OrchestrateParams, VerdictResult,
} from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import { fuseVerdict } from '../dist/engine/verdict';
import { computeVerdict } from '../dist/engine/core';
import { buildAuditRecord } from '../dist/engine/audit';
import {
  TEMPORAL_PATH_AUTHORITY, TEMPORAL_PATH_ADVISORY_REASON, TEMPORAL_PATH_FAMILIES, temporalPathAdvisory,
  POLICY_GATE_IDS,
} from '../dist/engine/guarantees';
import { temporalAdvisoryFireIds, temporalAdvisoryVerdict } from '../dist/engine/_verdict-advisory';
import { VALID_PATH_ROLLBACK_PREFIX } from '../dist/engine/gates/_health-valid-path';
import { loadCfg, canary, calibration, metricsAt, scenarioFor, FLAGS, POLICY_CTX, SIGNALS } from './_c64-fixture';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { loadDemoScript } = require('../demos/load-demo');

const ROOT = path.resolve(__dirname, '..');
const V4: CompiledConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json'), 'utf8'));
const TEMPORAL_ID = /^family_[ACD](_|$)/;

function emptyHealth(): HealthResult {
  return { rollback: [], extend: [], warmup: { active: false, grace: false, pct: 100, suppressedIds: [] }, suppressed: [] };
}
function fire(family: 'A' | 'C' | 'D' | 'E', signal: string, reason: string, alpha: number): DetectorVerdict {
  return { verdict: 'fire', statistic: 50, threshold: 10, alpha_consumed: alpha, alpha_spent: alpha, reason_code: reason, family, signal };
}

/** Every family firing, as verdicts that still carry the α a pre-C87 gate stamped on them. */
function allFiring(): HealthResult {
  return {
    ...emptyHealth(),
    family_A_shadow: [
      fire('A', 'p99_latency', 'cusum_threshold', 6.67e-5),
      fire('A', 'ttft', 'betting_wealth_exceeded', 3.3e-5),
      fire('A', 'cost_req', 'safe_t_terminal_fire', 6.67e-5),
    ],
    family_C_verdict: fire('C', 'hotelling_t2_safe', 'hotelling_exceeded_threshold', 2e-4),
    family_C_mmd_verdict: fire('C', 'sequential_mmd_betting_e_process', 'mmd_wealth_exceeded', 1e-4),
    family_D_shadow: [fire('D', 'kv_cache', 'spectral_e_detector_wealth_exceeded', 1e-4)],
    family_E_verdict: fire('E', 'weighted_conformal_e_value', 'conformal_exceeded', 1e-4),
  };
}

// ── 1. the constant ─────────────────────────────────────────────────

test('C87: the temporal path is advisory, with one reason code, over Families A, C and D', () => {
  assert.equal(TEMPORAL_PATH_AUTHORITY, 'advisory');
  assert.equal(temporalPathAdvisory(), true);
  assert.equal(TEMPORAL_PATH_ADVISORY_REASON, 'advisory_temporal_path_no_valid_null');
  assert.deepEqual([...TEMPORAL_PATH_FAMILIES].sort(), ['A', 'C', 'D']);
  for (const id of ['family_A_p99_latency', 'family_C', 'family_C_mmd', 'family_D_kv_cache']) {
    assert.ok(!POLICY_GATE_IDS.has(id), `${id} is not a policy gate`);
  }
});

// ── 2. fusion ───────────────────────────────────────────────────────

test('C87 fusion: every family firing and no policy gate is not a rollback; the families are advisory and spend no α', () => {
  for (const topology of ['portfolio', 'cascade'] as const) {
    const mid = fuseVerdict(allFiring(), { topology, tick: 12, totalTicks: 32, deployRef: 'c87' });
    assert.equal(mid.verdict, 'baking', topology);
    assert.deepEqual(mid.firing_families, []);
    assert.deepEqual(mid.advisory_families, ['A', 'C', 'D', 'E']);
    assert.equal(mid.total_alpha_spent, 0);
    assert.match(mid.verdict_rationale, /^Baking: no rollback signal so far/);
    assert.match(mid.verdict_rationale, /Advisory only \(no α spent, not a rollback trigger\): Family A fired.*Family C fired.*Family D fired.*Family E fired/);
    // the fires stay visible: per-family verdicts and the outlook say `fire` / `fired`
    assert.equal(mid.per_family_verdicts.A?.filter((v) => v.verdict === 'fire').length, 3);
    assert.equal(mid.per_family_verdicts.C?.verdict, 'fire');
    for (const fam of ['A', 'C', 'D', 'E']) {
      assert.ok(mid.evidence_outlook.some((e) => e.family_id === fam && e.state === 'fired'), `outlook ${fam}`);
    }
    const last = fuseVerdict(allFiring(), { topology, tick: 31, totalTicks: 32, deployRef: 'c87' });
    assert.equal(last.verdict, 'proceed', `${topology}: the window closes on proceed`);
    assert.deepEqual(last.advisory_families, ['A', 'C', 'D', 'E']);
    assert.equal(last.total_alpha_spent, 0);
  }
});

test('C87 fusion: a pre-C87 health result that still carries temporal ids on rollback[] does not roll back', () => {
  const h = allFiring();
  h.rollback = [
    { id: 'family_A_p99_latency', label: 'Family A p99_latency' }, { id: 'family_A_betting_ttft', label: 'Family A betting ttft' },
    { id: 'family_A_safe_t_cost_req', label: 'Family A safe-t cost_req' }, { id: 'family_C', label: 'Family C (multivariate)' },
    { id: 'family_C_mmd', label: 'Family C (Sequential MMD)' }, { id: 'family_D_kv_cache', label: 'Family D kv_cache' },
  ];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 12, totalTicks: 32, deployRef: 'c87' });
  assert.equal(v.verdict, 'baking');
  assert.deepEqual(v.firing_families, []);
  assert.equal(v.per_family_verdicts.B, null, 'no temporal id leaks into Family B');
});

test('C87 fusion: an indeterminate temporal verdict still extends, with or without an advisory fire beside it', () => {
  const h = allFiring();
  h.family_A_shadow!.push({ verdict: 'indeterminate', statistic: 7, threshold: 10, alpha_consumed: 0, alpha_spent: 0, reason_code: 'accumulating', family: 'A', signal: 'downstream_err' });
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 12, totalTicks: 32, deployRef: 'c87' });
  assert.equal(v.verdict, 'extend');
  assert.deepEqual(v.advisory_families, ['A', 'C', 'D', 'E']);
});

test('C87 fusion: with a policy gate the verdict is rollback as before, and the temporal fires stay advisory beside it', () => {
  for (const gate of POLICY_GATE_IDS) {
    const h = allFiring();
    h.rollback = [{ id: gate, label: gate }];
    const v = fuseVerdict(h, { topology: 'portfolio', tick: 12, totalTicks: 32, deployRef: 'c87' });
    assert.equal(v.verdict, 'rollback', gate);
    assert.deepEqual(v.firing_families, [], 'a policy gate is not a detector family');
    assert.deepEqual(v.advisory_families, ['A', 'C', 'D', 'E']);
    assert.equal(v.total_alpha_spent, 0);
    assert.match(v.verdict_rationale, /^Rollback triggered: policy gate\(s\): /);
    assert.match(v.verdict_rationale, /Advisory only .*Family A fired/);
  }
});

test('C87 fusion: Family B keeps its rollback effect where it had one; the temporal families beside it are advisory', () => {
  const h = allFiring();
  h.rollback = [{ id: 'slowbleed', label: 'Slow Bleed (Multi-Metric Drift)' }];
  const v = fuseVerdict(h, { topology: 'portfolio', tick: 12, totalTicks: 32, deployRef: 'c87' });
  assert.equal(v.verdict, 'rollback');
  assert.deepEqual(v.firing_families, ['B']);
  assert.deepEqual(v.advisory_families, ['A', 'C', 'D', 'E']);
  assert.equal(v.total_alpha_spent, 0);
});

test('C87 fusion: firing_families and advisory_families are disjoint and advisory_families is empty when nothing fires', () => {
  const clean = fuseVerdict(emptyHealth(), { topology: 'portfolio', tick: 31, totalTicks: 32, deployRef: 'c87' });
  assert.equal(clean.verdict, 'proceed');
  assert.deepEqual(clean.advisory_families, []);
  const v = fuseVerdict({ ...allFiring(), rollback: [{ id: 'slowbleed', label: 'x' }] }, { topology: 'portfolio', tick: 12, totalTicks: 32, deployRef: 'c87' });
  for (const f of v.firing_families) assert.ok(!v.advisory_families.includes(f));
});

// ── 3. the health gate ──────────────────────────────────────────────

const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];

test('C87 health gate: a 4σ step on every Family A signal fires and is recorded as advisory; rollback[] carries no temporal id and the cascade verdict is not rollback', () => {
  const cfg = loadCfg();
  const T = 100;
  const traj = canary(cfg, 87, T, SIGNALS, 4);
  const baseline = scenarioFor(cfg).baseline;
  const tb = new TrendBuffer(10);
  const seen = new Set<string>();
  for (let i = 0; i < T; i++) {
    const m = metricsAt(cfg, traj, i);
    for (const k of Object.keys(m)) tb.push(k, (m as unknown as Record<string, number>)[k]);
    const hr = evaluateHealth(m, baseline as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
    });
    assert.ok(!hr.rollback.some((s) => TEMPORAL_ID.test(s.id)), `tick ${i}: ${hr.rollback.map((s) => s.id)}`);
    assert.notEqual(computeVerdict(hr, i, T), 'rollback', `tick ${i}: cascade verdict`);
    for (const v of (hr.family_A_shadow ?? []) as DetectorVerdict[]) {
      assert.equal(v.alpha_spent, 0, `tick ${i} ${v.signal}: no Family A verdict books α`);
      if (v.verdict !== 'fire') { assert.equal(v.advisory_reason, undefined); continue; }
      assert.equal(v.advisory_reason, TEMPORAL_PATH_ADVISORY_REASON);
      assert.ok(v.advisory_id === 'family_A_' + v.signal || v.advisory_id === 'family_A_betting_' + v.signal, String(v.advisory_id));
      assert.notEqual(v.reason_code, TEMPORAL_PATH_ADVISORY_REASON, 'the detector keeps its own reason code');
    }
    for (const id of temporalAdvisoryFireIds(hr)) seen.add(id);
  }
  for (const s of SIGNALS) {
    assert.ok(seen.has('family_A_' + s) || seen.has('family_A_betting_' + s), `${s} was detected; saw ${[...seen].join(', ')}`);
  }
});

test('C87 health gate: a fire whose rollback id warm-up suppresses is not marked as a detection', () => {
  const v = fire('A', 'p99_latency', 'cusum_threshold', 6.67e-5);
  const marked = temporalAdvisoryVerdict(v, 'family_A_p99_latency');
  assert.equal(marked.advisory_id, 'family_A_p99_latency');
  assert.equal(marked.alpha_spent, 0);
  const suppressed = temporalAdvisoryVerdict(v, null);
  assert.equal(suppressed.advisory_id, undefined);
  assert.equal(suppressed.advisory_reason, undefined);
  assert.equal(suppressed.alpha_spent, 0, 'still no α');
  const cleanV = temporalAdvisoryVerdict({ ...v, verdict: 'clean' }, 'family_A_p99_latency');
  assert.equal(cleanV.advisory_id, undefined);
});

// ── 4. orchestrate on a recorded incident ───────────────────────────

function applyCellPatch(src: CompiledConfig, patch: any): CompiledConfig {
  const cfg = JSON.parse(JSON.stringify(src)) as CompiledConfig;
  const cell = (cfg.baseline_cells?.cells ?? []).find((c: any) =>
    c.key.hour_of_day === patch.target_cell.hour_of_day && c.key.day_of_week === patch.target_cell.day_of_week) as any;
  for (const sig of Object.keys(patch.family_A_per_signal ?? {})) cell.family_A.per_signal[sig] = patch.family_A_per_signal[sig];
  if (patch.family_C_mean_vector) cell.family_C.mean_vector = patch.family_C_mean_vector.slice();
  return cfg;
}

interface Run { verdicts: string[]; rollbackIds: Set<string>; advisoryIds: Set<string>; advisoryFamilies: Set<string>; firing: Set<string>; alpha: number; audits: AuditRecordV2[] }

function runGithub(topology: 'cascade' | 'portfolio', flags?: Record<string, boolean>): Run {
  const d = loadDemoScript(path.join(ROOT, 'demos', 'scripts', 'demo-github-2020.json'));
  const cfg = applyCellPatch(V4, d.cell_patch);
  const tb = new TrendBuffer(10);
  const out: Run = { verdicts: [], rollbackIds: new Set(), advisoryIds: new Set(), advisoryFamilies: new Set(), firing: new Set(), alpha: 0, audits: [] };
  for (let t = 0; t < d.ticks.length; t++) {
    const live = d.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: { ...d, flags: { ...d.flags, ...(flags ?? {}) } },
      hoursElapsed: t * (d.bakeHours / d.ticks.length), trendBuffer: tb, tick: t, totalTicks: d.ticks.length,
      compiledConfig: cfg, currentHourOfDay: d.currentHourOfDay, currentDayOfWeek: d.currentDayOfWeek, fusionTopology: topology,
    };
    const res = orchestrate(params) as VerdictResult;
    out.verdicts.push(res.verdict);
    for (const s of res.healthResult?.rollback ?? []) out.rollbackIds.add(s.id);
    for (const id of temporalAdvisoryFireIds(res.healthResult)) out.advisoryIds.add(id);
    const fused = res.gateResults?.fusion as FusedVerdict | undefined;
    if (fused) {
      for (const f of fused.advisory_families) out.advisoryFamilies.add(f);
      for (const f of fused.firing_families) out.firing.add(f);
      out.alpha += fused.total_alpha_spent;
    }
    out.audits.push(buildAuditRecord(params, res, { service: 'c87' }) as AuditRecordV2);
  }
  return out;
}

test('C87 orchestrate: on the GitHub-2020 reconstruction A, C, D and E all fire and neither topology rolls back; α 0', () => {
  for (const topology of ['portfolio', 'cascade'] as const) {
    const r = runGithub(topology);
    assert.ok(!r.verdicts.includes('rollback'), `${topology}: ${r.verdicts.join(',')}`);
    // portfolio closes on proceed; cascade (computeVerdict) ends on extend because Family B's
    // hold on the compiled profile is still on extend[] at the last tick (FAMILY_B_AUTHORITY).
    assert.equal(r.verdicts[r.verdicts.length - 1], topology === 'portfolio' ? 'proceed' : 'extend', topology);
    assert.deepEqual([...r.rollbackIds], [], `${topology}: rollback[] stays empty`);
    assert.deepEqual([...r.advisoryFamilies].sort(), ['A', 'C', 'D', 'E'], topology);
    assert.deepEqual([...r.firing], [], topology);
    assert.equal(r.alpha, 0, topology);
    for (const prefix of ['family_A_', 'family_C', 'family_D_']) {
      assert.ok([...r.advisoryIds].some((id) => id.startsWith(prefix)), `${topology}: an advisory ${prefix} fire; saw ${[...r.advisoryIds].join(', ')}`);
    }
  }
});

test('C87 orchestrate: the same run with a policy gate set rolls back as before, on the gate and on nothing temporal', () => {
  for (const topology of ['portfolio', 'cascade'] as const) {
    const r = runGithub(topology, { provenance: true });
    assert.ok(r.verdicts.every((v) => v === 'rollback'), `${topology}: ${r.verdicts.join(',')}`);
    assert.ok(r.rollbackIds.has('provenance'));
    assert.ok(![...r.rollbackIds].some((id) => TEMPORAL_ID.test(id)), [...r.rollbackIds].join(', '));
    assert.deepEqual([...r.firing], [], 'no temporal family is credited with the rollback');
  }
});

// ── 5. the audit record ─────────────────────────────────────────────

test('C87 audit: a temporal fire is on the family block as a fire with α 0 and gate health_advisory, on advisory_fires with the reason, and absent from v1 tripped[]', () => {
  const r = runGithub('portfolio');
  const seen: Record<string, boolean> = { A: false, C: false, D: false };
  for (const rec of r.audits) {
    assert.notEqual(rec.verdict, 'rollback');
    // v1 tripped[] names causes; an advisory trip (A, C, D, and E since C25) is not one.
    const advisoryIds = new Set((['A', 'C', 'D', 'E'] as const).flatMap((fam) => rec.families[fam].detectors.map((d) => d.detector_id as string)));
    assert.ok(!rec.tripped.some((t) => advisoryIds.has(t.id)), JSON.stringify(rec.tripped));
    for (const d of rec.families.E.detectors) assert.equal(d.gate, 'health_advisory');
    for (const fam of ['A', 'C', 'D'] as const) {
      const f = rec.families[fam];
      assert.equal(f.alpha_spent, 0, `${fam}: family α`);
      for (const d of f.detectors) {
        assert.equal(d.alpha_spent, 0, `${fam} ${d.detector_id}: trip α`);
        assert.equal(d.gate, 'health_advisory', `${fam} ${d.detector_id}: an advisory trip is not labelled health_rollback`);
      }
      if (f.verdict !== 'fire') { assert.equal(f.advisory_fires, undefined); continue; }
      seen[fam] = true;
      assert.ok(f.advisory_fires && f.advisory_fires.length > 0, `${fam}: ${JSON.stringify(f)}`);
      for (const a of f.advisory_fires!) assert.equal(a.reason_code, TEMPORAL_PATH_ADVISORY_REASON);
    }
  }
  assert.deepEqual(seen, { A: true, C: true, D: true });
});

// ── 6. the valid path ───────────────────────────────────────────────

test('C87 valid path: the terminal safe-t fire is advisory — recorded under family_A_safe_t_{signal}, α 0, not on rollback[]', () => {
  const cfg = loadCfg();
  const CAL = calibration(cfg);
  const T = 100;
  const traj = canary(cfg, 88, T, ['p99_latency'], 4);
  const baseline = scenarioFor(cfg).baseline;
  const tb = new TrendBuffer(10);
  let last: HealthResult | null = null;
  for (let i = 0; i < T; i++) {
    const m = metricsAt(cfg, traj, i);
    for (const k of Object.keys(m)) tb.push(k, (m as unknown as Record<string, number>)[k]);
    last = evaluateHealth(m, baseline as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
      validPath: { calibration: { p99_latency: CAL.p99_latency }, ar1Phi: { p99_latency: 0 } }, terminalLook: i === T - 1,
    });
    assert.ok(!last.rollback.some((s) => TEMPORAL_ID.test(s.id)), `tick ${i}`);
  }
  const st = ((last!.family_A_shadow ?? []) as DetectorVerdict[]).find((v) => v.reason_code.startsWith('safe_t_'))!;
  assert.equal(st.verdict, 'fire');
  assert.equal(st.advisory_reason, TEMPORAL_PATH_ADVISORY_REASON);
  assert.equal(st.advisory_id, VALID_PATH_ROLLBACK_PREFIX + 'p99_latency');
  assert.equal(st.alpha_spent, 0);
  const fused = fuseVerdict(last!, { topology: 'portfolio', tick: T - 1, totalTicks: T, deployRef: 'c87' });
  assert.equal(fused.verdict, 'proceed');
  assert.deepEqual(fused.advisory_families, ['A']);
});

// ── 7. DORMANCY.md and the constant cannot drift apart ──────────────

test('C87 dormancy: the DORMANCY.md entry is present, and while it says dormant the constant is advisory', () => {
  const md = fs.readFileSync(path.join(ROOT, 'DORMANCY.md'), 'utf8');
  const start = md.search(/^##\s+Temporal path rollback authority/m);
  assert.ok(start >= 0, 'DORMANCY.md has the temporal path entry');
  const rest = md.slice(start + 3);
  const end = rest.search(/^##\s+/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const status = body.match(/^-\s*status:\s*([A-Za-z_-]+)/m)?.[1];
  assert.equal(status, 'dormant');
  assert.match(body, /^-\s*activation_mechanism:\s*.*registered study on real telemetry/m);
  assert.match(body, /^-\s*last_reviewed_ts:\s*2026-10-02/m);
  assert.match(body, /^-\s*activation_disposition:\s*conditional/m);
  if (status === 'dormant') assert.equal(TEMPORAL_PATH_AUTHORITY, 'advisory');
});

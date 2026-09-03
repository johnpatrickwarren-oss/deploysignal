// test/c64b-family-a-advisory.test.ts — WORKLIST C64 (b).
//
// The Family A plug-ins (mixture supermartingale, betting e-process) are advisory on a signal
// the envelope-valid terminal path is routed for (C64 a, `OrchestrateParams.validPath`) and
// unchanged elsewhere: `FAMILY_A_PLUGIN_ADVISORY = 'when_valid_path_routed'`
// (engine/guarantees.ts). Their (ε, δ)-approximate e-value form — `epsilon_growing`, the
// engine's axis 3 (C61) — rides on `evidence_outlook`.
//
//   1. Table: the three Family A constructions carry their axis-3 form.
//   2. Not routed: nothing changes — a plug-in fire spends α and rolls back (byte-identity).
//   3. Routed: a plug-in fire is recorded with alpha_spent 0 and the advisory reason_code,
//      never enters rollback[] or firing_families; the outlook says so and carries the law.
//   4. Routed: the terminal safe-t fire still rolls back and spends the per-signal α.
//   5. Mixed: an unrouted signal's plug-in fire still rolls back beside a routed signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HealthResult, FusedVerdict } from '../dist/engine/types';
import { evaluateHealth } from '../dist/engine/gates/health';
import { fuseVerdict } from '../dist/engine/verdict';
import {
  DETECTOR_GUARANTEES, FAMILY_A_PLUGIN_ADVISORY, FAMILY_A_PLUGIN_ADVISORY_REASON, familyAPluginAdvisory,
} from '../dist/engine/guarantees';
import { VALID_PATH_ROLLBACK_PREFIX, validPathAlpha } from '../dist/engine/gates/_health-valid-path';

const engine = require('../shared');
const { TrendBuffer } = engine;
import { loadCfg, canary, calibration, metricsAt, scenarioFor, FLAGS, POLICY_CTX, type Signal } from './_c64-fixture';
const policyCtx = POLICY_CTX as unknown as Parameters<typeof evaluateHealth>[3];
const cfg = loadCfg();
const CAL = calibration(cfg);
const baseline = scenarioFor(cfg).baseline;
const SHIFT = 4;   // cell sigmas from tick 30: the plug-ins fire well before the end

/** Drive the gate for T ticks with a 4σ step on `shifted` from tick 30 and return the last
 *  tick's result, the first tick Family A drove a rollback, and that tick's fused verdict. */
function drive(opts: { routed: Signal[]; shifted: Signal[]; T?: number }) {
  const T = opts.T ?? 100;
  const tb = new TrendBuffer(10);
  const traj = canary(cfg, 21, T, opts.shifted, SHIFT);
  let last: HealthResult | null = null, firstATick: number | null = null, firstFused: FusedVerdict | null = null;
  const calibrationFor: Record<string, number[]> = {};
  for (const s of opts.routed) calibrationFor[s] = CAL[s];
  for (let i = 0; i < T; i++) {
    const m = metricsAt(cfg, traj, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    last = evaluateHealth(m, baseline as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
      ...(opts.routed.length > 0 ? { validPath: { calibration: calibrationFor, ar1Phi: { p99_latency: 0, ttft: 0 } }, terminalLook: i === T - 1 } : {}),
    });
    const fused = fuseVerdict(last, { topology: 'portfolio', tick: i, totalTicks: T, deployRef: 'c64b' });
    if (firstATick === null && fused.firing_families.includes('A')) { firstATick = i; firstFused = fused; }
  }
  return { last: last!, firstATick, firstFused, alpha: validPathAlpha(cfg) };
}

// ── 1. the table ─────────────────────────────────────────────────────

test('C64 (b): the flag is on and the three Family A constructions carry their axis-3 form', () => {
  assert.equal(FAMILY_A_PLUGIN_ADVISORY, 'when_valid_path_routed');
  assert.equal(DETECTOR_GUARANTEES.mSPRT_p99_latency.approximate_e_value?.form, 'epsilon_growing');
  const b = DETECTOR_GUARANTEES.betting_e_process_p99_latency.approximate_e_value;
  assert.equal(b?.form, 'epsilon_growing');
  assert.equal(b?.form === 'epsilon_growing' ? b.kappa : null, 0.8445, 'the measured κ (C58)');
  assert.equal(DETECTOR_GUARANTEES.safe_t_e_value_p99_latency.approximate_e_value?.form, 'e_value');
  assert.equal(DETECTOR_GUARANTEES.slowbleed.approximate_e_value, undefined, 'Family B rows carry none');
  assert.equal(familyAPluginAdvisory('p99_latency', new Set(['p99_latency'])), true);
  assert.equal(familyAPluginAdvisory('ttft', new Set(['p99_latency'])), false);
  assert.equal(familyAPluginAdvisory('p99_latency', undefined), false);
});

// ── 2. not routed: unchanged ─────────────────────────────────────────

test('C64 (b): without validPath a plug-in fire spends α and drives the verdict, and no verdict is advisory', () => {
  const { firstATick, firstFused } = drive({ routed: [], shifted: ['p99_latency'] });
  assert.ok(firstATick !== null && firstATick < 99, `plug-ins fire before the end: ${firstATick}`);
  assert.equal(firstFused!.verdict, 'rollback');
  assert.ok(firstFused!.total_alpha_spent > 0);
  const a = firstFused!.per_family_verdicts.A ?? [];
  assert.ok(!a.some((v) => v.reason_code === FAMILY_A_PLUGIN_ADVISORY_REASON));
});

// ── 3. routed: advisory ──────────────────────────────────────────────

test('C64 (b): on a routed signal the plug-in fire is advisory — recorded, α 0, never a Family A rollback — and the outlook carries the law', () => {
  const T = 100;
  const tb = new TrendBuffer(10);
  const traj = canary(cfg, 22, T, ['p99_latency'], SHIFT);
  let sawAdvisory = false;
  for (let i = 0; i < T - 1; i++) {   // stop before the terminal look
    const m = metricsAt(cfg, traj, i);
    for (const k of Object.keys(m)) tb.push(k, (m as Record<string, number>)[k]);
    const hr = evaluateHealth(m, baseline as never, FLAGS, policyCtx, tb, {
      compiledConfig: cfg, currentHourOfDay: 20, currentDayOfWeek: 3, ticksSinceDeploy: i, deployAgeDays: 0,
      validPath: { calibration: { p99_latency: CAL.p99_latency }, ar1Phi: { p99_latency: 0 } }, terminalLook: false,
    });
    const fused = fuseVerdict(hr, { topology: 'portfolio', tick: i, totalTicks: T, deployRef: 'c64b' });
    assert.ok(!fused.firing_families.includes('A'), `tick ${i}: an advisory plug-in fire must not make Family A fire`);
    assert.ok(!hr.rollback.some((s) => s.id.startsWith('family_A_')), `tick ${i}: no Family A rollback id`);
    const adv = (hr.family_A_shadow ?? []).filter((v) => v.reason_code === FAMILY_A_PLUGIN_ADVISORY_REASON);
    if (adv.length > 0) {
      sawAdvisory = true;
      for (const v of adv) { assert.equal(v.verdict, 'fire'); assert.equal(v.alpha_spent, 0); assert.equal(v.signal, 'p99_latency'); }
      assert.equal(fused.total_alpha_spent, 0);
      const a = fused.evidence_outlook.find((e) => e.family_id === 'A')!;
      assert.equal(a.state, 'accumulating');
      assert.ok(a.note.includes('advisory'), a.note);
      assert.equal(a.approximate_e_value?.form, 'epsilon_growing', JSON.stringify(a));
    }
  }
  assert.ok(sawAdvisory, 'a plug-in fired on the 4σ step');
});

// ── 4. routed: the terminal safe-t fire still decides ────────────────

test('C64 (b): the routed signal still rolls back at the terminal look, on safe-t, at the per-signal α', () => {
  const { last, firstATick, firstFused, alpha } = drive({ routed: ['p99_latency'], shifted: ['p99_latency'] });
  assert.equal(firstATick, 99, 'only the terminal look decides on a routed signal');
  assert.deepEqual(last.rollback.filter((s) => s.id.startsWith('family_A_')).map((s) => s.id), [VALID_PATH_ROLLBACK_PREFIX + 'p99_latency']);
  assert.equal(firstFused!.verdict, 'rollback');
  assert.ok(Math.abs(firstFused!.total_alpha_spent - alpha) < 1e-18, `α ${firstFused!.total_alpha_spent} vs ${alpha}`);
  const a = firstFused!.evidence_outlook.find((e) => e.family_id === 'A')!;
  assert.equal(a.state, 'fired');
  assert.ok(a.note.includes('p99_latency'));
  assert.equal(a.approximate_e_value?.form, 'e_value', JSON.stringify(a));
});

// ── 5. mixed: an unrouted signal is unchanged beside a routed one ────

test('C64 (b): an unrouted signal\'s plug-in fire drives the verdict as before while its neighbour is routed', () => {
  const { firstATick, firstFused } = drive({ routed: ['p99_latency'], shifted: ['ttft'] });
  assert.ok(firstATick !== null && firstATick < 99, `ttft plug-in fires before the end: ${firstATick}`);
  const ids = firstFused!.per_family_verdicts.A!.filter((v) => v.verdict === 'fire' && v.reason_code !== FAMILY_A_PLUGIN_ADVISORY_REASON).map((v) => v.signal);
  assert.ok(ids.includes('ttft'));
  assert.ok(firstFused!.total_alpha_spent > 0);
});

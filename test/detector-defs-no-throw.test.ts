// test/detector-defs-no-throw.test.ts — Remediation H1 regression guard.
//
// Every ROLLBACK_DEFS / EXTEND_DEFS check is invoked by evaluateSignals
// inside try/catch (historically `catch(e) {}`), so a detector that throws
// is indistinguishable from a detector that cleanly declined to fire —
// fail-open for a deploy-gating engine. The `gpu_eff` detector shipped with
// a use-before-declaration TypeError (`tm.slopeNorm` read one line before
// `var tm` was assigned) that made it permanently dead on the only
// changeType it can fire under (model_weights).
//
// This test invokes every check DIRECTLY — no try/catch — across a matrix
// of representative contexts and trend shapes so any thrown error fails the
// suite loudly instead of silently disabling a detector.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const engine = require('../shared');
const { ROLLBACK_DEFS, EXTEND_DEFS, TrendBuffer, METRIC_KEYS } = engine;

interface Def { id: string; label: string; check: (...args: any[]) => boolean }

const BASELINE: Record<string, number> = {
  p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89,
  cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02,
  collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0,
  eval_score: 0.91, refusal_rate: 0.012, output_len_p50: 410,
};

// Direction each metric degrades in (rise = bad when rising).
const FALL_METRICS = new Set(['kv_cache', 'mfu', 'collective_ops', 'eval_score', 'traffic_pct']);

function makeLive(severity: number): Record<string, number> {
  const live: Record<string, number> = {};
  for (const k of Object.keys(BASELINE)) {
    const mult = FALL_METRICS.has(k) ? 1 - severity : 1 + severity;
    live[k] = BASELINE[k] * mult;
  }
  return live;
}

// Trend buffer with `ticks` observations drifting toward `severity`.
function makeTb(ticks: number, severity: number): InstanceType<typeof TrendBuffer> {
  const tb = new TrendBuffer();
  for (let i = 0; i < ticks; i++) {
    const frac = ticks > 1 ? i / (ticks - 1) : 0;
    const live = makeLive(severity * frac);
    for (const k of METRIC_KEYS) {
      if (live[k] !== undefined) tb.push(k, live[k]);
    }
  }
  return tb;
}

const CTXS = [
  { riskLevel: 'critical', changeType: 'model_weights', author: 'human', hoursElapsed: 2, timeWindow: 'ok', _tick: 2 },
  { riskLevel: 'critical', changeType: 'model_weights', author: 'human', hoursElapsed: 21, timeWindow: 'ok', _tick: 8 },
  { riskLevel: 'high', changeType: 'serving_code', author: 'agent', hoursElapsed: 14, timeWindow: 'ok', _tick: 5 },
  { riskLevel: 'critical', changeType: 'config', author: 'human', hoursElapsed: 30, timeWindow: 'friday', _tick: 11 },
  null, // detectors must tolerate a missing ctx
];

const FLAG_SETS = [
  { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
  { security: true, artifact_content: true, provenance: true, contract: true, toolchain: true, zeta: false, approval: false },
  null, // and missing flags
];

const TBS: Array<[string, any]> = [
  ['empty', new TrendBuffer()],
  ['warming(3 ticks)', makeTb(3, 0.05)],
  ['nominal(8 ticks, flat)', makeTb(8, 0.005)],
  ['drifting(8 ticks, 15%)', makeTb(8, 0.15)],
  ['severe(12 ticks, 35%)', makeTb(12, 0.35)],
  ['null', null], // some call sites pass no buffer
];

const SEVERITIES = [0, 0.05, 0.2, 0.4];

test('every ROLLBACK_DEFS / EXTEND_DEFS check runs without throwing (no silent dead detectors)', () => {
  const defs: Array<[string, Def]> = ([] as Array<[string, Def]>).concat(
    (ROLLBACK_DEFS as Def[]).map((d): [string, Def] => ['rollback:' + d.id, d]),
    (EXTEND_DEFS as Def[]).map((d): [string, Def] => ['extend:' + d.id, d]),
  );
  assert.ok(defs.length > 10, 'expected a populated detector registry');

  for (const [name, def] of defs) {
    for (const ctx of CTXS) {
      for (const flags of FLAG_SETS) {
        for (const [tbName, tb] of TBS) {
          for (const sev of SEVERITIES) {
            const live = makeLive(sev);
            const tw = ctx ? ctx.timeWindow : 'ok';
            assert.doesNotThrow(
              () => { def.check(live, BASELINE, flags, ctx, tb, tw); },
              `${name} threw with ctx=${JSON.stringify(ctx)} tb=${tbName} severity=${sev}`,
            );
          }
        }
      }
    }
  }
});

test('gpu_eff detector is alive: fires on clear MFU degradation under model_weights', () => {
  const def = (ROLLBACK_DEFS as Def[]).find((d) => d.id === 'gpu_eff');
  assert.ok(def, 'gpu_eff detector must exist');

  // Sustained MFU erosion + HBM rise — the compound GPU-pressure signature
  // the detector documents (adv_gpu_eff_erosion / adv_thermal).
  const tb = new TrendBuffer();
  for (let i = 0; i < 8; i++) {
    tb.push('mfu', 0.72 - i * 0.012);
    tb.push('hbm_spill', 0.02 + i * 0.002);
    tb.push('p99_latency', 185 + i * 4);
  }
  const live = { ...makeLive(0), mfu: 0.58, hbm_spill: 0.036, p99_latency: 215 };
  const ctx = { riskLevel: 'critical', changeType: 'model_weights', author: 'human', hoursElapsed: 16, timeWindow: 'ok', _tick: 8 };

  const fired = def!.check(live, BASELINE, {}, ctx, tb);
  assert.equal(fired, true, 'gpu_eff must fire on sustained MFU degradation with rising HBM');
});

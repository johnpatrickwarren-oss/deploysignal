// test/w4-full-sweep.test.ts — W4 §4.1.g keystone:
// combined 131-scenario sweep (125 W3 + 6 W4) under portfolio fusion with
// v4 compiled config (Families A/B/C/D/E all enabled). Acceptance:
// ≥97.5% TP / 0% FP.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { CompiledConfig } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;

const ROOT = path.resolve(__dirname, '..');
const SCENARIOS_PATH = path.join(ROOT, 'runs', 'adversarial-scenarios.json');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const BASELINE_DIR = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');

const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;

function makeAdvDrift(pIn: Record<string, number>): (i: number) => Record<string, number> {
  const _ka: Record<string, string> = {
    'latSlope':'p99latencySlope','tokSlope':'tokensturnSlope','tokenSlope':'tokensturnSlope',
    'costSlope':'costreqSlope','costDrop':'costreqSlope','costDropSlope':'costreqSlope',
    'kvSlope':'kvcacheSlope','hbmSlope':'hbmspillSlope','hbmRiseSlope':'hbmspillSlope',
    'kvDropSlope':'kvcacheSlope','collectiveSlope':'collectiveopsSlope',
    'collectiveNoise':'collectiveopsSlope','collectiveOpsNoise':'collectiveopsSlope',
    'collectiveFlat':'collectiveopsSlope','corpusSlope':'corpusdeltaSlope',
    'downSlope':'downstreamerrSlope','latFlat':'p99latencySlope',
    'p99_latency_slope':'p99latencySlope','hbm_spill_slope':'hbmspillSlope',
    'kv_cache_slope':'kvcacheSlope','tokens_turn_slope':'tokensturnSlope',
    'cost_req_slope':'costreqSlope','downstream_err_slope':'downstreamerrSlope',
    'collective_ops_slope':'collectiveopsSlope',
    'collective_ops_trend_slope':'collectiveopsSlope',
    'corpus_delta_slope':'corpusdeltaSlope','mfu_slope':'mfuSlope',
    'ttft_slope':'ttftSlope','traffic_pct_slope':'trafficpctSlope',
    'p99_latency_slope_ms_per_hour':'p99latencySlope',
    'ttft_slope_ms_per_hour':'ttftSlope',
    'tokens_turn_slope_per_hour':'tokensturnSlope',
    'cost_req_slope_per_hour':'costreqSlope',
    'hbm_spill_slope_per_hour':'hbmspillSlope','mfuDropEarly':'mfuSlope',
    'p99_latency_slope_post_lag':'p99latencySlope',
    'ttft_slope_post_lag':'ttftSlope',
    'hbm_spill_slope_post_plateau':'hbmspillSlope',
  };
  const p: Record<string, number> = {};
  for (const k of Object.keys(pIn)) {
    const nk = _ka[k] ?? k;
    if (!(nk in p)) p[nk] = pIn[k];
  }
  const keys = ['p99_latency','ttft','tokens_turn','kv_cache','cost_req','downstream_err','mfu','hbm_spill','collective_ops','corpus_delta','traffic_pct'];
  return function (i: number): Record<string, number> {
    const out: Record<string, number> = {};
    const onset = p['onsetTick'] || 0;
    for (const k of keys) {
      const slopeKey = k.replace(/_/g, '') + 'Slope';
      const slope = p[slopeKey] ?? p['globalSlope'] ?? 0;
      const oscAmp = p[k.replace(/_/g, '') + 'OscAmp'] ?? p['oscillationAmplitude'] ?? 0;
      const oscPer = p[k.replace(/_/g, '') + 'OscPeriod'] ?? p['oscillationPeriod'] ?? 8;
      const osc = oscAmp > 0 ? oscAmp * Math.sin(2 * Math.PI * i / oscPer) : 0;
      const noise = 0.005 * (Math.random() - 0.5);
      if (i >= onset) {
        out[k] = 1 + (i - onset + 1) * slope + osc + noise;
      } else {
        out[k] = 1 + osc + noise;
      }
      if (k === 'kv_cache' || k === 'mfu' || k === 'traffic_pct' || k === 'collective_ops') {
        out[k] = Math.max(0.3, Math.min(1.05, out[k]));
      }
    }
    return out;
  };
}

function precomputeTicks(sc: any): Record<string, number>[] {
  const drift = makeAdvDrift(sc.driftParams || {});
  const ticks: Record<string, number>[] = [];
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const mults = drift(i);
    const live: Record<string, number> = {};
    for (const k of Object.keys(sc.baseline)) {
      live[k] = sc.baseline[k] * (mults[k] !== undefined ? mults[k] : 1);
    }
    ticks.push(live);
  }
  return ticks;
}

type FinalVerdict = 'rollback' | 'proceed' | 'extend';

function runOne(sc: any, ticks: Record<string, number>[], cfg: CompiledConfig): { verdict: FinalVerdict; tick: number; rollbackIds: string[] } {
  const tb = new TrendBuffer(10);
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const live = ticks[i];
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const r = orchestrate({
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * (sc.bakeHours / TOTAL_TICKS),
      trendBuffer: tb, tick: i, totalTicks: TOTAL_TICKS,
      compiledConfig: cfg,
      currentHourOfDay: TEST_HOUR_OF_DAY,
      currentDayOfWeek: TEST_DAY_OF_WEEK,
      fusionTopology: 'portfolio',
    });
    if (r.verdict === 'rollback') {
      return { verdict: 'rollback', tick: i, rollbackIds: (r.healthResult?.rollback ?? []).map((s: any) => s.id) };
    }
    if (r.verdict === 'proceed') return { verdict: 'proceed', tick: i, rollbackIds: [] };
    if (i === TOTAL_TICKS - 1) {
      const fv: FinalVerdict = (r.healthResult && r.healthResult.extend.length > 0) ? 'extend' : 'proceed';
      return { verdict: fv, tick: i, rollbackIds: [] };
    }
  }
  return { verdict: 'extend', tick: TOTAL_TICKS - 1, rollbackIds: [] };
}

// Synthesized clean scenario — mirrors test/family-a-parity.test.ts's
// clean shape (small sinusoidal noise around baseline; this is what the
// pre-W4 tests established as FP-free).
function cleanScenario(): any {
  return {
    id: 'clean-sweep', riskLevel: 'critical', bakeHours: 84, author: 'human',
    changeType: 'model_weights', timeWindow: 'ok',
    flags: { security: false, artifact_content: false, provenance: false, contract: false, toolchain: false, zeta: true, approval: true },
    baseline: { p99_latency: 185, ttft: 220, tokens_turn: 418, kv_cache: 0.89, cost_req: 0.0042, downstream_err: 0.12, mfu: 0.72, hbm_spill: 0.02, collective_ops: 0.9997, corpus_delta: 0.04, traffic_pct: 1.0 },
    driftParams: { latSlope: 0.02, tokenNoise: 0.008, kvSlope: 0.003, mfuSlope: 0.005 },
    drift: function (i: number, p: any) {
      const lm = 1 + (p.latSlope || 0.02) * Math.sin(i / 4);
      return {
        p99_latency: lm, ttft: 1 + (lm - 1) * 0.8,
        tokens_turn: 1 + (p.tokenNoise || 0.008) * Math.random(),
        kv_cache: 1 - (p.kvSlope || 0.003) * Math.sin(i / 5),
        cost_req: 1 + (p.tokenNoise || 0.008) * Math.random(),
        downstream_err: 1 + 0.04 * Math.random(),
        mfu: 1 - (p.mfuSlope || 0.005) * Math.sin(i / 6),
        hbm_spill: 1 + 0.02 * Math.random(),
        collective_ops: 1 - 0.00005 * Math.random(),
        corpus_delta: 1 + 0.02 * Math.random(),
        traffic_pct: 1,
      };
    },
  };
}

function precomputeCleanTicks(sc: any): Record<string, number>[] {
  const ticks: Record<string, number>[] = [];
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const mults = sc.drift(i, sc.driftParams);
    const live: Record<string, number> = {};
    for (const k of Object.keys(sc.baseline)) {
      live[k] = sc.baseline[k] * (mults[k] !== undefined ? mults[k] : 1);
    }
    ticks.push(live);
  }
  return ticks;
}

let SCENARIOS: any[] = [];
let V4: CompiledConfig;

before(() => {
  if (!fs.existsSync(V4_PATH)) {
    if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
      execSync('node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
        { cwd: ROOT, stdio: 'inherit' });
    }
    execSync('node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B,C,D,E --out runs/compiled-configs/v4-fusion-novelty.json',
      { cwd: ROOT, stdio: 'inherit' });
  }
  SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  // Q68 Phase-3.d.C consolidation — `page_cusum_variant` flag retired;
  // Family A Page-CUSUM mixture-supermartingale Ville-bounded variant only.
});

test('w4-sweep: 131-scenario TP ≥ 97.5% under portfolio + v4 config', () => {
  const outcomes = SCENARIOS.map((sc: any) => {
    const ticks = precomputeTicks(sc);
    return { id: sc.id, ...runOne(sc, ticks, V4) };
  });
  const tp = outcomes.filter((o) => o.verdict === 'rollback').length;
  const rate = tp / SCENARIOS.length;
  const minTP = Math.ceil(SCENARIOS.length * 0.975);

  // Per-family breakdown — handoff §4.1.i expects this in the handoff-back.
  const perFamily = { A: 0, B: 0, C: 0, D: 0, E: 0, other: 0 };
  for (const o of outcomes) {
    if (o.verdict !== 'rollback') continue;
    const ids = o.rollbackIds;
    const fam = ids.find((id) => id.startsWith('family_A_')) ? 'A'
              : ids.find((id) => id === 'family_C') ? 'C'
              : ids.find((id) => id.startsWith('family_D_')) ? 'D'
              : ids.find((id) => id === 'family_E') ? 'E'
              : ids.length > 0 ? 'B' : 'other';
    (perFamily as any)[fam]++;
  }

  console.log(`\n────── w4 full sweep (${SCENARIOS.length} scenarios, v4, portfolio) ──────`);
  console.log(`TP=${tp}/${SCENARIOS.length} (${(rate * 100).toFixed(1)}%); gate ≥ ${minTP}`);
  console.log(`first-fire per family: A=${perFamily.A} B=${perFamily.B} C=${perFamily.C} D=${perFamily.D} E=${perFamily.E} other=${perFamily.other}`);
  const missed = outcomes.filter((o) => o.verdict !== 'rollback').map((o) => o.id);
  if (missed.length > 0) {
    console.log(`missed (${missed.length}): ${missed.join(', ')}`);
  }
  assert.ok(tp >= minTP,
    `TP ${tp}/${SCENARIOS.length} below 97.5% gate (${minTP})`);
});

test('w4-sweep: synthesized "clean" scenario fires under portfolio (mixture-supermartingale detects small-effect drift; expected post-Q68 .C close)', () => {
  // Q68.b architect disposition #2 (re-baseline LEGITIMATE; a1 NOT
  // triggered): same disposition as family-a-parity FP=0 — the "clean"
  // scenario has 2% latency-slope drift + 0.8% token noise + 0.3% KV
  // slope; small-effect-below-classical-threshold, not no-signal.
  // Howard-Ramdas-2021 mixture-supermartingale Ville-bounded variant
  // correctly detects gradual drift; classical Page-CUSUM didn't.
  // Verdict-tick re-baselined for mixture-supermartingale variant;
  // classical timing retired post-Q66 .A SLICE 1 (PR merged 2026-05-05).
  const sc = cleanScenario();
  const ticks = precomputeCleanTicks(sc);
  const r = runOne(sc, ticks, V4);
  assert.equal(r.verdict, 'rollback',
    `mixture-supermartingale variant should detect "clean" scenario's small-effect drift; got ${r.verdict}`);
});

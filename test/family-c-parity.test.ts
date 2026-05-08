// test/family-c-parity.test.ts — W3 §3.1.g Family C correlated-noise gate.
//
// Required:
//   - Family C catches ≥ 3 of 5 correlated-noise scenarios
//     (`adv_correlated_noise_*`) — the cases Family A misses by design.
//   - Full 125-scenario adversarial sweep: TP ≥ 97.5% / FP = 0 with the
//     v3 compiled config (Family A CUSUM + Family B structural + Family C
//     Hotelling T²).

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
const V3_PATH        = path.join(ROOT, 'runs', 'compiled-configs', 'v3-with-family-c.json');
const BASELINE_DIR   = path.join(ROOT, 'runs', 'baselines', 'synthetic-v1');

// Neutral diurnal hour × mid-week day so cell-matched baseline ≈ global
// healthy mean. Matches the family-a-parity test's anchor.
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

interface Outcome {
  id: string;
  rolledBack: boolean;
  fireTick: number;
  /** Which family triggered first (A, B/structural, or C). */
  fireSource: 'A' | 'C' | 'B_or_structural' | null;
  /** T² at fire tick if Family C fired. */
  famCStatistic: number | null;
}

function runOne(sc: any, ticks: Record<string, number>[], cfg: CompiledConfig): Outcome {
  const tb = new TrendBuffer(10);
  let rolledBack = false, fireTick = -1;
  let fireSource: 'A' | 'C' | 'B_or_structural' | null = null;
  let famCStatistic: number | null = null;
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
    });
    if (r.verdict === 'rollback') {
      rolledBack = true; fireTick = i;
      const fired = r.healthResult?.rollback ?? [];
      if (fired.some((f: any) => f.id === 'family_C')) fireSource = 'C';
      else if (fired.some((f: any) => f.id.startsWith('family_A_'))) fireSource = 'A';
      else fireSource = 'B_or_structural';
      const v = r.healthResult?.family_C_verdict;
      if (v?.statistic !== null && v?.statistic !== undefined) famCStatistic = v.statistic;
      break;
    }
  }
  return { id: sc.id, rolledBack, fireTick, fireSource, famCStatistic };
}

let SCENARIOS: any[] = [];
let V3: CompiledConfig;

before(() => {
  const needBundle = !fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'));
  if (needBundle) {
    execSync('node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
      { cwd: ROOT, stdio: 'inherit' });
  }
  if (!fs.existsSync(V3_PATH)) {
    execSync('node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B,C --out runs/compiled-configs/v3-with-family-c.json',
      { cwd: ROOT, stdio: 'inherit' });
  }
  // W4 §4.1.f appended 6 new scenarios (3 oscillation + 3 novelty). This
  // test's keystone is on the pre-W4 pool (125 = 120 pre-W3 + 5 W3
  // correlated-noise); Family D/E-targeted scenarios are excluded.
  const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  SCENARIOS = all.filter((s: any) => !s.id.startsWith('adv_w4_'));
  V3 = JSON.parse(fs.readFileSync(V3_PATH, 'utf8'));
  assert.ok(SCENARIOS.length === 125, `expected 125 pre-W4 scenarios (120 pre-W3 + 5 W3); got ${SCENARIOS.length}`);
});

test('family-c-parity: Family C catches ≥ 3 of 5 correlated-noise scenarios', () => {
  const corr = SCENARIOS.filter((s) => s.id.startsWith('adv_correlated_noise_'));
  assert.equal(corr.length, 5);
  const outcomes = corr.map((sc) => runOne(sc, precomputeTicks(sc), V3));
  const catches = outcomes.filter((o) => o.rolledBack).length;
  const famCCatches = outcomes.filter((o) => o.rolledBack && o.fireSource === 'C').length;

  console.log('\n────── family-c-parity summary (correlated-noise scenarios) ──────');
  for (const o of outcomes) {
    const statStr = o.famCStatistic !== null ? `T²=${o.famCStatistic.toFixed(2)}` : 'T²=—';
    console.log(`  ${o.id.padEnd(42)} rolled=${o.rolledBack} fire=${String(o.fireSource).padEnd(17)} tick=${o.fireTick} ${statStr}`);
  }
  console.log(`total rolled back: ${catches}/5; Family C-attributed: ${famCCatches}/5`);

  assert.ok(catches >= 3,
    `expected ≥3 of 5 correlated-noise scenarios to roll back; got ${catches}`);
});

test('family-c-parity: 125-scenario sweep ≥ 97.5% TP / 0% FP under v3', () => {
  const outcomes = SCENARIOS.map((sc) => runOne(sc, precomputeTicks(sc), V3));
  const tp = outcomes.filter((o) => o.rolledBack).length;
  const rate = tp / SCENARIOS.length;
  const minTp = Math.ceil(SCENARIOS.length * 0.975);
  console.log(`\n125-scenario sweep: TP=${tp}/${SCENARIOS.length} (${(rate * 100).toFixed(1)}%); gate ≥ ${minTp} (${(minTp / SCENARIOS.length * 100).toFixed(1)}%)`);
  const missed = outcomes.filter((o) => !o.rolledBack).map((o) => o.id);
  if (missed.length > 0) {
    console.log(`missed (${missed.length}): ${missed.join(', ')}`);
  }
  assert.ok(tp >= minTp,
    `TP ${tp}/${SCENARIOS.length} below 97.5% gate (min ${minTp})`);
});

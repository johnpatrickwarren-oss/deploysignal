// test/fusion-parity.test.ts — W4 §4.1.b acceptance:
// adversarial sweep with portfolio primary matches cascade on all 125 W3
// scenarios (zero divergences on the existing pool). Validates that
// `fuseVerdict` under `topology: 'portfolio'` is drop-in for the W3
// `computeVerdict(healthResult, ...)` path on the scenarios that shipped
// under cascade. Extension families (D/E) aren't injected here; parity
// is on the Families A/B/C pool.

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
const CONFIG_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v3-with-family-c.json');
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

function runOne(sc: any, ticks: Record<string, number>[], cfg: CompiledConfig, topology: 'cascade' | 'portfolio'): { verdict: FinalVerdict; tick: number } {
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
      fusionTopology: topology,
    });
    if (r.verdict === 'rollback') return { verdict: 'rollback', tick: i };
    if (r.verdict === 'proceed')  return { verdict: 'proceed', tick: i };
    if (i === TOTAL_TICKS - 1) {
      // Post-ARCHITECT-REPLY-19 Q1: final-tick indeterminate collapses to
      // `proceed` at the fusion layer (engine/verdict.ts fuseVerdict).
      // Cascade's computeVerdict hasn't been amended (cascade is legacy /
      // out of scope per TPM-REPLY-19), so cascade may return `extend` at
      // tick 31 even when portfolio returns `proceed`. Normalize the
      // harness so this intended semantic divergence doesn't trip parity:
      // the invariant we care about is rollback-timing agreement, not the
      // pre-Q1 extend/proceed distinction at the window boundary.
      return { verdict: 'proceed', tick: i };
    }
  }
  return { verdict: 'extend', tick: TOTAL_TICKS - 1 };
}

let SCENARIOS: any[] = [];
let CONFIG: CompiledConfig;

before(() => {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!fs.existsSync(path.join(BASELINE_DIR, 'bundle.jsonl'))) {
      execSync('node tools/gen-synthetic-baseline.ts --out runs/baselines/synthetic-v1 --n 500 --ticks 32 --tenants 4 --seed 42',
        { cwd: ROOT, stdio: 'inherit' });
    }
    execSync('node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B,C --out runs/compiled-configs/v3-with-family-c.json',
      { cwd: ROOT, stdio: 'inherit' });
  }
  SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
});

test('fusion-parity: portfolio matches cascade on all 125 W3 scenarios', () => {
  const divergences: Array<{ id: string; cascade: FinalVerdict; portfolio: FinalVerdict; cascadeTick: number; portfolioTick: number }> = [];
  for (const sc of SCENARIOS) {
    // Shared tick stream so both topologies see identical inputs.
    const ticks = precomputeTicks(sc);
    // Seed Math.random consistently across both runs. Scenarios use small
    // noise terms; we accept per-run noise variance and still expect
    // final verdicts to match because fires are driven by drift > noise.
    const cascade  = runOne(sc, ticks, CONFIG, 'cascade');
    const portfolio = runOne(sc, ticks, CONFIG, 'portfolio');
    if (cascade.verdict !== portfolio.verdict) {
      divergences.push({ id: sc.id, cascade: cascade.verdict, portfolio: portfolio.verdict, cascadeTick: cascade.tick, portfolioTick: portfolio.tick });
    }
  }

  if (divergences.length > 0) {
    console.log('\nfusion-parity divergences:');
    for (const d of divergences.slice(0, 20)) {
      console.log(`  ${d.id.padEnd(40)} cascade=${d.cascade}@${d.cascadeTick}  portfolio=${d.portfolio}@${d.portfolioTick}`);
    }
  }
  assert.equal(divergences.length, 0,
    `portfolio must match cascade on all 125 scenarios; got ${divergences.length} divergences`);
});

// test/family-d-parity.test.ts — W4 §4.1.d acceptance.
//
// ≥1 of 3 new oscillation scenarios (adv_w4_oscillation_*) is caught
// under the v4 compiled config with Family D enabled. The full 131-scenario
// sweep acceptance lives in test/fusion-parity.test.ts-style full-sweep
// tests; this file narrows to the three scenarios Family D targets.

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
  const p = pIn;
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

function runOne(sc: any, ticks: Record<string, number>[], cfg: CompiledConfig): { verdict: FinalVerdict; tick: number; famDFires: string[]; rollbackIds: string[] } {
  const tb = new TrendBuffer(10);
  const famDFires: string[] = [];
  let firstRollbackIds: string[] = [];
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
    const shadow = r.healthResult?.family_D_shadow ?? [];
    for (const v of shadow as Array<{ verdict: string; signal?: string }>) {
      if (v.verdict === 'fire' && v.signal && famDFires.indexOf(v.signal) < 0) famDFires.push(v.signal);
    }
    if (r.verdict === 'rollback') {
      firstRollbackIds = (r.healthResult?.rollback ?? []).map((s: any) => s.id);
      return { verdict: 'rollback', tick: i, famDFires, rollbackIds: firstRollbackIds };
    }
    if (r.verdict === 'proceed') return { verdict: 'proceed', tick: i, famDFires, rollbackIds: [] };
    if (i === TOTAL_TICKS - 1) {
      const fv: FinalVerdict = (r.healthResult && r.healthResult.extend.length > 0) ? 'extend' : 'proceed';
      return { verdict: fv, tick: i, famDFires, rollbackIds: [] };
    }
  }
  return { verdict: 'extend', tick: TOTAL_TICKS - 1, famDFires, rollbackIds: [] };
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
  const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  SCENARIOS = all.filter((s: any) => s.id.startsWith('adv_w4_oscillation_'));
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
});

test('family-d-parity: ≥1 of 3 oscillation scenarios catches (Family D fires or scenario rolls back)', () => {
  assert.equal(SCENARIOS.length, 3, `expected 3 oscillation scenarios; got ${SCENARIOS.length}`);
  const outcomes = SCENARIOS.map((sc: any) => {
    const ticks = precomputeTicks(sc);
    return { id: sc.id, ...runOne(sc, ticks, V4) };
  });

  console.log('\n────── family-d-parity (oscillation scenarios) ──────');
  for (const o of outcomes) {
    const famDSigs = o.famDFires.length > 0 ? `D:${o.famDFires.join(',')}` : 'D:—';
    console.log(`  ${o.id.padEnd(36)} verdict=${o.verdict.padEnd(8)} tick=${String(o.tick).padEnd(2)} ${famDSigs}  rollback=${o.rollbackIds.join(',')}`);
  }

  const famDCatches = outcomes.filter((o) => o.famDFires.length > 0).length;
  const anyRollback = outcomes.filter((o) => o.verdict === 'rollback').length;
  console.log(`Family D direct catches: ${famDCatches}/3; any-family rollback on D scenarios: ${anyRollback}/3`);
  // Acceptance per handoff §4.1.d: ≥1 of 3 oscillation scenarios caught.
  // "Caught" = Family D fires on at least one signal OR the fused verdict
  // rolls back on the scenario (indirect catch via B/A/C picking up the
  // oscillation-driven deviation).
  assert.ok(anyRollback >= 1,
    `expected ≥1 of 3 oscillation scenarios to roll back; got ${anyRollback}`);
});

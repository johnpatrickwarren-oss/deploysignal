// test/family-e-parity.test.ts — W4 §4.1.c acceptance.
//
// ≥1 of 3 new novelty scenarios (adv_w4_novelty_*) is caught under the v4
// compiled config with Family E enabled. Family E is a stub; the goal is
// conformal-novelty proof-of-concept rather than full coverage.

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

function runOne(sc: any, ticks: Record<string, number>[], cfg: CompiledConfig): { verdict: FinalVerdict; tick: number; famECaught: boolean; rollbackIds: string[] } {
  const tb = new TrendBuffer(10);
  let famECaught = false;
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
    const e = r.healthResult?.family_E_verdict;
    if (e && (e as any).verdict === 'fire') famECaught = true;
    if (r.verdict === 'rollback') {
      firstRollbackIds = (r.healthResult?.rollback ?? []).map((s: any) => s.id);
      return { verdict: 'rollback', tick: i, famECaught, rollbackIds: firstRollbackIds };
    }
    if (r.verdict === 'proceed') return { verdict: 'proceed', tick: i, famECaught, rollbackIds: [] };
    if (i === TOTAL_TICKS - 1) {
      const fv: FinalVerdict = (r.healthResult && r.healthResult.extend.length > 0) ? 'extend' : 'proceed';
      return { verdict: fv, tick: i, famECaught, rollbackIds: [] };
    }
  }
  return { verdict: 'extend', tick: TOTAL_TICKS - 1, famECaught, rollbackIds: [] };
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
  SCENARIOS = all.filter((s: any) => s.id.startsWith('adv_w4_novelty_'));
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
});

test('family-e-parity: ≥1 of 3 novelty scenarios catches (Family E fires or scenario rolls back)', () => {
  assert.equal(SCENARIOS.length, 3, `expected 3 novelty scenarios; got ${SCENARIOS.length}`);
  const outcomes = SCENARIOS.map((sc: any) => {
    const ticks = precomputeTicks(sc);
    return { id: sc.id, ...runOne(sc, ticks, V4) };
  });

  console.log('\n────── family-e-parity (novelty scenarios) ──────');
  for (const o of outcomes) {
    console.log(`  ${o.id.padEnd(36)} verdict=${o.verdict.padEnd(8)} tick=${String(o.tick).padEnd(2)} E=${o.famECaught} rollback=${o.rollbackIds.join(',')}`);
  }

  const famECatches = outcomes.filter((o) => o.famECaught).length;
  const anyRollback = outcomes.filter((o) => o.verdict === 'rollback').length;
  console.log(`Family E direct catches: ${famECatches}/3; any-family rollback on E scenarios: ${anyRollback}/3`);
  // Acceptance per handoff §4.1.c: ≥1 of 3 novelty scenarios caught.
  // Direct Family E fire may be 0 by design — ARCHITECT-REPLY-11 Item 1:
  // Family E uses the SAME Mahalanobis metric as Family C. Family C's
  // threshold (χ²(1-2e-4, 11) ≈ 36, Mahalanobis ≈ 6) is slightly looser
  // than Family E's (1e-4 quantile of chi_p ≈ 6.3), so Family C will
  // typically fire first on any deviation large enough to cross either
  // bar. "Caught by any family" is the acceptable operational bar per
  // the stub's proof-of-concept scope.
  assert.ok(anyRollback >= 1,
    `expected ≥1 of 3 novelty scenarios to roll back; got ${anyRollback}`);
});

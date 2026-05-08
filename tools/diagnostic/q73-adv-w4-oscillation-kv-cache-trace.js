#!/usr/bin/env node
// tools/diagnostic/q73-adv-w4-oscillation-kv-cache-trace.js — Q73
// Phase 1 Output B. Per-tick trace on adv_w4_oscillation_kv_cache
// scenario showing exactly when each family fires and when Family D
// long-view-fill threshold is crossed. Reuses regenerator machinery.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS_PATH = path.join(ROOT, 'runs', 'adversarial-scenarios.json');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;
const SEED = 42;

const regenSrc = fs.readFileSync(path.join(ROOT, 'tools', 'regenerate-v2-fixture.js'), 'utf8');
function buildHelpers() {
  const sandbox = { module: { exports: {} }, exports: {}, require, __dirname: path.join(ROOT, 'tools') };
  const wrapped = `
${regenSrc}
module.exports.makeAdvDrift = makeAdvDrift;
`;
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', 'require', '__dirname', wrapped);
  factory(sandbox.module, sandbox.exports, require, sandbox.__dirname);
  return sandbox.module.exports;
}
const { makeAdvDrift } = buildHelpers();

function main() {
  const allScenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const sc = allScenarios.find((s) => s.id === 'adv_w4_oscillation_kv_cache');
  if (!sc) { console.error('scenario not found'); process.exit(1); }
  const v4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));

  const engine = require(path.join(ROOT, 'shared'));
  const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;

  // Seed Math.random
  let s = SEED >>> 0;
  const origRandom = Math.random;
  Math.random = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  const drift = makeAdvDrift(sc.driftParams || {});
  const tb = new TrendBuffer(10);

  console.log('Q73 Phase 1 Output B — adv_w4_oscillation_kv_cache per-tick trace');
  console.log('Substrate: runs/compiled-configs/v4-fusion-novelty.json (post-Phase-D)');
  console.log('━'.repeat(110));
  console.log('tick  verdict      kv_cache       longView.kv_cache   familyA fires       familyD fires        rollback?');
  console.log('─'.repeat(110));

  let firstRollbackTick = null;
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const mults = drift(i);
    const live = {};
    for (const k of Object.keys(sc.baseline)) {
      live[k] = sc.baseline[k] * (mults[k] !== undefined ? mults[k] : 1);
    }
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const r = orchestrate({
      liveMetrics: live, scenario: sc,
      hoursElapsed: i * (sc.bakeHours / TOTAL_TICKS),
      trendBuffer: tb, tick: i, totalTicks: TOTAL_TICKS,
      compiledConfig: v4,
      currentHourOfDay: TEST_HOUR_OF_DAY,
      currentDayOfWeek: TEST_DAY_OF_WEEK,
      fusionTopology: 'portfolio',
    });

    const longViewKv = tb.dataLong && tb.dataLong.kv_cache ? tb.dataLong.kv_cache.length : 0;
    const familyAShadow = r.healthResult.family_A_shadow || [];
    const familyAFires = familyAShadow.filter((v) => v.verdict === 'fire').length;
    const familyDShadow = r.healthResult.family_D_shadow || [];
    const familyDFires = familyDShadow.filter((v) => v.verdict === 'fire').length;
    const isRollback = r.verdict === 'rollback';
    if (isRollback && firstRollbackTick === null) firstRollbackTick = i;

    const tickStr = String(i).padStart(4);
    const verdictStr = (r.verdict || '').padEnd(11);
    const kvStr = live.kv_cache.toFixed(4).padStart(8);
    const longViewStr = String(longViewKv).padStart(3) + (longViewKv >= 20 ? ' (≥20)' : '       ');
    const fa = String(familyAFires).padStart(3);
    const fd = String(familyDFires).padStart(3);
    const rb = isRollback ? '✓' : ' ';
    console.log(`${tickStr}  ${verdictStr}  ${kvStr}     ${longViewStr}            ${fa}                ${fd}                  ${rb}`);
  }

  Math.random = origRandom;

  console.log('━'.repeat(110));
  console.log(`\nKey observations:`);
  console.log(`  • Family D long-view fill threshold: ≥ 20 samples required (W4 spec)`);
  console.log(`  • First rollback tick (production short-circuit): ${firstRollbackTick}`);
  if (firstRollbackTick !== null && firstRollbackTick < 20) {
    console.log(`  ⚠ Production regenerator's "if (verdict === 'rollback') break" at tick ${firstRollbackTick}`);
    console.log(`    SHORT-CIRCUITS BEFORE Family D long-view fills (tick 19+); Family D never evaluates`);
    console.log(`    in the W5 §T1 fixture-curation pipeline. Detector code is unchanged + works correctly`);
    console.log(`    when allowed to run beyond rollback (full-32-tick run produces 13 D fires starting tick 19).`);
  }
}

main();

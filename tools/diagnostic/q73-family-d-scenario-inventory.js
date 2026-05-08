#!/usr/bin/env node
// tools/diagnostic/q73-family-d-scenario-inventory.js — Q73 Phase 1
// empirical investigation driver. Per-scenario per-family fire-count
// inventory across the 16 Family D-candidate adversarial scenarios
// (filtered from runs/adversarial-scenarios.json by name patterns:
// kv_cache | oscillation | spectral | w4_ | peak_acf | quant).
//
// Reuses tools/regenerate-v2-fixture.js machinery (makeAdvDrift +
// orchestrate + audit writer) for byte-identical scenario evaluation
// pattern. Per-scenario writer captures audit records into separate
// JSONL files; post-run we tally families.D detector trips per file.
//
// Output: per-scenario per-family fire matrix on stdout. Used by
// Phase 1 diagnostic memo to populate Output A.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS_PATH = path.join(ROOT, 'runs', 'adversarial-scenarios.json');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

const NAME_PATTERNS = [
  'kv_cache', 'oscillation', 'spectral', 'w4_', 'peak_acf', 'quant',
];

const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;
const SEED = 42;

// Reuse regenerator's seeded LCG + makeAdvDrift via require
const regen = require(path.join(ROOT, 'tools', 'regenerate-v2-fixture'));
// regenerator exports SCENARIO_SLICE + regenerate; we need makeAdvDrift
// + seededLCG which are not exported. Pull them via a hack: read the
// regenerator source + eval the helper functions in-process.
const regenSrc = fs.readFileSync(path.join(ROOT, 'tools', 'regenerate-v2-fixture.js'), 'utf8');

// Extract the makeAdvDrift function + dependencies (_ka alias map +
// seededLCG) by parsing source. Defensive: regenerator API stable since
// W5; if it churns, this driver needs an update.
function buildHelpers() {
  // eslint-disable-next-line no-eval
  const sandbox = { module: { exports: {} }, exports: {}, require, __dirname: path.join(ROOT, 'tools') };
  const wrapped = `
${regenSrc}
module.exports.makeAdvDrift = makeAdvDrift;
module.exports.seededLCG = seededLCG;
`;
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', 'require', '__dirname', wrapped);
  factory(sandbox.module, sandbox.exports, require, sandbox.__dirname);
  return sandbox.module.exports;
}

const { makeAdvDrift } = buildHelpers();

function runScenarioCaptureFires(sc, V4, engine, createAuditWriter) {
  const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `q73-fd-inv-${sc.id}-`));
  const writer = createAuditWriter({ dir: tmpDir, service: 'q73', rotateDaily: false });
  const drift = makeAdvDrift(sc.driftParams || {});
  const tb = new TrendBuffer(10);
  try {
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
        compiledConfig: V4,
        currentHourOfDay: TEST_HOUR_OF_DAY,
        currentDayOfWeek: TEST_DAY_OF_WEEK,
        fusionTopology: 'portfolio',
        auditWriter: writer,
        auditOpts: { service: 'q73' },
      });
      // Q73 Phase 1 — CONFIGURABLE rollback short-circuit. Production
      // semantic (regenerator pattern) breaks on rollback to mirror
      // real-deployment-decision flow. Without short-circuit, Family D's
      // 20-sample long-view threshold gets exercised on scenarios where
      // Family A would otherwise rollback at tick < 20. Driver runs both
      // modes via Q73_NO_BREAK env var; default = production semantic
      // for primary inventory match against regenerator output.
      if (r.verdict === 'rollback' && !process.env.Q73_NO_BREAK) break;
    }
  } finally {
    writer.close();
  }

  // Collect JSONL records
  const fireCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const detectorByFamily = { A: new Set(), B: new Set(), C: new Set(), D: new Set(), E: new Set() };
  const dDetails = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) {
        const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const rec = JSON.parse(line);
          if (!rec.families) continue;
          for (const fam of ['A', 'B', 'C', 'D', 'E']) {
            const block = rec.families[fam];
            if (block && Array.isArray(block.detectors) && block.detectors.length > 0) {
              fireCounts[fam] += block.detectors.length;
              for (const det of block.detectors) {
                detectorByFamily[fam].add(det.detector_id);
                if (fam === 'D') {
                  dDetails.push({ tick: rec.tick, detector_id: det.detector_id });
                }
              }
            }
          }
        }
      }
    }
  }
  walk(tmpDir);
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    fireCounts,
    detectorByFamily: Object.fromEntries(
      Object.entries(detectorByFamily).map(([k, v]) => [k, [...v]]),
    ),
    dDetails,
  };
}

function main() {
  const allScenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const candidates = allScenarios.filter((s) =>
    NAME_PATTERNS.some((p) => s.id.includes(p)),
  );
  const v4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));

  const engine = require(path.join(ROOT, 'shared'));
  const { createAuditWriter } = require(path.join(ROOT, 'dist/engine/audit'));

  // Patch Math.random with seeded LCG (regenerator pattern for determinism)
  const origRandom = Math.random;
  let s = SEED >>> 0;
  Math.random = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };

  console.log(`Q73 Phase 1 — Family D scenario inventory (${candidates.length} candidates)`);
  console.log(`Substrate: runs/compiled-configs/v4-fusion-novelty.json (post-Phase-D)`);
  console.log(`Topology: portfolio  Cell: hour=${TEST_HOUR_OF_DAY} day=${TEST_DAY_OF_WEEK}`);
  console.log('━'.repeat(95));
  console.log('scenario_id                                       A    B    C    D    E   D-fires');
  console.log('─'.repeat(95));

  const familyDFiringScenarios = [];
  try {
    for (const sc of candidates) {
      const { fireCounts, detectorByFamily, dDetails } = runScenarioCaptureFires(sc, v4, engine, createAuditWriter);
      const firesD = fireCounts.D > 0 ? '✓' : ' ';
      const id = sc.id.padEnd(48, ' ').slice(0, 48);
      const counts = `${String(fireCounts.A).padStart(4)} ${String(fireCounts.B).padStart(4)} ${String(fireCounts.C).padStart(4)} ${String(fireCounts.D).padStart(4)} ${String(fireCounts.E).padStart(4)}    ${firesD}`;
      console.log(`${id}  ${counts}`);
      if (fireCounts.D > 0) {
        familyDFiringScenarios.push({
          id: sc.id,
          fires: fireCounts.D,
          detectors: detectorByFamily.D,
          firstFireTick: dDetails[0]?.tick,
        });
      }
    }
  } finally {
    Math.random = origRandom;
  }

  console.log('━'.repeat(95));
  console.log(`\nFamily D-firing scenarios on current main HEAD v4 substrate: ${familyDFiringScenarios.length}/${candidates.length}`);
  for (const fd of familyDFiringScenarios) {
    console.log(`  • ${fd.id} — ${fd.fires} D fires; first at tick ${fd.firstFireTick}; detectors=${fd.detectors.join(',')}`);
  }
}

main();

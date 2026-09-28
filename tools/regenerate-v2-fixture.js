'use strict';
/**
 * tools/regenerate-v2-fixture.js — W5 §T1 fixture regenerator.
 *
 * Builds test/fixtures/audit/golden-v2.jsonl from a curated slice of the
 * 131-scenario adversarial pool, run through portfolio fusion + the v4
 * compiled config so all five families (A/B/C/D/E) emit DetectorTrip
 * entries on at least one row each.
 *
 * Determinism: the adversarial drift functions in w4-full-sweep mix in
 * Math.random() noise; this regenerator monkey-patches Math.random with a
 * seeded LCG, and overwrites each record's wall-clock `ts` with TS_BASE plus
 * the record index in milliseconds, so the JSONL output is byte-identical
 * across runs. (Restored 2026-09-28 from 5c870ef, where `ts` still varied.)
 *
 * Run: node tools/regenerate-v2-fixture.js
 *      → writes test/fixtures/audit/golden-v2.jsonl
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT = path.resolve(__dirname, '..');
const SCENARIOS_PATH = path.join(ROOT, 'runs', 'adversarial-scenarios.json');
const V4_PATH        = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const FIXTURE_PATH   = path.join(ROOT, 'test', 'fixtures', 'audit', 'golden-v2.jsonl');

const TEST_HOUR_OF_DAY = 20;
const TEST_DAY_OF_WEEK = 3;
const SEED = 42;
const TS_BASE = Date.parse('2026-05-08T00:00:00.000Z');

// Curated scenario slice — 3 A + 3 B + 3 C + 1 D + 2 E + 4 extra Family-B
// fillers so every family has a non-empty `detectors[]` row in the output.
// Selection comes from the per-scenario first-fire-family discovery harness
// run against v4 + portfolio (see WEEK5-HANDOFF.md §5.0 T1).
const SCENARIO_SLICE = [
  // Family A (Page-CUSUM on per-signal regression)
  'adv_inverted_economics', 'adv_late_onset', 'adv_slow_downstream',
  // Family B (structural rule detectors)
  'adv_thermal', 'adv_silent_kv', 'adv_cache_warmup_mirage',
  'adv_cache_warmup_phantom', 'adv_kv_cv_gate_bypass', 'adv_capacity_recovery_spoof',
  // Family C (Hotelling T² multivariate)
  'adv_hbm_corroboration_dodge', 'adv_mfu_drop_no_lat_corr', 'adv_extend_boundary_surf',
  // Family D (ACF oscillation on kv_cache)
  'adv_w4_oscillation_kv_cache',
  // Family E (conformal novelty)
  'adv_cv_gate_exploit', 'adv_compound_lat_cv_evasion',
];

function seededLCG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PARAM_ALIASES = {
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

const DRIFT_KEYS = ['p99_latency','ttft','tokens_turn','kv_cache','cost_req','downstream_err','mfu','hbm_spill','collective_ops','corpus_delta','traffic_pct'];
const CLAMPED = new Set(['kv_cache', 'mfu', 'traffic_pct', 'collective_ops']);

function normalizeParams(pIn) {
  const p = {};
  for (const k of Object.keys(pIn)) { const nk = PARAM_ALIASES[k] || k; if (!(nk in p)) p[nk] = pIn[k]; }
  return p;
}

function paramOr(p, key, fallback) {
  return p[key] != null ? p[key] : fallback;
}

/** One metric's multiplier at tick i (Math.random is the seeded LCG while regenerating). */
function driftValue(p, k, i) {
  const stem = k.replace(/_/g, '');
  const onset = p['onsetTick'] || 0;
  const slope = paramOr(p, stem + 'Slope', p['globalSlope'] || 0);
  const oscAmp = paramOr(p, stem + 'OscAmp', p['oscillationAmplitude'] || 0);
  const oscPer = paramOr(p, stem + 'OscPeriod', p['oscillationPeriod'] || 8);
  const osc = oscAmp > 0 ? oscAmp * Math.sin(2 * Math.PI * i / oscPer) : 0;
  const noise = 0.005 * (Math.random() - 0.5);
  const v = i >= onset ? 1 + (i - onset + 1) * slope + osc + noise : 1 + osc + noise;
  return CLAMPED.has(k) ? Math.max(0.3, Math.min(1.05, v)) : v;
}

function makeAdvDrift(pIn) {
  const p = normalizeParams(pIn);
  return function (i) {
    const out = {};
    for (const k of DRIFT_KEYS) out[k] = driftValue(p, k, i);
    return out;
  };
}

/** Run one scenario for TOTAL_TICKS through orchestrate (records go to `writer`); returns the
 *  first rollback tick. Q73 Phase 2.b: no short-circuit on rollback, so Family D's 20-sample
 *  long view fills; the production rollback boundary is kept as q73_first_rollback_tick. */
function runScenario(engine, sc, V4, writer) {
  const { orchestrate, TrendBuffer, TOTAL_TICKS } = engine;
  const drift = makeAdvDrift(sc.driftParams || {});
  const tb = new TrendBuffer(10);
  let firstRollbackTick = null;
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const mults = drift(i);
    const live = {};
    for (const k of Object.keys(sc.baseline)) live[k] = sc.baseline[k] * (mults[k] !== undefined ? mults[k] : 1);
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
      auditOpts: { service: 'golden' },
    });
    if (r.verdict === 'rollback' && firstRollbackTick === null) firstRollbackTick = i;
  }
  return firstRollbackTick;
}

function jsonlFiles(dir) {
  const files = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) files.push(p);
    }
  })(dir);
  return files.sort();
}

/** Stamp q73_first_rollback_tick (per scenario, attributed by tick-0 boundaries in SCENARIO_SLICE
 *  order: audit records carry no scenario id) and a deterministic ts on every record. */
function stampRecords(lines, firstRollbackTickByScenario) {
  let scenarioIdx = 0;
  const out = [];
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.tick === 0 && out.length > 0) scenarioIdx += 1;
    const scenarioId = SCENARIO_SLICE[scenarioIdx] || null;
    rec.q73_first_rollback_tick = firstRollbackTickByScenario[scenarioId] ?? null;
    rec.ts = new Date(TS_BASE + out.length).toISOString();
    out.push(JSON.stringify(rec));
  }
  return out;
}

function regenerate() {
  const SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  const byId = Object.create(null);
  for (const s of SCENARIOS) byId[s.id] = s;
  const missing = SCENARIO_SLICE.filter((id) => !byId[id]);
  if (missing.length > 0) throw new Error(`scenario '${missing[0]}' missing from adversarial pool`);

  const engine = require(path.join(ROOT, 'shared'));
  const { createAuditWriter } = require(path.join(ROOT, 'dist/engine/audit'));

  // Patch Math.random with a seeded LCG; restore on exit.
  const origRandom = Math.random;
  Math.random = seededLCG(SEED);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-fixture-regen-'));
  const writer = createAuditWriter({ dir: tmpDir, service: 'golden', rotateDaily: false });
  const firstRollbackTickByScenario = Object.create(null);
  try {
    for (const id of SCENARIO_SLICE) firstRollbackTickByScenario[id] = runScenario(engine, byId[id], V4, writer);
  } finally {
    writer.close();
    Math.random = origRandom;
  }

  const lines = jsonlFiles(tmpDir).flatMap((p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean));
  const combined = stampRecords(lines, firstRollbackTickByScenario).join('\n') + '\n';
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, combined, 'utf8');
  return combined.trim().split('\n').length;
}

if (require.main === module) {
  const n = regenerate();
  console.log(`Wrote ${FIXTURE_PATH} — ${n} records (${SCENARIO_SLICE.length} scenarios)`);
}

module.exports = { regenerate, SCENARIO_SLICE };

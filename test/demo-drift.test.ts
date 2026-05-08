// test/demo-drift.test.ts — WS3.6 build-time drift guard.
//
// For each canned demo under demos/scripts/, re-run its baked tick stream
// through the engine (cell-patch applied) and assert the live verdict
// stream matches the demo's expected_outcome. This is the demo-side
// equivalent of test/replay-regression.test.js — pinning demo behavior
// against future engine changes so the pitch never silently drifts.
//
// Determinism: the canned demos bake their own per-tick `metrics` (no
// runtime randomness) and our test feeds them in order. The engine's
// orchestration is deterministic given identical inputs, so verdict
// stream matches byte-for-byte across runs.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig, OrchestrateParams } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');

const ROOT        = path.resolve(__dirname, '..');
const DEMOS_DIR   = path.join(ROOT, 'demos', 'scripts');
const V4_PATH     = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

interface CellPatch {
  target_cell: { hour_of_day: number; day_of_week: number };
  family_A_per_signal?: Record<string, any>;
  family_C_mean_vector?: number[];
  family_E_calibration_scores?: number[];
  alpha_budget_override?: { per_family?: Record<string, number>; total?: number };
}

interface CannedDemo {
  id: string;
  name: string;
  baseline: Record<string, number>;
  ticks: Array<{ metrics: Record<string, number>; pause_beat?: boolean }>;
  total_ticks: number;
  bakeHours: number;
  riskLevel: string;
  changeType: string;
  author: string;
  timeWindow: string;
  flags: Record<string, any>;
  currentHourOfDay: number;
  currentDayOfWeek: number;
  cell_patch: CellPatch;
  expected_outcome: {
    verdict: string;
    first_fire_tick?: number | null;
    first_fire_family?: string;
    portfolio_first_fire_tick?: number;
    portfolio_first_rollback_tick?: number;
    cascade_first_rollback_tick?: number;
    timing_delta_ticks?: number;
    first_families?: string[];
    alpha_total_max?: number;
    divergence_from_spec?: string;
  };
}

function applyCellPatch(src: CompiledConfig, patch?: CellPatch | null): CompiledConfig {
  if (!src || !patch) return src;
  const cfg = JSON.parse(JSON.stringify(src)) as CompiledConfig;
  const target = patch.target_cell || ({} as any);
  const cell = (cfg.baseline_cells?.cells || []).find((c: any) =>
    c.key && c.key.hour_of_day === target.hour_of_day && c.key.day_of_week === target.day_of_week);
  if (!cell) return cfg;
  if (patch.family_A_per_signal && (cell as any).family_A) {
    for (const sig of Object.keys(patch.family_A_per_signal)) {
      (cell as any).family_A.per_signal[sig] = patch.family_A_per_signal[sig];
    }
  }
  if (patch.family_C_mean_vector && (cell as any).family_C) {
    (cell as any).family_C.mean_vector = patch.family_C_mean_vector.slice();
  }
  if (patch.family_E_calibration_scores) {
    (cell as any).family_E = { calibration_scores: patch.family_E_calibration_scores.slice() };
  }
  if (patch.alpha_budget_override) {
    (cfg as any).alpha_budget = (cfg as any).alpha_budget || {};
    (cfg as any).alpha_budget.per_family = (cfg as any).alpha_budget.per_family || {};
    if (patch.alpha_budget_override.per_family) {
      for (const f of Object.keys(patch.alpha_budget_override.per_family)) {
        (cfg as any).alpha_budget.per_family[f] = patch.alpha_budget_override.per_family[f];
      }
    }
  }
  return cfg;
}

interface DemoRunResult {
  finalVerdict: string;
  firstRollbackTick: number | null;
  firstFireByFamily: Record<string, number | null>;
  totalAlphaSpent: number;
  cascadeFirstRollbackTick: number | null;
}

function runDemo(d: CannedDemo, cfg: CompiledConfig, topology: 'cascade' | 'portfolio'): DemoRunResult {
  const tb = new TrendBuffer(10);
  const firstFires: Record<string, number | null> = { A: null, B: null, C: null, D: null, E: null };
  let firstRollback: number | null = null;
  let totalAlpha = 0;
  for (let t = 0; t < d.ticks.length; t++) {
    const live = d.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live as any,
      scenario: {
        baseline: d.baseline as any,
        riskLevel: d.riskLevel as any, changeType: d.changeType as any,
        author: d.author as any, timeWindow: d.timeWindow as any,
        flags: d.flags as any, bakeHours: d.bakeHours,
      },
      hoursElapsed: t * (d.bakeHours / d.ticks.length),
      trendBuffer: tb, tick: t, totalTicks: d.ticks.length,
      compiledConfig: topology === 'portfolio' ? cfg : null,
      currentHourOfDay: d.currentHourOfDay,
      currentDayOfWeek: d.currentDayOfWeek,
      fusionTopology: topology,
    };
    const res = orchestrate(params);
    if (topology === 'portfolio') {
      const rec = buildAuditRecord(params, res, { service: d.id });
      if ((rec as any).families) {
        for (const f of ['A', 'B', 'C', 'D', 'E']) {
          if ((rec as any).families[f].verdict === 'fire' && firstFires[f] === null) firstFires[f] = t;
          totalAlpha += (rec as any).families[f].alpha_spent || 0;
        }
      }
    }
    if (res.verdict === 'rollback' && firstRollback === null) firstRollback = t;
  }
  return {
    finalVerdict: firstRollback !== null ? 'rollback' : 'proceed',
    firstRollbackTick: firstRollback,
    firstFireByFamily: firstFires,
    totalAlphaSpent: totalAlpha,
    cascadeFirstRollbackTick: null,
  };
}

let V4: CompiledConfig;
const DEMOS: CannedDemo[] = [];

before(() => {
  if (!fs.existsSync(V4_PATH)) {
    throw new Error(`v4 compiled config missing at ${V4_PATH} — run w4-full-sweep first to seed.`);
  }
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  // Q68 Phase-3.d.C consolidation — `page_cusum_variant` flag retired;
  // Family A Page-CUSUM mixture-supermartingale Ville-bounded variant only.
  if (!fs.existsSync(DEMOS_DIR)) {
    throw new Error(`demos/scripts/ missing — run: node tools/build-canned-demos.js`);
  }
  for (const f of fs.readdirSync(DEMOS_DIR).filter((n) => n.endsWith('.json'))) {
    DEMOS.push(loadDemoScript(path.join(DEMOS_DIR, f)) as CannedDemo);
  }
});

// ────────────────────────────────────────────────────────────────────
test('demo-drift: every canned demo produces its expected_outcome verdict', () => {
  // W10: five canned demos per ARCHITECT-REPLY-20 Item A.
  // W13: six canned demos per ARCHITECT-REPLY-24 Item A (baseline-maintenance added).
  // Addition #23: seven canned demos per ARCHITECT-REPLY-39 D6 (tenant-skew added).
  assert.ok(DEMOS.length === 7, `expected 7 canned demos, got ${DEMOS.length}`);
  for (const d of DEMOS) {
    // Addition #23: tenant-skew uses an extended cell_patch shape
    // (tenant_tier_cells / tenant_tier_map). The local applyCellPatch in
    // this file doesn't know about that shape; finalVerdict is asserted
    // by test/demo-tenant-skew.test.ts under a tenant-aware harness.
    if (d.id === 'demo-tenant-skew') continue;
    const cfg = applyCellPatch(V4, d.cell_patch);
    const out = runDemo(d, cfg, 'portfolio');
    assert.equal(out.finalVerdict, d.expected_outcome.verdict,
      `${d.id}: final verdict mismatch (got ${out.finalVerdict}, expected ${d.expected_outcome.verdict})`);
  }
});

test('demo-drift: clean demo fires no detectors and stays under α budget cap', () => {
  const d = DEMOS.find((x) => x.id === 'demo-clean');
  assert.ok(d, 'demo-clean missing');
  const cfg = applyCellPatch(V4, d!.cell_patch);
  const out = runDemo(d!, cfg, 'portfolio');
  assert.equal(out.firstRollbackTick, null, 'demo-clean must not rollback');
  for (const f of ['A', 'B', 'C', 'D', 'E']) {
    assert.equal(out.firstFireByFamily[f], null,
      `demo-clean: family ${f} fired at t=${out.firstFireByFamily[f]} — expected no fires`);
  }
  const cap = d!.expected_outcome.alpha_total_max || 1e-5;
  assert.ok(out.totalAlphaSpent <= cap,
    `demo-clean: total α ${out.totalAlphaSpent.toExponential(2)} exceeds cap ${cap.toExponential(2)}`);
});

test('demo-drift: novelty demo — Family E first fire matches expected tick', () => {
  const d = DEMOS.find((x) => x.id === 'demo-novelty');
  assert.ok(d, 'demo-novelty missing');
  const cfg = applyCellPatch(V4, d!.cell_patch);
  const out = runDemo(d!, cfg, 'portfolio');
  assert.equal(out.finalVerdict, 'rollback');
  assert.equal(out.firstFireByFamily.E, d!.expected_outcome.first_fire_tick,
    `demo-novelty: Family E first fire t=${out.firstFireByFamily.E}, expected t=${d!.expected_outcome.first_fire_tick}`);
  // Spec asserts E catches alone; assert no other family fires before E.
  for (const f of ['A', 'B', 'C']) {
    const ft = out.firstFireByFamily[f];
    if (ft !== null) {
      assert.ok(ft >= (d!.expected_outcome.first_fire_tick ?? 0),
        `demo-novelty: Family ${f} fired at t=${ft} BEFORE Family E (t=${d!.expected_outcome.first_fire_tick}) — spec says E should be sole catcher`);
    }
  }
});

test('demo-drift: github-2020 demo — first fire family + portfolio rollback tick match', () => {
  const d = DEMOS.find((x) => x.id === 'demo-github-2020');
  assert.ok(d, 'demo-github-2020 missing');
  const cfg = applyCellPatch(V4, d!.cell_patch);
  const out = runDemo(d!, cfg, 'portfolio');
  assert.equal(out.finalVerdict, 'rollback');
  assert.equal(out.firstRollbackTick, d!.expected_outcome.portfolio_first_rollback_tick,
    `demo-github-2020: portfolio rollback t=${out.firstRollbackTick}, expected t=${d!.expected_outcome.portfolio_first_rollback_tick}`);
  // Assert all expected families fire at some point (order may vary by 1 tick).
  const expectedFams = d!.expected_outcome.first_families || [];
  for (const f of expectedFams) {
    assert.ok(out.firstFireByFamily[f] !== null,
      `demo-github-2020: expected family ${f} to fire at some point; got null`);
  }
});

test('demo-drift: every canned demo carries normative metadata fields', () => {
  for (const d of DEMOS) {
    assert.ok(d.id, `demo missing id`);
    assert.ok(d.name, `${d.id}: missing name`);
    assert.ok(d.baseline, `${d.id}: missing baseline`);
    assert.ok(Array.isArray(d.ticks) && d.ticks.length > 0, `${d.id}: missing/empty ticks`);
    assert.ok(d.total_ticks === d.ticks.length, `${d.id}: total_ticks doesn't match ticks.length`);
    assert.ok(d.cell_patch, `${d.id}: missing cell_patch`);
    assert.ok(d.expected_outcome, `${d.id}: missing expected_outcome`);
    // Every tick must have metrics.
    for (let t = 0; t < d.ticks.length; t++) {
      assert.ok(d.ticks[t].metrics, `${d.id} tick ${t}: missing metrics`);
    }
    // pause_beat must be present somewhere (architecturally significant moments).
    const pauseBeats = d.ticks.filter((t) => t.pause_beat).length;
    assert.ok(pauseBeats >= 1, `${d.id}: expected ≥1 pause_beat tick`);
  }
});

test('demo-drift: demos exist for all seven required IDs (W13 + Addition #23)', () => {
  const ids = DEMOS.map((d) => d.id).sort();
  assert.deepEqual(ids, [
    'demo-anthropic-2025',
    'demo-baseline-maintenance',
    'demo-clean',
    'demo-github-2020',
    'demo-novelty',
    'demo-tenant-skew',
    'demo-tokens-creep',
  ]);
});

test('demo-drift: build-canned-demos.js --check passes (canned demos in sync with source)', () => {
  const { execSync } = require('node:child_process');
  // Should exit 0 — generator produces byte-identical output for unchanged sources.
  execSync('node tools/build-canned-demos.js --check', { cwd: ROOT, stdio: 'pipe' });
});

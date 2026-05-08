// test/dress-rehearsal.test.ts — WS3.7 automated dress-rehearsal walkthrough.
//
// Headless validation that each canned demo's run produces the data each
// spec'd panel needs to render — provenance (§3.1), shadow-compare (§3.2),
// calibration badge (§3.3), α-budget meter (§3.4). Plus structural checks
// on the rendered demo.html (panels present, normative colors present,
// honest-broker strip wired).
//
// The live walkthrough is John's job (humans clicking through the browser);
// this test catches drift in the artifacts the walkthrough depends on.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig, OrchestrateParams, AuditRecordV2, FamilyId } from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');

const ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');
const TEMPLATE_PATH = path.join(ROOT, 'demos', 'demo.template.html');
const DEMO_HTML_PATH = path.join(ROOT, 'demos', 'demo.html');

// Reproduces the demo template's applyCellPatch — kept in sync with
// demos/demo.template.html. Drift between this and the template would
// silently break the demo; this duplication is intentional for test
// isolation. demo-drift.test.ts uses the same logic; consider extracting
// to a shared helper if it grows.
function applyCellPatch(src: any, patch: any): any {
  if (!src || !patch) return src;
  const cfg = JSON.parse(JSON.stringify(src));
  const target = patch.target_cell || {};
  const cell = (cfg.baseline_cells?.cells || []).find((c: any) =>
    c.key && c.key.hour_of_day === target.hour_of_day && c.key.day_of_week === target.day_of_week);
  if (!cell) return cfg;
  if (patch.family_A_per_signal && cell.family_A) {
    for (const sig of Object.keys(patch.family_A_per_signal)) {
      cell.family_A.per_signal[sig] = patch.family_A_per_signal[sig];
    }
  }
  if (patch.family_C_mean_vector && cell.family_C) {
    cell.family_C.mean_vector = patch.family_C_mean_vector.slice();
  }
  if (patch.family_E_calibration_scores) {
    cell.family_E = { calibration_scores: patch.family_E_calibration_scores.slice() };
  }
  if (patch.alpha_budget_override) {
    cfg.alpha_budget = cfg.alpha_budget || {};
    cfg.alpha_budget.per_family = cfg.alpha_budget.per_family || {};
    if (patch.alpha_budget_override.per_family) {
      for (const f of Object.keys(patch.alpha_budget_override.per_family)) {
        cfg.alpha_budget.per_family[f] = patch.alpha_budget_override.per_family[f];
      }
    }
  }
  return cfg;
}

type FamArray = Array<FamilyId>;
const FAMS: FamArray = ['A', 'B', 'C', 'D', 'E'];

interface PanelRenderData {
  perTickFamilies: Array<Record<FamilyId, { verdict: string; detectors: any[]; alpha_spent: number }>>;
  perTickCascadeVerdicts: string[];
  perTickPortfolioVerdicts: string[];
  cumulativeAlphaPerFamily: Record<FamilyId, number[]>;
  totalAlphaSpentAtDecision: number;
  totalAlphaSpentEnd: number;
  decisionTick: number | null;
  divergenceCount: number;
  portfolioCatchesCount: number;
  cascadeCatchesCount: number;
  configVersionsObserved: Set<string>;
  pauseBeatTicks: number[];
}

function runDressRehearsal(d: any, V4: CompiledConfig): PanelRenderData {
  const cfg = applyCellPatch(V4, d.cell_patch);
  const cascadeTb = new TrendBuffer(10);
  const portfolioTb = new TrendBuffer(10);
  const data: PanelRenderData = {
    perTickFamilies: [],
    perTickCascadeVerdicts: [],
    perTickPortfolioVerdicts: [],
    cumulativeAlphaPerFamily: { A: [], B: [], C: [], D: [], E: [] },
    totalAlphaSpentAtDecision: 0,
    totalAlphaSpentEnd: 0,
    decisionTick: null,
    divergenceCount: 0,
    portfolioCatchesCount: 0,
    cascadeCatchesCount: 0,
    configVersionsObserved: new Set<string>(),
    pauseBeatTicks: [],
  };
  const cumA: Record<FamilyId, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  for (let t = 0; t < d.ticks.length; t++) {
    const live = d.ticks[t].metrics;
    if (d.ticks[t].pause_beat) data.pauseBeatTicks.push(t);
    for (const k of Object.keys(live)) {
      cascadeTb.push(k, live[k]);
      portfolioTb.push(k, live[k]);
    }

    // Cascade run.
    const cascParams: OrchestrateParams = {
      liveMetrics: live, scenario: d, hoursElapsed: t * (d.bakeHours / d.ticks.length),
      trendBuffer: cascadeTb, tick: t, totalTicks: d.ticks.length,
      fusionTopology: 'cascade',
    };
    const cascRes = orchestrate(cascParams);
    data.perTickCascadeVerdicts.push(cascRes.verdict);

    // Portfolio run.
    const portParams: OrchestrateParams = {
      liveMetrics: live, scenario: d, hoursElapsed: t * (d.bakeHours / d.ticks.length),
      trendBuffer: portfolioTb, tick: t, totalTicks: d.ticks.length,
      compiledConfig: cfg, currentHourOfDay: d.currentHourOfDay, currentDayOfWeek: d.currentDayOfWeek,
      fusionTopology: 'portfolio',
    };
    const portRes = orchestrate(portParams);
    const portRec = buildAuditRecord(portParams, portRes, { service: d.id }) as AuditRecordV2;
    data.perTickPortfolioVerdicts.push(portRes.verdict);
    if ((portRec as any).compiled_config_version) {
      data.configVersionsObserved.add((portRec as any).compiled_config_version);
    }

    const famSnapshot: any = {};
    if (portRec.families) {
      for (const f of FAMS) {
        const fa = portRec.families[f];
        famSnapshot[f] = {
          verdict: fa.verdict,
          detectors: fa.detectors.slice(),
          alpha_spent: fa.alpha_spent,
        };
        cumA[f] += fa.alpha_spent || 0;
        data.cumulativeAlphaPerFamily[f].push(cumA[f]);
        data.totalAlphaSpentEnd += fa.alpha_spent || 0;
      }
    }
    data.perTickFamilies.push(famSnapshot);

    // Track first-rollback tick — α budget UI freezes at decision time
    // (Ville's inequality bounds the run-level FP probability at the
    // moment the gate decides; subsequent ticks are post-decision).
    if (portRes.verdict === 'rollback' && data.decisionTick === null) {
      data.decisionTick = t;
      data.totalAlphaSpentAtDecision = data.totalAlphaSpentEnd;
    }

    // Divergence categories.
    if (cascRes.verdict !== portRes.verdict) {
      data.divergenceCount++;
      if (portRes.verdict === 'rollback' && cascRes.verdict !== 'rollback') data.portfolioCatchesCount++;
      if (cascRes.verdict === 'rollback' && portRes.verdict !== 'rollback') data.cascadeCatchesCount++;
    }
  }
  // If never rolled back, treat end-of-run as decision tick.
  if (data.decisionTick === null) {
    data.decisionTick = data.perTickFamilies.length - 1;
    data.totalAlphaSpentAtDecision = data.totalAlphaSpentEnd;
  }
  return data;
}

let V4: CompiledConfig;
const DEMOS: any[] = [];
const RENDERS: Record<string, PanelRenderData> = {};

before(() => {
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  // Q68 Phase-3.d.C consolidation — `page_cusum_variant` flag retired;
  // mixture-supermartingale Ville-bounded variant unconditional.
  for (const f of fs.readdirSync(DEMOS_DIR).filter((n) => n.endsWith('.json'))) {
    const d = loadDemoScript(path.join(DEMOS_DIR, f));
    DEMOS.push(d);
    RENDERS[d.id] = runDressRehearsal(d, V4);
  }
});

// ── Provenance panel data (§3.1) ─────────────────────────────────────
test('dress-rehearsal §3.1: every demo emits per-tick families block with all 5 family ids', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    assert.equal(r.perTickFamilies.length, d.ticks.length, `${d.id}: wrong frame count`);
    for (let t = 0; t < r.perTickFamilies.length; t++) {
      const fams = r.perTickFamilies[t];
      for (const f of FAMS) {
        assert.ok(fams[f] !== undefined, `${d.id} t=${t}: family ${f} missing from render frame`);
        assert.ok(['fire', 'indeterminate', 'clean', 'suppressed'].includes(fams[f].verdict),
          `${d.id} t=${t}: family ${f} verdict '${fams[f].verdict}' not in spec enum`);
      }
    }
  }
});

test('dress-rehearsal §3.1: detector trips carry full provenance (cell_key, baseline_version, schema_continuity)', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    let totalTrips = 0;
    for (const frame of r.perTickFamilies) {
      for (const f of FAMS) {
        for (const det of frame[f].detectors) {
          totalTrips++;
          assert.ok(det.provenance, `${d.id}: trip missing provenance`);
          assert.ok('cell_key' in det.provenance, `${d.id}: trip missing provenance.cell_key`);
          assert.ok('baseline_version' in det.provenance, `${d.id}: trip missing provenance.baseline_version`);
          assert.ok('schema_continuity' in det.provenance, `${d.id}: trip missing provenance.schema_continuity (W5 §S6)`);
          // Cell confidence must be one of the spec'd values when cell_key present.
          if (det.provenance.cell_key) {
            assert.ok(['strict', 'pooled', 'aggregate', 'none'].includes(det.provenance.cell_confidence),
              `${d.id}: cell_confidence '${det.provenance.cell_confidence}' invalid`);
          }
        }
      }
    }
    // Clean-expected demos must have zero trips; rollback-fire demos must have ≥1.
    // Q72 SLICE 2 Phase 3.B: re-baselined post-RFF architectural-fix; Q67
    // §Q67.4-ter v1 biased streaming-witness retired; v2 RFF unbiased-by-
    // linearity. demo-baseline-maintenance MOVED from clean→rollback-fire
    // category per Q68.b cascade-resolution + accuracy-first directive
    // 2026-05-07: trajectory carries -0.4%/tick drift on p99_latency +
    // cost_req; mixture-supermartingale + RFF detectors fire Family A
    // legitimately at t=26. Provenance fields must still be present on
    // every trip; the trip-count category just shifted.
    if (d.id === 'demo-clean') {
      assert.equal(totalTrips, 0, `${d.id} must produce zero detector trips (proceed scenario)`);
    } else {
      assert.ok(totalTrips > 0, `${d.id}: expected ≥1 detector trip`);
    }
  }
});

// ── Shadow-compare panel data (§3.2) ─────────────────────────────────
test('dress-rehearsal §3.2: shadow-compare streams aligned tick-for-tick', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    assert.equal(r.perTickCascadeVerdicts.length, r.perTickPortfolioVerdicts.length,
      `${d.id}: cascade/portfolio verdict streams differ in length`);
    assert.equal(r.perTickCascadeVerdicts.length, d.ticks.length);
  }
});

test('dress-rehearsal §3.2: divergence-category counts non-negative and consistent', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    assert.ok(r.divergenceCount >= 0);
    assert.ok(r.portfolioCatchesCount >= 0);
    assert.ok(r.cascadeCatchesCount >= 0);
    // Per spec §3.2: at W5, expected count of cascade-catches-portfolio-misses = 0
    // across all canned demos by design (we don't ship demos that regress).
    assert.equal(r.cascadeCatchesCount, 0,
      `${d.id}: cascade caught ${r.cascadeCatchesCount} times portfolio missed — pitch regression risk`);
  }
});

// ── α-budget meter data (§3.4) ───────────────────────────────────────
test('dress-rehearsal §3.4: cumulative α per family monotone non-decreasing', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    for (const f of FAMS) {
      const series = r.cumulativeAlphaPerFamily[f];
      for (let i = 1; i < series.length; i++) {
        assert.ok(series[i] >= series[i - 1] - 1e-15,
          `${d.id} family ${f}: cumulative α decreased at tick ${i} (${series[i - 1]} → ${series[i]})`);
      }
    }
  }
});

test('dress-rehearsal §3.4: total α spent at decision-tick stays under demo cap', () => {
  // Ville's inequality bounds run-level FP probability at the moment the
  // gate decides (first rollback). The α-budget meter freezes at decision
  // time per spec §3.4. Subsequent ticks are post-decision visualization
  // and don't re-bill the budget.
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    const cap = d.expected_outcome.alpha_total_max;
    if (cap === undefined) continue;
    assert.ok(r.totalAlphaSpentAtDecision <= cap,
      `${d.id}: total α at decision t=${r.decisionTick} = ${r.totalAlphaSpentAtDecision.toExponential(2)} exceeds cap ${cap.toExponential(2)}`);
  }
});

// ── Calibration badge data (§3.3) ────────────────────────────────────
test('dress-rehearsal §3.3: every demo surfaces a single deterministic compiled_config_version', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    assert.equal(r.configVersionsObserved.size, 1,
      `${d.id}: expected exactly 1 compiled_config_version across run; got ${r.configVersionsObserved.size}`);
  }
});

// ── Pause-beat coverage (§6.4) ───────────────────────────────────────
test('dress-rehearsal §6.4: every demo carries ≥1 pause_beat at architecturally significant tick', () => {
  for (const d of DEMOS) {
    const r = RENDERS[d.id];
    assert.ok(r.pauseBeatTicks.length >= 1, `${d.id}: missing pause_beat ticks`);
  }
});

// ── Honest-broker fidelity strip (§6.3 normative) ────────────────────
test('dress-rehearsal §6.3: demo-github-2020 carries fidelity_caveat for honest-broker UI strip', () => {
  const d = DEMOS.find((x) => x.id === 'demo-github-2020');
  assert.ok(d, 'demo-github-2020 missing');
  assert.ok(typeof d.fidelity_caveat === 'string' && d.fidelity_caveat.length > 50,
    'demo-github-2020 fidelity_caveat must be a substantive paragraph (≥50 chars)');
  assert.ok(d.fidelity_caveat.toLowerCase().includes('reconstruction'),
    'fidelity_caveat must use the word "reconstruction" per architect honest-broker framing');
  assert.ok(d.narrative_reference && d.narrative_reference.includes('github'),
    'demo-github-2020 must carry narrative_reference link to GitHub postmortem');
});

// ── Walkthrough timing budget ────────────────────────────────────────
test('dress-rehearsal: all three demos play in under 10 minutes wall-clock', () => {
  let totalMs = 0;
  for (const d of DEMOS) {
    const cadence = d.cadence_ms || 200;
    // Pause-beats add ~2s each (per template).
    const pauseAdd = (d.ticks.filter((t: any) => t.pause_beat).length) * 2000;
    totalMs += d.ticks.length * cadence + pauseAdd;
  }
  const minutes = totalMs / 60000;
  assert.ok(minutes < 10, `Three-demo walkthrough budget ${minutes.toFixed(1)} min exceeds 10 min target`);
});

// ── demo.html structural checks ──────────────────────────────────────
test('dress-rehearsal: demos/demo.html includes all four spec panels (provenance, shadow, alpha, cal-badge)', () => {
  const html = fs.readFileSync(DEMO_HTML_PATH, 'utf8');
  // Section markers from the template — if any of these go missing, the
  // panel is gone or the template has been refactored without updating
  // this dress-rehearsal allowlist.
  assert.ok(html.includes('id="provBody"'), 'demo.html missing provenance panel container (#provBody)');
  assert.ok(html.includes('id="shadowBody"'), 'demo.html missing shadow-compare body (#shadowBody)');
  assert.ok(html.includes('id="alphaBar"'), 'demo.html missing α-budget meter (#alphaBar)');
  assert.ok(html.includes('id="calBadge"'), 'demo.html missing calibration badge (#calBadge)');
  assert.ok(html.includes('id="fidelityStrip"'), 'demo.html missing honest-broker fidelity strip');
});

test('dress-rehearsal: demos/demo.html includes normative spec colors', () => {
  const html = fs.readFileSync(DEMO_HTML_PATH, 'utf8');
  // Verdict palette (§4.1) — verbatim from spec.
  for (const c of ['#1e9e4f', '#e8b109', '#d93025', '#8a8f9c']) {
    assert.ok(html.includes(c), `demo.html missing normative verdict color ${c}`);
  }
  // Family palette (§4.2).
  for (const c of ['#2f6ec9', '#0d8a7c', '#7b3fc7', '#d07a1f', '#c32c8a']) {
    assert.ok(html.includes(c), `demo.html missing normative family color ${c}`);
  }
  // Divergence yellow (§4.4).
  assert.ok(html.includes('#fdf2cc'), 'demo.html missing divergence-highlight color #fdf2cc');
});

test('dress-rehearsal: demo template marker plumbing intact (engine + config + canned demos all inlined)', () => {
  const tmpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  for (const marker of ['/* {{ENGINE_INLINE}} */', '/* {{COMPILED_CONFIG_INLINE}} */', '/* {{CANNED_DEMOS_INLINE}} */']) {
    assert.ok(tmpl.includes(marker), `template missing marker: ${marker}`);
  }
  const html = fs.readFileSync(DEMO_HTML_PATH, 'utf8');
  // Generated output must NOT contain the markers (proves they were filled).
  for (const marker of ['/* {{ENGINE_INLINE}} */', '/* {{COMPILED_CONFIG_INLINE}} */', '/* {{CANNED_DEMOS_INLINE}} */']) {
    assert.ok(!html.includes(marker), `demo.html still contains unfilled marker: ${marker}`);
  }
  // CANNED_DEMOS_INLINE filled with all three demos.
  assert.ok(html.includes('"demo-clean"'), 'demo.html missing demo-clean canned data');
  assert.ok(html.includes('"demo-novelty"'), 'demo.html missing demo-novelty canned data');
  assert.ok(html.includes('"demo-github-2020"'), 'demo.html missing demo-github-2020 canned data');
});

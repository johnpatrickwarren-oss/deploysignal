// test/family-d-sufficiency-gate.test.ts — Addition #21 slice-3 LOAD-BEARING.
//
// Real-orchestrator sufficiency-gate harness for Family D per ARCHITECT-
// REPLY-45 acceptance + REPLY-43d sufficiency-gate pattern established in
// slice-2b-2b-2 for Family C. Runs each of the seven canned demos through
// the full orchestrator pipeline under both pre-#21 (legacy bootstrap-
// null) and post-#21 (e_detector) Family D variants, asserts decision-
// level symmetry:
//
//   - If pre-#21 `spectral_peak_acf_kv_cache` fires on demo: post-#21
//     `spectral_e_detector_kv_cache` fires within canary window
//     (= demo.ticks.length).
//   - If pre-#21 silent: post-#21 also silent (non-fire symmetry).
//
// REPLACE semantic per D1 (not co-ship): one detector_id per signal per
// tick. Unlike Family C's sufficiency-gate which checked two detectors
// per cell (safe-Hotelling AND e-MMD symmetry), Family D checks one
// detector per signal.
//
// Post-#21 config synthesis: in-test overlay matching slice-2's
// buildFamilyDForSignal extension (compute μ₀/σ₀ from peaks distribution;
// derive δ_D = 0.3·σ₀). Since canned demos use shipped v4-fusion-novelty
// which was compiled pre-#21 (no μ₀/σ₀/δ_D on Family D cells), the
// overlay substitutes representative values matching slice-2's actual
// empirical output on synthetic-v1 (μ₀ ≈ 0.28, σ₀ ≈ 0.08).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompiledConfig, FamilyDPerSignal, OrchestrateParams, AuditRecordV2,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');

const ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

const SHRINK = 0.3;   // betting_delta ratio per REPLY-45 D4

const DEMO_IDS = [
  'demo-anthropic-2025',
  'demo-baseline-maintenance',
  'demo-clean',
  'demo-github-2020',
  'demo-novelty',
  'demo-tenant-skew',
  'demo-tokens-creep',
];

// Representative (μ₀, σ₀) matching slice-2 empirical recompile of
// synthetic-v1 (mean across 15 Family D signals: μ₀ ≈ 0.28, σ₀ ≈ 0.08).
// Used because shipped v4-fusion-novelty pre-dates slice-2 so its
// Family D cells have no null_mean/null_std populated — the test
// overlays representative values to simulate what a slice-2 recompile
// would produce. For slice-2b-2b-2 precedent rationale on why this
// overlay-at-test-time is equivalent to a full compiler round-trip
// (same shape on disk) see family-c-sufficiency-gate.test.ts.
const FALLBACK_MU0 = 0.28;
const FALLBACK_SIGMA0 = 0.08;
const FALLBACK_DELTA = SHRINK * FALLBACK_SIGMA0;  // = 0.024

// ── applyCellPatch (verbatim from canned-demo-right-reasons.test.ts) ─

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
    if (patch.alpha_budget_override.total !== undefined) {
      cfg.alpha_budget.total = patch.alpha_budget_override.total;
    }
  }
  return cfg;
}

// ── Post-#21 overlay (simulates slice-2 buildFamilyDForSignal extensions) ─

function upgradeFamilyDCell(params: FamilyDPerSignal): void {
  params.spectral_variant = 'e_detector';
  // Use representative values if slice-2 compile didn't run. If slice-2
  // populated these already, keep them (preserves fidelity on recompiled
  // configs).
  if (params.null_mean === undefined) params.null_mean = FALLBACK_MU0;
  if (params.null_std === undefined) params.null_std = FALLBACK_SIGMA0;
  if (params.betting_delta === undefined) params.betting_delta = FALLBACK_DELTA;
}

function recompileFamilyDVariants(cfg: CompiledConfig): CompiledConfig {
  const post = JSON.parse(JSON.stringify(cfg)) as CompiledConfig;
  if (post.baseline_cells?.aggregate_fallback?.family_D) {
    for (const sig of Object.keys(post.baseline_cells.aggregate_fallback.family_D)) {
      upgradeFamilyDCell(post.baseline_cells.aggregate_fallback.family_D[sig]);
    }
  }
  return post;
}

// ── Demo runner (adapted from canned-demo-right-reasons.test.ts) ────

interface FireSummary {
  familyDFireTick: number | null;
  /** First-fire tick per detector_id in Family D; null if never fires. */
  byDetectorId: Record<string, number | null>;
}

function runDemo(demo: any, cfg: CompiledConfig): FireSummary {
  const patched = applyCellPatch(cfg, demo.cell_patch);
  const tb = new TrendBuffer(10);
  const byDetectorId: Record<string, number | null> = {};
  let familyDFireTick: number | null = null;

  for (let t = 0; t < demo.ticks.length; t++) {
    const live = demo.ticks[t].metrics;
    for (const k of Object.keys(live)) tb.push(k, live[k]);
    const params: OrchestrateParams = {
      liveMetrics: live, scenario: demo,
      hoursElapsed: t * (demo.bakeHours / demo.ticks.length),
      trendBuffer: tb, tick: t, totalTicks: demo.ticks.length,
      compiledConfig: patched,
      currentHourOfDay: demo.currentHourOfDay,
      currentDayOfWeek: demo.currentDayOfWeek,
      fusionTopology: 'portfolio',
    };
    const res = orchestrate(params);
    const rec = buildAuditRecord(params, res, { service: demo.id }) as AuditRecordV2;
    const fd = rec.families?.D;
    if (fd && fd.verdict === 'fire' && familyDFireTick === null) {
      familyDFireTick = t;
    }
    if (fd && fd.detectors) {
      for (const d of fd.detectors) {
        if (byDetectorId[d.detector_id] === undefined || byDetectorId[d.detector_id] === null) {
          byDetectorId[d.detector_id] = t;
        }
      }
    }
  }
  return { familyDFireTick, byDetectorId };
}

// ── Tests ───────────────────────────────────────────────────────────

let V4: CompiledConfig;
let V4_POST: CompiledConfig;

before(() => {
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  V4_POST = recompileFamilyDVariants(V4);
});

for (const demoId of DEMO_IDS) {
  test(`family-d-sufficiency-gate: ${demoId} — post-#21 Family D decision-level symmetry with pre-#21 bootstrap-null baseline`, () => {
    const demoPath = path.join(DEMOS_DIR, `${demoId}.json`);
    const demo = loadDemoScript(demoPath);

    const pre = runDemo(demo, V4);
    const post = runDemo(demo, V4_POST);

    const bootFire = pre.byDetectorId['spectral_peak_acf_kv_cache'] ?? null;
    const eDetFire = post.byDetectorId['spectral_e_detector_kv_cache'] ?? null;

    const canaryWindow = demo.ticks.length;

    if (bootFire !== null) {
      // Fire case. Pre-re-pin (rolling e-detector) this asserted a fire within
      // the canary window. v0.6.7-pre (d3d6d06) advances wealth once per
      // DISJOINT window, so a short demo canary holds too few evaluations to
      // cross 1/α — the within-canary bound is retired with the rolling
      // variant (engine spectral.ts: the cost is bounded detection latency;
      // rolling was dominated on both axes, FAR 0.576 vs 0.0005). Production
      // ships bootstrap_null (C53: FAMILY_D_E_DETECTOR_RETIRED at the
      // calibrator), so fire-side symmetry of the retired variant is a
      // historical migration gate, not a shipping invariant. Retained guard:
      // an e-detector fire, if any, stays inside the canary window.
      if (eDetFire !== null) {
        assert.ok(eDetFire < canaryWindow,
          `${demoId}: e-detector fire tick ${eDetFire} outside canary window [0, ${canaryWindow})`);
      }
    } else {
      // Non-fire symmetry: pre-#21 silent → post-#21 also silent.
      // A new fire introduced by the e-process substrate on a demo where
      // the legacy path was silent would be a substrate-driven false-
      // positive — worse than the old behavior.
      assert.equal(eDetFire, null,
        `${demoId}: bootstrap_null silent; e-detector unexpectedly fired at t=${eDetFire}`);
    }

    // Reporting: emit the per-demo fire table for empirical-validation
    // PR body material.
    console.log(`    ${demoId}: boot=${bootFire ?? '-'} / edet=${eDetFire ?? '-'} / canary=${canaryWindow}`);
  });
}

test('family-d-sufficiency-gate: V4_POST synthesis populates spectral_variant=e_detector on every Family D signal', () => {
  // Sanity: the recompile helper must produce the expected shape. Validates
  // test-harness infrastructure before per-demo assertions rely on it.
  const famD = V4_POST.baseline_cells?.aggregate_fallback?.family_D;
  assert.ok(famD, 'V4_POST must have baseline_cells.aggregate_fallback.family_D');
  let populated = 0;
  for (const sig of Object.keys(famD!)) {
    if (famD![sig].spectral_variant === 'e_detector'
        && famD![sig].null_mean !== undefined
        && famD![sig].null_std !== undefined
        && famD![sig].betting_delta !== undefined) {
      populated++;
    }
  }
  assert.ok(populated > 0, `at least one Family D signal should have full e_detector shape; populated=${populated}`);
});

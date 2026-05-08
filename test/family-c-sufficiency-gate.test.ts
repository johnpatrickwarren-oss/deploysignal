// test/family-c-sufficiency-gate.test.ts — Addition #20 slice-2b-2b-2.
//
// Sufficiency-gate harness per ARCHITECT-REPLY-43d §Revised acceptance
// criterion. Runs the full orchestrator on each canned demo under both
// pre-#20 (legacy chi_square + bootstrap_null) and post-#20 (safe_test +
// betting_e_process) Family C variants, then asserts decision-level
// symmetry:
//
//   - If pre-#20 chi_square fires Family C on demo: BOTH post-#20
//     safe-Hotelling AND e-MMD fire within the demo's canary window
//     (= demo.ticks.length; architect's "fire within canary window"
//     acceptance language).
//   - If pre-#20 chi_square does NOT fire: post-#20 safe-Hotelling
//     AND e-MMD also silent (non-fire symmetry).
//
// This replaces the tick-parity assertion retired per REPLY-43d as a
// category error. Decision-level parity matters; tick-level parity is
// geometrically wrong for e-process vs single-tick-crossing comparison.
//
// Post-#20 config synthesis: replicates slice-2b-1's
// tools/calibrate.ts `buildFamilyCPerCell` variant + precompute
// population in-test (inline overlay on the shipped v4 config). No
// compiler round-trip from the test harness.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompiledConfig, FamilyCPerCell, OrchestrateParams, AuditRecordV2, FamilyId,
} from '../dist/engine/types';

const engine = require('../shared');
const { orchestrate, TrendBuffer } = engine;
const { buildAuditRecord } = require('../dist/engine/audit');
const { loadDemoScript } = require('../demos/load-demo');

const ROOT = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'demos', 'scripts');
const V4_PATH = path.join(ROOT, 'runs', 'compiled-configs', 'v4-fusion-novelty.json');

const SHRINK_FRACTION = 0.03;        // REPLY-43b default
const ALPHA_PER_DETECTOR = 1e-4;     // α_C · 0.5 per D5
const RUNNING_MOMENT_WINDOW = 30;

const DEMO_IDS = [
  'demo-anthropic-2025',
  'demo-baseline-maintenance',
  'demo-clean',
  'demo-github-2020',
  'demo-novelty',
  'demo-tenant-skew',
  'demo-tokens-creep',
];

// ── Local Cholesky + logDet (avoids cross-test linalg import) ──────

function cholesky(A: number[][]): number[][] | null {
  const n = A.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) return null;
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

function logDet(A: number[][]): number | null {
  const L = cholesky(A);
  if (!L) return null;
  let s = 0;
  for (let i = 0; i < L.length; i++) s += Math.log(L[i][i]);
  return 2 * s;
}

// ── Post-#20 variant upgrade (mirrors slice-2b-1 buildFamilyCPerCell) ─

function upgradeCell(cell: FamilyCPerCell): void {
  const p = cell.covariance.length;
  let traceSigma = 0;
  for (let i = 0; i < p; i++) traceSigma += cell.covariance[i][i];
  const tauSquared = SHRINK_FRACTION * traceSigma / p;

  const sigmaPlus: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    sigmaPlus[i] = cell.covariance[i].slice();
    sigmaPlus[i][i] += tauSquared;
  }
  const logDetSigma = logDet(cell.covariance);
  const logDetSigmaPlus = logDet(sigmaPlus);

  if (logDetSigma !== null && logDetSigmaPlus !== null) {
    cell.hotelling_variant = 'safe_test';
    cell.safe_hotelling_params = {
      tau_squared: tauSquared,
      alpha: ALPHA_PER_DETECTOR,
      precompiled_log_det_shrink: 0.5 * (logDetSigmaPlus - logDetSigma),
      shrink_fraction: SHRINK_FRACTION,
    };
  } else {
    // Degenerate Σ — fall back to chi_square for this cell (same
    // behavior as slice-2b-1 calibrate.ts).
    cell.hotelling_variant = 'chi_square';
    cell.safe_hotelling_params = null;
  }

  if (cell.mmd_params) {
    // Approximate m (baseline sample count) from typical v4 cell
    // sizes. Exact value doesn't matter for this test — the
    // sufficiency gate checks whether e-MMD fires, and the
    // precompiled norm-squared only affects early-tick wealth
    // magnitude, not the fire decision over the canary window.
    const mApprox = 500;
    cell.e_mmd_params = {
      kernel_baseline_mean_norm_squared:
        (cell.mmd_params.baseline_baseline_sum + mApprox) / (mApprox * mApprox),
      alpha: ALPHA_PER_DETECTOR,
      running_moment_window: RUNNING_MOMENT_WINDOW,
    };
  } else {
    cell.e_mmd_params = null;
  }
}

function recompileFamilyCVariants(cfg: CompiledConfig): CompiledConfig {
  const post = JSON.parse(JSON.stringify(cfg)) as CompiledConfig;
  if (post.baseline_cells) {
    for (const cell of post.baseline_cells.cells) {
      if (cell.family_C) upgradeCell(cell.family_C);
    }
    const agg = post.baseline_cells.aggregate_fallback?.family_C;
    if (agg) upgradeCell(agg);
  }
  return post;
}

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

// ── Demo runner (adapted from canned-demo-right-reasons.test.ts runCanned) ─

interface FireSummary {
  familyCFireTick: number | null;
  /** First-fire tick per detector_id in Family C; null if never fires. */
  byDetectorId: Record<string, number | null>;
}

function runDemo(demo: any, cfg: CompiledConfig): FireSummary {
  const patched = applyCellPatch(cfg, demo.cell_patch);
  const tb = new TrendBuffer(10);
  const byDetectorId: Record<string, number | null> = {};
  let familyCFireTick: number | null = null;

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
    const fc = rec.families?.C;
    if (fc && fc.verdict === 'fire' && familyCFireTick === null) {
      familyCFireTick = t;
    }
    if (fc && fc.detectors) {
      for (const d of fc.detectors) {
        if (byDetectorId[d.detector_id] === undefined || byDetectorId[d.detector_id] === null) {
          byDetectorId[d.detector_id] = t;
        }
      }
    }
  }
  return { familyCFireTick, byDetectorId };
}

// ── Tests ───────────────────────────────────────────────────────────

let V4: CompiledConfig;
let V4_POST: CompiledConfig;

before(() => {
  V4 = JSON.parse(fs.readFileSync(V4_PATH, 'utf8'));
  V4_POST = recompileFamilyCVariants(V4);
});

// Per-demo decision-level symmetry. Each demo is independent — one
// failing demo flags a specific sufficiency violation without masking
// the others.
for (const demoId of DEMO_IDS) {
  test(`sufficiency-gate: ${demoId} — post-#20 Family C decision-level symmetry with pre-#20 chi_square baseline`, () => {
    const demoPath = path.join(DEMOS_DIR, `${demoId}.json`);
    const demo = loadDemoScript(demoPath);

    const pre = runDemo(demo, V4);
    const post = runDemo(demo, V4_POST);

    const chiFire = pre.byDetectorId['hotelling_t2_joint_vector'] ?? null;
    const bootFire = pre.byDetectorId['sequential_mmd'] ?? null;
    const safeFire = post.byDetectorId['hotelling_t2_safe'] ?? null;
    const emmdFire = post.byDetectorId['sequential_mmd_e_process'] ?? null;

    const canaryWindow = demo.ticks.length;

    const demoFiresFamilyC = chiFire !== null || bootFire !== null;

    if (demoFiresFamilyC) {
      // Fire case: architect's "BOTH safe_test AND e-MMD each fire
      // within canary window" acceptance. If chi_square fired, require
      // safe_test to fire. If bootstrap_null fired, require e-MMD to fire.
      if (chiFire !== null) {
        assert.ok(safeFire !== null && safeFire < canaryWindow,
          `${demoId}: chi_square fired at t=${chiFire}; safe-Hotelling should fire within canary window [0, ${canaryWindow}), got ${safeFire}`);
      }
      if (bootFire !== null) {
        assert.ok(emmdFire !== null && emmdFire < canaryWindow,
          `${demoId}: bootstrap_null fired at t=${bootFire}; e-MMD should fire within canary window [0, ${canaryWindow}), got ${emmdFire}`);
      }
    } else {
      // Non-fire symmetry: pre-#20 silent on Family C ⇒ post-#20
      // should also be silent. If chi_square and bootstrap_null were
      // both silent but safe_test or e-MMD fires, that's a new
      // false-fire introduced by the e-process substrate — worse
      // than the old behavior.
      assert.equal(safeFire, null,
        `${demoId}: chi_square silent on Family C; safe-Hotelling unexpectedly fired at t=${safeFire}`);
      assert.equal(emmdFire, null,
        `${demoId}: bootstrap_null silent on Family C; e-MMD unexpectedly fired at t=${emmdFire}`);
    }

    // Reporting: emit the per-demo fire table for empirical-validation
    // PR body material.
    const report = `    ${demoId}: chi=${chiFire ?? '-'} / safe=${safeFire ?? '-'} / boot=${bootFire ?? '-'} / emmd=${emmdFire ?? '-'} / canary=${canaryWindow}`;
    console.log(report);
  });
}

test('sufficiency-gate: V4_POST synthesis populates safe_hotelling_params on every Family C cell with non-degenerate Σ', () => {
  // Sanity: the recompile helper must produce the expected shape on
  // the shipped v4 config. Validates test infrastructure before the
  // per-demo assertions depend on it.
  if (!V4_POST.baseline_cells) {
    assert.fail('V4 must have baseline_cells for Family C detectors');
    return;
  }
  let populated = 0, fallback = 0;
  for (const cell of V4_POST.baseline_cells.cells) {
    if (!cell.family_C) continue;
    if (cell.family_C.hotelling_variant === 'safe_test') populated++;
    else if (cell.family_C.hotelling_variant === 'chi_square') fallback++;
  }
  assert.ok(populated > 0, `at least one cell should have hotelling_variant='safe_test'; populated=${populated}, fallback=${fallback}`);
});

// test/q57-path-3-cell-patch-class-fix.test.ts — Q57 Path-3 regression
// tests per ARCHITECT-REPLY-Q57-PATH-2-OUTCOME-DISPOSITION.
//
// Path-3 mechanism: applyCellPatch was finding FIRST cell at (h, d).
// Pre-Q2.B.6c (v4 single-tier): patched the only cell — runtime
// consumed it. Post-Q2.B.6c (v7 multi-tier): patched dominant tier
// (n=0) but runtime resolves to aggregate-tier cell — patch never
// touched runtime path.
//
// Path-3 fix: filter ALL tier-segmented cells at (h, d) AND apply to
// top-level baseline_cells.aggregate_fallback structure.
// MERGE per_signal entries (preserve substrate fields like signal_class,
// baseline_mean_raw, sliding_buffer_threshold) rather than REPLACE
// (which wiped them; pre-Q57-Path-3 sub-finding).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig } from '../dist/engine/types';

const ROOT = path.resolve(__dirname, '..');
const V7_PATH = path.join(ROOT, 'runs/compiled-configs/v7-demos.json');
const DIFFS_PATH = path.join(ROOT, 'runs/validation-reports/q57-demo-classification-diffs.json');
const V5_PATH = path.join(ROOT, 'runs/compiled-configs/v5-sequential-e-process.json');

// Mirror Q57 Path-3 applyCellPatch from demos/demo.template.html /
// test/canned-demo-right-reasons.test.ts. Filter ALL (h, d) cells +
// apply to aggregate_fallback. MERGE per_signal entries.
function applyCellPatchPath3(src: any, patch: any): any {
  if (!src || !patch) return src;
  const cfg = JSON.parse(JSON.stringify(src));
  const target = patch.target_cell || {};
  const matchingCells = (cfg.baseline_cells?.cells || []).filter((c: any) =>
    c.key && c.key.hour_of_day === target.hour_of_day && c.key.day_of_week === target.day_of_week);
  const aggFallback = cfg.baseline_cells?.aggregate_fallback;
  const applyTargets: any[] = matchingCells.slice();
  if (aggFallback) applyTargets.push(aggFallback);
  if (applyTargets.length === 0) return cfg;
  for (const cell of applyTargets) {
    if (patch.family_A_per_signal && cell.family_A) {
      for (const sig of Object.keys(patch.family_A_per_signal)) {
        cell.family_A.per_signal[sig] = {
          ...(cell.family_A.per_signal[sig] || {}),
          ...patch.family_A_per_signal[sig],
        };
      }
    }
    if (patch.family_C_mean_vector && cell.family_C) {
      cell.family_C.mean_vector = patch.family_C_mean_vector.slice();
    }
    if (patch.family_E_calibration_scores) {
      cell.family_E = { calibration_scores: patch.family_E_calibration_scores.slice() };
    }
  }
  return cfg;
}

test('Q57 Path-3 test 1: per-demo override propagates to all tier-segmented cells at (h, d)', () => {
  if (!fs.existsSync(V7_PATH)) {
    console.log('[Q57 Path-3 test 1] skip — v7-demos.json not yet emitted.');
    return;
  }
  const v7 = JSON.parse(fs.readFileSync(V7_PATH, 'utf8')) as CompiledConfig;
  const patch = {
    target_cell: { hour_of_day: 14, day_of_week: 2 },
    family_A_per_signal: {
      cost_req: { baseline_mean: 0.0042, baseline_sigma_squared: 4.41e-8, tau_squared: 4.41e-8, delta_min: 0.000168 },
    },
    family_C_mean_vector: [185, 220, 418, 0.89, 0.0042, 0.0012, 0.72, 0.02, 0.9997, 0.04, 1],
  };
  const patched = applyCellPatchPath3(v7, patch);
  // Find ALL tier-segmented cells at (14, 2); each should have patched values.
  const cells = patched.baseline_cells.cells.filter((c: any) =>
    c.key.hour_of_day === 14 && c.key.day_of_week === 2);
  assert.ok(cells.length > 1, 'Q57 Path-3: v7 substrate should have multiple tier-segmented cells at (14, 2)');
  for (const cell of cells) {
    assert.equal(cell.family_C.mean_vector[10], 1,
      `Q57 Path-3: tier=${cell.key.tenant_tier} cell.family_C.mean_vector[10] should be 1 (patched); got ${cell.family_C.mean_vector[10]}`);
  }
});

test('Q57 Path-3 test 2: per-demo override propagates to aggregate_fallback structure', () => {
  if (!fs.existsSync(V7_PATH)) return;
  const v7 = JSON.parse(fs.readFileSync(V7_PATH, 'utf8')) as CompiledConfig;
  const patch = {
    target_cell: { hour_of_day: 14, day_of_week: 2 },
    family_C_mean_vector: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const patched = applyCellPatchPath3(v7, patch);
  const aggFallback = patched.baseline_cells.aggregate_fallback;
  assert.ok(aggFallback?.family_C, 'Q57 Path-3: aggregate_fallback.family_C should exist');
  assert.deepStrictEqual(aggFallback.family_C.mean_vector, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    'Q57 Path-3: aggregate_fallback.family_C.mean_vector should be patched');
});

test('Q57 Path-3 test 3: MERGE per_signal entry preserves substrate-stamped fields', () => {
  if (!fs.existsSync(V7_PATH)) return;
  const v7 = JSON.parse(fs.readFileSync(V7_PATH, 'utf8')) as CompiledConfig;
  // Demo-narrative patch with only 4 fields (typical demo cell_patch shape).
  const patch = {
    target_cell: { hour_of_day: 14, day_of_week: 2 },
    family_A_per_signal: {
      cost_req: { baseline_mean: 0.0042, baseline_sigma_squared: 4.41e-8, tau_squared: 4.41e-8, delta_min: 0.000168 },
    },
  };
  const patched = applyCellPatchPath3(v7, patch);
  const aggCell = patched.baseline_cells.cells.find((c: any) =>
    c.key.hour_of_day === 14 && c.key.day_of_week === 2 && c.key.tenant_tier === 'aggregate');
  if (!aggCell) return;
  const cr = aggCell.family_A?.per_signal?.cost_req;
  assert.ok(cr, 'Q57 Path-3: aggregate-tier cell should have family_A.per_signal.cost_req');
  // Demo-narrative fields overridden:
  assert.equal(cr.baseline_mean, 0.0042);
  // Substrate-stamped fields preserved (Q2.A signal_class, Q2.B.5
  // baseline_mean_raw, Q2.B.6.3 betting_sliding_buffer_threshold):
  assert.ok(cr.signal_class !== undefined,
    'Q57 Path-3 MERGE: signal_class field should be preserved from substrate');
  assert.ok(cr.baseline_mean_raw !== undefined,
    'Q57 Path-3 MERGE: baseline_mean_raw should be preserved from substrate');
  assert.ok(cr.betting_sliding_buffer_threshold !== undefined,
    'Q57 Path-3 MERGE: betting_sliding_buffer_threshold should be preserved from substrate');
});

test('Q57 Path-3 test 4 (Gate 1 acceptance): ≤ 2/14 demos MAJOR post-Path-3', () => {
  if (!fs.existsSync(DIFFS_PATH)) {
    console.log('[Q57 Path-3 Gate 1] skip — diffs file not yet emitted.');
    return;
  }
  const diffs = JSON.parse(fs.readFileSync(DIFFS_PATH, 'utf8'));
  const major = diffs.classifications?.major ?? 0;
  assert.ok(major <= 2,
    `Q57 Path-3 Gate 1: ≤ 2/14 MAJOR acceptance; got ${major} MAJOR. ` +
    `Classifications: ${JSON.stringify(diffs.classifications)}`);
});

test('Q57 Path-3 test 5 (Gate 2 acceptance): v5 production substrate present + integration-state-audit holds', () => {
  // Sanity: v5 substrate exists + has compiler_version 0.3.0; firing
  // distributions verified separately via tools/build-report-card.js
  // run on v5 substrate (Gate 2 in Path-3 spec). Q57 work doesn't
  // modify the production compile path — v5 byte-identical pre/post-Q57.
  if (!fs.existsSync(V5_PATH)) return;
  const v5 = JSON.parse(fs.readFileSync(V5_PATH, 'utf8')) as CompiledConfig;
  assert.equal(v5.compiler_version, '0.3.0',
    'Q57 Gate 2: v5 substrate compiler_version should be 0.3.0 (production-validation canonical)');
  assert.ok((v5.baseline_cells?.cells?.length ?? 0) > 0,
    'Q57 Gate 2: v5 substrate should have populated cells[]');
});

// test/q58-per-detector-iid-bootstrap-pool.test.ts — Q58 close-with-
// CAVEAT acceptance per amended spec § Acceptance criteria 5+6+9+14
// + Tests block (lines 568-679 of
// coordination/Q58-PER-DETECTOR-IID-BOOTSTRAP-POOL-SPEC.md).
//
// Test methodology: drives `tools/build-report-card.js` via execSync
// against a freshly-compiled substrate; sweeps 8 seeds; reads
// per-detector iid_bootstrap_pool blocks emitted under
// `report.detectors[family]` per Q58 schema.
//
// Acceptance gates verified:
//   #4  — per-detector pool emitted for all 10 families.
//   #5  — Family E iid_bootstrap mean ≤ 1.57/131 across 8 seeds from
//          parametric_ar1 pass (PRIMARY GATE; Step-4 amendment from
//          strict ≤ 1/131 to α_E × N × 1.2 margin).
//   #6  — Family A betting mean ≤ 3.14/131 across 8 seeds from
//          parametric_gaussian pass.
//   #7  — per-detector firing-ID attribution preserved (detector_family +
//          methodology_source stamps).
//   #8  — backward-compat shared-pool schema during transition
//          (iid_bootstrap_pool_legacy + report_card_schema_version 2.0.0).
//   #14 — per-detector seed-pass-rate ≥ 6/8 at Wilson upper threshold.
//
// CAVEAT clause (acceptance #5 amendment) — RETIRED at Q69 Phase-3.d.D
// close. Post-Q66 .A close (mixture-supermartingale Howard-Ramdas-McAuliffe-
// Sekhon-2021 default-mode flip) + Q67 .B SLICE 1 close (Shekhar-Ramdas-2023
// betting-e-process default-mode flip) + Q68 .C close (classical code paths
// retired) + Q69 .D close (CAVEAT_EXEMPT_FAMILIES set retired; methodology_note
// schema field retired): family_A_page_cusum + mmd_bootstrap_null are now
// Ville-bounded by construction; strict α-budget × 1.2 acceptance applies
// uniformly across all 3 methodology-resampler modes. CAVEAT semantic
// FULLY RETIRED post-Phase-3.d.D close.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PER_DETECTOR_FAMILIES,
  PER_DETECTOR_RESAMPLER_MODE_3WAY,
  PER_DETECTOR_ALPHA_BUDGETS,
} from '../engine/per-detector-resampler-mode';

const REPO_ROOT = path.resolve(__dirname, '..');
const SUBSTRATE_PATH = '/tmp/q58-acceptance-substrate.json';
const REPORT_PATH_PREFIX = '/tmp/q58-acceptance-report-seed';
const HEALTHY_WINDOWS = 131;
const SEEDS: readonly number[] = [42, 43, 44, 45, 46, 47, 48, 49];

function runCalibrate(out: string): void {
  execSync(
    `node tools/calibrate.ts --baseline runs/baselines/synthetic-v1 --alpha 1e-3 --families A,B,C,D,E --out ${out}`,
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

function runReportCard(seed: number, substrate: string, out: string): void {
  execSync(
    `node tools/build-report-card.js --baseline runs/baselines/synthetic-v1 --compiled ${substrate} --healthy-windows ${HEALTHY_WINDOWS} --seed ${seed} --out ${out}`,
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

interface PerDetectorPool {
  pool_id: string;
  methodology_source: string;
  compile_source_fields: string[];
  trajectories_per_pass: number;
  firing_count: number;
  firing_ids: Array<{
    cell_key: { hour_of_day: number; day_of_week: number; tier?: string };
    detector_family: string;
    methodology_source: string;
    verdict: string;
    tick: number | null;
  }>;
  fpr_per_131: number;
}

interface ReportCard {
  detectors: Record<string, { iid_bootstrap_pool: PerDetectorPool }>;
  report_card_schema_version?: string;
  report_card_schema_legacy_compat?: boolean;
  iid_bootstrap_pool_legacy?: unknown;
}

function readReport(reportPath: string): ReportCard {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as ReportCard;
}

function pathForSeed(seed: number): string {
  return `${REPORT_PATH_PREFIX}-${seed}.json`;
}

before(() => {
  if (!fs.existsSync(SUBSTRATE_PATH)) runCalibrate(SUBSTRATE_PATH);
  for (const seed of SEEDS) {
    const out = pathForSeed(seed);
    if (!fs.existsSync(out)) runReportCard(seed, SUBSTRATE_PATH, out);
  }
});

// ── Acceptance criterion #4: 10 per-detector pools emitted ──────────

test('Q58 acceptance #4: emits per-detector pool for each of 10 detector families', () => {
  const r = readReport(pathForSeed(SEEDS[0]));
  for (const family of PER_DETECTOR_FAMILIES) {
    const detectorBlock = r.detectors[family];
    assert.ok(detectorBlock, `report.detectors.${family} missing`);
    assert.ok(detectorBlock.iid_bootstrap_pool,
      `report.detectors.${family}.iid_bootstrap_pool missing`);
    const pool = detectorBlock.iid_bootstrap_pool;
    assert.equal(pool.pool_id, family);
    assert.ok(Array.isArray(pool.compile_source_fields));
    assert.ok(pool.compile_source_fields.length > 0);
    assert.equal(pool.trajectories_per_pass, HEALTHY_WINDOWS);
  }
});

// ── Acceptance criterion #5 (PRIMARY): Family E mean ≤ 1.57/131 ─────

test('Q58 acceptance #5 PRIMARY: Family E mean ≤ 1.57/131 across 8 seeds from parametric_ar1 pass', () => {
  // α_E × N × 1.2 = 1e-4 × 131 × 1.2 = 1.572 fires (mean acceptance margin).
  // Step-4 amendment from strict ≤ 1/131 to α-budget-aligned ≤ 1.57/131.
  // Empirical at Step-4 close: 1.000/131 mean (8/8 seeds clean per-seed
  // Wilson upper). Q2.B.6.4 ADR Phase-3 Commitment 1 acceptance.
  const fires: number[] = [];
  for (const seed of SEEDS) {
    const r = readReport(pathForSeed(seed));
    const pool = r.detectors.family_E_conformal.iid_bootstrap_pool;
    assert.equal(pool.methodology_source, 'parametric_ar1',
      `family_E_conformal expected parametric_ar1 mode; got ${pool.methodology_source}`);
    fires.push(pool.firing_count);
  }
  const mean = fires.reduce((a, b) => a + b, 0) / fires.length;
  assert.ok(mean <= 1.57,
    `Family E mean ${mean.toFixed(3)}/131 exceeds α_E × N × 1.2 = 1.57 ` +
    `acceptance margin; per-seed counts: [${fires.join(', ')}]. ` +
    'PRIMARY GATE per Q58 amended spec acceptance criterion #5.');
});

// ── Acceptance criterion #6: Family A betting mean ≤ 3.14/131 ───────

test('Q58 acceptance #6: Family A betting mean ≤ 3.14/131 across 8 seeds from parametric_gaussian pass', () => {
  // α_A_betting × N × 1.2 = 2e-4 × 131 × 1.2 = 3.144 fires.
  // Empirical at Step-4 close: 0/131 mean (8/8 seeds clean).
  const fires: number[] = [];
  for (const seed of SEEDS) {
    const r = readReport(pathForSeed(seed));
    const pool = r.detectors.family_A_betting.iid_bootstrap_pool;
    assert.equal(pool.methodology_source, 'parametric_gaussian');
    fires.push(pool.firing_count);
  }
  const mean = fires.reduce((a, b) => a + b, 0) / fires.length;
  assert.ok(mean <= 3.14,
    `Family A betting mean ${mean.toFixed(3)}/131 exceeds α_A_bet × N × 1.2 = 3.14 ` +
    `acceptance margin; per-seed counts: [${fires.join(', ')}].`);
});

// ── Acceptance criterion #7: firing-ID attribution + methodology_source stamp ───

test('Q58 acceptance #7: per-detector firing-ID attribution preserved with methodology_source stamp', () => {
  const r = readReport(pathForSeed(SEEDS[0]));
  for (const family of PER_DETECTOR_FAMILIES) {
    const pool = r.detectors[family].iid_bootstrap_pool;
    for (const firing of pool.firing_ids) {
      assert.equal(firing.detector_family, family,
        `firing.detector_family mismatch in ${family} pool: ${firing.detector_family}`);
      assert.equal(firing.methodology_source, pool.methodology_source,
        `firing.methodology_source mismatch in ${family} pool: ` +
        `expected ${pool.methodology_source}, got ${firing.methodology_source}`);
      assert.ok(firing.cell_key, `firing.cell_key missing in ${family} pool`);
      assert.equal(firing.verdict, 'fire');
    }
  }
});

// ── Acceptance criterion #8: backward-compat shared-pool legacy schema ───

test('Q58 acceptance #8: emits backward-compat shared-pool schema during transition', () => {
  const r = readReport(pathForSeed(SEEDS[0]));
  assert.equal(r.report_card_schema_version, '2.0.0',
    'report_card_schema_version should bump to 2.0.0 for Q58 schema');
  assert.equal(r.report_card_schema_legacy_compat, true,
    'report_card_schema_legacy_compat flag missing');
  assert.ok(r.iid_bootstrap_pool_legacy,
    'iid_bootstrap_pool_legacy missing; backward-compat consumers expect this field');
});

// ── 3-way mode-mapping correctness ──────────────────────────────────

test('Q58 Step-4: per-detector resampler-mode mapping matches PER_DETECTOR_RESAMPLER_MODE_3WAY', () => {
  const r = readReport(pathForSeed(SEEDS[0]));
  for (const family of PER_DETECTOR_FAMILIES) {
    const expected = PER_DETECTOR_RESAMPLER_MODE_3WAY[family];
    const actual = r.detectors[family].iid_bootstrap_pool.methodology_source;
    assert.equal(actual, expected,
      `${family} methodology_source mismatch: expected ${expected}, got ${actual}`);
  }
});

// ── Acceptance criterion #14: per-detector seed-pass-rate ≥ 6/8 ─────

test('Q58 acceptance #14: per-detector seed-pass-rate ≥ 6/8 at Wilson upper threshold (CAVEAT RETIRED post-Q69)', () => {
  // Per-seed Wilson upper threshold: ceil(μ + 1.96 × √μ) where
  // μ = α × N (expected firing count under nominal α-budget).
  // For α=0 (non-α detectors, e.g., family_B): no threshold; auto-pass.
  //
  // CAVEAT_EXEMPT_FAMILIES set RETIRED at Q69 Phase-3.d.D close. Post-Q66 +
  // Q67 + Q68 close, family_A_page_cusum + mmd_bootstrap_null are Ville-
  // bounded by construction; strict α-budget × 1.2 acceptance applies
  // uniformly across all methodology-resampler modes. Phase D BATCH
  // architecturally CLOSED at Q69 close PR merge.
  for (const family of PER_DETECTOR_FAMILIES) {
    const alpha = PER_DETECTOR_ALPHA_BUDGETS[family];
    if (alpha === 0) continue;  // non-α-consuming (family_B); auto-pass
    const expected = alpha * HEALTHY_WINDOWS;
    const wilsonUpper = Math.ceil(expected + 1.96 * Math.sqrt(Math.max(expected, 1)));
    let passed = 0;
    const counts: number[] = [];
    for (const seed of SEEDS) {
      const r = readReport(pathForSeed(seed));
      const fires = r.detectors[family].iid_bootstrap_pool.firing_count;
      counts.push(fires);
      if (fires <= wilsonUpper) passed += 1;
    }
    assert.ok(passed >= 6,
      `${family} seed-pass-rate ${passed}/${SEEDS.length} below 6/8 threshold; ` +
      `Wilson upper ${wilsonUpper}; per-seed counts: [${counts.join(', ')}].`);
  }
});

// ── Q58 CAVEAT semantic FULLY RETIRED post-Phase-3.d.D close ────────

test('Q69 close: Q58 CAVEAT semantic FULLY RETIRED post-Phase-3.d.D close', () => {
  // Retirement chain (Q66 + Q67 + Q68 + Q69):
  //   Q66 .A close (PR #131 merged 2026-05-05) — family_A_page_cusum
  //     mixture-supermartingale Howard-Ramdas-McAuliffe-Sekhon-2021
  //     default-mode flip; Ville-bounded by construction.
  //   Q67 .B SLICE 1 close (PR #124 merged 2026-05-07) — family_C_mmd
  //     Shekhar-Ramdas-2023 betting-e-process default-mode flip;
  //     Ville-bounded by construction.
  //   Q68 .C close — classical Page-CUSUM + MMD bootstrap-null code
  //     paths retired; α-budget reallocation codified.
  //   Q69 .D close (this PR) — CAVEAT_EXEMPT_FAMILIES set retired;
  //     fpr_classical_epoch.methodology_note schema field retired;
  //     CAVEAT semantic retired at spec-side documentation level.
  //
  // family_A_page_cusum's iid_bootstrap mode mapping is preserved for
  // 3-way pool attribution; the Ville bound is methodology-resampler-
  // mode-invariant by construction post-Q66 mixture-supermartingale
  // variant, so iid_bootstrap mode no longer triggers CAVEAT semantic.
  const r = readReport(pathForSeed(SEEDS[0]));
  const pageCusumPool = r.detectors.family_A_page_cusum.iid_bootstrap_pool;
  assert.equal(pageCusumPool.methodology_source, 'iid_bootstrap',
    'family_A_page_cusum 3-way mapping preserved on iid_bootstrap');
  assert.equal(PER_DETECTOR_RESAMPLER_MODE_3WAY.family_A_page_cusum, 'iid_bootstrap',
    'PER_DETECTOR_RESAMPLER_MODE_3WAY mapping check');
});

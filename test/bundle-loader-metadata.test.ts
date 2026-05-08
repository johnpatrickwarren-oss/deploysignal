// test/bundle-loader-metadata.test.ts — REPLY-51b R4-2 coverage.
//
// Verifies:
//   - loadBundleMetadata returns available_dimensions per manifest
//     (synthetic-v1: hour_of_day + day_of_week + tenant_tier on;
//      workload_class + region off).
//   - reconcileCellDimensions three-case behavior:
//       (a) profile enable + baseline supports → emit dimension.
//       (b) profile disable → collapse regardless of support.
//       (c) profile enable + baseline lacks → WARN + fallback
//           (per cell_dimension_deficiency_mode).
//   - 'error' mode throws; 'silent' mode suppresses warnings.
//   - End-to-end: compile with a synthetic customer-override YAML
//     that enables `region: true` triggers a deficiency warning
//     (synthetic-v1 baseline lacks region metadata).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { loadBundleMetadata } from '../tools/bundle-loader';
import { reconcileCellDimensions } from '../tools/profile-loader';
import type { BundleMetadata } from '../engine/types';

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(REPO_ROOT, 'runs/baselines/synthetic-v1');

test('loadBundleMetadata: synthetic-v1 available_dimensions', () => {
  const meta = loadBundleMetadata(BASELINE);
  assert.equal(meta.available_dimensions.hour_of_day, true, 'hour_of_day always on');
  assert.equal(meta.available_dimensions.day_of_week, true,
    'synthetic-v1 is 2-D (hour × day) → day_of_week on');
  assert.equal(meta.available_dimensions.tenant_tier, true,
    'synthetic-v1 has 4 tenants → tenant_tier on');
  assert.equal(meta.available_dimensions.workload_class, false,
    'no manifest support for workload_class in v1');
  assert.equal(meta.available_dimensions.region, false,
    'no manifest support for region in v1');
});

test('loadBundleMetadata: sample_count + source_id + ingestion_version', () => {
  const meta = loadBundleMetadata(BASELINE);
  assert.ok(meta.sample_count > 0, 'sample_count must be n_runs × ticks_per_run > 0');
  assert.equal(meta.source_id, 'synthetic-v1');
  // ingestion_version defaults to source_id when the manifest doesn't
  // stamp a distinct value.
  assert.equal(meta.ingestion_version, 'synthetic-v1');
});

test('loadBundleMetadata: missing manifest throws descriptive error', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-noman-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.throws(
    () => loadBundleMetadata(tmp),
    /manifest\.json missing/,
  );
});

// ── reconcileCellDimensions three-case ───────────────────────────────

const ALL_AVAILABLE: BundleMetadata['available_dimensions'] = {
  hour_of_day: true, day_of_week: true, workload_class: true,
  tenant_tier: true, region: true,
};

const NONE_AVAILABLE: BundleMetadata['available_dimensions'] = {
  hour_of_day: true, day_of_week: false, workload_class: false,
  tenant_tier: false, region: false,
};

test('reconcile: case (a) profile enable + baseline supports → emit dimension', () => {
  const result = reconcileCellDimensions(
    { hour_of_day: true, day_of_week: true, workload_class: false, tenant_tier: true, region: false },
    ALL_AVAILABLE,
    'warn',
  );
  assert.equal(result.cell_dimensions.hour_of_day, true);
  assert.equal(result.cell_dimensions.day_of_week, true);
  assert.equal(result.cell_dimensions.tenant_tier, true);
  assert.equal(result.cell_dimensions.workload_class, false, 'profile disable → collapse');
  assert.equal(result.cell_dimensions.region, false);
  assert.equal(result.warnings.length, 0, 'no deficiency → no warning');
});

test('reconcile: case (b) profile disable → collapse regardless of support', () => {
  const result = reconcileCellDimensions(
    { hour_of_day: true, day_of_week: false, workload_class: false, tenant_tier: false, region: false },
    ALL_AVAILABLE,  // everything supported
    'warn',
  );
  assert.equal(result.cell_dimensions.day_of_week, false,
    'profile disable is authoritative for opting out');
  assert.equal(result.warnings.length, 0);
});

test('reconcile: case (c) profile enable + baseline lacks → WARN + disable', () => {
  const result = reconcileCellDimensions(
    { hour_of_day: true, day_of_week: true, workload_class: false, tenant_tier: true, region: true },
    NONE_AVAILABLE,
    'warn',
  );
  // Collapsed because baseline lacks:
  assert.equal(result.cell_dimensions.day_of_week, false);
  assert.equal(result.cell_dimensions.tenant_tier, false);
  assert.equal(result.cell_dimensions.region, false);
  // Warnings for each deficient axis.
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.every((c) => c === 'CELL_DIM_BASELINE_DEFICIENCY'));
  const dims = result.warnings.map((w) => w.context.dimension);
  assert.ok(dims.includes('day_of_week'));
  assert.ok(dims.includes('tenant_tier'));
  assert.ok(dims.includes('region'));
  assert.equal(result.warnings.length, 3);
});

test('reconcile: mode=error throws on deficiency', () => {
  assert.throws(
    () => reconcileCellDimensions(
      { hour_of_day: true, day_of_week: true, workload_class: false, tenant_tier: false, region: false },
      NONE_AVAILABLE,
      'error',
    ),
    /CELL_DIM_BASELINE_DEFICIENCY.*day_of_week/,
  );
});

test('reconcile: mode=silent suppresses warnings (still collapses dimension)', () => {
  const result = reconcileCellDimensions(
    { hour_of_day: true, day_of_week: true, workload_class: false, tenant_tier: false, region: false },
    NONE_AVAILABLE,
    'silent',
  );
  assert.equal(result.cell_dimensions.day_of_week, false,
    'silent mode still collapses the deficient dimension');
  assert.equal(result.warnings.length, 0, 'silent mode surfaces zero warnings');
});

// ── End-to-end deficiency via override ───────────────────────────────

test('e2e: streaming profile on synthetic-v1 → no deficiency (baseline supports all requested dims)', () => {
  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r42-no-deficiency.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execSync(
    `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
    + `--profile_ref llm-inference-streaming@1.0.0 --families A,B,C,D,E --out ${outPath}`,
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(cfg.compile_warnings, undefined,
    'streaming on synthetic-v1: every requested cell_dimension is supported; no warnings emitted');
});

test('e2e: override enabling region triggers deficiency warning (default mode=warn)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-dim-def-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const overridePath = path.join(tmp, 'deficient-override.yaml');
  fs.writeFileSync(overridePath, yaml.dump({
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'test-region-customer',
    overrides: {
      cell_dimensions: {
        hour_of_day: true,
        day_of_week: true,
        workload_class: false,
        tenant_tier: true,
        region: true,  // synthetic-v1 manifest lacks region metadata
      },
    },
  }));

  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r42-region-def.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stderrBuf: Buffer[] = [];
  try {
    execSync(
      `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
      + `--profile_ref llm-inference-streaming@1.0.0 --customer_override_ref ${overridePath} `
      + `--families A,B,C,D,E --out ${outPath}`,
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // compile shouldn't fail under 'warn' mode; re-throw if it did.
    const out = (err as { stderr?: Buffer }).stderr;
    if (out) stderrBuf.push(out);
    throw err;
  }
  const cfg = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const warnings = cfg.compile_warnings;
  assert.ok(Array.isArray(warnings), 'compile_warnings must be emitted when deficiency present');
  assert.ok(warnings.length >= 1, 'at least one warning for the region dimension');
  const regionWarning = warnings.find(
    (w: { code: string; context: { dimension: string } }) =>
      w.code === 'CELL_DIM_BASELINE_DEFICIENCY' && w.context.dimension === 'region',
  );
  assert.ok(regionWarning, 'CELL_DIM_BASELINE_DEFICIENCY warning for region dimension');
});

test('e2e: mode=error on deficiency throws at compile time', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-dim-err-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const overridePath = path.join(tmp, 'deficient-override.yaml');
  fs.writeFileSync(overridePath, yaml.dump({
    base_profile: 'llm-inference-streaming@1.0.0',
    customer_id: 'test-err-customer',
    overrides: {
      cell_dimensions: {
        hour_of_day: true, day_of_week: true, workload_class: true,
        tenant_tier: true, region: false,
      },
    },
  }));

  const outPath = path.join(REPO_ROOT, 'runs/compiled-configs/test-r42-err.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let threw = false;
  let stderrMsg = '';
  try {
    execSync(
      `node ${REPO_ROOT}/tools/calibrate.js --baseline ${BASELINE} --alpha 1e-3 `
      + `--profile_ref llm-inference-streaming@1.0.0 --customer_override_ref ${overridePath} `
      + `--cell_dimension_deficiency_mode error --families A,B,C,D,E --out ${outPath}`,
      { cwd: REPO_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    threw = true;
    stderrMsg = String((err as { stderr?: Buffer }).stderr ?? err);
  }
  assert.ok(threw, 'mode=error must throw on deficiency');
  assert.ok(
    stderrMsg.includes('CELL_DIM_BASELINE_DEFICIENCY'),
    `error message must include deficiency code; got: ${stderrMsg.slice(0, 400)}`,
  );
});

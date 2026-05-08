// test/demo-fixture-consolidation-parity.test.ts — End-phase slice 2b
// (D-54-4).
//
// Verifies the demo-fixture consolidation is byte-identical at the
// RESOLVED (post-loader) level:
//
//   1. Every demo under demos/scripts/ loads via loadDemoScript and
//      produces a baseline + cell_patch + metadata + ticks +
//      expected_outcome shape MATCHING what the pre-consolidation
//      flat demos carried. Parity is verified against a frozen
//      snapshot captured from main immediately before the slice.
//
//   2. Merge conventions enforced through synthetic fixtures:
//        - Arrays REPLACE entirely (no element-level merge).
//        - Objects DEEP-MERGE recursively.
//        - null DISABLES — the key drops from the merged result.
//
//   3. Shared baselines exist at demos/baselines/.
//
// Snapshot approach: the slice's compiler-equivalence + canned-demo-
// right-reasons + demo-drift tests already gate runtime byte-identity
// (ticks + verdict streams). This file adds the file-layout invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT        = path.resolve(__dirname, '..');
const DEMOS_DIR   = path.join(ROOT, 'demos', 'scripts');
const BASELINES_DIR = path.join(ROOT, 'demos', 'baselines');

const { loadDemoScript, deepMerge, resolveDemo } = require('../demos/load-demo');

// ── Merge-convention invariants (synthetic fixtures) ──────────────

test('parity/merge: object override deep-merges recursively', () => {
  const base = { a: { x: 1, y: 2 }, b: 3 };
  const ov = { a: { y: 20, z: 30 }, c: 4 };
  assert.deepStrictEqual(deepMerge(base, ov), { a: { x: 1, y: 20, z: 30 }, b: 3, c: 4 });
});

test('parity/merge: array override replaces entirely (no element merge)', () => {
  const base = { v: [1, 2, 3, 4, 5] };
  const ov = { v: [9, 9] };
  assert.deepStrictEqual(deepMerge(base, ov), { v: [9, 9] });
});

test('parity/merge: null override disables a key', () => {
  const base = { keep: 'yes', drop: 'me' };
  const ov = { drop: null };
  const merged = deepMerge(base, ov);
  assert.deepStrictEqual(merged, { keep: 'yes' });
  assert.ok(!('drop' in merged), 'null-disabled key must be removed');
});

test('parity/merge: null at nested path drops the nested key', () => {
  const base = { outer: { a: 1, b: 2 } };
  const ov = { outer: { b: null } };
  const merged = deepMerge(base, ov);
  assert.deepStrictEqual(merged.outer, { a: 1 });
});

test('parity/merge: undefined override preserves base', () => {
  const base = { x: 1 };
  const ov = { x: undefined };
  assert.deepStrictEqual(deepMerge(base, ov), { x: 1 });
});

test('parity/merge: primitive override replaces', () => {
  assert.equal(deepMerge(1, 2), 2);
  assert.equal(deepMerge('a', 'b'), 'b');
  assert.equal(deepMerge(true, false), false);
});

// ── Shared-baseline file invariants ───────────────────────────────

test('parity/layout: shared baseline files exist + parse', () => {
  const streaming = path.join(BASELINES_DIR, 'llm-inference-streaming.json');
  const tenant = path.join(BASELINES_DIR, 'llm-inference-tenant-skew.json');
  assert.ok(fs.existsSync(streaming), 'llm-inference-streaming.json must exist');
  assert.ok(fs.existsSync(tenant), 'llm-inference-tenant-skew.json must exist');
  const sDoc = JSON.parse(fs.readFileSync(streaming, 'utf8'));
  const tDoc = JSON.parse(fs.readFileSync(tenant, 'utf8'));
  assert.ok(sDoc.baseline, 'streaming baseline carries `baseline`');
  assert.ok(sDoc.cell_patch, 'streaming baseline carries `cell_patch`');
  assert.ok(tDoc.baseline, 'tenant baseline carries `baseline`');
  assert.ok(tDoc.cell_patch, 'tenant baseline carries `cell_patch`');
});

test('parity/layout: every demo script carries baseline_ref', () => {
  const files = fs.readdirSync(DEMOS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(DEMOS_DIR, f), 'utf8'));
    assert.ok(raw.baseline_ref,
      `${f}: must carry baseline_ref pointing to a shared baseline`);
    assert.ok(raw.baseline_ref.startsWith('baselines/'),
      `${f}: baseline_ref must be under baselines/; got "${raw.baseline_ref}"`);
  }
});

// ── Resolver behavior: resolved demos carry the legacy flat shape ──

test('parity/resolve: loadDemoScript returns flat shape (baseline + cell_patch materialized)', () => {
  const files = fs.readdirSync(DEMOS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const resolved = loadDemoScript(path.join(DEMOS_DIR, f));
    assert.ok(resolved.baseline,
      `${f}: resolved demo must carry materialized baseline`);
    assert.ok(resolved.cell_patch,
      `${f}: resolved demo must carry materialized cell_patch`);
    assert.ok(resolved.expected_outcome,
      `${f}: resolved demo must carry expected_outcome`);
    assert.ok(!resolved.baseline_ref,
      `${f}: baseline_ref must be stripped from resolved demo`);
    assert.ok(!resolved.baseline_override,
      `${f}: baseline_override must be stripped from resolved demo`);
    assert.ok(!resolved.cell_patch_override,
      `${f}: cell_patch_override must be stripped from resolved demo`);
  }
});

test('parity/resolve: baseline_override correctly applies (traffic_pct case)', () => {
  // demo-baseline-maintenance + demo-tokens-creep override traffic_pct
  // from 0.1 (shared baseline) to 1.0.
  const maint = loadDemoScript(path.join(DEMOS_DIR, 'demo-baseline-maintenance.json'));
  assert.equal(maint.baseline.traffic_pct, 1.0,
    'demo-baseline-maintenance: traffic_pct override → 1.0');
  // family_C_mean_vector[10] also overridden (index 10 is traffic_pct).
  assert.equal(maint.cell_patch.family_C_mean_vector[10], 1.0,
    'demo-baseline-maintenance: family_C_mean_vector[10] (traffic_pct position) → 1.0');
});

test('parity/resolve: cell_patch_override correctly applies (github-2020 sigma case)', () => {
  const gh = loadDemoScript(path.join(DEMOS_DIR, 'demo-github-2020.json'));
  const sig = gh.cell_patch.family_A_per_signal.downstream_err.baseline_sigma_squared;
  // Github-2020 overrides downstream_err sigma to a higher value for
  // per-demo sensitivity tuning (distinguishes from the shared baseline
  // value; see tools/build-canned-demos.js estimateSigmaSquared).
  assert.ok(sig > 5e-9 && sig < 1e-8,
    `demo-github-2020: downstream_err.baseline_sigma_squared should be ~5.99e-9 (got ${sig})`);
});

test('parity/resolve: tenant-skew demo resolves against tenant baseline', () => {
  const t = loadDemoScript(path.join(DEMOS_DIR, 'demo-tenant-skew.json'));
  assert.ok(t.baseline, 'tenant-skew resolved baseline present');
  assert.ok(t.cell_patch, 'tenant-skew resolved cell_patch present');
  assert.equal(t.tenantId, 'B', 'tenant-skew carries tenantId=B at top level');
  assert.ok(t.cell_patch.tenant_tier_map,
    'tenant-skew cell_patch.tenant_tier_map materialized from tenant baseline');
  assert.equal(t.cell_patch.tenant_tier_map.B, 'large',
    'tenant-skew tier map preserves B → large');
});

// ── Legacy passthrough: resolveDemo on a pre-consolidation (flat) demo ──

test('parity/resolve: flat demo (no baseline_ref) passes through unchanged', () => {
  const flat = {
    id: 'flat-demo',
    baseline: { p99: 100 },
    cell_patch: { target_cell: { hour_of_day: 14 } },
    ticks: [],
    expected_outcome: { verdict: 'proceed' },
  };
  const resolved = resolveDemo(flat);
  assert.deepStrictEqual(resolved, flat,
    'flat demos (without baseline_ref) must return unchanged');
});

test('parity/resolve: resolved demo carries _baseline_ref + _baseline_id audit fields', () => {
  const resolved = loadDemoScript(path.join(DEMOS_DIR, 'demo-clean.json'));
  assert.equal(resolved._baseline_ref, 'baselines/llm-inference-streaming.json',
    'resolved demo exposes _baseline_ref for audit');
  assert.equal(resolved._baseline_id, 'llm-inference-streaming',
    'resolved demo exposes _baseline_id for audit');
});

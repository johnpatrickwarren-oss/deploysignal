// test/tenant-tier-bucketing.test.ts — Addition #23 D1+D2 unit coverage.
//
// Per ARCHITECT-REPLY-39 D1: traffic-fraction-to-tier assignment with
// architect default boundaries (≥0.50 dominant, ≥0.10 large, ≥0.01
// medium, <0.01 small). Boundary edges land in the lower-inclusive tier
// (deterministic at exact-fraction equality). Manual overrides bypass
// the fraction and force the operator's chosen tier.
//
// D2 — buildTenantTierMap reads bundle-run tenant_id, sums per-tenant
// sample counts, computes fractions, and emits a Record<string, TenantTier>.
// No-tenant bundles (every run lacks tenant_id) return null so the
// CompiledConfig stays pre-#23-shaped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignTier,
  buildTenantTierMap,
  hashTenantTierConfig,
  DEFAULT_TENANT_TIER_CONFIG,
} from '../tools/calibrate';
import type { BaselineBundle, TenantTierConfig } from '../engine/types';

const B = DEFAULT_TENANT_TIER_CONFIG.boundaries;

test('assignTier: defaults bucket the four canonical fractions', () => {
  assert.equal(assignTier(0.80, B), 'dominant');
  assert.equal(assignTier(0.20, B), 'large');
  assert.equal(assignTier(0.05, B), 'medium');
  assert.equal(assignTier(0.005, B), 'small');
});

test('assignTier: boundary equality lands in the upper tier (inclusive lower-bound)', () => {
  // fraction === boundary value → upper-tier-inclusive per D1
  assert.equal(assignTier(0.50, B), 'dominant');
  assert.equal(assignTier(0.10, B), 'large');
  assert.equal(assignTier(0.01, B), 'medium');
});

test('assignTier: custom boundaries respected', () => {
  const custom: TenantTierConfig['boundaries'] = { dominant: 0.30, large: 0.05, medium: 0.005 };
  assert.equal(assignTier(0.40, custom), 'dominant');
  assert.equal(assignTier(0.10, custom), 'large');
  assert.equal(assignTier(0.02, custom), 'medium');
  assert.equal(assignTier(0.001, custom), 'small');
});

function makeRun(tenantId: string | undefined, ticks: number): BaselineBundle['runs'][number] {
  return {
    tenant_id: tenantId,
    signal_series: { p99_latency: new Array(ticks).fill(185) },
    hour_of_day: new Array(ticks).fill(14),
    day_of_week: new Array(ticks).fill(2),
  };
}

test('buildTenantTierMap: no tenant_id on any run → returns null (pre-#23 shape)', () => {
  const bundle: BaselineBundle = {
    version: 't', generated_at: '0', seed: 1,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [makeRun(undefined, 100), makeRun(undefined, 50)],
  };
  assert.equal(buildTenantTierMap(bundle), null);
});

test('buildTenantTierMap: three-tenant 80/15/5 split → dominant/large/medium', () => {
  const bundle: BaselineBundle = {
    version: 't', generated_at: '0', seed: 1,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [makeRun('A', 800), makeRun('B', 150), makeRun('C', 50)],
  };
  const map = buildTenantTierMap(bundle);
  assert.deepEqual(map, { A: 'dominant', B: 'large', C: 'medium' });
});

test('buildTenantTierMap: single tenant at 100% traffic → dominant tier', () => {
  const bundle: BaselineBundle = {
    version: 't', generated_at: '0', seed: 1,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [makeRun('only', 1000)],
  };
  const map = buildTenantTierMap(bundle);
  assert.deepEqual(map, { only: 'dominant' });
});

test('buildTenantTierMap: long-tail tenant under boundary → small tier', () => {
  const bundle: BaselineBundle = {
    version: 't', generated_at: '0', seed: 1,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [makeRun('big', 9999), makeRun('tiny', 1)],
  };
  const map = buildTenantTierMap(bundle);
  assert.equal(map?.big, 'dominant');
  assert.equal(map?.tiny, 'small');
});

test('buildTenantTierMap: manual_overrides bypass fraction-derived tier', () => {
  const bundle: BaselineBundle = {
    version: 't', generated_at: '0', seed: 1,
    cell_dim: 'hour_of_day_x_day_of_week',
    runs: [makeRun('vip', 50), makeRun('whale', 9950)],
  };
  // VIP at 0.5% would be 'small' by default. Operator promotes to 'large'.
  const cfg: TenantTierConfig = {
    boundaries: B,
    manual_overrides: { vip: 'large' },
  };
  const map = buildTenantTierMap(bundle, cfg);
  assert.equal(map?.vip, 'large');
  assert.equal(map?.whale, 'dominant');
});

test('hashTenantTierConfig: deterministic + different inputs produce different hashes', () => {
  const a = hashTenantTierConfig({ boundaries: B });
  const b = hashTenantTierConfig({ boundaries: B });
  assert.equal(a, b, 'same input → same hash');
  const c = hashTenantTierConfig({ boundaries: { dominant: 0.40, large: 0.10, medium: 0.01 } });
  assert.notEqual(a, c, 'different boundaries → different hash');
  const d = hashTenantTierConfig({ boundaries: B, manual_overrides: { vip: 'large' } });
  assert.notEqual(a, d, 'overrides participate in hash');
});

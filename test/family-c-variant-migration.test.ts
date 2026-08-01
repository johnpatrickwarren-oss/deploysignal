// test/family-c-variant-migration.test.ts — Addition #20 slice-2b-2b.
//
// Verifies backward-compat and migration behavior for Family C's new
// `hotelling_variant` discriminator from slice-2b-1's compiler output:
//   - Pre-#20 configs (no `hotelling_variant` field) continue to exercise
//     the legacy chi_square T² path byte-identically.
//   - Post-#20 configs with `hotelling_variant='safe_test'` +
//     `safe_hotelling_params` route to evaluateSafeHotelling's wealth-
//     martingale path when a state store is threaded through.
//   - `force_legacy_family_c: true` (CompilerOption) is honored by
//     compile-time emission — cells emit `hotelling_variant: 'chi_square'`
//     + `safe_hotelling_params: null` so runtime dispatch stays on the
//     legacy path.
//
// Runtime-focused; compiler-round-trip for force_legacy_family_c is
// exercised indirectly by asserting the shape a compiler producing such
// a config would emit (since the compiler isn't importable from tests
// without a baseline bundle).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CompiledConfig, FamilyCPerCell, SafeHotellingState, DetectorVerdict,
} from '../engine/types';
import { evaluateFamilyC } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/hotelling';

/** Build a minimal p=2 isotropic Family C cell for controlled dispatch
 *  testing. Covariance = I_2 so the chi_square and safe_test paths have
 *  well-defined, analytically-predictable outputs. */
function makeCell(variant: 'chi_square' | 'safe_test' | undefined): FamilyCPerCell {
  const cell: FamilyCPerCell = {
    mean_vector: Array(11).fill(0),
    covariance: Array.from({ length: 11 }, (_, i) =>
      Array.from({ length: 11 }, (_, j) => (i === j ? 1 : 0))),
    covariance_method: 'ledoit_wolf',
  };
  if (variant === 'safe_test') {
    cell.hotelling_variant = 'safe_test';
    cell.safe_hotelling_params = {
      tau_squared: 0.03,
      alpha: 1e-4,
      precompiled_log_det_shrink: 0.5 * 11 * Math.log(1 + 0.03),
      shrink_fraction: 0.03,
    };
  } else if (variant === 'chi_square') {
    cell.hotelling_variant = 'chi_square';
    cell.safe_hotelling_params = null;
  }
  // variant=undefined → no field set (pre-#20 config shape)
  return cell;
}

function makeCfg(cell: FamilyCPerCell): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.2.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 0, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: {
      p99_latency: { min_ticks_before_eligible: 1, min_observation_window: 1, max_deploy_window_days: 10 },
    },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [{
        key: { hour_of_day: 14, day_of_week: 2 },
        n_samples: 500, confidence: 'strict', family_C: cell,
      }],
      aggregate_fallback: { family_A: { per_signal: {} }, family_C: cell },
    },
  };
}

const FAMILY_C_SIGNALS = [
  'p99_latency', 'ttft', 'tokens_turn', 'kv_cache', 'cost_req',
  'downstream_err', 'mfu', 'hbm_spill', 'collective_ops',
  'corpus_delta', 'traffic_pct',
];

/** Synthesize a live-metrics object with every Family C signal at a
 *  constant shift from baseline mean (0 for isotropic fixture). */
function liveAt(shift: number): Record<string, number> {
  const m: Record<string, number> = {};
  for (const sig of FAMILY_C_SIGNALS) m[sig] = shift;
  return m;
}

function baseCtx() {
  return {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 10, deployAgeDays: 0.5, trafficPct: 1.0,
  };
}

// ── Pre-#20 backward compatibility ──────────────────────────────────

test('variant-migration: pre-#20 cell (no hotelling_variant) dispatches chi_square path', () => {
  const cfg = makeCfg(makeCell(undefined));
  const states: Record<string, SafeHotellingState> = {};
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx(), states) as DetectorVerdict;
  assert.ok(v);
  // chi_square path emits no `signal` field (Family C's default detector_id
  // registry maps family_C → hotelling_t2_joint_vector at audit time).
  assert.equal(v.signal, undefined);
  // Threshold is a chi-square quantile — a finite positive number near
  // χ²(1 − α, p=11). Safe-Hotelling path emits threshold=1/α=10000;
  // chi_square emits ~O(40-50).
  assert.ok(v.threshold !== null);
  assert.ok(v.threshold! < 100, `chi_square threshold should be O(40-50); got ${v.threshold}`);
  // State store shouldn't have been touched (legacy path is stateless).
  assert.equal(Object.keys(states).length, 0);
});

test('variant-migration: pre-#20 cell with states=undefined also dispatches chi_square', () => {
  const cfg = makeCfg(makeCell(undefined));
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.signal, undefined);
  assert.ok(v.threshold! < 100);
});

// ── Post-#20 with safe_test dispatch ────────────────────────────────

test('variant-migration: post-#20 safe_test cell + states dispatches to wealth martingale', () => {
  const cfg = makeCfg(makeCell('safe_test'));
  const states: Record<string, SafeHotellingState> = {};
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx(), states) as DetectorVerdict;
  assert.ok(v);
  // Safe-Hotelling verdict carries signal='hotelling_t2_safe' for audit
  // detector_id projection (DETECTOR_REGISTRY.C extension).
  assert.equal(v.signal, 'hotelling_t2_safe');
  // Threshold is 1/α = 10000 on default alpha=1e-4.
  assert.equal(v.threshold, 10000);
  // State should have been allocated (per-cell key `__sh_<tier>_<h>_<d>`).
  const keys = Object.keys(states);
  assert.ok(keys.length === 1, `expected 1 state key, got ${keys.length}: ${keys.join(',')}`);
  assert.ok(keys[0].startsWith('__sh_'), `key should start with __sh_; got ${keys[0]}`);
  // M should have decayed slightly from 1 (sub-martingale under healthy).
  assert.ok(states[keys[0]].M < 1 && states[keys[0]].M > 0.5);
});

test('variant-migration: safe_test cell without states falls through to chi_square path', () => {
  // Guard: if a runtime caller forgets to thread the state store, the
  // dispatch degrades to the legacy chi_square path rather than
  // crashing. Ensures single-point-of-failure resilience.
  const cfg = makeCfg(makeCell('safe_test'));
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.signal, undefined);
  assert.ok(v.threshold! < 100);
});

// ── force_legacy_family_c compile-time shape ────────────────────────

test('variant-migration: force_legacy_family_c compile-time shape (hotelling_variant=chi_square + safe_hotelling_params=null) dispatches chi_square', () => {
  // Simulates what the compiler emits when `CompilerOptions.force_legacy_family_c=true`:
  // hotelling_variant='chi_square' + safe_hotelling_params=null + mmd_variant='bootstrap_null'.
  // Runtime must honor the explicit chi_square tag even with a state
  // store present, so operators using the escape hatch get legacy
  // behavior reliably.
  const cfg = makeCfg(makeCell('chi_square'));
  const states: Record<string, SafeHotellingState> = {};
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx(), states) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.signal, undefined);
  assert.ok(v.threshold! < 100);
  assert.equal(Object.keys(states).length, 0, 'no safe-Hotelling state allocated on chi_square cell');
});

// ── Post-#20 with missing safe_hotelling_params (degenerate cell) ───

test('variant-migration: safe_test cell with safe_hotelling_params=null falls through to chi_square', () => {
  // Slice-2b-1 calibrate.ts falls back to chi_square when logDet(Σ)
  // returns null (degenerate Σ). This asserts that path produces the
  // same runtime behavior as an explicit chi_square cell.
  const cell = makeCell('safe_test');
  cell.safe_hotelling_params = null;
  const cfg = makeCfg(cell);
  const states: Record<string, SafeHotellingState> = {};
  const v = evaluateFamilyC(cfg, liveAt(0), baseCtx(), states) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.signal, undefined);
  assert.equal(Object.keys(states).length, 0);
});

// test/spectral-variant-migration.test.ts — Addition #21 slice-3.
//
// Runtime-dispatch migration coverage for Family D's new
// `spectral_variant` discriminator (slice-2 compile-time substrate):
//   - Pre-#21 configs (no `spectral_variant` field) continue to exercise
//     the legacy bootstrap-null path byte-identically.
//   - Post-#21 configs with `spectral_variant='e_detector'` + populated
//     null_mean/null_std/betting_delta route to evaluateSpectralEDetector's
//     wealth-martingale path when state is threaded through.
//   - `force_legacy_family_d: true` (CompilerOption) emits
//     `spectral_variant='bootstrap_null'` so runtime dispatch stays on
//     legacy path even though μ₀/σ₀/δ_D are populated.
//
// Pattern mirrors test/family-c-variant-migration.test.ts (slice-2b-2b-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CompiledConfig, FamilyDPerSignal, SpectralEDetectorState, DetectorVerdict,
} from '../engine/types';
import { evaluateFamilyD } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/spectral';

function makeParams(variant: 'bootstrap_null' | 'e_detector' | undefined): FamilyDPerSignal {
  const p: FamilyDPerSignal = {
    bootstrap_null_quantile: 0.60,
    min_peak_lag: 3,
    max_peak_lag: 10,
  };
  if (variant === 'e_detector') {
    p.spectral_variant = 'e_detector';
    p.null_mean = 0.42;
    p.null_std = 0.05;
    p.betting_delta = 0.015;  // 0.3 · σ₀
  } else if (variant === 'bootstrap_null') {
    p.spectral_variant = 'bootstrap_null';
    // Slice-2 still populates μ₀/σ₀/δ_D on legacy-variant emission
    // (useful for post-merge retune); verifies dispatch honors the
    // explicit variant tag rather than field presence.
    p.null_mean = 0.42;
    p.null_std = 0.05;
    p.betting_delta = 0.015;
  }
  return p;
}

function makeCfg(cell: FamilyDPerSignal): CompiledConfig {
  return {
    version: 'test', compiler_version: '0.2.0', compiled_at: '0',
    baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 4e-4, B: 4e-4, C: 2e-4, D: 1e-4, E: 0 } },
    family_B: { cutoffs: {}, vote_thresholds: {} },
    bake_profiles: {
      kv_cache: { min_ticks_before_eligible: 1, min_observation_window: 1, max_deploy_window_days: 10 },
    },
    bonferroni_factor: 6,
    baseline_cells: {
      dimensions: ['hour_of_day', 'day_of_week'],
      cells: [],
      aggregate_fallback: {
        family_A: { per_signal: {} },
        family_D: { kv_cache: cell },
      },
    },
  };
}

function baseCtx() {
  return {
    hourOfDay: 14, dayOfWeek: 2,
    ticksSinceDeploy: 10, deployAgeDays: 0.5, trafficPct: 1.0,
  };
}

/** 30-sample window with mostly-flat noise + small oscillation. Peak|ACF|
 *  for this kind of window is in the 0.3-0.5 range — below bootstrap
 *  quantile 0.60 but well above μ₀=0.42. Useful for exercising both
 *  paths without triggering legacy fire. */
function makeWindow(): number[] {
  const w = new Array(30);
  for (let i = 0; i < 30; i++) {
    w[i] = 1 + 0.05 * Math.sin(i * 2 * Math.PI / 5) + 0.02 * ((i * 7919) % 11 / 11 - 0.5);
  }
  return w;
}

// ── Pre-#21 backward compatibility ──────────────────────────────────

test('spectral-variant-migration: pre-#21 cell (no spectral_variant) dispatches bootstrap-null', () => {
  const cfg = makeCfg(makeParams(undefined));
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const v = evaluateFamilyD(cfg, 'kv_cache', makeWindow(), baseCtx(), state) as DetectorVerdict;
  assert.ok(v);
  // Bootstrap-null emits reason_code `spectral_peak_at_lag_*` on fire
  // or `below_threshold` on clean. Threshold = bootstrap_null_quantile.
  assert.equal(v.threshold, 0.60);
  // State store should NOT have been touched (legacy path is stateless).
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);
});

test('spectral-variant-migration: pre-#21 cell with state=undefined dispatches bootstrap-null', () => {
  const cfg = makeCfg(makeParams(undefined));
  const v = evaluateFamilyD(cfg, 'kv_cache', makeWindow(), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.threshold, 0.60);
});

// ── Post-#21 with e_detector dispatch ───────────────────────────────

test('spectral-variant-migration: post-#21 e_detector cell + state dispatches wealth martingale', () => {
  // v0.6.7-pre re-pin (d3d6d06): the e-detector advances wealth once per
  // DISJOINT window, not per tick — the first windowLen−1 calls hold with
  // 'awaiting_disjoint_window' and the wealth is untouched (the rolling
  // per-tick path measured FAR 0.576 vs disjoint 0.0005; engine spectral.ts).
  const cfg = makeCfg(makeParams('e_detector'));
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const win = makeWindow();
  for (let t = 1; t < win.length; t++) {
    const held = evaluateFamilyD(cfg, 'kv_cache', win, baseCtx(), state) as DetectorVerdict;
    assert.equal(held.reason_code, 'awaiting_disjoint_window', `tick ${t} should hold`);
    assert.equal(state.n, 0, 'wealth must not advance inside the window');
  }
  const v = evaluateFamilyD(cfg, 'kv_cache', win, baseCtx(), state) as DetectorVerdict;
  assert.ok(v);
  // Safe-Hotelling-style e-detector threshold = 1/α_D = 10,000
  assert.equal(v.threshold, 10000);
  // State should be mutated at the window boundary (n=1; M may drift either way).
  assert.equal(state.n, 1);
  assert.ok(state.M > 0, `M should be positive; got ${state.M}`);
});

test('spectral-variant-migration: e_detector cell without state falls through to bootstrap-null', () => {
  // Guard: if a runtime caller forgets to thread state, dispatch
  // degrades to legacy rather than crashing. Single-point-of-failure
  // resilience (matches Family C slice-2b-2a pattern).
  const cfg = makeCfg(makeParams('e_detector'));
  const v = evaluateFamilyD(cfg, 'kv_cache', makeWindow(), baseCtx()) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.threshold, 0.60);  // bootstrap_null_quantile, not 1/α
});

// ── force_legacy_family_d compile-time shape ────────────────────────

test('spectral-variant-migration: explicit bootstrap_null variant pins legacy even with state + e-detector params populated', () => {
  // Simulates what the compiler emits when
  // `CompilerOptions.force_legacy_family_d=true`: spectral_variant
  // ='bootstrap_null' but μ₀/σ₀/δ_D still populated (slice-2 behavior).
  // Runtime must honor the explicit variant tag.
  const cfg = makeCfg(makeParams('bootstrap_null'));
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  const v = evaluateFamilyD(cfg, 'kv_cache', makeWindow(), baseCtx(), state) as DetectorVerdict;
  assert.ok(v);
  assert.equal(v.threshold, 0.60);  // legacy threshold
  assert.equal(state.M, 1);
  assert.equal(state.n, 0);  // state untouched
});

// ── Fire-path through dispatch (end-to-end) ─────────────────────────

test('spectral-variant-migration: e-detector dispatch fires on sustained strong oscillation at a disjoint-window boundary', () => {
  // v0.6.7-pre re-pin (d3d6d06): wealth advances once per disjoint 30-tick
  // window, so the pre-re-pin "within 15 ticks" bound is retired with the
  // rolling variant. The named cost is detection latency (engine spectral.ts:
  // bounded, rolling dominated on both axes); the fire must land on a window
  // boundary and never inside the first window.
  const cfg = makeCfg(makeParams('e_detector'));
  const state: SpectralEDetectorState = { M: 1, n: 0, alphaConsumed: 0 };
  // Strong oscillation → peak|ACF| sustained well above μ₀=0.42, via a
  // period-5 periodic pattern over the 30-sample window.
  const window = new Array(30);
  for (let i = 0; i < 30; i++) window[i] = 1 + 0.15 * Math.cos(i * 2 * Math.PI / 5);
  let firedTick = -1;
  const MAX_TICKS = 450;  // 15 disjoint windows
  for (let t = 1; t <= MAX_TICKS; t++) {
    const v = evaluateFamilyD(cfg, 'kv_cache', window, baseCtx(), state) as DetectorVerdict;
    if (v && v.verdict === 'fire') { firedTick = t; break; }
    if (t < window.length) {
      assert.notEqual(v?.verdict, 'fire', 'must not fire inside the first disjoint window');
    }
  }
  assert.ok(firedTick > 0, `should fire under sustained strong oscillation within ${MAX_TICKS} ticks; got firedTick=${firedTick}`);
  assert.equal(firedTick % window.length, 0,
    `fire must land on a disjoint-window boundary; got tick ${firedTick}`);
});

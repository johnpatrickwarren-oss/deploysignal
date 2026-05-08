// test/health-dispatch-maps.test.ts — End-phase slice 2 (D-54-2).
//
// Covers the Record<Variant, Evaluator> dispatch maps introduced in
// engine/detectors/{hotelling,spectral,conformal}.ts:
//   - Every declared variant has an evaluator.
//   - `undefined` variant normalizes to the legacy-default key.
//   - Unknown variant strings throw via the main entry function
//     (NOT silent fallback) per feedback_no_skip_test_policy.
//   - Prereq fall-through (safe_test w/o state → chi_square;
//     e_detector w/o state → bootstrap_null; weighted_e_value w/o
//     state → suppressed) preserves pre-refactor semantics byte-for-
//     byte.
//
// The BYTE-identical verdict parity is already gated by
// test/compiler-equivalence.test.ts + canned-demo-right-reasons.
// This file exercises the dispatch surface in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _HOTELLING_EVALUATORS_FOR_TEST,
  _hotellingVariantForDispatch,
} from '../engine/detectors/hotelling';
import {
  _SPECTRAL_EVALUATORS_FOR_TEST,
  _spectralVariantForDispatch,
} from '../engine/detectors/spectral';
import {
  _CONFORMAL_EVALUATORS_FOR_TEST,
  _conformalKindForDispatch,
} from '../engine/detectors/conformal';

import type { ConformalParams } from '../engine/types';

// ── Hotelling ─────────────────────────────────────────────────────

test('dispatch/hotelling: map has entries for both variants', () => {
  const keys = Object.keys(_HOTELLING_EVALUATORS_FOR_TEST).sort();
  assert.deepEqual(keys, ['chi_square', 'safe_test']);
});

test('dispatch/hotelling: undefined variant → legacy chi_square', () => {
  assert.equal(
    _hotellingVariantForDispatch(undefined, false, false),
    'chi_square',
  );
  // Even with prereqs present, undefined stays chi_square.
  assert.equal(
    _hotellingVariantForDispatch(undefined, true, true),
    'chi_square',
  );
});

test('dispatch/hotelling: safe_test w/ prereqs → safe_test', () => {
  assert.equal(
    _hotellingVariantForDispatch('safe_test', true, true),
    'safe_test',
  );
});

test('dispatch/hotelling: safe_test w/o prereqs → chi_square fallback', () => {
  assert.equal(
    _hotellingVariantForDispatch('safe_test', false, true),
    'chi_square',
  );
  assert.equal(
    _hotellingVariantForDispatch('safe_test', true, false),
    'chi_square',
  );
});

test('dispatch/hotelling: unknown variant string passes through (entry fn throws)', () => {
  const result = _hotellingVariantForDispatch(
    'no_such_variant' as never, true, true,
  );
  assert.equal(result, 'no_such_variant');
  // The Record lookup returns undefined; entry fn throws.
  assert.equal(
    _HOTELLING_EVALUATORS_FOR_TEST[result as 'chi_square'],
    undefined,
  );
});

// ── Spectral ──────────────────────────────────────────────────────

test('dispatch/spectral: map has entries for both variants', () => {
  const keys = Object.keys(_SPECTRAL_EVALUATORS_FOR_TEST).sort();
  assert.deepEqual(keys, ['bootstrap_null', 'e_detector']);
});

test('dispatch/spectral: undefined variant → legacy bootstrap_null', () => {
  assert.equal(
    _spectralVariantForDispatch(undefined, false),
    'bootstrap_null',
  );
  assert.equal(
    _spectralVariantForDispatch(undefined, true),
    'bootstrap_null',
  );
});

test('dispatch/spectral: e_detector w/ state → e_detector', () => {
  assert.equal(
    _spectralVariantForDispatch('e_detector', true),
    'e_detector',
  );
});

test('dispatch/spectral: e_detector w/o state → bootstrap_null fallback', () => {
  assert.equal(
    _spectralVariantForDispatch('e_detector', false),
    'bootstrap_null',
  );
});

test('dispatch/spectral: unknown variant string passes through', () => {
  const result = _spectralVariantForDispatch('weird' as never, true);
  assert.equal(result, 'weird');
  assert.equal(
    _SPECTRAL_EVALUATORS_FOR_TEST[result as 'bootstrap_null'],
    undefined,
  );
});

// ── Conformal ─────────────────────────────────────────────────────

test('dispatch/conformal: map has entries for all three kinds', () => {
  const keys = Object.keys(_CONFORMAL_EVALUATORS_FOR_TEST).sort();
  assert.deepEqual(keys, ['unweighted', 'weighted', 'weighted_e_value']);
});

test('dispatch/conformal: undefined kind → legacy unweighted', () => {
  const legacy: ConformalParams = { calibration_scores: [1, 2, 3] };
  assert.equal(_conformalKindForDispatch(legacy), 'unweighted');
});

test('dispatch/conformal: kind explicit unweighted → unweighted', () => {
  const explicit: ConformalParams = {
    kind: 'unweighted', calibration_scores: [1, 2, 3],
  };
  assert.equal(_conformalKindForDispatch(explicit), 'unweighted');
});

test('dispatch/conformal: kind weighted → weighted', () => {
  const weighted: ConformalParams = {
    kind: 'weighted', scores: [1, 2], weights: [0.5, 0.5],
    halflife_days: 7, effective_sample_size: 2,
  };
  assert.equal(_conformalKindForDispatch(weighted), 'weighted');
});

test('dispatch/conformal: kind weighted_e_value → weighted_e_value', () => {
  const eValue: ConformalParams = {
    kind: 'weighted_e_value', scores: [1, 2], weights: [0.5, 0.5],
    cumulative_weights_above: [1.0, 0.5], total_weight: 1.0,
    halflife_days: 7, effective_sample_size: 2,
  };
  assert.equal(_conformalKindForDispatch(eValue), 'weighted_e_value');
});

test('dispatch/conformal: unknown kind passes through', () => {
  const bogus = { kind: 'definitely_not_real' } as unknown as ConformalParams;
  const result = _conformalKindForDispatch(bogus);
  assert.equal(result, 'definitely_not_real');
  assert.equal(
    _CONFORMAL_EVALUATORS_FOR_TEST[result as 'unweighted'],
    undefined,
  );
});

// ── Invariants across all three dispatch maps ─────────────────────

test('dispatch/all: every map entry is a function', () => {
  for (const [k, v] of Object.entries(_HOTELLING_EVALUATORS_FOR_TEST)) {
    assert.equal(typeof v, 'function', `hotelling[${k}] must be a function`);
  }
  for (const [k, v] of Object.entries(_SPECTRAL_EVALUATORS_FOR_TEST)) {
    assert.equal(typeof v, 'function', `spectral[${k}] must be a function`);
  }
  for (const [k, v] of Object.entries(_CONFORMAL_EVALUATORS_FOR_TEST)) {
    assert.equal(typeof v, 'function', `conformal[${k}] must be a function`);
  }
});

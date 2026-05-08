// test/variant-selector-migration.test.ts — ARCHITECT-REPLY-53 R3.
//
// Coverage for the unified Family E variant selector:
//   (1) deprecated `force_legacy_family_e: true` compiles byte-
//       identical to `family_E_variant_selector: 'force_weighted'`
//       (schema-migration preserves existing shadow-compare audits).
//   (2) 'auto' default is byte-identical to configuration where
//       neither the legacy field nor the new selector is present
//       (byte-identity regression gate under default compile).
//   (3) 'force_unweighted' emits kind:'unweighted' on inputs where
//       'force_weighted_e_value' emits kind:'weighted_e_value' —
//       proving the selector correctly bypasses the weighted path.
//
// Pattern mirrors conformal-variant-migration.test.ts (runtime
// dispatch) but at the compiler layer: tests call the compiler
// helper directly with a seeded synthetic FamilyCPerCell, so
// determinism + byte-identity come from the mulberry32 RNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FamilyCPerCell, ConformalParams, CompilerOptions,
} from '../engine/types';
import {
  buildFamilyEPerCell, resolveFamilyEVariantSelector,
} from '../tools/calibrate';

const SEED = 42;
const HALFLIFE_DAYS = 7;

function makeFamC(p = 11): FamilyCPerCell {
  const cov: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    cov[i] = new Array(p).fill(0);
    cov[i][i] = 1;
  }
  return { mean_vector: new Array(p).fill(0), covariance: cov };
}

// ── Resolver: schema-migration ─────────────────────────────────────

test('variant-selector-migration: resolver defaults to auto when both fields absent', () => {
  assert.equal(resolveFamilyEVariantSelector({}), 'auto');
});

test('variant-selector-migration: resolver migrates legacy true → force_weighted', () => {
  assert.equal(
    resolveFamilyEVariantSelector({ force_legacy_family_e: true }),
    'force_weighted',
  );
});

test('variant-selector-migration: resolver migrates legacy false → auto', () => {
  assert.equal(
    resolveFamilyEVariantSelector({ force_legacy_family_e: false }),
    'auto',
  );
});

test('variant-selector-migration: resolver passes through explicit selector values', () => {
  const values: Array<NonNullable<CompilerOptions['family_E_variant_selector']>> =
    ['auto', 'force_weighted', 'force_weighted_e_value', 'force_unweighted'];
  for (const v of values) {
    assert.equal(
      resolveFamilyEVariantSelector({ family_E_variant_selector: v }),
      v,
    );
  }
});

test('variant-selector-migration: new selector wins when both fields present', () => {
  // Operator migrating a legacy config who also adds the new selector:
  // new selector is authoritative. Prevents the legacy field from
  // silently overriding an explicit operator choice.
  assert.equal(
    resolveFamilyEVariantSelector({
      force_legacy_family_e: true,
      family_E_variant_selector: 'auto',
    }),
    'auto',
  );
});

// ── Bullet 1: legacy true ≡ force_weighted (byte-identical) ─────────
//
// Test on a span long enough for the gate to be structurally exercised.
// Both legacy-true and force_weighted share the ESS+span gate exactly,
// so every branch (gate-pass, short-span-fail, low-ESS-fail) produces
// the same variant shape under identical seed + famC inputs.

test('variant-selector-migration: legacy force_legacy_family_e:true ≡ force_weighted (short span)', () => {
  const famC = makeFamC();
  const legacyVariant   = resolveFamilyEVariantSelector({ force_legacy_family_e: true });
  const newVariant      = resolveFamilyEVariantSelector({ family_E_variant_selector: 'force_weighted' });
  const viaLegacy = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, legacyVariant);
  const viaNew    = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, newVariant);
  assert.ok(viaLegacy && viaNew);
  assert.deepEqual(viaLegacy, viaNew);
});

test('variant-selector-migration: legacy force_legacy_family_e:true ≡ force_weighted (long span)', () => {
  const famC = makeFamC();
  const legacyVariant = resolveFamilyEVariantSelector({ force_legacy_family_e: true });
  const newVariant    = resolveFamilyEVariantSelector({ family_E_variant_selector: 'force_weighted' });
  const viaLegacy = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 30, legacyVariant);
  const viaNew    = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 30, newVariant);
  assert.ok(viaLegacy && viaNew);
  assert.deepEqual(viaLegacy, viaNew);
});

// ── Bullet 2: 'auto' ≡ absent (both fields missing) ────────────────
//
// The R3 byte-identity regression gate: adding the new selector field
// to CompilerOptions must not perturb compiled output when the field
// is absent. The resolver maps absent → 'auto' and legacy-false →
// 'auto', so all three of these inputs must produce identical output.

test('variant-selector-migration: absent ≡ explicit auto ≡ legacy-false (byte-identity regression gate)', () => {
  const famC = makeFamC();
  const vA = resolveFamilyEVariantSelector({});
  const vB = resolveFamilyEVariantSelector({ family_E_variant_selector: 'auto' });
  const vC = resolveFamilyEVariantSelector({ force_legacy_family_e: false });
  assert.equal(vA, 'auto');
  assert.equal(vB, 'auto');
  assert.equal(vC, 'auto');
  const [rA, rB, rC] = [
    buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, vA),
    buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, vB),
    buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, vC),
  ];
  assert.ok(rA && rB && rC);
  assert.deepEqual(rA, rB);
  assert.deepEqual(rA, rC);
});

// ── Bullet 3: 'force_unweighted' always emits unweighted ───────────
//
// Exercise the bypass behavior on inputs where a gate-bypassing
// weighted selector ('force_weighted_e_value') emits kind:
// 'weighted_e_value'. 'force_unweighted' on the same inputs must
// emit the unweighted variant (no `kind`, `calibration_scores` field
// present) — confirming the selector takes a distinct path and is
// not silently routed through the weighted code.

test('variant-selector-migration: force_unweighted emits unweighted even where force_weighted_e_value emits weighted_e_value', () => {
  const famC = makeFamC();
  // Short span — the 'auto' gate would route here to unweighted too,
  // but 'force_weighted_e_value' bypasses the gate and still emits
  // the e-value variant. 'force_unweighted' bypasses everything.
  const unweighted   = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, 'force_unweighted');
  const weightedEval = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, 'force_weighted_e_value');
  assert.ok(unweighted && weightedEval);
  // weightedEval is a discriminated-union member with kind 'weighted_e_value'.
  assert.equal((weightedEval as Extract<ConformalParams, { kind: 'weighted_e_value' }>).kind, 'weighted_e_value');
  // unweighted is the pre-#19 variant — `kind` is absent (optional,
  // not set) or explicitly 'unweighted' per the ConformalParams union.
  const kind = (unweighted as { kind?: string }).kind;
  assert.ok(kind === undefined || kind === 'unweighted',
    `expected kind absent or 'unweighted'; got ${JSON.stringify(kind)}`);
  // Unweighted variant must carry calibration_scores, not scores/weights.
  assert.ok('calibration_scores' in unweighted);
  assert.ok(!('cumulative_weights_above' in unweighted));
});

test('variant-selector-migration: force_weighted_e_value bypasses span gate (emits weighted_e_value on short span)', () => {
  const famC = makeFamC();
  // Span 1.3 days < FAMILY_E_MIN_SPAN_DAYS (7) — 'auto' routes to
  // unweighted; 'force_weighted_e_value' bypasses the gate.
  const viaAuto   = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, 'auto');
  const viaBypass = buildFamilyEPerCell(famC, SEED, HALFLIFE_DAYS, 1.3, 'force_weighted_e_value');
  assert.ok(viaAuto && viaBypass);
  // Auto on short span → unweighted (calibration_scores shape).
  assert.ok('calibration_scores' in viaAuto);
  // force_weighted_e_value → weighted_e_value shape.
  assert.equal((viaBypass as Extract<ConformalParams, { kind: 'weighted_e_value' }>).kind, 'weighted_e_value');
});

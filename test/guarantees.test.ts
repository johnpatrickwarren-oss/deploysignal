// test/guarantees.test.ts — WS2 machine-readable guarantee manifest.
//
// engine/guarantees.ts is the single source of truth for per-detector
// statistical-validity metadata (validity_class, null assumptions,
// repeated-look policy, α-participation, fallback relationships,
// literature citation). This test asserts:
//   1. Exhaustiveness — every id in DETECTOR_REGISTRY has an entry (the
//      `Record<DetectorId, DetectorGuarantee>` type annotation on
//      DETECTOR_GUARANTEES already enforces this at compile time; this
//      test is the runtime cross-check so a drift between the registry
//      and the table fails `npm test`, not just `tsc`).
//   2. Spot-checks against the ground truth verified against the
//      current runtime dispatch code (not just prose): Family A's
//      mixture-supermartingale Page-CUSUM is anytime-valid and is the
//      ONLY path the live gate reaches (Q68 consolidation retired the
//      classical excursion-theory CUSUM from production dispatch);
//      Family B is heuristic/non-participating; Family C splits
//      hotelling_t2_joint_vector (classical) from hotelling_t2_safe
//      (Ville); Family D splits spectral_peak_acf_kv_cache (classical)
//      from spectral_e_detector_kv_cache (Ville); Family E's single
//      registry id is Ville per its Addition #22 canonical design.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DETECTOR_REGISTRY } from '../engine/types';
import type { DetectorId } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';

function allRegistryIds(): DetectorId[] {
  const out: DetectorId[] = [];
  for (const fam of Object.keys(DETECTOR_REGISTRY) as Array<keyof typeof DETECTOR_REGISTRY>) {
    out.push(...(DETECTOR_REGISTRY[fam] as readonly DetectorId[]));
  }
  return out;
}

test('every DETECTOR_REGISTRY id has a DETECTOR_GUARANTEES entry', () => {
  for (const id of allRegistryIds()) {
    assert.ok(
      DETECTOR_GUARANTEES[id] !== undefined,
      `missing guarantee entry for registry id ${id}`,
    );
  }
});

test('every DETECTOR_GUARANTEES entry corresponds to a real registry id (no orphans)', () => {
  const registryIds = new Set(allRegistryIds());
  for (const id of Object.keys(DETECTOR_GUARANTEES)) {
    assert.ok(registryIds.has(id as DetectorId), `orphan guarantee entry for ${id} — not in DETECTOR_REGISTRY`);
  }
});

test('entry.detector_id matches its own table key, and entry.family matches the registry family', () => {
  for (const [famKey, ids] of Object.entries(DETECTOR_REGISTRY)) {
    for (const id of ids as readonly string[]) {
      const g = DETECTOR_GUARANTEES[id as DetectorId];
      assert.equal(g.detector_id, id);
      assert.equal(g.family, famKey);
    }
  }
});

test('Family B is heuristic_structural and non-α-participating for every id', () => {
  for (const id of DETECTOR_REGISTRY.B) {
    const g = DETECTOR_GUARANTEES[id];
    assert.equal(g.validity_class, 'heuristic_structural');
    assert.equal(g.alpha_participating, false);
  }
});

test('Family A betting-e-process ids are ville_anytime_valid and α-participating', () => {
  for (const id of DETECTOR_REGISTRY.A) {
    if (!id.startsWith('betting_e_process_')) continue;
    const g = DETECTOR_GUARANTEES[id];
    assert.equal(g.validity_class, 'ville_anytime_valid');
    assert.equal(g.alpha_participating, true);
    assert.equal(g.repeated_look_policy, 'anytime_valid_continuous_peeking');
  }
});

test('Family A Page-CUSUM ids (mSPRT_* and page_cusum_*) are ville_anytime_valid — '
  + 'Q68 consolidation retired the classical excursion-theory path from production '
  + 'dispatch (evaluateFamilyA always delegates to the mixture-supermartingale variant)', () => {
  for (const id of DETECTOR_REGISTRY.A) {
    if (id.startsWith('betting_e_process_')) continue;
    const g = DETECTOR_GUARANTEES[id];
    assert.equal(g.validity_class, 'ville_anytime_valid', `${id} should be ville_anytime_valid`);
    assert.equal(g.alpha_participating, true);
  }
});

test('Family C: hotelling_t2_joint_vector is the classical chi_square fallback target; '
  + 'hotelling_t2_safe is the Ville GROW e-test and is what it falls back from', () => {
  const classical = DETECTOR_GUARANTEES['hotelling_t2_joint_vector'];
  const ville = DETECTOR_GUARANTEES['hotelling_t2_safe'];
  assert.equal(classical.validity_class, 'classical_epoch_alpha');
  assert.equal(classical.fallback_of, 'hotelling_t2_safe');
  assert.equal(ville.validity_class, 'ville_anytime_valid');
});

test('Family C: sequential_mmd and sequential_mmd_e_process are both ville_anytime_valid — '
  + 'the classical bootstrap-null Sequential-MMD evaluator was retired from runtime '
  + 'dispatch at Q68 close; both live MMD paths (Q67 v2 canonical betting and the '
  + 'Option-B GRAPA/ONS betting) are Ville-bounded', () => {
  assert.equal(DETECTOR_GUARANTEES['sequential_mmd'].validity_class, 'ville_anytime_valid');
  assert.equal(DETECTOR_GUARANTEES['sequential_mmd_e_process'].validity_class, 'ville_anytime_valid');
});

test('Family D: spectral_peak_acf_kv_cache is the classical bootstrap-null fallback '
  + 'target; spectral_e_detector_kv_cache is the Ville mixture-prior e-detector', () => {
  const classical = DETECTOR_GUARANTEES['spectral_peak_acf_kv_cache'];
  const ville = DETECTOR_GUARANTEES['spectral_e_detector_kv_cache'];
  assert.equal(classical.validity_class, 'classical_epoch_alpha');
  assert.equal(classical.fallback_of, 'spectral_e_detector_kv_cache');
  assert.equal(ville.validity_class, 'ville_anytime_valid');
});

test('Family E: mahalanobis_conformal_baseline is ville_anytime_valid under its '
  + 'canonical Addition #22 (weighted_e_value) configuration; its null_assumptions '
  + 'flag that the unweighted/weighted kinds are classical single-shot conformal '
  + 'tests, not the wealth process', () => {
  const g = DETECTOR_GUARANTEES['mahalanobis_conformal_baseline'];
  assert.equal(g.validity_class, 'ville_anytime_valid');
  assert.ok(
    g.null_assumptions.some((a) => /weighted_e_value|kind/.test(a)),
    'expected a null_assumptions entry documenting the kind-dependence',
  );
});

test('self-normalized-e-process-fallback (Q70 §7/§6) is documented as deprecated / '
  + 'schema-only in at least one guarantee entry that references it', () => {
  const referencing = Object.values(DETECTOR_GUARANTEES).filter((g) =>
    g.null_assumptions.some((a) => /self.normalized/i.test(a))
    || /self.normalized/i.test(g.citation));
  assert.ok(
    referencing.length > 0,
    'expected at least one entry to document the self-normalized e-process fallback status',
  );
});

test('fallback_of always points at a real registry id', () => {
  const registryIds = new Set(allRegistryIds());
  for (const g of Object.values(DETECTOR_GUARANTEES)) {
    if (g.fallback_of !== undefined) {
      assert.ok(registryIds.has(g.fallback_of), `${g.detector_id}.fallback_of = ${g.fallback_of} is not a registry id`);
    }
  }
});

test('validity_class ↔ repeated_look_policy consistency: every ville_anytime_valid '
  + 'entry uses anytime_valid_continuous_peeking; no non-ville entry does', () => {
  for (const g of Object.values(DETECTOR_GUARANTEES)) {
    if (g.validity_class === 'ville_anytime_valid') {
      assert.equal(g.repeated_look_policy, 'anytime_valid_continuous_peeking');
    } else {
      assert.equal(g.repeated_look_policy, 'epoch_boundaries_only');
    }
  }
});

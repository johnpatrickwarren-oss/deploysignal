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
import type { CompiledConfig, ConformalParams, FamilyDPerSignal } from '../engine/types';
import type { DetectorId } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import { buildFamilyDSection } from '../tools/_guarantee-manifest-family-d';
import { buildFamilyESection } from '../tools/_guarantee-manifest-family-e';

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
    if (id.startsWith('betting_e_process_') || id.startsWith('safe_t_e_value_')) continue;
    const g = DETECTOR_GUARANTEES[id];
    assert.equal(g.validity_class, 'ville_anytime_valid', `${id} should be ville_anytime_valid`);
    assert.equal(g.alpha_participating, true);
  }
});

test('C64 (a): Family A safe_t_e_value_* ids are e_value_terminal, one look per canary, α-participating', () => {
  const ids = DETECTOR_REGISTRY.A.filter((id) => id.startsWith('safe_t_e_value_'));
  assert.equal(ids.length, 6, 'six Family A signals at engine v0.6.10-pre');
  for (const id of ids) {
    const g = DETECTOR_GUARANTEES[id];
    assert.equal(g.validity_class, 'e_value_terminal');
    assert.equal(g.repeated_look_policy, 'epoch_boundaries_only', 'a fixed-time e-value is read once');
    assert.equal(g.alpha_participating, true);
    assert.ok(g.id_mapping_note?.includes('family_A_safe_t_'), 'names the runtime rollback id');
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

test('Family C: sequential_mmd, sequential_mmd_e_process, and '
  + 'sequential_mmd_betting_e_process are all ville_anytime_valid — the classical '
  + 'bootstrap-null Sequential-MMD evaluator was retired from runtime dispatch at Q68 '
  + 'close; both live MMD paths (Q67 v2 canonical betting and the Option-B GRAPA/ONS '
  + 'betting) are Ville-bounded, and the legacy sequential_mmd fallback id inherits the '
  + 'same guarantee even though no live evaluator attributes to it today', () => {
  assert.equal(DETECTOR_GUARANTEES['sequential_mmd'].validity_class, 'ville_anytime_valid');
  assert.equal(DETECTOR_GUARANTEES['sequential_mmd_e_process'].validity_class, 'ville_anytime_valid');
  assert.equal(DETECTOR_GUARANTEES['sequential_mmd_betting_e_process'].validity_class, 'ville_anytime_valid');
});

test('Family D: spectral_peak_acf_kv_cache is the classical bootstrap-null fallback '
  + 'target; spectral_e_detector_kv_cache is the Ville mixture-prior e-detector', () => {
  const classical = DETECTOR_GUARANTEES['spectral_peak_acf_kv_cache'];
  const ville = DETECTOR_GUARANTEES['spectral_e_detector_kv_cache'];
  assert.equal(classical.validity_class, 'classical_epoch_alpha');
  assert.equal(classical.fallback_of, 'spectral_e_detector_kv_cache');
  // 2026-08-02: reclassified from ville_anytime_valid. The Ville premise is measured false in the
  // shipped configuration — 0.576 false-alarm rate against a nominal 0.05, with oracle parameters
  // and iid Gaussian data, driven by rolling-window overlap. The same detector evaluated on
  // disjoint windows measures 0.0005 on the same data. See knowledge/stats/h0-battery-2026-08-01.
  assert.equal(ville.validity_class, 'heuristic_structural');
  assert.equal(ville.alpha_participating, false, 'must not consume alpha under a false premise');
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

test('sequential_mmd: the audit-writer id-mapping caveat lives in id_mapping_note, '
  + 'not citation — citation stays a pure literature anchor. Now that '
  + 'sequential_mmd_betting_e_process is registered, the note documents the id as '
  + "DORMANT for live attribution (the canonical evaluator's fires route to its own "
  + 'id), not as an active misattribution target', () => {
  const g = DETECTOR_GUARANTEES['sequential_mmd'];
  assert.equal(g.citation, 'Shekhar & Ramdas (2023) canonical ONS kernel-MMD betting e-process');
  assert.ok(g.id_mapping_note !== undefined, 'expected sequential_mmd.id_mapping_note to be set');
  assert.match(g.id_mapping_note!, /sequential_mmd_betting_e_process/);
  assert.match(g.id_mapping_note!, /[Dd]ormant/);
  assert.doesNotMatch(g.citation, /sequential_mmd_betting_e_process/);
});

test('sequential_mmd_betting_e_process: registered Q67 v2 canonical id — ville, '
  + 'Shekhar-Ramdas-2023 citation, and (unlike its dormant sequential_mmd sibling) no '
  + 'id_mapping_note, since its own signal now resolves to itself with no fallback hop', () => {
  const g = DETECTOR_GUARANTEES['sequential_mmd_betting_e_process'];
  assert.equal(g.validity_class, 'ville_anytime_valid');
  assert.equal(g.family, 'C');
  assert.equal(g.citation, 'Shekhar & Ramdas (2023) canonical ONS kernel-MMD betting e-process');
  assert.equal(g.id_mapping_note, undefined);
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

// ────────────────────────────────────────────────────────────────────
// tools/_guarantee-manifest-family-d.ts buildFamilyDSection — direct
// unit coverage on small synthetic cells. Both committed fixtures used
// by test/guarantee-manifest-generator.test.ts (v5-sequential-e-process,
// v7-demos) have every kv_cache cell fully populated with
// null_mean/null_std, so classify()'s no_coverage branch — and its
// exclusion from classical_alpha_fraction's numerator — never executes
// under test via those fixtures. These synthetic cases close that gap.

const FAMILY_D_ALPHA_BUDGET = { total: 1e-3, per_family: { A: 0, B: 0, C: 0, D: 1e-4, E: 0 } };

function familyDCfg(perSignalCells: FamilyDPerSignal[]): CompiledConfig {
  return {
    version: 'test', compiler_version: '0', compiled_at: '0', baseline_ref: 't',
    alpha_budget: FAMILY_D_ALPHA_BUDGET,
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: perSignalCells.map((p, i) => ({
        key: { hour_of_day: i },
        n_samples: 10,
        confidence: 'strict' as const,
        family_D: { kv_cache: p },
      })),
      aggregate_fallback: {},
    },
  };
}

test('Family D buildFamilyDSection: e_detector cell WITH null_mean/null_std moments '
  + 'classifies as ville coverage (spectral_e_detector_kv_cache), not classical', () => {
  const cfg = familyDCfg([
    {
      bootstrap_null_quantile: 0.9, min_peak_lag: 3, max_peak_lag: 10,
      spectral_variant: 'e_detector', null_mean: 0.12, null_std: 0.04,
    },
  ]);
  const section = buildFamilyDSection(cfg);
  const eDet = section.detectors.find((d) => d.detector_id === 'spectral_e_detector_kv_cache')!;
  const classical = section.detectors.find((d) => d.detector_id === 'spectral_peak_acf_kv_cache')!;
  assert.equal(eDet.cell_total, 1);
  assert.equal(eDet.cell_counts?.['e_detector'], 1);
  assert.equal(eDet.cell_counts?.['no_coverage'] ?? 0, 0);
  assert.equal(classical.cell_counts?.['bootstrap_null'] ?? 0, 0);
  // Hand-derived: 1 cell total, 0 of them classified bootstrap_null -> 0/1 = 0.
  assert.equal(section.classical_alpha_fraction, 0);
});

test('Family D buildFamilyDSection: e_detector cell MISSING null_mean/null_std '
  + 'classifies as no_coverage (NOT classical) and is excluded from the classical '
  + 'numerator — engine/detectors/spectral.ts evaluateSpectralEDetector suppresses '
  + 'this cell entirely rather than falling through to bootstrap_null', () => {
  const cfg = familyDCfg([
    // Missing null_mean/null_std entirely -> no_coverage.
    { bootstrap_null_quantile: 0.9, min_peak_lag: 3, max_peak_lag: 10, spectral_variant: 'e_detector' },
    // A genuine classical cell alongside it, so the assertion can tell
    // "no_coverage excluded from the numerator only" apart from
    // "no_coverage excluded from the denominator too".
    { bootstrap_null_quantile: 0.85, min_peak_lag: 3, max_peak_lag: 10, spectral_variant: 'bootstrap_null' },
  ]);
  const section = buildFamilyDSection(cfg);
  const eDet = section.detectors.find((d) => d.detector_id === 'spectral_e_detector_kv_cache')!;
  const classical = section.detectors.find((d) => d.detector_id === 'spectral_peak_acf_kv_cache')!;
  assert.equal(eDet.cell_total, 2);
  assert.equal(eDet.cell_counts?.['no_coverage'], 1);
  assert.equal(eDet.cell_counts?.['e_detector'] ?? 0, 0);
  assert.equal(classical.cell_counts?.['bootstrap_null'], 1);
  // Hand-derived: total=2, bootstrap_null count=1 -> 1/2 = 0.5. Folding
  // no_coverage into the classical numerator would give 1 (2/2); dropping
  // it from the denominator too would also give 1 (1/1). Neither
  // happens — it dilutes the denominator without feeding the numerator.
  assert.equal(section.classical_alpha_fraction, 0.5);
});

test('Family D buildFamilyDSection: a bootstrap_null-variant cell classifies as classical', () => {
  const cfg = familyDCfg([
    { bootstrap_null_quantile: 0.8, min_peak_lag: 3, max_peak_lag: 10, spectral_variant: 'bootstrap_null' },
  ]);
  const section = buildFamilyDSection(cfg);
  const classical = section.detectors.find((d) => d.detector_id === 'spectral_peak_acf_kv_cache')!;
  assert.equal(classical.cell_total, 1);
  assert.equal(classical.cell_counts?.['bootstrap_null'], 1);
  // Hand-derived: total=1, bootstrap_null=1 -> 1/1 = 1.
  assert.equal(section.classical_alpha_fraction, 1);
});

// ────────────────────────────────────────────────────────────────────
// tools/_guarantee-manifest-family-e.ts buildFamilyESection — join
// correctness. Runtime (engine/detectors/conformal.ts
// lookupFamilyEParams, lines 112-141) always resolves ConformalParams
// from aggregate_fallback.family_E; a per-cell family_E block is
// compiled but never read there. This locks in that resolvedKindPerCell
// mirrors that exactly: a per-cell kind that diverges from the
// aggregate must not leak into the reported counts.

function familyECfg(perCellKind: ConformalParams, aggregateKind: ConformalParams): CompiledConfig {
  return {
    version: 'test', compiler_version: '0', compiled_at: '0', baseline_ref: 't',
    alpha_budget: { total: 1e-3, per_family: { A: 0, B: 0, C: 0, D: 0, E: 1e-4 } },
    baseline_cells: {
      dimensions: ['hour_of_day'],
      cells: [{
        key: { hour_of_day: 5 },
        n_samples: 10,
        confidence: 'strict',
        family_E: perCellKind,
      }],
      aggregate_fallback: { family_E: aggregateKind },
    },
  };
}

test('Family E buildFamilyESection: a divergent per-cell family_E.kind is ignored — '
  + 'the manifest reports the aggregate_fallback kind, matching what runtime actually '
  + 'reads (engine/detectors/conformal.ts lookupFamilyEParams never consults a '
  + 'per-cell family_E block, even when the matched cell compiles one)', () => {
  const perCellKind: ConformalParams = {
    kind: 'weighted_e_value',
    scores: [1, 2, 3],
    weights: [1, 1, 1],
    cumulative_weights_above: [3, 2, 1],
    total_weight: 3,
    halflife_days: 7,
    effective_sample_size: 3,
  };
  const aggregateKind: ConformalParams = { kind: 'unweighted', calibration_scores: [0.1, 0.2, 0.3] };
  const cfg = familyECfg(perCellKind, aggregateKind);
  const section = buildFamilyESection(cfg);
  const entry = section.detectors[0];
  // Hand-derived: the sole cell's compiled per-cell kind is
  // 'weighted_e_value' (ville) but the aggregate is 'unweighted'
  // (classical); the manifest must report 'unweighted' (1/1 classical),
  // not 'weighted_e_value' (1/1 ville) — a per-cell-first join would get
  // this backwards.
  assert.equal(entry.cell_total, 1);
  assert.equal(entry.cell_counts?.['unweighted'], 1);
  assert.equal(entry.cell_counts?.['weighted_e_value'] ?? 0, 0);
  assert.equal(section.classical_alpha_fraction, 1);
});

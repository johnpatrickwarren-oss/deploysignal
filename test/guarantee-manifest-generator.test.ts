// test/guarantee-manifest-generator.test.ts — WS2 machine-readable
// guarantee manifest: tools/build-guarantee-manifest.ts generator tests.
//
// Deviation from the WS2 brief worth flagging up front: the brief's
// example expected "Family C MMD bootstrap_null on 820/840 cells
// [classical fallback]" for v5-sequential-e-process.json, extrapolating
// from the compiled config's legacy `mmd_variant` field. That field is
// VESTIGIAL — engine/types/families/c.ts's FamilyCPerCell interface no
// longer declares it, no runtime code reads `.mmd_variant` (grep
// confirms zero property accesses across engine/ and tools/), and
// tools/calibrators/_family-c-build.ts's current compiler no longer
// emits it at all. The classical bootstrap-null Sequential-MMD evaluator
// itself is retired from runtime dispatch at Q68 close
// (engine/gates/_health-detectors.ts `runFamilyC` only calls the two
// Ville-bounded MMD evaluators). So on this config, the 820 cells stamped
// `mmd_variant: 'bootstrap_null'` by an older compiler get NO Sequential-
// MMD coverage at runtime at all (neither `e_mmd_params` nor
// `betting_e_process_params` is populated) — not a live classical
// fallback. This test suite asserts what the current runtime code
// actually does, per the join logic documented in
// tools/_guarantee-manifest-family-c.ts.
//
// A second, unanticipated finding this suite locks in: BOTH committed
// fixtures (v5 and v7) compile Family E's `ConformalParams.kind` as
// 'unweighted' (the classical parametric-Gaussian-bootstrap conformal
// p-value test) rather than 'weighted_e_value' (Addition #22's
// Ville-bounded wealth process) — the compiler's default 'auto' variant
// selector falls back to the classical kind when the baseline span/ESS
// don't clear the weighting-beneficial gate (tools/calibrators/family-e.ts).
// This — not the MMD fallback — is what actually keeps both fixtures out
// of 'fully_ville_bounded'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompiledConfig } from '../engine/types';
import { buildGuaranteeManifest } from '../tools/build-guarantee-manifest';

const REPO_ROOT = path.resolve(__dirname, '..');

function loadFixture(name: string): CompiledConfig {
  const p = path.join(REPO_ROOT, 'runs', 'compiled-configs', name);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CompiledConfig;
}

const FIXED_TS = '2026-01-01T00:00:00.000Z';

test('v5-sequential-e-process.json: alpha_budget echoes the compiled config', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  assert.deepEqual(m.alpha_budget, cfg.alpha_budget);
  assert.equal(m.compiler_version, cfg.compiler_version);
  assert.equal(m.config_version, cfg.version);
  assert.equal(m.baseline_ref, cfg.baseline_ref);
});

test('v5-sequential-e-process.json: Family B is alpha_participating=false for every entry', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  assert.equal(m.families.B.alpha_participating, false);
  assert.equal(m.families.B.detectors.length, 16);
  for (const d of m.families.B.detectors) assert.equal(d.alpha_participating, false);
});

test('v5-sequential-e-process.json: Hotelling is safe_test (ville) on all 840/840 cells; '
  + 'chi_square (classical) on 0/840 — no classical Hotelling contribution', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  const safe = m.families.C.detectors.find((d) => d.detector_id === 'hotelling_t2_safe')!;
  const classical = m.families.C.detectors.find((d) => d.detector_id === 'hotelling_t2_joint_vector')!;
  assert.equal(safe.cell_counts?.['safe_test'], 840);
  assert.equal(safe.cell_total, 840);
  assert.equal(classical.cell_counts?.['chi_square'] ?? 0, 0);
});

test('v5-sequential-e-process.json: Sequential MMD — Q67 v2 canonical (ville) active on '
  + '20/840 cells (the legacy `sequential_mmd` id, per the audit-writer id-mapping gap '
  + 'documented in engine/guarantees.ts); 820/840 cells have NO Sequential-MMD coverage '
  + '(not a classical fallback — the classical evaluator is retired from dispatch)', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  const canonical = m.families.C.detectors.find((d) => d.detector_id === 'sequential_mmd')!;
  const optionB = m.families.C.detectors.find((d) => d.detector_id === 'sequential_mmd_e_process')!;
  assert.equal(canonical.cell_counts?.['canonical'], 20);
  assert.equal(canonical.cell_counts?.['no_coverage'], 820);
  assert.equal(optionB.cell_counts?.['option_b'] ?? 0, 0);
  assert.equal(canonical.validity_class, 'ville_anytime_valid');
  assert.equal(optionB.validity_class, 'ville_anytime_valid');
});

test('v5-sequential-e-process.json: Family C classical_alpha_fraction is 0 — neither the '
  + 'Hotelling nor the MMD sub-test is on a classical path in this config', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  assert.equal(m.families.C.classical_alpha_fraction, 0);
});

test('v5-sequential-e-process.json: Family D spectral is e_detector (ville) on all '
  + 'populated kv_cache cells; no classical bootstrap_null contribution', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  const eDet = m.families.D.detectors.find((d) => d.detector_id === 'spectral_e_detector_kv_cache')!;
  assert.ok((eDet.cell_total ?? 0) > 0);
  assert.equal(eDet.cell_counts?.['e_detector'], eDet.cell_total);
  assert.equal(m.families.D.classical_alpha_fraction, 0);
});

test('v5-sequential-e-process.json: Family E is configured classical (kind=unweighted) — '
  + "the 'auto' variant selector fell back off the Ville weighted_e_value path — but since "
  + 'C25 (2026-09-02) Family E is advisory and non-α-participating, so its classical share '
  + 'is excluded: effective_validity is fully_ville_bounded even though this fixture still '
  + 'carries E at 1e-4', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  const conformal = m.families.E.detectors[0];
  assert.equal(conformal.cell_counts?.['unweighted'], 840);
  assert.equal(conformal.cell_counts?.['weighted_e_value'] ?? 0, 0);
  assert.equal(m.families.E.classical_alpha_fraction, 1, 'the configured reality is unchanged: classical');
  assert.equal(m.families.E.alpha_participating, false, 'C25: advisory, spends no α');
  assert.equal(conformal.alpha_participating, false);
  assert.equal(m.families.E.alpha_budget, 1e-4, 'pre-C25 fixture budget is reported as-is');
  assert.equal(m.effective_validity.status, 'fully_ville_bounded');
  assert.equal(m.effective_validity.classical_share_of_participating_alpha, 0);
  assert.ok(!m.effective_validity.classical_paths.some((p) => p.includes('Family E')));
});

test('v7-demos.json: manifest is well-formed and effective_validity matches its '
  + 'configured variants (Family E still classical=unweighted but advisory since C25, '
  + 'so fully_ville_bounded; MMD active via Option-B on 20/840 cells this time, not '
  + 'the canonical id)', () => {
  const cfg = loadFixture('v7-demos.json');
  const m = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });

  assert.equal(m.manifest_version, 1);
  assert.equal(m.generated_at, FIXED_TS);
  for (const fam of ['A', 'B', 'C', 'D', 'E'] as const) {
    assert.ok(m.families[fam], `missing families.${fam}`);
    assert.ok(m.families[fam].detectors.length > 0);
  }

  const canonical = m.families.C.detectors.find((d) => d.detector_id === 'sequential_mmd')!;
  const optionB = m.families.C.detectors.find((d) => d.detector_id === 'sequential_mmd_e_process')!;
  assert.equal(canonical.cell_counts?.['canonical'] ?? 0, 0);
  assert.equal(optionB.cell_counts?.['option_b'], 20);
  assert.equal(optionB.cell_counts?.['no_coverage'], 820);

  assert.equal(m.families.E.classical_alpha_fraction, 1);
  assert.equal(m.families.E.alpha_participating, false, 'C25: advisory');
  assert.equal(m.effective_validity.status, 'fully_ville_bounded');
});

test('generator is a pure function: identical (config, generatedAt) input produces a '
  + 'byte-identical manifest — no Date.now() or other hidden nondeterminism', () => {
  const cfg = loadFixture('v5-sequential-e-process.json');
  const m1 = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  const m2 = buildGuaranteeManifest(cfg, { generatedAt: FIXED_TS });
  assert.deepEqual(m1, m2);
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
});

test('known_limitations and fallback_behavior are non-empty and config-independent', () => {
  const v5 = buildGuaranteeManifest(loadFixture('v5-sequential-e-process.json'), { generatedAt: FIXED_TS });
  const v7 = buildGuaranteeManifest(loadFixture('v7-demos.json'), { generatedAt: FIXED_TS });
  assert.ok(v5.known_limitations.length > 0);
  assert.ok(v5.fallback_behavior.length > 0);
  assert.deepEqual(v5.known_limitations, v7.known_limitations);
  assert.deepEqual(v5.fallback_behavior, v7.fallback_behavior);
});

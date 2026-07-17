// tools/_guarantee-manifest-build.ts — pure generator:
// (compiledConfig, opts) => GuaranteeManifest. No I/O, no Date.now() —
// generated_at is threaded through from opts so the function is
// deterministic for a fixed input (required by the WS2 brief's
// determinism test).

import type { CompiledConfig, FamilyId } from '../engine/types';
import { COMPILER_VERSION_UNKNOWN } from './_guarantee-manifest-constants';
import { buildFamilyASection, buildFamilyBSection } from './_guarantee-manifest-family-ab';
import { buildFamilyCSection } from './_guarantee-manifest-family-c';
import { buildFamilyDSection } from './_guarantee-manifest-family-d';
import { buildFamilyESection } from './_guarantee-manifest-family-e';
import { computeEffectiveValidity } from './_guarantee-manifest-effective';
import { KNOWN_LIMITATIONS, FALLBACK_BEHAVIOR } from './_guarantee-manifest-limitations';
import type { BuildGuaranteeManifestOpts, GuaranteeManifest, ManifestFamilySection } from './_guarantee-manifest-types';

function buildFamilies(cfg: CompiledConfig): Record<FamilyId, ManifestFamilySection> {
  return {
    A: buildFamilyASection(cfg),
    B: buildFamilyBSection(cfg),
    C: buildFamilyCSection(cfg),
    D: buildFamilyDSection(cfg),
    E: buildFamilyESection(cfg),
  };
}

export function buildGuaranteeManifest(
  cfg: CompiledConfig,
  opts: BuildGuaranteeManifestOpts,
): GuaranteeManifest {
  const families = buildFamilies(cfg);
  return {
    manifest_version: 1,
    generated_at: opts.generatedAt,
    compiler_version: cfg.compiler_version ?? COMPILER_VERSION_UNKNOWN,
    config_version: cfg.version,
    baseline_ref: cfg.baseline_ref,
    baseline_provenance: cfg.baseline_provenance ?? 'unknown',
    alpha_budget: {
      total: cfg.alpha_budget.total,
      per_family: { ...cfg.alpha_budget.per_family },
    },
    families,
    effective_validity: computeEffectiveValidity(families),
    known_limitations: [...KNOWN_LIMITATIONS],
    fallback_behavior: [...FALLBACK_BEHAVIOR],
  };
}

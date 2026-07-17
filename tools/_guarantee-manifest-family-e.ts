// tools/_guarantee-manifest-family-e.ts — Family E (weighted-conformal
// Mahalanobis novelty) manifest section. DETECTOR_REGISTRY.E has exactly
// ONE id (mahalanobis_conformal_baseline) covering THREE possible
// ConformalParams.kind values with different validity properties
// ('unweighted' / 'weighted' are classical per-tick tests; 'weighted_e_value'
// — Addition #22 — is the Ville-bounded wealth process). engine/guarantees.ts
// records the canonical (Addition #22) guarantee for the id; this join
// reports which kind the config ACTUALLY selected, which is what
// effective_validity needs.
//
// Cells without a per-cell `family_E` block are served by
// `aggregate_fallback.family_E` at runtime (Family E piggybacks on Family
// C's per-cell mean/covariance the same way Family C itself falls back);
// so every cell counts toward whichever kind actually covers it.

import type { CompiledConfig, ConformalParams } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import type { ManifestDetectorEntry, ManifestFamilySection } from './_guarantee-manifest-types';

function kindOf(p: ConformalParams): string {
  return p.kind ?? 'unweighted';
}

function resolvedKindPerCell(cfg: CompiledConfig): string[] {
  const cells = cfg.baseline_cells?.cells ?? [];
  const fallback = cfg.baseline_cells?.aggregate_fallback.family_E;
  const out: string[] = [];
  for (const c of cells) {
    const p = c.family_E ?? fallback;
    if (p) out.push(kindOf(p));
  }
  return out;
}

export function buildFamilyESection(cfg: CompiledConfig): ManifestFamilySection {
  const kinds = resolvedKindPerCell(cfg);
  const total = kinds.length;
  const counts: Record<string, number> = {};
  for (const k of kinds) counts[k] = (counts[k] ?? 0) + 1;

  const g = DETECTOR_GUARANTEES['mahalanobis_conformal_baseline'];
  const villeCount = counts['weighted_e_value'] ?? 0;
  const classicalCount = total - villeCount;
  const entry: ManifestDetectorEntry = {
    detector_id: 'mahalanobis_conformal_baseline',
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `kind=weighted_e_value [ville] on ${villeCount}/${total} cells; `
      + `kind=unweighted|weighted [classical — per-tick conformal test, no wealth process] `
      + `on ${classicalCount}/${total} cells`,
    cell_counts: counts,
    cell_total: total,
  };

  const classicalAlphaFraction = total > 0 ? classicalCount / total : 0;

  return {
    family: 'E',
    alpha_participating: true,
    alpha_budget: cfg.alpha_budget?.per_family?.E ?? null,
    detectors: [entry],
    classical_alpha_fraction: classicalAlphaFraction,
  };
}

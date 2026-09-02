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
// Ground truth (verified against engine/detectors/conformal.ts
// lookupFamilyEParams, W5 REPLY-16 Q2, lines 112-141): the runtime ALWAYS
// dispatches on `aggregate_fallback.family_E` for the ConformalParams
// (and therefore the `kind` this join cares about) — never a per-cell
// `family_E` block, even when the matched cell compiles one
// (`match?.family_E` is never read there). Only Family C's per-cell
// mean/covariance is looked up per-cell for the Mahalanobis distance; the
// conformal calibration_scores/kind are pooled-aggregate only, for
// statistical-power reasons documented at that citation. So every cell's
// EFFECTIVE kind is the one value carried by `aggregate_fallback.family_E`.
// resolvedKindPerCell below resolves aggregate-only, matching runtime
// exactly — reading a per-cell `family_E` block first (as an earlier
// version of this join did) would silently diverge from what the engine
// actually evaluates whenever a per-cell block's `kind` differs from the
// aggregate's.

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
  // Aggregate-only, per the file header: runtime never reads a per-cell
  // `family_E` block, so this join must not either.
  for (const _c of cells) {
    if (fallback) out.push(kindOf(fallback));
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
    alpha_participating: g.alpha_participating,
    alpha_budget: cfg.alpha_budget?.per_family?.E ?? null,
    detectors: [entry],
    classical_alpha_fraction: classicalAlphaFraction,
  };
}

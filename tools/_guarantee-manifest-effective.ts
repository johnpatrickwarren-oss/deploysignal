// tools/_guarantee-manifest-effective.ts — effective_validity: the
// manifest's single computed summary of whether THIS config is fully
// Ville-bounded on its α-participating surface, or mixed.

import type { FamilyId } from '../engine/types';
import type { ManifestEffectiveValidity, ManifestFamilySection } from './_guarantee-manifest-types';

const CLASSICAL_PATH_LABEL: Record<FamilyId, string> = {
  A: 'Family A (Page-CUSUM / betting e-process)',
  B: 'Family B (structural — never α-participating)',
  C: 'Family C',
  D: 'Family D (spectral)',
  E: 'Family E (conformal)',
};

/** Weighted mean of each participating family's classical_alpha_fraction,
 *  weighted by that family's α budget. Families with alpha_budget null or
 *  0, or that don't participate, are excluded from both numerator and
 *  denominator. */
export function computeEffectiveValidity(
  families: Record<FamilyId, ManifestFamilySection>,
): ManifestEffectiveValidity {
  let weightedClassical = 0;
  let totalWeight = 0;
  const classicalPaths: string[] = [];

  for (const family of Object.values(families)) {
    if (!family.alpha_participating || !family.alpha_budget) continue;
    totalWeight += family.alpha_budget;
    weightedClassical += family.alpha_budget * family.classical_alpha_fraction;
    if (family.classical_alpha_fraction > 0) {
      classicalPaths.push(
        `${CLASSICAL_PATH_LABEL[family.family]}: ${(family.classical_alpha_fraction * 100).toFixed(1)}% `
        + `of this family's configured surface is classical/non-Ville in this config`,
      );
    }
  }

  const share = totalWeight > 0 ? weightedClassical / totalWeight : 0;
  return {
    status: share > 0 ? 'mixed' : 'fully_ville_bounded',
    classical_share_of_participating_alpha: share,
    classical_paths: classicalPaths,
  };
}

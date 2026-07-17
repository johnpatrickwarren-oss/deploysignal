// tools/_guarantee-manifest-types.ts — GuaranteeManifest shape + the small
// per-family join-result types tools/build-guarantee-manifest.ts assembles.
// Split out per arch-invariants.json (keep tools/build-guarantee-manifest.ts
// a thin facade + CLI).

import type { DetectorId, FamilyId } from '../engine/types';
import type { ValidityClass } from '../engine/guarantees';

/** One detector's configured-reality summary within a family section.
 *  `configured_reality` is a short, human-readable sentence describing
 *  what the JOINED compiled config actually selected for this id — not
 *  the static guarantees.ts claim alone. `cell_counts` is the structured
 *  form of the same information for programmatic consumers. */
export interface ManifestDetectorEntry {
  detector_id: DetectorId;
  validity_class: ValidityClass;
  alpha_participating: boolean;
  configured_reality: string;
  /** Present when the config carries per-cell/per-signal variant data for
   *  this id (Families C/D/E). Keys are variant labels (e.g.
   *  'safe_test', 'chi_square', 'e_detector', 'bootstrap_null',
   *  'weighted_e_value', 'unweighted', 'weighted', 'no_coverage');
   *  values are cell/signal counts. Absent for Family A/B ids, whose
   *  guarantee doesn't vary per cell in the current schema. */
  cell_counts?: Record<string, number>;
  /** Total cells/signals the count denominators are drawn from, when
   *  cell_counts is present. */
  cell_total?: number;
}

export interface ManifestFamilySection {
  family: FamilyId;
  alpha_participating: boolean;
  alpha_budget: number | null;
  detectors: ManifestDetectorEntry[];
  /** Fraction (0..1) of this family's configured α-participating surface
   *  that is, in THIS compiled config, backed by a classical (non-Ville)
   *  test rather than the Ville-bounded variant. 0 for Family B (never
   *  participates) and for any family whose configured paths are fully
   *  Ville in this config. Computed per-family by the family-specific
   *  join module (each has its own notion of "this cell's route was
   *  classical" — see tools/_guarantee-manifest-family-*.ts). */
  classical_alpha_fraction: number;
}

export interface ManifestEffectiveValidity {
  status: 'fully_ville_bounded' | 'mixed';
  /** Share of the α-participating budget (A+C+D+E; Family B excluded —
   *  it never participates) attributable to a classical (non-Ville) path
   *  in THIS config. Cells with NO coverage at all (neither a classical
   *  nor a Ville test runs for them — see the per-family join modules,
   *  e.g. tools/_guarantee-manifest-family-c.ts's Sequential-MMD
   *  no_coverage route and tools/_guarantee-manifest-family-d.ts's
   *  spectral no_coverage route) are deliberately EXCLUDED from this
   *  share: they're absent capacity, not a classical substitute. 0 when
   *  status is 'fully_ville_bounded'. */
  classical_share_of_participating_alpha: number;
  /** Human-readable list of exactly which configured paths are not
   *  Ville-bounded in this config (empty when fully_ville_bounded). */
  classical_paths: string[];
}

export interface GuaranteeManifest {
  manifest_version: 1;
  generated_at: string;
  compiler_version: string;
  config_version: string;
  baseline_ref: string;
  baseline_provenance: string;
  alpha_budget: {
    total: number;
    per_family: Record<string, number>;
  };
  families: Record<FamilyId, ManifestFamilySection>;
  effective_validity: ManifestEffectiveValidity;
  known_limitations: string[];
  fallback_behavior: string[];
}

/** Options for buildGuaranteeManifest. `generatedAt` is required (not
 *  defaulted to Date.now()) so the generator stays a pure function of its
 *  inputs — determinism tests inject a fixed value. */
export interface BuildGuaranteeManifestOpts {
  generatedAt: string;
}

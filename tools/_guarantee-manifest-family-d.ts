// tools/_guarantee-manifest-family-d.ts — Family D (spectral ACF)
// manifest section. Only `kv_cache` has a registered DETECTOR_REGISTRY.D
// id (spectral_peak_acf_kv_cache / spectral_e_detector_kv_cache); the
// compiler emits FamilyDPerSignal for other signals too, but they have no
// registry id to attribute fires to (see engine/detectors/spectral.ts
// FAMILY_D_SIGNALS comment) so they're out of scope for this manifest.

import type { CompiledConfig, DetectorId, FamilyDPerSignal } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import type { ManifestDetectorEntry, ManifestFamilySection } from './_guarantee-manifest-types';

const REGISTERED_SIGNAL = 'kv_cache';
type SpectralRoute = 'e_detector' | 'bootstrap_null';

function kvCacheCells(cfg: CompiledConfig): FamilyDPerSignal[] {
  const cells = cfg.baseline_cells?.cells ?? [];
  const out: FamilyDPerSignal[] = [];
  for (const c of cells) {
    const p = c.family_D?.[REGISTERED_SIGNAL];
    if (p) out.push(p);
  }
  return out;
}

function classify(p: FamilyDPerSignal): SpectralRoute {
  // Mirrors engine/detectors/spectral.ts spectralVariantForDispatch: the
  // e_detector path additionally requires the compiled null moments
  // (null_mean/null_std); config-declared 'e_detector' without them can't
  // actually run and the runtime dispatcher would fall through.
  if (p.spectral_variant === 'e_detector' && p.null_mean !== undefined && p.null_std !== undefined) {
    return 'e_detector';
  }
  return 'bootstrap_null';
}

function entry(id: DetectorId, route: SpectralRoute, counts: Record<string, number>, total: number): ManifestDetectorEntry {
  const g = DETECTOR_GUARANTEES[id];
  const n = counts[route] ?? 0;
  const label = route === 'e_detector' ? 'e_detector [ville]' : 'bootstrap_null [classical]';
  return {
    detector_id: id,
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `spectral_variant=${label} on ${n}/${total} cells (signal=${REGISTERED_SIGNAL})`,
    cell_counts: counts,
    cell_total: total,
  };
}

export function buildFamilyDSection(cfg: CompiledConfig): ManifestFamilySection {
  const perSignal = kvCacheCells(cfg);
  const total = perSignal.length;
  const routes = perSignal.map(classify);
  const counts: Record<string, number> = {};
  for (const r of routes) counts[r] = (counts[r] ?? 0) + 1;

  const classicalAlphaFraction = total > 0 ? (counts['bootstrap_null'] ?? 0) / total : 0;

  return {
    family: 'D',
    alpha_participating: true,
    alpha_budget: cfg.alpha_budget?.per_family?.D ?? null,
    detectors: [
      entry('spectral_peak_acf_kv_cache', 'bootstrap_null', counts, total),
      entry('spectral_e_detector_kv_cache', 'e_detector', counts, total),
    ],
    classical_alpha_fraction: classicalAlphaFraction,
  };
}

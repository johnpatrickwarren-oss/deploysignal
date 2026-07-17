// tools/_guarantee-manifest-family-d.ts — Family D (spectral ACF)
// manifest section. Only `kv_cache` has a registered DETECTOR_REGISTRY.D
// id (spectral_peak_acf_kv_cache / spectral_e_detector_kv_cache); the
// compiler emits FamilyDPerSignal for other signals too, but they have no
// registry id to attribute fires to (see engine/detectors/spectral.ts
// FAMILY_D_SIGNALS comment) so they're out of scope for this manifest.
//
// Ground truth (verified against engine/detectors/spectral.ts
// spectralVariantForDispatch + evaluateSpectralEDetector): a cell
// configured spectral_variant='e_detector' is NOT rerouted to the
// classical bootstrap_null test when its null_mean/null_std moments are
// missing from the compiled config. The dispatcher only falls back to
// bootstrap_null when the runtime per-(deploy, signal) wealth-state
// object is absent — a gate-wiring/legacy-TrendBuffer concern, not
// something this compiled config controls (the gate lazily allocates
// state for every evaluated cell). An e_detector cell missing its null
// moments instead reaches evaluateSpectralEDetector, which returns
// SUPPRESSED (spectral_e_detector_params_missing) — NO Family-D coverage
// runs for that cell at runtime. So this join has three routes, not two;
// 'no_coverage' mirrors how tools/_guarantee-manifest-family-c.ts encodes
// its own no-coverage cells and is excluded from classical_alpha_fraction
// for the same reason (absent capacity, not a classical substitute).

import type { CompiledConfig, DetectorId, FamilyDPerSignal } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import type { ManifestDetectorEntry, ManifestFamilySection } from './_guarantee-manifest-types';

const REGISTERED_SIGNAL = 'kv_cache';
type SpectralRoute = 'e_detector' | 'bootstrap_null' | 'no_coverage';

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
  // Mirrors engine/detectors/spectral.ts spectralVariantForDispatch +
  // evaluateSpectralEDetector, not just the dispatch map: a config-declared
  // 'e_detector' cell always reaches the e-detector evaluator at runtime
  // (see file header). Missing null_mean/null_std doesn't fall through to
  // bootstrap_null — the evaluator suppresses instead, so that cell has NO
  // Family-D coverage at all.
  if (p.spectral_variant !== 'e_detector') return 'bootstrap_null';
  if (p.null_mean !== undefined && p.null_std !== undefined) return 'e_detector';
  return 'no_coverage';
}

function bootstrapEntry(id: DetectorId, counts: Record<string, number>, total: number): ManifestDetectorEntry {
  const g = DETECTOR_GUARANTEES[id];
  const n = counts['bootstrap_null'] ?? 0;
  return {
    detector_id: id,
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `spectral_variant=bootstrap_null [classical] on ${n}/${total} cells `
      + `(signal=${REGISTERED_SIGNAL})`,
    cell_counts: counts,
    cell_total: total,
  };
}

function eDetectorEntry(id: DetectorId, counts: Record<string, number>, total: number): ManifestDetectorEntry {
  const g = DETECTOR_GUARANTEES[id];
  const n = counts['e_detector'] ?? 0;
  const noCoverage = counts['no_coverage'] ?? 0;
  return {
    detector_id: id,
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `spectral_variant=e_detector [ville] on ${n}/${total} cells; NO Family-D `
      + `coverage at all (spectral_variant=e_detector configured but null_mean/null_std not `
      + `compiled — engine/detectors/spectral.ts evaluateSpectralEDetector returns SUPPRESSED) `
      + `on ${noCoverage}/${total} cells (signal=${REGISTERED_SIGNAL})`,
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

  // no_coverage is deliberately excluded from both numerator and
  // denominator's implicit "classical" bucket — it's absent capacity, not
  // a classical substitute (mirrors Family C's Sequential-MMD no_coverage
  // treatment).
  const classicalAlphaFraction = total > 0 ? (counts['bootstrap_null'] ?? 0) / total : 0;

  return {
    family: 'D',
    alpha_participating: true,
    alpha_budget: cfg.alpha_budget?.per_family?.D ?? null,
    detectors: [
      bootstrapEntry('spectral_peak_acf_kv_cache', counts, total),
      eDetectorEntry('spectral_e_detector_kv_cache', counts, total),
    ],
    classical_alpha_fraction: classicalAlphaFraction,
  };
}

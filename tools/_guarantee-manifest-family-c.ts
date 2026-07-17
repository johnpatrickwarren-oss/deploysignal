// tools/_guarantee-manifest-family-c.ts — Family C (Hotelling T² +
// Sequential MMD) manifest section. Both sub-detectors are config-variant
// dependent (hotelling_variant per cell; MMD dispatch by which param
// struct is populated), so this is a per-cell join, not a static lookup.
//
// MMD ground truth (verified against engine/gates/_health-detectors.ts
// runFamilyC + engine/detectors/sequential-mmd.ts resolveEMmdParams):
// the classical bootstrap-null evaluator is retired from runtime
// dispatch at Q68 close. A cell's Family C MMD coverage is exactly one
// of three states: routed to the Q67 v2 canonical betting e-process
// (cell.betting_e_process_params present — takes priority), routed to
// the Option-B GRAPA/ONS betting e-process (only e_mmd_params present),
// or NO Sequential-MMD coverage at all (neither present — typically
// because the cell's baseline sample count is below
// MMD_MIN_BASELINE_SAMPLES; Hotelling remains the only Family C signal
// for that cell). There is no live classical MMD path to fall back to.

import type { CompiledConfig, DetectorId, FamilyCPerCell } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import type { ManifestDetectorEntry, ManifestFamilySection } from './_guarantee-manifest-types';

type MmdRoute = 'canonical' | 'option_b' | 'no_coverage';
type HotellingRoute = 'safe_test' | 'chi_square';

function familyCCells(cfg: CompiledConfig): FamilyCPerCell[] {
  const cells = cfg.baseline_cells?.cells ?? [];
  return cells.map((c) => c.family_C).filter((fc): fc is FamilyCPerCell => fc !== undefined);
}

function classifyHotelling(fc: FamilyCPerCell): HotellingRoute {
  // Mirrors engine/detectors/_hotelling-dispatch.ts hotellingVariantForDispatch:
  // 'safe_test' only takes effect when safe_hotelling_params is compiled;
  // otherwise (undefined, explicit 'chi_square', or 'safe_test' missing
  // its params) the dispatcher falls back to chi_square.
  if (fc.hotelling_variant === 'safe_test' && fc.safe_hotelling_params) return 'safe_test';
  return 'chi_square';
}

function classifyMmd(fc: FamilyCPerCell): MmdRoute {
  // Mirrors resolveEMmdParams's supersession guard: canonical params, if
  // present, always own the cell.
  if (fc.betting_e_process_params) return 'canonical';
  if (fc.e_mmd_params) return 'option_b';
  return 'no_coverage';
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

function hotellingEntry(id: DetectorId, route: HotellingRoute, counts: Record<string, number>, total: number): ManifestDetectorEntry {
  const g = DETECTOR_GUARANTEES[id];
  const n = counts[route] ?? 0;
  const label = route === 'safe_test' ? 'safe_test [ville]' : 'chi_square [classical]';
  return {
    detector_id: id,
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `hotelling_variant=${label} on ${n}/${total} cells`,
    cell_counts: counts,
    cell_total: total,
  };
}

function mmdEntry(id: DetectorId, route: MmdRoute, counts: Record<string, number>, total: number): ManifestDetectorEntry {
  const g = DETECTOR_GUARANTEES[id];
  const n = counts[route] ?? 0;
  const noCoverage = counts['no_coverage'] ?? 0;
  return {
    detector_id: id,
    validity_class: g.validity_class,
    alpha_participating: g.alpha_participating,
    configured_reality: `active [ville] on ${n}/${total} cells; no Sequential-MMD coverage at all `
      + `(neither betting_e_process_params nor e_mmd_params compiled — typically below `
      + `MMD_MIN_BASELINE_SAMPLES) on ${noCoverage}/${total} cells — Hotelling remains the `
      + `sole Family C signal there`,
    cell_counts: counts,
    cell_total: total,
  };
}

export function buildFamilyCSection(cfg: CompiledConfig): ManifestFamilySection {
  const cells = familyCCells(cfg);
  const total = cells.length;
  const hotellingCounts = countBy(cells.map(classifyHotelling));
  const mmdCounts = countBy(cells.map(classifyMmd));

  const detectors: ManifestDetectorEntry[] = [
    hotellingEntry('hotelling_t2_joint_vector', 'chi_square', hotellingCounts, total),
    hotellingEntry('hotelling_t2_safe', 'safe_test', hotellingCounts, total),
    mmdEntry('sequential_mmd', 'canonical', mmdCounts, total),
    mmdEntry('sequential_mmd_e_process', 'option_b', mmdCounts, total),
  ];

  // Family C's α splits 50/50 between Hotelling and Sequential MMD
  // (Addition #18 D8: "Sequential MMD gets half of the Family-C α-budget").
  // Only Hotelling has a live classical option (chi_square); MMD's
  // "no_coverage" cells spend no α at all (the detector doesn't run
  // there), so they don't count as classical — they're absent capacity,
  // not a classical substitute.
  const chiSquareFraction = total > 0 ? (hotellingCounts['chi_square'] ?? 0) / total : 0;
  const classicalAlphaFraction = 0.5 * chiSquareFraction;

  return {
    family: 'C',
    alpha_participating: true,
    alpha_budget: cfg.alpha_budget?.per_family?.C ?? null,
    detectors,
    classical_alpha_fraction: classicalAlphaFraction,
  };
}

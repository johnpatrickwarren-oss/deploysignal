// tools/_guarantee-manifest-family-ab.ts — Family A (per-signal change
// detection, uniformly Ville per engine/guarantees.ts) and Family B
// (structural, never α-participating) manifest sections. Neither family
// has per-cell variant selection in the current CompiledConfig schema —
// Family A's mixture-supermartingale dispatch is unconditional (Q68
// close) and Family B is flat cutoffs, not per-cell — so these sections
// are simpler than C/D/E and don't need cell_counts.

import type { CompiledConfig, DetectorId, FamilyId } from '../engine/types';
import { DETECTOR_REGISTRY } from '../engine/types';
import { DETECTOR_GUARANTEES } from '../engine/guarantees';
import type { ManifestDetectorEntry, ManifestFamilySection } from './_guarantee-manifest-types';

const FAMILY_A_DEFAULT_SIGNALS = [
  'p99_latency', 'ttft', 'eval_score', 'tool_success_rate',
  'downstream_err', 'cost_req',
] as const;

function familyASignalCount(cfg: CompiledConfig): number {
  return (cfg.family_a_signals ?? FAMILY_A_DEFAULT_SIGNALS).length;
}

/** Family A: every registry id is ville_anytime_valid at runtime (Q68
 *  consolidation — see engine/guarantees.ts file header). Report which
 *  signals the config actually monitors; the legacy mSPRT_* ids are what
 *  the audit writer emits, page_cusum_* is a reserved forward-compat
 *  alias with identical runtime binding. */
export function buildFamilyASection(cfg: CompiledConfig): ManifestFamilySection {
  const nSignals = familyASignalCount(cfg);
  const detectors: ManifestDetectorEntry[] = DETECTOR_REGISTRY.A.map((id: DetectorId) => {
    const g = DETECTOR_GUARANTEES[id];
    if (id.startsWith('safe_t_e_value_')) {
      // C64 (a): the terminal safe-t path runs only when the caller supplies a calibration
      // series (OrchestrateParams.validPath); a compiled config alone never activates it.
      return {
        detector_id: id,
        validity_class: g.validity_class,
        alpha_participating: g.alpha_participating,
        configured_reality: 'safe two-sample t e-value, one look at the canary end — inert unless the caller routes a calibration series (validPath)',
      };
    }
    const kind = id.startsWith('betting_e_process_') ? 'betting e-process co-ship'
      : id.startsWith('page_cusum_') ? 'mixture-supermartingale Page-CUSUM (reserved forward-compat id; not yet emitted)'
        : 'mixture-supermartingale Page-CUSUM (emitted as this id)';
    return {
      detector_id: id,
      validity_class: g.validity_class,
      alpha_participating: g.alpha_participating,
      configured_reality: `${kind} — Ville-bounded, active on ${nSignals} monitored signal(s)`,
    };
  });
  return {
    family: 'A',
    alpha_participating: true,
    alpha_budget: cfg.alpha_budget?.per_family?.A ?? null,
    detectors,
    // Every Family A registry id is ville_anytime_valid at runtime today
    // (Q68 consolidation) — no classical dispatch path is reachable.
    classical_alpha_fraction: 0,
  };
}

/** Family B: never α-participating; flat structural cutoffs (not
 *  per-cell), so all 16 ids share the same configured_reality string. */
function buildFlatStructuralSection(family: FamilyId, ids: readonly DetectorId[]): ManifestFamilySection {
  return {
    family,
    alpha_participating: false,
    alpha_budget: null,
    classical_alpha_fraction: 0,
    detectors: ids.map((id) => {
      const g = DETECTOR_GUARANTEES[id];
      return {
        detector_id: id,
        validity_class: g.validity_class,
        alpha_participating: g.alpha_participating,
        configured_reality: 'hand-tuned structural threshold — no statistical test, α reserved but never spent',
      };
    }),
  };
}

export function buildFamilyBSection(cfg: CompiledConfig): ManifestFamilySection {
  const section = buildFlatStructuralSection('B', DETECTOR_REGISTRY.B);
  const nCutoffs = cfg.family_B ? Object.keys(cfg.family_B.cutoffs).length : 0;
  section.alpha_budget = cfg.alpha_budget?.per_family?.B ?? null;
  if (!cfg.family_B) {
    for (const d of section.detectors) {
      d.configured_reality = 'Family B not compiled for this config (family_B absent) — inactive';
    }
  } else {
    for (const d of section.detectors) {
      d.configured_reality = `hand-tuned structural threshold — no statistical test, α reserved but never `
        + `spent (${nCutoffs} structural cutoff group(s) compiled)`;
    }
  }
  return section;
}

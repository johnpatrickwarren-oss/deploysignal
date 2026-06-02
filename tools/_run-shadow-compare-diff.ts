// tools/_run-shadow-compare-diff.ts — cross-substrate ΔFPR diff
// computation + Q62 Phase 4 H1a/H1b exemption mechanism for the
// shadow-compare orchestrator (extracted verbatim from
// tools/run-shadow-compare.ts during a behavior-preserving module
// split).

import type {
  Q60DetectorFamily,
  ShadowCompareBlock,
} from '../engine/types/config.js';
import {
  Q60_ALPHA_BUDGETS,
  Q60_DETECTOR_FAMILIES,
  type PerProfileReportCard,
} from './_run-shadow-compare-types';

// ── Cross-substrate diff ─────────────────────────────────────────

// ── Q62 Phase 4 H1a + H1b cross-substrate ΔFPR exemption mechanism ──
//
// Per ARCHITECT-REPLY-Q62-PHASE-4-DELTA-FPR-DISPOSITION.md § Ask 1
// (H1a + H1b combined PICK). Cross-substrate ΔFPR computation EXEMPTS:
//   - Classical-epoch-α detectors under iid_bootstrap mode
//     (family_A_page_cusum CAVEAT-inherited from Q58/Q59 H4 PERMANENT;
//     mmd_bootstrap_null when MMD_MIN fallback engages).
//   - Non-α-consuming structural detectors (family_B_pattern_match per
//     Q60 V2 family_b_trip_rate_note; reflects bootstrap-methodology
//     joint-distribution breakage, not production false-fire rate).
//
// 20th VIOLATION class anchor: cross-substrate-acceptance-bound-vs-
// CAVEAT-inheritance-coherence. Memorial F sub-rule 4 reinforcement:
// pre-existing-property-coherence verification must extend to multiple
// aggregation scopes (per-detector, per-substrate, cross-substrate,
// aggregate-pitch-claim). Cross-substrate ΔFPR aggregation requires
// SEPARATE exemption mechanism from per-substrate Q60 V2
// detector_exemption_reason mechanism.

// Q66 Phase-3.d.A close (item g) — family_A_page_cusum CAVEAT inheritance
// RETIRED. Default Page-CUSUM variant flips to anytime-valid Ville-bounded
// mixture-supermartingale (Howard-Ramdas-2021); methodology-resampler-mode
// invariant by construction. Q62 H1a+H1b cross-substrate ΔFPR exemption
// no longer required for this detector. Q66.A.b H1' AR(1) pre-whitening
// closes the parametric_ar1 ρ=0.5 → 17.2% FPR LS-1 surface. See
// coordination/ANTI-SCOPE-LEDGER.md § Q58 / Q59 stamps.
//
// Q67 Phase-3.d.B close (§ Q67.6) — family_C_mmd CAVEAT inheritance
// RETIRED. Default Sequential MMD variant flips to canonical anytime-valid
// Ville-bounded betting-e-process (Shekhar-Ramdas-2023); methodology-
// resampler-mode invariant by construction. Q62 H1a+H1b cross-substrate
// ΔFPR exemption no longer required for this detector. Build-report-card
// Phase-3.d.B acceptance gate (§ Q67.4) validates uniform mode invariance;
// see q67_phase_3_d_b_acceptance_gate stamp.
//
// family_B_pattern_match remains exempt (non-α-consuming structural
// detector; Q60 V2 family_b_trip_rate_note semantic preserved). Registry
// is now at its narrowest valid state post-Q67 Phase-3.d.B close.
const CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS: Partial<Record<Q60DetectorFamily, string>> = {
  family_B_pattern_match: 'non-α-consuming structural detector; family_b_trip_rate reflects joint-distribution breakage of bootstrap methodology per Q60 V2 family_b_trip_rate_note; not a production false-fire rate projection',
};

function isDetectorExemptFromCrossSubstrateFPR(family: Q60DetectorFamily): boolean {
  return family in CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS;
}

export function computeCrossSubstrateDiff(
  reportCards: Record<string, PerProfileReportCard>,
  referenceSubstrate: string,
  scenarios: string[],
): Record<string, ShadowCompareBlock> {
  const out: Record<string, ShadowCompareBlock> = {};
  for (const key of Object.keys(reportCards)) {
    const rc = reportCards[key];
    const substrateName = key.split('--')[0];
    if (substrateName === referenceSubstrate) continue;  // reference vs itself

    const scenario = key.split('--')[1];
    const refKey = `${referenceSubstrate}--${scenario}`;
    const refRc = reportCards[refKey];
    if (!refRc) continue;  // reference missing this scenario; skip

    const deltaFprPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [
        f,
        rc.per_detector_fpr_mean[f] - refRc.per_detector_fpr_mean[f],
      ]),
    ) as unknown as Record<Q60DetectorFamily, number>;

    // ΔTPR + Δmedian-TTD: stub zeros pending TPR sweep wiring (Phase
    // 2.2 build-report-card --profile flag emits TPR per scenario;
    // orchestrator reads that field). For Slice 1 scaffolding,
    // populate with zeros to make schema valid; empirical Phase 3
    // run produces real values.
    const deltaTprPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [f, 0]),
    ) as unknown as Record<Q60DetectorFamily, number>;
    const deltaTtdPerDetector = Object.fromEntries(
      Q60_DETECTOR_FAMILIES.map((f) => [f, 0]),
    ) as unknown as Record<Q60DetectorFamily, number>;

    // Q62 Phase 4 H1a+H1b: acceptance gate evaluates ΔFPR over NON-
    // EXEMPTED detectors only. Exempted detectors are emitted at
    // exempted_detector_metadata for audit transparency; their ΔFPR
    // values remain in delta_FPR_per_detector for diagnostic visibility
    // but do NOT count toward acceptance bound.
    const exemptedMetadata: Record<string, { detector: Q60DetectorFamily; reason: string; observed_delta_FPR: number }> = {};
    let fprMaxAbsNonExempt = 0;
    for (const family of Q60_DETECTOR_FAMILIES) {
      const dFpr = deltaFprPerDetector[family];
      if (isDetectorExemptFromCrossSubstrateFPR(family)) {
        exemptedMetadata[family] = {
          detector: family,
          reason: CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS[family]!,
          observed_delta_FPR: dFpr,
        };
        continue;
      }
      const absDFpr = Math.abs(dFpr);
      if (absDFpr > fprMaxAbsNonExempt) fprMaxAbsNonExempt = absDFpr;
    }
    const fprThreshold = 0.5 * Math.max(...Object.values(Q60_ALPHA_BUDGETS)) * 1.2;
    out[key] = {
      reference_substrate: referenceSubstrate,
      delta_TPR_per_detector: deltaTprPerDetector,
      delta_FPR_per_detector: deltaFprPerDetector,
      delta_median_TTD_per_detector: deltaTtdPerDetector,
      acceptance_gates_passed: {
        cross_substrate_delta_fpr_within_bound: fprMaxAbsNonExempt <= fprThreshold,
        cross_substrate_delta_tpr_within_bound: true,  // stub; Phase 3 fills
        cross_substrate_delta_ttd_within_bound: true,  // stub; Phase 3 fills
      },
      // Q62 Phase 4 H1a+H1b additive fields (preserve backward-compat
      // via optional schema field; pre-amendment consumers ignore).
      exempted_detector_count: Object.keys(exemptedMetadata).length,
      exempted_detector_metadata: exemptedMetadata,
    };
  }
  return out;
}

// engine/guarantees.ts — per-detector statistical-guarantee metadata.
//
// Single source of truth for what statistical claim each DETECTOR_REGISTRY
// id (engine/types/audit.ts) is entitled to make. This exists because an
// external review found the guarantee statement living only in prose
// (README.md / CHEAT-SHEET.md / deploysignal-paper.md) — and because that
// prose has, at different points, described a guarantee that the runtime
// dispatch code no longer implements. tools/build-guarantee-manifest.ts
// joins this static table against a compiled config to answer "what does
// THIS config actually guarantee" instead of "what did we last write down."
//
// Every entry below was verified against the CURRENT runtime dispatch path
// (not comments, not README prose) as of this file's authorship:
//
//   Family A — engine/detectors/_page-cusum-shadow.ts `evaluateFamilyA`
//     ALWAYS delegates to the Howard-Ramdas-McAuliffe-Sekhon-2021
//     mixture-supermartingale variant (family-a-mixture-supermartingale.ts).
//     The classical excursion-theory reset-at-zero CUSUM
//     (`evaluateFamilyAShadow`) is retired from the live gate path at Q68
//     Phase-3.d.C close; it survives only as an export consumed by
//     tools/run-nab-validation.ts. So EVERY Family A registry id —
//     including the legacy `mSPRT_*` ids the audit writer actually emits
//     and the reserved `page_cusum_*` forward-compat aliases — is backed by
//     the Ville-bounded mixture-supermartingale at runtime today. This
//     contradicts a still-open drift in README.md's prose (PR #40's
//     "Page-CUSUM co-ship component ... consume[s] classical-epoch-α"
//     bullet describes a pre-Q68 state); this table follows the code, and
//     the docs task tracked separately should reconcile the prose.
//
//   Family B — engine/gates/policy.ts hand-tuned absolute-threshold
//     patterns. No formal test; α is reserved-but-not-spent.
//
//   Family C — engine/detectors/_hotelling-dispatch.ts dispatches
//     `hotelling_variant` per cell: 'chi_square' (classical Wilson-Hilferty
//     χ², the default/fallback) vs 'safe_test' (Grünwald-de Heide-Koolen
//     safe-testing / GROW e-test, Ville). Sequential MMD: the classical
//     bootstrap-null evaluator (`evaluateSequentialMMD`) is retired from
//     runtime dispatch at Q68 close (engine/gates/_health-detectors.ts
//     `runFamilyC` only calls the two Ville-bounded MMD paths — Q67 v2
//     canonical betting-e-process and the Option-B GRAPA/ONS betting
//     e-process). All three live MMD ids are therefore Ville. Registry
//     gap CLOSED (was open when this table was first authored): the Q67
//     v2 canonical evaluator emits `signal: 'sequential_mmd_betting_e_process'`,
//     which used NOT to be a DETECTOR_REGISTRY.C id —
//     engine/_audit-families.ts's unrecognized-signal fallthrough
//     attributed those fires to the legacy `sequential_mmd` id instead of
//     the evaluator's own id. That id is now registered
//     (DETECTOR_REGISTRY.C), so canonical-evaluator fires attribute to
//     `sequential_mmd_betting_e_process` directly; `sequential_mmd` is
//     kept registered as engine/_audit-families.ts's fallback target for
//     any Family-C-MMD verdict whose signal isn't a registered id (no
//     live evaluator produces one today — see its table entry below).
//
//   Family D — engine/detectors/spectral.ts dispatches `spectral_variant`
//     per signal: 'bootstrap_null' (classical quantile test, the
//     default/fallback) vs 'e_detector' (Shin-Ramdas-Rinaldo-2022
//     mixture-prior betting e-process, Ville).
//
//   Family E — engine/detectors/conformal.ts dispatches `ConformalParams.
//     kind`: 'unweighted' / 'weighted' are per-tick recomputed conformal
//     p-value / weighted-quantile threshold tests (no wealth process — not
//     anytime-valid); 'weighted_e_value' (Addition #22) is the Ramdas-Wang
//     + Fedorova hedged-indicator e-value wealth process (Ville). There is
//     only ONE registry id for all three kinds
//     (`mahalanobis_conformal_baseline`) — unlike Families C/D, Family E's
//     registry doesn't split a classical id from a Ville id. This table
//     records the detector's canonical/designed guarantee (Addition #22);
//     tools/build-guarantee-manifest.ts's per-config join reports which
//     `kind` a given compiled config actually selected (the compiler's
//     default 'auto' selector silently falls back to the classical
//     'unweighted' path when the baseline's span/ESS don't clear the
//     weighting-beneficial gate — see tools/calibrators/family-e.ts
//     FAMILY_E_MIN_SPAN_DAYS / FAMILY_E_ESS_THRESHOLD).
//
//   Q70 Phase-3.d.E self-normalized e-process fallback
//     (@johnpatrickwarren-oss/deploysignal-engine/detectors/
//     self-normalized-e-process-fallback) — SLICE 1
//     shipped schema only (`self_normalized_fallback` fields on
//     FamilyCPerCell / FamilyDPerSignal / ConformalParams); calibrator
//     stamping and detector consumption were deferred to SLICE 2, which
//     never landed. It has no DETECTOR_REGISTRY id of its own (it's a
//     fallback variant nested under hotelling_t2_safe / spectral_e_
//     detector_kv_cache / mahalanobis_conformal_baseline), so it can't be
//     a row in this table; it is marked DEPRECATED in the null_assumptions
//     of those three entries and is never surfaced as live by the
//     generator (no runtime path constructs one).

import type { DetectorId, FamilyId } from './types';
import { DETECTOR_REGISTRY } from './types';

export type ValidityClass =
  | 'ville_anytime_valid'
  | 'classical_epoch_alpha'
  | 'heuristic_structural';

export type RepeatedLookPolicy =
  | 'anytime_valid_continuous_peeking'
  | 'epoch_boundaries_only';

export interface DetectorGuarantee {
  readonly detector_id: DetectorId;
  readonly family: FamilyId;
  readonly validity_class: ValidityClass;
  /** Concise null-hypothesis assumptions this detector's α control relies
   *  on. Not exhaustive derivations — pointers for an operator auditing
   *  the claim. */
  readonly null_assumptions: readonly string[];
  readonly repeated_look_policy: RepeatedLookPolicy;
  /** False for Family B (hand-tuned structural thresholds; α reserved but
   *  never spent per the R2 disposition) and true for every A/C/D/E id. */
  readonly alpha_participating: boolean;
  /** Set when this id is the classical/legacy path that a Ville-bounded
   *  sibling id falls back to (or is superseded by). Always a real
   *  DETECTOR_REGISTRY id. */
  readonly fallback_of?: DetectorId;
  /** Short literature anchor. */
  readonly citation: string;
  /** Non-literature caveat about how audit records map onto this id (e.g.
   *  a runtime signal name that doesn't match any DETECTOR_REGISTRY id, so
   *  fires get attributed to a different id than the one that produced
   *  them). Kept separate from `citation` so that field stays a pure
   *  literature anchor. */
  readonly id_mapping_note?: string;
}

const VILLE_POLICY: RepeatedLookPolicy = 'anytime_valid_continuous_peeking';
const EPOCH_POLICY: RepeatedLookPolicy = 'epoch_boundaries_only';

// ── Family A — per-signal change detection ─────────────────────────
//
// Every id below (mSPRT_*, page_cusum_*, betting_e_process_*) is
// Ville-bounded at runtime today; see the file-header note. mSPRT_* is
// what the audit writer actually emits (legacy naming, Addition #17
// aliasing kept for v1-record replay); page_cusum_* is reserved for a
// forward-compat emission-side rename that hasn't landed.

const FAMILY_A_MIXTURE_ASSUMPTIONS = [
  'per-cell mixture prior on the alternative mean shift δ (Gaussian or '
    + 'Beta prior, selected by the signal\'s compiled signal_class)',
  'AR(1) pre-whitened residuals against the compiled baseline mean/σ² '
    + '(Q66.A.b); exchangeable, not required iid, under H0',
] as const;

const FAMILY_A_BETTING_ASSUMPTIONS = [
  'bounded-support standardized deviation z_t = clip((x-μ)/(B·σ), -1, 1), '
    + 'B=3, derived from the compiled per-cell μ/σ²',
  'GRAPA bet with ONS fallback; no operator tunable',
] as const;

function familyAMixtureEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'A',
    validity_class: 'ville_anytime_valid',
    null_assumptions: FAMILY_A_MIXTURE_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Howard, Ramdas, McAuliffe & Sekhon (2021), Annals of Statistics — '
      + 'time-uniform nonparametric confidence sequences (mixture supermartingale)',
  };
}

function familyABettingEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'A',
    validity_class: 'ville_anytime_valid',
    null_assumptions: FAMILY_A_BETTING_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Waudby-Smith & Ramdas (2024) GRAPA + Online Newton Step fallback betting e-process',
  };
}

// ── Family B — structural pattern-matching (heuristic) ─────────────

function familyBEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'B',
    validity_class: 'heuristic_structural',
    null_assumptions: [
      'none — hand-tuned absolute-threshold pattern, not a statistical test',
    ],
    repeated_look_policy: EPOCH_POLICY,
    alpha_participating: false,
    citation: 'R2 disposition: 16 hand-designed structural signatures; '
      + 'no anytime-valid or classical guarantee (empirical sweep only)',
  };
}

// ── Family C — Hotelling T² + Sequential MMD ────────────────────────

const HOTELLING_CHI_SQUARE_ASSUMPTIONS = [
  'joint-Gaussian relative-deviation vector under H0 (Wilson-Hilferty χ² '
    + 'approximation to T² = r^T Σ⁻¹ r)',
  'per-tick recomputed test — no time-uniform correction; requires '
    + 'Bonferroni-style correction across repeated looks',
] as const;

const HOTELLING_SAFE_ASSUMPTIONS = [
  'mixture prior on alternative mean μ ~ N(0, τ²I_p), τ² = shrink_fraction '
    + '· trace(Σ)/p (REPLY-43b)',
  'DEPRECATED fallback available but not runtime-consumed: Q70 §7 '
    + 'EmpiricalProcessLILBound self-normalized e-process variant '
    + '(self_normalized_fallback on FamilyCPerCell) — SLICE 1 shipped '
    + 'schema-only, calibrator stamping + detector consumption never landed',
] as const;

const MMD_ASSUMPTIONS_CANONICAL = [
  'Gaussian-RBF kernel-MMD witness with median-heuristic bandwidth (RFF '
    + 'unbiased estimator when compiled with an rff_seed)',
  'exchangeability of the split-sample baseline vs live window under H0',
] as const;

const MMD_ASSUMPTIONS_OPTION_B = [
  'Gaussian-RBF kernel-distance scalar standardized over a running window, '
    + 'fed through the Family A GRAPA/ONS betting primitives',
  'superseded on any cell that also carries Q67 v2 betting_e_process_params '
    + '(resolveEMmdParams self-suppresses; the canonical evaluator owns the cell)',
] as const;

// ── Family D — spectral ACF oscillation detector ────────────────────

const SPECTRAL_BOOTSTRAP_ASSUMPTIONS = [
  'peak|ACF| under H0 has the compile-time bootstrap null distribution '
    + '(iid resample of healthy baseline windows)',
  'per-tick recomputed quantile test — no time-uniform correction',
] as const;

const SPECTRAL_E_DETECTOR_ASSUMPTIONS = [
  'peak|ACF| under H0 is Gaussian with compiled null mean/std (μ0, σ0); '
    + 'mixture-prior shift magnitude δ_D = 0.3·σ0 (Addition #21 D4)',
  'DEPRECATED fallback available but not runtime-consumed: Q70 §7 '
    + 'EmpiricalProcessLILBound self-normalized e-process variant '
    + '(self_normalized_fallback on FamilyDPerSignal) — SLICE 1 shipped '
    + 'schema-only, never wired to the detector',
] as const;

// ── Family E — weighted-conformal Mahalanobis novelty ───────────────

const CONFORMAL_ASSUMPTIONS = [
  'exchangeability of calibration scores (parametric-Gaussian-bootstrap '
    + 'Mahalanobis norms under the compiled per-cell Σ) with the live score',
  'this classification assumes the compiled cell selected '
    + "ConformalParams.kind === 'weighted_e_value' (Addition #22 hedged-"
    + "indicator e-value wealth process). kind 'unweighted' / 'weighted' "
    + 'are classical per-tick conformal p-value / weighted-quantile '
    + 'threshold tests with no wealth process — NOT anytime-valid. The '
    + "compiler's default 'auto' variant selector silently falls back to "
    + "'unweighted' when baseline span < FAMILY_E_MIN_SPAN_DAYS(7) or "
    + 'expected/observed ESS < FAMILY_E_ESS_THRESHOLD(0.9)·M — check the '
    + 'generated manifest\'s families.E section for what a given config '
    + 'actually selected, not this table alone',
  'DEPRECATED fallback available but not runtime-consumed: Q70 §6/§7 '
    + 'self-normalized e-process variant (self_normalized_fallback on '
    + 'ConformalParams) — SLICE 1 shipped schema-only, never wired to the detector',
] as const;

export const DETECTOR_GUARANTEES: Record<DetectorId, DetectorGuarantee> = {
  // Family A — legacy mSPRT_* ids (what the audit writer actually emits).
  mSPRT_p99_latency: familyAMixtureEntry('mSPRT_p99_latency'),
  mSPRT_ttft: familyAMixtureEntry('mSPRT_ttft'),
  mSPRT_eval_score: familyAMixtureEntry('mSPRT_eval_score'),
  mSPRT_tool_success_rate: familyAMixtureEntry('mSPRT_tool_success_rate'),
  mSPRT_downstream_err: familyAMixtureEntry('mSPRT_downstream_err'),
  mSPRT_cost_req: familyAMixtureEntry('mSPRT_cost_req'),

  // Family A — page_cusum_* forward-compat aliases (reserved; not yet
  // emitted by the audit writer — see engine/types/audit.ts registry
  // comment). Same runtime binding as mSPRT_* once the emission-side
  // rename lands, so the guarantee is identical.
  page_cusum_p99_latency: familyAMixtureEntry('page_cusum_p99_latency'),
  page_cusum_ttft: familyAMixtureEntry('page_cusum_ttft'),
  page_cusum_eval_score: familyAMixtureEntry('page_cusum_eval_score'),
  page_cusum_tool_success_rate: familyAMixtureEntry('page_cusum_tool_success_rate'),
  page_cusum_downstream_err: familyAMixtureEntry('page_cusum_downstream_err'),
  page_cusum_cost_req: familyAMixtureEntry('page_cusum_cost_req'),

  // Family A — betting e-process co-ship (Addition #17).
  betting_e_process_p99_latency: familyABettingEntry('betting_e_process_p99_latency'),
  betting_e_process_ttft: familyABettingEntry('betting_e_process_ttft'),
  betting_e_process_eval_score: familyABettingEntry('betting_e_process_eval_score'),
  betting_e_process_tool_success_rate: familyABettingEntry('betting_e_process_tool_success_rate'),
  betting_e_process_downstream_err: familyABettingEntry('betting_e_process_downstream_err'),
  betting_e_process_cost_req: familyABettingEntry('betting_e_process_cost_req'),

  // Family B — structural pattern-matching.
  kv_saturation: familyBEntry('kv_saturation'),
  hbm_elevation: familyBEntry('hbm_elevation'),
  hbm_spill_roll: familyBEntry('hbm_spill_roll'),
  mfu_collapse: familyBEntry('mfu_collapse'),
  slowbleed: familyBEntry('slowbleed'),
  collective: familyBEntry('collective'),
  capacity: familyBEntry('capacity'),
  gpu_eff: familyBEntry('gpu_eff'),
  compound_lat: familyBEntry('compound_lat'),
  tok_econ: familyBEntry('tok_econ'),
  behavioral: familyBEntry('behavioral'),
  eval_quality_drop: familyBEntry('eval_quality_drop'),
  refusal_spike: familyBEntry('refusal_spike'),
  output_len_drift: familyBEntry('output_len_drift'),
  tool_call_degradation: familyBEntry('tool_call_degradation'),
  quality_warning: familyBEntry('quality_warning'),

  // Family C — Hotelling T² (chi_square classical default / safe_test Ville).
  hotelling_t2_joint_vector: {
    detector_id: 'hotelling_t2_joint_vector',
    family: 'C',
    validity_class: 'classical_epoch_alpha',
    null_assumptions: HOTELLING_CHI_SQUARE_ASSUMPTIONS,
    repeated_look_policy: EPOCH_POLICY,
    alpha_participating: true,
    fallback_of: 'hotelling_t2_safe',
    citation: 'Hotelling (1931) T²; Wilson-Hilferty (1931) χ² approximation',
  },
  hotelling_t2_safe: {
    detector_id: 'hotelling_t2_safe',
    family: 'C',
    validity_class: 'ville_anytime_valid',
    null_assumptions: HOTELLING_SAFE_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Grünwald, de Heide & Koolen (2024), JASA — safe testing / GROW e-test',
  },

  // Family C — Sequential MMD. All three live-registered ids are Ville
  // (classical bootstrap-null retired at Q68 close); see file header for
  // the sequential_mmd id-mapping finding and its resolution.
  sequential_mmd: {
    detector_id: 'sequential_mmd',
    family: 'C',
    validity_class: 'ville_anytime_valid',
    null_assumptions: MMD_ASSUMPTIONS_CANONICAL,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Shekhar & Ramdas (2023) canonical ONS kernel-MMD betting e-process',
    id_mapping_note: 'Dormant for live attribution as of the '
      + "sequential_mmd_betting_e_process registration: the Q67 v2 canonical "
      + "evaluator now emits its OWN registered DETECTOR_REGISTRY.C id "
      + "('sequential_mmd_betting_e_process'), and engine/_audit-families.ts's "
      + "registry-membership check routes those fires there directly — no "
      + 'longer through this id. This id remains registered as '
      + "resolveDetectorId('family_C_mmd')'s fallback target for any "
      + 'Family-C-MMD verdict whose signal is absent or not a registered id '
      + '(no live evaluator produces one today; kept for v1-record replay '
      + 'and any future variant that has not yet registered its own id).',
  },
  sequential_mmd_e_process: {
    detector_id: 'sequential_mmd_e_process',
    family: 'C',
    validity_class: 'ville_anytime_valid',
    null_assumptions: MMD_ASSUMPTIONS_OPTION_B,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Addition #20 Option-B simplification of Shekhar & Ramdas (2023) via '
      + 'REPLY-34 GRAPA/ONS betting primitives',
  },
  // Q67 v2 canonical betting-e-process (Addition #20) — engine/detectors/
  // _family-c-betting-eval.ts evaluateFamilyCBettingEProcess. Registered
  // to close the id-mapping gap documented in the file header and in
  // sequential_mmd.id_mapping_note above: this evaluator always emitted
  // `signal: 'sequential_mmd_betting_e_process'`, but until this id was
  // added to DETECTOR_REGISTRY.C, engine/_audit-families.ts had nothing
  // to route it to and fell back to the legacy `sequential_mmd` id.
  sequential_mmd_betting_e_process: {
    detector_id: 'sequential_mmd_betting_e_process',
    family: 'C',
    validity_class: 'ville_anytime_valid',
    null_assumptions: MMD_ASSUMPTIONS_CANONICAL,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Shekhar & Ramdas (2023) canonical ONS kernel-MMD betting e-process',
  },

  // Family D — spectral ACF (bootstrap_null classical default / e_detector Ville).
  spectral_peak_acf_kv_cache: {
    detector_id: 'spectral_peak_acf_kv_cache',
    family: 'D',
    validity_class: 'classical_epoch_alpha',
    null_assumptions: SPECTRAL_BOOTSTRAP_ASSUMPTIONS,
    repeated_look_policy: EPOCH_POLICY,
    alpha_participating: true,
    fallback_of: 'spectral_e_detector_kv_cache',
    citation: 'Box-Jenkins ACF peak detection over a compile-time bootstrap null',
  },
  spectral_e_detector_kv_cache: {
    detector_id: 'spectral_e_detector_kv_cache',
    family: 'D',
    validity_class: 'ville_anytime_valid',
    null_assumptions: SPECTRAL_E_DETECTOR_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Shin, Ramdas & Rinaldo (2022) — mixture-prior betting e-process, scalar form',
  },

  // Family E — weighted-conformal Mahalanobis novelty. See
  // CONFORMAL_ASSUMPTIONS for the kind-dependence caveat.
  mahalanobis_conformal_baseline: {
    detector_id: 'mahalanobis_conformal_baseline',
    family: 'E',
    validity_class: 'ville_anytime_valid',
    null_assumptions: CONFORMAL_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    citation: 'Ramdas-Wang + Fedorova hedged-indicator e-value (Addition #22 / REPLY-46b), '
      + 'built on Tibshirani/Foygel-Barber/Candès/Ramdas (2019) weighted conformal',
  },
};

/** Runtime cross-check that every DETECTOR_REGISTRY id has a table entry
 *  (the `Record<DetectorId, ...>` annotation above already enforces this
 *  at compile time; this helper lets callers — and tests — assert it
 *  without relying on `tsc` having run). Returns the list of registry ids
 *  missing a table entry (empty when exhaustive). */
export function missingGuaranteeEntries(): DetectorId[] {
  const missing: DetectorId[] = [];
  for (const ids of Object.values(DETECTOR_REGISTRY)) {
    for (const id of ids as readonly DetectorId[]) {
      if (DETECTOR_GUARANTEES[id] === undefined) missing.push(id);
    }
  }
  return missing;
}

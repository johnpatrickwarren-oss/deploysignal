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

/** Family E is ADVISORY — WORKLIST C25, ruling knowledge/stats/family-e-budget-ruling
 *  option 3 (operator, 2026-09-02). The shipped `unweighted` kind is a per-tick
 *  parametric-bootstrap p-value whose super-uniformity under H0 is unestablished and
 *  which has no epoch guard, so it may not draw on the union-bound α budget. While
 *  this is true a Family E `fire` is recorded (evidence_outlook, audit record) but
 *  never enters `firing_families` (engine/verdict.ts) or the health gate's
 *  `rollback[]` (engine/gates/_health-detectors.ts), and its verdict books
 *  `alpha_spent: 0`. Keyed on this constant, not on the compiled α, so behaviour is
 *  identical whether a config carries E at 0 or at a legacy 1e-4.
 *
 *  Reversal is this one constant plus the profile budgets, gated on the two premises
 *  the ruling names: a registered coverage study of the conformal p against held-out
 *  scores (super-uniformity), and an epoch guard on the classical block. */
export const FAMILY_E_ADVISORY = true;

/** C62 (b), engine ADR 0030 — the false-coverage level at which the fused verdict reports e-BY
 *  effect-size intervals for the Family A mixture signals that fired this tick. Each selected
 *  signal's interval is read at `E_BY_DELTA·|S|/K` (K = the mixture signals evaluated, S = the
 *  fired, non-advisory ones), and Ramdas–Wang 2025 Theorem 13.7 gives FCR ≤ E_BY_DELTA under any
 *  selection rule and any dependence, provided the mixture's own construction premise holds.
 *  REPORTED, no verdict authority; a constant rather than a profile knob because nothing reads
 *  it but the report (engine study 2026-09-e-by-fcr: FCR at most 0.27·δ at δ = 0.05 on Gaussian
 *  signals, and under 0.04·δ except where every selected signal is a false fire read at its own
 *  fire tick). Under an ESTIMATED baseline the interval covers the shift from the estimate
 *  (engine study 2026-09-mixture-cs P3/P4), at this level as at every level. */
export const E_BY_DELTA = 0.05;

/** C64 (b), 2026-09-03 — the Family A plug-ins (mixture supermartingale, betting e-process)
 *  are ADVISORY on a signal the envelope-valid terminal path is routed for
 *  (`OrchestrateParams.validPath`, engine/gates/_health-valid-path.ts), and α-participating
 *  as before on every other signal. Registered ship rule of the C64 (d) power study
 *  (knowledge stats/valid-path-power-2026-09-03): (b) demotes only where (a) routes. An
 *  advisory plug-in fire keeps its verdict / statistic / evidence for evidence_outlook and
 *  the audit record, books `alpha_spent: 0`, carries reason_code `advisory_valid_path_routed`,
 *  and never enters `rollback[]` or `firing_families`. The plug-ins' estimation premise is
 *  false in the shipped configuration (E[e|H0] → ~1e8 / ~3e9, engine
 *  detectors/validity-envelope.ts); what they are under H0 is the `approximate_e_value` form
 *  each Family A row carries below, mirrored from the engine's axis 3 (C61). */
export const FAMILY_A_PLUGIN_ADVISORY: 'when_valid_path_routed' | 'never' = 'when_valid_path_routed';

/** reason_code an advisory plug-in fire carries (C64 b). */
export const FAMILY_A_PLUGIN_ADVISORY_REASON = 'advisory_valid_path_routed';

/** Is the Family A plug-in verdict for `signal` advisory this tick? True iff the valid path
 *  is routed for that signal and the flag is on. */
export function familyAPluginAdvisory(signal: string | undefined, routed: ReadonlySet<string> | undefined): boolean {
  return FAMILY_A_PLUGIN_ADVISORY === 'when_valid_path_routed' && !!signal && !!routed?.has(signal);
}

/** Axis 3 (Ramdas–Wang 2025 Def. 10.1), mirrored from the engine's `guarantees.ts` for the
 *  three Family A constructions this repo dispatches. `epsilon_growing` means no constant
 *  prices the statistic as an e-value: `E/(1+ε_T)` is one only at a stated horizon. */
export type ApproximateEValueForm =
  | { readonly form: 'e_value'; readonly note: string }
  | { readonly form: 'epsilon_growing'; readonly law: string; readonly kappa?: number; readonly source: string }
  | { readonly form: 'not_e_value'; readonly reason: string };

export type ValidityClass =
  | 'ville_anytime_valid'
  | 'classical_epoch_alpha'
  | 'heuristic_structural'
  /** C64 (a), 2026-09-03 — a genuine e-value read at ONE pre-scheduled look (the end of the
   *  canary): P(e ≥ 1/α) ≤ α by Markov, valid at data-dependent α (Ramdas–Wang 2025
   *  Prop. 4.4), and NOT an e-process — repeated looks are not licensed, which is why its
   *  policy is `epoch_boundaries_only`. Mirrors the engine's `e_value_terminal`. */
  | 'e_value_terminal'
  /** C64 (c), 2026-09-03 — the SHIPPED threshold is an empirical (1−α) quantile of max wealth
   *  under a joint-AR(1) bootstrap null over a fixed horizon (Q2.B.6.2/6.3 `sliding_buffer`
   *  calibration), in place of Ville's 1/α. That controls the CROSSING RATE at the calibrated
   *  horizon under the bootstrap's null — the smallest valid threshold on an unstated class
   *  (Ramdas–Wang 2025 Lemma 15.1) — and bounds no expectation: the statistic is not an
   *  e-value on the shipped path, and the threshold sits a median 2.4×10⁴ (Family A betting)
   *  / 3.6×10⁷⁶ (safe-Hotelling) ABOVE 1/α with a measured power cost (knowledge
   *  stats/ville-guarantee-is-empirical; stats/valid-path-power-2026-09-03 E3: 0.29 at 1.5σ,
   *  0.80 at 1.0σ). The construction at 1/α is Ville-valid inside its envelope (engine
   *  guarantees.ts); this class describes what DeploySignal compiles and runs. */
  | 'bootstrap_crossing_rate';

export type RepeatedLookPolicy =
  | 'anytime_valid_continuous_peeking'
  | 'epoch_boundaries_only'
  /** C64 (c) — peeks every tick; the crossing rate is controlled only within the bootstrap's
   *  calibrated horizon (500 trajectories × 100 ticks) and under its null. Not anytime-valid. */
  | 'bootstrap_horizon_peeking';

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
  /** C64 (b) — the (ε, δ)-approximate e-value form under H0 in the shipped configuration.
   *  Carried on the Family A rows and projected onto `evidence_outlook`; absent elsewhere
   *  (the engine's table is the authority for every row). */
  readonly approximate_e_value?: ApproximateEValueForm;
  /** Non-literature caveat about how audit records map onto this id (e.g.
   *  a runtime signal name that doesn't match any DETECTOR_REGISTRY id, so
   *  fires get attributed to a different id than the one that produced
   *  them). Kept separate from `citation` so that field stays a pure
   *  literature anchor. */
  readonly id_mapping_note?: string;
}

const VILLE_POLICY: RepeatedLookPolicy = 'anytime_valid_continuous_peeking';
const EPOCH_POLICY: RepeatedLookPolicy = 'epoch_boundaries_only';
const BOOTSTRAP_POLICY: RepeatedLookPolicy = 'bootstrap_horizon_peeking';

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
  // C64 (c): the threshold that ships.
  'fire threshold = compiled `betting_sliding_buffer_threshold`, the empirical (1−α) quantile of '
    + 'per-trajectory MAX wealth under the joint-AR(1) bootstrap (500 × 100 ticks; tools/calibrators/'
    + 'family-a.ts), not 1/α: a crossing-rate control at that horizon under that null, no e-value '
    + 'bound (median 2.41×10⁴ above 1/α over 82,888 compiled cells; 3.1% of cells below it)',
] as const;

/** Mirrors engine guarantees.ts (C61) — the mixture's plug-in law. */
const MIXTURE_APPROXIMATE_E_VALUE: ApproximateEValueForm = {
  form: 'epsilon_growing',
  law: 'E[M_n|H0] under an m-sample plug-in baseline grows without bound in n (engine '
    + 'validity-envelope.ts: ~3e9 at n >> m); the per-tick rate is unmeasured for the mixture. '
    + 'Exact at oracle parameters (H0 battery N1 CLEARED).',
  source: 'Tessera ADR 0014; knowledge stats/validity-premise-chain; detector-audit-sequential-2026-08-05',
};
/** Mirrors engine guarantees.ts (C61) — the betting e-process's measured law. */
const BETTING_APPROXIMATE_E_VALUE: ApproximateEValueForm = {
  form: 'epsilon_growing',
  law: 'per-tick increment excess kappa/m under an m-sample calibration (the GRAPA loop '
    + 'converges on the calibration bias), so epsilon_T = exp(kappa·T/m) − 1: unbounded in T. '
    + 'Measured 1.029 / 1.009 / 1.002 per tick at m = 30 / 100 / 500; exact at oracle parameters.',
  kappa: 0.8445,
  source: 'engine grapa-stability run-20260819T040000Z (C58); detector-audit-sequential-2026-08-05 (C23)',
};
/** The terminal safe-t path (C64 a): a genuine e-value at known φ. */
const SAFE_T_APPROXIMATE_E_VALUE: ApproximateEValueForm = {
  form: 'e_value',
  note: 'sigma integrated out exactly: E[e|H0] = 1 at every calibration length with known phi; '
    + 'outside the envelope (estimated phi = 0.9 from 100 samples) mean(e) = 9,710 '
    + '(knowledge stats/terminal-evalue-2026-08-02).',
};

function familyAMixtureEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'A',
    validity_class: 'ville_anytime_valid',
    null_assumptions: FAMILY_A_MIXTURE_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    alpha_participating: true,
    approximate_e_value: MIXTURE_APPROXIMATE_E_VALUE,
    citation: 'Howard, Ramdas, McAuliffe & Sekhon (2021), Annals of Statistics — '
      + 'time-uniform nonparametric confidence sequences (mixture supermartingale)',
  };
}

/** C64 (a) — the envelope-valid terminal path: the safe two-sample t e-value at known φ,
 *  read once per signal at the canary's end (engine/gates/_health-valid-path.ts). Ship rule of
 *  the C64 (d) power study (studies/valid-path-power, run 2026-09-03T18182Z): 1.0000 at the K1
 *  canonical 1.5σ, 0/524 null crossings at α = 0.05, exactly scale-invariant. */
const FAMILY_A_SAFE_T_ASSUMPTIONS = [
  'two-sample t on AR(1)-whitened residuals (calibration series vs the full canary), the '
    + 'common mean and the common innovation variance integrated out (right-Haar / GROW)',
  'known φ supplied by the caller, or the compiled cell φ̂ with calibration ≥ 100 (ADR 0005: '
    + 'the e-BH-relevant E[e|H0] ≤ 1 needs cal ≳ 100 under an estimated φ); maxPhiValid 0.95',
  'one look per canary: P(e ≥ 1/α) ≤ α by Markov; a fixed-time e-value, not an e-process',
] as const;

function familyASafeTEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'A',
    validity_class: 'e_value_terminal',
    null_assumptions: FAMILY_A_SAFE_T_ASSUMPTIONS,
    repeated_look_policy: EPOCH_POLICY,
    alpha_participating: true,
    approximate_e_value: SAFE_T_APPROXIMATE_E_VALUE,
    citation: 'Pérez-Ortiz, Lardy, de Heide & Grünwald (2024) GROW e-statistics for the '
      + 'location-scale model; engine ADR 0005 (safe-t e-value); Ramdas & Wang (2025) Prop. 4.4',
    id_mapping_note: 'runtime rollback id is `family_A_safe_t_{signal}`; the audit writer maps it '
      + 'to this registry id (engine ≥ v0.6.10-pre). Inert unless the caller supplies '
      + '`OrchestrateParams.validPath` (C64 a).',
  };
}

function familyABettingEntry(id: DetectorId): DetectorGuarantee {
  return {
    detector_id: id,
    family: 'A',
    // C64 (c): was ville_anytime_valid. The construction is Ville-valid at 1/α inside its
    // envelope; what ships compares wealth to a bootstrap quantile (see the class doc).
    validity_class: 'bootstrap_crossing_rate',
    null_assumptions: FAMILY_A_BETTING_ASSUMPTIONS,
    repeated_look_policy: BOOTSTRAP_POLICY,
    alpha_participating: true,
    approximate_e_value: BETTING_APPROXIMATE_E_VALUE,
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
  // C64 (c): the threshold that ships.
  'fire threshold = compiled `sliding_buffer_threshold` (types/families/c.ts: "replaces the '
    + 'analytical 1/α threshold"), the empirical (1−α) quantile of per-trajectory MAX wealth under '
    + 'the joint-AR(1) bootstrap with sliding-buffer evaluation: a crossing-rate control at that '
    + 'horizon, no e-value bound (median 3.6×10⁷⁶ above 1/α over 34,481 compiled cells)',
  'DEPRECATED fallback available but not runtime-consumed: Q70 §7 '
    + 'EmpiricalProcessLILBound self-normalized e-process variant '
    + '(self_normalized_fallback on FamilyCPerCell) — SLICE 1 shipped '
    + 'schema-only, calibrator stamping + detector consumption never landed',
] as const;

const MMD_ASSUMPTIONS_CANONICAL = [
  'Gaussian-RBF kernel-MMD witness with median-heuristic bandwidth (RFF '
    + 'unbiased estimator when compiled with an rff_seed)',
  'the compiled per-cell parametric-Gaussian reference pool is an adequate H0 model of the '
    + 'live window (the P-side arm is SYNTHESIZED from the compiled covariance — '
    + 'engine sequential-mmd.ts "synthesized P-side pool" — no real baseline sample is split; '
    + 'wording corrected 2026-08-03, was "exchangeability of the split-sample baseline")',
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
  'MEASURED VIOLATED 2026-08-01 — both stated assumptions fail, and the '
    + 'detector is reclassified heuristic_structural as a result. See '
    + 'knowledge/stats/h0-battery-2026-08-01. (a) peak|ACF| is a max of |r(k)| '
    + 'over lags 3-10: bounded in [0,1] and right-skewed (measured skew +0.49), '
    + 'not Gaussian; z_t = r·u − ½r² is an exact e-value increment only for '
    + 'u ~ N(0,1). Costs ~1.0023 per independent draw. (b) production evaluates '
    + 'every tick on a ROLLING 30-sample window (engine/gates/_health-detectors.ts), '
    + 'so successive peaks share 29 of 30 samples, u_t is nearly F_{t-1}-measurable, '
    + 'and the martingale-difference condition fails. Integrated autocorrelation '
    + 'time ~12. Measured false-alarm rate 0.576 against a nominal 0.05, with '
    + 'ORACLE parameters and iid Gaussian data — this is the construction, not '
    + 'estimation error. Evaluated on DISJOINT windows the same detector on the '
    + 'same data measures 0.0005, so the overlap is the whole of it.',
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

  // Family A — the envelope-valid terminal path (C64 a; engine v0.6.10-pre registry ids).
  safe_t_e_value_p99_latency: familyASafeTEntry('safe_t_e_value_p99_latency'),
  safe_t_e_value_ttft: familyASafeTEntry('safe_t_e_value_ttft'),
  safe_t_e_value_eval_score: familyASafeTEntry('safe_t_e_value_eval_score'),
  safe_t_e_value_tool_success_rate: familyASafeTEntry('safe_t_e_value_tool_success_rate'),
  safe_t_e_value_downstream_err: familyASafeTEntry('safe_t_e_value_downstream_err'),
  safe_t_e_value_cost_req: familyASafeTEntry('safe_t_e_value_cost_req'),

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
    // C64 (c): was ville_anytime_valid — the shipped threshold is the bootstrap quantile.
    validity_class: 'bootstrap_crossing_rate',
    null_assumptions: HOTELLING_SAFE_ASSUMPTIONS,
    repeated_look_policy: BOOTSTRAP_POLICY,
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
    // 2026-08-02: was ville_anytime_valid / alpha_participating: true. Reclassified because the
    // Ville premise is measured false in the shipped configuration (see the assumptions above).
    // The detector is kept — it may still carry signal about oscillation, which is what it is for
    // — but it no longer makes an anytime-valid claim and no longer consumes alpha, so the budget
    // returns to families whose premises hold.
    validity_class: 'heuristic_structural',
    null_assumptions: SPECTRAL_E_DETECTOR_ASSUMPTIONS,
    repeated_look_policy: EPOCH_POLICY,
    alpha_participating: false,
    citation: 'Shin, Ramdas & Rinaldo (2022) — mixture-prior betting e-process, scalar form. '
      + 'NOTE: what ships is a single wealth process against a POINT null with one shift; it is '
      + 'not the paper\'s e-detector construction, which sums e-processes over candidate onsets '
      + 'and bounds E[tau]. See knowledge/stats/e-detector.',
  },

  // Family E — weighted-conformal Mahalanobis novelty. See
  // CONFORMAL_ASSUMPTIONS for the kind-dependence caveat.
  mahalanobis_conformal_baseline: {
    detector_id: 'mahalanobis_conformal_baseline',
    family: 'E',
    validity_class: 'ville_anytime_valid',
    null_assumptions: CONFORMAL_ASSUMPTIONS,
    repeated_look_policy: VILLE_POLICY,
    // 2026-09-02: was alpha_participating: true. WORKLIST C25 — the kind that ships
    // (unweighted, 840/840 cells in every committed manifest) is a p-value with an
    // unestablished super-uniformity premise and no epoch guard; the ruling
    // (knowledge/stats/family-e-budget-ruling, option 3) zeroes its budget and makes
    // the family advisory (FAMILY_E_ADVISORY above). The detector is kept.
    alpha_participating: false,
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

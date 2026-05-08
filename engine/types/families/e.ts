// engine/types/families/e.ts — Family E (conformal novelty).

import type { SelfNormalizedEProcessFallback } from '../self-normalized-fallback';

/** Per-cell Family E conformal nonconformity state.
 *
 *  Addition #19 (ARCHITECT-REPLY-35) — discriminated union so the runtime
 *  can switch on `.kind`:
 *
 *  - `{ kind: 'unweighted' }` (or legacy shape with `kind` omitted):
 *    parametric Gaussian bootstrap of Mahalanobis norms under `N(0, Σ)`.
 *    Query's score is ranked against `calibration_scores` via a standard
 *    conformal p-value; fire when `p < α_family_E`. Pre-#19 config files
 *    and inline fixtures omit `kind` — they parse as this variant.
 *
 *  - `{ kind: 'weighted' }`: emitted by the #19 compiler pipeline. The
 *    bootstrap scores carry per-sample weights via a time-decay
 *    exponential (default half-life `min(baseline-age-span / 2, 14)` days
 *    per D3, operator override via `CompilerOptions.family_e_halflife_days`).
 *    Fire threshold is the `(1 − α_family_E)`-th weighted quantile of
 *    `scores` under `weights`; fire when the live Mahalanobis score
 *    exceeds that threshold. `effective_sample_size = (Σw)² / Σw²` is
 *    carried on the struct for audit visibility; the compiler warns when
 *    ESS drops below `0.7 · M_bootstrap` (over-aggressive decay).
 *
 *  Piggybacks on `BaselineCellEntry.family_C.{mean_vector, covariance}`.
 *  Robust covariance (MCD/MRCD) from Addition #18 is inherited via the
 *  shared Family C per-cell struct — Family E does not derive its own Σ. */
export type ConformalParams =
  | {
      kind?: 'unweighted';
      calibration_scores: number[];
      calibration_method?: 'parametric_gaussian_bootstrap';
      /** Q70 Phase-3.d.E — self-normalized e-process variant fallback
       *  (family_E_conformal). §6 BetaBinomial preferred for
       *  bounded_probability signals (Q70.4 ASK B); §7 LIL otherwise.
       *  ADDITIVE optional (sub-rule 2 MERGE); SLICE 1 schema only. */
      self_normalized_fallback?: SelfNormalizedEProcessFallback;
    }
  | {
      kind: 'weighted';
      /** Bootstrap Mahalanobis scores; sorted ascending. */
      scores: number[];
      /** Per-sample weights aligned with `scores` (time-decay exponential). */
      weights: number[];
      /** Half-life of the decay in days (`λ = log(2) / halflife_days`). */
      halflife_days: number;
      /** `(Σw)² / Σw²` — audit-visible ESS of the weighted calibration set. */
      effective_sample_size: number;
      calibration_method?: 'weighted_parametric_gaussian_bootstrap';
      /** Q70 Phase-3.d.E — self-normalized fallback (see ConformalParams
       *  unweighted-variant comment). ADDITIVE optional. */
      self_normalized_fallback?: SelfNormalizedEProcessFallback;
    }
  | {
      /** Addition #22 (ARCHITECT-REPLY-46 D3) — weighted e-value variant
       *  that replaces the per-tick weighted-quantile threshold test with
       *  a Ramdas-Wang + Fedorova indicator-based e-value wealth process.
       *  Fires at `M_t ≥ 1/α_E = 10,000` under Ville's inequality;
       *  anytime-valid time-uniform α control (parallels Family A/C/D
       *  e-process substrates). */
      kind: 'weighted_e_value';
      /** Bootstrap Mahalanobis scores, sorted ascending (required for
       *  O(log M) binary-search rank at query time). */
      scores: number[];
      /** Per-sample weights aligned with `scores` (ordered by ascending
       *  score post-sort — must not be independently sorted). */
      weights: number[];
      /** Reverse-cumulative weight sum: `cumulative_weights_above[k] =
       *  Σ_{i ≥ k} weights[i]`. Length equals `scores.length`; element 0
       *  equals `total_weight`. Precomputed at compile time so runtime
       *  e-value lookup is O(1) after O(log M) binary-search rank. */
      cumulative_weights_above: number[];
      /** `Σ weights`. Preserved separately (rather than recomputed from
       *  `cumulative_weights_above[0]`) for audit-replay robustness and
       *  the epsilon-floor derivation `ε = total_weight / (M+1)`. */
      total_weight: number;
      /** Half-life of the decay in days — same semantic as the
       *  `'weighted'` variant; preserved so audit consumers can
       *  reconstruct the weighting scheme. */
      halflife_days: number;
      /** ESS of the weighted calibration set — same semantic as the
       *  `'weighted'` variant. */
      effective_sample_size: number;
      calibration_method?: 'weighted_parametric_gaussian_bootstrap_e_value';
      /** Q70 Phase-3.d.E — self-normalized fallback (see ConformalParams
       *  unweighted-variant comment). §6 BetaBinomial pairs naturally with
       *  the weighted-e-value wealth process for bounded_probability
       *  signals. ADDITIVE optional. */
      self_normalized_fallback?: SelfNormalizedEProcessFallback;
    };

/** Type guard: true iff `p` is the Addition #19 weighted variant. */
export function isWeightedConformal(
  p: ConformalParams,
): p is Extract<ConformalParams, { kind: 'weighted' }> {
  return (p as { kind?: string }).kind === 'weighted';
}

/** Type guard: true iff `p` is the Addition #22 weighted-e-value variant. */
export function isWeightedEValueConformal(
  p: ConformalParams,
): p is Extract<ConformalParams, { kind: 'weighted_e_value' }> {
  return (p as { kind?: string }).kind === 'weighted_e_value';
}

/** Addition #22 (ARCHITECT-REPLY-46 D3) — per-(deploy, cell) Family E
 *  weighted-e-value wealth state. `M` is the wealth martingale
 *  (multiplicative), `alphaConsumed` tracks α spend across fires.
 *  Parallels the Addition #20 SafeHotellingState / Addition #21
 *  SpectralEDetectorState shape — same {M, n, alphaConsumed} triad. */
export interface ConformalEValueState {
  M: number;
  n: number;
  alphaConsumed: number;
}

/** Sample count across all variants of `ConformalParams`. Used by the
 *  detector's underpowered guard and by tests that want a variant-
 *  agnostic size. */
export function conformalSampleCount(p: ConformalParams): number {
  if (isWeightedConformal(p) || isWeightedEValueConformal(p)) return p.scores.length;
  return p.calibration_scores.length;
}

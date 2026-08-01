// engine/detectors/_hotelling-safe.ts — Addition #20 safe-Hotelling
// e-process (ARCHITECT-REPLY-43). Extracted VERBATIM from
// engine/detectors/hotelling.ts (god-file split). No behavior change.
//
// Mixture-prior growth-optimal e-test for the composite-Gaussian-mean
// null, per Grünwald-de Heide-Koolen 2024. Co-ships alongside the
// legacy chi_square variant; selection by `cell.hotelling_variant`.
// Wealth update `M_t = M_{t-1} · exp(z_t)` with z_t derived from the
// log-likelihood ratio under μ ~ N(0, τ²I_p) prior on the alternative.
// Anytime-valid under Ville's inequality: fire at `M_t ≥ 1/α`.

import type { DetectorVerdict, FamilyCPerCell, SafeHotellingState } from '../types';
import { cholesky, forwardSolve } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_linalg';

/** Fresh wealth state for a new (deploy, cell) safe-Hotelling evaluation.
 *  `M₀ = 1` is the Ville-inequality convention (log-wealth starts at 0). */
export function freshSafeHotellingState(): SafeHotellingState {
  return { M: 1, n: 0, alphaConsumed: 0 };
}

/** Addition #20 (ARCHITECT-REPLY-43 D4) — safe-Hotelling per-tick
 *  evaluation against a cell with populated `safe_hotelling_params`.
 *  The caller owns the state object; this function mutates `state.M` /
 *  `state.n` / `state.alphaConsumed` in place.
 *
 *  Formula (z_t derived inline for future auditors):
 *    Multivariate-Gaussian log-density under null N(0, Σ):
 *      log p₀(x) = -(p/2) log(2π) - ½ log det(Σ) - ½ xᵀ Σ⁻¹ x
 *    Marginal under alternative prior μ ~ N(0, τ²I_p):
 *      p_A(x) = ∫ N(x | μ, Σ) · N(μ | 0, τ²I) dμ = N(x | 0, Σ + τ²I)
 *      log p_A(x) = -(p/2) log(2π) - ½ log det(Σ+τ²I) - ½ xᵀ (Σ+τ²I)⁻¹ x
 *    Log-likelihood ratio:
 *      z_t = log p_A(x) - log p₀(x)
 *          = -½ [log det(Σ+τ²I) - log det(Σ)]
 *            + ½ xᵀ Σ⁻¹ x
 *            - ½ xᵀ (Σ+τ²I)⁻¹ x
 *          = -precompiled_log_det_shrink + ½ xᵀ Σ⁻¹ x - ½ xᵀ (Σ+τ²I)⁻¹ x
 *    M_t = M_{t-1} · exp(z_t); fire when M_t ≥ 1/alpha.
 *
 *  Practice-5 anchors (healthy p=11 cell, τ²≈δ_min²/4):
 *    - Healthy x near zero:        z_t ≈ -0.055, M drifts ~0.946×/tick.
 *    - Drifted x = [3σ, 3σ, 0, …]: z_t ≈  0.445, M grows   ~1.56×/tick.
 *    - Fire horizon on moderate shift: ~log(1/α)/z_t ≈ 9.2/0.445 ≈ 20 ticks.
 */
export function evaluateSafeHotelling(
  input: {
    cell: FamilyCPerCell;
    alpha: number;
  },
  x: number[],
  state: SafeHotellingState,
): DetectorVerdict {
  // Q2.B.6.2 — sliding-buffer-aware wealth threshold under joint AR(1) H₀.
  // Stamped by the calibrator (safe_hotelling_params.sliding_buffer_threshold);
  // pre-Q2.B.6.2 configs fall through to analytical 1/α (P3.7 backward-
  // compat anchor).
  const params = input.cell.safe_hotelling_params;
  const threshold = params?.sliding_buffer_threshold ?? (1 / input.alpha);
  if (!params) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'safe_hotelling_params_missing', family: 'C',
      signal: 'hotelling_t2_safe',
    };
  }
  // xᵀ Σ⁻¹ x = ||L⁻¹ x||², L from Cholesky of Σ.
  const L = cholesky(input.cell.covariance);
  if (!L) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'covariance_singular', family: 'C',
      signal: 'hotelling_t2_safe',
    };
  }
  // Build Σ+τ²I additively on the diagonal; PSD whenever Σ is PSD and
  // τ² > 0. Defensive Cholesky still runs — if it fails, degenerate Σ
  // slipped past REPLY-41's off-diag gate and surfaces as suppressed.
  const p = input.cell.covariance.length;
  const sigmaPlus: number[][] = new Array(p);
  for (let i = 0; i < p; i++) {
    sigmaPlus[i] = input.cell.covariance[i].slice();
    sigmaPlus[i][i] += params.tau_squared;
  }
  const Lplus = cholesky(sigmaPlus);
  if (!Lplus) {
    return {
      verdict: 'suppressed', statistic: state.M, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'covariance_plus_tau_singular', family: 'C',
      signal: 'hotelling_t2_safe',
    };
  }
  const y = forwardSolve(L, x);
  const yPlus = forwardSolve(Lplus, x);
  let xSigmaInvX = 0;
  for (const v of y) xSigmaInvX += v * v;
  let xSigmaPlusInvX = 0;
  for (const v of yPlus) xSigmaPlusInvX += v * v;
  const z_t = -params.precompiled_log_det_shrink
    + 0.5 * xSigmaInvX
    - 0.5 * xSigmaPlusInvX;
  // Informational floor against denormal underflow on extremely long
  // healthy runs (z_t negative ~60+ ticks of log(0.946) ≈ -0.056 sums
  // to log(1e-300) ≈ -690 → M_t at ~12,300 ticks). E-process semantics
  // preserved; floor is observability only.
  state.M = Math.max(1e-300, state.M * Math.exp(z_t));
  state.n += 1;
  if (state.M >= threshold) {
    const alphaSpent = Math.max(0, input.alpha - state.alphaConsumed);
    state.alphaConsumed = input.alpha;
    return {
      verdict: 'fire', statistic: state.M, threshold,
      alpha_consumed: alphaSpent, alpha_spent: alphaSpent,
      reason_code: 'safe_hotelling_wealth_exceeded', family: 'C',
      signal: 'hotelling_t2_safe',
    };
  }
  return {
    verdict: 'clean', statistic: state.M, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'C',
    signal: 'hotelling_t2_safe',
  };
}

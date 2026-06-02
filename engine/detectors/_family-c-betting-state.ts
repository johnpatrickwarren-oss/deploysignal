// engine/detectors/_family-c-betting-state.ts — Family C canonical
// betting-e-process: shared constants + fresh-state factory.
//
// Split out of family-c-betting-e-process.ts (god-file decomposition).
// Behavior-preserving: constants + freshFamilyCBettingEProcessState moved
// VERBATIM; public name re-exported by the facade.

import type { FamilyCBettingEProcessState } from '../types';

/** Canonical ONS step-size constant per Cutkosky-Orabona 2018 with `+λF`
 *  payoff sign convention (Shekhar-Ramdas 2023 ONSstrategy docstring:
 *  "a `+` instead of `−` used by Cutkosky & Orabona (2018)"). Architecturally
 *  fixed — not B-dependent (architect v1 mistakenly tied to B; v2 amended
 *  post-library-cross-check). */
export const ONS_STEP_SIZE_C = 2 / (2 - Math.log(3));  // ≈ 1.6336

/** Numerical guard for Math.log(0) on wealth-factor underflow. Mirrors
 *  evaluateEMmd's WEALTH_FLOOR convention. */
export const LOG_FACTOR_FLOOR = 1e-12;

/** Witness running-max normalization activates after this many ticks per
 *  canonical kernelMMDprediction lines 57-92. Quote: "a heuristic that
 *  significantly improves the practical performance". */
export const WITNESS_NORMALIZATION_THRESHOLD = 10;

/** Default λ_max if FamilyCBettingEProcessParams.lambda_max absent —
 *  canonical 0.5 per `ONSstrategy(F, lambda_max=0.5)` signature. */
export const DEFAULT_LAMBDA_MAX = 0.5;

/** Initial wealth state for a new (deploy, cell) Q67 v2 evaluation.
 *
 *  `p` is the input dimension (Family C joint-vector size, typically 11).
 *  `D` is optional Q72 SLICE 2 RFF feature dimension; when provided,
 *  the state pre-allocates q_running_phi_sum ∈ R^D for the unbiased
 *  RFF witness path. Absent ⇒ legacy state shape (q_running_phi_sum
 *  not initialized; runtime falls back to biased streaming witness). */
export function freshFamilyCBettingEProcessState(
  p: number, D?: number,
): FamilyCBettingEProcessState {
  const state: FamilyCBettingEProcessState = {
    log_S_t: 0,                  // S_0 = 1 ⇒ log_S_0 = 0
    ons_lambda: 0,               // canonical λ_0 = 0 (no bet at start)
    ons_inverse_hessian: 1,      // canonical A_0 = 1 (implicit regularization)
    n: 0,
    witness_running_max: 0,
    q_running_sum: new Array<number>(p).fill(0),
    q_count: 0,
    fired: false,
    tick_at_first_fire: null,
    alphaConsumed: 0,
  };
  if (D !== undefined && D > 0) {
    state.q_running_phi_sum = new Array<number>(D).fill(0);
  }
  return state;
}

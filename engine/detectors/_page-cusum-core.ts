// engine/detectors/_page-cusum-core.ts — classical Page-1954 reset-at-zero
// CUSUM core (state, update, single-tick evaluation). Split out of
// page-cusum.ts (god-file refactor). Computation is VERBATIM from the
// original; no statistical behavior changed.
//
// Math (per tick, per signal):
//
//   z_n = log[ N(x_n | 0, σ² + τ²) / N(x_n | 0, σ²) ]
//       = ½·log( σ² / (σ² + τ²) )  +  x_n² · τ² / ( 2·σ² · (σ² + τ²) )
//
//   S_n = max(0, S_{n-1} + z_n),  S_0 = 0
//
// Fire when S_n ≥ h = −log(α_per_signal).

import type { DetectorVerdict } from '../types';
import type { CUSUMState, CUSUMStates, CUSUMInput } from './_page-cusum-types';

export function freshCUSUM(): CUSUMState {
  return { S: 0, n: 0, alphaConsumed: 0 };
}

export function getOrCreateCUSUM(states: CUSUMStates, signal: string): CUSUMState {
  const s = states[signal];
  if (s) return s;
  const fresh = freshCUSUM();
  states[signal] = fresh;
  return fresh;
}

/** Page-CUSUM update. Mutates `state` in place and returns the new S_n. */
export function updateCUSUM(
  state: CUSUMState,
  x: number,
  sigmaSquared: number,
  tauSquared: number,
  perTickAlpha: number,
): number {
  // Guard against a degenerate cell (σ² = 0). If the cell has no
  // variance, any non-zero x_n is infinitely surprising under H₀ — the
  // correct behavior is immediate fire. The compiler applies a τ²
  // derivation that cannot be exactly zero (τ² = δ_min² / 4 and δ_min has
  // a 5% × mean floor), but σ² can be 0 if the generator clamps. Treat
  // σ² = 0 as "use τ² alone" — the mixture degenerates to a flat prior on
  // the shifted mean and z_n collapses to x²/(2τ²).
  let z: number;
  if (sigmaSquared <= 0) {
    if (tauSquared <= 0) z = 0;
    else z = (x * x) / (2 * tauSquared);
  } else {
    const denom = sigmaSquared + tauSquared;
    const logShrink = 0.5 * Math.log(sigmaSquared / denom);
    const quad = (x * x * tauSquared) / (2 * sigmaSquared * denom);
    z = logShrink + quad;
  }
  state.S = Math.max(0, state.S + z);
  state.n += 1;
  state.alphaConsumed += perTickAlpha;
  return state.S;
}

function suppressed(signal: string, reason: string, state: CUSUMState, threshold: number): DetectorVerdict {
  // Suppressed verdicts expose the current S_n so the shadow-compare
  // audit output can trace pre-eligibility accumulation. Not a fire, not
  // a clean — the caller treats this as "do not action".
  return {
    verdict: 'suppressed',
    statistic: state.S,
    threshold,
    alpha_consumed: state.alphaConsumed,
    alpha_spent: 0,
    reason_code: reason,
    family: 'A',
    signal,
  };
}

/** Evaluate one (signal, cell) at the current tick. Mutates `state` (S_n
 *  and n advance regardless of suppression, per architect spec). */
export function evaluateCUSUM(input: CUSUMInput, x: number): DetectorVerdict {
  const { signal, params, state } = input;
  // Q2.B.5 (per Q2-B-5-SIGMA-COHERENCE-SPEC.md) — Page-CUSUM operates
  // on RAW observation space; consumes raw-space σ² derived at compile
  // time from Family C's blended Σ_C diagonal for overlapping signals.
  // Falls through to `empirical_variance` (transformed-space σ²) on
  // pre-Q2.B.5 configs lacking `empirical_variance_raw` — preserves
  // backward compatibility with v5/v5.1 substrates.
  const sigmaSquared = params.derivation?.empirical_variance_raw
    ?? params.derivation?.empirical_variance;
  if (sigmaSquared === undefined) {
    throw new Error(`CUSUM: missing derivation.empirical_variance(_raw) for signal ${signal}`);
  }
  // Always update first — bake/traffic gates only suppress the fire, not
  // the accumulation. When eligibility lands, S_n already reflects all
  // prior samples.
  updateCUSUM(state, x, sigmaSquared, params.tau_squared, params.alpha);
  const threshold = -Math.log(params.alpha);

  if (input.ticksSinceDeploy < params.min_ticks_before_eligible) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  // Addition #4 clause 2 — n_post_deploy_samples >= min_observation_window.
  // Wired in W4 §4.1.h per ARCHITECT-REPLY-12 S2 landing. Often equivalent
  // to clause 1 on fast-fire signals (p99 3/3/1), but does real work on
  // slower signals like cost_req (8/8/7). `state.n` is the post-update
  // post-deploy sample count — checked after updateCUSUM, so the current
  // sample is included.
  if (state.n < params.min_observation_window) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  if (input.deployAgeDays > params.max_deploy_window_days) {
    return suppressed(signal, 'bake_profile_not_met', state, threshold);
  }
  if (input.trafficPct < input.trafficGate) {
    return suppressed(signal, 'traffic_pct_below_gate', state, threshold);
  }

  if (state.S >= threshold) {
    return {
      verdict: 'fire',
      statistic: state.S,
      threshold,
      alpha_consumed: state.alphaConsumed,
      alpha_spent: params.alpha,  // Ville's-inequality budget (Q3)
      reason_code: 'cusum_exceeded_threshold',
      family: 'A',
      signal,
    };
  }
  return {
    verdict: state.S > 0 ? 'indeterminate' : 'clean',
    statistic: state.S,
    threshold,
    alpha_consumed: state.alphaConsumed,
    alpha_spent: 0,
    reason_code: state.S > 0 ? 'accumulating' : 'reset_to_zero',
    family: 'A',
    signal,
  };
}

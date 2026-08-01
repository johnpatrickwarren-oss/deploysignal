// engine/detectors/_hotelling-dispatch.ts — D-54-2 variant dispatch
// (ARCHITECT-REPLY-54 slice 2). Extracted VERBATIM from
// engine/detectors/hotelling.ts (god-file split). No behavior change.

import type {
  DetectorVerdict, FamilyCPerCell, TenantTier, SafeHotellingState,
} from '../types';
import { hotellingT2 } from './_hotelling-math';
import { evaluateSafeHotelling, freshSafeHotellingState } from '@johnpatrickwarren-oss/deploysignal-engine/detectors/_hotelling-safe';

/** Unified context the Record<HotellingVariant, Evaluator> receives.
 *  Each evaluator reads only the fields its variant needs. */
export interface HotellingDispatchCtx {
  params: FamilyCPerCell;
  r: number[];
  alphaHotelling: number;
  threshold: number;
  states?: Record<string, SafeHotellingState>;
  tier: TenantTier | null;
  hourOfDay: number;
  dayOfWeek?: number;
}

export type HotellingVariant = 'chi_square' | 'safe_test';
type HotellingEvaluator = (ctx: HotellingDispatchCtx) => DetectorVerdict;

/** Chi-square (Wilson-Hilferty) per-tick T² test — the pre-#20 default.
 *  Stateless; statistic is (x − μ)ᵀ Σ⁻¹ (x − μ). */
function evaluateHotellingChiSquare(ctx: HotellingDispatchCtx): DetectorVerdict {
  const { params, r, alphaHotelling, threshold } = ctx;
  const t2 = hotellingT2(r, params.covariance);
  if (t2 === null) {
    // Covariance not positive definite — shouldn't happen after Ledoit-
    // Wolf shrinkage, but the compiler could hit a degenerate cell.
    return {
      verdict: 'suppressed', statistic: null, threshold,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'covariance_singular', family: 'C',
    };
  }
  if (t2 >= threshold) {
    return {
      verdict: 'fire', statistic: t2, threshold,
      alpha_consumed: alphaHotelling, alpha_spent: alphaHotelling,
      reason_code: 'hotelling_exceeded_threshold', family: 'C',
    };
  }
  return {
    verdict: 'clean', statistic: t2, threshold,
    alpha_consumed: 0, alpha_spent: 0,
    reason_code: 'below_threshold', family: 'C',
  };
}

/** Safe-Hotelling e-process wrapper for dispatch. Allocates per-cell
 *  state on first use; requires `safe_hotelling_params` on the cell. */
function evaluateHotellingSafeTestDispatch(ctx: HotellingDispatchCtx): DetectorVerdict {
  const { params, r, states, tier, hourOfDay, dayOfWeek } = ctx;
  // The dispatch map only routes here when prereqs are present; reassert
  // here for the type-narrow + throw defensively if someone added a
  // caller that skips the guard.
  if (!params.safe_hotelling_params || !states) {
    throw new Error(
      'evaluateHotellingSafeTestDispatch invoked without safe_hotelling_params or states — '
      + 'dispatch map gate must enforce prereqs before routing.',
    );
  }
  const cellKey = `__sh_${tier ?? 'none'}_${hourOfDay}_${dayOfWeek ?? -1}`;
  let state = states[cellKey];
  if (!state) {
    state = freshSafeHotellingState();
    states[cellKey] = state;
  }
  return evaluateSafeHotelling(
    { cell: params, alpha: params.safe_hotelling_params.alpha },
    r, state,
  );
}

/** Variant→evaluator dispatch map. Adding a variant = adding a key. */
export const HOTELLING_EVALUATORS: Record<HotellingVariant, HotellingEvaluator> = {
  'chi_square': evaluateHotellingChiSquare,
  'safe_test': evaluateHotellingSafeTestDispatch,
};

/** Resolve a cell's declared variant to the effective dispatch key.
 *  Normalizes `undefined` → `'chi_square'` for backward-compat. Falls
 *  `safe_test` back to `chi_square` when compile-time params or
 *  runtime state is missing (preserves pre-D-54-2 semantics). Passes
 *  through any other value so the caller's Record lookup can throw
 *  on unknowns (feedback_no_skip_test_policy). */
export function hotellingVariantForDispatch(
  raw: FamilyCPerCell['hotelling_variant'],
  hasParams: boolean,
  hasStates: boolean,
): HotellingVariant {
  if (raw === undefined || raw === 'chi_square') return 'chi_square';
  if (raw === 'safe_test') {
    return (hasParams && hasStates) ? 'safe_test' : 'chi_square';
  }
  // Unknown string — return as-is so the Record lookup throws.
  return raw as HotellingVariant;
}

/** Exposed for dispatch-map parity testing. */
export const _HOTELLING_EVALUATORS_FOR_TEST = HOTELLING_EVALUATORS;
export const _hotellingVariantForDispatch = hotellingVariantForDispatch;

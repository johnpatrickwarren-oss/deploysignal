// engine/detectors/_conformal-gates.ts — Family E pre-scoring helpers.
//
// Extracted VERBATIM from conformal.ts#evaluateFamilyE to keep that
// function under the 100-line limit and conformal.ts under 500 lines.
// These are pure block-extractions: no computation changed. Re-exported
// from conformal.ts is unnecessary — they are file-local collaborators
// of evaluateFamilyE and not part of the public import surface.

import type {
  CompiledConfig, DetectorVerdict, SchemaContinuityRecord,
} from '../types';
import { FAMILY_C_SIGNALS } from './hotelling';

/** Collect the live joint vector in Family-C signal order. Returns null
 *  when any required signal is absent (caller short-circuits to null),
 *  matching the inline behavior that returned null from evaluateFamilyE. */
export function collectLiveVector(
  cfg: CompiledConfig,
  liveMetrics: Record<string, number | undefined>,
): { x: number[]; cSignals: readonly string[] } | null {
  // Collect live vector in joint-vector order — identical to Family C
  // so calibration scores are comparable at query time. REPLY-51b v2
  // R4-1: reads from cfg.family_c_signals when profile is active,
  // otherwise falls back to hardcoded.
  const cSignals = cfg.family_c_signals ?? FAMILY_C_SIGNALS;
  const x: number[] = new Array(cSignals.length);
  for (let i = 0; i < cSignals.length; i++) {
    const v = liveMetrics[cSignals[i]];
    if (v === undefined) return null;
    x[i] = v;
  }
  return { x, cSignals };
}

/** Same bake/traffic eligibility gates as Family C. Returns a suppressed
 *  DetectorVerdict when a gate is not met, otherwise null (proceed).
 *  Verbatim extraction of the bake/traffic block from evaluateFamilyE. */
export function checkBakeAndTrafficGates(
  cfg: CompiledConfig,
  cSignals: readonly string[],
  ctx: { ticksSinceDeploy: number; deployAgeDays: number; trafficPct: number },
  alphaE: number,
): DetectorVerdict | null {
  // Same bake/traffic gates as Family C — Family E inherits joint-detector
  // eligibility since it's a nonconformity scorer over the same vector.
  // (Signal-level bake profiles aren't per-signal here because the test
  // is multivariate; most-constrained across signals.)
  const bakeProfiles = cfg.bake_profiles ?? {};
  let maxMinTicks = 0;
  let maxMaxDays = Infinity;
  let anyProfile = false;
  for (const sig of cSignals) {
    const p = bakeProfiles[sig];
    if (!p) continue;
    anyProfile = true;
    if (p.min_ticks_before_eligible > maxMinTicks) maxMinTicks = p.min_ticks_before_eligible;
    if (p.max_deploy_window_days < maxMaxDays) maxMaxDays = p.max_deploy_window_days;
  }
  if (!anyProfile) { maxMinTicks = 3; maxMaxDays = 1; }

  if (ctx.ticksSinceDeploy < maxMinTicks) {
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'E',
    };
  }
  if (ctx.deployAgeDays > maxMaxDays) {
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'bake_profile_not_met', family: 'E',
    };
  }

  const trafficGate = cfg.traffic_pct_gate?.min_traffic_pct_for_fire ?? 0;
  if (ctx.trafficPct < trafficGate) {
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'traffic_pct_below_gate', family: 'E',
    };
  }
  return null;
}

/** Schema-continuity + calibration-underpowered pre-guards. Returns a
 *  suppressed DetectorVerdict when a guard trips, otherwise null. Verbatim
 *  extraction of the two early-guard blocks from evaluateFamilyE. */
export function checkConformalPreGuards(
  schemaContinuityClass: SchemaContinuityRecord['schema_continuity'] | undefined,
  shouldSuppressE: boolean,
  calibrationSampleCount: number,
  alphaE: number,
): DetectorVerdict | null {
  // Addition #8 runtime consumer (W5 §S6): calibration is parametric
  // under the baseline's schema; a breaking continuity change invalidates
  // the assumed null distribution, so the threshold / conformal p-value
  // is meaningless and we suppress pending rebaseline.
  if (schemaContinuityClass && shouldSuppressE) {
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: schemaContinuityClass === 'observability_stack'
        ? 'observability_stack_deploy' : 'schema_continuity_breaking',
      family: 'E',
    };
  }

  // Addition #13 (per ARCHITECT-REPLY-31 correction): Family E evaluates the
  // full joint vector regardless of `ignore_thresholds`. An in-band signal's
  // contribution to the Mahalanobis nonconformity score is near-zero
  // naturally, so explicit suppression would silence Family E on genuine
  // other-signal novelty the operator didn't intend to ignore.

  // Minimum-calibration guard: need at least 1/α_E calibration samples so
  // the smallest observable p-value can actually fall below α. If we have
  // too few, emit suppressed — a runway-pitch acceptable behavior.
  // Addition #19: guard applies to raw sample count (not ESS). The
  // weighted variant tightens the *threshold* rather than the discrete
  // p-value staircase, so the underpowered-for-α check stays on n.
  if (calibrationSampleCount + 1 < Math.ceil(1 / alphaE)) {
    return {
      verdict: 'suppressed', statistic: null, threshold: alphaE,
      alpha_consumed: 0, alpha_spent: 0,
      reason_code: 'calibration_underpowered', family: 'E',
    };
  }
  return null;
}

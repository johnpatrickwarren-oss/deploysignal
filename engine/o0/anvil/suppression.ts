// engine/o0/anvil/suppression.ts — Addition #29 / Q29 orchestrator hook.
//
// Pure post-evaluateHealth function. Given a HealthResult and a declared
// ExpectedFailurePattern + current wallclock, returns a new HealthResult
// with the families in `suppress_families` rewritten to suppressed
// (reason_code 'expected_failure_pattern') if the current tick lies
// within the fault window [fault_start_unix, fault_start_unix +
// recovery_seconds]. Otherwise returns the input unchanged.
//
// Gated upstream on `params.expectedFailurePattern !== undefined` so the
// pre-Anvil orchestrator path is byte-identical (PRD-29 NFR-2 / AC-11).

import type { HealthResult } from '@johnpatrickwarren-oss/deploysignal-engine/types/policy';
import type { DetectorVerdict } from '../../types/verdict';
import type { ExpectedFailurePattern, SuppressibleFamily } from './types';
import { tickWithinFaultWindow } from './types';

const REASON_CODE = 'expected_failure_pattern';

function suppressedDetectorVerdict(prior: DetectorVerdict): DetectorVerdict {
  return {
    ...prior,
    verdict: 'suppressed',
    alpha_consumed: 0,
    alpha_spent: 0,
    reason_code: REASON_CODE,
  };
}

/** Returns a HealthResult with families in `suppress_families` rewritten
 *  to suppressed when `nowUnixSeconds` lies within the declared fault
 *  window. Pure — does not mutate `hr`. */
export function applyExpectedFailurePatternSuppression(
  hr: HealthResult,
  pattern: ExpectedFailurePattern,
  nowUnixSeconds: number,
): HealthResult {
  if (!tickWithinFaultWindow(pattern, nowUnixSeconds)) return hr;
  if (pattern.suppress_families.length === 0) return hr;

  const targets = new Set<SuppressibleFamily>(pattern.suppress_families);
  const out: HealthResult = { ...hr };

  if (targets.has('A')) {
    if (hr.family_A_shadow && hr.family_A_shadow.length > 0) {
      out.family_A_shadow = hr.family_A_shadow.map(suppressedDetectorVerdict);
    }
  }

  if (targets.has('C')) {
    if (hr.family_C_verdict) {
      out.family_C_verdict = suppressedDetectorVerdict(hr.family_C_verdict);
    }
    if (hr.family_C_mmd_verdict) {
      out.family_C_mmd_verdict = suppressedDetectorVerdict(hr.family_C_mmd_verdict);
    }
  }

  if (targets.has('D')) {
    if (hr.family_D_shadow && hr.family_D_shadow.length > 0) {
      out.family_D_shadow = hr.family_D_shadow.map(suppressedDetectorVerdict);
    }
  }

  if (targets.has('E')) {
    if (hr.family_E_verdict) {
      out.family_E_verdict = suppressedDetectorVerdict(hr.family_E_verdict);
    }
  }

  // Family B is non-α-consuming structural (Q60 V2 family_b_trip_rate_note);
  // it doesn't expose a DetectorVerdict array on HealthResult. Suppressing
  // 'B' via expected_failure_pattern is a documented no-op at v1; if a
  // chaos experiment is structurally targeted (e.g., capacity injection
  // that Family B kv_saturation would fire on), operators currently route
  // through Family A + magnitude-keyed declaration. Slice-2 candidate to
  // extend HealthResult with a family_B suppression channel.

  return out;
}

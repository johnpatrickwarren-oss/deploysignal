// engine/gates/health.ts — G1 Health Signal Service (facade)
//
// Answers: "Is this service healthy here, now?"
//
// Key signals (proposal §2):
//   KV cache hit rate, MFU trend, HBM spill, tokens/turn, TTFT/ITL SLO,
//   collective ops, behavioral regression, downstream errors, cost/request.
//
// Also includes AI quality signals: eval score, refusal rate, output length,
// tool call success rate. These are runtime health — they belong in G1.
//
// CRITICAL DESIGN CHANGE from monolithic shared.js:
//   This module does NOT know about risk tiers, time windows, or approval state.
//   It receives a PolicyContext from G2 (policy.ts) containing:
//     - thresholds: per-signal base thresholds
//     - warmup: suppression list and bypass thresholds
//     - downstreamRule: corroboration requirements
//   G1 evaluates signals against those thresholds. Period.
//
// This file is a thin facade: the rollback/extend check tables live in
// `_health-defs.ts`, the Family A/C/D/E detector dispatch in
// `_health-detectors.ts`, and the public `HealthOpts` type plus shared
// constants in `_health-types.ts`. Public exports below are unchanged.

import type {
  Metrics, Baseline, Flags, PolicyContext,
  FiredSignal, HealthResult, TrendBufferI,
} from '../types';
import { ROLLBACK_DEFS, EXTEND_DEFS } from './_health-defs';
import {
  HealthOpts, FAMILY_A_RETIRED_RATIO_IDS,
} from './_health-types';
import { runFamilyA, runFamilyC, runFamilyD, runFamilyE } from './_health-detectors';
import { runFamilyAValidPath } from './_health-valid-path';

export type { HealthOpts };

/** Warmup absolute-bypass overrides: if a metric exceeds its bypass
 *  threshold even during warmup, the matching signal fires anyway. */
function computeBypass(
  liveMetrics: Metrics, baseline: Baseline, policyCtx: PolicyContext,
): { [id: string]: boolean } {
  const warmup = policyCtx.warmup || { active: false, suppressedIds: [], grace: false, pct: 100 };
  const bypass: { [id: string]: boolean } = {};
  if (warmup.active && warmup.absoluteBypass) {
    if ((liveMetrics.tokens_turn as number) / (baseline.tokens_turn as number) >= warmup.absoluteBypass.tokens_turn) {
      bypass['tokens'] = true; bypass['tok_econ'] = true;
    }
    if ((liveMetrics.p99_latency as number) / (baseline.p99_latency as number) >= warmup.absoluteBypass.p99_latency) {
      bypass['p99'] = true;
    }
    if (warmup.absoluteBypass.cost_req &&
        (liveMetrics.cost_req as number) / (baseline.cost_req as number) >= warmup.absoluteBypass.cost_req) {
      bypass['cost'] = true;
    }
  }
  return bypass;
}

/** C64 (a) — the envelope-valid terminal path. Runs only when the caller
 *  supplied a calibration series (`opts.validPath`); appends its verdicts
 *  after the plug-ins' so the plug-in block is byte-identical. Independent
 *  of `familyAPromoted`: the path has its own inputs. */
function maybeRunFamilyAValidPath(
  result: HealthResult, rollbackFired: FiredSignal[], sup: string[],
  liveMetrics: Metrics, tb: TrendBufferI | null, opts?: HealthOpts,
): void {
  if (!opts?.validPath || !tb) return;
  runFamilyAValidPath(result, rollbackFired, sup, liveMetrics, tb, opts);
}

/**
 * Evaluate health signals against live metrics.
 *
 * G1 ONLY evaluates health. It does NOT check time windows (G2),
 * deployment state (G3), blast radius (G4), or approval (G5).
 */
export function evaluateHealth(
  liveMetrics: Metrics,
  baseline: Baseline,
  flags: Flags,
  policyCtx: PolicyContext,
  tb: TrendBufferI | null,
  opts?: HealthOpts,
): HealthResult {
  const warmup = policyCtx.warmup || { active: false, suppressedIds: [], grace: false, pct: 100 };
  const sup = warmup.suppressedIds || [];
  const bypass = computeBypass(liveMetrics, baseline, policyCtx);

  const rollbackFired: FiredSignal[] = [];
  const extendFired: FiredSignal[] = [];
  const legacyShadow: FiredSignal[] = [];
  // Post-2.1.g swap: when Family A is compiled (W3: under the unified
  // `baseline_cells` schema with a family_A block populated for at least
  // one cell), ratio fires for Family A's 6 primary SLIs redirect to
  // `family_A_legacy_shadow`. Page-CUSUM fires become the primary source
  // of truth for those signals. Other ratio detectors (structural
  // signatures, compound, tokens, etc.) stay on the primary path.
  const familyAPromoted = !!opts?.compiledConfig?.baseline_cells?.cells.some((c) => c.family_A);

  // Evaluate rollback signals
  ROLLBACK_DEFS.forEach(function (d) {
    if (sup.indexOf(d.id) >= 0 && !bypass[d.id]) return;  // suppressed during warmup
    if (d.check(liveMetrics, baseline, flags, policyCtx, tb)) {
      if (familyAPromoted && FAMILY_A_RETIRED_RATIO_IDS.has(d.id)) {
        legacyShadow.push({ id: d.id, label: d.label });
      } else {
        rollbackFired.push({ id: d.id, label: d.label });
      }
    }
  });

  // Evaluate extend signals
  EXTEND_DEFS.forEach(function (d) {
    if (sup.indexOf(d.id) >= 0) return;
    if (d.check(liveMetrics, baseline, flags, policyCtx, tb)) {
      extendFired.push({ id: d.id, label: d.label });
    }
  });

  const result: HealthResult = {
    rollback:   rollbackFired,
    extend:     extendFired,
    warmup,
    suppressed: sup,
  };

  // Family A Page-CUSUM (per ARCHITECT-REPLY-05.md). Primary detector for
  // the 6 primary SLIs when `compiledConfig.baseline_cells.*.family_A` is
  // populated. CUSUM state persists on the TrendBuffer for the deploy
  // lifetime. Errors silently swallowed — a shadow crash must not fail
  // the primary gate.
  if (familyAPromoted && tb && opts) {
    runFamilyA(result, rollbackFired, legacyShadow, sup, liveMetrics, tb, opts);
  }

  // C64 (a) — the envelope-valid terminal path; inert without `opts.validPath`.
  maybeRunFamilyAValidPath(result, rollbackFired, sup, liveMetrics, tb, opts);

  // Family C (Hotelling T²) — W3 addition. End of the cascade; any fire
  // adds a `family_C` rollback entry. Stateless (per-tick test); error
  // swallowing identical to Family A.
  const familyCEnabled = !!opts?.compiledConfig?.baseline_cells?.cells.some((c) => c.family_C);
  if (familyCEnabled && opts) {
    runFamilyC(result, rollbackFired, sup, liveMetrics, tb, opts);
  }

  // Family D (ACF oscillation) — W4 addition. Per-signal; consumes the
  // TrendBuffer's long view (default 30 samples). Fires push
  // `family_D_${signal}` into rollback. Silent error swallow per Family A.
  const familyDEnabled = !!opts?.compiledConfig?.baseline_cells?.aggregate_fallback.family_D;
  if (familyDEnabled && tb && opts) {
    runFamilyD(result, rollbackFired, sup, liveMetrics, tb, opts);
  }

  // Family E (conformal novelty) — W4 addition. Single multivariate test.
  // Advisory since C25 (FAMILY_E_ADVISORY): a fire is recorded on
  // `family_E_verdict` but does not push `family_E` into rollback.
  const familyEEnabled = !!opts?.compiledConfig?.baseline_cells?.aggregate_fallback.family_E;
  if (familyEEnabled && opts) {
    runFamilyE(result, rollbackFired, sup, liveMetrics, tb, opts);
  }

  return result;
}

export { ROLLBACK_DEFS, EXTEND_DEFS };

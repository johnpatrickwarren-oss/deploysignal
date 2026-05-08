// engine/gates/policy.ts — G2 policy resolution gate.
// Builds the threshold/warmup/downstream context that G1 (health) consumes.

import type {
  RiskLevel, Author, ChangeType, TimeWindow,
  ThresholdSet, ThresholdEntry,
  WarmupState, DownstreamRule,
  PolicyContext, PolicyResult,
  FailFastState, Metrics,
} from '../types';

const THRESHOLD_PROFILES: { [profileKey: string]: ThresholdSet } = {
  'critical:model_weights': { p99: { base: 1.15, tightenAfterHours: 12, tightenedBase: 1.12 }, ttft: { base: 1.15 }, compound: { base: 1.10 }, behavioral: { base: 1.18 } },
  'critical:serving_code':  { p99: { base: 1.18 }, ttft: { base: 1.18 }, compound: { base: 1.10 }, behavioral: { base: 1.18 } },
  'high:model_weights':     { p99: { base: 1.20 }, ttft: { base: 1.20 }, compound: { base: 1.12 }, behavioral: { base: 1.18 } },
  '_default':               { p99: { base: 1.20 }, ttft: { base: 1.20 }, compound: { base: 1.12 }, behavioral: { base: 1.18 }, downstream: { base: 1.50 }, cost: { base: 1.20 }, tokens: { base: 1.25 }, tok_econ: { baseTok: 1.25, baseCost: 1.20 } },
};

interface PolicyWarmupConfig {
  triggeredBy: ChangeType[];
  windowHours: { [k in RiskLevel]: number };
  graceWindowHours: number;
  absoluteBypass: { [signalId: string]: number };
  suppressedSignals: string[];
}

const WARMUP: PolicyWarmupConfig = {
  triggeredBy: ['model_weights'],  // 'all' is not a valid ChangeType but matches original behavior via indexOf check
  windowHours: { critical: 6, high: 8, medium: 10, low: 4 },
  graceWindowHours: 2,
  absoluteBypass: { tokens_turn: 1.35, p99_latency: 1.40, cost_req: 1.80 },
  suppressedSignals: ['tokens', 'tok_econ', 'cost', 'kv_low', 'hbm_spill', 'mfu_delta', 'mem_pressure'],
};

const BLOCKED: TimeWindow[] = ['friday', 'weekend', 'evening'];

const DOWNSTREAM_RULES: { [k: string]: DownstreamRule } = {
  config:   { base: 1.38, requiresCorroboration: false },
  _default: { base: 1.50, requiresCorroborationAfterHours: 12 },
};

interface PolicyChangeInput {
  riskLevel?: RiskLevel;
  changeType?: ChangeType;
  author?: Author;
  timeWindow?: TimeWindow;
}

const BAKE_HOURS_BY_RISK: { [k in RiskLevel]: number } = { critical: 84, high: 72, medium: 48, low: 24 };

export function resolvePolicy(change: PolicyChangeInput, hrs: number): PolicyContext {
  const rl: RiskLevel = change.riskLevel || 'medium';
  const ct: ChangeType = change.changeType || 'serving_code';
  const tw: TimeWindow = change.timeWindow || 'ok';

  const profile: ThresholdSet = THRESHOLD_PROFILES[rl + ':' + ct] || THRESHOLD_PROFILES['_default'];
  const def: ThresholdSet = THRESHOLD_PROFILES['_default'];
  const thr: ThresholdSet = {};
  for (const k in def) thr[k] = def[k];
  for (const k in profile) thr[k] = profile[k];

  if (thr.p99 && thr.p99.tightenAfterHours && hrs > thr.p99.tightenAfterHours) {
    thr.p99 = Object.assign({} as ThresholdEntry, thr.p99, { base: thr.p99.tightenedBase });
  }

  const wH = WARMUP.windowHours[rl] || 6;
  const gH = WARMUP.graceWindowHours;
  const inW = hrs < wH;
  const inG = !inW && hrs < (wH + gH);

  let warmup: WarmupState = {
    active: inW,
    grace: inG,
    pct: Math.min(100, Math.round(hrs / wH * 100)),
    hoursRemaining: Math.max(0, wH - hrs),
    suppressedIds: inW ? WARMUP.suppressedSignals : [],
    absoluteBypass: WARMUP.absoluteBypass,
    windowHours: wH,
    graceWindowHours: gH,
  };
  if ((WARMUP.triggeredBy as string[]).indexOf(ct) < 0) {
    warmup = { active: false, grace: false, suppressedIds: [], pct: 100 };
  }

  return {
    riskLevel: rl,
    changeType: ct,
    author: change.author || 'human',
    hoursElapsed: hrs,
    bakeHours: BAKE_HOURS_BY_RISK[rl] || 48,
    thresholds: thr,
    warmup,
    timeWindowBlocked: BLOCKED.indexOf(tw) >= 0,
    timeWindow: tw,
    downstreamRule: DOWNSTREAM_RULES[ct] || DOWNSTREAM_RULES['_default'],
  };
}

export function evaluatePolicy(change: PolicyChangeInput, hrs: number): PolicyResult {
  const ctx = resolvePolicy(change, hrs);
  if (ctx.timeWindowBlocked) {
    return { allow: false, reason: 'Deploy blocked: ' + ctx.timeWindow + ' window' };
  }
  return { allow: true, reason: null, policyContext: ctx };
}

/** Week 6+ Addition #10 (SRM check) — gate-layer decision on the L0
 *  traffic-allocation classification. Pure adapter: given the pre-computed
 *  continuity status (from `engine/l0/traffic-allocation-continuity.ts`)
 *  plus observed/expected canary fractions, returns whether G1 should
 *  short-circuit and the reason string. Orchestrator calls this between
 *  state (G3) and health (G1) so that a `'breaking'` classification
 *  prevents any detector family from evaluating against an invalid
 *  comparison population. The reason string shape matches the spec and is
 *  asserted by the SRM integration test. */
export function evaluateTrafficAllocation(
  status: 'stable' | 'drifting' | 'breaking' | undefined,
  observedTrafficPct: number,
  expectedCanaryWeight: number | undefined,
): { shortCircuit: false } | { shortCircuit: true; reason: string } {
  if (status !== 'breaking' || expectedCanaryWeight === undefined) {
    return { shortCircuit: false };
  }
  return {
    shortCircuit: true,
    reason: `Sample Ratio Mismatch — observed canary fraction ${
      (observedTrafficPct * 100).toFixed(1)
    }% diverged from expected ${
      (expectedCanaryWeight * 100).toFixed(1)
    }%`,
  };
}

/** Week 6+ Addition #13 — fail-fast / ignore-threshold classification.
 *
 *  Three-tier policy contract at G1 per NORTH-STAR-ARCHITECTURE.md Addition
 *  #13. These helpers implement tiers 1 (fail-fast) and 2 (ignore). The
 *  orchestrator calls them between the SRM short-circuit and health-gate
 *  evaluation; placement invariant is after L0 continuity short-circuits,
 *  before L2 detector families. Pure functions: no side effects, caller
 *  owns the sticky state for fail-fast.
 *
 *  `classifyFailFast` returns the sticky-updated state plus a short-circuit
 *  decision. Once state.tripped is true, subsequent calls short-circuit
 *  with a sticky reason — no re-evaluation (architect default). Signals
 *  whose observations are `undefined` are skipped (operators set
 *  thresholds on signals they monitor; unmonitored signals should not
 *  trip). Fail-fast evaluated strictly first: the edge case where a
 *  fail-fast threshold sits inside an ignore band resolves in fail-fast's
 *  favor.
 *
 *  `classifyIgnoredSignals` returns the set of signals whose current
 *  observation lies inside the operator's ignore band. Detector-family
 *  eligibility consumes this set; Family A (per-signal) suppresses the
 *  matching signal, Family C/E (multivariate) suppress the whole family
 *  if any consumed signal is in-band. Family B structural signatures are
 *  NOT affected by ignore thresholds per anti-scope. */
export function classifyFailFast(
  failFastThresholds: Record<string, number> | undefined,
  liveMetrics: Metrics,
  prior: FailFastState | undefined,
): { shortCircuit: boolean; reason: string | null; newState: FailFastState } {
  const base: FailFastState = prior ?? { tripped: false };
  if (base.tripped) {
    return {
      shortCircuit: true,
      reason:
        'Fail-fast threshold exceeded (sticky) — ' + base.trippedSignalId +
        ': prior observed ' + base.trippedObserved + ' > threshold ' + base.trippedThreshold,
      newState: base,
    };
  }
  if (failFastThresholds) {
    for (const signalId of Object.keys(failFastThresholds)) {
      const threshold = failFastThresholds[signalId];
      const observed = liveMetrics[signalId];
      if (observed === undefined) continue;
      if (observed > threshold) {
        const newState: FailFastState = {
          tripped: true,
          trippedSignalId: signalId,
          trippedThreshold: threshold,
          trippedObserved: observed,
        };
        return {
          shortCircuit: true,
          reason:
            'Fail-fast threshold exceeded — ' + signalId +
            ': observed ' + observed + ' > threshold ' + threshold,
          newState,
        };
      }
    }
  }
  return { shortCircuit: false, reason: null, newState: base };
}

export function classifyIgnoredSignals(
  ignoreThresholds: Record<string, { min?: number; max?: number }> | undefined,
  liveMetrics: Metrics,
): Set<string> {
  const out = new Set<string>();
  if (!ignoreThresholds) return out;
  for (const signalId of Object.keys(ignoreThresholds)) {
    const band = ignoreThresholds[signalId];
    const observed = liveMetrics[signalId];
    if (observed === undefined) continue;
    const minOk = band.min === undefined || observed >= band.min;
    const maxOk = band.max === undefined || observed <= band.max;
    if (minOk && maxOk) out.add(signalId);
  }
  return out;
}

export { THRESHOLD_PROFILES, WARMUP as WARMUP_CONFIG, BLOCKED as BLOCKED_WINDOWS, DOWNSTREAM_RULES };

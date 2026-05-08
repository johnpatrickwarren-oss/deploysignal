// engine/types/policy.ts — Policy context, thresholds, warmup,
// gate-result interfaces, health-result provenance.

import type {
  RiskLevel, Author, ChangeType, TimeWindow,
} from './primitives';
import type { Metrics, Baseline, Flags, TrendBufferI } from './metrics';
import type { FusedVerdict, DetectorVerdict } from './verdict';

// ── Policy ────────────────────────────────────────────────────────

/** Per-signal threshold configuration produced by resolvePolicy(). */
export interface ThresholdEntry {
  base?: number;
  baseTok?: number;
  baseCost?: number;
  tightenAfterHours?: number;
  tightenedBase?: number;
}

export interface ThresholdSet {
  p99?: ThresholdEntry;
  ttft?: ThresholdEntry;
  compound?: ThresholdEntry;
  behavioral?: ThresholdEntry;
  downstream?: ThresholdEntry;
  cost?: ThresholdEntry;
  tokens?: ThresholdEntry;
  tok_econ?: ThresholdEntry;
  [key: string]: ThresholdEntry | undefined;
}

export interface WarmupState {
  active: boolean;
  grace: boolean;
  pct: number;
  hoursRemaining?: number;
  suppressedIds: string[];
  absoluteBypass?: { [signalId: string]: number };
  windowHours?: number;
  graceWindowHours?: number;
}

export interface DownstreamRule {
  base: number;
  requiresCorroboration?: boolean;
  requiresCorroborationAfterHours?: number;
}

/**
 * Resolved policy context handed from G2 (policy) to G1 (health).
 * `_tick` is set by orchestrator after resolution for tick-aware checks.
 */
export interface PolicyContext {
  riskLevel: RiskLevel;
  changeType: ChangeType;
  author: Author;
  hoursElapsed: number;
  bakeHours: number;
  thresholds: ThresholdSet;
  warmup: WarmupState;
  timeWindowBlocked: boolean;
  timeWindow: TimeWindow;
  downstreamRule: DownstreamRule;
  /** Set by orchestrator before passing to gates. */
  _tick?: number;
}

/**
 * Week-6+ Addition #13 — sticky fail-fast state for an active deploy.
 * Once `tripped` goes true, subsequent ticks keep emitting short-circuit
 * with a reason reconstructed from the saved trip details. Caller owns
 * the lifetime; orchestrator returns updated state per tick.
 */
export interface FailFastState {
  tripped: boolean;
  trippedSignalId?: string;
  trippedThreshold?: number;
  trippedObserved?: number;
}

/** Week-6+ Addition #5 — deploy-level reversibility classification.
 *  One classification per deploy at deploy start; values stay constant
 *  across all ticks of the deploy (ticks within inherit unchanged per
 *  anti-scope). Threaded through `OrchestrateParams`/`VerdictResult`
 *  like `FailFastState`/`LifecycleDeployState` so callers carry it
 *  forward without re-running the classifier. */
export interface ReversibilityClassification {
  reversibility: 'reversible' | 'forward_only' | 'conditional';
  reversibility_source: 'platform_annotation' | 'default_fallback';
}

// ── Signal definitions ────────────────────────────────────────────

/**
 * Signal check function — evaluates a single signal at the current tick.
 * Returns true to fire the signal.
 */
export type SignalCheck = (
  m: Metrics,
  b: Baseline,
  f: Flags,
  pol: PolicyContext,
  tb: TrendBufferI | null,
) => boolean;

/** Common shape for ROLLBACK_DEFS / EXTEND_DEFS entries. */
export interface SignalDef {
  id: string;
  label: string;
  check: SignalCheck;
}

/** Alias kept distinct so future divergence doesn't break callers. */
export type RollbackDef = SignalDef;
export type ExtendDef = SignalDef;

/** A fired signal — what evaluateHealth returns in rollback[]/extend[]. */
export interface FiredSignal {
  id: string;
  label: string;
}

// ── Gate results ──────────────────────────────────────────────────

export interface BlastRadiusResult {
  riskLevel: RiskLevel;
  declaredRisk: RiskLevel;
  author: Author;
  changeType: ChangeType;
  escalated: boolean;
  escalationReasons: string[];
  requiresApproval: boolean;
}

export interface PolicyResult {
  allow: boolean;
  reason: string | null;
  policyContext?: PolicyContext;
}

export interface ApprovalResult {
  approved: boolean;
  requirement: 'human_token' | 'director' | 'none';
  reason: string | null;
  riskLevel: RiskLevel;
  author: Author;
}

export interface StateResult {
  allow: boolean;
  reason: string | null;
}

export interface HealthResult {
  rollback: FiredSignal[];
  extend: FiredSignal[];
  warmup: WarmupState;
  suppressed: string[];
  /** Week 2: per-primary-SLI Page-CUSUM verdicts. When Family A is
   *  compiled, CUSUM is the primary detector — fires appear in `rollback`
   *  and this array carries full provenance (S_n, threshold, α). */
  family_A_shadow?: DetectorVerdict[];
  /** Week 2 (post-2.1.g): ratio-detector fires for Family-A-scope signals
   *  (p99/ttft/downstream/cost/eval/tool), redirected here from `rollback`
   *  so Family A CUSUM is the primary verdict. Retained for one cycle of
   *  comparison per architect ARCHITECT-REPLY-05.md. Stripped at v1
   *  serialization; Week-4 schema bump picks it up. */
  family_A_legacy_shadow?: FiredSignal[];
  /** Week 3: per-tick Family C (Hotelling T²) multivariate verdict. A
   *  fire here becomes a `family_C` entry in `rollback[]`; provenance
   *  (T² statistic, χ² threshold, α spent) lives on this field. Stripped
   *  at v1 serialization; Week-4 schema bump picks it up. */
  family_C_verdict?: DetectorVerdict;
  /** Addition #18 — Sequential MMD verdict (second Family C detector,
   *  runs ALONGSIDE Hotelling T² not replacing per D4). Populated only
   *  when the compiled cell carries `mmd_params`; absent otherwise. Fire
   *  promotes to a `family_C_mmd` entry in `rollback[]`; provenance
   *  (U_t statistic, bootstrap null-quantile, α spent) lives here. */
  family_C_mmd_verdict?: DetectorVerdict;
  /** Week 4: Family D ACF oscillation verdicts (one per watched signal).
   *  Fires promote to `family_D_${signal}` entries in `rollback[]`. */
  family_D_shadow?: DetectorVerdict[];
  /** Week 4: Family E conformal novelty verdict (single multivariate).
   *  Fire promotes to `family_E` entry in `rollback[]`. */
  family_E_verdict?: DetectorVerdict;
}

/**
 * Composite gate output bundle. Generic so future gates (G6 security)
 * can extend without breaking existing callers.
 */
export interface GateResults {
  blastRadius?: BlastRadiusResult;
  policy?: PolicyResult;
  approval?: ApprovalResult;
  state?: StateResult;
  health?: HealthResult;
  /** Week 4: portfolio-fusion output. Always populated when the health
   *  path runs (both topologies emit a value — cascade for parity, portfolio
   *  for the new primary). Strip at v1 serialization; schema v2 picks up. */
  fusion?: FusedVerdict;
  [key: string]: unknown;
}

/** Addition #8 schema-continuity L0 record. Computed per live metric
 *  stream and emitted upstream of detectors. Detectors consult the class
 *  before evaluating; `breaking` or `observability_stack` suppresses
 *  everything pending rebaseline. `schema_baseline_ref` identifies which
 *  baseline the hash was measured against — a mismatch between the live
 *  stream's `schema_baseline_ref` and the compiled config's baseline_ref
 *  is itself a breaking-class change. */
export interface SchemaContinuityRecord {
  schema_hash: string;
  schema_continuity: 'continuous' | 'extended' | 'breaking' | 'observability_stack';
  schema_baseline_ref: string;
}

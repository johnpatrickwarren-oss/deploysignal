// engine/types/orchestration.ts — OrchestrateParams (evaluate() inputs).
//
// Depends on almost every other submodule; isolated here so the cross-
// cutting Metrics/Scenario/AuditWriter/CompiledConfig surface stays
// co-located with its one big consumer.

import type { Metrics } from './metrics';
import type {
  FailFastState, SchemaContinuityRecord, ReversibilityClassification,
} from './policy';
import type { Scenario } from './verdict';
import type { TrendBufferI } from './metrics';
import type { AuditWriter, AuditOpts } from './audit';
import type { CompiledConfig } from './config';
import type { StateGateContext } from './session';

/** Inputs to evaluate(). All fields except liveMetrics/scenario are optional. */
export interface OrchestrateParams {
  liveMetrics: Metrics;
  scenario: Scenario;
  hoursElapsed: number;
  trendBuffer?: TrendBufferI | null;
  tick: number;
  totalTicks: number;
  deployId?: string;
  targetCloud?: string;
  /** Task 2 (WS4 session-durability-argo plan) — pure data snapshot fed
   *  to the G3 state gate (`gates/state.ts` `evaluateState`). The
   *  service layer's SessionStore (Task 3) builds this from its
   *  file-backed store before each tick's evaluate() call. Absent → G3
   *  behaves exactly as the pre-WS4 stub (`{allow: true, reason: null}`)
   *  — hard backward-compat gate, same precedent as `failFastState` /
   *  `lifecycleEmitter` above. */
  stateContext?: StateGateContext;
  auditWriter?: AuditWriter | null;
  auditOpts?: AuditOpts | null;
  /** Week-1 NS keystone hook: if provided, Family B cutoffs from this config
   *  overlay the hand-tuned thresholds from policy.ts after policy resolution.
   *  When undefined (default), the engine behaves exactly as before. */
  compiledConfig?: CompiledConfig | null;
  /** Addition #23 — tenant identifier for the request(s) represented by
   *  `liveMetrics` this tick. When set and `compiledConfig.tenant_tier_map`
   *  is populated, the orchestrator derives `tenant_tier` and detectors
   *  look up `(hour, day, tenant_tier)` cells. When absent or when the
   *  mapping has no entry, falls back to `tenant_tier = 'aggregate'` —
   *  preserves pre-#23 lookup semantics. Privacy: `tenant_id` never
   *  reaches audit records; only the derived `tenant_tier` bucket is
   *  persisted (see audit/SCHEMA.md §DetectorTrip). */
  tenantId?: string;
  /** Week 2: hour-of-day context for Family A cell lookup (0..23). When
   *  undefined, the orchestrator falls back to `new Date().getHours()`.
   *  Adversarial tests inject this explicitly so per-cell behavior is
   *  deterministic. */
  currentHourOfDay?: number;
  /** Week 3: day-of-week (0..6) for 2-D cell lookup. Optional — 1-D
   *  configs ignore it. */
  currentDayOfWeek?: number;
  /** Week 2: bake-profile inputs. `ticksSinceDeploy` defaults to the
   *  orchestrator's `tick`. `deployAgeDays` defaults to
   *  `hoursElapsed / 24` — callers override when the scenario diverges. */
  ticksSinceDeploy?: number;
  deployAgeDays?: number;
  /** Week 4: fusion topology selector. `cascade` preserves W3 behavior
   *  (computeVerdict reads rollback[]/extend[] arrays). `portfolio`
   *  aggregates per-family verdicts via `fuseVerdict`. Default: cascade
   *  until adversarial parity confirms portfolio is drop-in. */
  fusionTopology?: 'cascade' | 'portfolio';
  /** Week 5 §S6 (Addition #8 runtime consumer): continuity class of the
   *  live telemetry stream against the compiled baseline's schema. L0
   *  helpers in engine/l0/schema-continuity.ts compute this per signal;
   *  the orchestrator passes the current-tick class through so detector
   *  eligibility and audit provenance can reflect it. Absent → treated
   *  as 'continuous' (no suppression applied). Families A/C/D/E suppress
   *  on 'breaking' and 'observability_stack'; Family B is unaffected per
   *  NORTH-STAR-ARCHITECTURE.md Addition #8 (structural signatures don't
   *  depend on continuous metric semantics). */
  schemaContinuityClass?: SchemaContinuityRecord['schema_continuity'];
  /** Week 6+ Addition #10 (SRM check): pre-classified traffic-allocation
   *  continuity for the current tick. The classifier lives in
   *  engine/l0/traffic-allocation-continuity.ts; callers own the rolling
   *  state and pass the per-tick status through. When `'breaking'`, the
   *  orchestrator short-circuits with `shortCircuit: 'srm'` BEFORE the
   *  health gate runs — no detector families evaluate (the comparison
   *  population is invalid). When absent or `'stable'`/`'drifting'`, the
   *  full gate path runs normally. Always emitted on audit records
   *  (top-level `traffic_allocation_continuity`) when provided; absent →
   *  null in audit. */
  trafficAllocationContinuity?: 'stable' | 'drifting' | 'breaking';
  /** Week 6+ Addition #10: expected canary fraction for the SRM
   *  reason-string emitted on short-circuit. Stand-in for
   *  `DeployContext.canary_weight` until Addition #9 lands and the typed
   *  deploy context replaces it. Required only to format the reason when
   *  `trafficAllocationContinuity === 'breaking'`; pure audit-field
   *  emission does not depend on it. */
  expectedCanaryWeight?: number;
  /** Week 6+ Addition #13 — operator-set fail-fast thresholds, per signal.
   *  Absolute panic bounds (NOT ratios). If an observed signal exceeds its
   *  threshold at any tick the orchestrator short-circuits L2 entirely
   *  with `shortCircuit: 'policy_fail_fast'` and verdict `rollback`.
   *  Signals whose live observation is `undefined` are skipped. Services
   *  that don't set any thresholds see zero behavior change (hard
   *  backward-compat gate). Three-tier policy contract tier 1 per
   *  `NORTH-STAR-ARCHITECTURE.md` Addition #13. */
  failFastThresholds?: Record<string, number>;
  /** Week 6+ Addition #13 — operator-set ignore thresholds, per signal.
   *  Per-signal skip band with optional `min` and `max`. Signals whose
   *  observed value lies within the band are passed to L2 as metadata;
   *  comparative-analysis detector families (A, C, E) suppress that
   *  signal (Family A) or the whole family (Family C/E multivariate —
   *  any consumed signal in-band suppresses the joint test) with
   *  `suppression_reason: 'ignore_threshold'`. Family B structural
   *  signatures are NOT affected — they fire on absolute ratios, not
   *  comparative analysis. Three-tier policy contract tier 2. */
  ignoreThresholds?: Record<string, { min?: number; max?: number }>;
  /** Week 6+ Addition #13 — sticky fail-fast state threaded across ticks.
   *  Once `.tripped` is true, the orchestrator keeps emitting
   *  short-circuit for the deploy's remaining ticks without re-evaluating
   *  — deploy is already marked for rollback. Absent → treat as
   *  `{ tripped: false }`. Caller owns the state; orchestrator returns
   *  the updated state on `VerdictResult.failFastState`. */
  failFastState?: FailFastState;
  /** Week 6+ Addition #14 — optional lifecycle event emitter. When set,
   *  the orchestrator emits the five event types at gate-lifecycle
   *  transitions: `evaluation.triggered`/`.started`/`.tick`/`.suppressed`/
   *  `.finished`. When absent, orchestrator behaves as
   *  `NoOpLifecycleEventEmitter` (zero side effects) — backward compat
   *  hard gate. */
  lifecycleEmitter?: import('../o0/lifecycle-events').LifecycleEventEmitter;
  /** Week 6+ Addition #14 — per-deploy lifecycle state threaded across
   *  ticks. The orchestrator is single-tick; this object carries the
   *  once-per-deploy emit latches (`triggered`/`started`/`finished`) and
   *  the per-family suppression state needed so
   *  `evaluation.suppressed` fires only on non-suppressed → suppressed
   *  transitions rather than every tick. Caller creates fresh per
   *  deploy (via `freshLifecycleState()`); orchestrator mutates it
   *  in-place and returns it on `VerdictResult.lifecycleState`. Absent
   *  → orchestrator initializes fresh state locally (fine for one-shot
   *  tests but loses once-per-deploy invariants across separate
   *  `evaluate()` calls). */
  lifecycleState?: import('../o0/lifecycle-events').LifecycleDeployState;
  /** Week 6+ Addition #5 — platform-annotation source for reversibility
   *  classification. Consulted once per deploy (at tick 0 when no
   *  prior classification is threaded through). Runway ships three
   *  implementations in `engine/o0/reversibility-source.ts`:
   *  `NoReversibilitySource` (default; every deploy falls back),
   *  `InlineReversibilitySource` (test fixture), and
   *  `ScenarioReversibilitySource` (scenario-JSON-keyed Record).
   *  Absent → orchestrator uses `NoReversibilitySource` → every
   *  deploy receives the default-fallback `'forward_only'` classification. */
  reversibilitySource?: import('../o0/reversibility-source').ReversibilityAnnotationSource;
  /** Week 6+ Addition #5 — pre-classified reversibility for this deploy.
   *  Orchestrator populates at tick 0 via
   *  `classifyReversibility(deployId, reversibilitySource)` and returns
   *  on `VerdictResult.reversibilityClassification`; caller threads it
   *  forward so subsequent ticks don't re-classify. A reversibility
   *  classification is a deploy-level property (not tick-mutable). */
  reversibilityClassification?: ReversibilityClassification;

  /** Anvil (Addition #29 / PRD-29 / Q29) — operator-declared
   *  expected-failure pattern for a chaos experiment. When set, the
   *  orchestrator suppresses the detector families named in
   *  `suppress_families` during the fault window
   *  `[fault_start_unix, fault_start_unix + recovery_seconds]` with
   *  `suppression_reason: 'expected_failure_pattern'`. Outside the
   *  fault window, normal detector eligibility applies. When absent
   *  (or when `DeployContext.strategy !== 'chaos_experiment'`), the
   *  orchestrator behaves byte-identically to pre-Anvil — back-compat
   *  hard gate per PRD-29 NFR-2 / AC-11.
   *
   *  Transitional stand-in until Addition #9 materializes the typed
   *  `DeployContext` interface with `expected_failure_pattern` per
   *  NORTH-STAR-ARCHITECTURE.md Addition #29 contract block. Mirrors
   *  the precedent Addition #10 used for `expectedCanaryWeight`
   *  (see line 86 above). */
  expectedFailurePattern?: import('../o0/anvil/types').ExpectedFailurePattern;

  // ── Consolidated activation slice: #25 / #26 / #27 wiring ──────────
  //
  // Per-deploy instances. Caller owns construction at deploy-start and
  // threads them on every tick — same pattern as `lifecycleState`.
  // All optional: absent → orchestrator behaves byte-identically to
  // pre-slice (no grouping, no enrichment, no agent invocation).

  /** Addition #25 — per-deploy VerdictGrouper. Absent → L3b grouping
   *  path skipped; FusedVerdict emission on `gateResults.fusion` is
   *  unchanged. */
  verdictGrouper?: import('../verdict-groups').VerdictGrouper;
  /** Addition #26 — per-deploy TopologyEnricher. Absent → no
   *  enrichment fan-out on group-close. Populated only when
   *  `compiledConfig.topology_ref` is configured. */
  topologyEnricher?: import('../topology-overlay').TopologyEnricher;
  /** Addition #27 — per-deploy AgentProposer. Absent OR
   *  `compiledConfig.agent.enabled === false` → no agent invocation
   *  on group-close. Structural type — the real implementation lives
   *  at `advisory/agent/proposer.ts` (outside engine/ rootDir; the
   *  advisory layer depends on engine, not the other way around). */
  agentProposer?: import('./agent').AgentProposerLike;
  /** Caller-owned factory for AgentInputContext. Invoked once per
   *  closed VerdictGroup. Keeps orchestrator ignorant of playbook
   *  loading + service_metadata shape. Required when `agentProposer`
   *  is set. */
  buildAgentInputContext?: (
    group: import('./verdict').VerdictGroup,
    reversibility: ReversibilityClassification,
  ) => import('./agent').AgentInputContextLike;
  /** Wallclock seconds for VerdictGrouper.ingest. Absent → orchestrator
   *  derives from `Date.now() / 1000`. Tests inject explicit values for
   *  deterministic grouping + grace-window behavior. */
  nowSeconds?: number;
}

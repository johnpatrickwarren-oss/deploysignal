// engine/types/verdict.ts — Scenario, orchestrator return, fusion
// output, detector-verdict, verdict-group + topology overlay artifacts.

import type { Verdict, FamilyId } from './primitives';
import type { Baseline, Flags } from './metrics';
import type {
  RiskLevel, Author, ChangeType, TimeWindow,
} from './primitives';
import type {
  HealthResult, GateResults, PolicyContext, FailFastState,
  ReversibilityClassification, FiredSignal,
} from './policy';

// ── Orchestrator I/O ──────────────────────────────────────────────

/** Scenario shape consumed by the orchestrator (subset of full scenario). */
export interface Scenario {
  id?: string;
  name?: string;
  baseline: Baseline;
  riskLevel?: RiskLevel;
  changeType?: ChangeType;
  author?: Author;
  timeWindow?: TimeWindow;
  flags?: Flags;
  filePaths?: string[] | null;
  bakeHours?: number;
  driftParams?: { [key: string]: number };
  drift?: (tick: number, params: { [key: string]: number }) => { [key: string]: number };
}

/** Orchestrator return value. `policyCtx` is present on the health path only.
 *  Week-6+ Addition #10: `'srm'` joins the short-circuit set — fires when
 *  L0 traffic-allocation-continuity classifies the current tick 'breaking'.
 *  Week-6+ Addition #13: `'policy_fail_fast'` joins when an operator-set
 *  fail-fast threshold is crossed. */
export interface VerdictResult {
  verdict: Verdict;
  reason: string;
  gateResults: GateResults;
  healthResult: HealthResult | null;
  shortCircuit: 'policy' | 'approval' | 'state' | 'srm' | 'policy_fail_fast' | null;
  policyCtx?: PolicyContext;
  /** Week-6+ Addition #13: sticky fail-fast state emitted on every tick so
   *  callers can thread it into the next tick. Once `.tripped` becomes
   *  true, stays true for the deploy. */
  failFastState?: FailFastState;
  /** Week-6+ Addition #14: per-deploy lifecycle state after this tick's
   *  emissions. Reflects the once-per-deploy emit latches and any
   *  per-family suppression transitions observed. Absent when the
   *  caller did not thread a lifecycle emitter through. */
  lifecycleState?: import('../o0/lifecycle-events').LifecycleDeployState;
  /** Week-6+ Addition #5: deploy-level reversibility classification set
   *  once at tick 0 (via `classifyReversibility`) and threaded across
   *  ticks. Callers pass it back in on subsequent ticks so the
   *  classifier doesn't re-run. Values populate the v2 audit record's
   *  `reversibility` + `reversibility_source` fields. */
  reversibilityClassification?: ReversibilityClassification;
  /** Week-6+ Addition #5: final action derived from the current tick's
   *  verdict via the O0 `translateVerdict` helper. Populated on every
   *  tick so callers see how a given verdict would be acted on given
   *  this deploy's reversibility classification. Real O0 adapters
   *  consume this translation and invoke orchestrator-native actions
   *  (rollback / pause_and_alarm / human_confirmation_required). */
  finalAction?: import('../o0/reversibility-translator').ReversibilityAction;
  /** Consolidated activation slice — aggregate Promise resolving when
   *  fan-out (topology enrichment + agent proposal) completes for a
   *  closed VerdictGroup this tick. Absent when no group closed on
   *  this tick or no fan-out was configured. Tests `await` this to
   *  synchronize on side-effects; production callers can ignore. */
  groupClosePromise?: Promise<GroupCloseFanoutResult>;
}

/** Consolidated activation slice — aggregate fan-out result. */
export interface GroupCloseFanoutResult {
  group_id: string;
  enriched?: VerdictGroupWithTopology;
  agent?: import('./agent').AgentResultLike;
  enrichment_error?: string;
  agent_error?: string;
}

// ── Fusion output + detector verdicts ─────────────────────────────

/** Fusion-layer output. Replaces the implicit cascade `Verdict` at the
 *  engine boundary for Week 4. `firing_families` is the set of families
 *  that fired this tick; `per_family_verdicts` carries the raw verdict
 *  per family (null when the family didn't evaluate — e.g. Family A
 *  returns an array of per-signal verdicts rather than a single one, so
 *  the portfolio aggregates A's first fire into `firing_families` but
 *  stores the list separately when needed).
 *
 *  `fusion_topology` is dual-mode during W4: both `cascade` (W3 baseline)
 *  and `portfolio` outputs are logged; portfolio promotes to primary once
 *  adversarial parity confirms. */
export interface FusedVerdict {
  verdict: 'rollback' | 'extend' | 'proceed' | 'baking';
  firing_families: Array<'A' | 'B' | 'C' | 'D' | 'E'>;
  per_family_verdicts: {
    A: DetectorVerdict[] | null;
    B: FiredSignal[] | null;
    C: DetectorVerdict | null;
    D: DetectorVerdict | null;
    E: DetectorVerdict | null;
  };
  total_alpha_spent: number;
  fusion_topology: 'cascade' | 'portfolio';
  tick: number;
  deploy_ref: string;
  /** WS5 verdict explainability. Generated 1-3 sentence rationale for
   *  `verdict`, built mechanically inside `fuseVerdict` from data
   *  already in scope there (no new statistics, no FM calls,
   *  deterministic — no timestamps/randomness):
   *   - `rollback`: which families fired, on which signals.
   *   - `extend`: which families are accumulating evidence
   *     (indeterminate) and which were suppressed (with
   *     `suppression_reason`).
   *   - `proceed` / `baking`: all families clean / in-window.
   *  See `EvidenceOutlookEntry` for the structured per-family
   *  breakdown this is rendered from. */
  verdict_rationale: string;
  /** WS5 verdict explainability. Per-family evidence summary, fixed
   *  A<B<C<D<E order. Every family emits at least one entry every tick;
   *  Family C emits ONE entry when only its Hotelling or only its e-MMD/
   *  betting detector has data, and TWO entries (`family_id: 'C'` twice,
   *  discriminated by `detector_kind`) when both are present — see
   *  `EvidenceOutlookEntry.detector_kind` for why: Hotelling's χ² path
   *  and its safe-test wealth path, and the e-MMD/betting path, are on
   *  numerically incomparable scales and must never collapse into one
   *  `progress` ratio (2026-07 Important-finding fix). */
  evidence_outlook: EvidenceOutlookEntry[];
}

/** Per-family entry in `FusedVerdict.evidence_outlook` (WS5 verdict
 *  explainability). Derived strictly from data `fuseVerdict` already
 *  receives via its `HealthResult` argument — the same
 *  `DetectorVerdict`/`FiredSignal` values used to compute
 *  `firing_families` / `per_family_verdicts`. No new orchestrator
 *  parameters are threaded in for this. */
export interface EvidenceOutlookEntry {
  family_id: 'A' | 'B' | 'C' | 'D' | 'E';
  /** `'fired'` mirrors `firing_families` membership for this family;
   *  `'accumulating'` when any evaluated detector in the family is
   *  `indeterminate`; `'suppressed'` when every evaluated detector in
   *  the family suppressed; `'clean'` otherwise (including families
   *  that produced no `DetectorVerdict`/`FiredSignal` this tick).
   *  Family B (structural rules) never reports `'accumulating'` or
   *  `'suppressed'` — it has no such concept (see header comment in
   *  engine/verdict.ts: "Family B doesn't spend Ville budget"). */
  state: 'fired' | 'accumulating' | 'clean' | 'suppressed';
  /** `statistic / threshold`, max across the family's SAME-SCALE
   *  detectors this tick (see `progress_scale` — never mixed across
   *  scales). Mirrors the formula the audit layer uses for Family A's
   *  `DetectorTripV2.cusum_progress` (`engine/_audit-families.ts`
   *  `tripFromVerdict`), applied here to every DetectorVerdict-shaped
   *  family (A/C/D/E all carry `statistic`/`threshold`) rather than
   *  restricting to Family A — that restriction in the audit layer is
   *  an emission-scope choice for already-fired trips, not a
   *  data-availability limit; the same ratio is informative for
   *  not-yet-fired (`indeterminate`) detectors too, which is the
   *  primary use case for this field's `extend`-verdict narrative.
   *  `null` when no detector in the family carries both a non-null
   *  `statistic` and a positive `threshold` — always `null` for
   *  Family B, whose `FiredSignal` entries carry neither field. */
  progress: number | null;
  /** How `progress` should be read — `null` iff `progress` is `null`
   *  (Family B always; other families when unavailable this tick).
   *
   *  `'linear'`: the statistic accumulates roughly additively toward a
   *  fixed threshold (Family A Page-CUSUM `S_n` vs `-log(α)`; Family C
   *  legacy χ² Hotelling T² vs a Wilson-Hilferty quantile) — "N% of
   *  fire threshold" is an honest closeness read.
   *
   *  `'wealth'`: the statistic is a Ville's-inequality wealth
   *  martingale `M_t = M_{t-1} · e_t` compared against `threshold =
   *  1/α` (Family C e-MMD/betting always; Family C safe-Hotelling,
   *  Family D's spectral e-detector, and Family E's weighted e-value
   *  when that variant is active — see `engine/verdict.ts`
   *  `progressScaleFor` for the per-evaluator citations). `M_t` starts
   *  at 1 and compounds multiplicatively tick-over-tick, so it can sit
   *  at a small fraction of `threshold` for many ticks and then cross
   *  it within one or two — "N% of fire threshold" phrasing would read
   *  as smooth linear progress when it is not; renderers must use the
   *  multiplicative ("0.72× fire threshold, compounds under sustained
   *  drift") phrasing instead. */
  progress_scale: 'linear' | 'wealth' | null;
  /** Set ONLY on Family C entries, and only to disambiguate which of
   *  Family C's two structurally-independent detectors (`famC` /
   *  `famCMmd` in `engine/verdict.ts`) this entry summarizes — undefined
   *  everywhere else, and undefined on the single default Family C
   *  entry emitted when neither detector produced data this tick.
   *  `'hotelling'` covers both the legacy χ² Hotelling T² variant
   *  (`progress_scale: 'linear'`) and the safe-Hotelling wealth variant
   *  (`progress_scale: 'wealth'`) — the KIND (Hotelling vs e-MMD/
   *  betting) is what's structural here (`evaluateFamilyC` vs
   *  `evaluateEMmd`/`evaluateFamilyCBettingEProcess`); the χ²-vs-safe
   *  sub-variant is resolved per-entry via `progress_scale` already.
   *  `'e_mmd_betting'` is always `progress_scale: 'wealth'` — every
   *  Family C e-MMD/betting evaluator (`evaluateEMmd`,
   *  `evaluateFamilyCBettingEProcess`) is a Ville's-inequality wealth
   *  process by construction. */
  detector_kind?: 'hotelling' | 'e_mmd_betting';
  /** One-sentence human-readable rendering of `state`/`progress`/
   *  suppression reason, e.g. "Family A accumulating evidence at 42%
   *  of fire threshold", "Family C (e-MMD/betting) accumulating
   *  evidence, wealth at 0.72× fire threshold (multiplicative —
   *  evidence can compound quickly under sustained drift)", or
   *  "Family D suppressed (ignore_threshold)". */
  note: string;
}

/** A single detector's verdict at one tick. Week 3 adds `alpha_spent` per
 *  ARCHITECT-REPLY-09.md Q3 — binary L3-consumable field, distinct from
 *  the cumulative `alpha_consumed` (which W4 renames to `cusum_progress`). */
export interface DetectorVerdict {
  verdict: 'fire' | 'indeterminate' | 'clean' | 'suppressed';
  statistic: number | null;
  threshold: number | null;
  /** Deprecated-name-retained-for-W3. Cumulative per-tick α contribution;
   *  not the Ville's-inequality budget. W4 audit schema v2 renames to
   *  `cusum_progress` and deprecates this name. */
  alpha_consumed: number | null;
  /** Week 3 addition (ARCHITECT-REPLY-09.md Q3). Binary budget-accounting:
   *  `α_per_signal` on `verdict === 'fire'`, `0` otherwise. L3 fusion in
   *  Week 4 sums these for total-α accounting. */
  alpha_spent: number;
  reason_code: string;
  family: 'A' | 'B' | 'C' | 'D' | 'E';
  /** Which signal this verdict is for. */
  signal?: string;
  /** Addition #13 audit enrichment (ARCHITECT-REPLY-31 §"On TPM's
   *  audit-enrichment ask"). Populated on Family A single-signal
   *  suppression records when `reason_code === 'ignore_threshold'`;
   *  identifies the signal whose in-band observation caused the
   *  suppression. Family C/E don't emit this field — they don't
   *  suppress under `ignore_thresholds` (per ARCHITECT-REPLY-31
   *  multivariate semantic). */
  ignore_threshold_trigger_signal?: string;
}

// ── Addition #25 (ARCHITECT-REPLY-47) — L3b VerdictGroup aggregator ──
//
// Post-L3 incident-aggregation layer. L3 (engine/verdict.ts) emits
// FusedVerdict per tick unchanged; L3b (engine/verdict-groups.ts)
// consumes that stream and produces VerdictGroup per incident. The
// aggregation is summary-only — the gating hot path is untouched,
// so groups carry zero latency penalty (D6).
//
// A group is scoped to (deploy_id, window_start_ts). Close triggers:
// window elapsed (D2 default 300s) or terminal verdict received via
// the evaluation.finished lifecycle event. Late-arrival verdicts
// within `grace_seconds` (D5 default 300s) attach as
// `late_arrival_verdicts` without re-opening the group.

/** Human-readable stable-sorting group identifier.
 *  Format: `group-{deploy_id}-{window_start_ts}` per ARCHITECT-REPLY-47
 *  Q1. UUID fallback reserved for collision cases (should not occur by
 *  construction — (deploy_id, window_start_ts) is unique). */
export type VerdictGroupId = string;

/** Aggregated-incident summary. References individual FusedVerdicts by
 *  value so audit provenance is preserved without duplicating the fused
 *  output. See NS-ARCH §L3b. */
export interface VerdictGroup {
  group_id: VerdictGroupId;
  deploy_id: string;
  /** Epoch seconds (numeric). First-ingested verdict's timestamp. */
  window_start_ts: number;
  /** Epoch seconds. Actual close time (when `closed_at_ts` is set) or
   *  the nominal `window_start_ts + window_seconds` while open. */
  window_end_ts: number;
  /** All FusedVerdicts attributed to this group in ingest order. */
  verdicts: FusedVerdict[];
  /** Subset of `verdicts` where `firing_families.length > 0`. */
  firing_verdicts: FusedVerdict[];
  /** Earliest-firing FusedVerdict by `tick`, tie-broken by
   *  `total_alpha_spent` (highest wins). `null` on all-silent groups. */
  root_cause: FusedVerdict | null;
  /** `min(1, k / confidence_saturation)` where k = count of distinct
   *  firing families in the group. */
  confidence: number;
  /** Late-arrival verdicts attached within the grace window post-close.
   *  Also appended to `verdicts` / `firing_verdicts` as appropriate. */
  late_arrival_verdicts: FusedVerdict[];
  closed: boolean;
  /** Epoch seconds at close; `null` while open. */
  closed_at_ts: number | null;
}

// ── Addition #26 (ARCHITECT-REPLY-48) — Topology overlay (Smartscape-lite) ──
//
// Post-#25 enrichment layer. VerdictGroup stays topology-agnostic (D5);
// VerdictGroupWithTopology is a separate artifact referencing the group
// by `group_id`. Enrichment is non-blocking (orchestrator fires it
// async post-VerdictGroup-close; does not gate emission).
//
// TopologySource is an abstract interface (D1 Option E) so v2 can add
// Istio / K8s / Linkerd impls without schema churn at the
// VerdictGroupWithTopology layer. v1 concrete impl is OtelServiceGraphV1.
//
// Snapshot hash (D6) is deterministic across runs: sha256 over sorted
// node-list + sorted edge-list JSON. Stored on the artifact at
// enrichment time; viewer compares to live hash at render time.

/** Node in a service-graph snapshot. */
export interface TopologyNode {
  /** Stable identifier within a snapshot (e.g., fully-qualified
   *  service name, or OTel resource id). Used for BFS + hashing. */
  id: string;
  service_name: string;
  kind: 'service' | 'database' | 'queue' | 'external';
  metadata?: Record<string, string>;
}

/** Directed edge in a service-graph snapshot. */
export interface TopologyEdge {
  /** Source node id (caller / reader / writer / publisher). */
  from: string;
  /** Target node id (callee / owning store). */
  to: string;
  relationship: 'calls' | 'reads' | 'writes' | 'publishes';
  metadata?: Record<string, string>;
}

/** Normalized service-graph snapshot returned by a TopologySource. */
export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Epoch seconds of snapshot fetch. */
  fetched_at_ts: number;
  /** Matches the producing TopologySource.id (e.g., 'otel_service_graph_v1'). */
  source_id: string;
  /** Source-specific version string. */
  source_version: string;
}

/** A correlational candidate surfaced for a VerdictGroup. Explicitly
 *  NOT a causal claim per D4 — `correlational_not_causal: true` is a
 *  required literal label on the wire. */
export interface TopologyCandidate {
  node_id: string;
  service_name: string;
  /** Hop count from the group's deploy-service node (0 = same node,
   *  1 = direct neighbor, bounded at `topology_max_hop_distance`). */
  topology_distance: number;
  /** [0, 1] intersection-over-union of the candidate event's window
   *  with the group's [window_start_ts, window_end_ts]. Point events
   *  fall back to an in-window indicator. */
  temporal_overlap_ratio: number;
  candidate_event_type: 'deploy' | 'incident' | 'alert' | 'unknown';
  candidate_event_id: string;
  candidate_event_ts: number;
  /** Literal `true` per D4; exists to force audit consumers to
   *  acknowledge the non-causal labeling in type contracts. */
  correlational_not_causal: true;
}

/** Audit-visible enrichment artifact. References a VerdictGroup by
 *  `group_id` rather than extending it (D5 strict-additive). */
export interface VerdictGroupWithTopology {
  group_id: VerdictGroupId;
  topology_source_id: string;
  /** Deterministic sha256 over sorted `snapshot.nodes` + sorted
   *  `snapshot.edges`. `null` when enrichment failed before a
   *  snapshot could be hashed. */
  topology_snapshot_hash: string | null;
  /** Ranked per D4: `temporal_overlap_ratio` descending first,
   *  `topology_distance` ascending second, then `node_id`
   *  lexicographic for deterministic tie-break. Empty on no
   *  candidates or on enrichment failure. */
  candidates: TopologyCandidate[];
  enriched_at_ts: number;
  /** Populated when enrichment degraded (timeout / malformed
   *  response / source unreachable); null on clean enrichment.
   *  Architect Q1 lean: emit-with-error over silent failure. */
  enrichment_error?: string | null;
}

/** Per-ingest candidate event associated with a topology node. Source
 *  (CI/CD, incident bus, alerting) stays customer-side; DS receives a
 *  normalized list and performs temporal-overlap scoring against the
 *  containing VerdictGroup's window. Architect Q2 leaves OTel-spec
 *  version normalization to implementation time. */
export interface TopologyCandidateEvent {
  /** Must match a node.id in the snapshot. */
  node_id: string;
  event_type: 'deploy' | 'incident' | 'alert' | 'unknown';
  event_id: string;
  /** Point-event timestamp in epoch seconds. */
  event_ts: number;
  /** Optional interval-event window (epoch seconds). When both are
   *  present, overlap uses intersection-over-union; otherwise the
   *  point-event indicator at `event_ts`. */
  event_window_start_ts?: number;
  event_window_end_ts?: number;
}

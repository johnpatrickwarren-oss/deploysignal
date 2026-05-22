# Q30 — Cairn structured-RCA attribution spec

_From: Architect. To: Implementer (this session — solo, audit-tier round-scaling per Anchor `11-round-scaling`)._
_Date: 2026-05-21._
_Foundation: [PRD-30-cairn.md](PRD-30-cairn.md) + Addition #9 (DeployContext) + Addition #25 (VerdictGroup, NORTH-STAR-ARCHITECTURE.md:1257) + Addition #29 (Anvil ExpectedFailurePattern, NORTH-STAR-ARCHITECTURE.md:1133) + audit/SCHEMA.md v2._
_Type: full implementation brief (inline ceremony)._
_Sequencing: independent of in-flight work. Substantive product layer (real attribution math), not a positioning-only addition._

_Framework: Anchor methodology (Q-NN-SPEC-TEMPLATE; Architect role; T0 anchor)._

---

## Spec

Build **Cairn** — the structured-RCA / postmortem attribution layer of the DS bundle. Lands as: (a) typed contracts under `engine/cairn/`; (b) a real Bayesian alignment-scoring function that ranks candidate cause-events against an observed incident's onset; (c) ingest helpers that extract candidate events from the existing DS audit JSONL + Tessera VerdictGroup wire format + Anvil chaos-experiment records + a generic external-event JSON shape; (d) a CLI tool `tools/cairn.js` that runs the attribution end-to-end and prints a ranked report; (e) ≥ 15 tests; (f) a synthetic demo + walkthrough doc; (g) positioning docs (NORTH-STAR Addition #30 + GAP-30 + README + ANTI-SCOPE-LEDGER Q30).

Closes PRD-30 AC-1 through AC-10. The lifecycle-loop framing is the load-bearing pitch beat: **DS catches before promotion. Tessera observes during steady state. Cairn attributes when something escapes both — statistically, not by eyeballing dashboards.**

Preserves Q2.B.6.4 ADR clauses 1–5 exactly: no new detector family; Cairn is a **scoring layer** that consumes the existing engine's outputs (and operator-supplied onset estimates), not a new `engine/detectors/*` module.

## Architectural mechanism

Three composed surfaces:

1. **Candidate enumeration.** `engine/cairn/ingest.ts` exports four small helpers that walk each known audit-stream shape and emit `AttributionCandidate[]`. Each candidate carries `{ cause_id, cause_kind, timestamp_unix, evidence_ref, optional metadata }`. The helpers are pure functions over the existing wire shapes — no new schema land at Cairn v1.

2. **Alignment scoring** (the load-bearing math). `engine/cairn/score.ts` exports `scoreCandidate(c, incident, config) → number` and `rankCandidates(cs, incident, config) → RankedAttribution`. The score is the product of three independent terms:

   - **Timestamp-alignment kernel** `K(Δt, σ_kind)` — Gaussian centered at zero lag, evaluated at `Δt = incident.onset_time_unix - candidate.timestamp_unix`. Bandwidth `σ_kind` depends on `cause_kind` (deploys ~30min; chaos ~5min; dependency changes ~2hr; env ~6hr; shard ~15min; generic ~1hr). Candidates with `Δt < -grace` (cause after incident) get kernel value 0 — mechanistic-inconsistency suppression.
   - **Per-kind prior** `π(kind)` — operator's base-rate belief that this kind is the typical incident cause. Default `π(deploy) = 0.35, π(chaos) = 0.20, π(dependency) = 0.15, π(env) = 0.10, π(shard) = 0.10, π(generic) = 0.10` (sums to 1.0 for normalization sanity but not strictly required since output is normalized).
   - **Evidence-quality boost** `e(candidate)` — multiplier applied based on what the candidate's evidence carries. A DS audit record with `verdict: 'extend'` adjacent in time to the incident gets boost 1.5 (engine flagged it as concerning); a DS record with `verdict: 'rollback'` that the operator overrode gets boost 2.0; a DS record with `verdict: 'proceed'` and `alpha_consumed < 0.001 × α_budget` gets boost 0.5 (negative evidence — engine emitted positive clean signal; PRD-30 OQ-30.3 resolution); plain timestamp-only candidates get boost 1.0.

   Final raw score: `s(c) = K(Δt, σ_kind(c)) × π(kind(c)) × e(c)`. Posterior is `p(c) = s(c) / Σ s(c')`.

3. **Ranked-attribution output.** `RankedAttribution = { ranked: Array<{ candidate, posterior, alignment_score, kind_prior, evidence_boost, kernel_value }>, suppressed: Array<{ candidate, suppression_reason }> }`. The ranked array is sorted by posterior descending; the suppressed array carries candidates with `kernel_value === 0` (mechanistic inconsistency).

The CLI `tools/cairn.js` glues these together: parses a JSON incident definition + a JSON candidates source (one of the four shapes), calls `rankCandidates`, prints the report. Replay-clean: same inputs → byte-identical output. The output JSON also lands at a stable path for `--check` mode and downstream consumers (postmortem-doc auto-fill, audit substrate).

---

## Existing architectural surface (REVIEWER-ANCHOR — mandatory)

| Inherited file | Pinned SHA | Lines opened | Verbatim snippet | Date+time opened |
|---|---|---|---|---|
| `engine/types/audit.ts` | `7eded78` | 128–142 | `FamilyVerdictV2` shape with extended `suppression_reason` enum including `'expected_failure_pattern'` (added Q29) — Cairn ingest reads `AuditRecordV2` fields | 2026-05-21 |
| `engine/types/verdict.ts` | `7eded78` | 115–139 | `DetectorVerdict` interface — Cairn's evidence-quality boost reads `verdict` + `alpha_consumed` + `alpha_spent` from per-family DetectorTrips | 2026-05-21 |
| `engine/o0/anvil/types.ts` | `7eded78` | (full file) | `ExpectedFailurePattern` shape — Cairn `candidatesFromAnvilExperiments` reads `{ kind, fault_start_unix, recovery_seconds, affected_signals }` per experiment | 2026-05-21 |
| `NORTH-STAR-ARCHITECTURE.md` | `7eded78` | 1257 | "`VerdictGroup` … L3b incident-aggregation layer … one per incident scoped to (deploy_id, window_start_ts)" — Cairn's per-incident candidate-grouping rides on this primitive | 2026-05-21 |
| `audit/SCHEMA.md` | `7eded78` | (full file referenced as v2 audit-substrate authority) | Schema v2 for `AuditRecord`/`AuditRecordV2` — Cairn ingests JSONL output of the writer in `engine/audit.ts` | 2026-05-21 |

**Architect self-attest checklist (tick at emit time):**

- [x] Files opened at brief-drafting time via this session's Read/Grep tool calls.
- [x] Snippet citations verbatim from pinned SHA `7eded78` (post-PR-19 merge to main).
- [x] Line numbers verified against file content at the pinned SHA.

---

## Open questions resolved at spec-emit (Q30.1 → Q30.3)

### Q30.1 — Engine-inferred onset consumption (PRD-30 OQ-30.1)

**Architect-pick: ENGINE-INFERRED-WHEN-AVAILABLE PICKED.**

**Why:** When a DS audit record adjacent in time to the incident's onset signal carries a Page-CUSUM fire-tick or a BOCPD run-length posterior peak, that estimate is statistically tighter than the operator's "onset_time = the time PagerDuty alerted me" point estimate (which can lag the actual change-point by minutes). For v1, Cairn looks for the engine-inferred onset on the incident's primary `affected_signal`; if present, the timestamp-alignment kernel uses the engine's onset distribution (Gaussian centered at fire-tick, σ = half the confidence-band width); if absent, falls back to operator-supplied point.

**Why operator-point-only rejected:** Throws away available statistical evidence. The operator's `onset_time_unix` is a defensible default; the engine's fire-tick is strictly more informative when available.

### Q30.2 — Per-cause-kind kernel defaults: per-call vs per-profile (PRD-30 OQ-30.2)

**Architect-pick: PER-CALL CONFIG OBJECT PICKED.**

**Why:** Cairn v1 is one-incident-at-a-time (PRD-30 AS-4). Per-call config is sufficient at v1; the operator runs Cairn against a specific incident and supplies the stack-specific kernel bandwidths inline. Per-profile defaults (analogous to Addition #28) are Slice 2 if customers run Cairn batch-mode against many incidents and want stable defaults across runs.

### Q30.3 — Negative-evidence boost (PRD-30 OQ-30.3)

**Architect-pick: YES PICKED.**

**Why:** Operationally critical. The most common false-attribute is "we deployed something just before the incident, so the postmortem blames the deploy" — when DS's gate-time analysis emitted `proceed` with low α consumption, that's positive evidence the deploy *isn't* the load-bearing cause. Without negative-evidence boost, Cairn's timestamp-alignment kernel will rank the recently-merged deploy first by default. With it, a clean DS verdict explicitly lowers the score of that candidate. Evidence-quality boost `e(c)` defaults to `1.0` (no info); a DS `proceed`-verdict adjacent to the candidate's timestamp drops it to `0.5`; a DS `extend`-verdict raises it to `1.5`; a DS `rollback`-verdict (overridden by operator and shipped anyway) raises it to `2.0`. The boost is multiplicative on the score, not additive on the posterior, so a `proceed`-verdict doesn't zero-out a high-kernel candidate — it just downweights.

**Why no rejected:** Would invite the most common postmortem pitfall (blame-the-deploy reflex). Cairn's whole pitch is statistically-rigorous attribution; ignoring positive evidence-of-innocence would be honesty-breach.

---

## Implementation surface

### File: `engine/cairn/types.ts` (new)

```ts
// engine/cairn/types.ts — Cairn (Addition #30 / PRD-30 / Q30) typed contracts.

/** A single cause-event candidate that Cairn considers. */
export interface AttributionCandidate {
  cause_id: string;
  cause_kind: CandidateKind;
  /** Unix-seconds when the cause-event happened. */
  timestamp_unix: number;
  /** Provenance — pointer back to the source audit record / experiment /
   *  webhook payload. Replay/post-mortem trace artifact. */
  evidence_ref: string;
  /** Optional engine-side metadata that ingest helpers populate when
   *  available (e.g., DS verdict + alpha_consumed for evidence-quality
   *  boost; Anvil expected_failure_pattern for chaos experiments). */
  metadata?: CandidateMetadata;
}

export type CandidateKind =
  | 'deploy'              // DS audit record
  | 'chaos_experiment'    // Anvil ExpectedFailurePattern
  | 'dependency_change'   // generic external event
  | 'env_change'          // generic external event (config rollout, infra)
  | 'shard_event'         // Tessera per-shard observation
  | 'generic';            // catch-all for external webhooks

export interface CandidateMetadata {
  /** When the candidate came from a DS audit record, the engine's verdict
   *  drives the evidence-quality boost. */
  ds_verdict?: 'proceed' | 'extend' | 'rollback' | 'baking';
  /** When DS evaluated the candidate, how much α the engine consumed
   *  relative to the deploy's budget. Used in negative-evidence detection
   *  (low α + proceed = strong "this isn't the cause" signal). */
  ds_alpha_consumed_ratio?: number;
  /** Anvil-only: pattern of the chaos experiment (gives "what should fire"
   *  context to the attribution narrative). */
  expected_failure_kind?: string;
  /** Free-form passthrough — Tessera VerdictGroupId, incident-mgmt
   *  payload, etc. */
  extra?: Record<string, unknown>;
}

/** Operator's description of the incident under attribution. */
export interface IncidentDefinition {
  incident_id: string;
  /** Best-known onset time (from incident-mgmt, alert ts, oncall report). */
  onset_time_unix: number;
  /** Signal(s) that exhibited the regression. Drives which engine-inferred
   *  onset distributions Cairn looks for in the candidate set. */
  affected_signals: string[];
  regression_magnitude_unit?: 'relative_fraction' | 'absolute' | 'sigma';
  regression_magnitude?: number;
  /** Optional engine-inferred onset distribution if the operator has it
   *  (DS audit record's Page-CUSUM fire-tick + confidence band, or BOCPD
   *  run-length posterior). When present, supersedes onset_time_unix for
   *  kernel evaluation per Q30.1. */
  engine_onset_estimate?: {
    center_unix: number;
    sigma_seconds: number;
  };
}

export interface CairnScoringConfig {
  /** Gaussian-kernel bandwidth per cause-kind, in seconds. Defaults
   *  per Q30.2 architect-pick. */
  kernel_sigma_seconds?: Partial<Record<CandidateKind, number>>;
  /** Per-kind prior; defaults per Q30 spec architect-table. */
  kind_prior?: Partial<Record<CandidateKind, number>>;
  /** Grace window post-incident: a candidate with timestamp ∈
   *  [onset, onset + grace_seconds] is still considered (clock skew,
   *  delayed event-recording). Default 60 seconds. Beyond grace,
   *  mechanistic-inconsistency suppression applies. */
  grace_seconds?: number;
  /** Optional override for evidence-quality boosts (default table
   *  applied if absent). */
  evidence_boost?: Partial<Record<'proceed' | 'extend' | 'rollback' | 'baking', number>>;
}

export interface ScoredCandidate {
  candidate: AttributionCandidate;
  /** Normalized posterior (sums to 1.0 across all ranked candidates). */
  posterior: number;
  /** Raw unnormalized score (kernel × prior × evidence). */
  raw_score: number;
  /** Per-component breakdown for audit + UI. */
  kernel_value: number;
  kind_prior: number;
  evidence_boost: number;
}

export interface SuppressedCandidate {
  candidate: AttributionCandidate;
  suppression_reason:
    | 'post_incident_timestamp'   // timestamp after onset + grace
    | 'kernel_underflow';         // kernel value below numerical threshold
}

export interface RankedAttribution {
  /** Sorted by posterior descending. */
  ranked: ScoredCandidate[];
  /** Excluded from posterior normalization. */
  suppressed: SuppressedCandidate[];
  /** Echo of the incident under attribution for replay-clean output. */
  incident: IncidentDefinition;
  /** Echo of the effective config (after defaults filled in). */
  config_used: Required<Omit<CairnScoringConfig, 'evidence_boost'>> & {
    evidence_boost: Record<'proceed' | 'extend' | 'rollback' | 'baking', number>;
  };
}
```

### File: `engine/cairn/score.ts` (new)

```ts
// engine/cairn/score.ts — Cairn alignment scoring (Q30 § Architectural mechanism §2).
//
// Pure functions. No engine/detectors/* touch (Q2.B.6.4 ADR preserved).

import type {
  AttributionCandidate, CandidateKind, IncidentDefinition,
  CairnScoringConfig, ScoredCandidate, SuppressedCandidate,
  RankedAttribution,
} from './types';

const DEFAULT_KERNEL_SIGMA_SECONDS: Record<CandidateKind, number> = {
  deploy: 30 * 60,            //  30 minutes
  chaos_experiment: 5 * 60,   //   5 minutes
  dependency_change: 2 * 3600, //   2 hours
  env_change: 6 * 3600,       //   6 hours
  shard_event: 15 * 60,       //  15 minutes
  generic: 1 * 3600,          //   1 hour
};

const DEFAULT_KIND_PRIOR: Record<CandidateKind, number> = {
  deploy: 0.35,
  chaos_experiment: 0.20,
  dependency_change: 0.15,
  env_change: 0.10,
  shard_event: 0.10,
  generic: 0.10,
};

const DEFAULT_EVIDENCE_BOOST = {
  proceed: 0.5,   // negative evidence — engine emitted clean
  extend: 1.5,    // engine was concerned
  rollback: 2.0,  // engine flagged, operator overrode (strong attribution)
  baking: 1.0,    // engine hadn't decided yet — neutral
};

const DEFAULT_GRACE_SECONDS = 60;
const KERNEL_UNDERFLOW = 1e-12;

function gaussianKernel(deltaSeconds: number, sigmaSeconds: number): number {
  const z = deltaSeconds / sigmaSeconds;
  return Math.exp(-0.5 * z * z);
}

function effectiveConfig(config: CairnScoringConfig): RankedAttribution['config_used'] {
  return {
    kernel_sigma_seconds: { ...DEFAULT_KERNEL_SIGMA_SECONDS, ...(config.kernel_sigma_seconds ?? {}) } as Record<CandidateKind, number>,
    kind_prior: { ...DEFAULT_KIND_PRIOR, ...(config.kind_prior ?? {}) } as Record<CandidateKind, number>,
    grace_seconds: config.grace_seconds ?? DEFAULT_GRACE_SECONDS,
    evidence_boost: { ...DEFAULT_EVIDENCE_BOOST, ...(config.evidence_boost ?? {}) },
  };
}

function evidenceBoostFor(
  candidate: AttributionCandidate,
  evidence_boost: Record<string, number>,
): number {
  const v = candidate.metadata?.ds_verdict;
  if (v && v in evidence_boost) {
    let boost = evidence_boost[v];
    // Sharpen negative evidence: a proceed with very low α consumed is
    // stronger "this isn't the cause" than a proceed with moderate α.
    if (v === 'proceed' && candidate.metadata?.ds_alpha_consumed_ratio !== undefined) {
      const ratio = candidate.metadata.ds_alpha_consumed_ratio;
      if (ratio < 0.05) boost *= 0.75;
    }
    return boost;
  }
  return 1.0;
}

/** Score one candidate against the incident. Returns the raw unnormalized
 *  score; rankCandidates does the cross-candidate normalization. */
export function scoreCandidate(
  candidate: AttributionCandidate,
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): {
  raw_score: number;
  kernel_value: number;
  kind_prior: number;
  evidence_boost: number;
  suppressed: SuppressedCandidate | null;
} {
  const cfg = effectiveConfig(config);

  // Choose the alignment center + sigma: prefer engine-inferred onset
  // (Q30.1 architect-pick) when present.
  let centerUnix: number;
  let effectiveSigma: number;
  if (incident.engine_onset_estimate) {
    centerUnix = incident.engine_onset_estimate.center_unix;
    // Combine engine-onset uncertainty with per-kind kernel via quadrature.
    const engineVar = incident.engine_onset_estimate.sigma_seconds ** 2;
    const kindVar = cfg.kernel_sigma_seconds[candidate.cause_kind] ** 2;
    effectiveSigma = Math.sqrt(engineVar + kindVar);
  } else {
    centerUnix = incident.onset_time_unix;
    effectiveSigma = cfg.kernel_sigma_seconds[candidate.cause_kind];
  }

  const delta = centerUnix - candidate.timestamp_unix;

  // Mechanistic-inconsistency suppression: candidate timestamp after onset
  // (beyond grace window) cannot have caused the incident.
  if (delta < -cfg.grace_seconds) {
    return {
      raw_score: 0,
      kernel_value: 0,
      kind_prior: cfg.kind_prior[candidate.cause_kind],
      evidence_boost: evidenceBoostFor(candidate, cfg.evidence_boost),
      suppressed: { candidate, suppression_reason: 'post_incident_timestamp' },
    };
  }

  const kernel_value = gaussianKernel(Math.max(0, delta), effectiveSigma);
  const kind_prior = cfg.kind_prior[candidate.cause_kind];
  const evidence_boost = evidenceBoostFor(candidate, cfg.evidence_boost);
  const raw_score = kernel_value * kind_prior * evidence_boost;

  const suppressed: SuppressedCandidate | null =
    kernel_value < KERNEL_UNDERFLOW
      ? { candidate, suppression_reason: 'kernel_underflow' }
      : null;

  return { raw_score, kernel_value, kind_prior, evidence_boost, suppressed };
}

/** Rank candidates by alignment posterior. Output is replay-clean:
 *  sort is stable by (posterior desc, then timestamp asc) for determinism. */
export function rankCandidates(
  candidates: AttributionCandidate[],
  incident: IncidentDefinition,
  config: CairnScoringConfig = {},
): RankedAttribution {
  const cfg = effectiveConfig(config);
  const scored: ScoredCandidate[] = [];
  const suppressed: SuppressedCandidate[] = [];

  for (const c of candidates) {
    const s = scoreCandidate(c, incident, config);
    if (s.suppressed) {
      suppressed.push(s.suppressed);
      continue;
    }
    scored.push({
      candidate: c,
      posterior: 0,  // filled in below after normalization
      raw_score: s.raw_score,
      kernel_value: s.kernel_value,
      kind_prior: s.kind_prior,
      evidence_boost: s.evidence_boost,
    });
  }

  const total = scored.reduce((acc, s) => acc + s.raw_score, 0);
  for (const s of scored) s.posterior = total > 0 ? s.raw_score / total : 0;

  // Sort by posterior desc, then by timestamp asc for determinism.
  scored.sort((a, b) => {
    if (b.posterior !== a.posterior) return b.posterior - a.posterior;
    return a.candidate.timestamp_unix - b.candidate.timestamp_unix;
  });

  return {
    ranked: scored,
    suppressed,
    incident,
    config_used: cfg,
  };
}
```

### File: `engine/cairn/ingest.ts` (new)

```ts
// engine/cairn/ingest.ts — pure ingest helpers (PRD-30 AC-3).

import type { AttributionCandidate } from './types';

/** A minimal DS-audit-record shape Cairn reads (avoids importing the
 *  full AuditRecordV2 type to stay loosely coupled — the consumer side
 *  only needs the four fields below). */
interface MinimalDsRecord {
  deploy_id?: string;
  ts?: number;
  verdict?: 'proceed' | 'extend' | 'rollback' | 'baking';
  alpha_consumed?: number;
  alpha_budget?: number;
  config_version?: string;
}

export function candidatesFromDsAudit(records: MinimalDsRecord[]): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  for (const r of records) {
    if (!r.deploy_id || r.ts === undefined) continue;
    const ratio =
      r.alpha_consumed !== undefined && r.alpha_budget !== undefined && r.alpha_budget > 0
        ? r.alpha_consumed / r.alpha_budget
        : undefined;
    out.push({
      cause_id: `deploy:${r.deploy_id}`,
      cause_kind: 'deploy',
      timestamp_unix: r.ts,
      evidence_ref: `ds-audit:${r.deploy_id}@${r.ts}${r.config_version ? '#' + r.config_version : ''}`,
      metadata: {
        ds_verdict: r.verdict,
        ds_alpha_consumed_ratio: ratio,
      },
    });
  }
  return out;
}

interface MinimalTesseraPayload {
  group_id?: string;
  shard_id?: string;
  event_ts?: number;
  verdict?: string;
}

export function candidatesFromTesseraFeed(payloads: MinimalTesseraPayload[]): AttributionCandidate[] {
  const out: AttributionCandidate[] = [];
  for (const p of payloads) {
    if (!p.group_id || p.event_ts === undefined) continue;
    out.push({
      cause_id: `tessera-shard:${p.shard_id ?? 'unknown'}:${p.group_id}`,
      cause_kind: 'shard_event',
      timestamp_unix: p.event_ts,
      evidence_ref: `tessera-verdict-group:${p.group_id}`,
      metadata: { extra: { tessera_verdict: p.verdict, shard_id: p.shard_id } },
    });
  }
  return out;
}

interface MinimalAnvilExperiment {
  experiment_id: string;
  fault_start_unix: number;
  kind: string;
  affected_signals?: string[];
  recovery_seconds?: number;
}

export function candidatesFromAnvilExperiments(
  experiments: MinimalAnvilExperiment[],
): AttributionCandidate[] {
  return experiments.map((e) => ({
    cause_id: `chaos:${e.experiment_id}`,
    cause_kind: 'chaos_experiment',
    timestamp_unix: e.fault_start_unix,
    evidence_ref: `anvil-experiment:${e.experiment_id}`,
    metadata: {
      expected_failure_kind: e.kind,
      extra: {
        affected_signals: e.affected_signals,
        recovery_seconds: e.recovery_seconds,
      },
    },
  }));
}

export interface ExternalEvent {
  event_id: string;
  timestamp_unix: number;
  event_kind: 'dependency_change' | 'env_change' | 'generic';
  description?: string;
  source?: string;
}

export function candidatesFromExternalEvents(events: ExternalEvent[]): AttributionCandidate[] {
  return events.map((e) => ({
    cause_id: `external:${e.event_id}`,
    cause_kind: e.event_kind,
    timestamp_unix: e.timestamp_unix,
    evidence_ref: `${e.source ?? 'external'}:${e.event_id}`,
    metadata: { extra: { description: e.description } },
  }));
}
```

### File: `engine/cairn/index.ts` (new)

```ts
export type {
  AttributionCandidate, CandidateKind, CandidateMetadata,
  IncidentDefinition, CairnScoringConfig,
  ScoredCandidate, SuppressedCandidate, RankedAttribution,
} from './types';
export { scoreCandidate, rankCandidates } from './score';
export {
  candidatesFromDsAudit, candidatesFromTesseraFeed,
  candidatesFromAnvilExperiments, candidatesFromExternalEvents,
  type ExternalEvent,
} from './ingest';
```

### File: `tools/cairn.js` (new — CLI driver; pure-JS following the tools/demo-anvil.js pattern)

Pseudo-code:

```js
// Read incident definition from argv[2] (JSON file path).
// Read candidates from argv[3] (JSON file path; object with shape
//   { ds_records?: [...], tessera_payloads?: [...], anvil_experiments?: [...], external_events?: [...] }).
// Compose candidates via ingest helpers.
// Call rankCandidates(); print ranked + suppressed sections.
// --json flag → output structured JSON instead of ASCII.
// --check flag → compare against on-disk saved output; exit 1 if stale.
```

### File: `demos/cairn-attribution-walkthrough.json` (new — synthetic fixture)

Three candidate causes: a deploy, an Anvil chaos experiment, an env change. Cairn ranks the deploy first (closest timestamp + reasonable kind prior), the env change last (long-lag kernel + low prior), chaos experiment middle.

---

## Tests

### `test/q30-cairn-types.test.ts` (new)

Exhaustive enum coverage on `CandidateKind`; type-shape stability of `RankedAttribution`.

### `test/q30-cairn-score.test.ts` (new)

- Kernel: zero lag → 1.0; one-σ lag → ≈ 0.607; two-σ lag → ≈ 0.135.
- Mechanistic suppression: candidate ts > incident.onset_time + grace → suppressed with `post_incident_timestamp`.
- Engine-onset preference: when `incident.engine_onset_estimate` present, kernel center shifts.
- Evidence-quality boost: proceed-verdict candidate scores < neutral candidate < extend-verdict candidate (timestamp held equal).
- Negative-evidence sharpening: proceed + low α-consumed-ratio multiplies boost by 0.75.
- Posterior sums to 1.0 over the ranked set.
- Replay-clean: same inputs twice → byte-identical output (JSON.stringify equality).

### `test/q30-cairn-ingest.test.ts` (new)

One assertion per ingest helper covering: well-formed input passes through; missing-required-field rows are skipped (not thrown); metadata propagates.

### `test/q30-cairn-cli.test.ts` (new)

End-to-end: run `tools/cairn.js` against the demo fixture; assert the ranked report puts the deploy first.

---

## Acceptance criteria

Echoes PRD-30 AC-1 through AC-10. Each test case maps to ≥ 1 AC; final assertion is the full-suite pass count (977 pre-Cairn + ≥ 15 new = ≥ 992 passing, 0 fail).

---

## Anti-scope

Per [`skills/06-anti-scope-ledger.md`](https://github.com/johnpatrickwarren-oss/anchor/blob/main/skills/06-anti-scope-ledger.md):

- **NO `engine/detectors/*` runtime code change.** Cairn is a scoring layer atop the existing engine; Q2.B.6.4 ADR clauses 1–5 preserved.
- **NO causal-inference framing.** Cairn does alignment-based ranked attribution, not Pearl-style counterfactuals (PRD-30 AS-3). The output document language uses "ranked attribution of timing-consistent candidates," never "root cause."
- **NO live incident-mgmt webhook adapters at v1.** Generic `candidatesFromExternalEvents` ingest helper only; PagerDuty/Opsgenie/incident.io adapters are Slice 2.
- **NO new detector family for attribution.** Same as Q29 — preserves Q2.B.6.4.
- **NO multi-incident batch RCA at v1** (PRD-30 AS-4).
- **NO narrative auto-gen** (PRD-30 AS-5; out of Cairn scope, into advisory layer Addition #27).
- **NO web UI** (PRD-30 AS-6).
- **NO streaming attribution surface** (PRD-30 AS-7).

**Cross-references to ANTI-SCOPE-LEDGER:**

- **Q2.B.6.4 ADR clauses 1–5:** preserved (no `engine/detectors/*` touch).
- **Q29 ADR Anvil clauses 1–6:** preserved (Cairn consumes Anvil's `ExpectedFailurePattern` records as candidate events; doesn't extend Anvil semantics).
- **Q60 V2 clause 3 (no live customer telemetry):** preserved.
- **Enterprise-infrastructure boundary:** preserved.
- **No-skip policy:** preserved.

---

## Open questions (deferred to implementation-time empirical surface)

1. **OQ-Q30.1:** Should `engine_onset_estimate.sigma_seconds` derive from the Page-CUSUM confidence band when the audit record carries it (currently the operator supplies σ directly)? Architect-pre-prediction: yes is correct for v1 calibration but the existing audit schema doesn't yet emit a fire-tick σ; deferring auto-derivation to a follow-on cycle when the schema bumps. Implementer wires the operator-supplied path at v1; flags if the audit schema turns out to already carry the needed field.
2. **OQ-Q30.2:** The CLI `--json` output shape — should it mirror `RankedAttribution` 1:1 or wrap with a `cairn_report_version: 'v1'` envelope for forward-compat? Architect lean: envelope. Implementer confirms.

---

## Implementation timeline

**Implementer (this session): ~2–3h total.**

- ~10 min: `engine/cairn/types.ts`
- ~25 min: `engine/cairn/score.ts` (load-bearing math)
- ~15 min: `engine/cairn/ingest.ts` + `engine/cairn/index.ts`
- ~30 min: `tools/cairn.js` (CLI driver)
- ~45 min: ≥ 15 tests in `test/q30-cairn-*.test.ts`
- ~15 min: `demos/cairn-attribution-walkthrough.json` + `demos/CAIRN-DEMO.md`
- ~20 min: NORTH-STAR Addition #30 + COMPETITIVE-GAPS GAP-30 + README + ANTI-SCOPE-LEDGER Q30

---

## Architect grilling output (T0)

| Concern | Status |
|---|---|
| The score combines three independent terms (kernel × prior × evidence) without principled justification of the multiplicative form. Why not additive? | **FLAGGED + ACCEPTED.** Multiplicative is the natural choice when each term gates a different aspect: kernel is "is the timing consistent" (zero-one-ish), prior is "is this kind plausible," evidence is "does positive/negative evidence boost or dampen." Additive would let high evidence rescue low kernel (a deploy 8 hours after onset boosted to top of ranking by an extend-verdict) — clearly wrong. Multiplicative ensures zero-kernel kills the score regardless. Documented in spec §2. |
| Mechanistic suppression is a hard cutoff at `delta < -grace`. A deploy 65 seconds after onset with grace=60 gets suppressed; one at 55 seconds doesn't. Stepwise. | **FLAGGED + DEFERRED.** Smoother decay (one-sided Gaussian on the negative-Δ side) would be more honest but adds complexity. v1 ships hard cutoff; OQ-Q30.X candidate for Slice 2. |
| Negative-evidence-boost for `proceed`-verdict candidates uses 0.5 — that's an arbitrary multiplier; what's the principled value? | **FLAGGED + ACCEPTED.** Defaults are operator-tunable via `CairnScoringConfig.evidence_boost`. The principled value is workload-dependent (how often does DS clean a deploy that turns out to be the cause?); 0.5 is a starting point chosen to be strong-but-not-zeroing. Documented as a calibration knob, not a load-bearing constant. |
| Negative-evidence sharpening (low α-consumed-ratio × 0.75 extra) is a second tunable on top of the first — risk of overfitting in the calibration. | **FLAGGED + ACCEPTED.** Same posture: operator-tunable. Default is conservative (0.75 not 0.5). |
| Cairn is described as "consuming Tessera VerdictGroup wire format" but the test/demo fixture won't actually exercise a live Tessera feed at v1. | **FLAGGED + ACCEPTED.** v1 ships the typed contract surface and the synthetic-fixture exercise; a live Tessera-feed integration is Slice 2 (matches Anvil precedent). |
| Q2.B.6.4 ADR check: any path of this spec touch engine/detectors/*? | **CHECKED — NO.** Cairn is `engine/cairn/`, sibling to existing engine/* dirs. No detectors/* edits. |

**Memorial F sub-rules:**

- **Sub-rule 2 (schema-precedent-recheck):** No new schema added; Cairn consumes existing wire shapes via minimal interfaces with optional fields.
- **Sub-rule 3 (acceptance-criterion-coherence):** Every Q30 AC traces to a PRD-30 AC; every PRD-30 AC has a Q30 test.
- **Sub-rule 4 (pre-existing-property-coherence):** Preserved Ville-bound (no detector math change); back-compat byte-identical (Cairn ships as a new module — no existing path touched); no-skip policy (all Q30 tests assert).

---

## P3 ten-axis verification

| # | Axis | Status |
|---|---|---|
| 1 | concrete-values | PASS — kernel σ defaults derived from operational reasoning (deploys: 30min canary windows; chaos: 5min fault windows; dependency changes: 2hr observed lag; env changes: 6hr config-rollout window; shard: 15min observation windowing matches Tessera). |
| 2 | coord-trail | PASS — grep for collisions with PRD-30, Q29 ADR, prior coord artifacts; none found. |
| 3 | file-opened | PASS — § Existing architectural surface table. |
| 4 | function-bodies | N/A — no refactor; new module only. |
| 5 | compiled-artifacts | N/A — no calibration substrate touched. |
| 6 | input-pipeline-alignment | PASS — ingest helpers consume the existing audit/Tessera/Anvil wire shapes; no schema drift. |
| 7 | compile-time-precision | PASS — kernel uses Math.exp; underflow handled at threshold 1e-12. |
| 8 | regime-coverage | PASS — pre-Cairn regime untouched (Cairn is new module). |
| 9 | wrapper-vs-algorithm-layer | PASS — Cairn is scoring layer; engine algorithm-layer untouched. |
| 10 | firing-attribution-discipline | PASS — Cairn ranked output is the attribution surface itself; replay-clean per AC-6. |

---

_Spec based on Anchor Q-NN-SPEC-TEMPLATE + Anchor `08-architect-six-practices` + `03-four-anchor-defense` (T0 anchor) + `01-pre-emit-grilling`. Cross-references PRD-30 for FR/NFR/AC traceability + ANTI-SCOPE-LEDGER for ADR clause preservation._

# Architecture — current implemented state

> **Doc status:** describes what is implemented on `main` today.
> [`NORTH-STAR-ARCHITECTURE.md`](NORTH-STAR-ARCHITECTURE.md) is the *target*
> architecture (non-binding); [`CHEAT-SHEET.md`](CHEAT-SHEET.md) carries the
> statistical detail (α-budget, detector math, validation results). An earlier
> revision of this file described the pre-portfolio heuristic engine; that
> material is preserved in [§ Historical](#historical-the-heuristic-era-engine)
> below.

## Entry point and execution model

The engine's public entry point is a **pure per-tick function**:

```ts
evaluate(params: OrchestrateParams): VerdictResult   // engine/orchestrator.ts
```

Each tick, the caller supplies `{scenario, liveMetrics, tick, totalTicks, …}`
plus **all rolling state** — the `TrendBuffer`, detector accumulator state,
lifecycle-event state, sticky fail-fast state. The engine holds no state
that affects evaluation between calls (the one module-level store, the G3
stub's, is inert — see below) and performs no I/O apart from the optional
audit writer. There
is no server loop, no HTTP surface, and no persistence layer in this repo —
see [Status](#implementation-status) and `README.md § Status`.

## Per-tick pipeline

```
                       ┌ reversibility classification (once per deploy, tick 0)
                       │ lifecycle: evaluation.triggered (tick 0)
                       ▼
 admission gates:  blast radius ─► policy ─► approval ─► state
                       │              │          │         │
                       │       rollback SC   extend SC  extend SC   (SC = short-circuit)
                       ▼
 traffic checks:   SRM continuity ─► fail-fast thresholds ─► ignore bands
                       │                    │
                  rollback SC          rollback SC (sticky)
                       ▼
 health gate:      Family B structural tables + Family A/C/D/E statistical dispatch
                       ▼
                   Anvil expected-failure-pattern suppression (only when declared)
                       ▼
 fusion:           fuseVerdict (portfolio) ∥ computeVerdict (cascade)
                       ▼
 post-verdict:     VerdictGrouper ingest ─► TopologyEnricher + advisory AgentProposer fan-out
                       ▼
 emit:             reversibility translation ─► audit record (v2) ─► lifecycle events
```

Any gate can short-circuit the pipeline; every path (short-circuit or full
evaluation) exits through a single `_emit()` helper, so audit records and
lifecycle events are uniform across all verdict return points.

### A note on gate numbering

Three numbering schemes exist in the wild: the code's file headers
(G1 health, G2 policy, G3 state, G4 blast-radius, G5 approval), this file's
earlier revision (G0–G4 in pipeline order), and CHEAT-SHEET's diagram
(G0 blast-radius, G1 policy). **The code's names are canonical**; this doc
uses functional names and gives the code label once per section.

## TrendBuffer (`engine/core.ts`)

A bounded rolling window per signal. On `get()` it returns `n`, `mean`,
`min`/`max`/`range`, `slope`, `slopeNorm` (slope normalized by baseline),
`cv`, and `trendStrength` (0 = pure noise, 1 = monotonic).

The design insight survives from the earliest engine: `cv` is not a noise
indicator on trending data — a metric drifting smoothly upward has high `cv`
but is moving, not noisy. `trendStrength` separates real movement from
jitter. The `TrendBuffer.get()` contract is the public type surface for
structural detection; changes ripple through every Family B pattern.

## Admission gates

**Blast radius** (`engine/gates/blast_radius.ts`, G4) — classifies deployment
risk from change metadata (risk level, change type, author, file paths) and
adjusts the effective risk tier downstream gates see. Never short-circuits.

**Policy** (`engine/gates/policy.ts`, G2) — time windows, change types,
risk-level rules. Short-circuits to `rollback`. Produces the `PolicyContext`
consumed by the health gate (thresholds, warmup state, downstream
corroboration rules); the compiled config is applied onto this context.

**Approval** (`engine/gates/approval.ts`, G5) — validates flags and author
context. Short-circuits to `extend`.

**State** (`engine/gates/state.ts`, G3) — **stub**. `evaluateState()`
currently always returns `{allow: true}`; its `recordDeployment` /
`updatePhase` helpers exist but nothing calls them, and its in-memory store
does not survive the process. This is the designed seam for deployment-
session persistence (see Status below).

## Traffic checks

**SRM / traffic-allocation continuity** (Addition #10) — when the canary is
receiving the wrong traffic fraction, the comparison population is invalid:
all detector families are moot, and the tick short-circuits to `rollback`
with `shortCircuit: 'srm'`.

**Fail-fast / ignore thresholds** (Addition #13) — operator-declared absolute
panic bounds short-circuit to `rollback` and are *sticky* for the deploy's
remaining ticks. Ignore bands produce a per-tick set of signals that the
statistical families suppress with `suppression_reason: 'ignore_threshold'`.

## Health gate (`engine/gates/health.ts`, G1)

A facade over two detection surfaces evaluated against the `PolicyContext`:

- **Family B — structural pattern tables** (`engine/gates/_health-defs.ts`):
  the hand-designed absolute-threshold patterns covering known LLM-serving
  failure classes — `slowbleed` (4+ metrics drifting sub-threshold
  simultaneously), `mfu_collapse`, `kv_saturation`, `hbm_elevation`,
  `hbm_spill_roll`, `collective`, `capacity`, `gpu_eff`, plus the per-signal
  ratio checks and flag-based signals. These are the direct descendants of
  the heuristic-era detectors (see § Historical) and are non-α-consuming.
- **Families A/C/D/E — statistical dispatch**
  (`engine/gates/_health-detectors.ts` → `engine/detectors/`): per-signal
  mixture-supermartingale Page-CUSUM + betting e-process (A), Hotelling T² +
  sequential-MMD betting e-process (C), spectral e-detector (D),
  weighted-conformal Mahalanobis novelty (E). Math, α-accounting, and
  per-family validity classes are documented in `CHEAT-SHEET.md`.

The health gate knows nothing about risk tiers, time windows, or approval
state — it evaluates signals against the thresholds the policy context hands
it. Detectors are independent; no inter-detector dependencies.

## Anvil suppression (Addition #29)

When the caller declares an `expectedFailurePattern` (chaos experiments),
the families the operator expects to fire are rewritten to `suppressed`
during the fault window; non-declared families still fire on unexpected
blast. The pre-Anvil path is byte-identical when no pattern is supplied.
The chaos-platform adapters themselves (`engine/o0/anvil/`) are typed
contracts with deliberately throwing stubs — see Status.

## Fusion and verdicts

Both fusion topologies compute every tick:

- **Cascade** (`computeVerdict`, `engine/core.ts`) — first-fire-wins over the
  health result. Default topology.
- **Portfolio** (`fuseVerdict`, `engine/verdict.ts`) — α-budget fusion across
  the five families, always emitted for audit and promoted to the primary
  verdict when `fusionTopology === 'portfolio'`.

The verdict union is `'rollback' | 'extend' | 'proceed' | 'baking'` —
`baking` is internal (in-window, insufficient evidence to conclude) and is
never surfaced as a final verdict; the last tick collapses indeterminate to
`proceed`. Per-detector verdicts are
`'fire' | 'indeterminate' | 'clean' | 'suppressed'` with per-fire
`alpha_spent`.

`VerdictResult` carries: `verdict`, `reason`, per-gate `gateResults`,
`healthResult`, `shortCircuit` (gate name or null), the fused portfolio
verdict, the reversibility classification, and `finalAction` — the concrete
orchestrator action derived from verdict × reversibility
(`engine/o0/reversibility-translator.ts`, Addition #5; by calling contract,
classification happens once per deploy at tick 0 and is never revised
mid-deploy — callers thread it via `params.reversibilityClassification` on
subsequent ticks).

## Post-verdict fan-out (Additions #25/#26/#27)

`VerdictGrouper` (`engine/verdict-groups.ts`) aggregates per-tick fused
verdicts into incident groups (grace-window close, D2 default 300 s). On
group close, fan-out runs to the `TopologyEnricher` (topology overlay,
common-mode attribution) and the **advisory** `AgentProposer`
(`advisory/agent/`), which emits a `ProposedAction` with `human_summary` and
`cited_evidence` — advisory only, never part of the verdict path. A closed
group emits exactly once (rail-g).

## Audit and lifecycle events

Every `_emit` builds an **audit-schema v2** record (`audit/SCHEMA.md`):
per-family blocks with `DetectorTripV2 {statistic, threshold, alpha_spent,
reason_code, provenance, cusum_progress}`, suppression reasons, cell
confidence, schema continuity, and reversibility fields. The shipped writer
(`engine/_audit-writer.ts`) is append-only JSONL with daily rotation;
writes are currently best-effort (fs errors are swallowed — a known gap,
tracked for remediation).

Lifecycle events (Addition #14): `evaluation.triggered / started / tick /
suppressed / finished`, emitted through a `LifecycleEventEmitter`. Shipped
emitters are `NoOpLifecycleEventEmitter` (default) and
`InMemoryLifecycleEventEmitter` (tests); durable transports are integration
work (see Status).

## Implementation status

Using the repo-wide status taxonomy (see `README.md § Implementation status
at a glance`):

- **Implemented, runtime path:** everything in the pipeline diagram above
  except as noted; five detector families; both fusion topologies; audit v2;
  Anvil suppression; verdict grouping + advisory fan-out.
- **Implemented, offline tools:** calibration compiler (`tools/calibrate.ts`),
  regression injection, real-trace ingestion, shadow-compare CLI, demo
  builders.
- **Stub / inert:** state gate persistence (G3); Anvil chaos-platform
  adapter network methods.
- **Spec-only:** orchestrator adapters (`ORCHESTRATION-ADAPTERS.md`);
  direction-aware baseline-maintenance loop (North-Star Addition #15);
  incident-aware gating; Metric Registry governance.

## Historical: the heuristic-era engine

An earlier revision of this document described the engine as it stood before
the statistical portfolio landed. Preserved for context; **do not read this
as current state.**

The original engine was a single health-gate cascade of hand-tuned heuristic
detectors — 24 rollback + 9 extend threshold checks over TrendBuffer
snapshots, with `slowbleed` as its signature pattern. Those detectors were
not hand-tuned but *evolved*: a tuning loop (`loop.js`, not included in this
public repo) paired Opus (planning) with Sonnet (patch-writing) against a
120-scenario adversarial suite (`runs/adversarial-scenarios.json`), with a
two-layer guardrail (prompt rules + runtime auto-stripping of tautologies
and guard removals) and `ADV_TP_THRESHOLD = 0.975` defended as a floor.

Disposition of that era's parts:

- The heuristic detectors live on as **Family B structural patterns**
  (`engine/gates/_health-defs.ts`), non-α-consuming by design.
- The era's three "architectural limits" are since addressed by the
  portfolio: covariance-only joint patterns → **Family C** (Hotelling T² +
  MMD); sub-floor oscillation → **Family D** (spectral e-detector); only
  sub-tick duty-cycle flapping remains out of reach at current tick
  resolution.
- The `shared.js` file at the repo root is the legacy monolith retained for
  the cascade demo path; the engine tree does not import it.
- The tuning-harness artifacts (`runs/<run-id>/`, `analyze_iterations.py`)
  are not part of this public subset.

## Invariants (do not break)

- Health-gate detectors are independent. No inter-detector dependencies
  without explicit review.
- `TrendBuffer.get()`'s returned shape is a public type surface.
- Every verdict path exits through `_emit()` — no ad-hoc returns bypassing
  audit or lifecycle emission.
- Reversibility is classified once per deploy at tick 0 and never revised
  mid-deploy (anti-scope rule, Addition #5).
- Anvil suppression must be a no-op when `expectedFailurePattern` is
  undefined (byte-identical pre-Anvil path, PRD-29 NFR-2/AC-11).

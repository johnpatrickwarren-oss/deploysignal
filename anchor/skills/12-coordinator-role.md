# Skill: Coordinator — PRD Decomposition and Wave Planning

**Trigger:** Project has a structured PRD and is ready to begin multi-cluster
parallel execution.
**Application moment:** After PRD is finalized and before any implementation
begins. Re-applied at scope revisions that affect work unit boundaries or
dependency edges.
**Owner:** Coordinator TPM — a dedicated session whose scope is cross-wave
orchestration only. Distinct from any cluster-level TPM work.

## What it is

The Coordinator role owns how a structured PRD becomes a dependency graph,
and how that graph becomes a sequenced wave plan that parallel clusters
can execute against.

This skill is upstream of all cluster dispatch. No cluster receives work
until the Coordinator has produced a validated wave plan with explicit
dependency edges, work unit classifications, and wave gate criteria. The
wave plan is the Coordinator's primary artifact — the analog of the
Architect's spec or the PM's PRD, but at the program level rather than the
feature level.

## Why a separate role

The existing TPM role (see [`templates/TPM-REPLY-TEMPLATE.md`](../templates/TPM-REPLY-TEMPLATE.md))
handles routing within a project — forwarding specs to implementers,
grilling artifacts before emit, tracking memorial state. That role
operates inside a single coordination cycle.

The Coordinator operates across cycles and across clusters. Its job is
not to route work but to determine what work exists, what order it must
happen in, and how many streams can run simultaneously. Conflating this
with intra-cycle TPM routing produces a role that is doing two
qualitatively different things and doing neither with full discipline.

The Coordinator has no reach inside any cluster. Once a cluster receives
its work unit, the Coordinator's job for that cluster is done until the
wave gate. What happens inside the cluster — whether it scales to
include an Architect, whether the Reviewer rejects and the cluster
retries — is not the Coordinator's concern until the cluster's output
surfaces at the wave gate.

## Coordinator scope and out-of-scope

**In scope:**
- PRD decomposition into candidate work units
- Dependency edge identification and DAG construction
- Wave sequencing from the DAG
- Work unit classification (novelty/complexity tier)
- Wave gate execution across all cluster outputs
- Cross-cluster dependency artifact management
- Resequencing dependent clusters when a wave gate surfaces a rejection
- Memorial accretion at the coordinator level

**Out of scope:**
- Spec drafting (Architect's role within clusters)
- Implementation (Implementer's role within clusters)
- Spec-vs-implementation audit (Reviewer's role within clusters)
- Intra-cluster routing decisions
- Retry decisions within a cluster (cluster handles internally up to halt threshold)

## DAG construction discipline

### Step 1 — Deterministic work unit extraction

Extract candidate work units directly from PRD structure. A well-formed
PRD (per [`skills/10-product-manager-role.md`](./10-product-manager-role.md))
has explicit features, acceptance criteria, and anti-scope. Each feature
is a candidate work unit. Do not invent work units; do not merge features
without explicit reasoning captured in the wave plan artifact.

For each candidate work unit, record:
- Work unit ID (e.g., WU-01, WU-02)
- Source PRD feature reference
- Acceptance criteria (verbatim from PRD)
- Anti-scope clauses that bound this unit
- File tree scope (which directories/files this unit touches)

This extraction is deterministic. Same PRD → same candidate work units.
No Claude judgment required at this step.

### Step 2 — Dependency edge identification

For each pair of work units, apply the following deterministic dependency
tests in order. If any test fires, record a dependency edge with the test
that fired as the reason.

**Test D1 — Shared output ownership.** Does WU-A write to a file, schema,
or interface that WU-B reads from? If yes: WU-A → WU-B (A must complete
before B dispatches).

**Test D2 — Acceptance criterion reference.** Does WU-B's acceptance
criteria mention a behavior, data structure, or interface that WU-A's
acceptance criteria define? If yes: WU-A → WU-B.

**Test D3 — Anti-scope boundary adjacency.** Is WU-B's scope adjacent to
WU-A's anti-scope in a way that creates an implicit assumption? Flag for
Claude judgment (Step 3).

**Test D4 — File tree overlap.** Do WU-A and WU-B touch the same files?
If yes: record as a contention risk, not necessarily a dependency.
Resolve via worktree isolation unless the overlap is in a shared
foundation file, in which case: WU-A → WU-B or serialize.

Record every edge with: source work unit, target work unit, dependency
test that fired, confidence (HIGH if D1/D2, MEDIUM if D3/D4).

### Step 3 — Claude judgment at ambiguity boundaries

Escalate to Claude only when:
- A dependency edge has MEDIUM confidence and the consequence of getting
  it wrong is a merge conflict or spec contradiction
- Two work units have no deterministic dependency edge but share a
  conceptual assumption that isn't captured in file tree or acceptance
  criteria
- Anti-scope boundary adjacency (D3) fired and the implicit assumption
  isn't resolvable by reading the PRD more carefully

For each Claude judgment call, record:
- The specific ambiguity (quote the relevant PRD text)
- The two candidate resolutions (parallel vs. sequential)
- Claude's judgment and the reasoning
- Resulting edge (or confirmed independence)

Claude judgment calls are logged as judgment artifacts, not deterministic
rules. The audit trail distinguishes them from D1/D2 edges.

### Step 4 — DAG validation

Before proceeding to wave planning, validate the DAG:

- **Cycle check.** No circular dependencies. If a cycle exists, surface
  to human operator — it indicates a PRD structural problem, not a DAG
  construction problem.
- **Island check.** Any work unit with no edges (no dependencies in or
  out) is a candidate for Wave 1 or any wave. Flag for explicit placement.
- **Foundation identification.** Work units whose outputs are inputs to
  3+ other work units are foundations. They must land in Wave 1 regardless
  of their own dependency-in count. Data models, shared interfaces, and
  core API contracts are the typical foundation candidates.

### Step 5 — Wave sequencing

From the validated DAG, assign work units to waves:

- **Wave 1:** Foundations + any work unit with no dependency-in edges
- **Wave N+1:** Work units whose all dependency-in edges point to work
  units completing in Wave N or earlier
- **Final wave:** Integration, cross-cutting concerns, hardening — work
  units that touch outputs from multiple prior waves

Record the wave plan as a durable artifact (`WAVE-PLAN-NN.md` in the
coordination folder). The wave plan is the Coordinator's primary output
and the input to cluster dispatch.

## Work unit classification

Each work unit receives a tier classification that determines the cluster
role configuration. This classification is self-governing — each cluster
reads its work unit and applies the rubric independently. The Coordinator
records the expected tier in the wave plan, but the cluster's own
assessment governs.

The tier names align with [`skills/11-round-scaling.md`](./11-round-scaling.md)
(the round-scaling rubric):

**`solo` — Implementer only:**
- Work unit is well-understood (similar to prior work in this project or codebase)
- Acceptance criteria are unambiguous and fully testable
- No novel algorithms, data structures, or integration patterns
- File tree scope is narrow and well-bounded

**`audit` — Implementer + Reviewer:**
- Work unit involves moderate complexity or cross-cutting concerns
- Acceptance criteria require interpretation at the boundary
- Implementation approach is known but verification is non-trivial
- File tree scope touches shared infrastructure

**`full` — Architect + Implementer + Reviewer:**
- Work unit is novel relative to the existing codebase
- Acceptance criteria involve emergent behavior or integration contracts
  not yet defined
- Implementation approach requires design decisions with downstream
  consequences
- File tree scope touches foundations or public interfaces

When in doubt, classify up. A `full` cluster that didn't need the
Architect costs one extra role's overhead. A `solo` cluster that needed
an Architect and didn't have one costs a Reviewer rejection and a retry
cycle.

### Cluster tier configurations vs. single-pipeline tiers

The cluster tier configurations above differ from the single-pipeline
tiers in [`skills/11-round-scaling.md`](./11-round-scaling.md) in one
specific way: **clusters in multi-cluster execution omit the per-cluster
Memorial-Updater role.** A separate Memorial-Updater per cluster would
produce concurrent appends to `MEMORIAL.md` and `CROSS-PROJECT-MEMORIAL.md`
across N parallel clusters — a race condition.

In multi-cluster mode, memorial duties redistribute:
- **Per-cluster CONFIRMATION/VIOLATION entries** are written inline by
  the cluster's Implementer (in `solo`) or by the Reviewer at the end of
  the Reviewer report (in `audit`/`full`). They land in
  `coordination/clusters/<cluster-id>/MEMORIAL-fragment.md`.
- **Wave-gate aggregation** is the Coordinator's job. At each wave gate,
  the Coordinator collects cluster memorial fragments and appends them
  to the project's `MEMORIAL.md` and `CROSS-PROJECT-MEMORIAL.md` under a
  single lock.
- **Coordinator-level memorial** (DAG construction and wave planning
  patterns) lives in `COORDINATOR-MEMORIAL.md` as described below.

In single-pipeline (Mode 2) mode, the Memorial-Updater role remains as
a separate fourth role per round — no parallelism, no race, no need to
collapse.

## Wave gate discipline

The wave gate is the Coordinator's primary quality control mechanism
between waves. It is not a rubber stamp — it is the program-level
equivalent of the four-anchor pre-merge defense, applied across all
cluster outputs simultaneously.

Wave gate checklist (run before dispatching Wave N+1):

- [ ] All Wave N clusters have emitted a Reviewer report (or explicit
      scope-reduction disposition per two-slice pattern)
- [ ] No CRITICAL findings in any Reviewer report are unresolved
- [ ] All cross-cluster dependency artifacts for Wave N outputs are
      current and accurate
- [ ] Anti-scope clauses from the PRD are preserved across all Wave N
      outputs
- [ ] No Wave N output has silently expanded scope into Wave N+1 territory
- [ ] Memorial state at wave gate is captured in `WAVE-GATE-NN.md`

**Wave gate failure handling:**

| Failure type | Coordinator action |
|---|---|
| Reviewer rejection, self-contained | Cluster retries internally; wave gate holds until resolved |
| Reviewer rejection with downstream implications | Coordinator resequences dependent clusters; records resequencing in `WAVE-GATE-NN.md` |
| Spec ambiguity surfaced by Reviewer | Coordinator routes back to Architect (if cluster had one) or spawns Architect for a targeted spec amendment before retry |
| Scope expansion detected | Coordinator issues anti-scope correction; cluster revises before wave gate clears |

The wave gate never advances under CRITICAL unresolved findings.
LIKELY-SURFACES findings from any cluster are pre-flagged to the next
wave's relevant clusters before dispatch.

## Memorial accretion at the coordinator level

The Coordinator maintains its own memorial layer, separate from any
cluster's memorial state. Coordinator memorials capture patterns at the
DAG construction and wave planning level — not implementation-level
failures.

Memorialize when:
- A dependency edge that was classified HIGH confidence turned out to be
  wrong at wave gate (adjust D1/D2 test application)
- A Claude judgment call at Step 3 resolved differently than the wave
  gate evidence suggested (adjust escalation threshold)
- A work unit classified `solo` required a `full` cluster (adjust
  classification rubric)
- A wave gate failure pattern repeats across two or more projects
  (promote to coordinator-level discipline)

Track violations and confirmations per memorial. Ratio drives
prioritization — same discipline as
[`skills/02-memorial-accretion.md`](./02-memorial-accretion.md) but
applied to coordinator-level failure patterns rather than
implementation-level ones.

## Coordinator artifacts

| Artifact | Location | Purpose |
|---|---|---|
| `WAVE-PLAN-NN.md` | `coordination/` | DAG + wave assignments + tier classifications; primary coordinator output |
| `WAVE-GATE-NN.md` | `coordination/` | Wave gate checklist results + failure dispositions per wave |
| `CLUSTER-HANDOFF-NN-WU.md` | `coordination/` | Cross-cluster dependency contract between specific work units |
| `COORDINATOR-MEMORIAL.md` | `coordination/` | Coordinator-level failure-driven discipline accumulation |
| `clusters/<cluster-id>/MEMORIAL-fragment.md` | `coordination/` | Per-cluster memorial fragments, aggregated by Coordinator at wave gate |

## Relationship to existing TPM role

The existing TPM role (template:
[`templates/TPM-REPLY-TEMPLATE.md`](../templates/TPM-REPLY-TEMPLATE.md))
handles intra-cluster routing — forwarding specs from Architect to
Implementer, grilling artifacts at T1, tracking memorial state within a
coordination cycle. That role continues to operate within each cluster
unchanged.

The Coordinator is the program-level layer above all clusters. It does
not replace the TPM; it operates at a different scope. A project using
the Coordinator has:

- One Coordinator session (cross-wave, cross-cluster)
- Zero or more cluster TPM sessions (intra-cluster, per the existing
  TPM role) — the integration's automated pipeline (Mode 2)
  demonstrates that the role-and-handoff disciplines TPM handles in
  Mode 1 can be encoded into `NEXT-ROLE.md` state for autonomous
  cluster-internal operation, so a dedicated TPM session is optional
  per cluster.

## Common pitfalls

- **Coordinator reaching inside clusters.** Once a cluster is
  dispatched, the Coordinator waits for the wave gate. Intervening in
  cluster-internal decisions (retry logic, Architect amendments within
  the cluster) breaks the accountability boundary and creates
  coordination confusion.
- **Skipping the deterministic steps and going straight to Claude.**
  D1 and D2 catch the majority of real dependencies. Claude judgment
  at ambiguous boundaries is valuable; Claude judgment at obvious
  boundaries is expensive and untraceable.
- **Wave plan as a living document during execution.** The wave plan
  is fixed at dispatch time. Changes discovered during execution
  surface at the wave gate and produce a new wave plan revision, not
  an in-flight edit. Versioning: `WAVE-PLAN-01.md`, `WAVE-PLAN-02.md`, etc.
- **Treating tier classification as the Coordinator's final word.**
  The cluster self-governs its own tier. The Coordinator's
  classification is a prior, not an instruction. If the cluster's
  reading of its work unit differs from the Coordinator's
  classification, the cluster's reading governs and the discrepancy
  is logged.
- **Wave gate as a formality.** The wave gate is the program's only
  cross-cluster quality check. A rubber-stamp wave gate is worse than
  no wave gate — it creates false confidence that cross-cluster
  integration has been verified.

## Cost

DAG construction: 30-60 minutes for a 10-20 work unit PRD, longer for
larger scope or higher ambiguity.

Wave gate execution: 15-30 minutes per wave, scaling with number of
clusters.

Coordinator memorial maintenance: 5-10 minutes per wave gate, triggered
by failure patterns.

Recovers cost at the first prevented merge conflict from incorrect
parallelization, or the first wave gate that catches a cross-cluster
spec contradiction before it propagates.

## Origin

This skill anticipates multi-cluster execution patterns derived from
sequential build experience in the DeploySignal case study and the
subsequent remodeling/quoting tool build (the validation project where
the round-scaling rubric and tier dial were developed). The dependency
test battery (D1–D4) and tier classification rubric were derived from
observed failure patterns in those sequential builds. As with all
Anchor disciplines, each component has a birth event from a specific
failure — none is theoretical.

Multi-cluster execution is the first application of these patterns in
parallel rather than sequential form. Real-world wave-gate failure
patterns are expected to refine the rubric across early
multi-cluster projects.

## Compatibility

This skill works alongside Superpowers' `dispatching-parallel-agents`
and `using-git-worktrees` skills. The Coordinator's wave plan is the
upstream input that Superpowers' dispatch mechanism executes against.
Superpowers handles the execution primitives (worktree isolation,
subagent dispatch, two-stage review); the Coordinator handles the
program-level intelligence about what to dispatch and in what order.

Compatible with CrewAI, LangGraph, and Claude Code multi-session
workflows. The Coordinator session is platform-agnostic; the wave plan
artifact is the coordination substrate regardless of which runtime
executes the clusters.

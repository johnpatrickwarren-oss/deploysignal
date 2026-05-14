# Methodology — Consolidated Reference

A single-page reference for the four roles (Architect / TPM / Implementer / Reviewer) at brief-drafting, routing, implementation, and audit time. Consult at the **start** of any non-trivial work cycle to anchor discipline application.

This doc is the "what" and the "why." For the "how," see the individual skill files in [`skills/`](./skills/).

---

## Five-role framework

Most agent orchestration frameworks have either no role separation (single-agent) or unopinionated role definitions (you bring your own). This pack opinionates on five roles, each with explicit responsibilities, primary artifacts, and discipline anchors.

| Role | Responsibilities | Primary artifacts | Discipline anchors |
|---|---|---|---|
| **Product Manager** | What gets built and why; user requirements; priority adjudication; acceptance criteria | `PRD-NN.md`, priority docs | Requirements traceability; priority drift detection |
| **Architect** | Spec drafting; dispositions on outcomes; cross-cycle oversight | `Q-NN-SPEC.md`, `ARCHITECT-REPLY-*.md` | Six practices + 10 P3 axes + Memorial F + grilling |
| **TPM** | Routing between roles; coordination; memorial landings; cross-track conflict | `TPM-REPLY-*.md`, `TPM-DISPOSITION-*.md` | TPM grilling + canonical-version verification |
| **Implementer** | Code; empirical verification of spec claims; halt-discipline when spec doesn't match reality | feature PRs + `DIAGNOSTIC-*.md` | Defensive patterns + multi-read-paths grep |
| **Reviewer** | Spec-vs-implementation audit; cross-cutting checks; adversarial post-merge | `REVIEWER-REPORT-NN.md` | No-skip policy + audit-state currency |

The Product Manager role is upstream of all others — it owns "what to build" before the others act on "how to build." PM can be a dedicated agent or the human operator; the framework is identical either way. The contract artifact (`PRD-NN.md`) is what matters, not who authors it. See [`skills/10-product-manager-role.md`](./skills/10-product-manager-role.md) for when this role is mandatory vs optional, and [`templates/PRD-TEMPLATE.md`](./templates/PRD-TEMPLATE.md) for a fillable scaffold.

The TPM role specifically distinguishes this pack from most agent frameworks. Most have either "supervisor" or "manager" roles; the TPM-as-coordinator framing aligns with a specific user persona (the technical PM who knows what they want and orchestrates the build) and provides a translation layer between the architect's design language and the implementer's execution language.

The Implementer role can be one or many parallel instances. When work scopes are independent (e.g., two features touching different file trees), running parallel Implementer sessions on isolated `git worktree` branches scales throughput without coordination overhead. See [`skills/07-round-numbering-convention.md`](./skills/07-round-numbering-convention.md) for cross-instance referential discipline.

### Templates for coordination-heavy roles

Each of the four coordination-heavy roles (PM, Architect, TPM, Reviewer) has a fillable scaffold under [`templates/`](./templates/). The scaffolds encode the relevant disciplines (pre-emit grilling, anti-scope, P3 axes, severity triage) structurally so the role's output captures discipline by construction rather than by memory.

| Role | Template | Encodes |
|---|---|---|
| Product Manager | [`PRD-TEMPLATE.md`](./templates/PRD-TEMPLATE.md) | Goal / personas / user stories / FRs / NFRs / acceptance criteria / anti-scope / priority / success metrics / dependencies / open Qs / update history. Traceability disciplines (every AC traces to FR; every FR traces to user story). |
| Architect | [`Q-NN-SPEC-TEMPLATE.md`](./templates/Q-NN-SPEC-TEMPLATE.md) | Spec / mechanism / open-Q architect picks / per-file pseudo-code / tests / acceptance / anti-scope / open Qs / P3 ten-axis verification / architect grilling output / Memorial application / timeline / pre-prediction / topic close framing / discipline-archive. |
| TPM | [`TPM-REPLY-TEMPLATE.md`](./templates/TPM-REPLY-TEMPLATE.md) | Pre-route discipline checklist / TPM grilling output / routing scope (the actual pasteable for downstream) / sequencing context / Memorial state / open coordination items. |
| Reviewer | [`REVIEWER-REPORT-TEMPLATE.md`](./templates/REVIEWER-REPORT-TEMPLATE.md) | Audit method / per-AC verification table / findings with severity tiers / cross-cutting verification (no-skip, audit-state currency, anti-scope preservation, right-reasons) / severity triage / disposition routing recommendations / audit-process self-check. |

The Implementer role does not have a single canonical template scaffold because Implementer outputs are code, tests, and PRs — these are project-specific and should follow the project's normal code conventions. The Implementer's discipline lives in [`skills/03-four-anchor-defense.md`](./skills/03-four-anchor-defense.md) (T2 anchor), not in a template.

### Role anchoring across multiple chat instances

When a project uses multiple AI chat instances (one per role), the most common failure mode is **role drift** — chats producing artifacts in another chat's scope, memory files asserting "THIS session = X" being mis-attributed when read in a different chat, the human becoming the only consistency mechanism for cross-chat role identity.

Prevent this with four primitives:

1. **Canonical role mapping file** (e.g., `PROJECT-ROLES.md` in coordination). Maps every chat instance to its role using **session ID** (UUID) as the anchor.
2. **Anti-drift rule.** Never use "THIS session = X" / "this chat = X" in any shared document. Use role-name references only ("TPM", "Architect"). Memory describes the system, not the author.
3. **Per-chat project instructions** that explicitly assert the chat's role. The project-instructions field is the absolute source of truth for role identity; memory defers to it.
4. **Drift-detection-and-remediation protocol.** When encountering a memory file asserting "THIS session = X", disregard the self-claim; apply the role configured in your project instructions; flag for refactor.

See [`skills/09-role-anchoring.md`](./skills/09-role-anchoring.md) for application detail and [`templates/PROJECT-ROLES-TEMPLATE.md`](./templates/PROJECT-ROLES-TEMPLATE.md) for a fillable scaffold.

---

## Four-anchor pre-merge defense

Every non-trivial change passes through four discipline anchors. Each catches what the previous misses. Skipping any anchor is the single biggest predictor of downstream rework.

| Anchor | When | Who | Discipline |
|---|---|---|---|
| **T0** | Architect spec-emit | Architect | Six practices + 10 P3 axes + grilling |
| **T1** | TPM routing-emit | TPM | TPM grilling + canonical-version verification |
| **T2** | Implementation-time | Implementer | Defensive patterns + multi-read-paths grep |
| **T3** | Post-merge | Reviewer | Spec-vs-impl audit + cross-cutting checks |

See [`skills/03-four-anchor-defense.md`](./skills/03-four-anchor-defense.md) for application detail.

> **Naming note:** the four anchors (`T0` / `T1` / `T2` / `T3`) are
> *temporally-ordered discipline checkpoints*. A separate concept —
> **round scaling**, which decides how many roles run for a given
> round — uses verbal names (`solo` / `audit` / `full`) precisely to
> avoid collision with the four-anchor letter+number names. See
> [`skills/11-round-scaling.md`](./skills/11-round-scaling.md) for
> when each tier applies.

---

## Architect six practices (T0)

| # | Practice | Purpose |
|---|---|---|
| **P1** | Inline derivations for every numerical threshold | Prevents arbitrary-magic-number specs that pass review but fail empirical |
| **P2** | Exhaustive option-space enumeration | Prevents "we picked X" without "vs Y, vs Z, why X wins" |
| **P3** | Representative-baseline spot-check against concrete shipped state (10 axes) | Prevents specs that look good in isolation but contradict actual code |
| **P4** | Per-component claim verification + semantic comparability | Prevents specs that claim two things are equivalent when they aren't |
| **P5** | Pseudo-code vs test-case round-trip + anchor consistency | Prevents specs that the implementer can't actually execute |
| **P6** | Empirical profile verification for performance claims | Prevents "should be fast" without measurement |

---

## Architect 10 P3 axes (T0)

P3 spot-check exercises actual shipped state across all axes — never illustrative; always concrete; always live at the moment of spec drafting.

1. **concrete-values** — open the file with the live constants, don't cite from memory
2. **coord-trail** — grep all coordination artifacts that might carry contradicting claims
3. **file-opened** — open every file mentioned in contract surfaces, not just summarize from prior reads
4. **function-bodies** — for refactor-class work, open function bodies + grep for module-local mutation
5. **compiled-artifacts** — open the compiled config (not just source) for behavior-on-artifact claims
6. **input-pipeline-alignment** — verify input harness vs compiled substrate before hypothesizing detector-layer bugs
7. **compile-time-precision** — verify floating-point precision corner cases at compile time (σ² underflow class)
8. **regime-coverage** — enumerate analytical-pass regime vs orchestrator regime-sweep coverage gap
9. **wrapper-vs-algorithm-layer** — distinguish algorithm-layer formal property vs wrapper-layer code paths
10. **firing-attribution-discipline** — verify attribution at source data BEFORE constructing hypothesis trees

Each axis was born from a specific real-world failure during DeploySignal. They are not theoretical; they are scar tissue.

---

## Memorial system (T0 + cross-cycle)

The most distinctive discipline in this pack. See [`skills/02-memorial-accretion.md`](./skills/02-memorial-accretion.md) for the mechanics.

**Memorial D — architectural-layer-coverage discipline**

Four-factor prior weighting at hypothesis-tree drafting time:

```
actual_prior = analytical-model-correctness
             × regime-coverage
             × attribution-verification
             × architectural-layer-coverage
```

Enumerate ALL architectural layers between calibration source and runtime consumption. Ensure candidate set covers all layers. Weight priors with explicit architectural-layer-coverage discount.

The load-bearing forward-looking discipline IS the explicit enumeration; probability ranking can be off without invalidating the discipline. Track violations vs confirmations.

**Memorial F — four sub-rules at brief-drafting time**

Each sub-rule has a distinct trigger condition. Consult all four; apply each whose trigger fires.

| # | Sub-rule | Trigger | Apply |
|---|---|---|---|
| 1 | **Multiple-read-paths** | Compile-time substrate modifications | Grep runtime detector code for compile-output objects |
| 2 | **Schema-precedent-recheck** | Schema additions or modifications | Verify all consumers have null-checks; grep for the field name |
| 3 | **Acceptance-criterion-coherence** | New acceptance criterion introduced | Verify criterion makes sense against existing methodology notes |
| 4 | **Pre-existing-property-coherence** | Spec claims a behavior should hold | Verify behavior wasn't already documented as the opposite somewhere |

---

## V/Q framework (cross-role)

Cost-bounded discipline against runaway investigation cycles.

- **V (Variants):** when investigating a failure, enumerate hypothesis variants at the architectural-layer level FIRST. Don't go deep on one hypothesis until you've enumerated the alternatives.
- **Q (Questions):** for the chosen hypothesis, draft the empirical question that would falsify it. The question is the unit of investigation, not the hypothesis itself.
- **Sequencing:** V before Q. Multiple Vs may share a Q. Track which Vs were ruled out by which Q to prevent re-investigation.

See [`skills/05-v-q-framework.md`](./skills/05-v-q-framework.md) for application detail.

---

## TPM grilling discipline (T1)

Adversarial pre-emit review of TPM's own routing artifacts BEFORE forwarding to implementer. Three buckets:

| Bucket | Action |
|---|---|
| **CRITICAL** | Architect amendment needed BEFORE forwarding |
| **LIKELY-SURFACES** | Pre-flag in routing as architect-pre-disposition |
| **PRE-EMPTABLE** | Fold into routing as anti-scope OR open-Q OR TPM correction |

The discipline catches TPM-side errors at the source rather than at downstream consumer. See [`skills/01-pre-emit-grilling.md`](./skills/01-pre-emit-grilling.md).

---

## Automated TPM routing (T1 — pipeline variant)

The TPM role as described above assumes a human reads every coordination artifact
and writes routing decisions between sessions. In automated pipeline deployments,
the TPM routing function is replaced by a file-driven state machine — but the
underlying discipline (T1) is unchanged. The anchors still apply; what changes is
who or what applies them.

### NEXT-ROLE.md as the routing contract

In automated mode, each role writes its routing decision to `coordination/NEXT-ROLE.md`
on completion rather than waiting for a human TPM to route it. The file carries:

```
CURRENT-ROUND: R01
NEXT-ROLE: IMPLEMENTER
STATUS: READY | ESCALATE | MERGE-READY | ROUND-COMPLETE | BLOCKED

## Inputs for next role
- coordination/specs/Q-R01-SPEC.md

## Escalation items
(bounded question if STATUS = ESCALATE)

## Routing notes
(sequencing context, if any)
```

`STATUS: READY` means the role completed its work and the next session can open.
`STATUS: ESCALATE` is the automated equivalent of the human TPM halting and asking
for input — it surfaces a bounded question that requires operator judgment, pauses
the pipeline, and waits for resolution before continuing.

### T1 discipline in automated mode

The TPM grilling checklist (verifying filenames, versions, line numbers, test counts
are current before routing) runs as part of each role's pre-emit grilling rather
than as a separate TPM session. The Architect's grilling output includes canonical
version verification. The Reviewer's pre-emit grilling includes audit-state currency
verification (confirming it is reviewing the artifact that would actually merge).

This preserves the T1 discipline without requiring a dedicated TPM session for
every handoff — appropriate when the human operator has validated the methodology
and trusts the role-level grilling to catch routing errors.

### Escalation as the human gate

In automated mode, the human operator is not absent — they are present at escalations.
An escalation is set when a role encounters a condition it cannot resolve without a
design decision that belongs to the operator:

- Spec ambiguity with two valid interpretations (Architect → operator)
- Spec claim contradicts codebase reality (Implementer → operator)
- CRITICAL finding with no clear resolution path (Reviewer → operator)

The escalation item is always a bounded question — not "what should I do" but
"option A does X (consequence Y), option B does Z (consequence W), which?" The
operator reads the question, resolves it, sets `STATUS: READY`, and the pipeline
continues. This is the minimum viable human-in-the-loop pattern: present at
decisions, absent from execution.

### What automated mode does not replace

The four-anchor defense (T0/T1/T2/T3) is fully preserved in automated mode.
What changes is the mechanism of T1, not its substance. The disciplines that
require human judgment — priority adjudication, architectural direction, accepting
or rejecting Reviewer findings — remain with the operator. The disciplines that
are mechanically verifiable — file existence, version currency, role boundary
adherence, TDD sequence — are enforced by the role prompts and escalation rules.

See [`integrations/superpowers-claude-code/`](integrations/superpowers-claude-code/)
for a complete reference implementation of automated mode.

## Pre-route checklist (T1)

Before forwarding ANY routing artifact to the implementer, verify:

1. All filenames cited are LIVE (verified against current source of truth, not memory)
2. All version labels cited are CURRENT (verified against canonical version doc)
3. All line numbers cited are CURRENT (verified by opening the file)
4. All test counts cited are CURRENT (verified by running `wc -l test/*.test.*` or equivalent)
5. All claims about another role's prior output are GREP-VERIFIED in their actual artifact

This is the discipline that prevents the "TPM cited a stale config name and the reviewer caught it" failure mode. See [`skills/04-pre-route-checklist.md`](./skills/04-pre-route-checklist.md).

---

## Cross-cycle disciplines

**Round numbering convention.** Each topic gets a single round number shared across architect / TPM / implementer / reviewer artifacts. Letter suffixes for sub-rounds (52a, 52b, ..., 52gk). Lets any role reference any other's artifact unambiguously.

**Anti-scope ledger.** Each spec carries an explicit anti-scope section. New work that drifts into anti-scope triggers a halt-and-route-back. Prevents scope creep at compile time rather than at review.

**Two-slice scope-reduction pattern.** When mid-delivery scope surprise surfaces, ship v1 with reduced scope; brief v2 under same topic letter-suffix. Prevents indefinite slip; preserves coordination trail.

**Continuous-flow cadence.** No calendar-based windows ("we'll review next week"). When previous work wraps, next work starts. Calendar windows generate artificial slack.

**Compute server routing.** Heavy work (>3hr sweeps) routes to a separate compute target via SSH/Tailscale. Preserves laptop responsiveness for coordination work.

**Parallel session worktree isolation.** When running parallel implementation sessions, each gets its own `git worktree`. Prevents race conditions on git operations.

---

## Anti-patterns explicitly avoided

- **No skipping statistical-invariant tests.** Tests that assert formal properties (Ville bounds, martingale invariants, e-value bounds) MUST pass — no `it.skip` or `xit` or `describe.skip` allowed on these. If you need to skip, the feature doesn't ship.
- **No relying on memory for filenames / versions / line numbers / test counts.** Always verify live before citing.
- **No pure-rubber-stamping at the multi-role boundary.** Each role's grilling discipline is mandatory at handoff time, not optional.
- **No infinite recursion on hypothesis investigation.** V/Q framework bounds the cycles.
- **No ceremonial process without measured benefit.** Each discipline in this pack has a documented birth event from a specific failure. Ones that don't earn their cost get retired.

---

## Honest scope and limits

- This pack was distilled from one project (DeploySignal). Generalization to other domains is hypothesis, not validated. Apply with appropriate skepticism.
- The Memorial accretion system requires deliberate maintenance (memorialize new disciplines as they emerge from failures). Without that maintenance, the pack becomes static.
- The four-role framework has overhead. Solo work or trivial features should NOT use all four roles — degenerate to the smallest set that captures the relevant discipline.
- Most disciplines here can be applied by humans, agents, or both. The pack does not assume autonomous agent execution; it works just as well as a checklist for a human team.

## Origin

Distilled from running [DeploySignal](https://github.com/johnpatrickwarren-oss/deploysignal) — see [`case-studies/deploysignal-coordination-trail.md`](./case-studies/deploysignal-coordination-trail.md) for the empirical record.

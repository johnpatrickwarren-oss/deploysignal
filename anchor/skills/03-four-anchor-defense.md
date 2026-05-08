# Skill: Four-Anchor Pre-Merge Defense

**Trigger:** Any non-trivial change moving from concept to merged code.
**Application moment:** At each anchor as the change progresses.
**Owner:** Each anchor has its named owner (Architect / TPM / Implementer / Reviewer).

## What it is

Four discipline anchors that every non-trivial change passes through, each catching what the previous misses. Skipping any anchor is the single biggest predictor of downstream rework.

| Anchor | When | Who | Discipline |
|---|---|---|---|
| **T0** | Architect spec-emit | Architect | Six practices + 10 P3 axes + Memorial F + grilling |
| **T1** | TPM routing-emit | TPM | TPM grilling + canonical-version verification |
| **T2** | Implementation-time | Implementer | Defensive patterns + multi-read-paths grep |
| **T3** | Post-merge | Reviewer | Spec-vs-impl audit + cross-cutting checks |

## Why four (and not three or five)

Three anchors (typically: design, implement, review) is the conventional software shape. It misses the **routing** anchor — the moment between spec and implementation where coordination errors happen. Many shipped bugs trace to a routing artifact that was wrong, not to a spec or implementation that was wrong.

Five or more anchors adds overhead without proportional catch rate. Each additional anchor either duplicates an existing one or adds ceremony. Four is the empirically-derived minimum.

## How each anchor works

### T0 — Architect spec-emit

The architect drafts a spec. Before declaring it ready for routing, applies:

- **Six practices.** Inline derivations, exhaustive option-space, P3 spot-checks, claim verification, pseudo-code round-trip, performance verification.
- **10 P3 axes.** Concrete-values, coord-trail, file-opened, function-bodies, compiled-artifacts, input-pipeline-alignment, compile-time-precision, regime-coverage, wrapper-vs-algorithm-layer, firing-attribution-discipline.
- **Memorial F sub-rules.** Multiple-read-paths, schema-precedent-recheck, acceptance-criterion-coherence, pre-existing-property-coherence.
- **Self-grilling.** [`01-pre-emit-grilling.md`](./01-pre-emit-grilling.md) applied to the spec draft.

T0 catches: undefined terms, contradicted decisions, unverified assumptions, scope drift in the spec itself.

T0 misses: anything that depends on TPM's translation of the spec to actionable routing.

### T1 — TPM routing-emit

The TPM converts spec to actionable routing artifact (pasteable for implementer, tracker entry, decision log). Before forwarding, applies:

- **Pre-route checklist.** All filenames live, all versions current, all line numbers verified, all test counts current, all cross-role claims grep-verified. See [`04-pre-route-checklist.md`](./04-pre-route-checklist.md).
- **TPM grilling.** Self-grilling on the routing artifact, three buckets (CRITICAL / LIKELY-SURFACES / PRE-EMPTABLE).

T1 catches: stale references, mistranslations from spec, scope ambiguity, missing context.

T1 misses: anything that only surfaces during actual implementation (e.g., a contract that compiles in isolation but breaks in integration).

### T2 — Implementation-time

The implementer builds against the routing artifact. Applies:

- **Defensive patterns.** Null checks, edge case handling, empirical verification of spec claims as they are built.
- **Multi-read-paths grep.** Before modifying compile-time substrate, grep all runtime consumers to ensure modifications don't break them.
- **Halt-discipline.** When spec and reality diverge mid-implementation, halt and route-back rather than guess.

T2 catches: contract violations during integration, runtime consumer breakage, performance regressions, edge cases the spec didn't enumerate.

T2 misses: cross-cutting issues that only surface after merge (e.g., subtle interaction with another change that landed in parallel).

### T3 — Post-merge review

The reviewer audits merged code against spec. Applies:

- **Spec-vs-implementation audit.** Each spec claim verified against the corresponding implementation.
- **Cross-cutting checks.** No-skip policy on statistical-invariant tests; audit-state currency (stale references in docs); right-reasons verification (the implementation does what it claims, not just what passes tests).
- **Severity tiering.** PASS / FAIL / GAP per finding; routing back via TPM.

T3 catches: spec-vs-impl drift, ceremonial passes (tests pass but for wrong reasons), documentation staleness.

T3 misses: nothing structural at this point — but T3 is the source of new discipline candidates (issues caught here become memorial candidates).

## What happens when an anchor catches an issue

The issue routes back to the anchor that should have caught it earlier. T3 → T0 if it's a spec issue; T3 → T1 if it's a routing issue; T3 → T2 if it's an implementation issue. The route-back is documented in the post-merge review report.

If the same issue class is caught at T3 multiple times (3+), it becomes a memorial candidate (see [`02-memorial-accretion.md`](./02-memorial-accretion.md)). The memorial encodes the discipline that should have caught it earlier, raising the catch rate at the upstream anchor.

## What about solo work?

For solo work without a multi-role split, the four anchors collapse but the discipline doesn't disappear:

- **T0 → T1:** spec yourself; grill yourself; verify references.
- **T2:** implement with defensive patterns and halt-discipline.
- **T3:** review your own work after merging, ideally in a fresh context (next-day review, separate file, separate session).

The fresh-context T3 step is the hardest to maintain solo because the implementer is also the reviewer. Mitigation: physically separate the contexts (different file, different session, different time of day). Even partial fresh-context provides value over zero.

## Worked example

A typical change that passes through all four anchors:

1. **T0:** architect drafts `Q-NN-SPEC.md` with six practices and 10 P3 axes applied. Self-grills; finds 2 LIKELY-SURFACES; pre-flags them in the spec.
2. **T1:** TPM converts spec to `TPM-REPLY-NN.md` routing pasteable for the implementer. Self-grills; finds 1 PRE-EMPTABLE (a stale config name); fixes inline. Forwards.
3. **T2:** implementer builds against routing. During implementation, discovers spec ambiguity in a corner case. Halts; routes back to architect for clarification. Architect adds 2-line clarification to spec; routing forwards again. Implementation completes. PR opened.
4. **T3:** reviewer audits PR. Verifies spec claims; runs test suite; checks audit-state currency in adjacent docs. Files 2 PASS / 1 GAP. GAP routes back via TPM to architect for fix-forward.

Total overhead: ~30% additional time vs single-anchor (architect-and-implementer-only) workflow. Catch rate (issues caught before they become production incidents): substantially higher than single-anchor — in DeploySignal, the four-anchor defense caught 6+ bugs that single-anchor would have plausibly missed at 60-90% per finding.

## Compatibility

The anchor structure works inside any agent orchestration framework (Superpowers, CrewAI, LangGraph) — each anchor maps to a phase or evaluator. It also works for fully-human teams.

The naming (T0/T1/T2/T3) is convention; rename for your context if useful.

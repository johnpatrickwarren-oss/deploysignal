# DISCIPLINE-REFERENCE

_DeploySignal cross-role discipline reference. Consolidates architect six-practices + 10-axis P3 + Memorial D + Memorial F + V/Q framework + TPM grilling + Architect grilling + Three-layer architect framework. Snapshot 2026-05-05 (post-Q66 Phase-3.d.A close)._

_For current state, see linked memorials at `.auto-memory/`. This doc is the at-a-glance reference; memorials are source of truth._

---

## What this doc is for

A single-page reference for the four roles (Architect / TPM / Mac Claude / Reviewer) at brief-drafting, routing, implementation, and audit time. Consumed by every role at the **start** of any non-trivial work cycle to anchor discipline application.

**When to consult:** before drafting an architect spec, drafting a TPM routing pasteable, starting Mac Claude implementation, or running a Reviewer audit. Not for onboarding (too dense); for ongoing work.

---

## Four-role framework

| Role | Responsibilities | Primary artifacts | Discipline anchors |
|---|---|---|---|
| **Architect** | Spec drafting; dispositions; oversight | `Q-NN-SPEC.md`, `ARCHITECT-REPLY-*.md` | 6 practices + 10 P3 axes + Memorial F + grilling |
| **TPM** | Routing; coordination; memorial landings | `TPM-REPLY-*.md`, `TPM-DISPOSITION-*.md` | TPM grilling + canonical-version-drift discipline |
| **Mac Claude** | Implementation; empirical verification; halt-discipline | feature PRs + `DIAGNOSTIC-*.md` | Defensive implementation patterns + Memorial F P3.3 application |
| **Reviewer** | Spec-vs-impl audit; cross-cutting checks | `REVIEWER-REPORT-NN.md` | No-skip policy + audit-state currency |

---

## Four-anchor pre-merge defense

| Anchor | When | Who | Discipline |
|---|---|---|---|
| **T0** | Architect spec-emit | Architect | 6 practices + 10 P3 + Memorial F application + grilling |
| **T1** | TPM routing-emit | TPM | TPM grilling + canonical-version verification |
| **T2** | Mac Claude implementation-time | Mac Claude | Defensive patterns + Memorial F P3.3 grep |
| **T3** | Reviewer post-merge | Reviewer | Spec-vs-impl audit + cross-cutting |

Each anchor catches what the previous miss. Memorial D accretion rate measures discipline efficacy across cycles.

---

## Architect six practices (T0)

| # | Practice | Closes |
|---|---|---|
| **P1** | Inline derivations for every numerical threshold | REPLY-38 class (ESS 0.7→0.9 unjustified) |
| **P2** | Exhaustive option-space enumeration | REPLY-31 class (multivariate-suppression incomplete) |
| **P3** | Representative-baseline spot-check against concrete shipped state (10 axes; see below) | REPLY-36/44/43a + 8 P3-axis refinements (REPLY-51b/54b/52c/52d/52ge/52gg/52gh/52gi) |
| **P4** | Per-component claim verification + semantic comparability | REPLY-37/43d (cross-family + category-mismatch) |
| **P5** | Pseudo-code vs test-case round-trip + P1-P5 anchor consistency | REPLY-28/42/43d/46b |
| **P6** | Empirical profile verification for performance claims | REPLY-42 pilot-event-2 |

---

## Architect 10 P3 axes (T0)

P3 spot-check exercises actual shipped state across all axes — never illustrative; always concrete; always live.

1. **concrete-values** — open the file with the live constants, not memory
2. **coord-trail** — grep all coordination artifacts that might carry claims
3. **file-opened** — open every file mentioned in contract surfaces
4. **function-bodies** — for extraction-class refactors, open function bodies + grep for module-local mutation
5. **compiled-artifacts** — open the compiled config (not just source) for behavior-on-artifact claims
6. **input-pipeline-alignment** — verify input harness vs compiled substrate before hypothesizing detector-layer bugs
7. **compile-time-precision** — verify FP-precision corner cases at compile time (σ² underflow class)
8. **regime-coverage** — enumerate analytical-pass regime vs orchestrator regime-sweep gap
9. **wrapper-vs-algorithm-layer** — distinguish algorithm-layer formal property vs wrapper-layer code paths
10. **firing-attribution-discipline** — verify firing-ID at source data BEFORE constructing hypothesis tree

Full detail: `.auto-memory/feedback_architect_cross_family_audit.md`

---

## Memorial D — architectural-layer-coverage discipline (T0)

**4-factor prior weighting:**

```
actual_prior = analytical-model-correctness
             × regime-coverage
             × attribution-verification
             × architectural-layer-coverage
```

**At hypothesis-tree drafting time, enumerate ALL architectural layers between calibration source and runtime consumption.** Ensure candidate set covers all layers; weight priors with explicit architectural-layer-coverage discount.

**Discipline interpretation:** when narrowing prior to one architectural layer, actual mechanism is at layer above. When explicitly enumerating across layers, candidate set captures actual mechanism. **The load-bearing forward-looking discipline IS the explicit enumeration**; probability ranking can be off without invalidating the discipline.

**Archive 20V/8C** (post-Q66 Phase-3.d.A close 2026-05-05): 20 violations where discipline NOT applied + 8 confirmations where discipline applied. Ratio trajectory: 1/9 → 2/11 → 3/14 → 5/20 → 7/25 → 8/27 → 8/28. Captures progressively at architect-side AND Mac-Claude-side anchor variants.

**20th VIOLATION class anchor** (Q62 Phase 4 cross-substrate-aggregation-scope ΔFPR halt 2026-05-04): cross-substrate-acceptance-bound-vs-CAVEAT-inheritance-coherence. Architect grilling PE-3 enumeration miss on cross-substrate aggregation scope as separate exemption surface (per-detector + per-substrate + cross-substrate + aggregate-pitch-claim are 4 distinct scopes; sub-rule 4 reinforcement at multi-aggregation-scope per Q62 Phase 4 disposition memo).

**8th CONFIRMATION class — 4 sub-instances post-formalization** (architect-grilling-discipline-pre-empirical-mechanism-capture variant; Q63 Q1 Suggestion 1 sub-instance accumulation discipline anchor):

| # | Cycle | Mechanism variant |
|---|---|---|
| 1 | Q60 V1 LS-1 | input-data-structure-semantic mismatch |
| 2 | Q60 LS-2 | LIKELY-SURFACES-prediction-validation multi-layer |
| 3 | Q64 Phase 4 | calibration-substrate-rationale-option-(γ) anticipation |
| 4 | Q66 SLICE 1 LS-1 (closed at .A.b via H1' pre-whitening) | stationarity-assumption-violation-from-AR(1)-correlation |

Sub-instance accumulation preserves Memorial D state at 20V/8C without inflating CONFIRMATION class count via architectural-class-character-divergence. The discipline-class character (architect grilling pre-empirical capture) is the load-bearing signal; specific mechanism variants validate class character across diverse architectural surfaces.

Full archive: `.auto-memory/feedback_vq_framework_discipline.md`

---

## Memorial F — four sub-rules at brief-drafting time (T0)

Each sub-rule has a distinct trigger condition. Consult all four; apply each whose trigger fires for the spec being drafted. A spec that touches compile-time substrate AND closes an ADR AND introduces a new acceptance criterion fires sub-rules 1+2+3+4; a spec that only modifies a schema fires sub-rule 2.

| # | Sub-rule | When | What to grep |
|---|---|---|---|
| 1 | **P3.3 multiple-read-paths** | Compile-time substrate modifications | Runtime detector code for compile-output objects |
| 2 | **MERGE-vs-REPLACE substrate-stamped-fields-preservation** | Schema modifications on multi-field objects | Substrate-stamped fields populated by calibration pipeline |
| 3 | **ADR-anti-scope-preservation** | Specs that close/realize an ADR | ADR's anti-scope clauses ("DO NOT do X") |
| 4 | **Pre-existing-property-vs-new-acceptance-criterion coherence** | New acceptance criterion / threshold / gate | `methodology_note`, `CAVEAT`, `note:`, `// HACK`, `// TODO` |

Each sub-rule emerged from a Mac-Claude-side defensive implementation patch surfacing an architect-side spec-drafting slip. Reusable across detector families and spec cycles.

Full archive: `.auto-memory/feedback_architect_cross_family_audit.md`

---

## V/Q framework — investigation chain discipline

**V framework — hypothesis-class isolation.** When detector / formal property fails empirically, draft V1.H1 / V1.H2 / V1.H3 hypotheses spanning candidate-mechanism space. Cheapest-test-first ordering (subject to candidate-mechanism space being EXHAUSTIVE; if all hypotheses falsify, extend to next architectural layer).

**Q framework — fix-vs-investigate enumeration.** When V completes, residual unresolved metrics may surface NEW mechanism class. Q1 quick-fix / Q2 architectural-clean / Q3 methodology-isolation / Q4 honest-scope ship / Q5 combo. Q3+Q4 paired = ship pitch-readiness today AND advance investigation in parallel.

**Composition:** V isolates the hypothesis class; Q enumerates fix-vs-investigate options for residuals once V closes.

**Per-tick detector-ID trace methodology** (P4-β.5 evaluation-scope-alignment standard diagnostic; Q2.B.6.1 close + Phase-2.4-v2 canonical worked example): when architect-level hypothesis at one architectural layer fails empirical validation despite high prior, switch to per-tick / per-detector-ID / per-mechanism explicit-enumeration BEFORE re-rolling priors at same layer. Empirical-localization methodology IS the discipline; pattern-matching on aggregate firing-family attribution is the anti-pattern.

Full detail: `.auto-memory/feedback_vq_framework_discipline.md`

---

## Three-layer architect framework

| Layer | Catches what previous miss | Q2.B.6.1 origin |
|---|---|---|
| **L1: Spec-drafting-time analytical reasoning** | First-pass spec quality | P1-P5 pre-route checklist |
| **L2: Compile-time invariant audit** | Architectural-correctness verification | P4-β.4 integration-state-audit |
| **L3: Validation-time empirical verification** | Empirical mechanism localization | Per-tick trace methodology |

Each layer pays compounding dividends within single PR cycles. Compile-time invariant audit (L2) is high-leverage — caught Σ_eps PSD violation; revealed pre-Q2.B.6 baseline as numerical artifact; surfaced calibration-scope-mismatch as actual mechanism (three discoveries from one audit step).

---

## Architect grilling discipline (T0; adversarial pre-emit review)

After six-practice + 10-axis P3 checklist completes, run grilling pass — ACTIVELY HUNT for what could go wrong rather than verify against checklist.

**10 axes** (mirror TPM grilling; role-specific surfaces): adversarial-counterargument, hidden-assumption-enumeration, Mac-Claude-implementation-time-gap-hunting, cross-reference-verification, confidence-prior-justification, edge-case-enumeration, backward-compat-impact, halt-boundary-clarity, **memorial-anchor-application** (Memorial D candidate-set + Memorial F 4 sub-rules at brief-drafting time), source-of-truth-currency.

**Output buckets:** CRITICAL (re-draft before emit) / LIKELY-SURFACES (pre-flag in spec § Open Q or Anti-scope) / PRE-EMPTABLE (fold proactively).

Full detail: `.auto-memory/feedback_architect_cross_family_audit.md` § Architect grilling discipline

---

## TPM grilling discipline (T1; adversarial pre-routing-emit review)

Same 10 axes as architect grilling, applied at TPM routing-pasteable-emit time. Catches cross-message-turn ambiguity, canonical-version drift, memorial-anchor citation errors before John forwards to Mac Claude / Architect / Reviewer.

**Skip when:** pure conversational acknowledgment OR status-relay (forwarding architect/Mac Claude content with no TPM disposition added).

Full detail: `.auto-memory/feedback_tpm_grilling_discipline.md`

---

## Mac Claude defensive implementation patterns (T2)

When implementing an architect spec, Mac Claude routinely catches T0 slips at implementation-time. Established patterns:

- **Memorial F P3.3 grep at Step 0** — open all runtime read paths consuming the modified substrate; verify spec covers all
- **Defensive both-object patches** — when spec targets one object but runtime reads multiple, patch all (page-cusum strict-tier-fast-path origin)
- **MERGE pattern over REPLACE** — preserve substrate-stamped fields when override schema is subset
- **Halt-discipline** — halt to TPM at architect-flagged boundary OR when spec gap surfaces; never speculate-implement

Mac Claude empirical defensive patches are themselves discipline data points — when implementation succeeds AND surfaces architect-side spec gaps, the architectural-archive grows.

---

## Reviewer audit cycle (T3)

Standard cycle ~3-4h; per shipped item verify (a) shipped code matches spec acceptance, (b) test coverage exercises shipped invariant per no-skip policy, (c) gaps surface as REVIEWER-REPORT-NN findings.

**Cross-cutting checks:**
- α-budget bookkeeping (Ville-bounded + classical-epoch-α split)
- No-skip policy on statistical-invariant tests
- Memorial cross-references current at file-state
- Compiled artifact state opened (per P3 axis #5)
- Test count drift (STATUS.md + CHEAT-SHEET.md)

**Findings classification:** PASS / FAIL / GAP. FAIL on core invariants gates next-cycle entry; GAPs resolve in parallel.

---

## Operational discipline memorials (sub-references)

- **Pasteable direction** — lead with one fenced code block; prose comes after (`.auto-memory/feedback_pasteable_direction.md`)
- **Parallel Mac Claude worktree isolation** — separate `git worktree add` per session; `node_modules` symlink (`feedback_parallel_macclaude_worktree_isolation.md`)
- **Pre-merge tsc check** — `tsc -p tsconfig.test.json` against latest main when parallel PRs touch import graph (`feedback_parallel_merge_tsc_check.md`)
- **Cross-team numbering convention** — one round number per topic shared across architect/TPM/PM/reviewer (`project_deploysignal_numbering_convention.md`)
- **No-skip policy on statistical-invariant tests** — Ville / martingale / e-value bound tests assert or feature doesn't ship (`feedback_no_skip_test_policy.md`)
- **Continuous-flow cadence** — next task starts when previous wraps; runway ends when work ends (`feedback_continuous_flow_cadence.md`)
- **3-track parallel operating model** — Reviewer + Architect + Mac Claude continuous tracks; TPM coordinates cross-track (`coordination/TPM-OPERATING-MODEL-3-TRACK-PARALLEL.md`)

---

## How to use this doc

**Architect at spec-drafting time:**
1. Apply six practices (P1-P6).
2. Apply 10 P3 axes for representative-baseline spot-check.
3. Apply Memorial F 4 sub-rules at brief-drafting time.
4. Apply Memorial D candidate-set enumeration at hypothesis-tree time.
5. Run grilling pass (10 axes; CRITICAL/LIKELY-SURFACES/PRE-EMPTABLE).
6. Emit spec via TPM.

**TPM at routing-emit time:**
1. Verify canonical-version labels live (no memory-citations).
2. Run TPM grilling pass (10 axes).
3. Address CRITICAL findings (re-route to architect for amendment OR fix TPM-side).
4. Pre-flag LIKELY-SURFACES in routing pasteable.
5. Fold PRE-EMPTABLE into routing as anti-scope or open-Q.
6. Forward to John for Reviewer / Architect / Mac Claude routing.

**Mac Claude at implementation-time:**
1. Read full architect spec + amendments before coding.
2. Apply Memorial F P3.3 grep at Step 0 (verify spec coverage).
3. Implement with defensive patterns (both-object patches; MERGE; halt-discipline).
4. Halt to TPM at architect-flagged boundaries OR when spec gap surfaces.
5. Emit diagnostic memo at halt; preserve worktree state.

**Reviewer at audit-time:**
1. Per-shipped-item PASS/FAIL/GAP analysis.
2. Cross-cutting checks (α-budget, no-skip, memorial cross-references, compiled artifact state).
3. Emit REVIEWER-REPORT-NN.md routed via TPM.

---

## Why this discipline framework exists

DeploySignal ships formal-statistical guarantees (Ville bounds, supermartingale e-processes, conformal prediction) that depend on calibration coherence between compile-time and runtime, between detector and methodology, between spec and implementation. The discipline framework catches the architectural slip classes that emerge when humans (architect / Mac Claude / TPM / Reviewer) compose these guarantees across multi-layer pipelines.

Memorial D 15V/5C archive demonstrates the framework working empirically — discipline-application catches the same slip classes across detector families AND spec cycles. The compounding dividend is real; per-cycle architect-side VIOLATION rate is the measure.

---

_Snapshot 2026-04-30. For current Memorial D / Memorial F state, see `.auto-memory/`. For active Phase ledger, see `coordination/PHASE-3-COMMITMENTS.md`._

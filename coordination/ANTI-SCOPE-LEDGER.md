# ANTI-SCOPE-LEDGER

_Architect cognitive overhead reduction artifact. Per Memorial F sub-rule 3 (ADR-anti-scope-preservation): architect at brief-drafting time MUST open ALL prior ADRs + verify new spec doesn't violate any anti-scope clauses. This ledger enumerates clauses for mechanical cross-reference._

_Snapshot 2026-05-05 (post-Q66 Phase-3.d.A close + sub-rule 3 INVERTED across .A SLICE 1 + .A.b + .A close). For each new spec drafted post this date, architect verifies new spec doesn't violate clauses below + cross-references applicable ADRs in spec § Anti-scope._

---

## How to use this ledger (architect-side discipline)

At brief-drafting time, for every new spec:

1. **Read ledger.** Open ANTI-SCOPE-LEDGER.md (this file).
2. **Identify applicable ADRs.** Which prior ADRs apply to the spec being drafted? (Check architectural class, system area, signal class, detector family.)
3. **Verify clauses preserved.** For each applicable ADR, walk through its anti-scope clauses; verify new spec doesn't violate.
4. **Cross-reference in spec.** In new spec § Anti-scope, explicitly cite which ADR clauses are verified preserved.
5. **Update ledger if new ADR.** When new spec closes as ADR (e.g., Q2.B.6.4-class declined-feature with anti-scope), TPM lands ADR + adds entry to this ledger post-close-PR-merge.

**Failure mode (Memorial D 13th VIOLATION precedent):** Q58 spec line 38 inadvertently re-introduced Family E aggregate-only Mahalanobis source — Q2.B.6.4 ADR anti-scope. Architect didn't open Q2.B.6.4 ADR before drafting Q58 Family E pool architecture. Mac Claude 2 caught at Step Q58.0 implementation-time grep. Ledger reduces this class of architect-side cognitive miss.

---

## Active ADRs (ordered by Q-cycle close date)

### Q2.B.6.4 P4-β.7 ADR — Family E lookupCell extension declined-feature

**Status:** ADR closed; Phase-3 commitment deferred (per-detector iid_bootstrap pool shipped at Q58 as alternative architectural path).

**Anti-scope clauses (5):**

1. **DO NOT make Family E aggregate-only for Mahalanobis source path.** Family E retains per-cell-preferred `family_C.{mean_vector, covariance, cholesky_L}` with aggregate-fallback per `engine/detectors/conformal.ts:137`. Prior attempt broke 3 novelty TP tests; reverted; preserved as anti-scope.
2. **DO NOT change Family E `calibration_scores` source from aggregate.** Calibration scores stay aggregate per ARCHITECT-REPLY-16 Q2 disposition.
3. **DO NOT touch `engine/detectors/*` runtime code.** Runtime detector code unchanged at Q2.B.6.4 ADR commitment scope.
4. **DO NOT refactor TrendBuffer or orchestrator dispatch.** Per-detector calibration symmetry happens at trajectory-generation time, not at TrendBuffer or orchestrator time.
5. **DO NOT introduce per-detector row-pool data structure.** Q2.B.6.4 architectural realization is per-detector resampler-mode dispatch (Q58), not per-detector row-pool object.

**Memorialized at:** `coordination/ARCHITECT-REPLY-Q2-B-6-4-PATH-A-HALT-DISPOSITION.md`. Pulled forward to Q58 spec § Anti-scope verification.

---

### Phase 2.4 demo-substrate carve-out ADR

**Status:** ADR closed; Q57 demo baseline refresh shipped for follow-on-deferred (closed 2026-04-29).

**Anti-scope clauses (2):**

1. **Demos serve narrative storytelling; production validation serves empirical-validation evidence.** Different fixture roles; intentionally different substrate alignment semantics.
2. **Demo refresh = follow-on commitment.** [Closed at Q57 close 2026-04-29; clause retired but historical preservation here.]

**Memorialized at:** `coordination/ADR-PHASE-2-4-DEMO-SUBSTRATE-CARVE-OUT-2026-04-28.md` (relocated to coordination/ via Reviewer-09 Item 9 fix-forward).

---

### Q57 close-PR demo refresh (Phase-3.d Slice 0 — closed)

**Status:** Closed 2026-04-29 via demo refresh. v7-demos.json canonical demo storytelling substrate post-Q2.A re-baselining.

**Anti-scope clauses (1; carry-forward note):**

1. **Demo trajectory regeneration NOT activated** (deferred at Q57 spec; re-baselining Path-3 worked; trajectory regeneration absorbs into topic 56 baseline curation pipeline if reactivated).

**Memorialized at:** `coordination/Q57-DEMO-BASELINE-REFRESH-SPEC.md` (CLOSED).

---

### Q58 close-with-CAVEAT amendment

**Status:** Q58 close-with-CAVEAT inheritance for `family_A_page_cusum` under iid_bootstrap mode; preserved as PERMANENT post-Q59 H4 PERMANENT close.

**Anti-scope clauses (2):**

1. **NO Page-CUSUM validation methodology re-engineering at Q58 close.** Page-CUSUM iid-bootstrap amplification is pre-existing-known-property documented in `tools/build-report-card.js:755-762 fpr_classical_epoch.methodology_note` since pre-Q58. Future reconciliation work was tagged Phase-3.c sub-track (Q59); Q59 attempted methodology-layer fix; Q59 H4 PERMANENT preserved Q58 CAVEAT as PERMANENT post-empirical-insufficiency. **Phase-3.c.2 (compile-time substrate extension) + Phase-3.d (Ville-bounded re-engineering) tagged future cycles.**
2. **NO per-detector amplification-factor tuning of α-budget × 1.2 acceptance margin.** Margin is methodologically derived from Wilson-Hilferty Poisson noise; per-detector tuning would conflate statistical noise vs methodology amplification.

**Memorialized at:** `coordination/Q58-PER-DETECTOR-IID-BOOTSTRAP-POOL-SPEC.md` § Acceptance criterion #5 CAVEAT clause + `ARCHITECT-REPLY-Q58-STEP-4-PAGE-CUSUM-CAVEAT-DISPOSITION.md`. CAVEAT inheritance restored byte-identical at Q59 H4 PERMANENT close 2026-05-01.

---

### Q59 H4 PERMANENT close (Phase-3.c CLOSED-NO-RESOLUTION-PER-H4-PERMANENT)

**Status:** Q59 attempted methodology-layer fix architecturally insufficient for substrate-calibration-layer mismatch; H4 PERMANENT picked; reverted; Q58 CAVEAT preserved.

**Anti-scope clauses (3 + carry-forward):**

1. **NO compile-time `ar1_phi` extension to family_A.** Q59 fits phi on-demand from cellRows at FPR-sweep time. Q2.B.6.1 family_D `ar1_phi` calibration pipeline unchanged. (Phase-3.c.2 future-tagged candidate would relax this; current state preserves.)
2. **NO Page-CUSUM Ville-bounded re-engineering.** Q59 ships methodology fix; Q59.3 Ville-bounded re-engineering tagged as Phase-3.d future cycle. Phase-3.d clause: classical-epoch-α detectors retire as legacy; replaced with Howard-Ramdas-McAuliffe-Sekhon-2021 mixture-supermartingale (Page-CUSUM) + Shekhar-Ramdas-2023 betting-e-process (MMD-bootstrap-null). Tagged future per Phase-3.d activation criterion.
3. **NO α-amplification-factor calibration.** Q59.2 path REJECTED; conflates statistical noise vs methodology amplification.

**Carry-forward:** Q2.B.6.4 ADR clauses 1-5 verified preserved at Q59 close (no engine/detectors/* changes; no orchestrator/TrendBuffer changes; no row-pool data structure; Family E per-cell-preferred Mahalanobis source preserved).

**Memorialized at:** `coordination/Q59-PAGE-CUSUM-RECONCILIATION-SPEC.md` (CLOSED-NO-RESOLUTION-PER-H4-PERMANENT) + `ARCHITECT-REPLY-Q59-STEP-Q59-4-RESUME-DISPOSITION.md`.

---

### Q60 Slice 1 V2 — Phase-3.d Slice 1 (CLOSED 2026-05-01 + 2026-05-02)

**Status:** Q60 Slice 1 Phases 1+2 + Phase 3 follow-up CLOSED. Phase-3.d.1 sub-track CLOSED-COMPLETE-VIA-β.1 2026-05-02.

**Anti-scope clauses (8):**

1. **NO new schema-map mappers in Slice 1.** Existing 4 mappers (mapBurstGPTRows + mapAzureLLMRows + mapMooncakeRows + mapGroundedSyntheticOverlay) cover Slice 1 datasets. New mappers (HuggingFace, research-paper traces) are Slice 2 scope.
2. **NO NAB integration in Slice 1.** Per Q60.5 architect-pick; deferred to Phase-3.d Slice 3 (C11) standalone.
3. **NO live customer telemetry.** Enterprise-infrastructure boundary preserved per John's Q1 disposition.
4. **NO modification to v5-sequential-e-process.json production validation substrate.** v5 stays canonical production validation; v8X substrates are NEW additive artifacts.
5. **NO Family E novelty detection design changes** (preserves Q2.B.6.4 ADR anti-scope; cross-reference clauses 1-2 above).
6. **NO compile-time calibration changes for synthetic-v1 baseline.** Q60 introduces real-data substrates; doesn't touch synthetic calibration pipeline.
7. **NO `engine/detectors/*` runtime code changes** (preserves Q58 ADR anti-scope clause 3 + Q59 H4 PERMANENT clause).
8. **NO Q58/Q59 acceptance criteria modifications.** Q60 acceptance criteria are PER-PROFILE additive; v5 production validation substrate's existing acceptance criteria UNCHANGED.

**Phase-3.d.1 multi-layer disposition (post-Q60 LS-2 + L3b):**

- **(A) calibrate.ts sparse-skip emission** at compile-time (per L1 architect-pick).
- **(D) run-shadow-compare.ts per-detector exemption clause** at FPR-sweep-time (per L2 architect-pick).
- **(corollary) collectCellRows manifest-signal coverage** (per L3a architect-pick).
- **(β.1) parametric_ar1 sparse-substrate-skip via detector_exemption_reason extension** (per L3b architect-pick post-Q60 Phase 3 halt).

**Carry-forward:** Q2.B.6.4 + Phase 2.4 carve-out + Q58 close-with-CAVEAT + Q59 H4 PERMANENT all verified preserved at Q60 V1 + V2 + Phase 3 dispositions.

**Memorialized at:** `coordination/Q60-PUBLIC-POSTMORTEM-INGESTION-SPEC.md` (V2 amended; CLOSED) + `ARCHITECT-REPLY-Q60-SLICE-1-PHASE-1-1-DISPOSITION-V2.md` + `ARCHITECT-REPLY-Q60-SLICE-1-PHASE-3-LS2-SPARSE-SIGNAL-DISPOSITION.md` + `ARCHITECT-REPLY-Q60-PHASE-3-L3B-PARAMETRIC-AR1-SPARSE-DISPOSITION.md`.

---

### Q66 Phase D BATCH — Phase-3.d.A sub-track (CLOSED 2026-05-05; sub-rule 3 INVERTED)

**Status:** Phase-3.d.A SLICE 1 + .A.b H1' AR(1) pre-whitening + .A close all CLOSED 2026-05-05. Sub-rule 3 INVERTED application across 3 cycles — Phase D's purpose IS ADR retirement; clauses tagged for retirement are explicitly retired at sub-track close.

**Anti-scope state transitions (5 ADR clauses; 3 RETIRED + 2 PRESERVED):**

| ADR | Clause | Status post-Q66 Phase-3.d.A | Cycle | Reasoning |
|---|---|---|---|---|
| Q58 close-with-CAVEAT | Clause 1: NO Page-CUSUM validation methodology re-engineering | **CLOSED-RETIRED** | Q66 SLICE 1 close | Phase D's purpose IS exactly this re-engineering; anytime-valid Ville-bounded variant ships SLICE 1. |
| Q58 close-with-CAVEAT | Clause 2: NO per-detector amplification-factor tuning | **PRESERVED** | — | Phase D scope doesn't introduce per-detector amplification-factor tuning. Re-evaluable at Phase-3.d.D consolidation. |
| Q59 H4 PERMANENT | Clause 1: NO compile-time `ar1_phi` extension to family_A | **CLOSED-RETIRED** | Q66 .A.b close | H1' pre-whitening adds `family_A.per_signal.ar1_phi` compile-time field as architecturally clean fix to AR(1)-correlation stationarity-violation; sub-rule 3 INVERTED extension to .A.b sub-track. |
| Q59 H4 PERMANENT | Clause 2: NO Page-CUSUM Ville-bounded re-engineering | **CLOSED-RETIRED** | Q66 SLICE 1 close | Phase D's purpose is exactly this re-engineering. |
| Q59 H4 PERMANENT | Clause 3: NO α-amplification-factor calibration | **PRESERVED** | — | Phase D scope doesn't introduce α-amplification-factor calibration; preserved through Phase-3.d.D. |

**Phase-3.d.A close additional state changes:**

- **`tools/run-shadow-compare.ts CROSS_SUBSTRATE_FPR_EXEMPT_DETECTORS` narrowed:** family_A_page_cusum exemption RETIRED at .A close (Ville-bound mode-invariance retires the exemption requirement); family_B_pattern_match exemption preserved per Q60 V2 family_b_trip_rate_note structural-non-α-consuming classification.
- **Q62 H1a+H1b cross-substrate ΔFPR exemption** for family_A_page_cusum **PARTIAL RETIREMENT** at Q66 Phase-3.d.A close (per Q62 spec AC #13 amendment); preserved for non-family-A detectors; future-detector exemption infrastructure intact.

**Memorial D state evolution across Q66 cycles:** preserved at 20V/8C; Q66 LS-1 stationarity-assumption-violation classified as 4th sub-instance within already-counted 8th CONFIRMATION class (architect-grilling-discipline-pre-empirical-mechanism-capture variant) per Q63 Q1 Suggestion 1 sub-instance accumulation discipline anchor.

**OTHER ADR clauses preserved at Q66 Phase D BATCH:**

- Q2.B.6.4 (5 clauses): preserved (no family_E touch; no engine/detectors/* refactor beyond family_A mixture-supermartingale; no TrendBuffer/orchestrator refactor; no row-pool data structure).
- Phase 2.4 demo-substrate carve-out (2 clauses): preserved.
- Q57 close (1 carry-forward): preserved.
- Q60 V2 (8 clauses + Phase-3.d.1 multi-layer): preserved (Q66 doesn't touch real-trace ingestion framework; v8X + v9X substrates unchanged).
- Q61 SPEC-1 (baseline curation pipeline SLICE 1): preserved (Q66 doesn't touch compile-time pipeline orchestration).
- Q62 SPEC-2 (HuggingFace research-paper ingestion): preserved (Q66 SLICE 1 + .A.b + .A close don't touch substrate ingestion); cross-substrate ΔFPR exemption clause for family_A_page_cusum partial-RETIRES at .A close per Q62 spec AC #13 amendment.
- Q63 SPEC-3 (per-tick detector trace tool): preserved + USED (per-tick trace tool primitive consumed for empirical mechanism localization at .A.b LS-1 surface).
- Q64 SPEC-4 (NAB firewall): preserved + RE-DERIVED (NAB acceptance thresholds may re-derive for Ville-bounded variants at Phase-3.d.D close per Slice 4 sub-track).

**Disposition-file-commit-state P3 axis sub-class — PERMANENT TPM workflow formalization (10 cycles sustained zero firing 2026-05-05):** Per Reviewer-20 §H + REPORT-19 §F + REPORT-16 §C trigger criterion (3-5 cycles → permanent TPM workflow), the disposition-file-commit-state P3 axis sub-class is now formally documented as PERMANENT TPM pre-route checklist line-item. 10 consecutive clean instances post-formalization (Q61 fix-forward + Q62 Phase 2 + Q63 + Q64 + Q65 + Q62 Phase 4 + Q64 Phase 4 + Q66 SLICE 1 + Q66 .A.b + Q66 Phase-3.d.A close). Permanent fold-in via memorial refresh at `feedback_tpm_routing_canonical_version_drift.md`.

**Memorialized at:** `coordination/Q66-PHASE-3-D-A-PAGE-CUSUM-MIXTURE-SUPERMARTINGALE-SPEC.md` (v2 amended at G1 batch docs PR 2026-05-05) + `coordination/PHASE-D-VILLE-BOUNDED-RE-ENGINEERING-FRAMING.md` + `coordination/ARCHITECT-REPLY-Q66-PHASE-3-D-A-b-DISPOSITION.md` + `coordination/REVIEWER-REPORT-18.md` + `REVIEWER-REPORT-19.md` + `REVIEWER-REPORT-20.md`.

---

### Q29 Anvil chaos-verdict packaging (PRD-29 + Q29-ANVIL-CHAOS-VERDICT-SPEC; 2026-05-21)

**Status:** Spec emitted; v1 stub-implementation landed (PRD-29 AC-1 through AC-11 closed at this PR). SLICE 2 (Chaos Mesh translation + CLI demo + walkthrough) landed via DS PR #19. Cross-repo `chaos_experiment` event_class extension merged into `deploysignal-engine` PR #1 (2026-05-22) — originally targeted Tessera but redirected to `deploysignal-engine` after R94's engine-repo extraction moved the contract files there. The stale local patch artifacts (`coordination/TESSERA-CHAOS-EXPERIMENT-EVENT-CLASS*.patch`) deleted post-merge. Active.

**Anti-scope clauses (6):**

1. **NO per-experiment detector retraining or online calibration of `expected_failure_pattern`.** Anvil v1 declares the pattern at experiment-start. Learning the pattern from experiment history is L5 learning-loop scope (future PRD).
2. **NO chaos-platform authoring UX.** DS does not own the Gremlin / Chaos Mesh / AWS FIS / Litmus UI surface. Anvil reads experiment definitions; it does not author them.
3. **NO live customer-tenancy chaos runs.** Enterprise-infrastructure boundary (cross-tenant data; SOC2). Anvil ships against public-tier substrates + synthetic chaos definitions only.
4. **NO fifth chaos platform at v1** (Steadybit, ChaosToolkit, Powerfulseal, etc.). Scope-discipline; deferred to a Slice 2.
5. **NO continuous-chaos verdict streaming.** Anvil v1 is per-experiment-bounded. Always-on chaos verdicting depends on L5 learning-loop.
6. **NO new detector family for chaos-specific signals.** Preserves Q2.B.6.4 ADR (no `engine/detectors/*` runtime code beyond Phase D batch). Anvil reuses the five existing families with chaos-aware suppression at the orchestrator layer.

**Carry-forward verification at Q29 spec-emit:**

- **Q2.B.6.4 ADR clauses 1–5:** preserved (no `engine/detectors/*` touch; Family E source unchanged; no row-pool data structure; no TrendBuffer/orchestrator refactor beyond an O(1) suppression-window check gated on `expectedFailurePattern !== undefined`).
- **Phase 2.4 demo-substrate carve-out:** preserved (Anvil doesn't touch demo substrate).
- **Q57 carry-forward:** preserved.
- **Q60 V2 clauses 1–8:** clauses 1, 2, 4, 5, 6, 7, 8 trivially preserved (no substrate/detector/synthetic-calibration touch); clause 3 (NO live customer telemetry) explicitly preserved per Anvil anti-scope clause 3.
- **Q66 Phase-3.d.A and downstream:** preserved.
- **Enterprise-infrastructure boundary** (John's Q1 disposition 2026-04-30): preserved.
- **No-skip policy:** preserved (Ville-bound tests under chaos profile must continue to assert; Q29 tests under `test/q29-*` are illustrative-deferred but the regression suite under `expectedFailurePattern === undefined` remains byte-identical per PRD-29 AC-11).

**Architectural mechanism summary:** verdict-vocabulary translation at adapter boundary (Q29.2); family-suppression at orchestrator layer (gated on `expectedFailurePattern !== undefined` to preserve back-compat); typed contracts under `engine/o0/anvil/`; reference profile `anvil-chaos-experiment@1.0.0` under `profiles/` extending `generic-microservice@1.0.0`. Wedge is positioning + audit substrate; adapter network-call implementations follow-on.

**Memorialized at:** `coordination/PRD-29-anvil.md` § Out-of-Scope + `coordination/Q29-ANVIL-CHAOS-VERDICT-SPEC.md` § Anti-scope + `NORTH-STAR-ARCHITECTURE.md` Addition #29 section + `ORCHESTRATION-ADAPTERS.md` Chaos-experiment adapter family section + `COMPETITIVE-GAPS-ADDITIONS.md` GAP-29.

---

### Q30 Cairn structured-RCA / postmortem attribution (PRD-30 + Q30-CAIRN-ATTRIBUTION-SPEC; 2026-05-21; extracted to sibling repo 2026-05-22)

**Status:** Spec emitted; v1 implementation landed (PRD-30 AC-1 through AC-10 closed in DS PR #21 2026-05-21). **Extracted 2026-05-22 to sibling repo at https://github.com/johnpatrickwarren-oss/cairn** for architectural consistency with the rest of the bundle (DS / Tessera / Cairn — three sibling products on the shared `deploysignal-engine` substrate). DS-side artifacts (engine/cairn/*, tools/cairn.js, test/q30-cairn-*, demos/cairn-*, coordination/PRD-30/Q30-spec) removed via the extraction PR; Cairn's PRD + spec + tests now live in the Cairn repo's `coordination/` + `test/`. The Q30 anti-scope clauses below carry forward as governing Cairn-repo discipline. Active.

**Anti-scope clauses (7):**

1. **NO new detector family for attribution.** Cairn is a scoring layer atop the existing engine; Q2.B.6.4 ADR clauses 1–5 preserved (no `engine/detectors/*` runtime touch).
2. **NO causal-inference framing** (Pearl-style counterfactuals / do-calculus). Cairn does **alignment-based ranked attribution** of timing-consistent candidates; framing the output as "causal" would invite scrutiny the v1 algorithm can't survive (honesty discipline; PRD-30 AS-3).
3. **NO live incident-management webhook adapters at v1** (PagerDuty / Opsgenie / incident.io / Statuspage). Generic `candidatesFromExternalEvents` ingest helper only; production-grade adapters are Slice 2.
4. **NO multi-incident batch RCA at v1.** Cairn v1 is one-incident-at-a-time; cross-incident pattern detection is a future PRD.
5. **NO narrative auto-generation.** Cairn outputs structured ranked data; narrative synthesis is advisory-layer scope (Addition #27).
6. **NO web UI dashboard for Cairn at v1.** CLI + JSON output is the v1 surface.
7. **NO real-time / streaming attribution.** Postmortems are batch-mode; in-incident "live root-cause" indicator is a candidate Slice 2.

**Carry-forward verification at Q30 spec-emit:**

- **Q2.B.6.4 ADR clauses 1–5:** preserved (Cairn lives at `engine/cairn/`, no `engine/detectors/*` touch).
- **Q29 ADR Anvil clauses 1–6:** preserved (Cairn consumes Anvil's `ExpectedFailurePattern` records as candidate events; doesn't extend Anvil semantics; ingests via minimal local interface to stay loosely coupled).
- **Q60 V2 clause 3** (no live customer telemetry): preserved (Cairn ships against synthetic fixtures + existing DS demos at v1).
- **Phase 2.4 demo-substrate carve-out:** preserved (Cairn doesn't touch demo substrate).
- **Q57 / Q66 / Phase D batch:** preserved (Cairn doesn't touch detector/substrate code).
- **Enterprise-infrastructure boundary** (John's Q1 disposition 2026-04-30): preserved.
- **No-skip policy:** preserved (26 Q30 tests all assert; no skips).

**Architectural mechanism summary:** scoring layer atop existing engine; Gaussian timestamp-alignment kernel × per-cause-kind prior × evidence-quality boost; mechanistic-inconsistency suppression for post-incident timestamps; engine-inferred onset preference when available; replay-clean CLI driver.

**Memorialized at:** `coordination/PRD-30-cairn.md` § Out-of-Scope + `coordination/Q30-CAIRN-ATTRIBUTION-SPEC.md` § Anti-scope + `NORTH-STAR-ARCHITECTURE.md` Addition #30 section + `COMPETITIVE-GAPS-ADDITIONS.md` GAP-30.

---

## TAGGED-future commitments (anti-scope on activation)

### Phase-3.c.2 — Compile-time substrate extension for substrate-anchored validation-methodology

**Status:** TAGGED future architect-driven cycle (post-Q59 H4 PERMANENT). Anti-scope on activation: must preserve Q58 close-with-CAVEAT semantic OR explicitly retire it via formal Phase-3.c.2 architectural commitment.

### Phase-3.d — Ville-bounded re-engineering (classical-epoch-α detector retirement)

**Status:** **CLOSED 2026-05-07** (Phase-3.d.D close PR merge). Phase-3.d sub-track FULLY CLOSED across .A + .B + .C + .D + .E (.A SLICE 1 + .A.b + .A close + .A.c.α [Layer 1 PENDING re-disposition] + .A.c.γ + .γ.b + .γ.c [PR #131 merged 2026-05-07]; .B SLICE 1 [PR #124 merged 2026-05-07]; .C [PR #132 WIP merged 2026-05-07]; .D [this PR — Q69 close]; .E SLICE 1 [PR #133 merged 2026-05-07; SLICE 2 substantive predicate logic deferred per architect's iterative-refinement pattern]). Subsumed Phase-3.c.2. **Phase D BATCH architecturally CLOSED at this PR merge;** production deployment hardening (Phase E) future-tagged.

**Phase D BATCH close — full ADR-clause walk (Q69.5 — sub-rule 3 INVERTED extension to .D):**

| ADR | Clause | Pre-Q69 status | Post-Q69 stamp |
|---|---|---|---|
| Q58 close-with-CAVEAT | Clause 1: NO Page-CUSUM validation methodology re-engineering | CLOSED-RETIRED (Q66 SLICE 1) | **CLOSED-RETIRED-FULL** (Phase-3.d.D walk closure; Q69.5) |
| Q58 close-with-CAVEAT | Clause 2: NO per-detector amplification-factor tuning | PRESERVED | **PRESERVED-PERMANENT-POST-PHASE-D** (Q69.7 ASK B pick (ii); Phase-3.d scope didn't introduce per-detector amplification-factor tuning; clause provides architectural anchor for hypothetical future cycles — Phase E or beyond — that could re-introduce the conflation) |
| Q59 H4 PERMANENT | Clause 1: NO compile-time `ar1_phi` extension to family_A | CLOSED-RETIRED (Q66 .A.b) | **CLOSED-RETIRED-FULL** (walk closure) |
| Q59 H4 PERMANENT | Clause 2: NO Page-CUSUM Ville-bounded re-engineering | CLOSED-RETIRED (Q66 SLICE 1) | **CLOSED-RETIRED-FULL** (walk closure) |
| Q59 H4 PERMANENT | Clause 3: NO α-amplification-factor calibration | PRESERVED | **PRESERVED-PERMANENT-POST-PHASE-D** (Q69.7 ASK B pick (ii); analogous to Q58 clause 2 reasoning) |
| Q60 V2 (8 clauses + Phase-3.d.1 multi-layer) | Various (no schema-map mappers in Slice 1; no NAB integration in Slice 1; etc.) | PRESERVED | **PRESERVED** — Q69 doesn't touch real-trace ingestion framework |
| Q61 SPEC-1 | (baseline curation pipeline SLICE 1) | PRESERVED | **PRESERVED** — Q69 doesn't touch compile-time pipeline orchestration |
| Q62 SPEC-2 | (HuggingFace research-paper ingestion + AC #13 cross-substrate exemption amendment) | PRESERVED + PARTIAL-RETIRED-AT-Q66 | **PRESERVED + PARTIAL-RETIRED-CONFIRMED** — cross-substrate ΔFPR exemption clause for `family_A_page_cusum` partial-RETIRES per Q62 spec AC #13 amendment carries forward |
| Q63 SPEC-3 | (per-tick detector trace tool) | PRESERVED + USED | **PRESERVED + USED-AT-PHASE-D** — per-tick trace tool primitive consumed at .A.b LS-1 surface + .A.c.γ LS-1 surface + Q73 Phase 1 family_D investigation |
| Q64 SPEC-4 | (NAB firewall) | PRESERVED + RE-DERIVED-CANDIDATE | **TAGGED-PENDING NAB acceptance threshold re-derivation at Phase-3.d Slice 4 activation** (Q69.7 ASK C pick (iii) HYBRID; Q64 spec amendment deferred to Slice 4 architect-pick at activation; preserves architectural-anchor visibility without forcing re-derivation work into Q69 scope) |
| Q66 (Phase-3.d.A SLICE 1 + .A.b + .A close + .A.c.γ.c) | All sub-tracks | CLOSED | **CLOSED-CONFIRMED** at Q69 close walk |
| Q67 (Phase-3.d.B SLICE 1) | All sub-tracks | CLOSED | **CLOSED-CONFIRMED** at Q69 close walk |
| Q68 (Phase-3.d.C SPEC + impl) | All sub-tracks | CLOSED (PR #132 merged 2026-05-07; partial WIP close — Q68.3 ALPHA rename done; classical code paths retired) | **CLOSED-CONFIRMED** at Q69 close walk |
| Q70 (Phase-3.d.E SPEC + impl) | All sub-tracks | CLOSED (SLICE 1 PR #133 merged 2026-05-07; SLICE 2 deferred) | **CLOSED-CONFIRMED-AT-SLICE-1** at Q69 close walk |

**Phase D BATCH architectural close stamp:** every Family A + Family C detector is anytime-valid Ville-bounded; classical-epoch-α detectors retired at code-path level (Q68); CAVEAT inheritance retired at runtime semantic level (Q66 .A close); spec-side documentation + schema deprecation finalized at Q69. Aggregate-pitch-claim transforms to "Family A Page-CUSUM mixture-supermartingale (Howard-Ramdas-McAuliffe-Sekhon-2021) + Family C MMD betting-e-process (Shekhar-Ramdas-2023) — anytime-valid Ville-bounded; strict α-budget × 1.2 acceptance under all methodology-resampler modes; NO methodology-dependency CAVEAT" per sub-rule 4 reinforcement at multi-aggregation-scope (Q69.6).

**Phase-3.d.E SLICE 1 anti-scope (sub-rule 3 INVERTED — extends from .A + .B + .C to cross-cutting .E):**

- **Cross-detector calibration regime architecture is the architectural anchor at Q70.** Per-detector exemption rules + self-normalized fallback are the architectural mechanisms.
- Q66 .A.c.γ.c family_A_page_cusum compound predicate preserved EXACTLY at SLICE 1 (regression-tested: 18/18 Q66 cases green post-refactor).
- Q67 SLICE 1 mmd_betting NO exemption preserved at Q70.
- NO new substrate generation at Q70 (production-AR(1)-data substrate TAGGED FUTURE Phase E per spec § Q70.3 option iii).
- NO retroactive Q66 / Q67 amendment at Q70 (existing predicates preserved; family_C_safe_test exemption is distinct scope from family_C_mmd_betting / mmd_betting Q67 surface).
- NO sweep mode retirement at Q70 (sweep modes preserved; conditional exemption + self-normalized fallback handle mismatch).
- **SLICE 1 vs SLICE 2 split:** SLICE 1 ships dispatch-table refactor + self-normalized fallback module + schema additions + tests for the architectural foundation; substantive per-detector predicate logic + calibrator stamping + detector wiring + sweep validation deferred to SLICE 2 per architect's anticipated LS-1 iterative-refinement pattern (Q66 .γ → .γ.b → .γ.c precedent).

### Phase-3.d Slice 2 — HuggingFace + research-paper trace ingestion

**Status:** TAGGED future cycle. Anti-scope on activation: preserve all Q60 Slice 1 V2 anti-scope clauses 1-8 above; new mappers for new datasets; per-substrate compiled configs additive (v9X+) without modifying existing v5/v7/v8X.

### Phase-3.d Slice 3 — NAB firewall for Families A/D

**Status:** TAGGED for C11 standalone follow-on scope. Anti-scope on activation: NAB acceptance criterion may shift if Phase-3.d Ville-bounded variants ship first; architect re-derives at activation.

### Q72 SLICE 2 family_D-invariant-relaxation — RETIRED-AT-Q73-CLOSE

**Status:** RETIRED 2026-05-07 at Q73 Phase 3 close (Path 2.b pipeline-modification per `ARCHITECT-REPLY-Q73-PHASE-1-CLOSE-INTAKE-AND-PHASE-2-ROUTING`).

Q72 SLICE 2 Phase 3.B HALT #1 disposition (per `ARCHITECT-REPLY-Q72-SLICE-2-MC-2-HALT-DISPOSITION.md`) introduced `Q72_FAMILY_D_INVARIANT_RELAXED` flag in `test/replay-regression-v2.test.js` to allow family_D zero-fire on the W5 §T1 fixture, pending Q73 fixture-scenario-recuration. Q73 Phase 1 empirical investigation (per `coordination/DIAGNOSTIC-Q73-PHASE-1-FAMILY-D-FIXTURE-INVESTIGATION-2026-05-07.md`) localized the mechanism: Family A mixture-supermartingale Ville-bounded variant fires at tick 18 on `adv_w4_oscillation_kv_cache`; Family D's 20-sample long-view threshold fills at tick 19; the regenerator's `if (r.verdict === 'rollback') break` short-circuited at tick 18 → Family D never evaluated. One-tick gap.

Phase 2.b pipeline-modification: regenerator runs full TOTAL_TICKS regardless of rollback; per-record `q73_first_rollback_tick` field preserves production-semantic rollback decision boundary for downstream consumers. Family D fires 52 times across the regenerated 480-record fixture; W5 §T1 invariant restored. Family D detector code unchanged on current main HEAD (architect-pre-prediction (a) ~70% confirmed: FIXTURE-SHAPE-SPECIFIC class with rollback-short-circuit-vs-window-length-mismatch wrinkle). Phase D close trajectory unaffected.

---

## Cross-cutting anti-scope reminders

**Enterprise-infrastructure boundary (per John's Q1 disposition 2026-04-30):**

- DO NOT introduce production traffic / live deploys
- DO NOT introduce real customer telemetry (cross-tenant data; SOC2-required)
- DO NOT introduce paid-tier-cloud / the target platform-enterprise integration
- DO NOT introduce authentication / SSO / role-based access infrastructure
- **OK to use:** personal hardware (laptop; Mac mini B4 per `feedback_compute_server_routing.md`); free-tier cloud; public-tier datasets (HuggingFace; research-paper traces; public postmortems).

**No-skip policy (per `feedback_no_skip_test_policy`):**

- DO NOT skip statistical-invariant tests (Ville / martingale / e-value bound).
- Test must assert OR feature doesn't ship; documented architectural skips → delete + HISTORICAL-SKIPS.md per REPORT-09 CC2 fix-forward precedent.

**Pasteable direction (per `feedback_pasteable_direction`):**

- DO lead pasteables with one fenced code block containing all prereqs; prose comes after.

**Worktree isolation (per `feedback_parallel_macclaude_worktree_isolation`):**

- DO use separate `git worktree add` per Mac Claude session; DO NOT race git ops on shared working tree.

---

_Ledger version 1.1 (post-Q66 Phase-3.d.A close 2026-05-05; Phase D BATCH section added with sub-rule 3 INVERTED across .A SLICE 1 + .A.b + .A close cycles). Updated post-close-PR-merge for any new ADR cycle. Cross-reference SPEC-TEMPLATE.md § Anti-scope for canonical spec usage._

_Architect-side discipline application is mechanical: open this ledger; identify applicable ADRs; verify clauses preserved; cross-reference in spec § Anti-scope. Memorial F sub-rule 3 satisfaction reduced to ledger-walk + verification rather than memory-recall._

# PRD-29: Anvil — chaos-verdict packaging on the DeploySignal substrate

_Owner: Product Manager (John, with assistance)._
_Drafted: 2026-05-21. Last updated: 2026-05-21._
_Status: draft._

_Framework: Anchor methodology (PRD template; PM role)._

---

## Goal

Chaos-engineering platforms (Gremlin, Chaos Mesh, AWS FIS, Litmus, Verica) inject faults well, but they leave the **verdict** — did the system behave acceptably under the injected fault? — to an operator eyeballing dashboards. The chaos-experiment workflow is structurally a deploy gate run backward: instead of "deploy and decide whether to roll back," the operator runs "inject fault and decide whether the system passed." DeploySignal already owns the verdict surface for the forward direction (Ville-bounded multi-family detector portfolio, audit substrate). **Anvil** packages the bundle `DS engine + Tessera (sibling product, https://github.com/johnpatrickwarren-oss/tessera) + chaos-platform adapter family` as a verdict layer for chaos experiments — targeting Verica-style buyers who today have a credibility gap on principled FP-controlled outcome assessment.

Tessera fits the bundle naturally: it's a sibling product that already vendors the DS engine at SHA `5a72371` and applies it to per-shard cluster observation (per-shard residual semantics + hierarchical e-value combination + e-BH FDR control + topology-aware freeze-hook). Shard-targeted chaos experiments (pod-kill on shard-04, network-partition on rack-2, latency-injection on a tenant subset) line up exactly with Tessera's per-shard scope. The Anvil capability lands inside DS as a docs-only positioning addition + typed contracts + adapter stubs + chaos-reference profile; the per-shard observation layer comes from Tessera via its existing `engine/ds-integration/` HTTP contract (no new contract surfaces required at Anvil v1).

Success from the buyer's frame: a chaos-engineering team runs an experiment in Gremlin (or Chaos Mesh, AWS FIS, Litmus) and receives a structured verdict — `experiment_passed` / `experiment_failed_unexpectedly` / `experiment_inconclusive` — keyed against an `expected_failure_pattern` declared at experiment-start. The verdict carries the same DeploySignal audit provenance the forward direction emits, so post-experiment review reconstructs which detector family fired, what α was spent, and which baseline cell the comparison ran against. For shard-targeted experiments, the per-shard attribution layer is sourced from Tessera.

---

## Target user / personas

- **P1 — Chaos-engineering practitioner at a Verica-style buyer.** Runs scheduled chaos game-days; designs experiments with expected blast radius and an a-priori hypothesis of what "passing" looks like; today writes the pass/fail call in a postmortem doc by hand. Cares about reproducibility, audit trail, and not having their FP-controlled credibility undermined by ad-hoc verdicts.
- **P2 — Platform-SRE running standing chaos automation.** Has continuous chaos in production (Chaos Mesh / AWS FIS); needs an automated verdict the on-call rotation trusts. Today often disables continuous chaos because the noise-vs-signal ratio of dashboard-eyeballing isn't worth the on-call cost.
- **P3 — DeploySignal existing user adding chaos to their delivery pipeline.** Already uses DS for canary verdicts; wants the same audit substrate for their chaos experiments without learning a second product.

---

## User stories

- **US-1:** As a chaos-engineering practitioner (P1), I want to declare at experiment-start what failure shape I expect (e.g., "p99 latency rises by ≤30% within ≤45s and recovers within ≤60s post-fault"), so that the verdict is keyed against my hypothesis rather than against the workload's normal baseline.
- **US-2:** As a platform-SRE (P2), I want my Chaos Mesh / Gremlin / AWS FIS / Litmus experiment runs to hit a single verdict endpoint that returns `pass` / `fail_unexpectedly` / `pass_with_concerns` with audit provenance, so my on-call rotation gets one paged signal not a dashboard.
- **US-3:** As an existing DS user (P3), I want to pick a `anvil-chaos-experiment` profile in my CompiledConfig the same way I pick `llm-inference-streaming`, so I don't onboard a new product.
- **US-4:** As any of P1/P2/P3, I want the verdict to suppress detector families that the injected fault was *expected* to cause to fire (so the verdict says "the fault produced its expected effect" rather than "rollback"), but still fire on unexpected blast — e.g., if I injected latency, an unexpected error-rate spike is the signal of interest.

---

## Functional requirements

- **FR-1 — `expected_failure_pattern` on DeployContext.** The orchestration adapter contract (Addition #9 `DeployContext`) gains a new optional field `expected_failure_pattern`. Schema: `{ kind, affected_signals[], magnitude, magnitude_unit, recovery_seconds, suppress_families[] }`. Populated by the chaos adapter from the experiment definition; absent → orchestrator behaves as a normal canary gate (back-compat hard gate). Traces to US-1, US-4.
- **FR-2 — Four chaos-platform O0 adapters.** New adapter family under `engine/o0/anvil/`: `gremlin`, `chaos-mesh`, `aws-fis`, `litmus`. Each implements `OrchestrationAdapter` (`emitVerdict`, `fetchDeployContext`) + the chaos-specific extension `fetchExpectedFailurePattern(experiment_ref) → ExpectedFailurePattern`. Traces to US-2.
- **FR-3 — `anvil-chaos-experiment` reference profile.** New profile YAML at `profiles/anvil-chaos-experiment.yaml` extends `generic-microservice@1.0.0`. Profile-schema gains optional `expected_failure_pattern` defaults block. Traces to US-3.
- **FR-4 — Verdict-vocabulary extension.** A chaos run's `FusedVerdict.verdict` maps from the existing `proceed | extend | rollback | suppressed_insufficient_samples` to chaos vocabulary: `proceed → experiment_passed`; `rollback → experiment_failed_unexpectedly` (with `expected_failure_pattern` matched-or-not-matched annotation); `extend → experiment_still_running`. Mapping lives at the adapter boundary, not in the engine — engine emits its native vocabulary; adapter translates per `DeployContext.strategy === 'chaos_experiment'`. Traces to US-2.
- **FR-5 — Expected-fault family suppression.** When `expected_failure_pattern.suppress_families` is populated, the named detector families (e.g., `['A_p99_latency']` for an injected-latency experiment) are suppressed with `suppression_reason: 'expected_failure_pattern'` for the duration of the fault window. Suppression does NOT extend beyond the declared `recovery_seconds`. Traces to US-4.
- **FR-6 — Audit-record extension.** `AuditRecord` gains optional `expected_failure_pattern` top-level field (mirrors `schema_continuity` / `traffic_allocation_continuity`). Replay-clean: same compiled config + same chaos experiment definition + same metric stream produces the same verdict. Traces to US-1.

---

## Non-functional requirements

- **NFR-1 (performance).** Adapter `fetchDeployContext` + `fetchExpectedFailurePattern` together must complete in < 200 ms p99 at experiment-start (call once per experiment). Per-tick gate evaluation cost unchanged from the pre-Anvil baseline (Anvil adds zero per-tick work; suppression check is O(1) lookup against a precomputed signal-family set).
- **NFR-2 (back-compat).** Pre-Anvil compiles and runtime paths must be byte-identical when `expected_failure_pattern` is absent and `DeployContext.strategy ≠ 'chaos_experiment'`. Same property the existing additions (#9, #10, #11, #13, #14) all maintain.
- **NFR-3 (positioning).** README must surface Anvil as a packaged capability targeted at Verica-style buyers, distinct from but built on the existing DS engine. Re-brand framing: "DS-Anvil — chaos-engineering verdicts on the DeploySignal substrate."
- **NFR-4 (statistical-invariant preservation).** Ville bound on the α-participating portfolio MUST hold across all enabled detector families inside a chaos experiment, exactly as for the canary direction. No detector-family math changes; Anvil is packaging + adapters + profile + vocabulary, not statistics.

---

## Acceptance criteria

- [ ] **AC-1:** `engine/o0/anvil/types.ts` defines `ExpectedFailurePattern` and `ChaosExperimentContext` exported types matching FR-1 schema. (traces FR-1)
- [ ] **AC-2:** Four adapter modules exist at `engine/o0/anvil/{gremlin,chaos-mesh,aws-fis,litmus}.ts`, each exporting a class implementing the adapter contract with at least typed stub bodies + provenance docstrings citing the upstream chaos platform's experiment-definition API. (traces FR-2)
- [ ] **AC-3:** `profiles/anvil-chaos-experiment.yaml` exists, validates against the updated profile schema, and resolves cleanly through `tools/profile-loader.ts` (extends `generic-microservice@1.0.0` with chaos-specific bake profile + α reallocation). (traces FR-3)
- [ ] **AC-4:** `profiles/schema/profile.schema.json` gains optional `expected_failure_pattern_defaults` field with `additionalProperties: false` enforcement. (traces FR-3)
- [ ] **AC-5:** `OrchestrateParams` in `engine/types/orchestration.ts` gains transitional `expectedFailurePattern?: ExpectedFailurePattern` field with the same "stand-in until Addition #9 DeployContext is materialized" docstring pattern Addition #10 used for `expectedCanaryWeight`. (traces FR-1)
- [ ] **AC-6:** NORTH-STAR-ARCHITECTURE.md gains an Addition #29 section that (a) introduces Anvil as the chaos-verdict packaging layer; (b) adds `expected_failure_pattern` to the `DeployContext` spec block; (c) cross-references the new adapter family + profile; (d) preserves Anchor pre-emit grilling output structure. (traces FR-1, FR-2, FR-3, FR-4)
- [ ] **AC-7:** ORCHESTRATION-ADAPTERS.md gains a "Chaos-experiment adapter family" section documenting the inverted-verdict mapping (FR-4), the four target platforms, and the expected-pattern declaration contract. (traces FR-2, FR-4)
- [ ] **AC-8:** COMPETITIVE-GAPS-ADDITIONS.md gains a GAP-29 entry (Tier 1 — Runway-add candidate) describing the Verica-style buyer gap and the recommendation to land Addition #29. (traces NFR-3)
- [ ] **AC-9:** README.md gains a "DS-Anvil — chaos verdicts" positioning paragraph (or section) surfacing the capability for Verica-style buyers. (traces NFR-3)
- [ ] **AC-10:** ANTI-SCOPE-LEDGER.md gains a "PRD-29 / Q29 Anvil" entry enumerating clauses explicitly NOT in scope (no per-experiment detector retraining; no chaos-platform-side experiment authoring UX; no live customer-tenancy chaos runs in this cycle). (traces all)
- [ ] **AC-11:** When `expected_failure_pattern` is absent and `DeployContext.strategy ≠ 'chaos_experiment'`, all existing tests pass byte-identically. (traces NFR-2)

---

## Out-of-scope

- **AS-1: Per-experiment detector retraining / online calibration of `expected_failure_pattern`.** Reason: belongs to L5 learning-loop. Anvil v1 declares the pattern at experiment-start; learning the pattern from experiment history is a separate PRD.
- **AS-2: Authoring UX inside Gremlin / Chaos Mesh / AWS FIS / Litmus.** Reason: DS does not own the chaos-platform UI surface. Anvil reads experiment definitions; it does not author them.
- **AS-3: Live customer-tenancy chaos runs.** Reason: cross-tenant data crosses the enterprise-infrastructure boundary per John's Q1 disposition 2026-04-30 in `ANTI-SCOPE-LEDGER.md`. Anvil ships against public-tier substrates + synthetic chaos definitions only.
- **AS-4: A fifth chaos platform (Steadybit, ChaosToolkit, Powerfulseal, etc.).** Reason: scope-discipline. Four canonical platforms (Gremlin, Chaos Mesh, AWS FIS, Litmus) cover the Verica-style buyer's actual stack; additional platforms are Slice 2.
- **AS-5: Continuous-chaos verdict streaming.** Reason: Anvil v1 is per-experiment-bounded (start → end). Always-on chaos verdicting is downstream of L5 learning-loop activation.
- **AS-6: New detector family for chaos-specific signals (e.g., "fault-recovery slope").** Reason: anti-scope across the existing Q2.B.6.4 ADR (no new `engine/detectors/*` code beyond Phase D batch). Anvil reuses the five existing families with chaos-aware suppression, not a new family.

**Cross-references to ANTI-SCOPE-LEDGER preserved:**

- **Q2.B.6.4 ADR clauses 1–5** preserved (Anvil touches no `engine/detectors/*` runtime code; Family E source unchanged; no new row-pool data structure; no TrendBuffer/orchestrator refactor).
- **Q60 V2 clauses 3 (NO live customer telemetry)** preserved (AS-3 above).
- **Enterprise-infrastructure boundary** preserved (no production-traffic / SSO / paid-tier-cloud introduced).
- **No-skip policy** preserved (Ville-bound tests under chaos profile must continue to assert).

---

## Priority

- **Must-have:** AC-1, AC-2 (stub bodies; full implementation deferred), AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11.
- **Should-have:** Worked example showing one of the four adapters end-to-end against a synthetic chaos definition (deferred to a follow-on cycle; not gating this PRD).
- **Could-have:** A demo entry under `demos/` that runs an "anvil chaos" canned scenario in the single-frame dashboard. Deferred — adds storytelling lift but is not load-bearing on the positioning play.
- **Won't-have (this cycle):** Detector-family retraining; chaos-platform authoring UX; live customer-tenancy chaos; fifth platform; continuous-chaos streaming; chaos-specific detector family.

---

## Success metrics

- **SM-1 (positioning):** At least one Verica-style buyer conversation references the Anvil capability by name within 60 days of the README update, traceable to a pitch artifact that links to this PRD.
- **SM-2 (developer ergonomics):** A DS user implementing one of the four chaos adapters against their own platform can land a working `fetchExpectedFailurePattern` + `fetchDeployContext` + `emitVerdict` cycle in ≤ 1 engineering-day, based on the typed contract surface + the spec.
- **SM-3 (statistical-invariant preservation):** Replay-suite + Ville-bound tests are byte-identical pre- vs post-Anvil when `expected_failure_pattern` is absent. Non-zero diff at AC-11 is a release blocker.

---

## Dependencies

- **Upstream (must land before this):** Addition #9 (O0 orchestration adapter layer — typed `DeployContext` interface, currently spec-level + transitional `OrchestrateParams` stand-ins). Anvil ships its own transitional stand-in (`expectedFailurePattern` on `OrchestrateParams`) mirroring Addition #10's pattern, so the cycle is not blocked on Addition #9's materialization.
- **Downstream (depend on this):** L5 learning-loop chaos-pattern auto-derivation (out of scope here; future PRD).
- **Parallel (touch related surface; coordination needed):** Addition #11 (`suppressed_insufficient_samples` verdict) — chaos verdicts under low traffic should map cleanly to the same suppression vocabulary.
- **Sibling product (cross-repo bundle):** [Tessera](https://github.com/johnpatrickwarren-oss/tessera). The DS-Anvil buyer bundle composes DS engine + Tessera per-shard observation + chaos-adapter family. Anvil v1 requires no Tessera-side change — the existing Tessera↔DS HTTP contract (`engine/ds-integration/feed-contract.ts` + `event-contract.ts`) carries the per-shard verdict observations cleanly. A chaos-specific `event_class` extension to Tessera's 5-value closed-set (`firmware_push | model_redeploy | env_change | config_change | capacity_change`) would be a cross-repo amendment deferred to Tessera's Phase 4 design cycle. Anvil v1 reads the existing contract; doesn't add to it.

---

## Open questions

- **OQ-1:** Should `expected_failure_pattern.suppress_families` accept per-signal granularity (e.g., `family_A:p99_latency`) or only family-level (`family_A`)? PM lean: family-level for v1 (matches the existing `suppression_reason` enum granularity); per-signal is Slice 2 if chaos practitioners demand it. Architect resolves at Q29 spec-emit.
- **OQ-2:** Does the chaos-verdict vocabulary belong in the engine (rename `proceed → experiment_passed` inside `FusedVerdict.verdict` when `strategy === 'chaos_experiment'`) or stay at the adapter boundary (engine emits `proceed`; adapter renames on the way out)? PM lean: adapter boundary, to preserve the no-engine-detectors-touch anti-scope from Q2.B.6.4. Architect confirms or overrides at Q29.
- **OQ-3:** Should Anvil ship a default `anvil-chaos-experiment` profile that enables all five detector families, or default to Family A + Family C only (matching what chaos-experiment-noise signal-richness typically supports)? PM lean: Family A + Family C only by default for v1; chaos practitioners with richer signal inventories can override via customer-override YAML. Architect confirms at Q29.

---

## Update history

- **2026-05-21:** Initial draft. PM artifact for Anvil capability — chaos-verdict packaging on the DeploySignal substrate. Targets Verica-style buyer wedge. Framework: Anchor (PRD template).

---

## Notes for the PM

- Every AC traces to at least one FR or NFR (AC-1→FR-1, AC-2→FR-2, AC-3+AC-4→FR-3, AC-5→FR-1, AC-6→FR-1/2/3/4, AC-7→FR-2/4, AC-8→NFR-3, AC-9→NFR-3, AC-10→cross-cutting, AC-11→NFR-2). No untraceable ACs.
- Every FR traces to at least one US (FR-1→US-1+US-4, FR-2→US-2, FR-3→US-3, FR-4→US-2, FR-5→US-4, FR-6→US-1). No untraceable FRs.
- This PRD is a positioning play — most of the implementation lift is in docs + typed contracts + a profile YAML. The four adapter modules ship as typed stubs with provenance docstrings, not full implementations, because Anvil's wedge value is the verdict surface + the audit substrate, not the chaos-platform integrations themselves (those are commodity).

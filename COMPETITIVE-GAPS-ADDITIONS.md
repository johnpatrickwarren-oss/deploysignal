# Competitive-Landscape → Capability Additions

_Architect analysis. Drafted 2026-04-19 as a reading of `COMPETITIVE-LANDSCAPE.md`._
_Purpose: extract every capability gap, design pattern, or operator-ergonomics surface where competitors do something useful that DeploySignal doesn't (or doesn't yet), classify by scope and architectural placement, and recommend disposition (add / defer / cede)._
_Audience: architect-on-architect for self-review; TPM for sequencing into follow-on roadmap; John for pitch decisions and deciding what to commit to in the conversation vs what to honestly cede._

## Reading conventions

Each gap labeled `GAP-##`. Per-gap fields:

- **Source:** which competitor(s) surface this pattern.
- **What they do:** one-line description.
- **Architectural placement:** where it lives in DS (L0/L1/L2/L3/L4/L5 layer, named addition, orchestration adapter, or new component).
- **Scope:** `Runway` (lands before the target audience, ~hours of work) / `First 90 days` (for follow-on Q1, real-data-dependent) / `Q2+` (for follow-on later) / `Cede` (not DS's lane).
- **Effort:** Small (<2 hours) / Medium (1–3 days) / Large (1+ week).
- **Pitch impact:** Does landing this change what the pitch says?

---

## Tier 1 — Runway-add candidates (small, high pitch leverage)

These are quick architectural additions that strengthen the pitch and aren't load-bearing on real data. Most are spec-only or single-fusion-layer changes.

### GAP-01 — Sample Ratio Mismatch (SRM) check in L0

- **Source:** LaunchDarkly Guarded Rollouts (ships SRM as a separate always-rollback channel).
- **What they do:** Compare expected vs observed traffic-allocation ratios (e.g., expected 5% canary, observed 3% canary) and trip an automatic rollback if mismatch detected. Catches infrastructure-level routing bugs that confound any subsequent statistical analysis.
- **Architectural placement:** L0 ingestion preprocessing, alongside addition #8 (schema-continuity check). New L0 subsystem: `traffic-allocation-continuity check`.
- **Scope:** Runway (spec-only addition; implementation in follow-on).
- **Effort:** Small (architect spec ~30 min; implementation 2–3 hours for follow-on).
- **Pitch impact:** Significant. SRM is well-known to anyone who has run A/B tests at scale; LD shipping it is a credibility signal we currently can't match. Closes a discoverable competitive gap. Recommend adding as Architecture Addition #10.

**Recommendation:** Add to north-star doc this week as Addition #10 (docs-only). Spec: L0 emits `traffic_allocation_continuity` flag per tick; if observed canary fraction deviates from expected by >2σ over rolling window, trip `srm_detected` and the gate emits `rollback` short-circuit at G1 with `short_circuit: "srm"`. Treat as policy-layer check (G1 short-circuit), not as a Family E novelty fire — SRM has its own deterministic semantics.

### GAP-02 — `suppressed_insufficient_samples` verdict + minimum-context guard

- **Source:** LaunchDarkly Guarded Rollouts (auto-rollbacks if traffic is too thin to support analysis).
- **What they do:** When samples are below statistical-power threshold, refuse to evaluate and either rollback conservatively or surface `insufficient context.` Robust-to-edge-case behavior.
- **Architectural placement:** L3 verdict fusion + per-family eligibility logic (extends addition #4 per-signal bake profile and the family suppression patterns from REPLY-13).
- **Scope:** Runway (spec change; small implementation in fusion layer).
- **Effort:** Small (architect spec inline; implementation ~1 hour).
- **Pitch impact:** Closes a robustness vulnerability. A reviewer asking "what happens if traffic is too low?" today gets a fuzzy answer. With this, the answer is clean: "verdict is `suppressed_insufficient_samples`; configurable to rollback-conservative or pass-with-warning." Strengthens the calibrated-confidence pitch beat.

**Recommendation:** Extend the existing `suppression_reason` enum in `audit/SCHEMA.md` v2 with `insufficient_samples`. Add per-family `min_samples_for_evaluation` to `BakeProfile`. L3 fusion: if all families return `suppressed` for `insufficient_samples` reason at final tick, emit verdict `suppressed_insufficient_samples` (new top-level verdict variant) rather than collapsing to `proceed` per Q1 Option 1. Decision dial: services can configure whether `suppressed_insufficient_samples` defaults to proceed or rollback — operator policy, not architect policy.

### GAP-03 — Per-pod / node-level verdict breakdown

- **Source:** Harness (node-level metric comparison: each canary node vs each primary node).
- **What they do:** When the orchestrator supplies per-pod labels, run the comparison per-pod rather than aggregating over the canary set. Catches pod-specific regressions (one bad pod in a healthy canary fleet) that aggregated comparison misses.
- **Architectural placement:** L1 characterization (multi-scale window per pod, not just per canary cohort). Cell matrix extension (addition #2) to include `pod_id` as a dimension when present.
- **Scope:** Runway (architect spec); implementation depends on whether real telemetry includes per-pod labels (for follow-on).
- **Effort:** Medium (architect spec 1 hour; implementation depends on telemetry shape).
- **Pitch impact:** Material correctness gap. Right now an aggregated DS verdict on a 10-pod canary could miss a single-pod regression that Harness would catch. Closing it removes an honest weakness.

**Recommendation:** Extend addition #2 cell-matrix dimensions to optionally include `pod_id` when present in telemetry; emit per-pod verdicts when label cardinality supports it; aggregate to canary-level verdict via portfolio fusion at the cohort level. Architect spec only this week; implementation in follow-on with real telemetry. Frame in pitch as: "When per-pod labels are available, per-pod verdicts; when not, cohort-level. Same fusion semantics either way."

### GAP-04 — Fail-Fast / Ignore threshold contract surface

- **Source:** Harness Continuous Verification ("Fail-Fast thresholds (hit → fail without analysis) vs Ignore thresholds (below → skip analysis; above → run comparative analysis)").
- **What they do:** Operator-defined "if metric crosses X, immediately fail without running the statistical analysis" (panic threshold) and "if metric stays below Y, skip the comparative analysis entirely" (gate-around-the-gate). Both reduce wasted analysis cycles and let operators encode hard-stop rules outside the statistical machinery.
- **Architectural placement:** G1 policy gate. Extends `policyContext` with `fail_fast_thresholds` and `ignore_thresholds` per signal.
- **Scope:** Runway (spec-only addition; implementation small for follow-on).
- **Effort:** Small (architect spec 30 min).
- **Pitch impact:** Demonstrates operator-ergonomics maturity. SRE leads love panic thresholds because they sidestep the "wait for the statistical test to confirm what we already know" problem. Closes a UX ergonomics gap.

**Recommendation:** Extend addition #5 (reversibility classification in G0) and addition #6 (incident-state input to G1) with a sibling spec for fail-fast/ignore thresholds. Three-tier policy contract: hard-stop fail-fast bounds; comparative-analysis ignore bounds; statistical detector portfolio inside. Gives operators the panic-threshold escape hatch without compromising the architecture.

### GAP-05 — Business-event-driven lifecycle hooks in O0

- **Source:** Dynatrace Site Reliability Guardian (`guardian.validation.triggered` → workflows → Guardian → `guardian.validation.finished` event-driven contract).
- **What they do:** Pipeline posts a business event; gate processes; gate emits structured lifecycle events (triggered/started/objective-evaluated/finished) for orchestrator and downstream consumers.
- **Architectural placement:** O0 orchestration adapter. Extends `OrchestrationAdapter` interface with a lifecycle-event emission contract.
- **Scope:** Runway (spec extension to ORCHESTRATION-ADAPTERS.md).
- **Effort:** Small (architect spec 1 hour; implementation in follow-on).
- **Pitch impact:** Industry-pattern alignment. Matches Dynatrace's framing in a way that reads as "we know how this should look at scale." Removes a "you haven't thought about lifecycle events" follow-up question.

**Recommendation:** Extend ORCHESTRATION-ADAPTERS.md with a `LifecycleEventEmitter` contract: `evaluation.triggered`, `evaluation.started`, `evaluation.tick` (per-tick verdict), `evaluation.suppressed`, `evaluation.finished` with `final_verdict`. Adapters implement. Orchestrator subscribes. Mirrors Dynatrace's pattern; provides clean integration point for any orchestrator (Argo Rollouts, Flagger, Spinnaker) that wants to react to lifecycle transitions.

### GAP-06 — Effect-size confidence interval rendering alongside p-value

- **Source:** LaunchDarkly Guarded Rollouts (ships absolute-difference CI, not just p-value).
- **What they do:** Display the confidence interval on the metric difference (e.g., "p99 latency change: +8ms ± 4ms with 95% CI"); rollback condition is "CI falls entirely on the worse-performance side."
- **Architectural placement:** L4 audit + L3 verdict (new field `effect_size_ci` on `DetectorTrip` for Family A mSPRT).
- **Scope:** Runway (architect spec for audit schema v2.1 / inline patch).
- **Effort:** Small (architect spec; implementation 1 hour for Family A; CIs are derivable from mSPRT state).
- **Pitch impact:** Adds a more-intuitive readout alongside `cusum_progress` and `alpha_spent`. CIs are what most engineers think in (despite mSPRT giving p-values), so rendering both serves both audiences.

**Recommendation:** Add `effect_size_ci: {lower, upper, confidence_level}` to Family A `DetectorTrip.provenance` block. Computed from Page-CUSUM state and the mixture prior. Optional field in v2.1 schema bump (post-phase minor schema revision); UI renders alongside `cusum_progress` for Family A trips. Doesn't replace `alpha_spent` (Ville-bound budget tracking) but complements it.

### GAP-07 — `policy_short_circuit` family-equivalent in v2.1 schema

- **Source:** Implicitly already specified in `audit/SCHEMA.md` v2 §"What v2 does not do" (deferred per REPLY-13 S7).
- **What they do:** Several competitors (Datadog, New Relic, Dynatrace, Harness) emit per-cause attribution for short-circuit / policy-driven decisions. DS currently surfaces flag-driven short-circuits (`security`, `artifact`, `provenance`, `contract`, `toolchain`, `tokens`) only via top-level `short_circuit` + `reason` fields.
- **Architectural placement:** Audit schema v2.1, `policy_details` block.
- **Scope:** First 90 days (lands when first real flag-driven scenarios surface in production shadow mode).
- **Effort:** Medium (schema design + audit writer + reader updates).
- **Pitch impact:** Currently honest-broker'd via the schema's "what v2 does not do" section; closing the gap removes a known blind spot. Recommend committing to v2.1 timeline for follow-on so it's not just deferred indefinitely.

**Recommendation:** Already on the post-phase list per REPLY-13; surface in pitch as "v2.1 work alongside first customer-service flag-integration." No runway action.

### GAP-29 — Chaos-engineering verdict surface (Anvil, Addition #29)

- **Source:** Verica + the broader chaos-engineering ecosystem (Gremlin, Chaos Mesh, AWS FIS, Litmus, ChaosToolkit).
- **What they do:** Inject faults principally and well; the *verdict* (did the system behave acceptably under the injected fault?) is left to operators eyeballing dashboards. Per-platform "experiment results" surfaces today are descriptive (here's the metric trace) rather than evaluative (here's the verdict, with FP control). The chaos-engineering market today has no principled FP-controlled verdict surface.
- **Architectural placement:** O0 adapter layer (Addition #9) — four new modules under `engine/o0/anvil/`. New `expected_failure_pattern` field on `DeployContext` (Addition #29 contract extension; transitional stand-in via `OrchestrateParams.expectedFailurePattern`). New reference profile `anvil-chaos-experiment@1.0.0` under `profiles/` (joins Addition #28 v1 profile inventory). Verdict vocabulary translation at adapter boundary (Q29.2 architect-pick) — engine emits its native vocabulary, adapter renames per `DeployContext.strategy === 'chaos_experiment'`.
- **Scope:** Runway (positioning play; ~1 cycle of spec + typed contracts + profile + four adapter stubs + five doc updates).
- **Effort:** Small to Medium.
- **Pitch impact:** Material. Re-brands the bundle `DS engine + Tessera + chaos-adapter family` as a packaged chaos-engineering verdict product targeted at Verica-style buyers. Targets buyers who today have weak verdict surfaces on their chaos investment. The bundle leverages a sibling product (Tessera, https://github.com/johnpatrickwarren-oss/tessera) for the per-shard observation layer — chaos experiments commonly target specific shards / pods / nodes, and Tessera's per-shard residual semantics + e-BH FDR control + topology-aware freeze-hook line up exactly with that scope. No new product builds; existing pieces compose.

**Recommendation:** Land as Architecture Addition #29 per PRD-29 and Q29-ANVIL-CHAOS-VERDICT-SPEC.md. Stub adapter implementations are sufficient at v1 — the wedge is the typed contract surface + the audit substrate, not the network-call implementations. Q2.B.6.4 ADR clauses 1–5 preserved (no `engine/detectors/*` runtime touch). Tessera-side contract amendment (chaos-event-class extension to `engine/ds-integration/event-contract.ts`) is cross-repo future work, not Anvil v1 scope.

### GAP-30 — Structured RCA / postmortem attribution (Cairn, Addition #30)

- **Source:** SRE postmortems across every team; Dynatrace Smartscape does topology RCA; Datadog Service Map does dependency tracing; nobody does statistically-rigorous attribution that combines deploy verdicts + cluster observations + incident timelines + (optional) chaos experiment results into a probabilistic root-cause distribution.
- **What they do:** When a regression escapes deploy-gate and steady-state observation and lands in prod, the postmortem RCA today is *manual and unstructured* — an SRE reads dashboards, scrolls audit logs, eyeballs deploy timelines, and writes a narrative as rigorous as the author's pattern-matching that week. Existing topology-RCA tools (Smartscape, Service Map) provide dependency graphs but don't rank candidates by timing-alignment with the incident under statistical control.
- **Architectural placement:** New module `engine/cairn/` (scoring layer + ingest helpers); CLI at `tools/cairn.js`. Consumes existing wire shapes: DS audit JSONL, Tessera VerdictGroupPayload, Anvil ExpectedFailurePattern, and a generic external-event JSON shape (incident-mgmt webhook payloads, env-change feeds). No new detector family — Q2.B.6.4 ADR preserved.
- **Scope:** Runway-substantive — has real attribution math (Gaussian timestamp-alignment kernel × per-kind prior × evidence-quality boost; mechanistic-inconsistency suppression; engine-inferred onset preference), not a stub-only positioning play. ~1 cycle.
- **Effort:** Medium (typed contracts + scoring algorithm + 4 ingest helpers + CLI + 26 tests + walkthrough doc + 5 positioning-doc updates).
- **Pitch impact:** Material. Closes the lifecycle loop. The bundle pitch: "**DeploySignal catches before promotion. Tessera observes during steady state. Cairn attributes when something escapes both — statistically, not by eyeballing dashboards.**" Strong Verica/Casey adjacency: chaos engineering finds weaknesses *before* they cause incidents; Cairn ranks them *after*. Two halves of the same methodology.

**Recommendation:** Land as Architecture Addition #30 per PRD-30 and Q30-CAIRN-ATTRIBUTION-SPEC.md. Honesty discipline (PRD-30 AS-3): Cairn does **alignment-based ranked attribution**, not Pearl-style causal inference. The output document language uses "ranked attribution of timing-consistent candidates," never "root cause." Live PagerDuty / Opsgenie / incident.io webhook adapters are Slice 2, paired with first buyer conversation.

---

## Tier 2 — First 90 days for follow-on (real-data-dependent or integration-heavy)

These either need real the target platform telemetry or surface area that doesn't exist current-cycle. Architecturally specifiable now; implementation is shadow-mode-and-after work.

### GAP-08 — Auto-generated SLI / verification profiles (zero-config day-one)

- **Source:** Harness 2026 release ("AI auto-builds verification profiles from existing dashboards").
- **What they do:** When a service onboards, scan existing observability dashboards / alerts / SLOs to auto-generate the initial detector configuration. Operator can refine; doesn't have to start from scratch.
- **Architectural placement:** Above the metric registry layer (addition #3) — call it M0+, an "onboarding wizard" that derives M0's Tier-1 SLI list from existing org observability artifacts.
- **Scope:** First 90 days (needs real production observability surface to auto-derive from).
- **Effort:** Medium (~1 week follow-on to wire up first integration with whatever the operator uses for SLO definitions).
- **Pitch impact:** Closes a discoverable adoption-friction gap. "How long does it take to onboard a new service?" — Harness can say "minutes"; DS today says "operator declares SLIs." Auto-generation reduces operator cost.

**Recommendation:** Architect adds to north-star as Addition #11 (docs-only this week). Spec: M0+ scanner reads service's existing SLO definitions, alert rules, and dashboard panels; derives candidate Tier-1 SLI list with proposed `delta_min` values from existing alert thresholds; surfaces to operator for review-and-accept; produces initial CompiledConfig. Implementation in follow-on once production observability surface (whatever it is) is mapped. Pitch language: "Zero-config day-one onboarding via integration with existing observability artifacts."

### GAP-09 — Log clustering as a learning-loop signal

- **Source:** Harness (Known/Unknown/Unexpected-Frequency log clustering); Datadog Watchdog (new error-type detection).
- **What they do:** Cluster post-deploy log lines; flag clusters that didn't exist pre-deploy as "Unknown" (potential novel issues) or clusters whose frequency changed materially as "Unexpected Frequency."
- **Architectural placement:** Family E (conformal novelty) extension OR new Family F (log-stream novelty). Adjacent but distinct from Family E's metric-distribution novelty.
- **Scope:** First 90 days (needs real log streams).
- **Effort:** Large (1–2 weeks; log clustering is its own subsystem).
- **Pitch impact:** Adds a signal class DS doesn't currently have. Logs are where engineers actually look during incident triage; integrating them as a gate input is natural.

**Recommendation:** Specify as a possible extension (Addition #12 — log-stream novelty channel) but flag as "we'd build this in shadow mode after first customer service is in advisory" — needs real logs at production volume to calibrate. Pitch language: "Log-stream novelty is a natural Family F extension once we're operating against real telemetry; runway delivers the metric-distribution novelty in Family E and the log channel is a known follow-on."

### GAP-10 — Pre-deploy evaluation suite integration ("eval_score is a Tier-1 SLI")

- **Source:** Anthropic / OpenAI public writeups; W&B LLM Evaluation Jobs; HF eval ecosystem.
- **What they do:** Run benchmark / eval suite pre-deploy; result is a quality score that feeds the deploy gate's decision.
- **Architectural placement:** L0 ingestion (eval_score becomes a first-class signal in the metric registry) + G1 policy (eval_score below threshold can fail-fast).
- **Scope:** First 90 days (needs real eval pipeline integration at production scale).
- **Effort:** Small (the signal is already in the architecture; integration is wiring the eval runner to publish a Prometheus metric or similar).
- **Pitch impact:** Closes a "what about pre-deploy evals" follow-up. Already partially addressed (eval_score is in the Family A registry); closing means actually wiring it.

**Recommendation:** Already specified architecturally (eval_score is in DETECTOR_REGISTRY.A). Frame in pitch: "Pre-deploy evals are upstream; their results feed our gate as a Tier-1 SLI via the metric registry. We don't replace evals; we make their results actionable inside the deploy decision."

### GAP-11 — Change-card UX for verdicts

- **Source:** New Relic Change Tracking; Datadog Change Tracking; Honeycomb Intelligence.
- **What they do:** Render verdicts in dashboards as compact "change cards" with summary + drill-down rather than raw audit JSON.
- **Architectural placement:** L4 observability (UI rendering layer), not engine.
- **Scope:** First 90 days (depends on production observability dashboard surface).
- **Effort:** Medium (UI work with whatever dashboard tooling the operator uses).
- **Pitch impact:** UX expectation; reviewer sees "well-formed dashboard cards" as a sign of production-grade work. Currently DS provenance renders in the demo's drawer; production UI doesn't exist.

**Recommendation:** Follow-on UI work. Pitch language: "Verdicts emit as structured records; rendering as dashboard cards is a thin overlay on whatever monitoring surface the operator uses (Grafana, Datadog, internal). Demo shows the data structure; production UI is integration work."

### GAP-12 — Kayenta-compatible REST API for migration drop-in

- **Source:** Spinnaker / Kayenta is the canonical reference for "automated canary analysis"; teams already using Kayenta have an integration footprint.
- **What they do:** Kayenta is a standalone REST service that AnalysisTemplates call. DS could expose a Kayenta-compatible API (same request/response shape) so that teams running Spinnaker + Kayenta can swap providers transparently.
- **Architectural placement:** O0 orchestration adapter, Kayenta-compat layer.
- **Scope:** First 90 days (only valuable if the operator runs Spinnaker + Kayenta today; speculative).
- **Effort:** Medium (API surface is documented; mapping to DS's verdict shape is mechanical).
- **Pitch impact:** Strong if the target platform does run Kayenta; modest if they don't. Worth a one-line offer in pitch: "If you're on Kayenta today, Kayenta-compatible API surface is a 1-week follow-on add to make migration a config flip."

**Recommendation:** Specify in ORCHESTRATION-ADAPTERS.md as a Level 1.5 (between web metric provider and full custom CRD operator). Don't implement runway-side. Pitch as a migration-friendly option.

### GAP-13 — Topology / dependency-graph awareness

- **Source:** Dynatrace Smartscape; Datadog Service Map; New Relic; Splunk.
- **What they do:** Render verdicts on a service-dependency graph; correlate cause-and-effect across services; "this service rolled back; here's the upstream cause and downstream blast radius."
- **Architectural placement:** L4 observability (overlay), not engine. Could be a new contract surface that consumes verdict streams + topology data and emits causal-RCA output.
- **Scope:** First 90 days (needs real topology data) OR Cede (Datadog/Dynatrace own this category).
- **Effort:** Large (topology engineering is its own product).
- **Pitch impact:** Honestly weak DS surface today; cede or partner is the right framing. "Topology RCA is Datadog/Dynatrace's lane; DS verdicts emit structured fields that any topology overlay can consume; integration story is 1-week follow-on to bridge Mosaic dependency graph data into the verdict UI."

**Recommendation:** Cede explicitly in pitch; offer integration-story rather than first-party feature. Frame as: "Verdicts are structured for topology overlays; we don't own the graph engineering."

### GAP-14 — Incident-chat ingestion as gate signal (extension of #6)

- **Source:** Harness 2026 "Human-Aware Change Agent" (Slack/Teams incident-chat ingestion).
- **What they do:** Subscribe to incident-channel chatter; surface as additional gate signal ("on-call is currently discussing a SEV-2 in #incident-foo; tighten gate sensitivity").
- **Architectural placement:** Extends Addition #6 (incident-state input to G1) with a chat-stream subchannel.
- **Scope:** First 90 days (needs Slack/Teams API integration at production scale).
- **Effort:** Medium (chat-API integration; LLM-based incident-relevance scoring).
- **Pitch impact:** "How does the gate know about ongoing incidents the official incident-management system hasn't formally raised yet?" — chat-ingestion is the answer Harness ships.

**Recommendation:** Extend Addition #6 spec with `IncidentSignalSource` enum: `{pagerduty, opsgenie, internal_incident_mgmt, slack_chat, teams_chat}`. Each source contributes to the consolidated `IncidentState`. Architect-doc-only this week; implementation in follow-on.

---

## Tier 3 — Follow-on Q2+ (larger architectural commitments)

### GAP-15 — Agentic rollback proposer

- **Source:** Dynatrace Davis AI agentic rollback (Preview).
- **What they do:** When the gate fires `rollback`, the agentic system proposes a remediation (specific commit to revert, specific config change to roll back, specific scaling decision to make).
- **Architectural placement:** Above the engine — a remediation-proposer layer that consumes audit records + change history + CI metadata and emits suggested actions.
- **Scope:** Follow-on Q2+ (needs real change history, real remediation patterns, real engineering judgment about what "fix" looks like for each incident class).
- **Effort:** Large (multi-month).
- **Pitch impact:** Forward-looking pitch beat for the long-term roadmap; not runway-scope.

**Recommendation:** Mention in pitch as "for follow-on roadmap"; don't commit. "Gate emits structured verdicts with provenance; a remediation-proposer layer is a natural extension once we have enough deploy-incident-history to learn remediation patterns."

### GAP-16 — Sensitivity dial / tuning preset abstractions

- **Source:** Harness (High/Medium/Low sensitivity dial).
- **What they do:** Abstract the per-detector α-budget, threshold tightness, and bake-time settings behind a single operator-friendly dial: "High sensitivity (catch more, more false alarms)" vs "Low sensitivity (catch less, fewer false alarms)."
- **Architectural placement:** Above the calibration compiler — an "operator profile" layer that translates sensitivity preset to specific α-budget allocations + bake-time overrides + threshold scalings.
- **Scope:** Follow-on Q1+Q2 (UX layer; operator-research-dependent).
- **Effort:** Medium.
- **Pitch impact:** Closes an operator-ergonomics gap. SRE leads frequently want "one knob"; α-budget allocation is correct architecturally but verbose operationally.

**Recommendation:** Specify as a follow-on UX layer: `SensitivityProfile` enum `{conservative, balanced, sensitive, very_sensitive}` maps to {α_total, per-family allocation overrides, bake_time multipliers}. Operator-friendly default; per-detector tuning available for advanced users.

### GAP-17 — "Plain Threshold Based Verification" no-stats mode

- **Source:** Harness (offers a no-ML threshold mode alongside the statistical mode).
- **What they do:** Some services don't have enough traffic / data to support statistical analysis. For those, fall back to plain operator-set thresholds.
- **Architectural placement:** L3 verdict fusion — a "stats-suppressed mode" where Family A/C/E suppress and Family B (structural signatures) plus operator thresholds are the only inputs.
- **Scope:** Follow-on Q1.
- **Effort:** Small (mostly already implementable via per-family suppression + cell_confidence='aggregate' fallback).
- **Pitch impact:** Closes the "what about low-traffic services where stats don't work" follow-up. Currently DS hand-waves "Family B works at any traffic level"; Harness explicitly ships a degraded mode.

**Recommendation:** Document the degradation behavior explicitly. The architecture already supports it (suppress Family A/C/D/E when sample requirements aren't met; Family B always runs). Pitch language: "DS degrades gracefully — when sample requirements aren't met, statistical families suppress and the structural-signature family + operator-set fail-fast thresholds run alone. Same architecture, narrower active surface."

### GAP-18 — Bundles-triggered calibration-compiler runs from CI

- **Source:** the target platform Asset Bundles + Deployment Jobs.
- **What they do:** GitOps for the Lakehouse; CI runs that build / deploy data jobs.
- **What DS needs:** Architectural integration — when a Bundles deploy ships, DS's calibration compiler can re-baseline against the new healthy traffic. Triggers via Bundles' webhook/event system.
- **Architectural placement:** O0 orchestration adapter (Bundles becomes another supported orchestrator) + calibration compiler trigger surface.
- **Scope:** First 90 days for follow-on.
- **Effort:** Medium.
- **Pitch impact:** Native-to-production integration; surfaces as "we plug into your existing Bundles CI cleanly."

**Recommendation:** Mention in pitch under production-specific-fit; specify in the platform-mapping doc as a follow-on integration. Currently the mapping doc covers Argo Rollouts as the orchestrator; Bundles is the data-plane sibling.

### GAP-19 — BubbleUp-style contribution analysis as post-verdict explanation UI

- **Source:** Honeycomb BubbleUp.
- **What they do:** Given an outlier subset (rollback verdict), rank which dimensions/values are over-represented to explain "what was different about the failing requests."
- **Architectural placement:** L4 observability extension — post-verdict explanation surface.
- **Scope:** Follow-on Q1.
- **Effort:** Medium.
- **Pitch impact:** Strong UX layer; closes a gap that BubbleUp users will notice.

**Recommendation:** Architect-spec a post-verdict explanation API: when a verdict fires, the gate emits the audit record + a query interface that downstream UI (BubbleUp-style or custom) can use to drill into "which signals contributed how much to the firing decision." Could be implemented as a thin overlay on the existing per-family `alpha_spent` and `cusum_progress` fields.

---

## Tier 4 — Explicit cede / partner

These are categories where competitors have material advantage and DS should not try to compete head-on.

### GAP-CEDE-01 — LLM-content safety guardrails

- **Source:** Arize / Fiddler / WhyLabs.
- **What they do:** Prompt-injection detection, hallucination scoring, toxicity filtering, bias/fairness monitoring of LLM outputs.
- **DS position:** Cede explicitly. DS addresses infrastructure-side AI signals (KV cache, MFU, HBM, eval_score, refusal_rate, tool_success_rate) — the operational substrate. LLM output-content quality is a different category with established players. Could be a future Family F if a the target customer demands it; not current scope.

### GAP-CEDE-02 — Pre-deploy evaluation batteries

- **Source:** W&B LLM Evaluation Jobs; HF eval ecosystem; Anthropic Bloom; OpenAI Evals.
- **What they do:** Run model benchmarks / eval suites pre-deployment.
- **DS position:** Pre-deploy evals are upstream of DS. Their results feed DS's gate as a Tier-1 SLI (eval_score is in DETECTOR_REGISTRY.A). Don't duplicate; integrate.

### GAP-CEDE-03 — Topology-driven causal RCA

- **Source:** Dynatrace Smartscape; Datadog Service Map.
- **What they do:** Render dependency graphs; correlate cause-and-effect across services.
- **DS position:** Cede explicitly. DS verdicts emit structured fields that any topology overlay can consume. Topology engineering is Datadog / Dynatrace's lane; partnering is the right move.

### GAP-CEDE-04 — Full CD pipeline UX

- **Source:** Harness, Spinnaker, Argo CD, Octopus, Flagger.
- **What they do:** Visual pipeline designers, RBAC, secret stores, deploy orchestration.
- **DS position:** Cede explicitly. DS is the analysis engine inside an existing rollout controller, not a new pipeline product. The O0 adapter pattern is the right move.

---

## Summary — recommended capability additions

### To land in runway (architect-doc-only, no engine changes)

1. **GAP-01 — SRM check** (Addition #10): L0 traffic-allocation-continuity check; G1 short-circuit on `srm`. ~30 min architect spec.
2. **GAP-02 — `suppressed_insufficient_samples` verdict + min-context guard**: extend `suppression_reason` enum; new top-level verdict variant. ~30 min architect spec.
3. **GAP-03 — Per-pod verdict breakdown**: extend Addition #2 cell-matrix dimensions. ~1 hour architect spec.
4. **GAP-04 — Fail-Fast / Ignore threshold contract surface**: G1 policy extension. ~30 min architect spec.
5. **GAP-05 — Lifecycle event hooks in O0**: extend ORCHESTRATION-ADAPTERS.md. ~1 hour architect spec.
6. **GAP-06 — Effect-size CI alongside p-value for Family A**: audit schema v2.1 minor extension. ~30 min architect spec.

Total runway architect work: ~4 hours, all docs-only. **Recommend landing as Architecture Additions #10 through #14 in the north-star doc** alongside a v2.1 schema-extension note for GAP-06.

### To commit to in pitch as first-90-days follow-on scope

1. **GAP-08 — Auto-generated verification profiles**: Addition #11 (zero-config day-one onboarding via the target platform observability scan).
2. **GAP-10 — Pre-deploy eval integration**: already specified; emphasize the integration story.
3. **GAP-11 — Change-card dashboard rendering**: for follow-on UI work.
4. **GAP-12 — Kayenta-compat API**: O0 Level 1.5 surface.
5. **GAP-14 — Incident-chat ingestion**: extends Addition #6.
6. **GAP-17 — Plain-threshold no-stats mode**: document graceful degradation explicitly.
7. **GAP-18 — the target platform Bundles integration**: O0 sibling adapter.

### Q2+ follow-on commitments

1. **GAP-09 — Log-stream novelty Family F**: shadow-mode-and-after work.
2. **GAP-15 — Agentic rollback proposer**: long-term roadmap.
3. **GAP-16 — Sensitivity dial UX**: operator-research-dependent.
4. **GAP-19 — BubbleUp-style contribution analysis API**: post-verdict explanation layer.

### Cede explicitly in pitch

1. LLM-content guardrails (Arize/Fiddler/WhyLabs lane).
2. Pre-deploy evaluation batteries (W&B/HF/Bloom upstream).
3. Topology-driven RCA (Dynatrace/Datadog lane).
4. Full CD pipeline UX (Harness/Spinnaker/Octopus lane).

---

## Pitch-framing implications

Adding the project-tier additions (#10–#14) means the pitch's "what shipped" surface grows by 5 architectural specs and the honest-gap section shrinks. The competitive comparison table in COMPETITIVE-LANDSCAPE.md should also update — at minimum the "DS=YES" row for SRM, insufficient-samples handling, per-pod breakdown, fail-fast policy, and lifecycle events.

The cede-list deserves an explicit "what we're not pitching" paragraph in the pitch draft Part 5 (honest gaps). Currently Part 5 covers structural detector-coverage gaps and synthetic-data caveats; adding "we're explicitly not in the LLM-content-safety / topology-RCA / CD-pipeline-UX lanes" reinforces calibrated-confidence framing and pre-empts "why don't you do X" questions for X that aren't DS's lane.

The biggest architectural addition — GAP-08 auto-generated verification profiles — deserves a callout in Part 7 (first 90 days) since it's the answer to "how long does service onboarding take" which is a major adoption-friction question.

---

## Open questions (architect-side, not yet resolved)

1. **Per-pod verdict aggregation semantics.** When per-pod verdicts disagree (3 of 5 pods say rollback, 2 say proceed), how does the cohort-level verdict resolve? Majority? Any-fires? Minimum-pods-must-agree-to-promote? Policy decision; needs spec.
2. **SRM threshold sensitivity.** What's the right deviation threshold for SRM detection? LD doesn't publish theirs. Probably needs empirical calibration on real data; spec a starting value (e.g., 2σ over a 5-minute rolling window) and flag for follow-on tuning.
3. **Fail-fast vs detector-portfolio interaction.** If fail-fast trips, does the gate also emit per-family verdict records, or short-circuit entirely? Currently I'd say short-circuit (G1 wins, family verdicts suppressed for the run). Spec choice.
4. **Lifecycle event schema.** What's the canonical shape of `evaluation.tick`, `evaluation.suppressed`, etc.? Probably mirrors v2 audit record subset; spec via the same provenance contract.
5. **Insufficient-samples default policy.** When `suppressed_insufficient_samples` fires, default action is configurable (proceed-conservative or rollback-conservative). Which is the safer default? My instinct: rollback-conservative for high-risk-tier deploys, proceed-conservative for low-risk. Per-risk-tier policy.

These five are architect-scope and would land alongside the project additions if/when I write Addition #10–#14 sections in the north-star doc.

— Architect

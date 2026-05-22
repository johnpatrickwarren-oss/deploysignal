# PRD-30: Cairn — structured RCA / postmortem attribution

_Owner: Product Manager (John, with assistance)._
_Drafted: 2026-05-21. Last updated: 2026-05-21._
_Status: draft._

_Framework: Anchor methodology (PRD template; PM role)._

---

## Goal

When a regression escapes deploy-gate and steady-state observation and lands in prod, the postmortem RCA is the load-bearing artifact that determines whether the next deploy avoids the same failure mode. Today that RCA is **manual and unstructured** — an SRE reads dashboards, scrolls audit logs, eyeballs deploy timelines, and writes a narrative that's only as rigorous as the author's pattern-matching that week. Dynatrace Smartscape does topology RCA; Datadog Service Map does dependency tracing; nobody does **statistically-rigorous attribution** that combines deploy verdicts + cluster observations + incident timelines + (optional) chaos-experiment results into a probabilistic root-cause distribution.

**Cairn** is the postmortem attribution layer of the DS bundle. It consumes audit streams from DeploySignal (deploy verdicts + α-budget consumption + per-cell baseline references), Tessera (per-shard observations + freeze-hook activations + cluster events), the customer's incident-management system (incident onset time + affected services), and optionally chaos-platform output (Anvil experiment runs). Runs the same Family A/C/D/E engine on the **attribution surface** — given an observed regression at time T, which deploy / shard / dependency / chaos event is statistically most consistent with the regression's onset pattern? Produces a **ranked attribution report** with cited evidence.

The pitch frame: "DeploySignal catches before promotion. Tessera observes during steady state. Cairn does the postmortem when something escapes both — statistically, not by eyeballing dashboards." Strong Verica/Casey adjacency: chaos engineering's whole point is "find weaknesses before they cause incidents"; Cairn is the complement: "when an incident does happen, attribute it to specific weaknesses rigorously."

Success from the buyer's frame: an oncall SRE finishes the incident, drops in Cairn the incident's onset time + affected services, and within seconds gets a ranked list of cause-candidates (deploys, chaos experiments, dependency changes, configuration changes, environmental events) with posterior probabilities + the audit-trail citations that back each rank. The postmortem write-up's "what happened" section is no longer an exercise in narrative pattern-matching; it's a verifiable statistical claim.

---

## Target user / personas

- **P1 — SRE running postmortems.** The person assigned to author the postmortem doc within 24–72h of an incident. Today: hunts through Slack, dashboards, deploy timelines, AAR notes. Cares about getting to the cause faster, defensibly, and not missing co-occurring factors.
- **P2 — Incident commander.** Mid-incident, after stabilization. Wants the most-likely cause ranked NOW so the next mitigation is targeted, not exploratory. Today: shouts "did anyone deploy in the last hour?" into the bridge.
- **P3 — Chaos-engineering practitioner at a Verica/Casey-adjacent buyer.** Already running chaos game-days; wants to validate that the system's actual incident-attribution matches the failure modes the chaos program is exercising. Today: cross-references manually.
- **P4 — Existing DS + Tessera user closing the lifecycle loop.** Already gating with DS, observing with Tessera; wants the same audit substrate for postmortems without onboarding a third product.

---

## User stories

- **US-1:** As a postmortem SRE (P1), I want to input an incident's onset time and affected signals, so I get a ranked list of candidate causes with posterior probabilities — not a narrative I have to construct by hand.
- **US-2:** As an incident commander (P2), I want to see the top-ranked cause within seconds of running Cairn during the incident, so my next mitigation step is targeted rather than exploratory.
- **US-3:** As a chaos practitioner (P3), I want each candidate cause-event in the ranked report to carry its provenance citation (DS audit record ID, Tessera VerdictGroup ID, Anvil experiment ref), so the postmortem traces back to verifiable evidence.
- **US-4:** As any persona (P1/P2/P3/P4), I want Cairn to suppress causes whose timing is mechanistically inconsistent with the incident (e.g., a deploy that happened 6 hours after the incident's onset can't have caused it), so the rank reflects only plausible candidates.
- **US-5:** As an existing DS + Tessera user (P4), I want Cairn to consume the audit streams I'm already emitting, so adding RCA to the stack costs no new instrumentation.

---

## Functional requirements

- **FR-1 — Incident definition surface.** Cairn accepts an `IncidentDefinition` with at minimum `{ onset_time_unix, affected_signals, regression_magnitude_unit, optional regression_magnitude }`. Traces to US-1.
- **FR-2 — Candidate enumeration from audit streams.** Cairn ingests candidate cause-events from at least four source types: DS audit records (`AuditRecord` / `AuditRecordV2` JSONL), Tessera VerdictGroup feed payloads, Anvil chaos-experiment definitions, and a generic external-event JSON shape (for incident-mgmt webhook payloads, env-change feeds, etc.). Each candidate carries `{ cause_id, cause_kind, timestamp_unix, evidence_ref, optional metadata }`. Traces to US-3, US-5.
- **FR-3 — Per-cause alignment scoring.** Cairn scores each candidate against the incident's onset by combining: (a) timestamp alignment (kernel decay from `cause.timestamp_unix` to `incident.onset_time_unix`); (b) per-cause-kind prior (deploys: ~30min blast-radius window; dependency changes: ~hours; chaos experiments: ~minutes; env changes: ~hours-to-days); (c) evidence-quality boost (a cause backed by a DS `extend`-verdict gets a higher score than a cause known only by timestamp). Output is a normalized posterior over candidates. Traces to US-1, US-4.
- **FR-4 — Ranked attribution report.** Cairn produces an output document containing: ranked candidate list (highest posterior first), per-candidate posterior probability + cited evidence reference + alignment-score breakdown (kernel score, kind prior, evidence boost), and an explicit "candidates suppressed for mechanistic inconsistency" section. Traces to US-1, US-2, US-3.
- **FR-5 — CLI driver.** `tools/cairn.js` reads an incident-definition JSON + a candidates-source JSON (or directory) and prints the ranked attribution report. Replay-clean: same inputs → byte-identical output. Traces to US-2.
- **FR-6 — Per-cause-kind decay configurability.** Operators set the per-kind kernel bandwidth in a config object (defaults are reasonable; the operator's stack-specific knowledge — "our deploys take 45min to manifest" — encodes here). Traces to US-4.

---

## Non-functional requirements

- **NFR-1 (performance).** Attribution scoring is O(N) in candidate count. A typical postmortem will have ≤ 100 candidates (24h pre-incident window with all four source types). Scoring + report rendering must complete in < 1 second on a developer laptop.
- **NFR-2 (engine reuse).** Cairn reuses the existing Family A/C/D/E engine where possible. Specifically: when an engine-inferred onset distribution exists (BOCPD run-length posterior on a relevant signal, Page-CUSUM fire-tick with confidence band), Cairn consumes it instead of the operator-supplied onset point estimate. No new detector family; preserves Q2.B.6.4 ADR clauses.
- **NFR-3 (replay-clean).** Same incident definition + same candidate set + same config → byte-identical ranked report. This makes Cairn audit-substrate-compatible with the rest of DS: a postmortem can be reproduced months later from the same inputs.
- **NFR-4 (audit-stream compatibility).** Cairn consumes the existing DS audit JSONL (no new schema) and the Tessera `VerdictGroupPayload` wire format (no Tessera-side changes). Traces to US-5.
- **NFR-5 (no live customer telemetry at v1).** Anti-scope alignment with `coordination/ANTI-SCOPE-LEDGER.md` enterprise-infrastructure boundary. v1 ships against synthetic fixtures + audit JSONL produced by existing DS demos.

---

## Acceptance criteria

- [ ] **AC-1:** `engine/cairn/types.ts` exports `IncidentDefinition`, `AttributionCandidate`, `CandidateKind`, `AttributionEvidence`, `RankedAttribution`, `CairnScoringConfig`. (FR-1, FR-2, FR-3)
- [ ] **AC-2:** `engine/cairn/score.ts` exports `scoreCandidate(candidate, incident, config) → number` (returns alignment score; not normalized) and `rankCandidates(candidates, incident, config) → RankedAttribution` (returns ranked + posterior-normalized output). (FR-3, FR-4)
- [ ] **AC-3:** `engine/cairn/ingest.ts` exports `candidatesFromDsAudit(records: AuditRecord[]) → AttributionCandidate[]`, `candidatesFromTesseraFeed(payloads) → AttributionCandidate[]`, `candidatesFromAnvilExperiments(patterns) → AttributionCandidate[]`, `candidatesFromExternalEvents(events) → AttributionCandidate[]`. (FR-2)
- [ ] **AC-4:** Mechanistic-inconsistency suppression: candidates with `timestamp_unix > incident.onset_time_unix + small_grace` are suppressed with `suppression_reason: 'post_incident_timestamp'` and excluded from the normalized posterior. (FR-3, US-4)
- [ ] **AC-5:** Per-kind kernel + prior defaults: deploys (Gaussian kernel σ=30 min), chaos experiments (Gaussian kernel σ=5 min), dependency changes (Gaussian kernel σ=2 hr), env changes (Gaussian kernel σ=6 hr), shard events (Gaussian kernel σ=15 min), generic external events (Gaussian kernel σ=1 hr). Configurable per-call. (FR-6)
- [ ] **AC-6:** `tools/cairn.js` CLI runs end-to-end on a synthetic fixture and prints a ranked report. Re-running produces byte-identical output (replay-clean). (FR-5, NFR-3)
- [ ] **AC-7:** ≥ 15 tests under `test/q30-cairn-*.test.ts`: type contracts, scoring function unit cases, ingest helpers, end-to-end CLI scenarios, replay determinism. (FR-1–FR-6)
- [ ] **AC-8:** `demos/CAIRN-DEMO.md` + `demos/cairn-attribution-walkthrough.json` — synthetic scenario with three candidate causes (a deploy, an Anvil chaos experiment, an env change); Cairn ranks the deploy first, the env change last, chaos experiment middle (the canonical "deploy did it" story). (FR-4)
- [ ] **AC-9:** `NORTH-STAR-ARCHITECTURE.md` gains Addition #30 with the lifecycle-loop framing (DS catches / Tessera observes / Cairn attributes); `COMPETITIVE-GAPS-ADDITIONS.md` gains GAP-30; `README.md` gains a Cairn section; `ANTI-SCOPE-LEDGER.md` gains a Q30 entry. (positioning)
- [ ] **AC-10:** Full test suite passes (≥ 977 + 15 new = 992 cases, 0 fail); type-check clean. (NFR-3, regression invariant)

---

## Out-of-scope

- **AS-1: Live ingestion adapters for incident-management platforms** (PagerDuty / Opsgenie / incident.io / Statuspage webhook consumers). Reason: pairs better with the first buyer conversation. v1 ships the `candidatesFromExternalEvents` ingest helper that accepts a generic event JSON; production adapters are Slice 2.
- **AS-2: A new detector family for attribution.** Reason: Q2.B.6.4 ADR (no new `engine/detectors/*` code beyond Phase D batch). Cairn is a scoring layer on top of the existing engine, not a new detector.
- **AS-3: Causal inference (counterfactual / do-calculus).** Reason: Cairn does **alignment-based attribution**, not formal causal inference. Pearl-style counterfactuals require a known causal graph; Cairn ranks correlation-of-timing under a known set of candidates. Mislabeling Cairn's output as "causal" would be honesty-breach in the pitch; framing stays "ranked attribution of timing-consistent candidates."
- **AS-4: Multi-incident batch RCA / "find systemic patterns across the last 30 incidents".** Reason: separate PRD. Cairn v1 is one-incident-at-a-time.
- **AS-5: Auto-generation of postmortem narrative prose.** Reason: that's the LLM-advisor scope (Addition #27 advisory layer); Cairn outputs structured ranked data, not narrative.
- **AS-6: A web UI dashboard for Cairn.** Reason: CLI + JSON output is the v1 surface. UI is downstream of first buyer adoption.
- **AS-7: Real-time attribution streaming.** Reason: postmortems are batch-mode. Streaming attribution during the incident itself (a live "most-likely-cause" indicator) is a candidate Slice 2 if incident-commander persona pulls hard.

**Cross-references to ANTI-SCOPE-LEDGER preserved:**

- **Q2.B.6.4 ADR clauses 1–5** preserved (Cairn touches no `engine/detectors/*` runtime code).
- **Q60 V2 clause 3 (NO live customer telemetry)** preserved (AS-1 above + NFR-5).
- **Enterprise-infrastructure boundary** preserved.
- **No-skip policy** preserved (Cairn tests assert, no skips).

---

## Priority

- **Must-have:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-9, AC-10. The core attribution algorithm + CLI + tests + positioning docs.
- **Should-have:** AC-8 (demo). Strong pitch evidence but not engine-correctness load-bearing.
- **Could-have:** Engine-inferred-onset consumption (when a BOCPD posterior or Page-CUSUM fire-tick is available in the DS audit record, prefer it over the operator-supplied onset point). Tracked as OQ-30.1.
- **Won't-have (this cycle):** Incident-mgmt webhook adapters; causal-inference framing; multi-incident batch RCA; narrative auto-gen; web UI; streaming.

---

## Success metrics

- **SM-1 (buyer):** At least one Verica/Casey-style buyer conversation references Cairn by name within 90 days of merge, traceable to the README + Addition #30 spec.
- **SM-2 (DS+Tessera user adoption):** At least one existing DS or Tessera user (internal or external) runs `tools/cairn.js` against a real incident audit JSONL within 60 days of merge; the ranked report's top candidate matches the postmortem author's independent best-guess in ≥ 75% of trials (calibration target).
- **SM-3 (regression invariant):** Pre-Cairn full-suite test count + 15 new Q30 tests = post-Cairn count; zero pre-Cairn tests changed status (still 977 pre-existing + 15 new = 992 passing, 0 fail). Anchor methodology byte-identical-preservation discipline.

---

## Dependencies

- **Upstream:** Addition #9 (`OrchestrationAdapter` + `DeployContext` shape — informational; Cairn consumes adjacent `AuditRecord` not the adapter directly). Addition #25 (`VerdictGroup` — Cairn consumes the close-event shape for grouping per-incident candidates). Addition #29 (Anvil — Cairn consumes `ExpectedFailurePattern` records as chaos-experiment candidates).
- **Downstream:** Slice 2 incident-mgmt webhook adapters (future PRD); Slice 2 streaming attribution surface; future LLM-advisor narrative synthesis (composes on Cairn's structured output).
- **Sibling product (cross-repo bundle):** [Tessera](https://github.com/johnpatrickwarren-oss/tessera). Cairn consumes the `VerdictGroupPayload` wire format Tessera emits via `engine/ds-integration/feed-contract.ts`. No Tessera-side change required at Cairn v1 — existing contract is sufficient.

---

## Open questions

- **OQ-30.1:** When an `AuditRecord` for the incident's affected signal carries an engine-inferred onset estimate (BOCPD run-length posterior or Page-CUSUM fire-tick + confidence band), should Cairn consume it as the onset distribution instead of the operator-supplied point estimate? PM lean: yes for v1, falls back to operator-supplied point if engine estimate absent. Architect resolves at Q30 spec-emit.
- **OQ-30.2:** Per-cause-kind kernel bandwidth defaults (deploys: σ=30min, chaos: σ=5min, dependency: σ=2hr, env: σ=6hr, shard: σ=15min, generic: σ=1hr) — should these be operator-tunable per-call only, or also per-profile (analogous to Addition #28 reference profiles)? PM lean: per-call config object at v1; profile-level defaults are Slice 2. Architect confirms at Q30.
- **OQ-30.3:** Should Cairn support **negative-evidence boost** (a cause that DS evaluated and emitted `proceed` should have a lower attribution score than a cause that DS never saw — because DS's clean verdict is positive evidence the cause isn't load-bearing)? PM lean: yes for v1 — operationally important because the "we deployed but it didn't cause this" case is the most common false-attribute. Architect picks at Q30.

---

## Update history

- **2026-05-21:** Initial draft. PM artifact for Cairn capability — structured-RCA / postmortem attribution that closes the lifecycle loop: DS catches at gate-time, Tessera observes during steady state, Cairn attributes when something escapes both. Targets SRE postmortem leads + incident commanders + Verica/Casey-adjacent chaos-engineering buyers. Framework: Anchor.

---

## Notes for the PM

- Every AC traces to one or more FRs (AC-1→FR-1/2/3, AC-2→FR-3/4, AC-3→FR-2, AC-4→FR-3, AC-5→FR-6, AC-6→FR-5, AC-7→all, AC-8→FR-4, AC-9→positioning, AC-10→NFR-3). No untraceable ACs.
- Every FR traces to ≥ 1 US (FR-1→US-1, FR-2→US-3/US-5, FR-3→US-1/US-4, FR-4→US-1/US-2/US-3, FR-5→US-2, FR-6→US-4).
- The honesty discipline (AS-3) is load-bearing for the pitch: Cairn does **alignment-based ranked attribution**, not causal inference. Calling it "causal" would invite Pearl-style scrutiny that the v1 algorithm can't survive; "ranked attribution of timing-consistent candidates" is defensible end-to-end.
- The lifecycle-loop framing (DS catches / Tessera observes / Cairn attributes) is the load-bearing pitch beat. The buyer's frame: three products, one engine, one audit substrate, one methodology — three lifecycle stages of incident management.

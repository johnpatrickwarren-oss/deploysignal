# DORMANCY.md v1

Per-addition activation status for modules that ship as code (types, schemas, helpers) but are NOT wired into the runtime execution path. Dormant modules do not affect production verdicts — their activation requires explicit operator + orchestrator changes documented per entry.

Schema (additive; follow-on evolutions extend without breaking):

- `status` — `'dormant' | 'active'`
- `activation_mechanism` — string; how to un-dormant (what operator / code change flips the status)
- `last_reviewed_ts` — ISO date of the most recent audit of this entry
- `activation_disposition` — `'deferred' | 'current-cycle' | 'conditional'` + clarifying note

Per ARCHITECT-REPLY-53 §R1 (D1a/D1b/D1c) — an internal decision record not included in this public repo; its substance: dormancy status must be tracked per-addition in this file, with a machine-enforceable import ban while dormant. Forbid-import enforcement lives in `test/dormancy-forbid-import.test.ts` — CI fails if `engine/**/*.ts` imports from `advisory/agent/` while this file marks #27 as dormant. (References below to "REPLY-52" cite the internal real-data-validation decision cycle — the run that produced the v8 real-trace substrates recorded in `CHEAT-SHEET.md`; "the consolidated activation slice" is the post-REPLY-52 orchestrator change that wired #25/#26/#27 into the runtime path.)

---

## Addition #25 — VerdictGrouper (L3b verdict grouping)

- status: active
- activation_mechanism: wired in consolidated activation slice (post-REPLY-52 orchestrator surgery)
- last_reviewed_ts: 2026-04-22
- activation_disposition: current-cycle; awaiting the consolidated activation slice once REPLY-52 real-data validation lands enough confidence in upstream verdicts to warrant grouping them.

## Addition #26 — TopologyEnricher (VerdictGroup topology overlay)

- status: active
- activation_mechanism: wired in consolidated activation slice (post-REPLY-52 orchestrator surgery)
- last_reviewed_ts: 2026-04-22
- activation_disposition: current-cycle; stacked behind #25 (TopologyEnricher consumes closed VerdictGroups — no group without #25 active).

## Addition #27 — agent (advisory proposer, `advisory/agent/`)

- status: active
- activation_mechanism: wired in consolidated activation slice (post-REPLY-52 orchestrator surgery)
- last_reviewed_ts: 2026-04-22
- activation_disposition: current-cycle; relocated to `advisory/agent/` per ARCHITECT-REPLY-53 R4 (D4b) — the directory-name signals the post-decision advisory positioning but does not change activation state.

## Addition #28 — profile library (reference workload profiles)

- status: active
- activation_mechanism: post-REPLY-51b v2 dynamic routing landed; compiler consumes `profile_ref` + `customer_override_ref` and emits profile-driven `joint_vector.signals` inventory, family-enable gates, policy_defaults, and audit threading.
- last_reviewed_ts: 2026-04-22
- activation_disposition: current-cycle; the only active entry in this file — serves as the reference pattern for post-activation state (`status: active` + concrete landed-change summary under `activation_mechanism`).

## Plan B — randomized twin (engine ADR 0036, `twin_arm`, gate-http `mode: "twin"`)

- status: dormant
- activation_mechanism: a separate authority ADR after a registered real-service A/A run (engine plan D) shows no arm-level effect at the declared split; that ADR flips `TWIN_ARM_AUTHORITY` in `engine/guarantees.ts` from `'advisory'` and, with it, the twin record's `mode: 'shadow'` in `service/gate-http/_gate-twin.ts` and the `dryRun` entry and conditions in `service/gate-http/argo/twin-analysis-template.yaml`. `test/twin-dormancy.test.ts` fails if the constant leaves `'advisory'` while this entry still says `dormant`, and `test/twin-authority.test.ts` states what advisory means on each surface.
- last_reviewed_ts: 2026-10-02
- activation_disposition: conditional; what is dormant is the twin verdict's AUTHORITY, not its code. The path runs whenever a compiled config declares `twin_arm` (`engine/gates/_health-twin.ts`, which then replaces every other health check) or a session is begun with `mode: "twin"`, and it reports on `HealthResult.twin_arm`, the tick response and `GET /v1/verdict`'s `twin` block. Nothing it produces reaches `rollback[]`, `firing_families`, `alpha_spent`, a `rolled_back` phase or a failing Argo analysis. Engine study 2026-09-twin-null (run-20260926T053339Z) met its ship rule on synthetic arms; the premise (no arm-level effect on any tick under randomized routing) is untested on a real service.
- local_aa_t2: study 2026-09-twin-aa-local (tier T2, two local processes, not T3), studies/twin-aa-local/results/run-20260927T050717Z/REPORT.md: 0/100 false rollbacks at w 0.5 and w 0.1, power 40/40 per fault; ship rule NOT MET on E6 (178 upstream errors in 2 ticks, attributed post-hoc to host sleep); authority unchanged.
- local_aa_t2_run2: same study, Amendment 1 (host held awake, void rule for host suspension), studies/twin-aa-local/results/run-20260927T172045Z/REPORT.md: executable (no Sleep/DarkWake in the power log, longest tick 277.9 ms); 0/100 false rollbacks at w 0.5 and w 0.1, power 40/40 per fault, 0 upstream errors; ship rule MET at T2 only; authority unchanged, T3 still required.
- real_aa_t3: study 2026-10-twin-aa-real, AA cell, 2026-09-29, studies/twin-aa-real/REPORT.md: **E1 FAIL** (12 of 44 executable runs rolled back, 0.2727, stopped by the registered 11-rollback rule), E2 FAIL, E3 PASS. Every rollback is `twin_sign_p99_latency`: fresh Fargate task pairs carry a persistent p99 offset of 0.01–2 ms at a 1 ms p99, and the sign kind scores any persistent direction as worse (engine `detectors/twin-contrast.ts:154-155`, no magnitude). `twin_rate_http_5xx` fired in no run; the sample-ratio guard never fired. Per PREREGISTRATION.md §9 no authority ADR may cite this study. What activation now needs, beyond the list above: a magnitude (minimum effect of interest) in the sign kind or latency expressed as a rate, then a re-registered T3 A/A on a service with a p99 well above placement noise and more than two tasks per arm; the `rate` kind remains the authority candidate, with its real-service power measured at one point (AB-5xx, 2026-09-30: E4 PASS 20/20 on a ×2 fault, the rate detector first in 16 at ticks 25–26).
- real_aa_t3_2: study 2026-10-twin-aa-real-2, AA cell, 2026-09-30 to 2026-10-02, studies/twin-aa-real-2/REPORT.md: **E1 PASS** (0 of 100 executable runs rolled back, one-sided 95% upper bound 0.030), E2 PASS, E3 PASS, 0 void, on the re-registered configuration: the p99 `sign` metric with `margin: { relative: 0.10 }` (engine ADR 0037, v0.13.0-pre), a service p99 of about 76 ms, four tasks per arm. Citable under its ship rule as "no gross false-rollback excess ... sign kind with a 10% margin and rate kind ... 60-tick bake, tier T3"; necessary and not sufficient for the authority ADR. Post-hoc: replayed without the margin the same 100 runs give 1 rollback, so the latency scale and task count, not the margin, account for most of the change from the first study (12 of 44). Still open for the ADR: power with the margin (study 2026-10-twin-fault-shapes, registered), the proceed side, generality beyond one synthetic service, the Argo and CodeDeploy paths, and the temporal path's own rollback authority (knowledge WORKLIST C87).

## Temporal path rollback authority — Families A, C, D (`TEMPORAL_PATH_AUTHORITY`, C87, 2026-10-02)

- status: dormant
- activation_mechanism: per family, a registered study on real telemetry that shows the family's false-rollback rate within its declared bound under a declared null; then `TEMPORAL_PATH_AUTHORITY` (defined in `engine/_guarantees-temporal.ts`, re-exported by `engine/guarantees.ts`) becomes per-family and that family's fires return to `rollback[]` and `firing_families`. No operator setting and no profile field activates it. `test/c87-temporal-path-advisory.test.ts` fails if the constant leaves `'advisory'` while this entry still says `dormant`, and states what advisory means on each surface.
- last_reviewed_ts: 2026-10-02
- activation_disposition: conditional; what is dormant is the ROLLBACK AUTHORITY of every detector that tests the canary against a baseline fitted from history: Family A (mixture supermartingale, betting e-process, and the terminal safe-t path of C64 a), Family C (Hotelling T² in both variants, e-MMD, the betting e-process) and Family D (spectral, both variants). The detectors still run and report. A fire is recorded on the health result (`family_A_shadow`, `family_C_verdict`, `family_C_mmd_verdict`, `family_D_shadow`) with `advisory_reason: advisory_temporal_path_no_valid_null` and `advisory_id` (the rollback id it would have carried), in `evidence_outlook` and the rationale's advisory clause, on the fused verdict's `advisory_families`, and in the audit record's `families.{A,C,D}.advisory_fires`. It books `alpha_spent: 0` and never reaches `rollback[]` or `firing_families`, so neither the cascade verdict (`engine/core.ts` `computeVerdict`) nor the portfolio verdict (`engine/verdict.ts` `fuseVerdict`) nor the gate service rolls back on it. A rollback comes from the policy gates (`POLICY_GATE_IDS`), the policy, approval, state, sample-ratio and fail-fast short-circuits, and Family B where it keeps a rollback effect (no compiled config, or a compiled config with no statistical family: `FAMILY_B_AUTHORITY`). An `indeterminate` temporal verdict still extends the canary. The twin path (Plan B above) is separate and unchanged.
- evidence: real telemetry, engine v0.12.2-pre, Ville thresholds 1/α, bar 0.05. studies/gwdg-gate/REPORT.md, E1 FAIL: a Family-A-only gate rolled back 40 of 44 healthy two-day GPU units (0.909); with Family C beside it 42 of 44 (0.955). studies/burstgpt-gate/REPORT.md, E1 FAIL: the Family A gate on `cost_req` rolled back 13 of 87 healthy 100-tick windows (0.149). Not measured on real telemetry: Family C alone, Family D, the safe-t path. They are advisory for want of a measurement, not on a failed one.
- consequence_on_the_corpus: on the 131-scenario adversarial corpus under the v4 config, 131 are detected (a rollback or an advisory A/C/D fire) and 36 roll back (35 policy short-circuits, 1 provenance gate); the other 95 are reported and proceed (`test/w4-full-sweep.test.ts`). Detection in the corpus tests means "rollback OR an advisory A/C/D fire" (`test/_c87-detection.ts`).

## Family A rollback authority on custom signals (`FAMILY_A_ROLLBACK_AUTHORITY`, 2026-09-27)

- status: dormant
- activation_mechanism: SUBORDINATE to the temporal-path entry above since C87 (2026-10-02): while `TEMPORAL_PATH_AUTHORITY` is `'advisory'` no Family A fire rolls back, authorized or not, and nothing in this entry activates a rollback. What this rule still decides is the kind of advisory fire: an authorized signal's fire carries `advisory_reason: advisory_temporal_path_no_valid_null` and counts as a detection; an unauthorized signal's keeps reason_code `advisory_signal_not_rollback_authorized`. If the temporal path regains authority for Family A, then, as before, per signal, by the operator: a profile's `family_a_rollback_signals` lists an sli_list signal outside the six defaults, accepting the plug-in envelope (`validUnderEstimatedBaseline: false`, engine detectors/validity-envelope.ts at v0.12.1-pre). Globally: an engine envelope that admits the mixture and betting plug-ins under an estimated baseline, after which `FAMILY_A_ROLLBACK_AUTHORITY` in `engine/guarantees.ts` may move to `'any_configured_signal'`.
- last_reviewed_ts: 2026-10-02
- activation_disposition: conditional; what is dormant is the AUTHORITY of a Family A plug-in fire on a signal that is not one of the engine's six defaults, not routed through the valid path (`OrchestrateParams.validPath`) and not listed by the operator. The six defaults held authority by grandfathering, not on validity grounds: they carry the same plug-in envelope (and since C87 they hold none). The detectors still run on it (engine v0.12.1-pre evaluates every sli_list signal). The fire is recorded on `family_A_shadow` with reason_code `advisory_signal_not_rollback_authorized` and `alpha_spent: 0`, in `evidence_outlook`, and in the audit record's `families.A.advisory_fires`; it never reaches `rollback[]` or `firing_families`. Its α is dropped, not reallocated; the Bonferroni split still counts the signal, which is conservative for the authorized ones. The decision is `engine/gates/_health-detectors.ts` `pluginAdvisoryReason` over `familyARollbackAuthorized`. Shipped profiles monitor only default signals and are unaffected. `test/family-a-rollback-authority.test.ts`.

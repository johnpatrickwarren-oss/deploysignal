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
- last_reviewed_ts: 2026-09-26
- activation_disposition: conditional; what is dormant is the twin verdict's AUTHORITY, not its code. The path runs whenever a compiled config declares `twin_arm` (`engine/gates/_health-twin.ts`, which then replaces every other health check) or a session is begun with `mode: "twin"`, and it reports on `HealthResult.twin_arm`, the tick response and `GET /v1/verdict`'s `twin` block. Nothing it produces reaches `rollback[]`, `firing_families`, `alpha_spent`, a `rolled_back` phase or a failing Argo analysis. Engine study 2026-09-twin-null (run-20260926T053339Z) met its ship rule on synthetic arms; the premise (no arm-level effect on any tick under randomized routing) is untested on a real service.
- local_aa_t2: study 2026-09-twin-aa-local (tier T2, two local processes, not T3), studies/twin-aa-local/results/run-20260927T050717Z/REPORT.md: 0/100 false rollbacks at w 0.5 and w 0.1, power 40/40 per fault; ship rule NOT MET on E6 (178 upstream errors in 2 ticks, attributed post-hoc to host sleep); authority unchanged.
- local_aa_t2_run2: same study, Amendment 1 (host held awake, void rule for host suspension), studies/twin-aa-local/results/run-20260927T172045Z/REPORT.md: executable (no Sleep/DarkWake in the power log, longest tick 277.9 ms); 0/100 false rollbacks at w 0.5 and w 0.1, power 40/40 per fault, 0 upstream errors; ship rule MET at T2 only; authority unchanged, T3 still required.

## Family A rollback authority on custom signals (`FAMILY_A_ROLLBACK_AUTHORITY`, 2026-09-27)

- status: dormant
- activation_mechanism: per signal, by the operator: a profile's `family_a_rollback_signals` lists an sli_list signal outside the six defaults, accepting the plug-in envelope (`validUnderEstimatedBaseline: false`, engine detectors/validity-envelope.ts at v0.12.1-pre). Globally: an engine envelope that admits the mixture and betting plug-ins under an estimated baseline, after which `FAMILY_A_ROLLBACK_AUTHORITY` in `engine/guarantees.ts` may move to `'any_configured_signal'`.
- last_reviewed_ts: 2026-09-27
- activation_disposition: conditional; what is dormant is the AUTHORITY of a Family A plug-in fire on a signal that is not one of the engine's six defaults, not routed through the valid path (`OrchestrateParams.validPath`) and not listed by the operator. The six defaults hold authority by grandfathering, not on validity grounds: they carry the same plug-in envelope. The detectors still run on it (engine v0.12.1-pre evaluates every sli_list signal). The fire is recorded on `family_A_shadow` with reason_code `advisory_signal_not_rollback_authorized` and `alpha_spent: 0`, in `evidence_outlook`, and in the audit record's `families.A.advisory_fires`; it never reaches `rollback[]` or `firing_families`. Its α is dropped, not reallocated; the Bonferroni split still counts the signal, which is conservative for the authorized ones. The decision is `engine/gates/_health-detectors.ts` `pluginAdvisoryReason` over `familyARollbackAuthorized`. Shipped profiles monitor only default signals and are unaffected. `test/family-a-rollback-authority.test.ts`.

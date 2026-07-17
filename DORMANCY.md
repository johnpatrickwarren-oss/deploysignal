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

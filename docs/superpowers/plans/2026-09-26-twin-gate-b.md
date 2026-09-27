# Plan B — the randomized twin in DeploySignal (advisory)

- **Date:** 2026-09-26
- **Engine:** `@johnpatrickwarren-oss/deploysignal-engine` v0.12.0-pre (tag on `10c9691`, ADR 0036).
- **Authority:** `TWIN_ARM_AUTHORITY = 'advisory'`. No twin verdict becomes an automatic rollback or a
  failed rollout. Flipping it is a separate ADR after a real-service A/A (Plan D), not this work.
- **Branch:** `wt/twin-gate-b` (worktree `~/concord/.worktrees/deploysignal/twin-gate-b`). PR against
  `main`, not merged.

Every task is test-first: the failing test is written and run red before the code.

## Task 1 — re-pin the engine

- `package.json`: `#v0.11.0-pre` → `#v0.12.0-pre`; `npm install` updates `package-lock.json`.
- The contrast arm and the valid path import engine subpaths; the full suite must stay green.
- Test: `test/twin-engine-pin.test.ts` — the installed engine reports version `0.12.0-pre` and
  exports `stepTwinGate`, `initTwinGate`, `ticksToDetect`.

## Task 2 — the profile block and `profiles/twin-generic.yaml`

- `profiles/schema/profile.schema.json`: optional `twin_arm` with the contract's fields
  (`canary_weight`, `alpha_rollback`, `alpha_proceed`, `alpha_srm`, `max_ticks`,
  `allow_unequal_rate_split?`, `metrics[] {id, kind, worse, tolerance}`).
- Type `TwinArmProfile` in `engine/types/_config-profiles.ts`; `CompiledConfig.twin_arm` passthrough
  (the `control_arm` route: `effective-config.ts` → `attachProfileProvenance`).
- `alpha_allocation.total` may be 0 only when the profile declares `twin_arm` (its alphas live there).
- `profiles/twin-generic.yaml`: no LLM signals; `http_5xx` (rate, worse higher), `success` (rate, worse
  lower), `p99_latency_ms` (sign, worse higher); `canary_weight: 0.5`; Families A–E off.
- Test: `test/twin-profile.test.ts` — validates, loads, passes through; unknown key rejected;
  the engine's `checkTwinGateConfig` accepts the converted config.

## Task 3 — the gate path `engine/gates/_health-twin.ts`

- `twinGateConfig(profile)` (snake_case → engine camelCase), `stepTwinArm(cfg, state, tick)` wrapping
  `stepTwinGate`, the verdict map (`inconclusive → hold`, `invalid_experiment → halt`), and
  `ticksToDetectFor` from `twin-planning` where computable.
- `evaluateHealth`: a compiled config with `twin_arm` runs ONLY the twin path — no Family A/B/C/D/E,
  no `ROLLBACK_DEFS`/`EXTEND_DEFS`; the block lands on `HealthResult.twin_arm`, nothing on `rollback[]`.
- Test: `test/twin-health-path.test.ts`.

## Task 4 — HTTP service, twin mode

- `POST /v1/sessions {"mode":"twin","twin_arm":{…}}` → 201 `{session_id, mode:"twin"}`; no
  `scenario.baseline`. `POST /v1/sessions/{id}/ticks` per the contract.
- Persistence follows the existing runtime: the durable `SessionRecord` (with `twin_arm`), the
  per-tick verdict history (JSONL, idempotent on `emitted_at_ts` when supplied), the accumulator state
  in the in-memory map, and void-on-restart (OQ-1).
- A twin session's record is `mode: 'shadow'`, so `GET /v1/verdict/{deploy_ref}` returns code 0.
- Test: `test/twin-gate-http.test.ts` (runtime + handlers + a live server round trip).

## Task 5 — `TWIN_ARM_AUTHORITY` and the no-rollback proof

- `engine/guarantees.ts`: `TWIN_ARM_AUTHORITY = 'advisory'` beside `CONTRAST_ARM_AUTHORITY`.
- Test: `test/twin-authority.test.ts` — a regressed canary driven to engine `rollback` through
  `evaluateHealth`, `orchestrate`, the runtime, the HTTP handlers and `GET /v1/verdict`: no rollback
  id, no `rolled_back` phase, verdict code never 1; the Argo template never fails.

## Task 6 — Argo Rollouts

- `service/gate-http/argo/twin-analysis-template.yaml`: web provider on `GET /v1/verdict/{ref}`, the
  metric in `dryRun`, `successCondition: "true"`; an example Rollout whose experiment step runs a
  baseline ReplicaSet (stable spec) and a canary ReplicaSet at the same weight.
- README section on twin mode and the advisory posture.

## Task 7 — DORMANCY.md

- Entry for the twin addition: status, activation mechanism (the authority ADR after a real-service
  A/A).

## Task 8 — the 2026-09-25 defects

1. `engine/gates/_health-valid-path.ts:174` iterates `FAMILY_A_PRIMARY_SIGNALS`; iterate the compiled
   config's `family_a_signals` (fallback: the engine list, as the other runtime detectors do).
2. `engine/recalibration/direction-metadata.ts:30-45` is the only direction source; the profile's
   `direction_of_better` and `δ_min` reach `CompiledConfig.sli_meta` and the classifier reads them.
3. `engine/gates/_health-defs.ts:348-350` extends whenever `traffic_pct < 0.60`; compare against the
   baseline's `traffic_pct` instead (a canary at its planned share is not low traffic).
- One test per fix. Anything that belongs in the engine repo is recorded, not edited.

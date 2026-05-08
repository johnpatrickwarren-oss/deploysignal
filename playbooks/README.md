# Agentic Rollback Playbook Library

Per ARCHITECT-REPLY-49 Addition #27. YAML-backed playbook entries that scope the agentic rollback proposer's action space. Each entry is schema-validated at load time (`playbooks/schema/playbook.schema.json`) and filtered per the deploy's reversibility tag (rail e) before the FM sees it.

## v1 inventory (10 entries)

| File | Category | Reversibility required |
|---|---|---|
| [`rollback_canary_to_zero`](./rollback_canary_to_zero.yaml) | rollback | reversible |
| [`pause_and_alarm_oncall`](./pause_and_alarm_oncall.yaml) | pause | any |
| [`scale_down_affected_cell`](./scale_down_affected_cell.yaml) | scale | reversible |
| [`widen_alpha_budget_temp`](./widen_alpha_budget_temp.yaml) | widen_budget | any |
| [`suppress_family_a_signal_x`](./suppress_family_a_signal_x.yaml) | suppress | any |
| [`freeze_deploy_rollout`](./freeze_deploy_rollout.yaml) | pause | any |
| [`revert_tenant_tier_isolation`](./revert_tenant_tier_isolation.yaml) | rollback | reversible |
| [`rollback_to_previous_version`](./rollback_to_previous_version.yaml) | rollback | reversible |
| [`enable_shadow_mode_only`](./enable_shadow_mode_only.yaml) | pause | any |
| [`escalate_to_sre_team`](./escalate_to_sre_team.yaml) | pause | any |

Coverage matrix: every Family × reversibility-tag pair has at least one accessible action post-rail-e filter (architect-derived per D2 / P1).

## Rail (e) reversibility filter

At FM-input construction time, the playbook list passed to the FM is pre-filtered per the deploy's `reversibility_tag` (from Addition #5):

| Deploy reversibility_tag | Entries whose `reversibility_required` pass the filter |
|---|---|
| `reversible` | `reversible`, `any` |
| `forward_only` | `forward_only`, `any` |
| `conditional` | `forward_only`, `any` *(conservative — same set as `forward_only`)* |

Rail (e) is a **HARD INVARIANT** at input-construction, not a post-hoc confidence gate. The FM never sees inapplicable entries; it cannot propose them. Covered by `test/agent-rail-reversibility.test.ts`.

## Authoring a new playbook entry

1. Pick a category and reversibility requirement.
2. Add `playbooks/<snake_case_id>.yaml` with all required fields (per schema).
3. Run `npm test` — `test/agent-playbook-schema.test.ts` auto-exercises every `.yaml` in this directory.
4. Version stays at `1.0.0` for new entries; bump semver when modifying published entries.

Field reference: see [`schema/playbook.schema.json`](./schema/playbook.schema.json). Required fields:

- `id` — snake_case; must match filename stem.
- `version` — semver (Q2: defaults to 1.0.0 on v1; bump rules match #28 profile library).
- `applies_when` — `firing_families[]` + `min_family_count` + `verdict_class`.
- `reversibility_required` — `reversible` / `forward_only` / `any`.
- `confidence_threshold` — entries may tighten the global default 0.7; not loosen.
- `orchestrator_command_template` — `${var}` placeholders filled by the FM at proposal time.
- `human_description` / `expected_effect` — oncall-readable strings.
- `category` — one of `rollback` / `pause` / `suppress` / `scale` / `widen_budget`.

## Anti-scope (v1)

- **No customer-authored playbooks in v1.** DS-managed set only; customer-authoring gate is deferred.
- **No auto-execute.** `CompilerOptions.agent.auto_execute_enabled` is schema-enforced to `false` in v1. Narrow-auto for specific low-risk entries is deferred per D3 with documented gate ("shadow-mode period + <5% reject rate + operator opt-in").
- **Rail (e) is not a confidence threshold.** It runs BEFORE the FM sees the playbook list — hard invariant, not soft gate.
- **No rails beyond a-g.** Adding a rail requires operational evidence post-phase.

## Follow-on migration paths

- **Fine-tuned FM:** v1 is zero-shot with structured-output. Once production verdict + operator-accept/reject data accumulates, fine-tuned version reuses the playbook schema + safety rail set unchanged (per D1).
- **Real MLflow/UC wiring:** v1 ships integration contracts + StubAdapter that logs to local audit. Real Mosaic-native + Claude-via-Bedrock adapters are for follow-on per D5.
- **Per-customer playbook catalogs:** v1 ships only DS-managed playbooks. Q3 lean: v2 opens a customer catalog surface similar to #28's profile library; v1 scope remains DS-curated.

# Reference Workload Profile Library

Per ARCHITECT-REPLY-51 Addition #28. YAML-based templates that parameterize `CompiledConfig` inputs by workload class. This directory is the source of truth for profile content; the compiler loads profiles via `tools/profile-loader.ts`.

## v1 inventory

| Profile | Version | Extends | Purpose |
|---|---|---|---|
| [`llm-inference-streaming`](./llm-inference-streaming.yaml) | 1.0.0 | — | Primary DS target. Matches current default compile path (backward-compat anchor). |
| [`llm-inference-batch`](./llm-inference-batch.yaml) | 1.0.0 | `llm-inference-streaming` | Batch (non-streaming) LLM inference. Excludes TTFT; widens p99; tightens cost_req. |
| [`generic-microservice`](./generic-microservice.yaml) | 1.0.0 | — | Fallback for non-LLM workloads. Family A only; C/D/E disabled. |

v2 profiles (out of scope for Addition #28; noted for follow-on sequencing): `rag-pipeline`, `training-to-serving-handoff`, `data-plane`.

## Schema

- [`schema/profile.schema.json`](./schema/profile.schema.json) — validates every profile YAML against the D3 field contract.
- [`schema/customer-override.schema.json`](./schema/customer-override.schema.json) — validates customer override YAMLs against D8 structural rules.

Loader: `tools/profile-loader.ts` (pure library; integration into `tools/calibrate.ts` CompilerOptions lands in slice-2).

## Extension — authoring a new profile

1. Pick a parent (or `extends: null` for a root profile).
2. Add `profiles/<new-id>.yaml` with all required fields (or inherit via `extends:`).
3. Run `npm test` — `test/profile-schema-validation.test.ts` auto-exercises every `.yaml` in this dir.
4. Version stays at `1.0.0` until a published consumer depends on the profile; see semver below.

Field-level override semantics (D4, propagated to override layer via D8):
- **Scalars:** child value replaces parent.
- **Arrays:** child replaces parent array entirely (no append/merge). Override a sub-item by restating the full array.
- **Objects:** deep-merge with child precedence.
- **Null:** `field: null` in the child explicitly disables the parent's value.

Single-parent inheritance only. Circular chains (A extends B extends A) are rejected at load time.

## Customer overrides

Customers supply a YAML of the form:

```yaml
base_profile: "llm-inference-streaming@1.2.0"
customer_id: "acme"
overrides:
  sli_list:
    - signal: p99_latency
      δ_min: 0.008   # acme: tighter than profile default 0.01
  alpha_allocation:
    per_family:
      A: 3.0e-4
```

Loader computes `effective_config = deepMerge(base_profile, override.overrides)`. Overrides CANNOT introduce fields absent from the base profile schema (schema-enforced per D8); they CAN null out base fields to disable them.

Audit provenance: both `profile_ref` and `customer_override_ref` thread onto `CompiledConfig` so operators can reconstruct `effective_config` from git history (slice-2 wires the threading).

## Semver policy (D5)

`profile_ref` format: `<id>@<semver>` — e.g. `llm-inference-streaming@1.2.0`.

Versioning rules match standard semver:

| Bump | Change | Consumer action |
|---|---|---|
| MAJOR (`x.0.0`) | Breaking field changes: renames, removals, semantic shifts | Consumers must re-validate; no auto-upgrade. |
| MINOR (`1.x.0`) | Additive optional fields | Existing configs still compile cleanly. |
| PATCH (`1.0.x`) | Default-value tweaks | No field changes; existing configs recompile with new defaults. |

Profile file names include only the id (no version suffix). The file's internal `version:` field is the canonical source of truth; prior versions live in git history.

Architect lean on migration policy (Q1): **error** on version mismatch between override's `base_profile` and the loaded profile's actual `version`. Forces explicit consumer bump; prevents silent behavior drift.

## Post-M0 evolution (D7)

Addition #3 Metric Registry M0 is follow-on scope. Pre-M0, this library IS the Tier 1 + Tier 2 defaults surface — service teams pick a profile; the profile populates `CompiledConfig` inputs that M0 would otherwise populate via registry calls.

Post-M0, this library becomes a bootstrap / seed path for M0's registry content:
- A new service registers via M0 with "start from `llm-inference-streaming@1.2.0`" as the seed; M0 populates defaults from the profile.
- Service teams override via M0's registry surface (tighter UI for field-level tuning than raw YAML).
- Profile library persists as a catalog of starting points; M0 becomes the persistence + override surface.

The Addition #28 schema remains valid post-M0; its role narrows from "config source" to "seed catalog".

## Anti-scope (slice-1)

- No multi-parent inheritance (single-parent `extends` only).
- No override chains (profile + team + deploy layers). Single override layer only.
- No v2 profiles in this directory yet.
- No engine-side hardcoding of profile content. All profile content is in YAML here; `tools/calibrate.ts` slice-2 will consume via `profile-loader.ts`.

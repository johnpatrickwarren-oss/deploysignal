# Audit Log Schema — v1

One JSON object per line (JSONL). Every engine tick produces exactly one record,
regardless of verdict. This means shadow-mode deployments produce a complete
decision trail with no gaps.

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `string` | Always `"1"` for this version. Bump on breaking changes. |
| `ts` | `string` (ISO 8601) | Timestamp when the verdict was produced. Example: `"2026-04-15T14:32:01.123Z"`. |
| `service` | `string` | Service identifier passed to the runner. |
| `tick` | `integer` | Current tick index (0-based). |
| `total_ticks` | `integer` | Total ticks in this run (known up front for batch; 0 for streaming). |
| `hours_elapsed` | `number` | Simulated hours elapsed since deploy start. Required for replay — policy gate warmup behavior depends on elapsed time. |
| `verdict` | `string` | One of `"proceed"`, `"extend"`, `"rollback"`. |
| `reason` | `string` | Human-readable explanation. Detector label(s) when tripped; `"All signals nominal."` on proceed. |
| `short_circuit` | `string \| null` | Gate that short-circuited the pipeline (`"policy"`, `"approval"`, `"state"`), or `null` if health gate evaluated. |
| `tripped` | `array<TripEntry>` | Signals that fired. Empty array on `"proceed"`. See TripEntry below. |
| `inputs` | `Metrics` | Live metric values for this tick. See Metrics below. |
| `baseline` | `Metrics` | Baseline metric values used for comparison. |
| `scenario_ctx` | `ScenarioCtx` | Scenario metadata required for faithful replay. See ScenarioCtx below. |
| `trend_snapshot` | `object<string, TrendStats>` | Per-signal trend buffer state. Keys are signal names. See TrendStats below. |
| `policy_ctx_digest` | `string` | SHA-1 hex digest of the serialized policy context. Lets you detect policy changes without logging the full object. |
| `mode` | `string` | Engine mode: `"shadow"` (default for now), `"advise"`, or `"act"`. Placeholder — only `"shadow"` is implemented in Phase 1. |
| `gate_results` | `object` | Raw gate output keyed by gate name (`blastRadius`, `policy`, `approval`, `state`, `health`). Included for replay fidelity; omit from human-readable views. Post-Phase-5, this field is required for faithful replay because gate state becomes stateful (recent-decision memory in policy gate). |

### TripEntry

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Detector identifier (e.g., `"slowbleed"`, `"p99"`, `"kv_saturation"`). |
| `label` | `string` | Human-readable detector name (e.g., `"Slow Bleed (Multi-Metric Drift)"`). |
| `gate` | `string` | Which gate fired this signal: `"health_rollback"` or `"health_extend"`. |

### ScenarioCtx

Scenario metadata needed for faithful replay through policy/approval/state gates.

| Field | Type | Description |
|-------|------|-------------|
| `riskLevel` | `string` | Deployment risk level (`"low"`, `"medium"`, `"high"`, `"critical"`). |
| `changeType` | `string` | Type of change (`"model_weights"`, `"config"`, etc.). |
| `author` | `string` | Change author identifier. |
| `timeWindow` | `string` | Change window status (`"ok"`, `"freeze"`, etc.). |
| `flags` | `object` | Feature flags passed to approval gate (security, artifact, provenance, etc.). |

### Metrics

The live inference metrics consumed by the engine:

| Field | Type | Unit |
|-------|------|------|
| `p99_latency` | `number` | ms |
| `ttft` | `number` | ms |
| `tokens_turn` | `number` | tokens/turn |
| `cost_req` | `number` | $/request |
| `kv_cache_hit` | `number` | ratio (0–1) |
| `mfu` | `number` | ratio (0–1) |
| `hbm_spill` | `number` | ratio |
| `downstream_err` | `number` | ratio (0–1) |
| `refusal_rate` | `number` | ratio (0–1) |
| `eval_score` | `number` | score (0–1) |
| `tool_call_success` | `number` | ratio (0–1) |

### TrendStats

Per-signal output from `TrendBuffer.get()`:

| Field | Type | Description |
|-------|------|-------------|
| `n` | `integer` | Sample count in the buffer window. |
| `slope` | `number` | Raw linear regression slope. |
| `slopeNorm` | `number` | Slope normalized by baseline mean. |
| `cv` | `number` | Coefficient of variation. |
| `mean` | `number` | Running mean. |
| `min` | `number` | Window minimum. |
| `max` | `number` | Window maximum. |
| `range` | `number` | max - min. |
| `roc` | `number` | Rate of change (last 3 samples, normalized). |
| `stable` | `boolean` | Low cv + meaningful slope. |
| `insufficient` | `boolean` | True when n < 4 (not enough data for regression). |
| `trendStrength` | `number` | 0–1, monotonicity-weighted directional confidence. Computed per-signal by the engine, not stored in TrendBuffer directly. |

## Design decisions

- **Every tick is logged.** In shadow mode, the full decision trail matters more than disk savings. Downsample later if volume becomes a problem.
- **`gate_results` is included raw.** This makes replay possible without reverse-engineering gate internals. The reader CLI hides it by default.
- **`policy_ctx_digest` is a digest, not the full object.** Policy context contains thresholds and warmup state — useful for debugging but verbose. The digest detects changes; `--verbose` replay can rehydrate from gate_results.
- **`trendStrength` lives in `trend_snapshot`.** The engine computes it per-signal on demand (it's a function of TrendBuffer output, not stored in the buffer). The audit record captures the computed value at decision time.

## Size budget

Typical record sizes (JSON.stringify, no rounding — exact float bits preserved for replay determinism):
- Full rollback with trend data: ~1.9 KB
- Proceed (clean): ~1.2 KB
- Short-circuit (policy/approval/state): ~0.9 KB
- Average: ~1.3 KB/record

A 120-scenario adversarial sweep at ~20 ticks each ≈ 2,400 records ≈ **3.1 MB**.

## Float serialization

No rounding layer. All numeric values use default `JSON.stringify` serialization.
Replay determinism depends on exact bits — do not introduce formatting or precision limits.

## File conventions

- Path: `<audit-dir>/<service>/YYYY-MM-DD.jsonl`
- Rotation: daily, based on UTC date.
- Encoding: UTF-8, one JSON object per line, newline-terminated.
- No header line. Schema version is in every record.

---

# Audit Log Schema — v2 (W4 fusion-topology + portfolio-family extension)

_Added 2026-04-18 as the end-of-W3 architect deliverable. Absorbs: `ARCHITECT-REPLY-01` Conflict 3 sketch, `ARCHITECT-REPLY-09` Q3 (`alpha_spent` / `cusum_progress`), `coordination/REVIEWER-REPORT-WK02` X3 (`alpha_consumed` semantics), `coordination/REVIEWER-REPORT-WK03` X2 (per-family divergence) + X4 (synthetic-ID registry), addition #5 (reversibility). Consumed by subtask 4.1.h (audit writer + reader)._

## Backward compatibility — the one invariant

**Every field present in v1 is present in v2 with identical semantics.** v2 is strict-additive. A v1 reader consuming a v2 record sees the same fields it always did, ignoring new fields. A v2 reader consuming a v1 record treats missing v2 fields as `null` / absent.

`schema_version: "2"` is the only disambiguator. Replay fixtures preserved from Phase-1 (the 160-record golden JSONL) remain readable and produce identical verdicts. Writer auto-emits v2 records whenever the orchestrator's `fusion_topology` is `"portfolio"`; v1 records continue for legacy `"cascade"` paths until those paths are retired.

## New top-level fields in v2

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `string` | `"2"` for this version. |
| `fusion_topology` | `"cascade" \| "portfolio"` | Which verdict-fusion mode produced the top-line verdict. Lets shadow-compare runs record both side-by-side during W4. |
| `compiled_config_version` | `string` | The `CompiledConfig.version` the engine ran on for this record (e.g., `"v3-family-c-2d-cells"`). Every verdict is traceable to an exact compiled threshold set. |
| `families` | `object<string, FamilyVerdict>` | Per-family verdict records keyed by `"A" \| "B" \| "C" \| "D" \| "E"`. See FamilyVerdict below. Required on v2 records. |
| `reversibility` | `"reversible" \| "forward_only" \| "conditional" \| null` | Deploy reversibility classification from addition #5 (shipped 2026-04-20 per ARCHITECT-REPLY-32). Classified once per deploy by G0 against a `ReversibilityAnnotationSource`; value stays constant across all ticks. `null` only appears on pre-Addition-#5 records in the golden-v2 fixture; post-#5 records always carry a concrete value (default-fallback populates `'forward_only'` when no annotation source is supplied). |
| `reversibility_source` | `"platform_annotation" \| "default_fallback" \| null` | Whether the value came from an explicit platform annotation or from the conservative default. Post-#5 always `'platform_annotation'` (operator-set) or `'default_fallback'` (missing annotation → `'forward_only'`). `null` only in pre-Addition-#5 records. |
| `total_alpha_spent` | `number` | Sum of `alpha_spent` across all fired detectors this tick. Ville-inequality-consistent run-level budget accounting. |

### FamilyVerdict

One per family per tick. Families that weren't evaluated (pre-min-ticks, pre-cell-sufficient-samples) emit `verdict: "suppressed"` with `suppression_reason`.

| Field | Type | Description |
|-------|------|-------------|
| `verdict` | `"fire" \| "indeterminate" \| "clean" \| "suppressed"` | Family-level verdict. |
| `detectors` | `array<DetectorTrip>` | Which specific detectors within this family produced verdicts (empty on `clean`, may contain multiple on `fire`). |
| `alpha_spent` | `number` | 0 if family didn't fire; `α_family / N_detectors_bonferroni` if any detector in the family fired. Ville-inequality-consistent. |
| `suppression_reason` | `string \| null` | If `verdict = "suppressed"`, one of `"bake_profile"`, `"cell_confidence_none"`, `"schema_continuity_breaking"`, `"observability_stack_deploy"`, `"structural_mismatch"`. Null otherwise. |

### DetectorTrip (replaces v1's TripEntry for v2 records)

v2 formalizes the synthetic IDs Reviewer X4 flagged (`family_A_${signal}`, `family_C`) into a two-field registry: `family_id` + `detector_id`. This lets downstream audit consumers join cleanly against a detector-registry table rather than parsing string prefixes.

| Field | Type | Description |
|-------|------|-------------|
| `family_id` | `"A" \| "B" \| "C" \| "D" \| "E"` | Which family this detector belongs to. |
| `detector_id` | `string` | Family-scoped canonical detector name. See detector-registry table below. |
| `statistic` | `number` | The detector's computed statistic value this tick (e.g., Page-CUSUM `S_n` for Family A, `T²` for Family C). |
| `threshold` | `number` | The compiled threshold this statistic was compared against. |
| `alpha_spent` | `number` | 0 if detector didn't fire; per-detector α if fired (post-Bonferroni within family). Must match the family's `alpha_spent` when this detector is the sole firer. |
| `reason_code` | `string` | Machine-readable code (e.g., `"cusum_crossed_h"`, `"t2_exceeded_chi_quantile"`, `"kv_ratio_pinned_flat"`). |
| `gate` | `string` | Backward-compat with v1 TripEntry. One of `"health_rollback"` or `"health_extend"`. |
| `label` | `string` | Backward-compat with v1. Human-readable detector name. |
| `provenance` | `Provenance` | See Provenance below. Cell key, cell confidence, covariate freshness, baseline version. |
| `cusum_progress` | `number` (optional) | Family-A-only diagnostic. `S_n / threshold`, normalized CUSUM progress in [0, ∞). Absent from non-A families (per-tick single-shot tests have no "progress"). Replaces v1's misleading `alpha_consumed` field. |

### Provenance

The cell-lookup and covariate-freshness provenance Reviewer T3/T4 flagged (lets observable runtime cell-consultation settle the "did the detector use the right cell?" question).

| Field | Type | Description |
|-------|------|-------------|
| `cell_key` | `object \| null` | The `{hour_of_day, day_of_week, ...}` key that was consulted for cell-segmented baseline lookup. `null` if the detector doesn't consult cells (Family B structural, pre-addition-#2 detectors). **Addition #23**: gains optional `tenant_tier` ∈ `{'dominant', 'large', 'medium', 'small', 'aggregate'}`. The raw `tenant_id` is **never** persisted — privacy invariant per ARCHITECT-REPLY-39 anti-scope. |
| `cell_confidence` | `"strict" \| "pooled" \| "aggregate" \| "none" \| null` | Confidence tag from the consulted cell. `null` when `cell_key` is null. |
| `variance_inflated` | `boolean` | `true` if the covariance this detector used came from a pooled cell (shrunk toward pooled-neighbor estimate). From Reviewer X4. |
| `covariate_freshness` | `number` | Age in hours of the CUPAC predictor applied to this signal. 0 for signals without CUPAC (current scope — no CUPAC in shipped code). |
| `baseline_version` | `string` | Same as top-level `compiled_config_version` for single-version records; present on each trip for future multi-version roll-forward. |
| `schema_continuity` | `"continuous" \| "extended" \| "breaking" \| "observability_stack" \| null` | From addition #8. `null` on records that predate continuity checking. |
| `tenant_tier_config_hash` | `string` (optional) | **Addition #23.** 8-hex-character FNV-1a hash of the `tenant_tier_config` (boundaries + manual overrides) the compiler used to bucket tenants. Lets operators verify the tiering rule didn't change silently between deploys. Absent on pre-#23 configs (no tenant_tier_map emitted). |
| `family_c_shrink_fraction_used` | `number` (optional) | **Addition #20 (REPLY-43b).** The shrink fraction `c` used to derive `τ² = c · trace(Σ) / p` for Family C safe-Hotelling's mixture prior on the cell consulted. Default 0.03; operator override via `CompilerOptions.family_c_shrink_fraction`. Fire timings depend on `c`, so replay consumers need this value to reproduce decisions across different compiler runs. Populated only on records where Family C's safe-Hotelling detector fired (i.e. `detector_id === 'hotelling_t2_safe'`); absent otherwise. |

### Per-family detector registry (normative — consumed by audit readers and SLI dashboards)

Each family's `detector_id` values are drawn from a fixed enumeration. v2 records must use registry-valid IDs; v2 readers that encounter unknown `detector_id` values emit a `"unknown_detector_id"` warning and preserve the record.

**Family A — Per-signal regression (Page-CUSUM + betting e-processes, co-shipped per Addition #17):**

Page-CUSUM (shipped W2; file renamed `engine/detectors/mSPRT.ts` → `engine/detectors/page-cusum.ts` per ARCHITECT-REPLY-34 D1; **shipped 2026-04-20**):

- `mSPRT_p99_latency` (legacy id — Page-CUSUM's canonical emission path this PR; the REPLY-36 cleanup renames emission to `page_cusum_*` alongside demo `expected_outcome` + test-assertion migrations)
- `mSPRT_ttft`
- `mSPRT_eval_score`
- `mSPRT_tool_success_rate`
- `mSPRT_downstream_err`
- `mSPRT_cost_req`
- `page_cusum_p99_latency` (forward-compat alias — registry-valid read; not yet emitted)
- `page_cusum_ttft`, `page_cusum_eval_score`, `page_cusum_tool_success_rate`, `page_cusum_downstream_err`, `page_cusum_cost_req`

Betting-based e-processes (**shipped 2026-04-20** — Addition #17 Part 2 per ARCHITECT-REPLY-34; runs alongside Page-CUSUM; GRAPA + ONS-fallback wealth martingale; Ville-bounded anytime-valid FP control; α-budget split 50/50 within each per-signal Bonferroni slice per D7):

- `betting_e_process_p99_latency`
- `betting_e_process_ttft`
- `betting_e_process_eval_score`
- `betting_e_process_tool_success_rate`
- `betting_e_process_downstream_err`
- `betting_e_process_cost_req`

One Page-CUSUM + one betting-e-process entry per primary SLI — Family A's Bonferroni factor in the compiler stays at 6 (the primary-SLI count); each signal's per-slot α is further halved across the two co-shipped detectors. Family-level α stays ≤ 4e-4. Audit consumers reading v4-and-earlier records still see `mSPRT_*` ids; readers are expected to accept the legacy ids as an alias of the corresponding `page_cusum_*` canonical id.

**Family B — Structural signatures:**

- `kv_saturation`
- `hbm_elevation`
- `hbm_spill_roll`
- `mfu_collapse`
- `slowbleed`
- `collective`
- `capacity`
- `gpu_eff`
- `compound_lat`
- `tok_econ`
- `behavioral`
- `eval_quality_drop`
- `refusal_spike`
- `output_len_drift`
- `tool_call_degradation`
- `quality_warning`

Mirrors today's hand-designed detector set. Additions go through north-star Architecture-Addition process.

**Family C — Multivariate drift:**

- `hotelling_t2_joint_vector` (legacy per-tick χ² threshold-crossing; retained for backward-compat + force_legacy_family_c shadow-compare per Addition #20 D6)
- `hotelling_t2_core_subspace` (reserved for future subspace-projected variant)
- `sequential_mmd` (**shipped 2026-04-20** — Addition #18 Part 2 per ARCHITECT-REPLY-33; nonparametric MMD per-tick bootstrap-null; retained as backward-compat variant alongside `sequential_mmd_e_process`)
- `hotelling_t2_safe` (**shipped 2026-04-21** — Addition #20 per ARCHITECT-REPLY-43; mixture-prior safe-test e-process per Grünwald-de Heide-Koolen 2024; fires at `M_t ≥ 1/α` under Ville's inequality; co-ships alongside the legacy chi_square variant with compile-time selection via `cell.hotelling_variant`)
- `sequential_mmd_e_process` (**shipped 2026-04-21** — Addition #20 per ARCHITECT-REPLY-43; kernel-distance scalar betting e-process per Shekhar-Ramdas 2023 Option-B simplification; co-ships alongside legacy bootstrap_null variant with compile-time selection via `cell.mmd_variant`; reuses Addition #17 REPLY-34 betting primitives)

**Family D — Temporal structure:**

- `spectral_peak_acf_kv_cache` (legacy per-tick bootstrap-null threshold; retained for backward-compat + `force_legacy_family_d` shadow-compare per Addition #21 D1/D2)
- `spectral_peak_acf_collective_ops` (reserved)
- `spectral_e_detector_kv_cache` (**shipped 2026-04-21** — Addition #21 per ARCHITECT-REPLY-45; scalar mixture-prior betting e-process on peak|ACF|, Shin-Ramdas-Rinaldo 2022 simplified form; fires at `M_t ≥ 1/α_D = 10000` under Ville's inequality; co-ships alongside legacy bootstrap-null variant with compile-time selection via `cell.spectral_variant` — REPLACE semantic per D1, one detector_id per signal per tick)
- `bocpd_run_length_posterior` (reserved — post-phase)

**Family E — Novelty (conformal anomaly):**

- `mahalanobis_conformal_baseline` (W4 ships this; **Addition #19 shipped 2026-04-20** per ARCHITECT-REPLY-35 — parametric Gaussian bootstrap calibration gains per-sample time-decay weights; runtime fires when live Mahalanobis score exceeds the `(1 − α)`-th weighted quantile of the bootstrap scores; on-disk `ConformalParams` becomes a discriminated union with `kind ∈ {'unweighted','weighted','weighted_e_value'}`, pre-#19 configs parse as `'unweighted'`, post-#19 pre-#22 configs parse as `'weighted'`, post-#22 configs emit `'weighted_e_value'` by default. **Addition #22 shipped 2026-04-21** per ARCHITECT-REPLY-46 + REPLY-46b: the `'weighted_e_value'` variant runs a hedged-indicator betting wealth process `e_t = 1 + 𝟙(s_t in upper-α_E tail) − α_E` on the time-decayed calibration distribution; fires at `M_t ≥ 1/α_E = 10,000` under Ville's inequality. **COMPILER_VERSION bumped to 0.3.0** per REPLY-46 D9 to coordinate the variant default flip. `CompilerOptions.force_legacy_family_e` pins the legacy `'weighted'` variant for shadow-compare + audit-trail reproducibility.)
- `autoencoder_conformal_baseline` (reserved — for follow-on)
- `foundation_model_conformal_baseline` (reserved — ICLR 2026 ACAD-TSFM, for follow-on; route (b) real-held-out-with-weights covered by Tibshirani/Foygel-Barber/Candès/Ramdas 2019 lands here when operational baseline pools reach the per-cell `n ≥ ⌈1/α⌉` floor at α = 1e-4)

## Changes to v1 fields in v2 records

The v1 `tripped` array is preserved in v2 records as a **flattened projection** of all fired `DetectorTrip` entries across all families — sorted by family_id then detector_id. This lets v1 readers keep working against v2 records with no code changes. v2 readers ignore `tripped` and read from `families[*].detectors` directly.

The v1 `reason` field on the top-level record remains human-readable. On v2 records it typically renders as `"{family_id}.{detector_id}: {reason_code}"` for the highest-confidence firing detector (the first one fused into the verdict). Multiple-fire cases get `"portfolio: A={count} fires, C={count} fires, ..."` summary text.

The v1 `short_circuit` field retains its meaning. v2 adds that G1 policy can short-circuit on `blocked_by_incident` (from addition #6) with a new shorted-circuit value `"policy_incident"`.

## Deprecations in v2 — what v2 writers no longer emit

**`alpha_consumed`.** The v1 field name was a category error — what it measured (cumulative per-tick statistic progression) isn't α consumption under Ville's inequality semantics. v2 writers don't emit `alpha_consumed`. The diagnostic it captured is now `cusum_progress` on Family A `DetectorTrip` entries only (per Q3 resolution and X2 per-family divergence). Family C and other per-tick single-shot tests don't have a diagnostic equivalent; `alpha_spent` is the only budget field for them.

**Synthetic detector IDs in v1 `tripped[].id` (`family_A_${signal}`, `family_C`).** v2 writers emit canonical `{family_id, detector_id}` pairs in `DetectorTrip` per the registry above. The flattened `tripped` projection for backward compat uses the `detector_id` as the `id` field, which is more stable than the synthetic IDs (e.g., `mSPRT_p99_latency` rather than `family_A_p99_latency`).

## Size budget — v2

v2 records are larger than v1 by the `families` block plus provenance detail. Typical sizes:
- Full rollback with all 5 families evaluated and 2 firing: ~3.2 KB
- Proceed (clean, all families `clean`): ~2.1 KB
- Suppressed-family cases (early-tick, partial evaluation): ~1.8 KB
- Average: ~2.3 KB/record

A 120-scenario adversarial sweep at ~20 ticks each ≈ 2,400 records ≈ **5.5 MB.** Still trivially manageable at demo/project scale.

## Replay determinism — v2

Same invariants as v1: no rounding, default `JSON.stringify` float serialization, exact-bit preservation. v2 adds: the `families` block's ordering is deterministic (families emit in lexicographic family_id order; detectors within a family emit in registry-definition order). The flattened `tripped` projection follows the same ordering.

Replay-regression fixtures extend: the existing 160-record v1 fixture stays valid; a parallel v2 fixture captures the same scenario runs under `fusion_topology: "portfolio"` with full per-family verdicts. Both fixtures run in the replay-regression test in parallel; both must pass.

## What v2 does not do

- **Does not change the one-record-per-tick invariant.** v1's guarantee stays: every tick produces exactly one audit record regardless of verdict.
- **Does not re-encode values.** All numeric values use default `JSON.stringify` serialization. No binary formats, no gzip, no base64 — plain JSONL.
- **Does not change rotation semantics.** Daily rotation based on UTC date remains the standard.
- **Does not emit per-family provenance outside trip entries.** Families with `verdict: "clean"` have empty `detectors` arrays; `alpha_spent = 0`; no provenance block (there's no detector firing to attribute). Suppressed families carry `suppression_reason` but no detector details.
- **Does not attribute flag-based gate short-circuits in the per-family block.** Flag-driven rollbacks from G1 (policy) / G2 (approval) / G3 (state) gates — for example, `security`, `artifact`, `provenance`, `contract`, `toolchain`, `tokens` — short-circuit before the health gate evaluates. v2 emits these via the existing `short_circuit` top-level field (`"policy"` / `"approval"` / `"state"` / `"policy_incident"`) with attribution text in the `reason` field. They are **not** pushed into `families.B.detectors[]` because Family B is "structural signatures evaluated in the health gate," not "anything that can cause rollback." A v2 reader seeing `short_circuit !== null` with an empty `families.B.detectors[]` is behaving correctly; attribution lives at the top level for short-circuit cases. Deferred to **v2.1 post-phase**: a `policy_details` block capturing gate-short-circuit provenance (gate identity, flag / rule id, raised-at-tick) so that downstream consumers joining per-family audit records can attribute flag-driven rollbacks in the same shape as health-gate family fires. Not runway-scope; flag-driven scenarios aren't in the adversarial pool, and real-world flag integration lands with the first customer-service shadow-mode rollout for follow-on.

## Migration path

1. **W4 ship.** Writer detects `fusion_topology === "portfolio"` and emits v2; cascade path emits v1. Replay regression test runs both.
2. **End of W4 adversarial sweep.** v2 fixture generated alongside v1 fixture. Both pass 160/160.
3. **Post-runway.** Cascade path retired; all records v2. v1 readers still supported for legacy audit archives.

---

# Audit Log Schema — v2.1 extensions (planned, post-phase)

_Queued 2026-04-19 as competitive-research-derived minor extensions. v2.1 is a strict-additive minor version over v2: all v2 records remain valid; v2 readers ignore v2.1-added fields; v2.1 readers treat them as optional. No writer-side commitment in the project; lands alongside first-hire integration work as new fields begin to carry production signal._

## v2.1 extensions — fields added (all optional, all strict-additive)

### Top-level record fields

- **`traffic_allocation_continuity`** (added per Architecture Addition #10, SRM check — shipped 2026-04-19). Values: `'stable' | 'drifting' | 'breaking'`. Emitted by L0 on every tick alongside `schema_continuity`. When `'breaking'`, the record also carries `short_circuit: 'srm'` and suppresses all family detector blocks (orchestrator skips the health gate; v2 family blocks stay at their `clean` default). Absent or `null` on records where the caller does not thread `trafficAllocationContinuity` through `OrchestrateParams` — readers treat absence and `null` identically.
- **`granularity`** (added per Architecture Addition #12, per-pod verdict breakdown). Values: `'per_pod' | 'cohort'`. When `'per_pod'`, the record represents a single pod's verdict; a parent cohort-level record references children. When `'cohort'` (or absent for backward compat), single-record-per-tick-per-deploy as in v2.
- **`pod_id`** (added per Architecture Addition #12). Present when `granularity === 'per_pod'`; references the specific pod.

### `FusedVerdict.verdict` enum extension

Gains `'suppressed_insufficient_samples'` per Architecture Addition #11. Downstream consumers handle as a fourth verdict class (sibling to `proceed`, `extend`, `rollback`); operator policy at the orchestrator layer resolves to concrete action.

### `short_circuit` enum extension

Gains `'srm'` (per Addition #10, shipped 2026-04-19) and `'policy_fail_fast'` (per Addition #13, shipped 2026-04-19). Treated identically in v2.1 readers — top-level `reason` field carries the human-readable explanation; `suppression_reason` on per-family records surfaces the cause.

### `suppression_reason` enum extension

Gains `'ignore_threshold'` (per Addition #13, G1 policy ignore bounds — shipped 2026-04-19) and `'insufficient_samples'` (per Addition #11, per-family sample-threshold suppression).

Only Family A (single-signal mSPRT) emits `suppression_reason: 'ignore_threshold'` at the family level. Multivariate families (C Hotelling T², E conformal Mahalanobis) evaluate the full joint vector regardless of `ignore_thresholds` state — in-band signals contribute near-zero to the Mahalanobis quadratic form naturally (see NORTH-STAR-ARCHITECTURE.md Addition #13 multivariate-semantic invariant) — so neither Family C nor Family E produces a `'ignore_threshold'` suppression_reason. Architect-intended semantic per ARCHITECT-REPLY-31.

### `DetectorTrip.ignore_threshold_trigger_signal` — Family-A-only audit enrichment

Optional field on `DetectorTrip` entries where `reason_code === 'ignore_threshold'` and `family_id === 'A'`. Names the signal whose in-band observation caused the suppression — unambiguous for single-signal detectors, where the suppressed detector is keyed on that exact signal. Family C/E do NOT emit this field because they do not suppress under `ignore_thresholds` (per ARCHITECT-REPLY-31 multivariate semantic). Added for audit observability per TPM-REPLY-28 enrichment ask; landed alongside the multivariate-semantic correction.

### `DetectorTrip.provenance` — Family A effect-size CI

Per GAP-06 in `COMPETITIVE-GAPS-ADDITIONS.md`, Family A's `DetectorTrip.provenance` block gains an optional field:

- **`effect_size_ci`**: `{ lower: number, upper: number, confidence_level: number }`. Computed from Page-CUSUM state and the mixture prior at emission time. Derivation is O(1) per emission. Renders alongside `cusum_progress` in dashboard UIs so viewers see both the Ville-bound budget statistic (formal sequential-test value) and the intuitive effect-size range (what LaunchDarkly Guarded Rollouts surfaces as its primary statistical output).

The field is Family-A-specific per the REPLY-13 §X2 resolution pattern — per-family fields live in family-specific provenance blocks; non-A families don't have an effect-size CI in the same sense because their statistics aren't directly interpretable as effect sizes on a single signal.

### `LifecycleEvent` — emission type adjacent to audit (shipped 2026-04-20)

Per Architecture Addition #14, O0 adapters emit five lifecycle event types (`evaluation.triggered | .started | .tick | .suppressed | .finished`). Runway ships the `LifecycleEventEmitter` contract plus two reference implementations: `NoOpLifecycleEventEmitter` (default zero-side-effect) and `InMemoryLifecycleEventEmitter` (test fixture with per-listener error isolation and registration-order delivery). Real-orchestrator adapters (Kubernetes Events, Spinnaker notifications, the model-lifecycle tooling tags, webhooks) remain for follow-on — the engine emits `LifecycleEvent` objects; adapters translate.

Lifecycle events are a derivative ephemeral stream, NOT audit records — they flow to orchestrator-native event surfaces for integration (incident managers, dashboards, etc.) and are not persisted by the engine. The audit log remains the authoritative per-tick record; the `evaluation.tick` payload carries the tick's v2 audit record so lifecycle subscribers don't need to join against a separate source, but the subscriber owns any persistence. Emission invariants:

- `evaluation.triggered` / `.started` / `.finished` fire exactly once per deploy (latched via `LifecycleDeployState.{triggeredEmitted,startedEmitted,finishedEmitted}`).
- `evaluation.tick` fires every tick.
- `evaluation.suppressed` fires only on non-suppressed → suppressed per-family transitions mid-evaluation, NOT every tick a family is suppressed (prevents event spam; tick-0 initial-state is baseline, not a transition).

`evaluation.tick` payload mirrors the v2/v2.1 audit record for that tick. `evaluation.finished` payload includes `final_verdict`, `total_alpha_spent`, per-family summary, `divergence_from_spec` if applicable.

### Addition #18 — robust covariance metadata (shipped 2026-04-20)

Per ARCHITECT-REPLY-33 Part 1. `FamilyCPerCell` gains three additive fields, all strict-additive over v4-and-earlier CompiledConfigs. Audit records carry the fields on every v2 Family C trip via `DetectorTrip.provenance` (cell_confidence etc. unchanged — the method choice lives on the baseline cell rather than per-trip):

- **`covariance_method`**: `'ledoit_wolf' | 'mcd' | 'mrcd' | 'ledoit_wolf_from_degenerate_mrcd' | 'aggregate_fallback'` — discriminator identifying which estimator produced the cell's covariance. Compile-time migration: v4-and-earlier cells without the field read as `'ledoit_wolf'` (no runtime fallback, no silent swap). MCD vs MRCD vs LW per-cell choice is sample-size driven (n ≥ 2p+1 AND p ≤ 20 → MCD; n < 2p+1 AND p ≤ 20 → MRCD; p > 20 → LW), overridable via `CompilerOptions.covariance_method_override`. **Addition #23**: `'aggregate_fallback'` is emitted on per-tenant-tier cells whose pooled n falls below the MCD floor (`max(5·p, 200)`); the cell inherits the across-tier aggregate covariance verbatim and audit consumers see "this cell used the aggregate Σ, not a tier-specific MCD" instead of an unstable-on-sparse-tier covariance.
- **`outlier_detection`** (new `OutlierDetection` type, Family-C-only, null on LW cells): `{method, raw_baseline_n, trimmed_baseline_n, outlier_fraction, h_support, mahalanobis_cutoff}`. Populated on MCD/MRCD cells; documents the core subset h and the Mahalanobis cutoff √χ²(0.975, p) used for the reweighting step.
- **`mmd_params`** (new `MMDParams` type, Family-C-only, null on cells without MMD precompute — LW cells with n < 500 or any pre-#18 config): `{kernel: 'gaussian_rbf', bandwidth, window_size, baseline_baseline_sum, null_quantile, null_quantile_bootstraps, alpha}`. Compile-time precompute that lets Sequential MMD run the O(b·p) streaming recurrence at evaluation time without shipping the raw baseline matrix.

`DetectorTrip.detector_id` on Family C trips takes four values post-#20 (ARCHITECT-REPLY-43, shipped 2026-04-21): `'hotelling_t2_joint_vector'` (legacy chi_square per-tick threshold), `'sequential_mmd'` (legacy bootstrap-null), `'hotelling_t2_safe'` (safe-test e-process mixture-prior; new default on post-#20 configs), `'sequential_mmd_e_process'` (kernel-distance betting e-process; new default on post-#20 configs). Variant selection is compile-time via `cell.hotelling_variant` + `cell.mmd_variant`; legacy paths stay selectable via `CompilerOptions.force_legacy_family_c`. Audit consumers that switch on enumerated ids degrade gracefully on the new values per the existing forward-compat rule.

Family C α-budget split (D8): when a cell carries `mmd_params`, Hotelling T² takes `per_family.C × 0.5` and Sequential MMD takes the other half. Cells without `mmd_params` (pre-#18 configs or LW/small-n) keep the Hotelling detector on the full family budget for backward compat. Family-level α stays at `alpha_budget.per_family.C` either way.

`DetectorTrip.detector_id` on Family D trips takes two values post-#21 (ARCHITECT-REPLY-45, shipped 2026-04-21): `'spectral_peak_acf_{signal}'` (legacy per-tick bootstrap-null threshold; retained for backward-compat + `force_legacy_family_d` shadow-compare), and `'spectral_e_detector_{signal}'` (scalar mixture-prior betting e-process on peak|ACF|; new default on post-#21 configs). REPLACE semantic per D1 — one detector_id per signal per tick, not co-shipped. Variant selection is compile-time via `cell.spectral_variant`; legacy path stays selectable via `CompilerOptions.force_legacy_family_d`. Audit consumers switch on enumerated ids via forward-compat degradation. Currently registered per W4 detector scope: `spectral_peak_acf_kv_cache` + `spectral_e_detector_kv_cache`; other `FAMILY_D_SIGNALS` would extend the registry proportionally as needed.

### Addition #23 — tenant-slice cell-matrix dimension (shipped 2026-04-20)

Per ARCHITECT-REPLY-39. Strict-additive on every audit surface:

- **`DetectorTrip.provenance.cell_key.tenant_tier`** (optional): the tenant-tier bucket consulted for the cell lookup, one of `'dominant' | 'large' | 'medium' | 'small' | 'aggregate'` (or an operator-custom string when `manual_overrides` is in play). Absent on pre-#23 records and on Family B trips (structural signatures don't consult per-tier cells). **Privacy invariant** (anti-scope per ARCHITECT-REPLY-39): the raw `tenant_id` is **never** persisted in audit records — only the tier bucket. Tenant_id reaches the orchestrator's `OrchestrateParams.tenantId` and gets resolved at the per-tick level via `CompiledConfig.tenant_tier_map`; from that point on, only the tier flows through the gate.

- **`DetectorTrip.provenance.tenant_tier_config_hash`** (optional): 8-hex-character FNV-1a hash of the `CompiledConfig.tenant_tier_config` (boundaries + manual_overrides) the compiler used to bucket tenants. Lets operators verify the tiering rule is unchanged across compiles — a hash mismatch on a re-baseline indicates the tier definitions drifted, which itself is a notable change in audit semantics. Absent on pre-#23 configs (no `tenant_tier_map` emitted).

- **`FamilyCPerCell.covariance_method = 'aggregate_fallback'`** (new enum member, documented in the row above): emitted on per-tier cells where pooled n < MCD floor and the across-tier aggregate covariance was inherited. Strict-additive on the discriminated union; v2 readers that switch on the existing values degrade gracefully on the new value per the existing forward-compat rule.

- **`BaselineCellsConfig.dimensions`** gains `'tenant_tier'` as a permitted dimension entry; emitted only when `tenant_tier_map` is populated.

Three-tenant `demo-tenant-skew` scenario provides a canonical end-to-end trace: portfolio fires Family A on tenant B's `'large'`-tier cell with `cell_key.tenant_tier === 'large'` in the audit; cascade emits zero rollback records because the aggregate eval_score stays under threshold.

### Addition #28 — reference workload profile provenance (shipped 2026-04-22)

Per ARCHITECT-REPLY-51. Strict-additive on `CompiledConfig`:

- **`CompiledConfig.profile_ref`** (optional, format `<id>@<semver>`): identifies the reference workload profile that parameterized this compile. Examples: `'llm-inference-streaming@1.0.0'`, `'llm-inference-batch@1.0.0'`, `'generic-microservice@1.0.0'`. Absent on pre-#28 configs and on compiles run without `CompilerOptions.profile_ref` (legacy path). Audit consumers reload the specific profile version via `loadProfile(profile_ref)` reading `profiles/<id>.yaml` at git history of the recorded version — byte-identical re-derivation of `effective_config` enabled.

- **`CompiledConfig.customer_override_ref`** (optional, format `<customer_id>@<semver>`): present only when an override layer composed on top of the base profile (`CompilerOptions.customer_override_ref` path to override YAML). Example: `'acme@1.0.0'`. Absent on profile-only compiles and on legacy compiles.

**Audit reproducibility invariant.** Given `(profile_ref, customer_override_ref)` from an old audit record + matching git history of `profiles/`, an operator can run `loadProfile(profile_ref) → override → resolveEffectiveConfig` and obtain the exact `effective_config` that drove the original compile. Re-running `node tools/calibrate.js --profile_ref ... --customer_override_ref ...` against the same baseline produces a byte-identical `CompiledConfig` (modulo `compile_phases` timing, which is strictly diagnostic). Covered by `test/profile-audit-reproducibility.test.ts`.

**Byte-identity anchor.** `llm-inference-streaming@1.0.0` encodes the pre-#28 compile defaults exactly (same α split at 40/20/20/10/10, same 13 bake_profile entries, same FAMILY_A + FAMILY_C signal lists). A compile with `--profile_ref llm-inference-streaming@1.0.0` produces byte-identical output vs the legacy (no-profile) compile path — PRIMARY backward-compat regression anchor, covered by `test/profile-v1-set-smoke.test.ts`.

**What stays unchanged.** Per-tick `AuditRecord` / `AuditRecordV2` shape: unchanged (profile_ref lives on `CompiledConfig`, not on per-verdict records). `DetectorTrip.detector_id`: unchanged. `FamilyVerdict` shape: unchanged. v2 reader forward-compat: v2 readers encountering `profile_ref` on an embedded `CompiledConfig` treat it as an unknown string field and ignore per standard JSON tolerance.

### Addition #28 dynamic-routing extensions (REPLY-51b v1 + v2; shipped 2026-04-22)

All strict-additive on `CompiledConfig`; no `COMPILER_VERSION` bump (matches REPLY-43 D5 precedent for family-field optional relaxation). Legacy configs load + validate unchanged; runtime consumers null-check before access.

- **`CompiledConfig.family_B`** — relaxed from required → optional (R4-4 post-v1). Absent when `structural_detectors.enabled: false` on the active profile (`generic-microservice@1.0.0` pattern). Legacy + streaming compiles still emit it. Consumer null-guard pattern: `cfg.family_B && cfg.family_B.cutoffs` (matched `engine/orchestrator.ts:36`).

- **`CompiledConfig.family_D`** — similarly optional post-v2 R4-1. Absent when the active profile's effective spectral-applicable signal subset is empty (generic-microservice pattern). Legacy + streaming + batch compiles emit it.

- **`CompiledConfig.family_a_signals`** — optional `string[]` (post-v2 R4-1). Profile-driven Family A monitored-signal inventory emitted when the compile ran under a profile. Legacy compiles omit. Runtime detectors (`page-cusum`, `betting-e-process`) read with fallback to hardcoded `FAMILY_A_PRIMARY_SIGNALS`. A3 invariant: runtime operates on compiled shape without per-tick projection.

- **`CompiledConfig.family_c_signals`** — optional `string[]` (post-v2 R4-1). Profile-driven Family C/E joint-vector inventory. Compiled `covariance` matrix + `mean_vector` dimensions match this inventory's length (streaming: 11 signals → 11×11; batch: 10 signals → 10×10 per §D7(a); generic: 0 signals → Family C absent per D5). Runtime detectors (`hotelling`, `sequential-mmd`, `conformal`) read with fallback to hardcoded `FAMILY_C_SIGNALS`.

- **`CompiledConfig.policy_defaults`** — optional `{reversibility_threshold_minutes, auto_rollback_enabled, default_risk_tier}` (post-v1 R4-3). Emitted by profile-routed compiles. Runtime consumer wiring in `engine/gates/policy.ts` deferred per R4-3 followup disposition 2026-04-22 — the surface lands now so future G1-layer adoption reads cleanly; no current consumer reads the field.

- **`CompiledConfig.compile_warnings`** — optional `Warning[]` (post-v2 R4-2). Accumulated during dispatch. Shape: `{code: string, message: string, context: Record<string, unknown>}`. Current codes: `CELL_DIM_BASELINE_DEFICIENCY` (profile enables a cell dimension the baseline lacks; `CompilerOptions.cell_dimension_deficiency_mode` controls `warn` | `error` | `silent`). Absent when compile produced zero warnings (legacy + clean-reconcile compiles).

**Reader forward-compat.** v2 and v2.1 readers encountering any of these optional fields on an embedded `CompiledConfig` treat unknown fields as ignored per standard JSON tolerance. Consumers that need the new fields are expected to null-check — no schema version bump is required for the strict-additive relaxation.

**What stays unchanged (v2 dynamic-routing additions).** `AuditRecord` / `AuditRecordV2` shape: unchanged. `DetectorTrip.detector_id` / `detector_id` enumerations: unchanged. `FamilyVerdict` shape: unchanged. `evaluation.*` lifecycle event payloads: unchanged. No new audit event types. Dynamic routing is entirely a compile-time + detector-runtime phenomenon; the audit surface remains at the per-tick `AuditRecord` granularity it had pre-#28.

## What v2.1 does not change

- **All v1 guarantees.** One-record-per-tick, no rounding, default JSON serialization, daily rotation, backward-compat with readers.
- **All v2 guarantees.** Per-family verdict records, canonical detector registry, `cusum_progress` Family-A-only, `alpha_spent` universal. Policy-short-circuit attribution (flag-driven rollbacks) remains deferred to v3 per the original v2 §"What v2 does not do" note.
- **The schema version number on shipped records.** Until v2.1 fields are actually emitted, records remain `schema_version: '2'`. When writer-side support for any v2.1 field ships, `schema_version` moves to `'2.1'` on those records.

## v2.1 migration path

1. **Post-runway Q1.** As each Architecture Addition lands in implementation (SRM check, per-pod breakdown, fail-fast thresholds, insufficient-samples handling, lifecycle events), the corresponding v2.1 fields start emitting on records where they apply. `schema_version` moves to `'2.1'` on those records; v2 records continue to emit on code paths that haven't been updated.
2. **Readers.** v2 readers treat v2.1-added fields as unknown and ignore them (standard JSON tolerance). v2.1 readers prefer the extended fields when present, fall back to v2 semantics when absent. Backward-compat is strict-additive: no v2 record shape changes.
3. **Fixtures.** v2 replay-regression fixture stays canonical for v2 paths. As v2.1 fields start emitting, parallel v2.1 fixtures generated alongside.

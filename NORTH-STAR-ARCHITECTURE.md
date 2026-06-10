# North-Star Architecture — Math-Grounded Deployment Decision Platform

_Status: Reference architecture. Non-binding. Drafted 2026-04-16._
_Companion docs: the project roadmap (deleted) (execution plan), the pitch draft (deleted) (narrative), `ARCHITECTURE.md` (current state), `DETECTOR-MATH-RESEARCH.md` (method survey)._

This doc describes the system we'd build if we started clean today, knowing what we know about AI-inference workloads, what we know about the limits of hand-tuned detectors, and what the 2024–2026 literature on sequential testing, kernel two-sample tests, and conformal anomaly detection has made viable. It is the target architecture — not what exists, not a promise, but the shape everything should move toward.

---

## Thesis in one paragraph

A deployment decision engine should be a **statistical monitoring system with explicit false-alarm control**, not a hand-crafted classifier. Its detectors should form a portfolio of principled tests against a shared α budget; its threshold numbers should be _derived_ from the noise envelope of healthy traffic, not memorized from an adversarial suite; its runtime path should be arithmetic plus lookups; and its learning loop should close on real production outcomes rather than synthetic scenarios. Domain knowledge — AI-inference failure signatures, data-plane skew patterns, whatever the workload demands — belongs in the _structure_ of detectors, not in their threshold numbers. The goal is a system where rigor and domain knowledge compose cleanly instead of fighting each other.

---

## Design principles

**Principle 1 — Math at build time; arithmetic at run time.** All statistical machinery (hypothesis tests, null distributions, covariance estimation, kernel computations, model scoring) runs in a _calibration compiler_, offline. The runtime detector path is simple arithmetic against compiled thresholds. This keeps production latency trivial and makes every detector's behavior auditable from its inputs.

**Principle 2 — Explicit α budget.** The system owns a top-line false-alarm budget and allocates it across detector families. Every threshold carries the FP rate it was derived at. When two detectors fire, their joint FP rate is known. This is what turns "we tuned it and it seems to work" into "we have finite-sample false-alarm control under stated assumptions."

**Principle 3 — Detectors are a portfolio, not a pipeline.** Five detector families run in parallel, each answering a distinct statistical question. A verdict is a fusion of their outputs, not the first-fires-wins cascade of the current engine. Any one family can be swapped, upgraded, or retired without destabilizing the others.

**Principle 4 — Domain knowledge lives in detector _structure_, not in threshold numbers.** Patterns specific to the workload — "KV cache pinned flat at capacity," "shuffle skew ratio," "MFU collapse before latency responds" — remain as hand-designed detector shapes. Their cutoffs come from the calibration compiler. Numeric trivia moves from code to configuration.

**Principle 5 — Baselines are live, not frozen.** The reference against which deviations are measured is a rolling aggregate of recent healthy production traffic, managed by an explicit baseline layer. When production shifts, thresholds recompile. There is no "scenario baseline" buried in code.

**Principle 6 — Ground truth comes from outcomes, not scenarios.** The learning loop closes on real incidents, customer impact signals, and oncall decisions, retrieved from the audit stream and labeled downstream. Synthetic scenarios exist only as regression tests — fixtures that prove the system still catches known patterns after a change. They are never the fitness function.

**Principle 7 — Verdicts carry provenance.** Every rollback, extend, or proceed verdict emits the detector that fired, the statistic it computed, the threshold it compared to, the α this consumed from the budget, and the baseline version used. Oncall gets "p99 rejected H₀ at α=10⁻⁴, 40% of run budget consumed" not "p99 tripped."

---

## The architecture, at a glance

```
  raw telemetry (Prometheus / traces / logs / billing)
           │
           ▼
  L0 — Signal ingestion + preprocessing
        (schema normalize, robust stats, CUPAC adjustment)
           │
           ▼
  L1 — Characterization
        (multi-scale windows, distributional summaries, BOCPD run-length)
           │
           ▼
  L2 — Detector portfolio (5 families run in parallel)
        ├── Per-signal regression   (Page-CUSUM + betting e-processes)
        ├── Structural signatures   (domain patterns, compiled thresholds)
        ├── Multivariate drift      (Hotelling T², sequential MMD)
        ├── Temporal structure      (spectral/ACF, BOCPD)
        └── Novelty                 (conformal anomaly scoring)
           │
           ▼
  L3 — Verdict fusion
        (α budget allocation, rollback / extend / proceed)
           │
           ▼
  L4 — Audit + observability
        (provenance on every verdict, shadow comparison, the model-lifecycle tooling tracking)
           │
           ▼
  L5 — Learning loop
        (outcomes → baseline refresh → recompile thresholds)

  ── and orthogonal to the runtime pipeline ──

  CC — Calibration Compiler  (build-time; takes healthy baseline + α budget,
                              emits the detector config the runtime consumes)
```

The calibration compiler is deliberately drawn outside the runtime stack because it _is_ the architectural innovation. Every existing tool in this space (Kayenta, Flagger, Argo Rollouts, Watchdog, Anodot) runs its statistics at detect time. Moving the statistics to a build-time compiler is what lets a principled, multi-family detector set run at arithmetic cost.

---

## Layer specs

### L0 — Signal ingestion + preprocessing

**Job:** Take raw telemetry, emit variance-reduced, outlier-aware metric streams in a canonical shape.

**Inputs:** Prometheus scrapes, structured logs, distributed traces, billing counters, customer-impact signals (support ticket rate, churn proxies). Each signal has a canonical name, a unit, a semantic type (counter / gauge / ratio / latency quantile / categorical rate), and an ingestion provenance.

**Responsibilities:**
- Normalize cardinality: per-service, per-region, per-tenant disaggregation according to schema.
- Apply CUPAC-style adjustment: `Y_adj = Y − θ·(X − E[X])` where `X` is a per-signal covariate from a pre-deploy predictor (traffic mix, time of day, request-shape prior). Variance reduction multiplier ≈ `1 − ρ²`.
- Robust statistics throughout: Theil-Sen slope, median/MAD for centering/spread, Hampel identifier for per-point outlier tagging. No OLS fits on the inbound path.
- Emit health metadata alongside each sample: "this signal's covariate predictor is stale," "this sample flagged as Hampel outlier," "this cardinality has insufficient data for adjustment."

**Out of scope:** Detection. L0 is pure preprocessing.

**Contract:** Each signal emits a typed stream `{signal_id, ts, value_raw, value_adjusted, outlier_flag, covariate_freshness}`.

### L0b — Profile layer (Addition #28)

**Job:** Parameterize the compile-time defaults (α allocation, bake profiles, SLI inventory, cell dimensions, policy defaults) by workload class via a YAML-backed template library. A deploy's `CompilerOptions.profile_ref` selects a base profile; an optional `customer_override_ref` layers customer-specific deltas on top.

**Inputs:** `profiles/<id>.yaml` (reference profile templates) + optional customer override YAMLs. Both schema-validated (JSON Schema Draft-07 subset) at load time.

**Responsibilities:**
- `loadProfile(profile_ref)`: resolves the `extends:` chain (single-parent inheritance with cycle detection); merges root → leaf; validates the resolved shape against the full schema; enforces `alpha_allocation.total == Σ per_family` invariant.
- `loadCustomerOverride(file)` + `resolveEffectiveConfig(profile, override)`: composes `effective_config = deepMerge(profile, override.overrides)`. Override CANNOT introduce fields absent from the base profile schema (schema-enforced per D8). Arrays replace entirely (D4); scalars replace; objects deep-merge; `null` disables parent fields.
- Integration surface in `tools/calibrate.ts`: when `profile_ref` is supplied, `effective.alpha_allocation.per_family` drives the α split and `effective.bake_profiles` overrides `BAKE_PROFILE` entries. Legacy compiles (no `profile_ref`) keep the hardcoded constants; output stays byte-identical.

**v1 profile inventory:**
- `llm-inference-streaming` (primary DS target; matches current compile defaults exactly — backward-compat regression anchor).
- `llm-inference-batch` (extends streaming; excludes TTFT; widens p99; tightens cost_req; halves Family C α).
- `generic-microservice` (fallback for non-LLM workloads; Family A only).

**Semver policy (`<id>@<semver>`):** MAJOR = breaking; MINOR = additive optional; PATCH = default tweaks. Profile file names carry only the id; historical versions live in git history. Version mismatches between ref and file throw (Q1 strict policy).

**Dynamic routing (post-REPLY-51b):** Post-REPLY-51b, profile library dynamically routes field values through compile:

- `sli_list` → Family A monitored signals; per-signal τ²/δ_min derivation per profile.
- `joint_vector.signals` → Family C/E joint-vector composition; compile emits per-profile-dimension covariance (scale-invariant `τ² = 0.03·trace(Σ)/p` preserves REPLY-43b consumer requirement at varying p).
- `joint_vector.include_in_family_c/e` → Family C/E enable gate; emit absent when disabled.
- `structural_detectors.enabled` → Family B enable gate; emit absent when disabled.
- `cell_dimensions.*` → cell-matrix dimensions; reconciled with baseline bundle metadata (three-case per REPLY-51a D4 + bundle-loader extension per R4-2).
- `bake_profiles` → per-signal bake overrides.
- `policy_defaults` → G1 policy thresholds (surface shipped REPLY-51b v1; runtime consumer for follow-on per R4-3 followup 2026-04-22).

**Ville-preservation:** per-family e-process validity preserved under profile-specific dimension; sum-bound α_total holds per-profile with enabled-family α allocation summing to profile-specified total. Disabled families contribute zero to the sum; Ville bound reduces correspondingly.

**Bundle-metadata reconciliation (R4-2):** `tools/bundle-loader.ts#loadBundleMetadata(path)` exposes a fast-path `BundleMetadata` read from `manifest.json` (no sample materialization). `tools/profile-loader.ts#reconcileCellDimensions(profileDims, bundleAvailable, mode)` implements the D4 three-case:

- **(a) profile enable + baseline supports** → emit the dimension.
- **(b) profile disable** → collapse regardless of support (profile is authoritative for opting out).
- **(c) profile enable + baseline lacks** → under `mode: 'warn'` (default), emit `CELL_DIM_BASELINE_DEFICIENCY` Warning + fall back to disabled; under `'error'`, throw a compile-time error; under `'silent'`, collapse without surfacing any warning.

Warnings emit through two always-on channels: stderr (operator visibility) + `CompiledConfig.compile_warnings[]` (programmatic inspection). Operators select the mode via `CompilerOptions.cell_dimension_deficiency_mode`.

**Out of scope:** Multi-parent inheritance (single-parent `extends` only). Override chains (single override layer only). v2 profiles (rag-pipeline, training-to-serving, data-plane). `workload_class` + `region` bundle-metadata support (manifest-level extensions; post-phase).

**Relationship to Addition #3 Metric Registry (M0):** Pre-M0, this library IS the Tier 1 + Tier 2 defaults surface. Post-M0, the profile library becomes a seed catalog for the registry (customers "start from `llm-inference-streaming@1.2.0`" as their seed); M0 takes over as the persistence + override surface. Addition #28's schema remains valid post-M0; its role narrows from "config source" to "seed catalog."

**Contract:** `CompiledConfig.profile_ref?: string` + `CompiledConfig.customer_override_ref?: string` + `CompiledConfig.policy_defaults?` + `CompiledConfig.family_a_signals?` + `CompiledConfig.family_c_signals?` + `CompiledConfig.compile_warnings?` (all optional for strict-additive backward-compat). Given both provenance pointers + git history of the `profiles/` directory, operators can reconstruct `effective_config` and re-compile byte-identically.

### L1 — Characterization

**Job:** Compute a rich, multi-scale snapshot per signal that downstream detectors consume without doing their own buffering.

**What changes from today's TrendBuffer:**
- Three window scales per signal, not one: short (3–5 ticks, for responsiveness), medium (10–15, for trend stories), long (whole-run, for stability baseline).
- Online empirical distribution summary per window (t-digest or P² sketch — supports quantile queries in O(1)).
- Autocorrelation summary (lags 1–k) so oscillation is first-class.
- BOCPD run-length posterior: probability current observation is in a new regime. This becomes a signal itself, not a detector.
- Theil-Sen slope replacing OLS slope. Slope normalization unchanged.
- `trendStrength` stays as a composite signal but derived from the richer inputs.

**Contract:** `SignalSnapshot { signal_id, windows: { short, medium, long }, distribution, acf, runLengthPosterior, slope, slopeNorm, ... }`. Typed. Versioned. The boundary every detector reads from.

### L2 — Detector portfolio

Five families, each with its own α allocation and its own statistical question. Each detector emits `{verdict: fire|indeterminate|clean, statistic, threshold, alpha_consumed, reason_code}`.

**Family A — Per-signal regression (Page-CUSUM + betting e-processes, co-shipped per Addition #17).** Tests "has the mean of this primary SLI shifted by a practically significant amount against baseline?" via two independent anytime-valid detectors per signal under Ville's inequality: Page-CUSUM with mixture prior (mixing-variance `τ²` calibrated from historical effect-size distributions; practical-significance threshold `δ_min`; optimal for abrupt unknown-onset mean shifts) and betting-based e-processes (GRAPA bet with ONS fallback; optimal for gradual drift and non-Gaussian residual regimes). Both fire independently; Family A fuses via any-fire union. Runs on p99, TTFT, eval_score, tool_success_rate, downstream_err, cost_per_request. Each signal owns a Bonferroni-corrected slice of the family's α budget, further split 50/50 across the two detectors. Replaces the current per-signal ratio detectors.

**Family B — Structural signatures.** Preserves the AI-inference-specific pattern detectors the current engine evolved: `kv_saturation` (pinned-flat ratio at capacity), `hbm_elevation`, `mfu_collapse`, `slowbleed`, `collective`, `capacity`, `gpu_eff`. Every numeric cutoff (`1.04` ratio, `0.005` slope norm, `4-of-9` vote count) is _derived_ at calibration time from the healthy-baseline distribution and the family's α allocation. Detector structure is hand-designed; detector numbers are compiled. Survives novel workloads better than today because the numbers track the baseline.

**Family C — Multivariate drift.** Two detectors: Hotelling T² on the low-dimensional core-signal subspace (~11 core metrics), sequential MMD on the full joint vector (~15+ signals including quality). T² is cheap, catches large covariance-structure shifts, threshold is a χ² quantile (pure lookup). MMD is nonparametric, catches higher-moment drift T² misses, threshold is the bootstrap-null quantile precomputed at calibration time. Runs are multi-tenant-aware per Addition #23: covariance is estimated per `(tenant_tier, hour_of_day, day_of_week)` cell when data supports it; when tier-level pooling under-samples (n < `max(5·p, 200)` MCD floor), the cell falls back to the across-tier aggregate covariance with `covariance_method: 'aggregate_fallback'` recorded in the audit. Retires the `adv_correlated_noise` structural gap and natively covers shadow-model bleed.

**Family D — Temporal structure.** Two detectors: spectral peak test on ACF (detects oscillation with period in the tick-scale frequency band — retires `adv_oscillating_cache_signal`), and the BOCPD run-length posterior surfaced from L1 as an explicit regime-change detector. The BOCPD threshold is derived from hazard-rate calibration; spectral threshold from null-distribution bootstrap.

**Family E — Novelty (conformal anomaly scoring).** Scores each tick's joint snapshot via Mahalanobis distance under the cell's robust covariance (Ledoit-Wolf / MCD / MRCD per Addition #18); compares against a parametric Gaussian null bootstrap computed at calibration time. Pre-#19 path: empirical conformal p-value, fire when `p < α_family`. Addition #19 path: bootstrap scores carry time-decay exponential weights, fire when the live score exceeds the `(1 − α)`-th weighted quantile — adapts the null distribution to recent-baseline conditions while preserving bootstrap statistical strength. Route (b) real-held-out-with-weights (Tibshirani/Foygel-Barber/Candès/Ramdas 2019 framework) is deferred per the per-cell sample-size floor at α = 1e-4. This is the unknown-unknowns channel — the only family that fires on failure modes no one thought to handle.

**α allocation across families.** Total budget `α_total` (e.g., 10⁻³ per deploy). Default split: 40% to A (per-signal SLIs carry the bulk of expected firings), 20% each to B and C, 10% each to D and E. Explicitly tunable per risk tier — critical deploys consume less budget per tick; low-risk deploys tolerate more. Post-#28, the allocation is sourced from the selected profile's `alpha_allocation.per_family` (§L0b) — `llm-inference-streaming@1.0.0` encodes the default split above; alternative workload profiles (e.g., `llm-inference-batch`) can reallocate.

**Scope of α_total claim (post-#22 FINAL, revised post-REPLY-52g).** The α-participating portfolio consists of two formal-property classes:

_Ville-bounded portion (anytime-valid e-processes):_ Family A's betting-e-process co-ship component, Family C's safe-Hotelling (when baseline calibration sufficient), Family C's e-MMD-betting (when baseline samples ≥ MMD_MIN_BASELINE_SAMPLES), Family D's spectral e-detector, Family E's weighted-conformal hedged-indicator. These are anytime-valid e-processes under Ville's inequality; their per-deploy-union false-alarm probability ≤ `α_ville = α_A_betting + α_C_safe + α_C_mmd_betting + α_D + α_E ≈ 5·10⁻⁴`, regardless of tick count. No union-bound correction over tick count.

_Classical-epoch-α portion (per-deploy Bonferroni-corrected):_ Family A's Page-CUSUM co-ship component (classical Page-1954 reset-at-zero CUSUM with Gaussian mixture-prior; resets at deploy canary boundary) and Family C's MMD-bootstrap-null fallback (when baseline samples < MMD_MIN_BASELINE_SAMPLES). These are classical per-tick tests with per-deploy false-alarm probability ≤ `α_classical ≈ 3·10⁻⁴` via excursion arguments over 100-tick canary with 6 signals under Bonferroni correction. Classical portion does NOT inherit time-uniform Ville bound; bound is valid only at canary boundaries.

**Run-level per-deploy false-alarm probability — DUAL-SURFACE FRAMING (post-REPLY-52gk):**

_Under iid bootstrap from per-cell empirical samples (operational H₀; canonical V2 honest-scope test)._ `α_total_operational = 8·10⁻⁴` formal claim; empirical FPR 30/131 ≈ 22.9% with detector-localized attribution per ARCHITECT-REPLY-52gi/52gk + Mac Claude 2 commit 8ff91f1:

| Detector | Healthy-window fires | Status |
|---|---|---|
| `family_A_betting_*` | 0/131 | Ville-clean ✓ |
| `family_A_page_cusum_*` | 0/131 | classical-clean ✓ |
| `family_A_legacy_classical` | 5/131 | classical-epoch; not Ville |
| `family_C` | 6/131 | elevated pending Q2.B calibration-coherence |
| `family_D_kv_cache` | 24/131 | broad miscalibration on kv_cache; pending Q2.B investigation |
| `family_E` | 1/131 | within α_E·1.5·131 envelope when methodology-amplification accounted |

iid bootstrap is internally consistent (each detector consumes from the same per-cell sample stream the bootstrap samples); empirical FPR elevation reflects detector calibration coherence gaps + per-cell Σ_C shrinkage choices, not formal-property gaps.

_Under parametric Gaussian H₀ with per-cell joint covariance (formal H₀; Cholesky-corrected post-Mac Claude 1 commit c702f5d)._ `α_total_formal_pending_Q2B = 6·10⁻⁴` narrowed claim; empirical FPR 79/131 = 60.3% under pre-Cholesky diagonal-covariance resampler (RESOLVED at c702f5d as resampler bug); 131/131 on Family C + E + Page-CUSUM + 27/131 on Family D under post-Cholesky parametric resampler (calibration-source incoherence artifact: 168/336 strict cells have aggregate-fallback μ_C disagreeing with per-cell μ_A by ~15%; no joint Gaussian H₀ simultaneously satisfies both detectors' calibration; pending Q2.B compile-time calibration-coherence enforcement). Family A betting empirically Ville-clean across all parametric methodology surfaces tested (5 surfaces, >196,000 cumulative trajectories, 0 fires). Parametric methodology becomes meaningful for the Ville claim post-Q2.B; until Q2.B lands, parametric H₀ surface is not usable as a formal-property test.

**Q2.B Phase-2 commitment** (architect-clever Q2.B.4 per ARCHITECT-REPLY-52gk):

- Single-source per-cell μ_vec across all detectors at compile time.
- Σ_C regularization via shrinkage to aggregate (Ledoit-Wolf 2004 style); μ stays per-cell always.
- Family D kv_cache investigation absorbed (kv_cache miscalibration may share root cause with calibration-source incoherence).
- Family D autocorrelation-aware parametric methodology (AR(1)/VAR(1)) deferred to same Phase-2 batch.
- Q2.A signal-class registry (logit-transform for bounded-probability) remains separate Phase-2 commitment.

Family B is non-α-consuming structural (R2 disposition; unchanged).

Post-Q2.B expected outcome: `α_total_formal` restored to `8·10⁻⁴` on parametric H₀ surface; `α_total_operational` holds at `8·10⁻⁴` on iid bootstrap surface; Family A + C + D + E Ville-bounded portion empirically clean across both methodology surfaces.

**Q2.B.5 σ²_A_raw coherence note** (post-Q2.B.4): Family A's raw-space σ²_A on overlapping signals (p99_latency, ttft, downstream_err, cost_req) is derived at compile time from Family C's per-cell Σ_C diagonal (`σ²_A_raw_i = μ_A_raw_i² · Σ_C[i,i]`). Under per-cell rank-sufficient calibration this equals raw per-cell sample variance exactly (Family A regression invariance preserved). Page-CUSUM consumes this raw-space σ² via boundedZ standardization.

**Q2.B.6 Σ-runtime-coherence resolution** (post-Q2.B.5): Q2.B.5 surfaced two coupled gaps preventing parametric H₀ closure on Family C — (a) `tools/build-report-card.js:lookupCell` was tier-blind and selected `tier=dominant, n=0` cells while runtime gate consumed `tier=aggregate` cells (168/168 cell-selection mismatch); (b) Q2.B.4's μ-coherence override sourced from `baseline_mean` which Q2.B.5 made log-transformed for cost_req + downstream_err, leaving `family_C.mean_vector` incoherent with raw-space live values. Q2.B.6c closes (a) by mirroring `engine/detectors/hotelling.ts:matchFamilyCCell` semantics + sourcing μ_C-only signals from `cell.family_C.mean_vector`; Q2.B.6c also retargets the override to `baseline_mean_raw`. Q2.B.6a drops convex shrinkage in favor of binary `shrinkage_alpha ∈ {0, 1}`: rank-sufficient (n ≥ p+1) cells use Σ_pc; rank-deficient use Σ_aggregate. Architecturally regressive on the shrinkage decision but correct on the coherence decision; trade-off accepted per ARCHITECT-REPLY-Q2-B-5-DISPOSITION §57-66 + §74. Empirical post-Q2.B.6: parametric Cholesky family_C fires drop 131→0; iid bootstrap family_C fires drop 131→6 (matches pre-Q2.B.4 baseline). Residual 21/131 ville-bounded fires under parametric (all `family_D_kv_cache`) defer to Q2.B.5b investigation per architect §98-107.

### Demo substrate architectural carve-out (Phase 2.4 close)

Demo storytelling fixtures (v4-fusion-novelty.json at compiler_version
0.2.0) and production validation evidence (v5-sequential-e-process at
0.3.0; Phase-3 substrate) serve different fixture roles with
intentionally different substrate alignment semantics.

Production validation substrate uses post-Phase-2 calibration (Q2.A
signal-class transforms + Q2.B.* coherence + Q2.B.6.1+.2+.3 sliding-
buffer recalibration) for empirical Ville-bound verification on
synthetic-v1 baseline. Demo storytelling substrate uses pre-Q2.A
calibration aligned with demo trajectory profile-tuning baselines;
post-Q2.A transforms (architecturally correct for production) amplify
pre-existing demo-baseline-vs-live mismatches that pre-Q2.A semantics
silently tolerated.

Phase-2 architectural improvements apply to production validation
substrate; demos retain v4 for narrative integrity. Demo refresh (re-
tuning demo baselines under post-Q2.A semantics) is Phase-3 commitment
follow-on scope. The carve-out is intentional: substrate-vs-fixture-
role alignment is the architectural principle; different fixtures
legitimately have different substrates.

### Q57 Path-3 closure note (post-Phase-2.4 carve-out)

Topic 57 demo baseline refresh closes the Phase-2.4 demo-substrate
carve-out commitment. v7-demos.json (compiler_version 0.3.0+; post-
Phase-2 substrate inheritance via Q2.A + Q2.B.* + integration-state-
audit + Q2.B.6.1+.2+.3 sliding-buffer recalibration) supersedes
v4-fusion-novelty.json as canonical demo storytelling substrate.

The applyCellPatch class-fix shipped at Q57 Path-3 (commit e635efb)
propagates per-demo cell_patch_override symmetrically across all
tier-segmented cells at target (h, d) AND aggregate_fallback structure.
This symmetric reach applies REGARDLESS of CFG_PATH version: both V4
and V7 substrates consume the patched aggregate_fallback at runtime.
Architecturally consistent with the carve-out narrative: demos serve
storytelling fixtures; production validation serves empirical-validation
evidence; both fixture roles inherit applyCellPatch class-fix uniformly.

v4-fusion-novelty.json retained as historical reference only;
v6-demos-archived as production-validation-substrate reference (no
canonical role post-Phase-2.4); v7-demos.json is canonical demo
storytelling substrate post-Q57.

### L3 — Verdict fusion

**Job:** Combine the five families' outputs into a single verdict with explicit semantics.

**Rules (first match wins):**
1. If any family fires with confidence above its threshold → `rollback`. Reason emits the highest-confidence firing detector with its provenance.
2. Else if any family returns `indeterminate` (statistic is between accept and reject bounds and budget remains) → `extend`. Effectively "come back next tick with more data."
3. Else if all families return `clean` and the current tick has consumed enough of the run's budget to support a decision → `proceed`.
4. Else → `baking` (internal, never surfaced).

**Early-run guards.** Families have per-family minimum-ticks before they're eligible to fire. Warmup and cold-start patterns handled here, not embedded in each detector. The `FP_CLASSIFIER_CONFIG.capacityEarlyRollbackMinTick = 8` pattern from today's engine generalizes to a per-family table.

**Budget accounting.** Each firing consumes from the family's α allocation. If a family burns through its budget early in the run, subsequent firings from that family are suppressed (escalate confidence requirement rather than refuse entirely). The audit trail records budget consumption per tick.

### L3c — Advisory layer (Addition #27, `advisory/agent/`)

**Job:** Propose recovery actions post-verdict. Never decide; never auto-execute.

**Positioning (ARCHITECT-REPLY-53 R4 — FINAL text).**

> `advisory/agent/` is a POST-DECISION advisory layer. The gate (`engine/`) decides rollback vs proceed via statistical e-processes with Ville-bounded false-alarm. The advisor (`advisory/`) proposes recovery actions referencing the gate's decision + playbook + audit provenance. The advisor never overrides the gate's decision; never auto-executes in v1; safety rail (e) binds FM-input playbook-filter to deploy reversibility deterministically. Advisor is a separable system; operators can disable (default) or connect to any FM vendor (platform-native / Claude-Bedrock / stub).

**Directory relocation (REPLY-53 R4 D4b).** The advisory module lives at `advisory/agent/` at repo root — parallel to `engine/`, `profiles/`, `playbooks/`, `regression-profiles/`, `runs/` — relocated out of the `engine/` subtree as part of this addition. The directory name signals semantic separation at 30-second first-impression speed for code-reading reviewers; the `engine/` subtree now strictly contains statistical-decision code, while `advisory/` contains the FM-backed proposer + playbook loader + safety rails. `CompilerOptions.agent` stays in `engine/types.ts` (cross-module configuration, not agent-internal).

**Dormancy.** Addition #27 remains dormant per the activation gate: `CompilerOptions.agent.enabled = false` by default, and the orchestrator post-VerdictGroup-close hook that would invoke `AgentProposer.propose()` is not wired in v1. Operators opting in must configure an FM vendor (`vendor_native` / `claude_bedrock` / `stub`); `auto_execute_enabled: false` is schema-enforced in v1 — narrow-auto gate is deferred.

### L4 — Audit + observability

**Job:** Make every verdict reproducible, comparable, and explainable.

- Extends today's audit log (WS2 Phase 1 is the ancestor) with per-family verdicts, per-detector statistics, and α-consumption per tick. Schema version bump required.
- Shadow comparison is a first-class view: what did the current-engine verdict look like vs the new-system verdict? Surfaced in the demo dashboard.
- The model-lifecycle tooling integration: every detector configuration (calibration compiler output) is a versioned artifact. Every verdict logs its config version. Rollbacks traceable to the exact compiled threshold set.
- A platform governance layer controls who sees what — tenant-level and team-level ACLs on verdicts and provenance.

### L5 — Learning loop

**Job:** Close the loop from production outcomes back to calibration.

**Ground-truth sources:**
- Audit log verdicts correlated with downstream incident reports.
- Manual rollback events (someone overrode the system).
- Customer impact signals (support ticket rate spikes, contract-SLO breaches).
- Oncall feedback (explicit "this was a false alarm" / "this was a real regression" tags).

**Feedback pathways:**
- CUPAC predictors retrain periodically on expanded healthy history.
- Conformal baseline model (Family E) refits on expanded healthy trajectories.
- α allocation rebalances across families based on observed firing-value distributions.
- Baseline windows for the calibration compiler update.

**What this loop is NOT:** It is not a tuning loop that chases a TP target on a synthetic suite. There is no ADV_TP_THRESHOLD here. The system's quality is measured by outcome metrics — prevented-incident rate, customer-impact correlation with verdicts, oncall-override rate — not by a fixed scoreboard.

---

## The calibration compiler

The keystone component. Takes three inputs, emits one output.

**Inputs:**
- `baseline_window`: a slice of historical healthy traffic (rolling, typically 2–4 weeks).
- `alpha_budget`: total FP rate per deploy, allocated across detector families.
- `policy_profile`: per-risk-tier knobs (blast radius, time window restrictions, tenant sensitivity).

**Output: a single compiled detector configuration file** — effectively a typed bundle containing:
- Per-signal covariate predictors (CUPAC regression coefficients).
- Per-family α allocation.
- Family A: per-signal mSPRT mixing prior `τ²`, practical-significance threshold `δ_min`.
- Family B: per-detector structural cutoffs (the numeric trivia that today is hand-tuned in `health.ts`).
- Family C: mean vector and covariance matrix for Hotelling T²; MMD null-distribution quantile.
- Family D: spectral null quantile; BOCPD hazard rate.
- Family E: trained baseline model weights, calibration-set scores, conformal quantile.

**Invocation model:** runs automatically on baseline refresh (triggered by drift detection on the baseline itself), or on-demand when a policy change ships. Its output is a versioned artifact — every production deploy's verdict traces back to an exact compiler output version.

**This is the thing that does not exist today in any open or published deployment-decisioning system.** Kayenta does per-deploy statistics; Watchdog does online ML scoring; Flagger does per-release threshold checks. Nobody treats the detector configuration itself as a compiled artifact with a build step. Moving statistics to a compiler is what makes the runtime path cheap, the system's behavior reproducible, and the detector portfolio composable.

---

## Architecture additions — PM-critique integration (W1 batch)

Three sections added 2026-04-18 in response to the 2026-04-16 external PM review (full triage in the PM-critique response (deleted)). These modify or extend the layers already specified above — they are not replacements. Remaining PM-critique additions (#1 DID / reference cells, #3 metric registry, #4 per-signal bake profile, #5 reversibility classification, #6 incident-state input, #7 propensity matching) land in subsequent W2–W3 batches per the architect deliverable calendar in `coordination/ARCHITECT-REPLY-03.md` (internal coordination doc, not included in this public repo).

### Addition #2 — Segmented baselines (baseline cell matrix)

**Modifies:** the calibration compiler's inputs and outputs; L1's baseline lookup pattern.

**Problem.** The `baseline_window` input to the calibration compiler is described above as "a slice of historical healthy traffic (rolling, typically 2–4 weeks)" — effectively a single aggregate baseline. That framing is naive. Production workloads have strong diurnal, weekly, and sometimes seasonal structure. A 2am-Sunday baseline does not represent 10am-Tuesday traffic; a canary running on Tuesday 10am compared against an aggregate-2-week baseline will either false-alarm on the regime difference or have thresholds too loose to catch real regressions.

**Fix.** The compiler emits not a single baseline but a **baseline cell matrix** — a structured collection of per-cell baselines indexed by the context dimensions that matter for the workload. Detector thresholds at run time look up the cell matching the canary's current context.

**Cell dimensions (in priority order).** Compiler supports nested-dimension cells; each service's compiled config declares which dimensions it uses.

| Dimension | Cardinality | Default enabled? | Notes |
|---|---|---|---|
| Hour of day | 24 | Yes (W2) | First dimension added; covers diurnal variation in traffic, batch-size distributions, cache hit rates |
| Day of week | 7 | Yes (W3) | Combines with hour-of-day for a 168-cell 2-D matrix |
| Workload class | ~3–10 (service-specific) | Service-declared | E.g. short-prompt vs long-prompt for inference; OLTP vs batch for data plane |
| Tenant slice | 10s to 1000s | Service-declared | Used only where cardinality supports reliable estimation |
| Region | ~5–50 | Optional | Enabled for services with per-region deploy patterns |

**Sparsity and hierarchical pooling.** Cell sparsity is the central concern. A 500-run × 32-tick baseline has 16,000 samples total; a 2-D 168-cell matrix puts ~95 samples per cell — thin for covariance estimation. A 4-D (hour × day × workload × tenant) matrix with 168 × 5 × 100 = 84,000 cells is far sparser than the available data supports. The compiler handles this by **hierarchical pooling**:

1. **Full-resolution cells first.** For any cell with ≥ `min_samples_strict` (default 60), use the cell's own empirical statistics.
2. **Pool adjacent cells when sparse.** For cells below `min_samples_strict` but ≥ `min_samples_pooled` (default 20), pool with adjacent cells along the least-important dimension (default: tenant → workload → day → hour).
3. **Fall back to aggregate baseline.** For cells below `min_samples_pooled`, the aggregate (all-cells-combined) baseline is used, with a `cell_confidence: low` flag emitted so downstream detectors can widen thresholds conservatively.
4. **Refuse cells with no samples.** A cell with zero samples is emitted as `cell_confidence: none`; Family A and Family C are suppressed for that cell context; only Family B with its compiled structural thresholds remains eligible.

**Compiler output shape change.** `CompiledConfig` gains a `baseline_cells` field:

```ts
interface CompiledConfig {
  // ... existing fields ...
  baseline_cells: {
    dimensions: Array<'hour_of_day' | 'day_of_week' | 'workload_class' | 'tenant_slice' | 'region'>
    cells: Array<{
      key: Record<string, string | number>      // e.g. {hour_of_day: 14, day_of_week: 2}
      n_samples: number
      confidence: 'strict' | 'pooled' | 'aggregate' | 'none'
      pooled_from?: Array<Record<string, string | number>>  // which adjacent cells if pooled
      family_A: { per_signal_tau2: Record<string, number>, per_signal_delta_min: Record<string, number> }
      family_B: { cutoffs: Record<string, number>, raw_empirical: Record<string, number> }
      family_C: { mean: number[], covariance: number[][], mmd_null_quantile: number }
      // Families D and E cell-shape TBD in W3
    }>
    aggregate_fallback: {  // used when cell_confidence = aggregate or none
      family_A: { ... }, family_B: { ... }, family_C: { ... }
    }
  }
}
```

**Runtime detector consumption.** Detectors at tick-time receive the `DeployContext` (from O0 — see addition #9) and look up the matching cell. A helper on the compiled config: `config.cellFor(context) → CellBaseline | null`. Detectors that receive `null` back (no cell match, no aggregate fallback eligible) return `suppressed` rather than evaluating.

**Covariance in sparse cells.** Related Week 3 concern flagged by TPM: at 2-D granularity the per-cell sample count (~95 samples for the demo baseline) is marginal for stable covariance estimation on the 11-signal vector. Mitigation: Ledoit-Wolf shrinkage toward the aggregate covariance is applied automatically when `n_samples_in_cell / n_signals² < 2`. The shrinkage intensity is recorded in the compiled config so verdicts can reference it in their provenance.

**Sequencing.** W2 ships 1-D (hour-of-day) cells in the compiler; W3 extends to 2-D (hour × day-of-week). Addition #23 (2026-04-20) ships the 3-D `tenant_tier` extension as the multi-tenancy-closure surface for PM #4 — full implementation, not docs-only. Workload-class and region dimensions remain architecture-complete-in-docs for the project, implementation in follow-on. This matches the schedule compensation in `coordination/TPM-REPLY-03.md` (internal coordination doc, not included in this public repo) after Week 1 shipped before this spec landed.

### Addition #8 — Metric schema continuity check

**Modifies:** L0. New responsibility alongside existing ingestion, CUPAC adjustment, and robust stats.

**Problem.** A deploy that changes the telemetry it's being evaluated by breaks the gate's pre/post comparison. Examples: a deploy that adds a new error code (changes the `downstream_err` definition), switches latency measurement from client-perceived to server-perceived (discontinuity in `p99_latency`), changes trace granularity (alters distribution of per-span durations). A gate that blindly compares canary metrics against pre-deploy baseline in these cases is comparing apples to oranges and its verdict is meaningless — possibly actively wrong.

**Fix.** L0 computes a **schema hash** per signal at ingestion and monitors it across the deploy boundary. On deploy, the pre-deploy schema hash is recorded; post-deploy ticks compare the observed schema hash and emit a `schema_continuity` flag per signal per tick.

**Schema hash contents.** The hash is over metadata, not values. Inputs:
- Signal name (canonical)
- Unit (ms, tokens/sec, fraction, etc.)
- Semantic type (counter / gauge / ratio / latency quantile / categorical rate)
- Granularity (per-request, per-second, per-minute, per-tick)
- Label keys present on the metric (not values — just the set of keys)
- For latency quantiles: the quantile list (`[p50, p95, p99]`)
- For histograms: the bucket boundary set
- For traces: span name set (where available) and attribute-key set

**Consequences at L2.** Per-signal schema change triggers per-signal detector handling:

| Schema change type | L0 flag | Family A (per-signal regression) | Family B (structural) | Family C (multivariate) | Family E (novelty) |
|---|---|---|---|---|---|
| No change | `continuous` | Runs normally | Runs normally | Runs normally | Runs normally |
| Benign extension (new label key added; new histogram bucket at edge; new trace attribute) | `extended` | Runs normally | Runs normally | Runs with new dimension optional | Runs normally |
| Breaking change (label key removed; unit changed; quantile list changed; granularity changed) | `breaking` | **Suppressed** for affected signal until re-baseline | Runs on unaffected signals only | **Suppressed** (covariance invalid) | **Suppressed** (baseline model invalid) |
| Observability-stack deploy (telemetry pipeline itself) | `observability_stack` | **All families suppressed** | **Suppressed** | **Suppressed** | **Suppressed** |

**Re-baseline trigger.** When any signal emits `breaking`, the compiler is triggered to re-compile after sufficient post-deploy traffic accumulates to establish a new baseline for that signal. Default: `min_rebaseline_samples = 500` for the affected signal's cell matrix. During the re-baseline window, affected detectors remain suppressed; audit records carry the `rebaseline_pending` flag so oncall can see why the gate is quiet on that signal.

**Observability-stack deploys.** Handled as a special case because they can affect all signals simultaneously. The deploy manifest's `change_type` field (`infrastructure` with a subtype `observability`) is the trigger. Gate refuses to evaluate against its own pre-deploy baseline; verdict emitted is `suppressed_observability_deploy` with a `requires_fresh_baseline` flag. The audit trail records this explicitly so it's distinguishable from "gate was broken and had no data."

**Contract surface change.** L0's emitted stream gains `schema_hash` and `schema_continuity` fields:

```ts
interface SignalStream {
  // ... existing fields: signal_id, ts, value_raw, value_adjusted, outlier_flag, covariate_freshness ...
  schema_hash: string            // stable hash of the signal's metadata
  schema_continuity: 'continuous' | 'extended' | 'breaking' | 'observability_stack'
  schema_baseline_ref?: string   // which baseline version this sample should be compared against
}
```

**Interaction with addition #2.** Schema continuity is checked before baseline-cell lookup. A breaking schema change invalidates the pre-deploy baseline cell matrix for the affected signal; the new baseline cells are recompiled for the new schema and used going forward. Cells computed under the old schema are preserved in the compiled config's history but not used for new verdicts.

### Addition #9 — Orchestration adapter layer (O0)

**Adds:** a new architectural layer (O0), sibling to L0. Emits verdicts to external orchestrators; ingests deploy context from them. Full spec in `ORCHESTRATION-ADAPTERS.md`; this section is the integrating summary.

**Principle.** The engine stays orchestrator-agnostic. Adapters at the edge translate `FusedVerdict` (from L3) to whatever external orchestrator expects — Argo Rollouts, Flagger, Spinnaker, internal tooling. Symmetric to L0's role for telemetry-source diversity (Prometheus, Datadog, OpenTelemetry).

**Two jobs.**

1. **Emit verdicts outward.** Take `FusedVerdict` from L3; translate to the orchestrator's expected signal shape (e.g., Argo Rollouts' `Successful` / `Failed` / `Inconclusive` analysis result); handle retry/backoff; emit provenance to L4 audit.
2. **Ingest context inward.** Read orchestrator state (current canary weight, current step, rollout strategy, reversibility annotation, deploy author) and populate the `DeployContext` struct that G1 policy gate reads as part of its `policyContext`.

**Verdict-semantic mapping (Argo Rollouts, canonical).**

```
our verdict        → Argo analysis status
───────────────────────────────────────────
proceed            → Successful    (advance to next canary step)
rollback           → Failed        (trigger Rollout abort / rollback)
extend             → Inconclusive  (Argo retries next interval)
```

The `extend → Inconclusive` mapping matches Argo Rollouts' built-in retry-after-interval behavior exactly; no orchestrator-side changes required.

**Integration levels (increasing K8s integration depth).** Level 1 (web metric provider) is the project target. Levels 2–4 are documented in `ORCHESTRATION-ADAPTERS.md` and deferred. Level 1 requires zero K8s-specific code — just an HTTP service our engine exposes; Argo's `AnalysisTemplate` hits it via the built-in `web` provider.

**Bidirectional context flow.** G1's `policyContext` gains named inputs from the orchestrator:

- `current_canary_weight` — maps to our existing `traffic_pct` covariate; closes PM critique Q19 (variable canary fraction).
- `rollout_strategy` — different gate semantics per strategy. Canary: fire on regression signal. Blue-green: evaluate pre-traffic-shift; verdict is promote-or-abort. Rolling: advisory only.
- `current_step` / `total_steps` — feeds bake-time eligibility logic.
- `pause_state` — if the Rollout is explicitly paused by a human, the gate pauses its own evaluation.
- `reversibility` — from future addition #5 (reversibility classification in G0). Forward-only deploys get `pause_and_alarm` semantics instead of `rollback`.

**Annotation conventions.** Platform team (for follow-on at production scale) defines deploy-metadata annotations that the adapter reads. Full table in `ORCHESTRATION-ADAPTERS.md`; key invariant: missing annotations default to conservative values (highest risk, forward-only, requires human approval), with a warning emitted to the audit log. Never silently defaults to permissive.

---

## Architecture additions — PM-critique integration (W2 batch)

Two sections added 2026-04-18 (W2-batch, brought forward from end-of-W2 calendar). Remaining PM-critique additions (#1 DID / reference cells, #3 metric registry, #6 incident-state input, #7 propensity matching) land in the W3 batch at end-of-W3 per the architect deliverable calendar in `coordination/ARCHITECT-REPLY-09.md` (internal coordination doc, not included in this public repo).

### Addition #4 — Per-signal bake profile

**Modifies:** `CompiledConfig` (new per-signal profile block); L2 detector eligibility gating.

**Problem.** The current engine applies a uniform 32-tick bake window to every signal. This is wrong on two directions. (a) For some signals, 32 ticks is far too short — a cost-per-request regression of 15% often doesn't surface within 32 × 5s = 160 seconds; it takes hours or days of aggregated billing data. Evaluating cost on the same window as latency means cost regressions slip past the gate entirely. (b) For other signals, 32 ticks is too long — a severe p99 latency regression is visible within 3–5 ticks, so forcing all signals to wait the full window introduces unnecessary detection lag and costs engineer response time.

PM critique B9 framed this crisply: different metrics have different time-to-signal, and a deploy-gate that can't cover slow-signal regressions should explicitly say so rather than pretend uniform bake windows work.

**Fix.** Each signal gets a **bake profile** with three per-signal parameters, compiled from the baseline's empirical signal-shape and SRE-declared policy:

```ts
interface BakeProfile {
  signal_id: string
  min_ticks_before_eligible: number   // no fire before this tick
  min_observation_window: number       // statistic must include at least this many post-deploy samples
  max_deploy_window_days: number       // how long post-deploy to continue comparing to baseline
}
```

Compiler emits the full profile per-signal as part of `CompiledConfig`. Detectors at runtime read the profile at each tick; firing is gated on all three.

**Default profiles (starting points; SRE policy overrides).** Calibrated from the baseline's empirical time-to-stability per signal.

| Signal | min_ticks_before_eligible | min_observation_window | max_deploy_window_days |
|---|---|---|---|
| `p99_latency` | 3 | 3 | 1 (24 hours) |
| `ttft` | 3 | 3 | 1 |
| `downstream_err` | 4 | 4 | 1 |
| `tool_success_rate` | 6 | 6 | 2 |
| `eval_score` | 6 | 6 | 3 |
| `refusal_rate` | 6 | 6 | 3 |
| `cost_per_request` | 8 | 8 | 7 (cost regressions accumulate slowly) |
| `tokens_per_request` | 8 | 8 | 3 |
| `mfu`, `hbm_spill`, `kv_cache` (infra signals) | 4 | 4 | 1 |
| `collective_ops` | 4 | 4 | 1 |

**`max_deploy_window_days` semantics.** A deploy-gate that compares canary to baseline for 7 days is not the same thing as the tick-level gate running for 7 days. Past `min_deploy_window_days` (the short-window fast-fire gate), the evaluation transitions to a post-deploy regression watcher — lower cadence (hourly instead of per-tick), looser thresholds, different fusion semantics (advisory only, not rollback-triggering). This post-deploy regression watcher is out of current scope but the profile's `max_deploy_window_days` field is the input it will eventually consume.

**Interaction with other families.** Family B (structural signatures) retain their own warmup windows (from `WARMUP_CONFIG` in `engine/core.ts`); bake profile applies to Families A, C, D, E only. Family B's warmup is workload-invariant (based on change-type and risk tier); the bake profile is signal-variant (based on the signal's time-to-stability).

**Interaction with addition #2 (segmented baselines).** Bake profile is signal-level, not cell-level — all hour-of-day cells share the same `min_ticks_before_eligible` for p99_latency, for example. If a service has diurnal time-to-stability variation (e.g., cache-cold at 2am takes longer to settle than at 10am), that's encoded in the per-cell `baseline_sigma_squared`, not the bake profile. This keeps the profile tractable.

**Runtime contract.** Detector's `eligible_to_fire(tick, deploy_context)` check reads: `tick >= profile.min_ticks_before_eligible AND n_post_deploy_samples >= profile.min_observation_window AND deploy_age_days <= profile.max_deploy_window_days`. Failure of any clause emits `suppressed_bake_profile` in the audit record.

**Compiler responsibility.** The compiler derives per-signal `min_ticks_before_eligible` from baseline autocorrelation — the smallest k such that the signal's lag-k autocorrelation drops below 0.3. `min_observation_window` derives similarly but with a stricter threshold (lag-k autocorrelation < 0.1). `max_deploy_window_days` comes from SRE policy (operator-configured; baseline doesn't derive it).

### Addition #5 — Deploy reversibility classification (extends G0)

**Modifies:** G0 blast-radius gate; downstream verdict interpretation in the orchestration adapter (O0 from addition #9).

**Problem.** Some deploys are mechanically rollbackable; others are not. Schema migrations, data format changes, state machine transitions, irreversible auth/RBAC changes, and custom model weight-layout changes cannot be cleanly reverted — rolling them back either breaks dependents, corrupts state, or requires compensating deploys. A gate that issues a `rollback` verdict on a forward-only deploy has made the problem worse: automated rollback can't happen cleanly, and the gate has now turned one broken deploy into two.

PM critique C10: "a gate that says 'rollback!' on a forward-only deploy has made things worse."

**Fix.** G0 classifies each deploy by **reversibility**, a three-value tag that determines how downstream consumers (orchestration adapter, runbook automation) interpret a `rollback` verdict from L3.

```ts
type Reversibility = 'reversible' | 'forward_only' | 'conditional'
```

- **`reversible`** — deploy can be cleanly rolled back by reverting the artifact or config. Examples: pure code changes, container image rotations, config changes, feature flag flips, model-weight rotations where the prior checkpoint is still valid. `rollback` verdict → automated rollback (orchestrator-specific: Argo `Failed` status, Spinnaker abort, etc.).
- **`forward_only`** — deploy cannot be cleanly rolled back. Rolling back would either break dependents, corrupt state, or require a compensating deploy. Examples: schema migrations, data-format changes (if non-backward-compatible), irreversible auth/RBAC state transitions, breaking API changes when downstream already consumes the new shape. `rollback` verdict → `pause_and_alarm` instead of automated rollback. Triggers a runbook/oncall escalation, not an automated action.
- **`conditional`** — rollback may or may not be safe; operator judgment required. Examples: infrastructure migrations (e.g., GPU hardware cohort swap) where mechanical rollback is possible but may have contractual/capacity implications. `rollback` verdict → human-in-the-loop pause with explicit operator confirmation required before any action.

**Tag source.** The reversibility tag comes from the deploy manifest — typically set by the platform team on a per-service basis or per-deploy via CI pipeline metadata. The orchestration adapter (O0) reads the tag from orchestrator-specific annotations:

- Argo Rollouts: `deploysignal.io/reversibility` annotation on the `Rollout` resource.
- Spinnaker: pipeline parameter.
- Internal tooling: platform-specific.

**Default when missing.** If no reversibility tag is set, G0 applies the conservative default: `forward_only`. This matches the platform-wide invariant from addition #9 ("missing annotations default to conservative values"). Surfaces a warning in the audit log. Never silently defaults to `reversible` — silent permissive defaults are how automated-rollback-on-forward-only-deploy incidents happen.

**Per-deploy-class defaults (policy table for production deployment the target platform, extracted from the platform-mapping doc (deleted)).** When the platform team sets annotations by deploy class rather than per-deploy, these are starting defaults:

| Change pattern | Default `reversibility` |
|---|---|
| Model weight rotation (fine-tunes, base model swaps) | `reversible` |
| Serving-engine version updates (vLLM, TRT-LLM) | `reversible` |
| Batching / scheduling policy changes | `reversible` |
| Config / flag changes | `reversible` |
| Quota / rate-limit changes | `reversible` |
| Custom model weight-layout changes | `forward_only` |
| Telemetry schema changes | `conditional` |
| Auth / RBAC changes | `forward_only` |
| GPU cohort migrations | `conditional` |
| Schema migrations (data plane) | `forward_only` |

**Verdict-semantic table (how downstream interprets `rollback` per reversibility tag).**

```
                    | reversible          | forward_only        | conditional
────────────────────┼─────────────────────┼─────────────────────┼────────────────────
L3 verdict=rollback | orchestrator-native | pause_and_alarm     | human_confirm
                    | rollback action     | (no auto action)    | (pause + runbook)
L3 verdict=extend   | orchestrator-native | orchestrator-native | orchestrator-native
                    | extend (retry)      | extend              | extend
L3 verdict=proceed  | advance             | advance             | advance
```

**Audit provenance.** Every verdict emits the reversibility tag it was evaluated under. If the tag was the conservative default (missing annotation), the audit record includes `reversibility_source: default_fallback` with the warning flag, so oncall reviews can distinguish "platform correctly classified as forward-only" from "annotation missing; gate defaulted to forward-only."

**Interaction with addition #9 (orchestration adapter).** O0 is the layer that actually maps `rollback` verdicts to orchestrator actions. The reversibility tag is consumed there, not inside the engine. This keeps the engine orchestrator-agnostic (the engine's job is to emit verdicts; the consequences of a verdict depend on the orchestrator and the deploy metadata).

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-32). G0 classifier (`engine/g0/reversibility-classifier.ts`) runs once per deploy at deploy start against a `ReversibilityAnnotationSource` (runway ships three: `NoReversibilitySource` / `InlineReversibilitySource` / `ScenarioReversibilitySource`). O0 translator (`engine/o0/reversibility-translator.ts`) is a pure function mapping verdict × reversibility to the concrete orchestrator action (`rollback` / `pause_and_alarm` / `human_confirmation_required` / passthrough for non-rollback verdicts). Audit records carry `reversibility` + `reversibility_source` on every v2 record — constant across all ticks of a deploy. Default-fallback is `'forward_only'` (conservative; missing annotations must NOT auto-rollback). L3 continues to emit `rollback` regardless of reversibility; the translator handles action derivation post-verdict so L3 semantics stay orthogonal to downstream action selection. Real-orchestrator annotation sources (Argo Rollouts resource annotation reader, Spinnaker pipeline parameter reader, the model-lifecycle tooling tag reader) remain for follow-on.

---

## Architecture additions — PM-critique integration (W3 batch, docs-only)

Four sections added 2026-04-18 completing the PM-critique integration additions. All four are **docs-only in the project**; implementation is deferred. Rationale per the PM-critique response (deleted) Part J: these additions require either real tenant data (DID matching, propensity-score matching), SRE-team configuration surface that doesn't exist current-cycle (metric registry), or platform integration with external systems (incident management). Architecturally specifying them is load-bearing for the pitch; implementing them against synthetic data would produce stubs that don't validate the architectural claims.

The pitch should reference these additions as "here's the architectural spec; here's where implementation starts in the first 90 days at production scale." Calibrated confidence — own what's shipped, own what's specified, own what's not-yet-built.

### Addition #1 — Difference-in-differences (DID) reference cells

**Modifies:** L0 outputs; calibration compiler's cell matrix emission; Family A and Family C detector inputs.

**Problem.** The canary-vs-baseline comparison today is implicitly a before-and-after test: "did the canary's metrics deviate from the canary's baseline after deploy?" This confounds deploy-induced regressions with coincident environmental changes — a noisy neighbor, an upstream dependency blip, a customer-mix shift. CUPAC (on L0) absorbs predictable covariate differences, but it can't distinguish "the canary got worse because of this deploy" from "the whole platform got worse and the canary is just a detection surface." PM critique B4 and F17 both converge on this.

**Fix.** Classical difference-in-differences methodology. For each canary deploy, identify a **matched reference cell** — the slice of production that did NOT receive the treatment (same tenant class, same time-of-day, same workload class, same region, but a non-canary deployment or the stable-version pod slice). Detectors compute the DID estimator: `(canary_post − canary_pre) − (reference_post − reference_pre)` rather than `canary_post − canary_pre` directly. Environmental effects present in both slices cancel; deploy-attributable signal remains.

**Contract surface.** O0's `DeployContext` (from addition #9) gains a `reference_cell_ref` field populated at deploy start. The compiled config's cell matrix (from addition #2) already has the right shape — per-(tenant, hour, day, workload) cells — so the reference cell is a lookup against the same matrix the canary uses for its baseline. The lookup key is the canary's deployment metadata minus the treatment flag.

**When no match exists.** If no comparable reference slice exists (canary's tenant/workload combination has no non-canary baseline cell with sufficient samples), the gate reports `structural_mismatch` — Families A and C suppress with `suppression_reason: "structural_mismatch"`; Family B (which doesn't depend on baselines) remains eligible. See addition #7 for the companion propensity-score matching used when structural mismatch threatens to always fire.

**Interaction with existing architecture.** DID is a statistical framing applied at the detector level; no engine-wide topology change. The compiler already emits per-cell means and covariances; the detectors already lookup the cell that matches the canary's context. Adding the reference-cell lookup is an additional read against the same cell matrix — compile-time-cheap, runtime-cheap. The honest-broker caveat: the framing only works when there _is_ a stable non-canary slice to compare against, which assumes a fractional rollout shape (canary = 5%, baseline = 95%). For 100%-immediately deploys, DID degrades to before-and-after; the gate's verdict quality likewise degrades. The deploy-class policy table should flag non-canary rollouts as `verdict_quality_degraded: true` so the pitch/oncall doesn't misrepresent what the gate is evaluating.

**Scope.** Docs-only. Implementation requires real tenant data for reference-cell identification quality (the synthetic baseline has uniform tenants, so DID on synthetic degenerates to before-and-after). Ships first as shadow-mode-only in the first 30-60 days for follow-on; gate promotes to enforcement only after at least one documented incident where DID catches an environmental-effect false alarm the before-and-after version would have fired on.

### Addition #3 — Metric registry layer

**Adds:** a new layer above L0 — call it "Metric Registry" or M0. Sibling of L0, consulted by the calibration compiler and at runtime by the detector eligibility logic.

**Problem.** Architecture above assumes metrics are given — someone has already decided that `p99_latency, ttft, eval_score, tool_success_rate, downstream_err, cost_req` are the six primary SLIs for Family A. PM critique B7 correctly flags that this is the actual hard problem: "you can have perfect math on the wrong metrics and catch nothing." Kayenta's hardest lesson documented publicly is that metric selection, not statistical test selection, is where operators spend the most time.

**Fix.** A per-service metric registry with three tiers:

- **Tier 1 — SRE-declared SLIs.** The service team owns this list. Team declares what customer-observable quality looks like for their service (per the Google SRE Workbook's SLO framework). Registry emits these as Family A's monitored signal set.
- **Tier 2 — Auto-included structural signals.** The detector library knows what it needs (Family B `kv_saturation` needs `kv_cache`; Family B `mfu_collapse` needs `mfu`). The registry auto-includes these when the corresponding detector is enabled. Service teams don't have to think about them; they're configuration-in-code.
- **Tier 3 — Predictive-power-ranked candidates (post-L5).** Once the learning loop has outcome labels (incident correlations), the registry computes per-metric predictive power against real incidents. Low-signal metrics get deprioritized in α allocation; high-signal candidate metrics outside Tier 1 get surfaced to the service team for promotion to Tier 1.

**Contract surface.** `MetricRegistry` is a read-only lookup during calibration:

```ts
interface MetricRegistry {
  slisForService(service_id: string): Array<MetricSpec>             // Tier 1
  structuralSignalsForDetectors(detector_ids: string[]): Array<MetricSpec>  // Tier 2
  predictiveRankings(service_id: string): Array<{ metric_id: string, rank_score: number }>  // Tier 3 (post-L5)
  accessControl(actor_id: string, service_id: string): 'read' | 'write' | 'none'  // platform governance-layer ACL
}

interface MetricSpec {
  metric_id: string
  telemetry_source: string          // 'prometheus' | 'trace' | 'billing' | 'custom'
  semantic_type: 'counter' | 'gauge' | 'ratio' | 'latency_quantile' | 'categorical_rate'
  slo_target?: number               // if Tier 1 and team declared an SLO
  delta_min?: number                // practical-significance override
}
```

**Governance.** Registry entries are versioned; promotion from Tier 3 → Tier 1 is a PR-style change requiring service-team approval. The platform governance layer (at production scale) controls who can read/write the registry. Audit log captures registry version alongside `compiled_config_version` so verdicts are traceable to both.

**Pre-L5 behavior.** The Tier 3 ranking stays empty; registry is operator-configured (Tier 1 + Tier 2 only). This is sufficient for the first 6 months for follow-on — metric selection is handled by service teams with the detector library's structural auto-additions, same pattern operators use today, just formalized and governed.

**Pre-M0 bootstrap via Addition #28 (profile library).** Addition #28's reference workload profile library (§L0b) provides the Tier 1 + Tier 2 surface before M0 lands: service teams pick a profile (`llm-inference-streaming`, `llm-inference-batch`, `generic-microservice`); the profile populates `CompiledConfig` inputs that M0 would otherwise emit. Post-M0, the profile library becomes a seed catalog for registry content — a new service registers via M0 with "start from `llm-inference-streaming@1.2.0`" as the seed; M0 persists + governs overrides from there. Addition #28's schema remains valid post-M0; its role narrows to "starting-point catalog."

**Scope.** Docs-only. Currently, the project has a hard-coded registry equivalent in `engine/types.ts` (the `Metrics` interface enumerates signals). Follow-on: a genuine registry with governance + versioning + cross-service reuse.

### Addition #6 — Incident-state input to G1 policy

**Modifies:** G1 policy gate (adds incident-management state as a named input to `policyContext`).

**Problem.** The gate today has no awareness of production incidents. A gate that happily promotes a deploy during an active SEV-1 makes the incident worse — adds a new variable to the postmortem, potentially cascades the root cause, occupies oncall's attention with a rollback when they're already overloaded. PM critique D13 is clear: incident-aware gating is table stakes for adoption at scale.

**Fix.** G1 reads incident-management state as part of `policyContext`, maps the state to one of four `incident_mode` escalation levels:

- **`clear`** — no active incidents; recent-incident cooldown elapsed. Gate operates normally; α budget stays at configured defaults.
- **`active_sev_2`** — active SEV-2 affecting this service or a downstream dependency. Gate tightens: α budget halved (forces more confidence for a fire), bake time extended by 50%, `extend` preferred over `proceed` in ambiguous cases.
- **`active_sev_1`** — active SEV-1 affecting this service, downstream, or any customer-facing surface. Gate refuses to promote any deploy; emits `blocked_by_incident` short-circuit at G1. Explicit override (signed by the incident commander) is the only bypass; override is audited.
- **`recent_incident_cooldown`** — for `cooldown_hours` after a SEV-1 or SEV-2 resolves (default: 4 hours post-SEV-1 resolution, 2 hours post-SEV-2), gate stays in tightened mode. Prevents same-root-cause regressions from slipping through while the platform is still in post-incident fragility.

**Contract surface.** `PolicyContext` gains `incident_state`:

```ts
interface IncidentState {
  mode: 'clear' | 'active_sev_2' | 'active_sev_1' | 'recent_incident_cooldown'
  active_incidents: Array<{
    id: string                      // PagerDuty/Opsgenie/internal incident ID
    severity: 'sev_1' | 'sev_2' | 'sev_3'
    scope: 'this_service' | 'direct_dependency' | 'customer_impact'
    started_at: string              // ISO 8601
  }>
  cooldown_remaining_hours: number  // 0 if not in cooldown
  source: 'pagerduty' | 'opsgenie' | 'internal' | 'manual'
}
```

**Integration with upstream systems.** Platform-team responsibility to wire `IncidentState` from the chosen incident-management system. Wiring is a follow-on Q1 deliverable alongside the first customer-service shadow-mode rollout. For the target platform specifically: PagerDuty likely based on public engineering writeups; verify day 1. Wiring is a 1–2 day integration.

**Post-incident audit integration.** Per addition #5's audit provenance: when `incident_mode` is not `clear`, the audit record carries the active incident IDs. Post-incident postmortems reading the audit log can correlate "what deploys were gated vs promoted during this window" with the incident timeline. Feeds the learning loop (L5) directly.

**Scope.** Docs-only. Follow-on integration with incident-management system is the first deliverable; tightening behavior turns on once the integration is wired.

### Addition #7 — Propensity-score matching + switchback rotation

**Modifies:** calibration compiler's reference-cell identification (extends addition #1); policy surface (adds `switchback_policy` opt-in).

**Problem.** PM critique F17: the canary population may be systematically different from any available baseline population — noisy neighbor effects, routing logic that sends enterprise-tier customers to specific pods, region-specific behavior. CUPAC (addition #1's upstream sibling in L0) absorbs _predictable_ bias via a covariate regression; adversarial assignment (the canary is _fundamentally_ a different population) escapes CUPAC. Addition #1's DID framing degrades for the same reason: if no reference cell matches, DID has no comparison basis.

**Fix — two methods, applied per-deploy based on what the service can tolerate:**

**(a) Propensity-score matching.** At deploy start, the O0 adapter computes the canary slice's propensity-score feature vector (covariates: tenant class, traffic volume band, time-of-day, workload composition, prompt-length histogram, model-family share). The calibration compiler precomputes propensity scores for all baseline cells. At runtime, the adapter finds the matched baseline cell with smallest propensity-score distance. Matched cell becomes the `reference_cell_ref` input to DID.

If the minimum matched distance exceeds a threshold (`propensity_distance_max`, compiled from the baseline's internal distance distribution — typically the 95th percentile of cell-to-cell distances), the gate reports `structural_mismatch` and suppresses Families A and C for this deploy. Family B remains eligible because structural signatures don't depend on a reference population.

**(b) Switchback rotation (opt-in per service).** For services where the canary/baseline population structurally can't match (e.g., a canary gets all enterprise traffic by routing design), switchback rotation is an alternative. The platform alternates which pod slice runs canary vs baseline every N minutes; over the canary window, both slices serve the same customer mix. Time-of-day confound eliminates by averaging; customer-mix confound eliminates by the rotation's symmetry.

Switchback is NOT applicable to:
- Customer-facing APIs with strong session affinity (flipping mid-session breaks users).
- Stateful services where request routing affects state reads (cache locality).
- Services with observable per-session drift (the user notices the A/B difference and changes behavior, contaminating the estimate).

Switchback IS applicable to:
- Internal services (request-level stateless, no user-visible affinity).
- Batch workloads (job-level, no session).
- Certain inference services where the model is stateless and the canary rotation is opaque to the caller.

**Contract surface.** `DeployContext` (addition #9) gains:

```ts
interface DeployContext {
  // ... existing fields ...
  propensity_score_match: {
    matched_cell_ref: CellRef | null      // null when structural mismatch
    distance: number
    fallback_flag: 'none' | 'structural_mismatch' | 'switchback_active'
  }
  switchback_policy: {
    enabled: boolean
    rotation_period_minutes: number | null // null when disabled
  }
}
```

**Honest framing for the pitch.** "Current architecture handles predictable covariate bias via CUPAC. For adversarial assignment (canary is a systematically different population), propensity-score matching identifies the closest baseline cell; switchback rotation is available where services tolerate it. For services where neither works (strong session affinity + inherently biased canary assignment), the gate honestly reports `structural_mismatch` and falls back to Family B structural signatures only. We do not pretend statistical comparison works in all canary-assignment topologies." This is exactly the calibrated-confidence stance the PM critique coaches for.

**Scope.** Docs-only. Full propensity-score matching requires per-service covariate engineering; switchback requires platform-team wiring in the routing layer. Both are for follow-on Q1/Q2 work, targeted at service adoption waves 2 and 3 (after platform inference is running in advisory mode).

---

## Architecture additions — competitive-research integration (W6+1 batch, docs-only)

Five sections added 2026-04-19 from a competitive-landscape analysis and capability-additions review. These close visible pitch gaps where commercial competitors (LaunchDarkly Guarded Rollouts, Harness Continuous Verification, Dynatrace Site Reliability Guardian) ship capabilities DS didn't specify. All five are **docs-only in the project**; implementation is deferred Q1 when real platform telemetry, real orchestrator integration, and real routing-layer data surface. Specifying them architecturally closes the gap in the pitch while keeping implementation scope bounded.

The pattern follows the PM-critique batches (W1–W3 additions #1–#9): name the capability, describe the gap, specify contract surfaces and behavior, flag as docs-only, and document the follow-on implementation path. The runway's the pitch draft (deleted) updates to reference these additions in Part 2 ("what's in flight") and Part 5 (honest-gaps) so the pitch audience sees a complete architectural claim, not a partial one.

### Addition #10 — Sample Ratio Mismatch (SRM) check in L0

**Modifies:** L0 ingestion preprocessing, sibling to addition #8 (schema-continuity check). New L0 subsystem: traffic-allocation-continuity check.

**Problem.** A canary deploy expected to receive X% of traffic but actually receives Y% (where |X − Y| exceeds expected statistical variance) means the routing layer is broken. Any subsequent statistical analysis comparing canary to baseline is operating on the wrong population; the comparison is meaningless before it starts. Sample Ratio Mismatch is a well-known failure mode in A/B testing and progressive delivery. LaunchDarkly Guarded Rollouts ships SRM as a separate always-rollback channel because the canary population can't be trusted as a comparable sample when routing misbehaves. DS currently has no SRM check; routing failures would produce misleading detector verdicts silently.

**Fix.** L0 emits per-tick `traffic_allocation_continuity` flag by comparing observed canary fraction (from `traffic_pct` in the live metrics stream, per the existing `Metrics` schema) against expected canary fraction (from `DeployContext.canary_weight` per addition #9). When |observed − expected| exceeds 2σ over a rolling 5-tick window, escalate.

**Rolling-window σ estimation invariant.** σ is estimated from the rolling window of observations _prior to_ the current tick; the current observation is compared against that σ, not included in it. Including the current observation in the σ estimate would dilute anomaly detection: an outlier observation would inflate σ, which would reduce its own z-score, producing the wrong semantic. Standard practice for anomaly detection against a reference noise envelope — estimate noise from history, evaluate current against that estimate. This invariant applies to any future addition using rolling-window σ estimation (candidates: #11 minimum-context sample-count guard, #12 per-pod variance estimation, #15 recalibration-candidate statistics).

Three classes of SRM status:

- **`stable`:** observed ≈ expected; allocation healthy; no action.
- **`drifting`:** |observed − expected| moderately exceeds expected variance but not catastrophically. Increment drift counter; if sustained over ≥5 consecutive ticks, escalate to `breaking`.
- **`breaking`:** |observed − expected| catastrophically exceeds expected variance OR sustained `drifting` over ≥5 ticks. Triggers G1 short-circuit.

**When `srm` short-circuits:** all detector families suppress — the comparison population is invalid, statistical results would be meaningless. Top-level verdict is `rollback` with `short_circuit: "srm"` and `reason: "Sample Ratio Mismatch — observed canary fraction X% diverged from expected Y%"`. Audit record carries `traffic_allocation_continuity` field on every tick alongside `schema_continuity`.

**Why this matters architecturally.** SRM is the routing-layer equivalent of schema-continuity. Both invalidate the canary-vs-baseline comparison; both deserve their own short-circuit semantics rather than being lumped into per-family detectors. Both fail-fast cleanly: don't try to extract a verdict from invalid data. A gate that silently analyzed a broken canary would fire false-positive rollbacks on healthy deploys and miss real regressions on bad deploys — worst of both worlds.

**Contract surface change:** `SignalStream` (L0 output) gains `traffic_allocation_continuity: 'stable' | 'drifting' | 'breaking'` field. `AuditRecord` gains `traffic_allocation_continuity` field at top level alongside `schema_continuity`. `G1 policyContext.short_circuit` enum gains `'srm'` value.

**Scope.** Implementation shipped 2026-04-19 (ARCHITECT-REPLY-28). L0 module `engine/l0/traffic-allocation-continuity.ts` classifies every observed `traffic_pct` against `expectedCanaryWeight` with architect-set constants (2σ stable / 5σ catastrophic / 5-tick sustained / 2% σ-floor, empirical σ from the previous rolling window). Orchestrator short-circuits with `shortCircuit: 'srm'` on `breaking`; audit records emit `traffic_allocation_continuity` on every tick alongside `schema_continuity`. `expectedCanaryWeight` is a transitional `OrchestrateParams` field until Addition #9 lands `DeployContext.canary_weight`. Lifecycle-event emission for SRM deferred to post-#14. Scenario coverage: 9 unit + 5 integration tests; replay v1 160/160 preserved (synthetic fixtures hold `traffic_pct = 1.0` and don't exercise SRM).

### Addition #11 — `suppressed_insufficient_samples` verdict + minimum-context guard

**Modifies:** L3 verdict fusion (new verdict variant); per-family eligibility logic (extends addition #4 per-signal bake profile); `BakeProfile` contract surface.

**Problem.** When traffic on a canary is too thin to support statistical analysis — a low-RPS service, an early-tick window before mSPRT has accumulated enough samples, a batch workload where requests are sparse — the gate currently has only two options under Q1 Option 1 semantics (from REPLY-19): `proceed` at final tick (indeterminate collapses to clean) or `extend` during the run. Neither is honest on insufficient evidence. `proceed` is gambling with unknown FP rate; `extend` forever is paralysis. LaunchDarkly Guarded Rollouts ships an explicit minimum-context guard that auto-rollbacks (or surfaces `insufficient_context` to the operator) when traffic hasn't reached analytical power by the bake window end. The guard is a separate verdict path, not a degradation of the statistical machinery.

**Fix.** Introduce `suppressed_insufficient_samples` as a top-level verdict variant (sibling to `proceed`, `rollback`, `extend`, `baking`). Triggered when at the end of the observation window, all detector families have either:

- `verdict: 'suppressed'` with `suppression_reason: 'bake_profile'`, OR
- `verdict: 'suppressed'` with `suppression_reason: 'insufficient_samples'`,

AND no family has fired `rollback` or `fire`.

Per-family `min_samples_for_evaluation` field added to `BakeProfile`: below this sample count, the family suppresses with reason `insufficient_samples` rather than evaluating with low-power statistics. Default values per signal:

- `p99_latency`, `ttft`, `downstream_err`: 30 samples (fast-response signals).
- `eval_score`, `refusal_rate`, `tool_success_rate`: 50 samples (per-tick noise is higher).
- `cost_req`, `tokens_per_turn`: 100 samples (cost ratios and token counts are noisy).

**Operator policy resolves the new verdict variant at the orchestrator layer** (O0 adapter translates `suppressed_insufficient_samples` to an orchestrator action per service policy):

- **Default:** treat as `extend` for one additional bake window; if still insufficient, surface to operator review (no automatic action; operator decides).
- **High-risk-tier policy:** treat as `rollback` (conservative — refuse to promote on insufficient evidence).
- **Low-risk-tier policy:** treat as `proceed` (permissive — blast radius is low, risk is bounded).

**Why this matters architecturally.** Under Q1 Option 1, a clean final-tick verdict on an insufficient-sample run is statistically dishonest. Collapsing indeterminate to clean makes sense when evidence is mid-accumulation and the window has closed; it doesn't make sense when there was never enough evidence to begin with. The new variant separates "the window closed without evidence crossing threshold" (legitimate `proceed`) from "the window closed without enough evidence to make any claim at all" (`suppressed_insufficient_samples` — needs operator policy). Calibrated-confidence framing in the pitch: we don't pretend to make claims on insufficient data.

**Contract surface change:** `FusedVerdict.verdict` type extended with `'suppressed_insufficient_samples'`. `BakeProfile` gains `min_samples_for_evaluation: number` (per-signal). `AuditRecord.fusion_verdict` can emit the new variant; downstream consumers handle as a fourth verdict class.

**Scope.** Docs-only. Implementation small (~1–2 hours) when first low-traffic service surfaces in shadow mode; runway scenarios all have ample samples by final tick so the new variant doesn't fire against them.

### Addition #12 — Per-pod verdict breakdown (extends Addition #2 cell matrix)

**Modifies:** L1 characterization (per-pod buffering when label cardinality supports it); L3 fusion (cohort-level aggregation of per-pod verdicts); addition #2 cell matrix (optional `pod_id` dimension).

**Problem.** A canary deploy might have N pods. If 3 of N pods have a regression and the others are healthy, an aggregated per-cohort comparison may not cross threshold — the healthy pods dilute the signal. Harness Continuous Verification operates at the per-node level (each canary node vs each primary node) for exactly this reason; pod-specific regressions are a real failure mode in Kubernetes deployments where uneven resource scheduling, GPU heterogeneity, or noisy-neighbor effects can degrade a subset of pods. Currently DS aggregates across all canary pods, missing this class.

**Fix.** When per-pod labels are available in telemetry (typical in K8s/Argo deployments where `pod_id` is a Prometheus label), L1 maintains per-pod TrendBuffer state in addition to per-cohort state. Per-pod verdicts emit; cohort-level verdict is portfolio-fused across pod verdicts.

**Cohort-level fusion semantics for per-pod verdicts** (configurable policy):

- **Any-pod-rollback rule (default):** if any pod fires `rollback`, cohort verdict is `rollback`. Conservative; matches the principle "one bad pod is enough to abort."
- **Majority-pod-rollback rule:** ≥50% of pods fire `rollback` for cohort-level rollback. Tolerates single-pod transients (GPU driver hiccups, transient scheduling issues).
- **Per-tier policy:** high-risk-tier defaults to any-pod-rollback; low-risk-tier defaults to majority-pod-rollback.

**Cell matrix extension** (addition #2 interaction): dimensions optionally include `pod_id`. For services where per-pod sample size is adequate (`n_samples_per_pod ≥ min_samples_strict = 60`), per-pod cells. For services where per-pod is inadequate but cohort-level is adequate, cohort-level cells (current behavior). Hierarchical pooling (per addition #2) collapses `pod_id` dimension first when sparse.

**Graceful degradation:**

- When per-pod telemetry is unavailable (no pod label, or cardinality too high to track per-pod): fall back to current cohort-level behavior with `granularity: 'cohort'` flag in audit.
- When per-pod is available and sample-sufficient: `granularity: 'per_pod'` and per-pod verdicts surface in audit.

**Why this matters architecturally.** Harness's per-node comparison is a correctness feature, not a UX feature — aggregated comparison misses failure modes that per-pod catches. DS specifying this addition closes a material detection gap. Pitch beat: "per-pod when labels support it; cohort-level when they don't; same portfolio-fusion semantics either way."

**Contract surface change:** `SignalStream` adds optional `pod_id?: string`. `CompiledConfig.baseline_cells.dimensions` may include `'pod_id'`. `AuditRecord` gains `granularity: 'per_pod' | 'cohort'` field; per-pod records reference their `pod_id`. Per-pod verdicts surface as child records under the cohort verdict in the audit trail.

**Scope.** Docs-only. Implementation in follow-on Q1 (medium; depends on platform telemetry granularity). Needs real K8s pod labels; synthetic data doesn't carry `pod_id`.

### Addition #13 — Fail-Fast / Ignore threshold contract surface

**Modifies:** G1 policy gate (extends `policyContext` with operator-defined panic and ignore thresholds).

**Problem.** Operators frequently want hard-stop rules outside the statistical machinery — "if p99 latency hits 2× baseline, immediately fail regardless of the statistical analysis" (panic threshold); "if eval_score stays above 0.95, don't bother running the comparative analysis" (ignore threshold; gate-around-the-gate that saves analysis cycles on obviously-fine deploys). Harness Continuous Verification ships both as Fail-Fast / Ignore threshold contract surfaces. SRE leads recognize these because they sidestep the "wait for the statistical test to confirm what we already know" problem. DS currently has neither — a deploy with catastrophically bad p99 at tick 3 still waits for the statistical machinery to confirm the obvious.

**Fix.** G1 policy gate extends with two new operator-set contract surfaces, both per-signal:

**`fail_fast_thresholds`** — panic bounds; if signal value crosses the threshold at any tick, gate emits `rollback` with `short_circuit: "policy_fail_fast"` immediately, no statistical evaluation. Threshold is a hard absolute bound (not a ratio): e.g., `{p99_latency: 1000}` means p99 over 1000ms at any tick triggers immediate rollback. Sibling to the reversibility classification (addition #5) in G0 — both are policy-layer hard-stop rules.

**`ignore_thresholds`** — comparative-analysis skip bounds; if a signal stays within `[min, max]` over the bake window, the corresponding detector family suppresses for that signal with `suppression_reason: 'ignore_threshold'`. E.g., `{eval_score: {min: 0.95}}` means eval_score above 0.95 doesn't need comparative analysis — statistically and operationally fine. Saves analysis cycles; reduces false-positive risk on obviously-healthy signals.

**Three-tier policy contract becomes explicit:**

1. **Fail-fast bounds (G1, hard-stop):** absolute panic thresholds; fire immediately on cross. Short-circuits L2 entirely.
2. **Ignore bounds (G1 → L2 suppression):** if signal stays inside the band, skip the statistical comparison for that signal. Family A (single-signal mSPRT) suppresses the matching signal with `suppression_reason: 'ignore_threshold'`. Multivariate and structural families are unaffected (see the multivariate-semantic paragraph below).
3. **Statistical detector portfolio (L2):** runs only on signals that haven't fail-fast'd and haven't been ignored.

**Multivariate-semantic invariant (per ARCHITECT-REPLY-31).** `ignore_thresholds` apply to single-signal detectors (Family A mSPRT) only. Multivariate families (C Hotelling T², E conformal Mahalanobis) evaluate the full-dimensional joint vector regardless of `ignore_thresholds` state; in-band signals contribute near-zero to the multivariate distance naturally via the Mahalanobis math (`(x − μ)ᵀ Σ⁻¹ (x − μ)` with `x ≈ μ` for that component contributes ≈ 0 to the quadratic form), so explicit suppression would be redundant and would silence Family C/E on other-signal drift the operator didn't intend to ignore. Family B structural signatures operate on absolute thresholds and are similarly unaffected. This is the architect-intended semantic as of ARCHITECT-REPLY-31. Future detector families (e.g., Addition #7 propensity-based evaluation, Addition #16 SLO substrate) inherit this rule rather than re-deriving it.

**Why this matters architecturally.** Gives operators an escape hatch from the statistical machinery without compromising the architecture's formal guarantees. The detector portfolio retains its α-budget contract; panic and ignore thresholds are operator policy that operates around the portfolio, not within it. Operator-ergonomics maturity that SRE leads recognize. The `short_circuit: 'policy_fail_fast'` path is instrumented identically to existing short-circuits (`policy_incident`, `srm`, etc.) — consistent audit shape.

**Contract surface change:** `PolicyContext` gains `fail_fast_thresholds: Record<signal_id, number>` and `ignore_thresholds: Record<signal_id, {min?: number, max?: number}>`. `AuditRecord.short_circuit` enum gains `'policy_fail_fast'`; `suppression_reason` enum gains `'ignore_threshold'`.

**Scope.** Implementation shipped 2026-04-19 (ARCHITECT-REPLY-30). Both threshold types are operator-set per service; default is empty (no fail-fast or ignore rules) — backward-compatible with current behavior. First services using them will be those with well-understood hard bounds (internal SLO floors, contractual latency limits).

### Addition #14 — Lifecycle event hooks in O0

**Modifies:** O0 orchestration adapter (extends `OrchestrationAdapter` interface with structured lifecycle event emission).

**Problem.** External orchestrators (Argo Rollouts, Spinnaker, Flagger) and downstream consumers (incident-management systems, dashboards, audit log subscribers) often want to react to gate evaluation transitions, not just final verdicts. Dynatrace Site Reliability Guardian models this as a business-event-driven contract: the pipeline posts `guardian.validation.triggered` as a first-class event; Guardian processes; Guardian emits `guardian.validation.finished` with the verdict; downstream tooling subscribes. The event-driven contract makes the gate's lifecycle observable and integrable without custom polling. DS's O0 adapter (addition #9) currently has only the verdict-emission contract (`emitVerdict`); no structured lifecycle events.

**Fix.** O0 adapters implement a `LifecycleEventEmitter` contract with five event types, each emitted at a well-defined gate-lifecycle transition:

- **`evaluation.triggered`:** deploy starts; gate begins observation. Emitted once. Payload includes `deploy_id`, `service_id`, `compiled_config_version`, `expected_window_ticks`, `risk_tier`.
- **`evaluation.started`:** first tick processed; baseline cell identified; detector families initialized. Emitted once. Payload includes `cell_key`, `cell_confidence`, `families_eligible`.
- **`evaluation.tick`:** per-tick verdict emission. Emitted per-tick during evaluation. Payload mirrors the v2 audit record for that tick. High-frequency stream; subscribers may throttle or sample.
- **`evaluation.suppressed`:** emitted when a family transitions into a suppressed state mid-evaluation. Payload includes `family_id`, `suppression_reason`, `tick`.
- **`evaluation.finished`:** final verdict emission. Emitted once. Payload includes `final_verdict`, `total_alpha_spent`, per-family summary, `divergence_from_spec` if applicable.

**Per-orchestrator delivery mechanics** (adapter-specific):

- **Argo Rollouts (Level 1 adapter):** events emit as Kubernetes Events on the Rollout resource (`kubectl describe rollout` surfaces them).
- **Spinnaker (for follow-on adapter):** events emit as Spinnaker pipeline notifications on the parent pipeline.
- **Custom (for follow-on):** webhook POST to operator-configured URL with standard payload shape.
- **The model-lifecycle tooling integration (production-specific, for follow-on):** events emit as the model-lifecycle tooling tags on the deploy run; `evaluation.finished` also writes a structured result artifact.

**Why this matters architecturally.** Matches the industry pattern for CD/CI lifecycle integration (Dynatrace Guardian, Argo events, Spinnaker stages all use structured events at scale). Downstream tooling integration — incident-management systems reacting to `evaluation.finished`, dashboards subscribing to `evaluation.tick`, audit log consumers listening for `evaluation.suppressed` — becomes a webhook subscription rather than a custom polling loop. Closes a visible integration-surface gap.

**Contract surface change:** `OrchestrationAdapter` interface gains `emitLifecycleEvent(event_type: LifecycleEventType, payload: LifecycleEventPayload): Promise<void>` method. New typed `LifecycleEventType` enum and `LifecycleEventPayload` union types in `engine/types.ts`. Adapters implement per-orchestrator delivery; the engine emits the events to the adapter; the adapter routes to the orchestrator's native event surface.

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-31). Runway ships the `LifecycleEventEmitter` contract plus two reference implementations (`NoOpLifecycleEventEmitter` as default zero-side-effect backward-compat gate; `InMemoryLifecycleEventEmitter` as test fixture with per-listener error isolation and registration-order delivery). Real-orchestrator adapters (Argo Rollouts Kubernetes Events, Spinnaker pipeline notifications, the model-lifecycle tooling run tags, webhook POSTs) remain for follow-on — the engine emits `LifecycleEvent` objects; adapters translate.

**Follow-up enhancements unlocked.** Additions #10 (SRM short-circuit) and #13 (fail-fast trip) can emit lifecycle events via the new contract in a 1–2 hour follow-up pass (not retrofitted in this PR per brief anti-scope). #10 would emit `evaluation.suppressed` per family + `evaluation.finished` on short-circuit; #13 would emit `evaluation.suppressed` per family + `evaluation.finished` on trip. No sixth event type needed for either.

---

## Audit schema v2.1 — minor extension note (GAP-06, effect-size CI)

A minor schema extension planned for v2.1 (post-phase): Family A's `DetectorTrip.provenance` block gains an optional `effect_size_ci: { lower: number, upper: number, confidence_level: number }` field. Computed from Page-CUSUM state and the mixture prior at emission time; derivation is O(1) per emission. Renders alongside `cusum_progress` in dashboard UIs so viewers see both the Ville-bound budget statistic and the intuitive effect-size range.

This is intentionally scoped as a v2.1 minor extension (not v3 breaking): older v2 audit consumers can ignore the field; newer tooling uses it. LaunchDarkly ships an effect-size CI as its primary statistical surface in Guarded Rollouts; DS adding it alongside (not replacing) the mSPRT statistic gives viewers both the formal sequential-test value and the intuitive CI. Lands post-phase when the pitch audience's UI expectations become clearer; runway keeps v2 exactly as specified.

### Addition #18 — Robust covariance (MCD / MRCD) + Sequential MMD

**Modifies:** `tools/calibrate.ts` (adds FastMCD + MRCD estimator paths + Sequential MMD compile-time precompute); `engine/detectors/hotelling.ts` (α-budget halves when `mmd_params` present; math unchanged); new `engine/detectors/sequential-mmd.ts`; `engine/gates/health.ts` (wires Sequential MMD alongside Hotelling).

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-33). Two parts, one PR:

**Part 1 — Robust covariance.** Compiler gains FastMCD (Rousseeuw & Van Driessen 1999) + MRCD (Boudt et al. 2020) as selectable covariance estimators on `FamilyCPerCell`; retains Ledoit-Wolf as selectable fallback. Per-cell choice is sample-size driven (n ≥ 2p+1 AND p ≤ 20 → MCD; n < 2p+1 AND p ≤ 20 → MRCD; p > 20 → LW); `CompilerOptions.covariance_method_override` lets operators force a specific method. New fields on `FamilyCPerCell`: `covariance_method` (required on new cells; v4-and-earlier migrate to `'ledoit_wolf'` compile-time default), `outlier_detection` (MCD/MRCD-only metadata documenting h_support, trim fraction, Mahalanobis cutoff), and `mmd_params` (Sequential MMD precompute, null until cell is recompiled). Hotelling T² math unchanged — detector consumes whichever Σ lives on the cell.

**Part 2 — Sequential MMD as Family C second detector.** Runs alongside Hotelling T² (not replacing). Gaussian RBF kernel with median-heuristic bandwidth per D5 (no operator tunable). Streaming U_t statistic per Li/Chen 2019 with the baseline×baseline third term precomputed at compile time; O(b·p) per-tick cost at b=30 window size. Bootstrap null-quantile precomputed via 2000 resamples, per-cell seed (matches Family E's seeding pattern). α-budget split 50/50 within Family C per D8: when the cell carries `mmd_params`, Hotelling takes `per_family.C × 0.5` and MMD takes the other half. Family-level α stays at the pre-#18 value. Captures distributional-shape shifts Hotelling T² misses (bimodality emergence, variance inflation without mean-shift).

Audit records carry both detectors' verdicts: `DetectorTrip.detector_id` gains `'sequential_mmd'` additively alongside `'hotelling_t2_joint_vector'`; the families block's Family C entry aggregates both into a single `verdict` (fire if either fires). Real-orchestrator pass-throughs and replay readers degrade gracefully on the new id per the existing forward-compat rule.

Regression-safety hard gate: pre-#18 configs that don't recompile continue to emit Hotelling-only verdicts with the pre-#18 α budget (no silent swap). Only configs compiled after 2026-04-20 with Addition #18 installed carry the split.

### Addition #19 — Weighted-quantile conformal for Family E

**Modifies:** `tools/calibrate.ts#buildFamilyEPerCell` (weighted-bootstrap rewrite); `engine/detectors/conformal.ts` (weighted-quantile threshold path, D2 header fold); `engine/detectors/_linalg.ts` (new `weightedQuantile` primitive); `engine/types.ts` (`ConformalParams` becomes a discriminated union; `CompilerOptions.family_e_halflife_days`).

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-35). Family E conformal novelty uses the cell's robust covariance (MCD/MRCD or Ledoit-Wolf per Addition #18) to score live-vector Mahalanobis deviations against a parametric Gaussian null bootstrap. Calibration scores carry per-sample weights via a time-decay exponential (default half-life `min(baseline-age-span / 2, 14)` days). Fire threshold is the `(1 − α)`-th weighted quantile of the bootstrap scores. Weighting makes the null distribution adapt to recent-baseline conditions without losing the full bootstrap's statistical strength; effective sample size is audit-visible. Route (b) real-held-out-with-weights deferred to follow-on (finite-sample coverage requires `n ≥ ⌈1/α⌉` per cell, which exceeds typical cell sample counts at α = 1e-4).

D2 text fold: the `engine/detectors/conformal.ts` header previously described calibration as a "10% held-out slice" — inaccurate; the pre-#19 compiler already drew from a parametric Gaussian null. The #19 PR rewires the calibration path anyway and is the natural moment to replace that phrasing with the accurate parametric-bootstrap-plus-weighted-extension description. Same fold applies everywhere the stale phrasing propagated (NS-ARCH Family E spec, WS3-INTERFACE-WEEK5 §F).

`ConformalParams` migrates to a discriminated union: `{ kind: 'unweighted', calibration_scores }` for pre-#19 on-disk configs and inline fixtures (parses transparently — `kind` is optional on the unweighted variant), `{ kind: 'weighted', scores, weights, halflife_days, effective_sample_size }` for recompiles under the new pipeline. Every reader switches on `.kind` (detector, audit, demo rendering). λ = `log(2) / halflife_days`; operator override via `CompilerOptions.family_e_halflife_days`. Compiler warns when ESS drops below `0.7 · M_bootstrap` (over-aggressive decay). Cell-similarity weighting + per-sample timestamp tracking are architect-recorded follow-ups (ARCHITECT-REPLY-35 Open Qs 1–2), both deferred to follow-on.

### Addition #22 — Family E weighted-conformal e-value (hedged-indicator betting form)

**Modifies:** `engine/types.ts` (`ConformalParams.kind: 'weighted_e_value'` variant with `cumulative_weights_above` + `total_weight` precomputes; new `ConformalEValueState`; `CompilerOptions.force_legacy_family_e`; `TrendBufferI.conformalEValueStates`); `engine/detectors/_linalg.ts` (new `findFirstGE` O(log n) binary search); `engine/detectors/conformal.ts` (new `evaluateConformalWeightedEValue` + `freshConformalEValueState`; `evaluateFamilyE` gains variant dispatch for the new `kind`); `tools/calibrate.ts` (`buildFamilyEPerCell` extended: reverse-cumsum weights + total_weight precompute; `CompilerOptions.force_legacy_family_e`; default `weighted_e_value` emission when baseline span ≥ 7 days and ESS-threshold met); `engine/gates/health.ts` (Family E evaluator lazy-allocates per-(deploy, cell) wealth state + threads into evaluateFamilyE); `audit/SCHEMA.md` v2.1 (Family E detector_id enumeration extended); WS3-INTERFACE-WEEK5 §D8 tooltip FINAL; new tests `conformal-e-value.test.ts` + `conformal-variant-migration.test.ts`. **`COMPILER_VERSION` bumped 0.2.0 → 0.3.0 per REPLY-46 D9.**

**Scope.** Implementation shipped 2026-04-21 across two slices (ARCHITECT-REPLY-46 + REPLY-46b correction). Family E post-#22 runs a single anytime-valid weighted-conformal e-value: a hedged-indicator betting wealth process (Shekhar-Ramdas 2023 λ=1 special case) over the time-decayed calibration distribution from Addition #19. Fires at `M_t ≥ 1/α_E = 10,000` under Ville's inequality. REPLACE semantic: one detector per Family E cell.

**REPLY-46b formula correction.** REPLY-46's original D3 specified `e_t = total_weight / den` — the "invert the conformal p-value" construction. That formula is NOT a valid e-value: `E[e_t | H₀] ≈ H_M ≈ 10.5` at M=20,000 (not ≤ 1), so the wealth process grows multiplicatively under H₀ and Ville's inequality does not apply. Slice-1 shipped dormant with the Ville-bound test `.skip()`'d + formula-correctness unit tests passing; TPM-REPLY-46a routed the diagnosis to architect. REPLY-46b disposed with the hedged-indicator form:

```
indicator = (cumulative_weights_above[k] < α_E · total_weight) ? 1 : 0
e_t = 1 + indicator − α_E
    ⇒ indicator=0: e_t = 1 − α_E  (no fire signal; slight decay)
    ⇒ indicator=1: e_t = 2 − α_E  (fire signal; wealth doubles)
```

Validity: under weighted exchangeability, `P(indicator=1 | H₀) = α_E` by construction, so `E[e_t | H₀] = α_E·(2−α_E) + (1−α_E)·(1−α_E) = 1` exactly. Martingale preserved; Ville applies.

**Fire-time semantics.** Parallels Family A/C/D: e-process wealth accumulates across ticks and fires when cumulative log-wealth crosses `log(1/α_E)`. Under sustained indicator=1 drift (s_t beyond α_E-tail of calibration), fire horizon is `log(10000)/log(2) ≈ 14 ticks`. Under healthy (indicator mostly 0), wealth drifts slowly as `(1−α_E)^t ≈ 1 − t·α_E`.

**Legacy fallback retained.** `CompilerOptions.force_legacy_family_e=true` emits the Addition #19 `weighted` quantile-threshold variant; `unweighted` (pre-#19) path still loads for historical configs. Baselines with span < 7 days or expected ESS below threshold fall back to `unweighted` regardless (weighting-beneficial gate from REPLY-38 Cluster 2).

**Post-#22 Ville scope — FINAL.** Families A, C, D, E all anytime-valid Ville-bounded e-processes. Combined honest α bound: `α_A + α_C + α_D + α_E = 4e-4 + 2e-4 + 1e-4 + 1e-4 = 8e-4` per deploy. Addition #22 closes the Ville-full substrate; §L2 tooltip transitions to its FINAL single-unified form.

### Addition #21 — Family D e-detector (peak-ACF as betting wealth process)

**Modifies:** `engine/types.ts` (`FamilyDPerSignal.spectral_variant`/`null_mean`/`null_std`/`betting_delta`; new `SpectralEDetectorState`; `CompilerOptions.force_legacy_family_d`; `TrendBufferI.spectralEDetectorStates`); `engine/detectors/spectral.ts` (new `evaluateSpectralEDetector` + `freshSpectralEDetectorState`; `evaluateFamilyD` gains variant dispatch); `tools/calibrate.ts` (`buildFamilyDForSignal` computes null-distribution moments + betting_delta alongside the existing bootstrap quantile; `--force_legacy_family_d` CLI flag); `engine/gates/health.ts` (Family D shadow evaluator lazy-allocates per-signal state + threads into evaluateFamilyD); `engine/audit.ts` (variant-aware `detector_id` projection for Family D — `spectral_e_detector_*` when the e-detector fired, `spectral_peak_acf_*` legacy); `audit/SCHEMA.md` v2.1 (Family D detector_id enumeration extended); WS3-INTERFACE-WEEK5 §D8 tooltip; new tests `spectral-e-detector.test.ts` + `spectral-variant-migration.test.ts` + `spectral-cupac-interaction.test.ts` + `family-d-sufficiency-gate.test.ts`.

**Scope.** Implementation shipped 2026-04-21 across three slices (ARCHITECT-REPLY-45). Family D post-#21 runs a single anytime-valid e-detector on peak|ACF|: a scalar mixture-prior betting wealth process (Shin-Ramdas-Rinaldo 2022, simplified single-mixture form). Fires at `M_t ≥ 1/α_D = 10,000` under Ville's inequality. Replaces — not co-ships with — the legacy per-tick bootstrap-null threshold crossing (unlike Family A/C co-ships; REPLY-45 D1 rationale: both bootstrap-null and e-detector operate on the same peak|ACF| statistic with no complementary detection regime, so co-ship would split α_D without power gain).

**Legacy fallback retained.** `cell.spectral_variant='bootstrap_null'` (CompilerOption `force_legacy_family_d=true`) pins the legacy per-tick threshold-crossing path for shadow-compare + historical-run reproducibility. Both code paths live in the runtime; compile-time selection via `cell.spectral_variant`.

**Null-distribution moments derivation.** `buildFamilyDForSignal` computes `null_mean` (μ₀) and `null_std` (σ₀) as byproducts of the existing 2000-sample bootstrap sort — negligible compile-time cost (~0.5ms per signal). `betting_delta` (δ_D) = `0.3 · σ₀` per REPLY-45 D4, derived from sufficiency-gate fire-horizon targets: ≤25 ticks on 2σ₀ oscillation, ≤50 ticks on 1σ₀ mild oscillation, while maintaining healthy sub-martingale drift `exp(-0.5·r²) ≈ 0.956×/tick` under H₀ (r = δ_D/σ₀ = 0.3). Stored per-signal so audit replay consumers reproduce fire timings across recompiles.

**Fire-time semantics.** safe-Hotelling/e-MMD fire-time semantics (see Addition #20) carry over directly to Family D: the e-detector's wealth-process accumulates evidence across ticks and fires when cumulative log-wealth crosses `log(1/α_D)`. Fire timings may lag bootstrap-null's stochastic single-tick threshold-crossing on transient spikes, while being equivalent or faster on sustained oscillation. Acceptance is decision-level parity (sufficiency gate per REPLY-43d), not tick-level. Empirical datapoint from slice-3 canned-demo validation: `demo-github-2020` fires Family D at t=19 under bootstrap-null and t=26 under e-detector — +7-tick drift, well within the demo's 32-tick canary window.

**CUPAC-bypass invariant (D7).** Family D consumes pre-CUPAC signals. Rationale (architect-authored): CUPAC regresses out predictable variance, but oscillation IS a form of structured variance — regressing out correlated covariates before spectral analysis would mask the oscillation the family is designed to detect. This is the first explicit "family X consumes pre-CUPAC signal" architectural decision; future families may inherit the pattern. Test `spectral-cupac-interaction.test.ts` validates the masking effect empirically: a flattened (post-regression) window produces <10× the wealth growth of a raw oscillating window.

**Post-#21 Ville scope.** Families A, C, and D are all Ville-valid anytime-valid e-processes. Combined honest α bound: `α_A + α_C + α_D = 4e-4 + 2e-4 + 1e-4 = 7e-4` per deploy. Family E still applies per-tick union-bound correction; Addition #22 closes that gap.

### Addition #20 — Family C e-processes (safe-Hotelling + e-MMD co-ship)

**Modifies:** `engine/types.ts` (`FamilyCPerCell.hotelling_variant`/`mmd_variant` discriminators + `safe_hotelling_params`/`e_mmd_params` precomputes; new `SafeHotellingState`/`EMmdState`; `CompilerOptions.family_c_shrink_fraction` + `force_legacy_family_c`); `engine/detectors/_linalg.ts` (new `logDet` primitive); `engine/detectors/hotelling.ts` (new `evaluateSafeHotelling` alongside the legacy `evaluateFamilyC` chi-square path); `engine/detectors/sequential-mmd.ts` (new `evaluateEMmd` reusing REPLY-34 betting primitives alongside the legacy bootstrap-null path); `tools/calibrate.ts` (`buildFamilyCPerCell` extensions precomputing `precompiled_log_det_shrink` + `kernel_baseline_mean_norm_squared`, variant-default population); `engine/gates/health.ts` (Family C shadow evaluator dispatches on `hotelling_variant` + `mmd_variant`); `engine/orchestrator.ts` (fresh-state factory grows `safe_hotelling_states` + `e_mmd_states` maps); `audit/SCHEMA.md` v2.1 (DetectorTrip.detector_id extended with `hotelling_t2_safe` + `sequential_mmd_e_process`; DetectorTrip.derivation.wealth_process_value for e-process variants; Provenance.family_c_shrink_fraction_used for reproducibility); new tests `safe-hotelling.test.ts` + `e-mmd.test.ts` + `family-c-coship-ville.test.ts` + `family-c-variant-migration.test.ts` + `family-c-cupac-interaction.test.ts`; WS3-INTERFACE-WEEK5 §D8 tooltip.

**Scope.** Implementation landed across slices 2026-04-20 through 2026-04-21 (ARCHITECT-REPLY-43, -43a, -43b). Family C post-#20 carries two independent anytime-valid e-processes — `hotelling_t2_safe` (parametric; GRAW/GROW e-test from Grünwald-de Heide-Koolen 2024) and `sequential_mmd_e_process` (kernel; betting e-process on kernel-distance scalar per Shekhar-Ramdas 2023, Option-B simplification) — under a 50/50 α-split of the `α_C = 2e-4` family budget. Both fire at `M_t ≥ 1/α_per_detector = 10,000`. Parallels Family A's Page-CUSUM + betting e-process structure from Addition #17; Family C post-#20 has a single coherent anytime-valid FP-control philosophy under Ville's inequality, matching Family A.

**Co-ship, not replace.** Legacy variants (`chi_square` for Hotelling, `bootstrap_null` for Sequential MMD) stay in the runtime and selectable via `cell.hotelling_variant` / `cell.mmd_variant`. Operators can pin `force_legacy_family_c: true` at compile for shadow-compare runs + audit-trail reproducibility on historical pre-#20 traces. New-config defaults flip to `safe_test` + `betting_e_process`; v4-era configs loaded on-disk retain their chi_square + bootstrap_null labels until recompiled.

**Family C safe-Hotelling τ² derivation (REPLY-43b revision from original D4).** Family C safe-Hotelling uses auto-derived `τ² = c · trace(Σ) / p` where c defaults to 0.03 (derived from chi_square fire-timing parity on 2σ joint drift). Operator override via `family_c_shrink_fraction` CompilerOption. The per-signal `δ_min` parameterization used by Family A Page-CUSUM is NOT shared — Family C has its own scale-invariant parameter because the joint-multivariate detection threshold is governed by `trace(Σ)`, not by per-signal operator intuition. Original D4 tied `τ² = δ_min²/4` to the per-signal δ_min; slice-2b empirical calibration on synthetic-v1 surfaced that this produced `τ²/λ` ratios of ~200% (vs P3's 1% expectation), collapsing wealth dynamics. The scale-invariant shrink-fraction formulation keeps `τ²/trace-per-dim ≈ c` independent of baseline scale, restoring the canonical "fire in O(20) ticks on moderate drift" narrative.

**e-MMD Option B construction.** Compile-time `kernel_baseline_mean_norm_squared = (1/m²) · Σ_{i,j} k(y_i, y_j)` (derived from `baseline_baseline_sum` which stores `Σ_{i≠j}` + `m` for the RBF self-kernel diagonal). Runtime per tick: `d_t = √(k(x_t, x_t) − 2·(1/m)·Σ_i k(x_t, y_i) + kernel_baseline_mean_norm²)`; standardized via running moments over `running_moment_window = 30` ticks; betted via REPLY-34's `pickBet` (GRAPA with ONS fallback); wealth update `M_t = M_{t-1} · max(0, 1 + λ_t · d_t_std)` with `d_t_std` clipped to [−1, 1] for non-negativity. True O(1) via random-feature approximation flagged as for follow-on optimization target. Baseline pool reuses the Addition #18 Sequential MMD pseudo-sampling path (L·w from Cholesky(Σ)) so both variants are identical under shadow-compare.

**Architectural post-#20 Ville scope.** Families A and C are both anytime-valid Ville-bounded under Addition #20 — together totaling honest `α = α_A + α_C = 6e-4`. Families D and E still apply per-tick union-bound corrections; extensions to Ville-valid substrates queued as Additions #21 and #22. Post-#22, the full family-portfolio honest Ville bound becomes the `α_total` gate; §L2 tightens accordingly at that time.

**Fire-time semantics (ARCHITECT-REPLY-43d, post-slice-2b-2b-1 category-mismatch finding).** safe-Hotelling and e-MMD are anytime-valid detectors that fire when cumulative wealth exceeds 1/α. Their fire-time distribution differs from chi-square's stochastic threshold-crossing; expect safe_test fire times to lag chi_square on transient-spike drifts, while being equivalent or faster on sustained drifts. Both fire within canary window on representative regressions; decision-level parity is the acceptance target, not tick-level parity.

### Addition #17 — Betting-based e-processes (Family A co-ship)

**Modifies:** file rename `engine/detectors/mSPRT.ts` → `engine/detectors/page-cusum.ts` (with one-line `export *` shim at the old path for one PR cycle); new `engine/detectors/betting-e-process.ts`; `engine/gates/health.ts` (co-ship union of Page-CUSUM and betting shadows); `engine/core.ts` (`TrendBuffer.bettingStates`); `engine/types.ts` (`FamilyAPerSignalParams.betting_e_process_alpha`, `BettingEProcessState`, `DETECTOR_REGISTRY.A` grows additively with `page_cusum_*` and `betting_e_process_*`); `tools/calibrate.ts` (`buildFamilyAPerSignal` + α-split compiler pass); `audit/SCHEMA.md` v2.1 detector registry; D1 inline-comment scrub across `hotelling.ts` + `conformal.ts`.

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-34). Family A now runs two independent anytime-valid tests per signal under a 50/50 α-split of the per-signal Bonferroni-corrected budget. Both detectors are martingale-based and Ville-bounded; Family A has a single coherent anytime-valid FP-control philosophy for the first time at the NS-ARCH level.

Page-CUSUM (mixture-prior log-likelihood `S_n`) handles abrupt unknown-onset mean shifts and fires at `S_n ≥ −log(α)`; its behavior at demo-calibrated fire points is preserved (Page-CUSUM consumes the full per-signal budget on pre-#17 configs via the `betting_e_process_alpha` absence fallback; post-#17 recompiles give it the split's other half). Betting-based e-processes (this PR) run a wealth martingale `M_t = ∏ (1 + λ_t z_t)` updated per-tick via GRAPA (Waudby-Smith & Ramdas 2024) with ONS fallback when GRAPA's raw bet leaves the unit ball; fire at `M_t ≥ 1 / α_betting`. No operator-exposed tunable — the bet is derived from running moments of the standardized `z_t = clip((x − μ) / (3σ), −1, 1)` sequence. GRAPA-over-ONS selection is recorded on the per-(deploy, signal) state's `onsFallbackCount` audit counter.

**Co-ship, not replace (D1).** Page-CUSUM stays because it has two years of demo calibration and a complementary power profile (abrupt shifts vs. gradual drift + non-Gaussian residuals). The for follow-on door stays open: if evidence shows betting e-processes uniformly dominate, a follow-up PR retires Page-CUSUM with full re-calibration. Starting co-ship keeps that door open; starting replace closes it.

**α accounting.** Per-signal α allocation: `(α_A / bonferroni_factor) · 0.5` per detector. At W2 defaults (`α_A = 4e-4`, `bonferroni_factor = 6`): per-detector α ≈ 3.33e-5; betting threshold M ≈ 30,000; Page-CUSUM threshold `h = −log(3.33e-5) ≈ 10.31`. Family-level α stays ≤ 4e-4. Compiler emits a sanity-check warning if the 2·(per-signal α)·bonf sum deviates from `α_A`. Detector IDs: `page_cusum_{signal}` (forward-compat alias for the REPLY-36 emission-side rename — this PR keeps emitting `mSPRT_{signal}` so demo `expected_outcome` strings and audit-consumer tests stay intact) and `betting_e_process_{signal}` (emitted as new live records via the `family_A_betting_{signal}` rollback prefix). Legacy `mSPRT_{signal}` records stay loadable via the registry's read-compat aliasing.

**Suppression + eligibility parity (D8, D9).** `ignore_thresholds`, bake-profile, traffic-gate, and schema-continuity semantics are identical for both detectors. Bake-profile + traffic-gate suppress FIRE, not ACCUMULATION — the martingale and CUSUM state evolve regardless so that when eligibility lands both statistics already reflect deploy history. `ignore_thresholds` suppress BEFORE the bet/CUSUM update on that signal so wealth doesn't accumulate on intentionally-ignored observations. Audit records emit per-signal per-detector suppression verdicts under a single Family A block.

**D1 text fold.** `mSPRT.ts` renamed to `page-cusum.ts`; `engine/detectors/mSPRT.ts` keeps a one-line `export *` shim for the one-PR deprecation window. `engine/detectors/hotelling.ts` and `engine/detectors/sequential-mmd.ts` swap their `trafficGateMin` import path to the canonical location. NS-ARCH "truncated mSPRT" phrasing → "Page-CUSUM + betting e-processes"; historical references (e.g., `POSTMORTEM-SHORTLIST-W2.md` "W2 mSPRT parity blocker") left as-is for provenance.

### Addition #23 — Tenant-slice cell-matrix dimension (multi-tenancy closure)

**Modifies:** `engine/types.ts` (`TenantTier`/`TenantTierConfig` types; `CellKey.tenant_tier?`; `CompiledConfig.tenant_tier_map?` + `tenant_tier_config?`; `BaselineCellsConfig.dimensions` accepts `'tenant_tier'`; `FamilyCPerCell.covariance_method` gains `'aggregate_fallback'`; `OrchestrateParams.tenantId?`; new `resolveTenantTier` helper); `engine/orchestrator.ts` (passes `tenantId` to health gate); `engine/gates/health.ts` (`HealthOpts.tenantId` threaded to all detector-family shadow evaluators); `engine/detectors/page-cusum.ts` + `betting-e-process.ts` + `hotelling.ts` + `sequential-mmd.ts` + `conformal.ts` (cell lookup accepts `tenant_tier`; two-stage match falls back to `'aggregate'` tier on miss); `tools/calibrate.ts` (`buildTenantTierMap`, per-tier collection, MCD-floor `aggregate_fallback` covariance, `assignTier` + `hashTenantTierConfig` exports); new canned demo `demos/scripts/demo-tenant-skew.json` + new tests `tenant-tier-bucketing.test.ts` + `cell-matrix-tenant-dimension.test.ts` + `demo-tenant-skew.test.ts` + §A8 right-reasons extension; `audit/SCHEMA.md` v2.1 (DetectorTrip.cell_key gains `tenant_tier`, Provenance gains `tenant_tier_config_hash`).

**Scope.** Implementation shipped 2026-04-20 (ARCHITECT-REPLY-39). Closes PM-feedback Tier-1 #4 (multi-tenancy gap). Cell key extends from `(hour_of_day, day_of_week)` to `(hour_of_day, day_of_week, tenant_tier)` with four default tiers bucketed by per-tenant traffic fraction over the baseline window: `'dominant'` (≥0.50), `'large'` (≥0.10), `'medium'` (≥0.01), `'small'` (<0.01). Boundaries operator-configurable via `CompilerOptions.tenant_tier_config`; manual-override map promotes specific tenants regardless of fraction (VIP escape hatch). The 5th tier `'aggregate'` always emits with cross-tenant pooled stats and serves as the runtime fallback when a request's tier has no per-tier cell, when the tier under-samples, or when the `tenant_tier_map` is absent (pre-#23 configs).

**Cell-matrix size.** Pre-#23 bundles (no tenant_id on runs) compile byte-identically to pre-#23 output: 168 cells (24h × 7d), `dimensions: ['hour_of_day', 'day_of_week']`. Bundles with per-run tenant_id grow to 168 × 5 = 840 cells (24h × 7d × 5 tiers); the four operational tiers cover real tenants and the `'aggregate'` tier carries the cross-tenant pool. Compile time scales linearly with the cell count and stays under the 10-second-per-config gate at the synthetic baseline scale (per-cell covariance is the dominant cost; the new tier loop is a 5× outer multiplier).

**Tier-pool covariance fallback (D3).** Per-tier covariance estimation reuses Addition #18's MCD/MRCD pipeline with REPLY-38's PSD validation. When the per-tier pool falls below the MCD numerical-stability floor of `n ≥ max(5·p, 200)` samples, the cell inherits the across-tier aggregate covariance and the audit records `covariance_method: 'aggregate_fallback'` (a new enum member, strict-additive on the discriminated union). Operators reading the audit see "this cell's data was too sparse for tier-specific covariance; the aggregate Σ was used" rather than misinterpreting an unstable tier-specific Σ as authoritative. No hierarchical-Bayes shrinkage — the aggregate-fallback path is the architect-decided runway choice; shrinkage revisits for follow-on if fleet-scale evidence shows per-tier and aggregate covariances diverge in ways the fallback doesn't catch.

**Privacy invariant.** Audit records (DetectorTrip.cell_key) carry the `tenant_tier` bucket but never the raw `tenant_id`. The provenance block gains `tenant_tier_config_hash` for audit reproducibility — operators can verify the boundaries+overrides didn't change silently between deploys. Per-tenant_id cells are explicitly anti-scope: tiering is the architectural primitive that generalizes across platforms (the target platform/Anthropic/OpenAI tenant_id schemes differ), and per-id cells would create thousands of mostly-empty cells that fall through to LW or aggregate fallback on almost all of them. Operators wanting finer-grained slicing use the `manual_overrides` map.

**Family B unaffected.** Structural signatures (Family B) fire on absolute ratios that don't depend on per-tenant baseline structure; tenant-tier doesn't apply. Family B cells stay at `(hour, day)` keying.

**Demo evidence.** New canned demo `demo-tenant-skew` (Demo 7): three-tenant traffic split (A 80% / B 15% regressing eval_score / C 5%), tenant B's regression starts at t=8 with magnitude `1.5 · δ_min` for eval_score. Portfolio mode catches at t∈[10, 22] via Family A Page-CUSUM on tenant B's `'large'`-tier cell; cascade aggregates eval_score across tenants and the 5%-of-baseline drop stays below cascade's 6% `eval_quality_drop` threshold (CASCADE MISSES). This is the pitch beat closing PM #4's two-word objection: "cascade averages across tenants; sparse-tenant regressions stay below aggregate thresholds. Portfolio evaluates per-tenant-tier."

---

## Architecture additions — baseline-maintenance + SLO substrate (W6+2 batch, docs-only)

Two sections added 2026-04-19 after the build-first posture pivot (TPM-REPLY-26). These formalize two extensions that were implicit in earlier work: the direction-aware baseline-maintenance automation loop that Demo 6 sketches conceptually, and the SLO-derivation substrate that the calibration compiler naturally supports but hasn't yet been specified. Both are **buildable against synthetic/demo scenarios** and slot into the existing post-Tier-1 implementation queue.

Both additions use a **monthly calendar-safety-net refresh cadence** (drift-triggered refresh remains event-driven). This aligns with standard SLO measurement windows (30-day), improves statistical robustness of baseline estimates, and reduces maturity-dashboard noise relative to weekly refresh. Operator can override per-service for active-rollout phases where faster cadence is warranted.

### Addition #15 — Direction-aware baseline-maintenance automation loop

**Modifies:** baseline-maintenance automation loop (previously informally sketched in Demo 6 framing); extends Addition #14 direction-of-better meta-metrics table to drive recalibration-path classification; adds operator-review queue + rejection-preserves-alarms mechanic.

**Problem.** The existing baseline-maintenance loop (drift signal → calibrate → shadow-mode → promote) is direction-agnostic. Drift detector fires on any joint-distribution shift regardless of whether the shift means "service got better" (legitimate automation target) or "service got worse" (potentially silent regression). Auto-promoting a degraded baseline accepts the regression as the new norm — architecturally wrong. Demo 6 works because its trajectory is pure improvement direction; the loop's behavior on degradation direction is undefined.

The real-world case is more subtle than "accept or reject all degradation." Some degradations are legitimate (feature addition increasing cost; hardware cohort shift; traffic-mix change; added safety checks increasing latency). Some are illegitimate (memory leak; tech debt; upstream dependency degradation). The architecture can't distinguish these automatically — operator judgment is required. But the architecture should force the judgment to happen rather than silently accepting the degraded state.

**Fix.** Direction-aware recalibration path classification using Addition #14's direction-of-better metadata:

- **All signals improving** (drift direction matches direction-of-better for every signal in the drifting set): classify as `improvement`. Auto-promote through shadow-mode validation to active baseline. No operator involvement.
- **All signals degrading** (drift direction matches direction-of-worse for every signal): classify as `degradation`. Enter operator-review queue; requires explicit approval with reason code before promotion.
- **Mixed drift** (some signals improving, some degrading): classify as `mixed`. Enter operator-review queue (any signal-level degradation triggers review).
- **Context-dependent signals** (cost_req, tokens_turn, kv_cache, corpus_delta — the 4 informational-only signals from Addition #14): treated as `degradation`-requiring-review by default. Per-service override available for cases where the direction is legitimately expected to rise (e.g., a service where cost_req climbs due to feature complexity growth).

**Recalibration workflow (direction-aware):**

```
Drift signal fires
  ↓
Classify direction (per-signal using Addition #14 metadata):
  - all_improving / all_degrading / mixed
  ↓
Compile candidate baseline (shadow mode; monthly calendar-safety-net OR drift-triggered)
  ↓
Validate against canary traffic for N ticks (shadow-mode parallel with current baseline)
  ↓
Route by classification:
  ┌── improvement → auto-promote → maturity dashboard event: "improvement recalibration v_N → v_{N+1}"
  │
  ├── degradation → operator-review queue:
  │   • Proposed baseline diff (which signals moved how much; direction per signal)
  │   • Suggested reason codes: feature_complexity_growth | hardware_cohort_shift |
  │     traffic_mix_change | safety_check_addition | upstream_dependency | other_legitimate | regression
  │   • Timeout: 14 days untouched → escalation event + default-reject
  │   • Operator outcomes:
  │     - Approve with reason code → promote; audit records operator_id + reason_code
  │     - Reject → baseline unchanged; gate continues firing against original baseline;
  │       regression surfaces as ongoing alarms until fixed (see below)
  │
  └── mixed → operator-review queue (same path as degradation)
```

**Rejection-preserves-alarms mechanic.** Key architectural invariant: when operator rejects a degradation-direction recalibration, the gate's old tighter baseline stays active. For ongoing deploys, detectors continue comparing against the old norm. If the service really has degraded, Family A mSPRT keeps firing on every deploy because current reality is outside the old baseline's statistical envelope. The gate becomes a persistent signal that the service has degraded below its historical norm — alarms keep firing until (a) the service gets fixed, (b) operator re-opens the decision with a reason code, or (c) engineering leadership sees the pattern on the maturity dashboard and makes a business-level call. Without this invariant, rejection is toothless; with it, the architecture prevents silent regression acceptance at scale.

**Timeout behavior.** Default 14 days untouched in the review queue → escalation event emitted to engineering-leadership view + default-reject (keep firing alarms until human acknowledges). Prevents queue rot. Per-service timeout configurable.

**Monthly calendar-safety-net refresh.** Even if the drift detector doesn't fire, the baseline refreshes once per calendar month against the trailing 30-day healthy-traffic window. Safety net for slow drift that accumulates below detector threshold. Calendar refresh goes through the same direction-aware classification — if the month's drift is improvement-direction, auto-promote; if degradation, operator-review.

**Contract surface change:**
- `RecalibrationCandidate`: `{proposed_baseline_version, current_baseline_version, direction_classification: 'improvement' | 'degradation' | 'mixed', per_signal_direction: Record<signal_id, 'improved' | 'degraded' | 'unchanged'>, suggested_reason_codes: string[], shadow_mode_validated_at, timeout_at}`.
- `RecalibrationApproval`: `{candidate_id, operator_id, reason_code, approved_at}`.
- `RecalibrationOutcome`: `'auto_promoted' | 'operator_approved' | 'operator_rejected' | 'timeout_rejected' | 'shadow_mode_failed'`.
- `AuditRecord` gains optional fields for recalibration events: `recalibration_event?: {candidate_id, outcome, operator_id?, reason_code?}`.

**Scope.** Docs-only this batch. Implementation post-Tier-1 (estimated ~1 week): drift-classification logic extending the existing drift detector; operator-review queue with timeout enforcement; per-service reason-code catalog; maturity-dashboard event emission for auto-promotions and operator approvals; integration test with synthetic degradation + rejection + persistent-alarms validation.

**Interaction with other additions:**
- **Addition #11 (`suppressed_insufficient_samples`):** when operator rejects a recalibration and old baseline fires alarms on every deploy, some deploys may legitimately have insufficient samples; those still resolve to `suppressed_insufficient_samples` rather than auto-firing.
- **Addition #14 (lifecycle events):** direction-aware loop emits structured events (`recalibration.proposed`, `recalibration.shadow_validated`, `recalibration.operator_approved`, `recalibration.operator_rejected`, `recalibration.auto_promoted`, `recalibration.timeout_rejected`) on the same lifecycle surface as evaluation events.
- **Addition #16 (SLO substrate, next):** SLO target suggestions get re-derived after every recalibration; operator sees both the proposed baseline AND the proposed SLO adjustments in a single review surface.

**Open architect-side questions (flag if they surface during implementation):**
1. **Reason-code catalog governance.** Who owns the list of legitimate reason codes per service? SRE policy surface; probably operator-configurable with architect-provided defaults. Follow-on tuning.
2. **Mixed-drift routing.** Currently specifies operator-review queue for any mixed drift. Alternative: only-degradation-signals-in-mixed trigger review; improvement signals auto-promote separately per signal. More granular but more complex. Start simple (any mixed → review); revisit if operator workload surfaces a need.
3. **Per-service timeout default.** 14 days is architect default; per-service override. Consider separate short-timeout (1–2 days) for high-risk-tier deploys where indecision cost is higher.

### Addition #16 — SLO substrate (baseline-derived SLO suggestions + error budget math)

**Adds:** new calibration compiler output `SLOSuggestions` as a sibling to `CompiledConfig`; extends Addition #3 metric registry (M0) with an SLO tier above the SLI tier; formalizes monthly SLO measurement window aligned with baseline refresh cadence; adds SLO compliance tracking and error budget math to the audit stream.

**Problem.** The calibration compiler today emits `CompiledConfig` (detector thresholds) from `baseline + α budget + direction-of-better`. It has exactly the information needed to also derive SLO suggestions (target threshold + compliance percentage + measurement window + derived error budget) — but the project doesn't emit them. SREs declaring SLOs today work from intuition or external dashboards; the compiler could automate target derivation from observed baselines, matching the SRE Workbook SLO framework computationally rather than by-hand. Separately, no existing component tracks SLO compliance over time — the maturity dashboard's "service-maturity trajectory" beat is richer with compliance-against-SLO data alongside baseline-trend data.

**Fix — three parts.**

**Part 1 — Compiler emits `SLOSuggestions` as a sibling artifact.** For every signal in the metric registry, the compiler derives three candidate SLO tightness levels:

| Tightness | Target threshold (for "lower better" signals) | Interpretation |
|---|---|---|
| Strict | `μ + 1σ` | SLO that 84% of healthy traffic satisfies at baseline. Aggressive; for services already running tight. |
| Practical | `μ × (1 + δ_min)` | SLO at the practical-significance boundary — violations are operationally meaningful. Default recommendation. |
| Loose | `μ + 2σ` | SLO that 97.5% of healthy traffic satisfies. Conservative; for services with high variance or unclear customer expectations. |

For "higher better" signals (mfu, eval_score, tool_success_rate, collective_ops): flip the direction — `μ − 1σ`, `μ × (1 − δ_min)`, `μ − 2σ`.

For "informational-only" signals (cost_req, tokens_turn, kv_cache, corpus_delta): no SLO suggestions (direction-of-better is context-dependent; operator declares target manually if they want an SLO).

Each suggestion includes: target threshold, compliance percentage (computed from baseline distribution via `1 − P(signal outside threshold)`), measurement window in days (monthly default; aligns with baseline refresh cadence), derived error budget in minutes (`(1 − compliance%) × measurement_window`), derivation rationale (human-readable explanation of the math).

**Part 2 — Metric registry gains SLO tier.** Addition #3 M0 metric registry gains a new tier above the existing Tier-1 SLIs:

- **Tier 0 (new): SLOs.** SRE-accepted SLO definitions per signal per service. Populated from compiler's `SLOSuggestions` after operator review. Each SLO entry: `{signal_id, target_threshold, compliance_percent, measurement_window_days, error_budget_minutes, accepted_by, accepted_at, source: 'suggested_strict' | 'suggested_practical' | 'suggested_loose' | 'custom'}`.
- **Tier 1 (existing):** SRE-declared SLIs.
- **Tier 2 (existing):** Auto-included structural signals.
- **Tier 3 (existing, post-L5):** Predictive-power-ranked candidates.

SLO workflow: compiler emits suggestions → SRE dashboard renders three tightness options per signal → SRE picks one (or specifies custom) → accepted SLOs land in Tier 0 registry → ongoing compliance tracked from audit stream.

**Part 3 — SLO compliance tracking + error budget math in audit stream.** Audit records gain per-tick SLO compliance status:

- `slo_compliance_per_signal: Record<signal_id, {slo_target, observed_value, in_compliance: boolean}>` on every audit record.
- Rolling error budget consumption: aggregated from audit stream over the measurement window; surfaced as `error_budget_consumed_minutes` and `error_budget_remaining_minutes` on the maturity dashboard.
- Compliance trajectory view: "service X hit 99.9% p99 SLO for 3 consecutive months; trending stable" or "service Y compliance dropping, on track to exhaust error budget in 8 days."

**Monthly measurement window alignment.** SLO measurement window = baseline refresh cadence = 30 days (monthly). Direct alignment means each SLO report covers exactly one baseline version (no sliding-baseline compliance math). When a recalibration occurs (via Addition #15), SLO suggestions re-derive from the new baseline; SRE reviews the proposed SLO adjustments alongside the proposed baseline in the same review surface.

**Contract surface change:**
- `SLOSuggestions` (new compiler output, sibling to `CompiledConfig`): `{compiled_at, compiled_config_version, baseline_ref, per_signal: Record<signal_id, {suggestions: Array<{tightness, target_threshold, compliance_percent, measurement_window_days, error_budget_minutes, derivation_rationale}>, operator_selected?: SuggestionID}>}`.
- `MetricRegistry` (Addition #3) gains `slosForService(service_id): Array<SLODefinition>` method for Tier 0 access.
- `AuditRecord` gains `slo_compliance_per_signal?: Record<signal_id, {slo_target, observed_value, in_compliance}>` optional field.

**Scope.** Docs-only this batch. Implementation post-Addition-#15 (estimated ~1 week):
- Compiler extension (~2 days): `SLOSuggestions` derivation logic; three tightness levels per signal with direction-of-better awareness; compliance-math helpers.
- Audit extension (~1 day): per-tick SLO compliance field emission; rolling error budget counter.
- Maturity dashboard extension (~2 days): SLO trajectory + error budget views on the baseline-history archive.
- Tests (~1 day): analytical SLO derivation on known distributions; error budget arithmetic; multi-baseline-version compliance rollup.

**Interaction with other additions:**
- **Addition #3 (metric registry M0):** gains Tier 0 for SLOs above existing SLI tier.
- **Addition #14 (direction-of-better):** directly drives the sign of SLO target threshold adjustment.
- **Addition #15 (direction-aware baseline loop):** recalibration events trigger SLO-suggestion re-derivation; operator reviews baseline change and SLO change together.
- **Addition #11 (`suppressed_insufficient_samples`):** compliance tracking treats suppressed ticks as neither compliant nor non-compliant (excluded from rolling percentage).

**SLO vs detector threshold — different constructs.** Worth flagging architecturally to pre-empt the question: Family A mSPRT's threshold answers "when does a deploy fire `rollback`?" (deploy-time question about whether a change caused regression). SLO target answers "is current behavior within acceptable bounds?" (ongoing question about absolute service-level behavior). Both derivable from the same baseline + α substrate but measuring different things. A service can simultaneously satisfy its SLO AND have a deploy fire a detector (small shift detectable by mSPRT even though absolute value stays inside SLO) — both signals valid. Conversely, a service can violate its SLO AND have no deploy fire a detector (baseline crept above SLO over time, no individual deploy crossed detector threshold). The SLO substrate catches that class; detectors catch the deploy-attributable class.

**Open architect-side questions:**
1. **Target-tightness default.** Spec offers three options; practical (δ_min-based) is the architect-suggested default. SRE-policy-configurable per service.
2. **Multi-signal SLO correlation.** Error budget math assumes per-signal independence. Correlated signals (p99 and downstream_err) have joint violation probabilities that aren't the product of marginals. Follow-on Q2 extension: covariance-aware joint SLO with Family C's covariance matrix as input.
3. **Sliding-baseline vs fixed-baseline SLO compliance.** With monthly refresh + monthly measurement window, each SLO report covers exactly one baseline. But what if a service's SLO is defined against a specific baseline version (e.g., the initial baseline at onboarding) rather than the current active one? "Point-in-time" SLO definitions are a separate concept from "current-baseline-tracking" SLOs; spec addresses the latter. Point-in-time SLOs are a follow-on extension if customers demand.

### Addition #28 — Reference workload profile library (ARCHITECT-REPLY-51)

Config-layer template library (§L0b above). Three v1 profiles live at `profiles/*.yaml`: `llm-inference-streaming` (primary DS target; matches current compile defaults exactly), `llm-inference-batch` (extends streaming; excludes TTFT; reallocates Family C α), `generic-microservice` (non-LLM fallback; Family A only). Schemas at `profiles/schema/*.json`. Loader at `tools/profile-loader.ts`.

`CompilerOptions.profile_ref?: string` (format `<id>@<semver>`) + `CompilerOptions.customer_override_ref?: string` (optional path to customer override YAML) drive the compile. Both propagate to `CompiledConfig` for audit provenance. Legacy compiles (no profile refs) keep existing constants — byte-identical to pre-#28 main. Profile-routed compiles with `llm-inference-streaming@1.0.0` are byte-identical to legacy (backward-compat anchor — verified by `test/profile-v1-set-smoke.test.ts`).

### Addition #29 — Anvil chaos-verdict packaging (PRD-29, Q29)

The DS substrate already produces FP-controlled verdicts on the forward direction (deploy → telemetry → verdict). **Anvil** packages that same substrate as a chaos-engineering-verdict product targeting Verica-style buyers. Four chaos-platform O0 adapters (`engine/o0/anvil/{gremlin,chaos-mesh,aws-fis,litmus}.ts`) implement `ChaosOrchestrationAdapter` (extends `OrchestrationAdapter` from Addition #9 with `fetchExpectedFailurePattern`). One reference profile `anvil-chaos-experiment@1.0.0` (extends `generic-microservice@1.0.0`) ships under `profiles/`. No `engine/detectors/*` runtime touch — Q2.B.6.4 ADR clauses 1–5 preserved.

**`DeployContext` contract extension (PRD-29 FR-1).** The Addition #9 `DeployContext` interface gains an optional `expected_failure_pattern` field:

```ts
interface DeployContext {
  // ... existing fields ...
  expected_failure_pattern?: {
    kind: string;                       // 'latency_injection' | 'cpu_stress' | …
    affected_signals: string[];
    magnitude: number;
    magnitude_unit: 'relative_fraction' | 'absolute' | 'sigma';
    recovery_seconds: number;
    suppress_families: ('A' | 'B' | 'C' | 'D' | 'E')[];
    fault_start_unix: number;
  };
}
```

Transitional stand-in until Addition #9 materializes the typed `DeployContext` interface: `OrchestrateParams.expectedFailurePattern?: ExpectedFailurePattern` (mirrors Addition #10's `expectedCanaryWeight`).

**Verdict vocabulary mapping (Q29.2 architect-pick: adapter-boundary, not engine).** Engine native vocabulary → chaos adapter renames on `emitVerdict` per `DeployContext.strategy === 'chaos_experiment'`:

| Engine verdict | Chaos verdict |
|---|---|
| `proceed` | `experiment_passed` |
| `rollback` | `experiment_failed_unexpectedly` (audit annotation `firing_family_in_suppress_set: bool` distinguishes "expected fault produced expected signal" from "unexpected blast on non-suppressed family") |
| `extend` | `experiment_still_running` |
| `suppressed_insufficient_samples` | `experiment_inconclusive` |

**Expected-fault family suppression.** When the current tick lies within `[fault_start_unix, fault_start_unix + recovery_seconds]` and `suppress_families` is populated, the named families return `verdict: 'suppressed'` with `suppression_reason: 'expected_failure_pattern'`. Outside the window, normal detector eligibility applies. The check is O(1) per tick and gated on `expectedFailurePattern !== undefined`, so the pre-Anvil path is byte-identical (PRD-29 AC-11).

**Reference profile `anvil-chaos-experiment@1.0.0`.** Family A + Family C default (Q29.3 architect-pick); B/D/E off. Profile-level `expected_failure_pattern_defaults` block carries `default_suppress_families`, `default_recovery_seconds`, `default_magnitude_unit` for chaos runs whose adapter doesn't supply per-experiment overrides. α split: A=7·10⁻⁴ + C=3·10⁻⁴, total 1·10⁻³.

**Scope.** Spec + typed-contract surface + four adapter stubs + profile + docs. Adapter network-call implementations + end-to-end demo are follow-on per PRD-29 priority. Anvil's v1 wedge is the verdict-surface positioning + the audit substrate (replay-clean per FR-6), not the chaos-platform integrations themselves (those are commodity).

**Interaction with other additions:**

- **Addition #9 (O0 adapter layer):** Anvil's four adapters live alongside the canary-direction adapters and share the `OrchestrationAdapter` contract.
- **Addition #10 (SRM):** chaos experiments have no canary fraction; SRM check is a no-op when `DeployContext.strategy === 'chaos_experiment'` (no `expectedCanaryWeight` populated).
- **Addition #11 (`suppressed_insufficient_samples`):** maps cleanly to chaos vocab `experiment_inconclusive`.
- **Addition #28 (profile library):** `anvil-chaos-experiment@1.0.0` joins the v1 profile inventory as the fourth reference profile.

**Interaction with Tessera (sibling product).** [Tessera](https://github.com/johnpatrickwarren-oss/tessera) vendors the DS engine at SHA `5a72371` and ships per-shard observation primitives + topology-aware freeze-hook + e-BH FDR control for cluster scope. Tessera's per-shard surface lines up exactly with shard-targeted chaos experiments (pod-kill on shard-04, network-partition on rack-2, latency-injection on a tenant subset). The DS-Anvil **buyer bundle** comprises three components: (a) the DS engine (this repo — verdict layer); (b) Tessera (sibling repo — per-shard observation layer); (c) the chaos-adapter family (`engine/o0/anvil/`, this addition). Cluster-scope chaos runs consume Tessera's per-shard feed via the existing Tessera-side HTTP contract at `engine/ds-integration/` (`POST /v1/tessera/verdict-groups` Tessera→DS; `POST /v1/tessera/deploy-events` DS→Tessera). No new contract surfaces required at Anvil v1 — the existing Tessera↔DS contract carries the per-shard verdict observations cleanly; Anvil's chaos adapters populate `DeployContext.expected_failure_pattern` at experiment-start so the per-shard verdicts on Tessera's side suppress correctly for the duration of the fault window. Tessera-side `engine/ds-integration/event-contract.ts` already carries the `event_class` closed-set; chaos-experiment event-class extension to that contract is a future cross-repo amendment (Tessera-side R63+ design cycle), not Anvil v1 scope.

**Anti-scope (per PRD-29 + ANTI-SCOPE-LEDGER Q29 entry):** no per-experiment detector retraining (L5 scope); no chaos-platform authoring UX (DS doesn't own those surfaces); no live customer-tenancy chaos runs (enterprise-infrastructure boundary); no fifth platform at v1; no continuous-chaos streaming; no new chaos-specific detector family; no Tessera-side contract amendment (cross-repo, deferred to Tessera Phase 4 design cycle). Q2.B.6.4 ADR clauses 1–5 verified preserved.

### Addition #30 — Cairn structured-RCA / postmortem attribution (sibling product, see https://github.com/johnpatrickwarren-oss/cairn)

**Status:** v1 originally landed inside this repo via DS PR #21 (2026-05-21). Extracted to a sibling repo at **https://github.com/johnpatrickwarren-oss/cairn** for architectural consistency with the rest of the bundle (DS engine + Tessera + Cairn — three sibling products, one shared statistical substrate). PRD-30 + Q30 spec + 23 tests + CLI + demo + walkthrough doc all live there now; DS-side artifacts deleted in the extraction PR.

The DS substrate produces verdicts at gate-time (DS proper) and packages them for chaos experiments (Anvil, Addition #29); the sibling [Tessera](https://github.com/johnpatrickwarren-oss/tessera) observes per-shard during steady state; the sibling [Cairn](https://github.com/johnpatrickwarren-oss/cairn) closes the lifecycle loop with postmortem attribution.

**Lifecycle-loop framing (load-bearing pitch beat):**

> DeploySignal catches before promotion. Tessera observes during steady state. Cairn attributes when something escapes both — statistically, not by eyeballing dashboards.

Strong Verica/Casey adjacency: chaos engineering's whole point is "find weaknesses before they cause incidents"; Cairn is the complement: "when an incident does happen, attribute it to specific weaknesses rigorously."

**Mechanism (Q30 §2 of the Cairn repo).** Cairn is a scoring layer that consumes audit streams from DS / Tessera / Anvil + generic external events. Given an `IncidentDefinition` (onset time + affected signals + optional engine-inferred onset distribution) and a set of `AttributionCandidate`s, Cairn computes a per-candidate Bayesian alignment score:

```
s(c) = K(Δt, σ_kind) × π(kind) × e(c)
posterior(c) = s(c) / Σ s(c')
```

Three multiplicative terms: timestamp-alignment Gaussian kernel (per-kind σ defaults — deploys 30 min; chaos 5 min; dependency 2 hr; env 6 hr; shard 15 min; generic 1 hr), per-kind prior, and evidence-quality boost driven by DS verdict adjacent to the candidate (`proceed` → 0.5 negative evidence; `extend` → 1.5; `rollback`-overridden → 2.0). Mechanistic-inconsistency suppression excludes post-incident candidates. Engine-inferred onset preference combines engine uncertainty + per-kind kernel via quadrature when an `incident.engine_onset_estimate` is supplied.

**Bundle interaction.** Cairn consumes the existing wire shapes — DS audit JSONL, Tessera `VerdictGroupPayload`, Anvil `ExpectedFailurePattern` records — via four ingest helpers. No new contract surfaces required at Cairn v1; no Tessera-side change. Cross-repo dependency direction is one-way: Cairn reads bundle audit streams; nothing in DS / Tessera / Anvil imports Cairn.

**Honesty discipline (load-bearing for the pitch).** Cairn does **alignment-based ranked attribution**, not Pearl-style causal inference. Output language uses "ranked attribution of timing-consistent candidates," never "root cause."

**Anti-scope (per Cairn-repo PRD-30 + Q30 + ANTI-SCOPE-LEDGER Q30 entry):** no new detector family (Q2.B.6.4 preserved); no causal-inference framing; no live incident-mgmt webhook adapters at v1; no multi-incident batch RCA; no narrative auto-gen; no web UI; no streaming.

### Addition #Q2.B — Calibration coherence (Phase-2 commitment per ARCHITECT-REPLY-52gk)

Single-source per-cell μ_vec across all detectors at compile time; Σ_C regularization via shrinkage to aggregate (Ledoit-Wolf 2004 style); μ stays per-cell always. Closes the calibration-source incoherence between Family A's per-cell `baseline_mean` and Family C's aggregate-fallback `mean_vector` surfaced by post-Cholesky parametric H₀ test (REPLY-52gi → 52gk). Family D kv_cache miscalibration investigation absorbed in same Phase-2 batch (may share root cause). Family D autocorrelation-aware parametric methodology (AR(1)/VAR(1)) deferred to same batch. Q2.A signal-class registry (logit-transform for bounded-probability) remains separate Phase-2 commitment. Architect to draft full implementation brief; reference: ARCHITECT-REPLY-52gk Q2.B.4 mechanism.

Integration semantics in `tools/calibrate.ts`:
- `effective_config = deepMerge(profile, override.overrides)` drives `alpha_budget.per_family` (replaces the hardcoded 40/20/20/10/10 FRACTION constants) and `bake_profiles` (overrides `BAKE_PROFILE` entries for matching signals; `_default` preserved).
- `effective.sli_list`, `effective.joint_vector`, `effective.structural_detectors`, `effective.cell_dimensions`, `effective.policy_defaults` are currently audit-only provenance (structured access via `loadProfile(profile_ref)` at read time). Dynamic routing of these fields through the compile path is follow-on scope.
- `args.alpha` must equal `effective.alpha_allocation.total` when `profile_ref` is present; mismatch throws at compile time (force-explicit contract per Q1 strict policy).

Inheritance + override semantics (D4 / D8): single-parent `extends:` with cycle detection; scalars replace; arrays replace entirely (NOT append); objects deep-merge with child precedence; `null` on child disables parent. Overrides CANNOT introduce fields absent from the base profile schema (D8 no-new-fields, schema-enforced).

Semver policy (D5): MAJOR = breaking field changes; MINOR = additive optional; PATCH = default-value tweaks. Profile file names carry only the id — historical versions live in git history. Version mismatches between ref and resolved file throw (Q1).

**Interaction with other additions:**
- **Addition #3 (Metric Registry M0):** Pre-M0, #28 IS the Tier 1 + Tier 2 defaults surface. Post-M0, the profile library becomes a seed catalog (customers "start from `llm-inference-streaming@1.2.0`" as their seed); M0 takes over as the persistence + override surface. The #28 schema remains valid; its role narrows.
- **Addition #23 (tenant-tier dimension):** inherited transparently via `effective.cell_dimensions.tenant_tier` (v1 profiles set this per-workload — streaming + batch on, generic off).
- **Addition #16 (SLO substrate):** `policy_defaults.reversibility_threshold_minutes` + `default_risk_tier` currently audit-only provenance; follow-on scope includes routing these into the SLO derivation.

**Anti-scope:** no Addition #3 M0 implementation; no multi-parent inheritance; no override chains; no v2 profiles (rag-pipeline, training-to-serving, data-plane); no hardcoded profile content in engine code; no compile-perf changes (REPLY-50 scope).

---

## P4 Dual-Source-Coherence Discipline

The DeploySignal compile-and-runtime architecture surfaces a class
of architectural-correctness gaps where two sources need to agree —
between calibrators (Family A's μ_A vs Family C's μ_C; σ²_A vs Σ_C
diagonal); between compile-time math and runtime detector consumption;
between validation methodology and detector design. Each surfaced as
an empirical Ville-bound violation during Phase-2 work; each closes
via a discipline class that should be applied at brief-drafting time.
The discipline classes are formalized as P4-α (calibration-source
symmetry) and P4-β (compile-vs-runtime-vs-spec-vs-methodology
symmetry). Memorial: `.auto-memory/feedback_architect_cross_family_audit.md`
P4-α + P4-β formalization.

### P4-α calibration-source symmetry

For any unification of calibration values (μ, σ², covariance) across
detectors that share a cell, walk through EACH source class
symmetrically. Don't assume coherence falls out from one source alone.
Closed for μ at Q2.B.4 (per-cell μ_C ← per-cell empirical mean across
all detectors); closed for σ² at compile time at Q2.B.5 (Family A's
raw-space σ²_A derived from Family C's Σ_C diagonal on overlapping
signals).

### P4-β compile-vs-runtime-vs-spec-vs-methodology symmetry

Seven sub-axes formalized through Phase-2 work:

- **β.1 Distribution alignment** (Q2.B.5 spec gap → Q2.B.6a closure):
  Compile-time math produces Σ_blended; runtime under iid bootstrap
  consumes Σ_pc; mismatch surfaces empirical Ville-bound violation.
  Verify validation methodology samples come from a distribution
  consistent with the calibrated source.

- **β.2 Value-space alignment** (Q2.B.5 spec gap → Q2.B.6c.μ closure):
  Compile-time WRITE targets one field semantics (e.g., raw); runtime
  READ consumes different semantics (e.g., logit-transformed). Per-class
  transforms (Q2.A) introduce per-signal semantic divergence within
  shared field names.

- **β.3 Cell-selection alignment** (Q2.B.6c root cause): validation
  methodology selects one cell for sample generation; runtime detector
  consumes a different cell for evaluation. Tier-aware fallback semantics
  must be symmetric across calibration and runtime cell-resolution paths.

- **β.4 Integration-state coverage** (Q2.B.6+Q2.B.7 integration regression
  → Q2.B.6.1 integration-state-audit closure): each PR's acceptance
  scoped against single-PR substrate; integrated-main substrate state
  unverified at PR ship. When concurrent PRs touch interacting surfaces,
  acceptance criteria must include integrated-main re-verification +
  compile-time invariant audit.

- **β.5 Evaluation-scope alignment** (Q2.B.7 calibration-scope mismatch
  → Q2.B.6.1 Step 5 + Q2.B.6.2 + Q2.B.6.3 closures): compile-time
  bootstrap calibrates threshold against single-evaluation H₀
  distribution; runtime detector evaluates same statistic across sliding
  buffer (~80 evaluations per trajectory). Per-trajectory FPR ≠
  per-evaluation calibration α. Template-reproducible across detector
  families: bootstrap-MAX-statistic-quantile applied uniformly to
  Family D spectral, Family C Hotelling safe_test, Family A betting.

- **β.6 Acceptance-criteria-vs-fix-mechanism scope alignment** (Q2.B.6.1
  Outcome-B + Q2.B.6.4 Path-A halt): spec acceptance criteria list
  multiple surfaces; spec implementation mechanism only touches subset
  of those surfaces. Aspirational acceptance gates that are
  architecturally unreachable by the spec's fix mechanism produce
  false-completion. At brief-drafting time, verify per acceptance
  criterion that the fix mechanism CAN architecturally reach that
  criterion's surface.

- **β.7 Methodology-vs-detector-design alignment** (Q2.B.6.4 Path-A halt;
  Phase-3 per-detector iid_bootstrap pool commitment): validation
  methodology surface stresses TP/FP trade-off detector design didn't
  anticipate. Detector calibrated against one methodology surface
  (typically parametric H₀ for formal-property tests); validation also
  runs detector against a different methodology surface (operational-
  shape-divergence tests like iid_bootstrap-shared-pool). Concrete
  instance: Family E weighted-conformal Mahalanobis novelty detection
  designed for parametric H₀; iid_bootstrap-shared-pool methodology
  produces 24/131 FPR because shared-pool samples lack spatial-
  correlation structure Family E calibrated against. Phase-3 commitment
  per ADR `coordination/ARCHITECT-REPLY-Q2-B-6-4-PATH-A-HALT-DISPOSITION.md` (internal coordination doc, not included in this public repo):
  per-detector iid_bootstrap pool restructure (~150 LOC) for clean
  closure of methodology-stress class.

P4-β audit step generalizes to ALL compile-time invariant verification
(PSD, well-conditioned, internally consistent, scope-aligned, source-
coherent, methodology-aligned, template-applicable). Compile-time
invariant audit is a high-leverage discipline mechanism that catches
what spec-drafting analytical reasoning misses.

---

## Contract surfaces (stable interfaces)

These are the boundaries that don't change when layers are rewritten. Everything behind them is replaceable.

- **`SignalStream`** (L0 output): the typed per-signal ingestion stream. Extended in addition #8 with `schema_hash`, `schema_continuity`, `schema_baseline_ref`; in addition #10 with `traffic_allocation_continuity`; in addition #12 with optional `pod_id`.
- **`SignalSnapshot`** (L1 output): the multi-scale characterization bundle per signal.
- **`DetectorVerdict`** (L2 family output): `{verdict, statistic, threshold, alpha_consumed, reason_code, provenance}`. `suppression_reason` enum extended in additions #8 (schema continuity classes), #11 (`insufficient_samples`), #13 (`ignore_threshold`).
- **`FusedVerdict`** (L3 output): `{verdict: rollback|extend|proceed|suppressed_insufficient_samples, families, total_alpha_consumed, tick, deploy_ref}`. `verdict` enum extended in addition #11 with `suppressed_insufficient_samples`.
- **`CompiledConfig`** (CC output): the versioned bundle the runtime consumes. Extended in addition #2 with `baseline_cells` (cell matrix with hierarchical pooling and per-cell confidence tags, optionally `pod_id`-dimensioned per addition #12), in addition #4 with `bake_profiles` (per-signal `{min_ticks_before_eligible, min_observation_window, max_deploy_window_days, min_samples_for_evaluation}` — last field added per addition #11), in addition #28 with optional `profile_ref` + `customer_override_ref` strings for workload-profile provenance (§L0b).
- **`AuditRecord`** (L4 emission): one per tick, one per verdict-emission event. Extended in addition #5 with `reversibility` and `reversibility_source`; in addition #10 with `traffic_allocation_continuity`; in addition #12 with `granularity` (`'per_pod' | 'cohort'`). `short_circuit` enum extended in addition #10 (`'srm'`), #13 (`'policy_fail_fast'`), and existing `'policy_incident'` (addition #6).
- **`OrchestrationAdapter`** (O0 interface, addition #9): `{emitVerdict(verdict, deploy) → EmitResult, fetchDeployContext(deploy) → DeployContext, emitLifecycleEvent(event_type, payload) → Promise<void>}`. Last method added per addition #14. Implemented per orchestrator (Argo Rollouts first; Flagger, Spinnaker for follow-on). Addition #5 specifies how the adapter interprets `rollback` verdicts per `DeployContext.reversibility`; addition #11 specifies how adapters translate `suppressed_insufficient_samples` to orchestrator-specific actions.
- **`DeployContext`** (O0 → G1 input, additions #9, #1, #7): `{deploy_id, deploy_ref, strategy, current_step, total_steps, canary_weight, reversibility, change_type, risk_level, author, labels, annotations, reference_cell_ref, propensity_score_match, switchback_policy}`. `canary_weight` is the comparison basis for SRM checks per addition #10. Populated by the adapter from orchestrator state; consumed by G1 policy gate.
- **`BakeProfile`** (per-signal, additions #4 + #11): `{signal_id, min_ticks_before_eligible, min_observation_window, max_deploy_window_days, min_samples_for_evaluation}`. Last field added per addition #11. Consumed by detector eligibility gating at each tick.
- **`MetricRegistry`** (M0 read-only surface, addition #3): `{slisForService, structuralSignalsForDetectors, predictiveRankings, accessControl}`. Pre-L5: operator-configured Tier 1 + detector-library-driven Tier 2. Post-L5: outcome-labeled Tier 3 ranking surfaces. Governance via platform governance-layer ACL at production scale.
- **`IncidentState`** (G1 policyContext input, addition #6): `{mode, active_incidents, cooldown_remaining_hours, source}`. Four modes: `clear`, `active_sev_2`, `active_sev_1`, `recent_incident_cooldown`. Sourced from PagerDuty / Opsgenie / internal system; platform-team wiring required.
- **`PolicyContext`** (G1 policyContext, additions #6 + #13): includes `incident_state` (addition #6), `fail_fast_thresholds: Record<signal_id, number>` (addition #13), `ignore_thresholds: Record<signal_id, {min?, max?}>` (addition #13). Operator-set per service.
- **`LifecycleEventType`** and **`LifecycleEventPayload`** (O0 emission, addition #14): five event types `evaluation.triggered | .started | .tick | .suppressed | .finished` with typed payload per type. Adapters route to orchestrator-native event surfaces (Kubernetes Events for Argo Rollouts, pipeline notifications for Spinnaker, webhook POST for custom, the model-lifecycle tooling tags for production deployment). Addition #15 extends with six recalibration event types (`recalibration.proposed | .shadow_validated | .operator_approved | .operator_rejected | .auto_promoted | .timeout_rejected`).
- **`RecalibrationCandidate`** and **`RecalibrationOutcome`** (baseline-maintenance loop, addition #15): `{proposed_baseline_version, current_baseline_version, direction_classification, per_signal_direction, suggested_reason_codes, shadow_mode_validated_at, timeout_at}` plus outcome enum `'auto_promoted' | 'operator_approved' | 'operator_rejected' | 'timeout_rejected' | 'shadow_mode_failed'`. `AuditRecord` gains optional `recalibration_event` field.
- **`SLOSuggestions`** (new compiler output, sibling to `CompiledConfig`, addition #16): `{compiled_at, compiled_config_version, baseline_ref, per_signal: Record<signal_id, {suggestions: Array<{tightness, target_threshold, compliance_percent, measurement_window_days, error_budget_minutes, derivation_rationale}>, operator_selected?: SuggestionID}>}`. Monthly measurement window default.
- **`SLODefinition`** (M0 Tier 0, addition #16): `{signal_id, target_threshold, compliance_percent, measurement_window_days, error_budget_minutes, accepted_by, accepted_at, source}`. Populated via SRE review of `SLOSuggestions`. `MetricRegistry` gains `slosForService` accessor for Tier 0 access.
- **`AuditRecord` SLO compliance extension** (addition #16): optional `slo_compliance_per_signal: Record<signal_id, {slo_target, observed_value, in_compliance: boolean}>` per-tick field. Rolling error budget consumption aggregated from audit stream for maturity dashboard.

Versioning: each contract is semver'd. Breaking changes require a schema migration in the audit reader and a compatibility layer on the runtime side. Additions #10–#16 are all backward-compatible extensions; v2 consumers continue to work against emitted records.

---

## How this differs from existing tools

**Netflix Kayenta** runs a statistical test (Mann-Whitney U, etc.) comparing canary vs baseline at query time. Useful, but per-deploy — no cross-deploy baseline management, no variance reduction, no explicit α budget, no multivariate test, no novelty channel.

**Argo Rollouts / Flagger** are progressive-delivery orchestrators. They hit metric providers and apply threshold rules. They are _not_ decision engines — the intelligence has to live somewhere else. This system would sit inside their "analysis template" slot, but be radically more sophisticated than what those tools typically contain.

**Datadog Watchdog / New Relic Applied Intelligence / Anodot** are ML-based anomaly detectors. Opaque scores, vague confidence, no α guarantees, no compile-time thresholds. Good at catching things; bad at explaining _why_ and bad at composing with domain-specific knowledge.

**LinkedIn / Meta / Google internal deployment tooling** — best-in-class, but closed. The public writeups suggest statistical SPC-flavored approaches similar to parts of this architecture, but the compiler-and-portfolio combination is not, to my knowledge, in the public literature.

**What's genuinely new here:**
1. The calibration compiler as a first-class artifact. Thresholds are derived, not tuned.
2. A detector portfolio with explicit α allocation, not a cascade.
3. Native composition of AI-inference structural signatures with general-purpose statistical tests.
4. Conformal novelty as a budgeted family with formal guarantees, not an opaque ML score.
5. Learning closes on real outcomes, not on a synthetic scoreboard.

---

## The target platform fit

The architecture is generic, but it's tuned for the shape of what production scale actually runs.

**Two workload planes, one engine.** Data plane (a distributed-compute engine, the table-storage layer, the platform governance layer — failure signatures around shuffle skew, concurrency, plan regressions, query-cost drift) and serving plane (the managed AI platform, large-model inference, training — the AI-inference signatures DeploySignal already handles). The structural-signature family (B) has different detector shapes per plane, but the statistical families (A, C, D, E) and the calibration compiler are shared. One engine, two detector libraries.

**Multi-tenancy.** L0 disaggregates per tenant where cardinality supports it. Family C's covariance estimation respects tenant slices — you don't want a single noisy tenant to shift the covariance estimate for everyone. The α budget has a per-tenant slice so a single-tenant regression doesn't consume the platform's overall budget.

**The model-lifecycle tooling as the artifact backbone.** CC's compiled configs live as the model-lifecycle tooling models. Every deploy's verdict references the model-lifecycle tooling artifact version. Rollback from a bad detector config is a model rollback.

**Platform governance layer.** Who sees which verdict, which provenance, which tenant slice. Table-level ACLs on the audit stream.

**Three clouds.** L0 abstracts cloud-specific telemetry. AWS-flavored CloudWatch, Azure Monitor, GCP Cloud Monitoring all land in the canonical SignalStream shape. Family B's structural signatures are workload-specific but cloud-agnostic.

**Scale implications.** At production scale, L1's characterization stream is high-throughput. The multi-scale-window design is meant to be implementable in streaming frameworks (a streaming framework such as Flink) rather than in-process memory. CC can run on clusters of the same scale as platform-scale training.

**Pitch-framing note:** the architecture is also intentionally open-sourceable. The target platform has a strong track record on this (the platform's open-source components). Nothing in the design depends on proprietary telemetry or internal infrastructure. Publishing a reference implementation would be a plausible follow-on — either as a target-platform open-source artifact or as an academic-venue paper (MLSys, SRECon, SOSP workshops).

---

## Open questions

Things this doc doesn't answer and that need real decisions before any of it gets built.

1. **Does the target platform's current deployment tooling have this gap, or is this a greenfield/platform play?** Shapes whether this is an extension (slot into existing Argo/internal tooling) or a standalone platform.
2. **Per-deploy α budget — what's the right number?** `10⁻³` is a starting guess. The answer depends on deploy frequency (if you deploy 1000×/day, FP rate of 10⁻³ is one false rollback per day — maybe acceptable, maybe not).
3. **Conformal novelty (Family E) — which baseline model?** Autoencoder, density estimator, or foundation-model-based forecaster (the ICLR 2026 ACAD-TSFM approach). Different training-cost / interpretability / accuracy trade-offs.
4. **Ground-truth labeling pipeline.** The learning loop depends on reliable incident labels. Who attaches "this deploy caused an incident" to an audit record, and how fast? Without this, the loop degrades to heuristic feedback.
5. **Data-plane detector library (structural signatures for a distributed-compute engine/the table-storage layer).** The AI-inference detector set from DeploySignal is one library; the data-plane library is a new piece of work. Scoping it is a project of its own.
6. **How aggressively to retire current numeric cutoffs.** The `1.20` ratios and `4-of-9` votes live in code today. Do we compile them immediately on ship (riskier, clean) or run a period of "compiled thresholds in shadow, hand-tuned in prod" (safer, slower)?

---

## Evolution path from the current engine

The current DeploySignal engine is the reference implementation of roughly L2 Family B (structural signatures) plus a crude proxy for L2 Family A (per-signal regression, via `effectiveThreshold + trendStrength`). It has no L0 variance reduction, no L1 multi-scale or BOCPD, no Families C/D/E, no calibration compiler, and no explicit α budget.

The path to the north star is _not_ a rewrite. It's a sequence of in-place layer additions, each independently sweepable against the existing adversarial suite as a regression guard. See the project roadmap (deleted) (strategic shape) and the project schedule (deleted) (execution shape) for the first increment; weekly briefs live under `coordination/handoffs/` (internal coordination tree, not included in this public repo; `coordination/handoffs/WEEK1-HANDOFF.md`, future `WEEK2-HANDOFF.md` etc.; `coordination/handoffs/WS2-PHASE2-HANDOFF.md` is shelved for the project). The longer-term sequencing is approximately:

1. Calibration compiler as a build-time tool that reproduces today's hand-tuned thresholds from a healthy baseline (proves the compiler architecture; no behavior change).
2. Multi-scale windows in L1 (enables richer detectors without changing fusion).
3. Family A (mSPRT) shipped; replaces the per-signal ratio detectors one by one.
4. Family C (Hotelling T² first, MMD second).
5. Family D (spectral + BOCPD).
6. Family E (conformal novelty), dependent on shadow-mode history from WS2 Phase 3.
7. Fusion layer (L3) upgrade from first-fires-wins to α-budgeted portfolio.
8. Learning loop (L5) — only after shadow-mode data accumulates.

Six weeks won't land all eight steps. Six weeks lands enough of steps 1–4 to make the pitch credible.

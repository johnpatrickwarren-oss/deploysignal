# DeploySignal — How the Gate Works

*An AI-inference deployment decision engine with formal false-positive control.*

DeploySignal gates canary rollouts by composing five independent detector families, each with formal statistical guarantees, against a segmented baseline derived from recent healthy traffic. The gate emits one of three surfaced verdicts — `proceed`, `extend`, or `rollback` (a fourth internal state, `baking`, marks in-window insufficient evidence and is never surfaced; per-family suppression — shipped reasons include `bake_profile`, `cell_confidence_none`, `ignore_threshold` — is recorded in the audit block, not as a top-level verdict; the Addition #11 `insufficient_samples` reason is planned v2.1, see `audit/SCHEMA.md`) — under a per-deploy false-positive budget `α_total = 10⁻³` allocated across families via Bonferroni correction (`40/20/20/10/10` across A/B/C/D/E). Family B is non-α-consuming structural (R2 disposition: 16 hand-designed absolute-threshold patterns, not statistical tests; the 2·10⁻⁴ Family B allocation is reserved-but-not-spent in the Ville claim). The α-participating portfolio (A+C+D+E) sums to `α_total_participating = 8·10⁻⁴`. The Ville-vs-classical partition originally documented at ARCHITECT-REPLY-52g has since shifted; verified against runtime dispatch 2026-07-17: the **Ville-bounded portion** is Family A's betting e-process AND its mixture-supermartingale Page-CUSUM (the classical Page-CUSUM path retired at Q68), Family C's safe-Hotelling and MMD betting e-process where a cell's baseline supports it (`α_ville ≈ 7·10⁻⁴`; sparse cells get **no MMD coverage** — the bootstrap-null fallback is retired, so sparseness costs coverage, not validity), and Family D's spectral e-detector. The **classical-epoch-α portion** as actually compiled in the committed configs is Family E's conformal detector: the compiler's auto-selector emits the classical `unweighted` kind when the baseline span / effective-sample-size gate isn't met (`α_classical ≈ 1·10⁻⁴`, valid only at canary boundaries; the weighted anytime-valid Family E variant compiles only when its span/ESS gate passes). Per-config ground truth lives in the generated guarantee manifest. Calibration happens at compile time; runtime arithmetic is cheap. Baseline history across recalibrations doubles as a service/engineering/product-maturity substrate.

## Architecture

```
Telemetry ──► L0 ──► L1 ──► L2 ──► L3 ──► G0 ──► G1 ──► O0 ──► Orchestrator
            ingest  buffer  five  verdict  blast   policy  emit   (Argo /
            +CUPAC  per-   families fusion  radius  gate           Spinnaker /
            +SRM    cell   in                                       model registry /
                           parallel                                 webhook)
```

**L0** ingests and normalizes telemetry; runs CUPAC covariate adjustment, metric-schema-continuity check (fires if telemetry shape changes mid-deploy), and sample-ratio-mismatch check (fires if the canary is receiving the wrong traffic fraction). **L1** maintains per-cell (hour × day × workload × tenant × region) trend buffers. **L2** runs the five detector families in parallel on those buffers. **L3** fuses per-family verdicts under the α-budget. **G0** gates by blast-radius and reversibility classification. **G1** applies operator policy: incident-state, fail-fast thresholds, ignore bands. **O0** emits the verdict plus structured lifecycle events (`triggered` / `started` / `tick` / `suppressed` / `finished`) to the orchestrator.

## The Five Detector Families

**Family A — per-signal change detection.** Two co-shipped detectors per signal (Addition #17): a betting-based e-process (Howard, Ramdas et al. 2021; Waudby-Smith & Ramdas 2024) — anytime-valid Ville-bounded under H₀, supplying the Family A contribution to α_ville — and a classical Page-1954 reset-at-zero CUSUM with Gaussian mixture-prior log-likelihood-ratio update — per-deploy Bonferroni-corrected via excursion theory (NOT anytime-valid Ville-bounded), supplying the Family A contribution to α_classical. Both evaluate six SLIs independently (`p99_latency`, `ttft`, `eval_score`, `tool_success_rate`, `downstream_err`, `cost_req`) under a 50/50 α-split of the per-signal Bonferroni budget; either firing promotes to rollback under Family A's any-fire union. Compile-time output: per-cell baseline statistics + betting `tau_squared` + CUSUM threshold; runtime is a scalar accumulator per detector per signal.

**Family B — structural signatures.** Sixteen hand-designed patterns on absolute-threshold ratios covering known LLM-serving failure classes: kv-cache saturation, MFU collapse, token-spill divergence, TTFT cliff, eval-score cliff, oscillation, nine others. Fires when a pattern's signature ratio exceeds its compiled threshold at any tick. Deliberately narrow: Family B catches *known* failure modes; the other four catch unknown ones.

**Family C — joint-vector regression.** Two detectors run against the multivariate signal vector x_t per cell:

- **Hotelling T²** — (x − μ)ᵀ Σ⁻¹ (x − μ) ~ χ²(p) under joint-Gaussian H₀. Σ is estimated per cell via **Minimum Covariance Determinant (MCD)** (Rousseeuw & Van Driessen 1999) when `n ≥ 2p+1`, **Minimum Regularized Covariance Determinant (MRCD)** (Boudt et al. 2020) for tight samples, **Ledoit-Wolf shrinkage** for high-dimensional cells. The compiler picks the method per cell based on sample-size.
- **Sequential MMD** (Li & Chen 2019) — kernel-based nonparametric statistic U_t with Gaussian RBF kernel and median-heuristic bandwidth. Catches distributional-shape shifts Hotelling misses (bimodality emergence, variance inflation without mean shift). α-budget split 50/50 between the two detectors within Family C.

**Family D — temporal structure.** Spectral ACF peak detection catches oscillatory regressions (e.g., tokenizer lock-contention introducing periodic latency spikes). Bayesian Online Changepoint Detection (BOCPD; Adams & MacKay 2007) catches regime changes not tied to a specific frequency. Both consume the same per-signal history buffer.

**Family E — distributional novelty.** Mahalanobis distance on the joint signal vector scored against a parametric-Gaussian bootstrap null, sharing the cell's robust Σ with Family C. Fire threshold is the **weighted α-quantile** of the bootstrap scores (Barber et al. 2023), with time-decay exponential weights that adapt to recent-baseline conditions while preserving the full bootstrap's statistical strength. Effective sample size is audit-visible. Catches vectors outside the healthy distribution regardless of which dimension is anomalous.

## α-Budget Composition

Per-deploy budget α_total = 10⁻³ splits across families with Bonferroni correction:

| Family | α_family | What it catches |
|---|---|---|
| A — change detection¹ | 4 × 10⁻⁴ | Mean shifts in known SLIs |
| B — structural | 2 × 10⁻⁴ | Absolute-threshold breaches |
| C — joint regression | 2 × 10⁻⁴ | Multivariate mean + shape shifts |
| D — temporal | 1 × 10⁻⁴ | Oscillation + regime change |
| E — novelty | 1 × 10⁻⁴ | Off-manifold joint-vector observations |

¹ **Family A Page-CUSUM (Phase D BATCH close 2026-05-07)** — anytime-valid Ville-bounded mixture-supermartingale variant (Howard-Ramdas-McAuliffe-Sekhon-2021); methodology-mode-invariant by construction. Strict α-budget × 1.2 acceptance under all 3 methodology-resampler modes (iid_bootstrap + parametric_gaussian + parametric_ar1) UNIFORMLY. Classical Page-CUSUM code path retired at Q68 .C close; CAVEAT inheritance retired at Q66 .A close (runtime semantic) + Q69 .D close (spec-side documentation + schema). AR(1) pre-whitening (Q66.A.b H1') closes the parametric_ar1 ρ=0.5 → 17.2% FPR LS-1 surface.

² **Family C Sequential MMD (Phase D BATCH close 2026-05-07)** — anytime-valid Ville-bounded betting-e-process variant (Shekhar-Ramdas-2023; canonical ONS); methodology-mode-invariant by construction. Classical bootstrap-null code path retired at Q68 .C close; methodology dependency retired at Q67 .B SLICE 1 close + Q69 .D close.

**Phase D BATCH closed 2026-05-07 (Q69 PR merge).** Phase-3.d sub-track FULLY CLOSED across .A + .B + .C + .D + .E. Phase D architectural close stamp: every Family A + Family C detector is anytime-valid Ville-bounded; classical-epoch-α retired; CAVEAT FULLY DEPRECATED.

Total family-level α is union-bounded ≤ α_total. Within-family signal-level α uses a further Bonferroni split. **Post-Phase-D close, α-participating portfolio is unified Ville-bounded** (anytime-valid e-processes — A-betting + A-Page-CUSUM mixture-supermartingale + C-safe-Hotelling + C-e-MMD-betting + D-spectral-e-detector + E-weighted-conformal; `α_total = α_ville ≈ 8·10⁻⁴`; no union-bound correction over tick count; numerical total unchanged from pre-Phase-D scope-split). Classical-epoch-α portion FULLY RETIRED. Family B is non-α-consuming structural (R2 disposition).

## Calibration Philosophy

**Compile-time heavy; runtime cheap.** The compiler ingests a 2-4 week baseline of healthy traffic, segmented into per-cell statistics. It fits per-cell means, robust covariances, bootstrap null quantiles, bake profiles, and α-thresholds; freezes a `CompiledConfig`. Runtime per-tick cost is O(p) for Family A, O(p²) for Family C Hotelling (one Cholesky solve against the precomputed Σ⁻¹), O(1) for Family B, O(b · p) for Sequential MMD with buffer b = 30 and 11-dim signal vector (~900 flops/tick). No matrix factorization at runtime; no threshold recalibration at runtime. The gate scales linearly in deploys.

**Byproduct: platform-maturity dashboard.** Baseline versions are archived across recalibrations. Trending p99_latency baseline down over 12 months = service-performance improvement. Rising eval_score baseline = quality-regression-free feature velocity. Declining rollback frequency = engineering-maturity signal. The gate is the operational substrate for platform-engineering decision-making, not just a deploy-time classifier.

## Honest Scope

Status buckets below use the repo-wide taxonomy (see `README.md § Implementation status at a glance`): **[runtime]** implemented in the per-tick engine path · **[offline-tool]** implemented as a repo tool, run manually · **[stub]** typed contract with inert/throwing implementation · **[spec-only]** exists in architecture docs only · **[future]** intended control-plane work, not yet specified in full.

**Shipped today [runtime]:** five detector families (Tier-1-SOTA complete as of 2026-04-20, including betting e-processes, MCD/MRCD robust covariance, Sequential MMD, weighted-quantile conformal); audit-schema v2 classifier (shipped records remain `schema_version: '2'`; v2.1 is a planned strict-additive post-phase extension — profile-block emission per Q60.4 is queued there; see `audit/SCHEMA.md`) with full provenance per verdict; structured lifecycle-event contract (`triggered`/`started`/`tick`/`suppressed`/`finished`) with in-process emitters (NoOp default + in-memory test emitter — no durable transport yet).

**Shipped today [offline-tool]:** calibration compiler with formal α-accounting (`tools/calibrate.ts`); six canned demos validating against synthetic trajectories; regression-injection + real-trace ingestion harnesses.

**Orchestration adapters [spec-only / stub]:** `ORCHESTRATION-ADAPTERS.md` is an architecture spec — the Argo Rollouts / Spinnaker / model-lifecycle / webhook adapters it describes are **not shipped as code**. The only adapter code today is the Anvil chaos family (`engine/o0/anvil/`), whose network methods deliberately throw pending implementation. (An earlier revision of this line listed the adapters under "shipped"; that was wrong — the lifecycle-event *contract* they would consume is shipped, the adapters are not.)

**Specified, implementation-for follow-on [spec-only]:** real-production-baseline calibration (synthetic baseline today; needs >100K healthy prod runs for tight α calibration); live cluster integration against a running Argo deployment; Tier-2 neural detectors (foundation-model novelty, transformer CPD) gated on real-baseline accumulation; direction-aware baseline-maintenance automation loop (North-Star Addition #15); SLO substrate derivation from baselines.

**Deliberately out of scope:** LLM content-safety (owned by Arize / Fiddler / WhyLabs); pre-deploy model evaluation (W&B, Hugging Face); full CD pipeline UX (Harness, Spinnaker); topology-graph root-cause analysis (Dynatrace, Datadog).

## Real-Data Validation (REPLY-52 partial)

**Shipped:** regression-injection harness (`tools/inject-regression.ts`) with three `delta_kind` dispatch modes (`absolute`, `relative_to_baseline_sigma`, `relative_to_baseline_mean`; step-function semantic — latest applicable `tick_offset` per signal wins); five hand-curated v1 profiles sourced from public postmortems (OpenAI 2024-12-11, Anthropic 2025-09 TPU + XLA, Cloudflare 2024-03, GitHub 2024-06); per-source structural schema-map layer (`tools/ingest-real-trace.ts`) for BurstGPT, Azure LLM Inference, Mooncake, grounded-synthetic overlay; `CompiledConfig.baseline_provenance` honest-provenance stamp; 27 new tests green.

**Pre-injection baseline invariant:** σ and μ are computed over ticks `[0, T_inject)` only, so regression noise never leaks into the reference shape. Tests assert byte-identical pre-injection samples.

**Caveat filters baked in:** BurstGPT log_type → service-error class only (`content_filter_rejection` + `context_length_overrun` excluded); Azure ContextTokens is arrival-only, never cost_req; Mooncake scoped to Family B KV-cache (not Family D spectral — 1-hour window insufficient for multi-cycle ACF/BOCPD); grounded-synthetic cost_req stamped with `grounded_synthetic:cost_req_via_tokens_times_pricing`.

**Shipped since this section was first written [offline-tool]:** dataset ingestion runs for four real traces — BurstGPT, Azure LLM Inference, Mooncake (v8a–c, Q60 Slice 1 V2 close 2026-05-02) and HuggingFace/LMSYS Arena (v9a, 2026-05-04) — with baseline bundles under `runs/baselines/real-*/` and compiled configs under `runs/compiled-configs/`.

**Deferred (for follow-on):** runs of the shadow-compare CLI against the 5 profiles (the CLI itself, `tools/run-shadow-compare.ts`, is shipped [offline-tool]; the synthetic-vs-real-baseline comparison runs are not), audit-emitted report cards per profile, NAB firewall for Families A/D structural-validity floor, v9b/v9c ingestion (AlpaServe, DeepSpeed-FastGen — not yet acquired).

**α-path validation report card (REPLY-52g U2+U4 scope-split):** `tools/build-report-card.js` emits `runs/validation-reports/report-card-v1.json` (generated artifact, gitignored — run `node tools/build-report-card.js` to produce it) under compile-substrate bootstrap (E3) + dual-surface FPR scope-split (Ville-bounded vs classical-epoch-α per ARCHITECT-REPLY-52g). Validation substrate: `runs/compiled-configs/v5-sequential-e-process.json` (compiled from synthetic-v1 under current main with `hotelling_variant=safe_test` 840/840, `spectral_variant=e_detector`, `family_E.kind=weighted_e_value`, `mmd_variant=betting_e_process` on 20/840 cells + `bootstrap_null` on 820/840 — synthetic-v1's median 95 samples/cell sits below the lowered MMD_MIN=100 threshold; the U2+U4 framework explicitly permits MMD-bootstrap-null fallback under classical-epoch-α). v4-fusion-novelty.json retained for canned-demo role.

**Compiled-config canonical versions (post-Q57):**

- **v7-demos.json** (compiler_version 0.3.0+; topic-57 close): canonical
  demo storytelling substrate post-Q2.A re-baselining. Aggregate-
  fallback baseline values aligned with demo trajectory live values
  via aggregate_fallback_patch schema + applyCellPatch class-fix
  symmetric coverage. Closes Phase 2.4 demo-substrate carve-out ADR
  commitment.

- **v4-fusion-novelty.json** (compiler_version 0.2.0; HISTORICAL
  reference): retained as historical reference only; pre-Q2.A demo
  substrate; available in runs/compiled-configs/ for backward-compat
  audits.

- **v5-sequential-e-process.json** (compiler_version 0.3.0): canonical
  production-validation substrate (unchanged through topic 57).

- **v6-demos-archived.json** (compiler_version 0.3.0; ARCHIVED): non-
  canonical post-Phase-2.4; production-validation-substrate reference.

**Compiled-config canonical versions (post-Phase-3 close; Q60 Slice 1 V2):**

- **v8a-real-burstgpt-v1.json** (Q60 Slice 1 V2 close 2026-05-02):
  canonical real-trace substrate for BurstGPT (cost_req-only signal
  coverage per Track A1 mapper; 200k rows → 34,202 ticks). Sparse-
  signal substrate per Q60 Phase-3.d.1 (A) calibrate.ts emission;
  Family A on cost_req exercised; 8/10 detectors exempted via L2 (D)
  + L3b β.1 per-detector exemption mapping.
- **v8b-real-azure-llm-inference-v1.json** (Q60 Slice 1 V2 close
  2026-05-02): canonical real-trace substrate for Azure LLM Inference
  2023 conv (tokens_turn-only signal coverage; 19k rows → 701 ticks).
  Sparse-signal substrate; ContextTokens-arrival-only caveat preserved
  (cost_req NEVER emitted).
- **v8c-real-mooncake-v1.json** (Q60 Slice 1 V2 close 2026-05-02):
  canonical real-trace substrate for Mooncake conversation_trace
  (kv_cache + tokens_turn signal coverage; 12k rows → 708 ticks).
  Sparse-signal substrate scoped to Family B kv_cache via Q60 V2
  caveat; family_D_kv_cache exempted by L3b β.1 parametric_ar1 PASS
  skip.
- **v9a-real-huggingface-lmsys-arena-v1.json** (shipped 2026-05-04):
  canonical real-trace substrate for HuggingFace/LMSYS Arena
  (eval_score + tokens_turn + cost_req signal coverage; 39,712 ticks;
  caveat filters: synthetic_timestamp_derivation,
  chars_div_4 token-count heuristic, reject_judge_disagreement).
- **v9b-real-alpaserve-v1.json** (NOT SHIPPED — dataset not acquired;
  pending architect Q62.1-disposition).
- **v9c-real-deepspeed-fastgen-v1.json** (NOT SHIPPED — dataset not
  acquired; pending architect Q62.1-disposition).

Synthetic-v1 × v5 sweep (131 healthy windows × 100-tick canary; injection at tick 30):

- **TPR (5 public-postmortem profiles):** Ville-bounded **5/5**, classical-epoch 3/5, combined **5/5**. Median time-to-detect 6 ticks (~30s @ 5s cadence). PRIMARY gate (≥80%) cleared.
- **Ville-bounded FPR — DUAL-SURFACE (post-REPLY-52gk):**

  _Under iid bootstrap (operational H₀):_ 30/131 = 22.9% with attribution per Mac Claude 2 commit 8ff91f1: Family A betting + Page-CUSUM EMPIRICALLY VILLE-CLEAN (0/131 each); Family C 6/131; Family D kv_cache 24/131; Family E 1/131; Family A legacy classical 5/131. V2 narrowing language landed at REPLY-52gf and is preserved here: acknowledged elevation under iid bootstrap reflects detector calibration-coherence gaps + per-cell Σ_C shrinkage choices, not formal-property gaps.

  _Under parametric Gaussian H₀ (formal-property test, post-Cholesky):_ Family A betting confirmed Ville-clean across 5 cumulative methodology surfaces (>196,000 trajectories, 0 fires); Family A Page-CUSUM + C + E parametric 131/131 fires localized to compile-time calibration-source incoherence (168/336 strict cells aggregate-fallback μ_C ≠ per-cell μ_A); pending Q2.B calibration-coherence enforcement (Phase-2 commitment per ARCHITECT-REPLY-52gk).
- **TPR post-P1: 4/5** — at the 80% acceptance gate; openai_routing_error_ramp now misses (pre-P1 caught incidentally via tool_success_rate hyper-sensitivity). Median time-to-detect 27 ticks; p95 64 ticks. **Attribution accuracy 4/4** (post-P1 Page-CUSUM/betting both attribute to expected signals: `eval_score`, `p99_latency`, `cost_req`).
- **sigma_floor_applied audit field: 66 cells** — all `tool_success_rate`, exactly matching the cross-signal grep prediction at `coordination/DIAGNOSTIC-V1-H1-GREP-2026-04-26.md` (internal coordination doc, not included in this public repo).
- **Family B diagnostic trip-rate: 131/131** (non-α-consuming per R2; methodology-specific, not a production projection).

**Pitch-positioning under V2 honest-scope path with dual-surface framing:** 5/5 TPR + 30s median TTD on real public-postmortem regressions (OpenAI 2024-12-11, Anthropic 2025-09 TPU + XLA, Cloudflare 2024-03, GitHub 2024-06) under v5 substrate. Three methodology-surface findings:

(a) Family A betting + Page-CUSUM EMPIRICALLY VILLE-CLEAN under both iid bootstrap and post-Cholesky parametric H₀ (>196,000 trajectories cumulative; 0 fires; design contract holds).

(b) Family C/D/E elevated under iid bootstrap; localized to specific detector miscalibrations (Family D kv_cache broad; Family C calibration-coherence) pending Q2.B Phase-2.

(c) Parametric H₀ surface SURFACED a separate compile-time calibration-source incoherence bug (Family A μ_A ≠ Family C μ_C on 168/336 cells); architect-clever Q2.B.4 mechanism (single-source per-cell μ + Σ_C shrinkage) is the Phase-2 fix.

Pitch-narrative discipline arc: methodology-surface-divergence as diagnostic; framework caught its own seven-artifact phantom hypothesis chain via empirical wrap-around at chain step N+1 (REPLY-52gi misattribution catch); corrected pitch-readiness restored within half-day; architecturally improved Cholesky resampler shipped to main as Phase-1 win; Q2.B calibration-coherence committed Phase-2.

## Key References

- Howard, Ramdas, McAuliffe, Sekhon (2021). *Time-uniform, nonparametric, nonasymptotic confidence sequences.* Annals of Statistics.
- Waudby-Smith, Ramdas (2024). *Estimating means of bounded random variables by betting.* J. Royal Statistical Society B.
- Barber, Candès, Ramdas, Tibshirani (2023). *Conformal prediction beyond exchangeability.* Annals of Statistics.
- Rousseeuw, Van Driessen (1999). *A fast algorithm for the minimum covariance determinant estimator.* Technometrics.
- Boudt, Rousseeuw, Vanduffel, Verdonck (2020). *The minimum regularized covariance determinant estimator.* Statistics and Computing.
- Li, Chen (2019). *Adaptive dynamic network inference via sequential MMD tests.*
- Adams, MacKay (2007). *Bayesian online changepoint detection.*
- Ville (1939). *Étude critique de la notion de collectif.*

---

*DeploySignal — compiler 0.3.0, audit schema v2 (v2.1 planned; see `audit/SCHEMA.md`), 874 tests on main (as of 2026-05-04) (869 pass / 0 fail / 5 skipped+todo; post-Q65 SPEC-5 close 2026-05-04; Phase C BATCH PARTIALLY CLOSED — Q61 + Q63 + Q65 closed; Q62 Phase 2 closed, Phase 1 in HALT; Q64 in flight).*

*Test count methodology: test-runner output (`npm test` summary line counting all `test()` + `it()` blocks across `test/*.test.ts`) is canonical. Grep-based count of top-level `^test(` invocations yields a lower number (excludes nested `it()` blocks within `describe()` blocks); use test-runner output to avoid divergence.*

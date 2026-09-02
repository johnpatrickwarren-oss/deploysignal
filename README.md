# DeploySignal

> **Repo status:** active development happens in a private working repository
> (`deploysignal-private`); this public repo is the published snapshot and may lag it.

**Statistical deploy-gate decision engine for AI inference workloads.** A reference architecture and reference implementation: Ville-bounded detector portfolio, calibration compiler that compiles healthy-baseline traces into per-cell threshold parameters, audit substrate that emits structured DetectorTrip records, and a worked-example demo surface (6 canned scenarios including a reconstruction of a publicly-disclosed AI inference regression).

## What this is

A statistically-rigorous answer to one operational question: **given a new deploy and live telemetry, should we proceed, extend, or rollback?**

- **Multi-family detector portfolio.** Five detector families operate in parallel — Page-CUSUM mixture-supermartingale (Family A; per-signal mean shift), structural pattern-matching (Family B), Hotelling T² + Sequential MMD betting-e-process (Family C; multivariate distributional shift), spectral ACF (Family D; oscillation-class signal), weighted-conformal Mahalanobis novelty (Family E). Each family contributes evidence; portfolio fusion produces the verdict.
- **Anytime-valid α-budget — with an honest boundary.** The α-participating portfolio is predominantly anytime-valid (Ville-bounded supermartingales / e-processes): on those paths, operators can peek at the wealth statistic at every tick without inflating the false-positive rate. Not every configured path is Ville-bounded, and an earlier revision of this bullet named the wrong classical paths. Verified against runtime dispatch (2026-07-17): both Family A components are Ville-bounded post-Q68 (the classical Page-CUSUM code path is retired); cells too sparse for the Family C MMD betting e-process get **no MMD coverage** (the bootstrap-null fallback is retired — sparseness costs coverage, not validity); the **classical-epoch-α** path that used to ship in the committed compiled configs is Family E's conformal detector, which the compiler's auto-selector compiles to the classical `unweighted` kind when the baseline span/effective-sample-size gate isn't met — a per-tick p-value with no epoch guard. Since 2026-09-02 (WORKLIST C25, `knowledge/stats/family-e-budget-ruling` option 3) Family E is **advisory**: its budget is 0 on the llm profiles, it is non-α-participating (`FAMILY_E_ADVISORY`, `engine/guarantees.ts`), its fires are reported but never trigger rollback, and the participating budget is A + C + D = 7·10⁻⁴; the classical residue is Family D's `bootstrap_null` quantile test. At engine pin v0.6.7-pre a zero-budget Family E reads `suppressed/calibration_underpowered` rather than advisory; the engine re-pin restores its reporting. Per-config ground truth is machine-checkable: each compiled config's guarantee manifest reports the configured validity class per detector, and the audit record tracks per-family α.
- **Calibration compiler.** `tools/calibrate.ts` compiles a healthy-baseline trace into a `CompiledConfig` with per-(hour-of-day × day-of-week × tenant-tier) cells. Per-cell mean vectors, covariance matrices (Ledoit-Wolf / MCD / MRCD), Cholesky factors, AR(1) phi coefficients, mixture-supermartingale priors, betting-e-process baseline pools, conformal calibration scores. The compile is deterministic; same input → same output → same fire decisions on replay.
- **Audit substrate.** Every detector evaluation emits a structured `DetectorVerdict` with provenance (cell_key, baseline_version, schema_continuity), α consumption, fire reason. Audit records replay-clean: the same compiled config + the same metric stream produces the same verdict, supporting post-incident reconstruction.

## DS bundle — sibling products

DeploySignal is one product in a multi-product bundle. Within this repo, the canonical engine source is the local [`engine/`](engine/) tree — all code and tests here import it directly. [`deploysignal-engine`](https://github.com/johnpatrickwarren-oss/deploysignal-engine) (`@johnpatrickwarren-oss/deploysignal-engine`) is the extracted, Tessera-evolved npm package that **external** products consume via git-dep; in this repo it is exercised only by the r92 engine-package POC test:

| Repo | Stage | What it does |
|---|---|---|
| [`deploysignal`](https://github.com/johnpatrickwarren-oss/deploysignal) (this repo) | Pre-promotion | Gate-time verdict for the deploy under analysis. Also packages Anvil (Addition #29) inside this repo as a chaos-experiment overlay. |
| [`tessera`](https://github.com/johnpatrickwarren-oss/tessera) | Steady state | Per-shard cluster observation; per-shard residual semantics + e-BH FDR control + topology-aware freeze-hook. |
| [`cairn`](https://github.com/johnpatrickwarren-oss/cairn) | Postmortem | Structured RCA / attribution — ranks candidate cause-events against incident onset. Closes the lifecycle loop. |

The lifecycle-loop frame:

> **DeploySignal catches before promotion. Tessera observes during steady state. Cairn attributes when something escapes both — statistically, not by eyeballing dashboards.**

Strong Verica/Casey adjacency on Cairn: chaos engineering finds weaknesses *before* they cause incidents; Cairn ranks them *after*. Two halves of the same methodology.

## DS-Anvil — chaos-engineering verdicts

DeploySignal's verdict substrate also runs the inverse direction: chaos experiments. **Anvil** (Addition #29) is the chaos-verdict packaging — four chaos-platform O0 adapters (Gremlin, Chaos Mesh, AWS FIS, Litmus), an `expected_failure_pattern` contract that lets the operator declare what the injected fault should do, and an `anvil-chaos-experiment@1.0.0` reference profile — that turns the same Ville-bounded multi-family portfolio into a principled chaos-engineering verdict layer. Targets Verica-style buyers who today have weak verdict surfaces on their chaos investment; the chaos-engineering market injects faults well but leaves the pass/fail call to operators eyeballing dashboards.

**The "DS-Anvil" buyer bundle.** Anvil-the-product packages three components: (1) the DeploySignal engine (Ville-bounded portfolio + audit substrate) at the verdict layer; (2) [Tessera](https://github.com/johnpatrickwarren-oss/tessera) at the per-shard observation layer — Tessera is a sibling product that vendors the DS engine and ships per-shard residual semantics + hierarchical e-value combination + e-BH FDR control for cluster scope, which lines up exactly with shard-targeted chaos experiments (pod-kill, latency-injection on rack-N); (3) the chaos-platform adapter family (`engine/o0/anvil/`) that lands in this repo. The Anvil capability lands inside DS as a docs-only positioning addition + typed contracts + adapter stubs; cluster-scope chaos runs consume Tessera's per-shard feed via the existing [`engine/ds-integration/`](https://github.com/johnpatrickwarren-oss/tessera/tree/main/engine/ds-integration) HTTP contract.

See [`engine/o0/anvil/`](engine/o0/anvil/) for the adapter contracts and stubs, and [`profiles/anvil-chaos-experiment.yaml`](profiles/anvil-chaos-experiment.yaml) for the reference profile.

## Quick start

```bash
npm ci
npm test           # runs the full suite (see the CHEAT-SHEET.md status line for the live suite count)
npm run build      # tsc compile
```

To rebuild the demo bundle and demos:
```bash
node tools/build-canned-demos.js   # regenerate canned demo JSONs
node tools/build-demo.js           # regenerate demos/demo.html
```

To open the interactive demo locally: open `demos/demo.html` in a browser.

## Where to read next

- **[`NORTH-STAR-ARCHITECTURE.md`](NORTH-STAR-ARCHITECTURE.md)** — the target architecture spec (long; load-bearing).
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — current implemented architecture.
- **[`FAMILY-INTUITION.html`](FAMILY-INTUITION.html)** — visual walkthrough of the five detector families and how they compose.
- **[`CHEAT-SHEET.md`](CHEAT-SHEET.md)** — quick-reference card across the system surface.
- **[`DETECTOR-MATH-RESEARCH.md`](DETECTOR-MATH-RESEARCH.md)** — the statistical-literature anchors for each detector.
- **[`audit/SCHEMA.md`](audit/SCHEMA.md)** — the audit-record schema (versioned).

## Implementation status at a glance

Docs in this repo mark components with a five-bucket status taxonomy so readers can tell what exists where. The buckets, and the headline components in each:

| Status | Meaning | Currently includes |
|---|---|---|
| **[runtime]** | Implemented in the per-tick engine path or a shipped long-running service, exercised by the test suite | Five detector families; gate cascade + SRM + fail-fast (G3 state gate wired via `StateGateContext`); portfolio/cascade fusion with `verdict_rationale` + scale-honest `evidence_outlook`; audit v2 with fail-loud writer; verdict grouping + advisory fan-out; Anvil suppression; **durable session store + Argo Rollouts Level-1 verdict service** (`service/`, declare-void-and-restart semantics, idempotent tick replay) |
| **[offline-tool]** | Implemented as a repo tool an operator runs manually | Calibration compiler + guarantee-manifest sidecar; **Addition #15 baseline-maintenance lifecycle** (`tools/recalibrate`: candidate state machine, readiness gates, shadow validation, approve/reject, atomic promotion + rollback, timeout + calendar sweeps); regression injection; real-trace ingestion (v8a–c, v9a); shadow-compare CLI; pre-registered comparator-baseline study; demo builders |
| **[stub]** | Typed contract present, implementation inert or deliberately throwing | Anvil chaos-platform adapter network methods; curation pipeline SLICEs 2–3 (D5–D10 throw) |
| **[spec-only]** | Specified in `NORTH-STAR-ARCHITECTURE.md` / `ORCHESTRATION-ADAPTERS.md`, no code | Spinnaker / model-lifecycle / webhook orchestrator adapters (the **Argo Level-1 web-provider service is shipped** — see [runtime]); incident-aware gating; Metric Registry governance |
| **[future]** | Intended production-control-plane work, not fully specified | Multi-instance/distributed control plane (the shipped session store is deliberately single-writer reference-grade); multi-region baseline consistency; automated candidate *production* (window selection → curation → compile remains an upstream operator flow feeding `recalibrate propose`) |

The engine is also published as a separate shared library, [`deploysignal-engine`](https://github.com/johnpatrickwarren-oss/deploysignal-engine), consumed by this repo and by [Tessera](https://github.com/johnpatrickwarren-oss/tessera); a handful of statistical baseline primitives live there rather than here (see that repo's README for its charter).

## Guarantee manifest

The statistical-validity claim above ("predominantly anytime-valid, with an honest boundary") is generated from code, not hand-maintained as prose. [`engine/guarantees.ts`](engine/guarantees.ts) is a static, per-detector table (validity class, null assumptions, repeated-look policy, α-participation, fallback relationships, literature citation) keyed by every id in `DETECTOR_REGISTRY` (`engine/types/audit.ts`). [`tools/build-guarantee-manifest.ts`](tools/build-guarantee-manifest.ts) joins that table against a compiled config to report which validity class is actually configured — e.g. which cells route Hotelling T² through the classical χ² test vs the Ville-bounded safe-test e-process, or Family E's conformal novelty detector through the classical per-tick p-value test vs the Ville-bounded weighted-e-value wealth process — rather than asserting one guarantee for the whole system.

Every `tools/calibrate.ts` compile emits a `<config-basename>.guarantee-manifest.json` sidecar next to the `CompiledConfig` automatically. To generate one standalone:

```bash
node tools/build-guarantee-manifest.js --config runs/compiled-configs/v7-demos.json \
                                        --out runs/compiled-configs/v7-demos.guarantee-manifest.json
```

The manifest reports `effective_validity` (`fully_ville_bounded` or `mixed`, with the classical share of the α-participating budget and exactly which configured paths carry it), plus `known_limitations` and `fallback_behavior` sourced from [`deploysignal-paper.md`](deploysignal-paper.md) §5 and the compiler/detector fallback code. Because it's derived from the compiled config rather than asserted in prose, it can't silently drift from what a given deploy actually runs.

## Methodology

This codebase was built as a four-role multi-agent project (architect / TPM / implementer / reviewer). The methodology — including the four-anchor pre-merge defense, memorial accretion, pre-emit grilling, and role anchoring across multiple chat instances — is published as a standalone pack:

> **[`johnpatrickwarren-oss/anchor`](https://github.com/johnpatrickwarren-oss/anchor)** — the coordination methodology distilled from this project, with templates and worked-example case study. Independently usable on other software projects.

The local [`anchor/`](anchor/) folder is a pointer to that canonical repo.

Comparator-baseline validation against tuned threshold-gate and canary-vs-control alternatives is pre-registered in [`runs/comparator-baseline/ENDPOINTS.md`](runs/comparator-baseline/ENDPOINTS.md), with the committed registered run at [`runs/comparator-baseline/report-synthetic-v1.json`](runs/comparator-baseline/report-synthetic-v1.json) (see [`METHODOLOGY.md` §5](METHODOLOGY.md#5-empirical-validation-against-comparator-baselines)).

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Baseline curation scope and limits

DeploySignal's detector calibration assumes baseline traces are operator-curated as healthy. Two defense layers handle sparse outliers in the baseline window:

**Layer 1 — Robust covariance estimation.** Family C (Hotelling T²) uses MCD/MRCD (Minimum Covariance Determinant + regularized variant) with Croux-Haesbroeck consistency correction. Family E (Mahalanobis novelty) shares the cell's robust Σ. Sparse outlier observations get downweighted; thresholds calibrate against the underlying healthy distribution.

**Layer 2 — Per-cell stratification.** Baselines are computed per-cell across `hour × day × workload × tenant × region`. Outage data contained within a single tenant or hour-of-day cell doesn't contaminate other cells' calibrations.

**Gap — Sustained large-scale-event (LSE) contamination.** No automatic outage-period detection in baseline ingestion. If an operator feeds a baseline window containing a multi-day outage, calibrated thresholds will skew (mean shifted, variance inflated); robust statistics break down past ~50% contamination per window. Operators are responsible for upstream curation: feed traces from healthy windows; exclude incident periods via timestamp filtering before ingestion.

This operator-curated-healthy-baseline pattern is consistent with industry standard for deploy-gate analysis tools — Spinnaker Kayenta, Argo Rollouts, Flagger, Harness Continuous Verification, LaunchDarkly Release Guardian, Datadog Watchdog, and Dynatrace Quality Gates all rely on operator-curated healthy traffic as calibration input. The same pattern applies to LLM-observability tools (Fiddler Guardrails, Arize Phoenix, WhyLabs LangKit) for their reference distributions.

**Where the boundary sits today (2026-07-17):** DeploySignal now implements candidate-baseline *governance* — persisted candidates, readiness gates, mandatory shadow validation, operator approve/reject with reason codes, atomic promotion with rollback, timeout default-reject, and a monthly calendar due-check (`tools/recalibrate`). Operator-declared exclusion windows (`exclusion-windows.json`) are a first-class readiness input: a candidate whose source window overlaps a declared incident/maintenance period fails eligibility. What remains upstream and operator-owned is candidate *production*: selecting the telemetry window, curating it as healthy, and running the calibration compiler that `recalibrate propose` consumes. Automated inference of exclusion windows from DeploySignal's own session/verdict records, and an integrated refresh controller that chains window selection → compile → propose over an operator-supplied bundle, are approved follow-on work — not yet shipped.

## Performance

Per-tick gate-evaluation latency on the full 5-family detector portfolio:

| Scenario | Median | p99 | Max | Sample size |
|---|---|---|---|---|
| Healthy path (no fires; full evaluation) | 29.8 μs | 62.8 μs | 0.194 ms | 5,000 ticks |
| Regression path (C+E co-fire at t=11) | 27.8 μs | 60.8 μs | 0.167 ms | 5,000 ticks |

Measured 2026-04-20 on `darwin-arm64` (Apple Silicon), Node.js v25.9, against the `v4-fusion-novelty` compiled config in portfolio fusion topology with all five detector families active. 1,000-tick warm-up before measurement.

Raw measurements: `runs/benchmarks/tick-latency-baseline.json`. Methodology: `tools/benchmark-tick-latency.ts`.

### Per-family complexity

Calibration is heavy at compile time; runtime is arithmetic against precomputed structures (no matrix factorization at runtime; no threshold recalibration at runtime).

| Family | Per-tick cost |
|---|---|
| A — mixture-supermartingale Page-CUSUM + betting e-process | O(p) per signal |
| B — structural patterns | O(1) lookup against compiled thresholds |
| C — Hotelling T² | O(p²) — one Cholesky solve against precomputed Σ⁻¹ |
| C — Sequential MMD with RFF | O(D · p) where D = 256 RFF dimension; ~2,800 flops/tick at p = 11 |
| D — spectral ACF + BOCPD | O(p · log b) where b = buffer size |
| E — weighted-conformal Mahalanobis | O(B) where B = bootstrap sample count |

### Staleness note

The above measurements predate Phase D architectural changes (Q66 mixture-supermartingale Page-CUSUM; Q67 betting e-process for Sequential MMD; Q72 RFF construction). Post-Phase-D projection: median ~35–50 μs, p99 ~100–150 μs — still sub-millisecond, modest increase from the 2026-04-20 baseline. Benchmark refresh tracked as a separate cycle.

For context: a typical LLM token-generation step is 10–100 ms. DeploySignal adds well under 1% overhead on a typical inference-request budget.

## Status

Reference implementation. Not packaged for production deployment as-is — the engine is shipped as runtime-exercised TypeScript modules with a deterministic test substrate; integration with a specific deployment platform (Argo Rollouts, Flagger, custom Kubernetes operators, etc.) is work that wraps this engine. See [`ORCHESTRATION-ADAPTERS.md`](ORCHESTRATION-ADAPTERS.md) for the architectural seam where that integration plugs in.

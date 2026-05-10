# DeploySignal

**Statistical deploy-gate decision engine for AI inference workloads.** A reference architecture and reference implementation: Ville-bounded detector portfolio, calibration compiler that compiles healthy-baseline traces into per-cell threshold parameters, audit substrate that emits structured DetectorTrip records, and a worked-example demo surface (6 canned scenarios including a reconstruction of a publicly-disclosed AI inference regression).

## What this is

A statistically-rigorous answer to one operational question: **given a new deploy and live telemetry, should we proceed, extend, or rollback?**

- **Multi-family detector portfolio.** Five detector families operate in parallel — Page-CUSUM mixture-supermartingale (Family A; per-signal mean shift), structural pattern-matching (Family B), Hotelling T² + Sequential MMD betting-e-process (Family C; multivariate distributional shift), spectral ACF (Family D; oscillation-class signal), weighted-conformal Mahalanobis novelty (Family E). Each family contributes evidence; portfolio fusion produces the verdict.
- **Anytime-valid α-budget.** Detectors are anytime-valid (Ville-bounded supermartingales / e-processes); operators can peek at the wealth statistic at every tick without inflating the false-positive rate. α budgets are explicitly allocated per family and tracked in the audit record.
- **Calibration compiler.** `tools/calibrate.ts` compiles a healthy-baseline trace into a `CompiledConfig` with per-(hour-of-day × day-of-week × tenant-tier) cells. Per-cell mean vectors, covariance matrices (Ledoit-Wolf / MCD / MRCD), Cholesky factors, AR(1) phi coefficients, mixture-supermartingale priors, betting-e-process baseline pools, conformal calibration scores. The compile is deterministic; same input → same output → same fire decisions on replay.
- **Audit substrate.** Every detector evaluation emits a structured `DetectorVerdict` with provenance (cell_key, baseline_version, schema_continuity), α consumption, fire reason. Audit records replay-clean: the same compiled config + the same metric stream produces the same verdict, supporting post-incident reconstruction.

## Quick start

```bash
npm ci
npm test           # runs the full suite (~970 tests)
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
- **[`COMPETITIVE-LANDSCAPE.md`](COMPETITIVE-LANDSCAPE.md)** — capability comparison vs adjacent tooling (Kayenta, LaunchDarkly, Harness, etc.).
- **[`DEMO-SCRIPT-10MIN.md`](DEMO-SCRIPT-10MIN.md)** — narrated walkthrough of the 6 canned demos.
- **[`audit/SCHEMA.md`](audit/SCHEMA.md)** — the audit-record schema (versioned).
- **[`coordination/PROJECT-ROLES.md`](coordination/PROJECT-ROLES.md)** — the multi-role coordination structure this project was built under.
- **[`coordination/ANTI-SCOPE-LEDGER.md`](coordination/ANTI-SCOPE-LEDGER.md)** — explicit ADR-anti-scope clauses and the discipline for preserving them across architectural cycles.

## Methodology

This codebase was built as a four-role multi-agent project (architect / TPM / implementer / reviewer). The methodology — including the four-anchor pre-merge defense, memorial accretion, pre-emit grilling, and role anchoring across multiple chat instances — is published as a standalone pack:

> **[`johnpatrickwarren-oss/anchor`](https://github.com/johnpatrickwarren-oss/anchor)** — the coordination methodology distilled from this project, with templates and worked-example case study. Independently usable on other software projects.

The local [`anchor/`](anchor/) folder mirrors that public repo for in-repo access.

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Baseline curation scope and limits

DeploySignal's detector calibration assumes baseline traces are operator-curated as healthy. Two defense layers handle sparse outliers in the baseline window:

**Layer 1 — Robust covariance estimation.** Family C (Hotelling T²) uses MCD/MRCD (Minimum Covariance Determinant + regularized variant) with Croux-Haesbroeck consistency correction. Family E (Mahalanobis novelty) shares the cell's robust Σ. Sparse outlier observations get downweighted; thresholds calibrate against the underlying healthy distribution.

**Layer 2 — Per-cell stratification.** Baselines are computed per-cell across `hour × day × workload × tenant × region`. Outage data contained within a single tenant or hour-of-day cell doesn't contaminate other cells' calibrations.

**Gap — Sustained large-scale-event (LSE) contamination.** No automatic outage-period detection in baseline ingestion. If an operator feeds a baseline window containing a multi-day outage, calibrated thresholds will skew (mean shifted, variance inflated); robust statistics break down past ~50% contamination per window. Operators are responsible for upstream curation: feed traces from healthy windows; exclude incident periods via timestamp filtering before ingestion.

This operator-curated-healthy-baseline pattern is consistent with industry standard for deploy-gate analysis tools — Spinnaker Kayenta, Argo Rollouts, Flagger, Harness Continuous Verification, LaunchDarkly Release Guardian, Datadog Watchdog, and Dynatrace Quality Gates all rely on operator-curated healthy traffic as calibration input. The same pattern applies to LLM-observability tools (Fiddler Guardrails, Arize Phoenix, WhyLabs LangKit) for their reference distributions. Adding automated incident-window exclusion (e.g., as a D11 decision in the baseline curation pipeline, or operator-supplied incident-timestamp manifest) is a possible future extension.

## Status

Reference implementation. Not packaged for production deployment as-is — the engine is shipped as runtime-exercised TypeScript modules with a deterministic test substrate; integration with a specific deployment platform (Argo Rollouts, Flagger, custom Kubernetes operators, etc.) is work that wraps this engine. See [`ORCHESTRATION-ADAPTERS.md`](ORCHESTRATION-ADAPTERS.md) for the architectural seam where that integration plugs in.

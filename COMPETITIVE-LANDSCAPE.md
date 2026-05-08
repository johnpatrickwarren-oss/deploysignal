# DeploySignal — Competitive Landscape (Point-by-Point)

_Author: TPM (laptop Cowork session), 2026-04-19. Companion to the pitch one-pager (deleted), `NORTH-STAR-ARCHITECTURE.md`, the PM-critique response (deleted)._

_Purpose: grounded comparison of DeploySignal against commercial products, public FAANG writeups, observability-adjacent tools, and the the target platform / ML-platform lens. Structured for a Claude-based TPM agent (or human) to consume in one pass and extract talking points, pitch rebuttals, and follow-on gap work._

_Methodology: two-pass research. Pass 1 (2026-04-19 AM): market-researcher agent with WebSearch + WebFetch. Pass 2 (2026-04-19 PM): direct primary-source verification via Claude-in-Chrome for the highest-value competitors whose docs were blocked at WebFetch on pass 1. Primary-source citations per claim. Remaining caveats (ACM Queue CAS article behind paywall; Datadog docs pages render partially; Meta Conveyor OSDI '23 PDF not re-fetched) at the bottom._

_Primary-source verified in pass 2:_ LaunchDarkly Guarded Rollouts (sequential testing semantics), Netflix Kayenta tech blog (Mann-Whitney U + pass/high/low classification), Google SRE Workbook canarying chapter (methodology only; CAS algorithm internals remain unreachable), Dynatrace Site Reliability Guardian / Release Validation (DQL + SLO objectives; no specific statistical-test family named), Harness Continuous Verification ML Concepts (Symbolic Aggregate Approximation for metrics + log clustering for Known/Unknown/Unexpected Frequency).

---

## How to read this document

1. **Axes table** — 14 comparison axes. Each axis has a one-line statement of DeploySignal's position and a compact verdict table across the top competitors.
2. **Per-competitor cards** — narrative summary per competitor: one-line summary, where DS wins, where they win, and where DS needs work.
3. **Top threats / moats / gaps** — five-item lists synthesizing the comparison.
4. **Open research questions** — honest unknowns for next research pass.
5. **Source index** — every URL, by competitor.

Verdict legend in the matrix:
- `DS` — DeploySignal does this
- `YES` — competitor does this, confirmed in source
- `no` — competitor does not do this per public writeup
- `partial` — competitor does a weaker/adjacent version
- `?` — not publicly documented or source blocked

---

## DeploySignal position summary (restated for comparison)

DeploySignal sits inside the analysis step of a progressive-delivery rollout (Argo Rollouts first; Flagger / Spinnaker designed in via the O0 orchestration adapter). It emits `rollback | extend | proceed` per tick. Distinguishing choices:

- **Calibration compiler (build-time).** Every threshold is derived from a healthy baseline plus an explicit α budget, emitted as a versioned `CompiledConfig` artifact. Runtime is arithmetic against compiled thresholds.
- **Five-family detector portfolio running in parallel against a shared α budget.** Post-Phase-D BATCH close 2026-05-07: A = betting-e-process + Page-CUSUM mixture-supermartingale (Howard-Ramdas-McAuliffe-Sekhon-2021; anytime-valid Ville-bounded), B = 16 AI-inference structural signatures, C = safe-Hotelling T² + Sequential MMD betting-e-process (Shekhar-Ramdas-2023; anytime-valid Ville-bounded), D = spectral ACF + BOCPD, E = conformal Mahalanobis novelty. **α_total = α_ville ≈ 8·10⁻⁴ unified Ville-bounded;** methodology-mode-invariant by construction; classical-epoch-α retired.
- **Segmented baseline cell matrix** (hour × day × workload × tenant × region) with hierarchical pooling and Ledoit-Wolf shrinkage.
- **Schema-continuity check in L0** — breaking-change detection across deploy boundaries suppresses affected signals until re-baseline.
- **Reversibility-aware verdicts.** Forward-only deploys get `pause_and_alarm` instead of automated rollback.
- **Self-explaining verdicts.** Every verdict carries `family_id, detector_id, statistic, threshold, α spent, cell key, cell confidence, schema continuity, baseline version`.
- **Second value prop: service-maturity dashboard** built from versioned baseline archive.

Runway state: end-to-end on synthetic data; 158+ tests green; 6 canned demos. Live Argo wiring, MLflow / Unity Catalog, DID reference cells, propensity matching, incident-state input, metric registry, and recalibration automation loop are first-90-days-for follow-on work.

---

## Axes at a glance — the compact matrix

Rows are comparison axes. Columns are the ~14 most important competitors grouped by lane. `DS=YES` unless noted on the axis row.

| Axis | DS | Harness | LD Guardian | Argo Rollouts | Flagger | Kayenta | Google CAS | Meta Conveyor | Uber (Argos/uVitals) | Amazon Apollo | Datadog Watchdog | Dynatrace QG | the target platform LM | Arize/WhyLabs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Is a deploy-verdict gate (not detect-and-alert) | YES | YES | YES | YES | YES | YES | YES | YES | YES | YES | no | YES | partial | no |
| Anytime-valid / sequential tests | YES | ? | YES | no | no | no (fixed window) | ? | ? | ? | no | no | no | no | no |
| Multivariate / covariance-aware joint test | YES | no | no | no | no | no | ? | ? | partial (clustering) | composite-alarm only | no | no | no | partial (WhyLabs) |
| Novelty / unknown-unknowns channel with formal bound | YES | partial (new-error clusters) | no | no | no | no | ? | ? | ? | no | partial (new error types) | no | no | partial (LLM guardrails) |
| AI-inference structural detectors (kv, MFU, HBM, collective_ops, slowbleed) | YES | no | no | no | no | no | no | no | no | no | no | no | no | no |
| Calibration-as-compile-step (thresholds derived from baseline + α, versioned artifact) | YES | no (auto-profile but no α contract) | no | no | no | no (defaults + operator overrides) | ? | ? | no (dynamic thresholds) | no | no | no | no | no |
| Shared α budget across detector families | YES | no | ? | no | no | no | ? | ? | no | no | no | no | no | no |
| Segmented baseline cells (time × workload × tenant × region) | YES | no | no | no | no | no (baseline cluster only) | ? | ? | seasonal only | no | no | no | no | no |
| Schema-continuity check across deploy boundary | YES | no | no | no | no | no | ? | ? | ? | no | no | no | no (UC handles schema) | no |
| Reversibility-aware verdict semantics (`pause_and_alarm` for forward-only) | YES | no | no | no | no | no | ? | partial (pipeline discipline) | ? | partial (operational) | no | partial (agentic-rollback preview) | no (UC governance) | no |
| Per-verdict provenance (family, detector, stat, threshold, α, cell, schema, baseline version) | YES | partial (log clusters) | partial | YES (k8s CRD status) | YES (events) | YES (per-metric judge) | ? | ? | YES (uMonitor) | YES (which alarm) | YES (insights) | YES (Davis cards) | YES (UC) | YES (explainability) |
| Orchestrator-agnostic adapter | YES | no (in Harness CD) | no (in LD flag plane) | n/a (is the orchestrator) | n/a | YES (REST service) | n/a (Google-internal) | n/a | n/a | n/a | YES (metric provider) | YES (CLI/REST gates) | no | YES as monitor |
| Incident-state input to gate (pauses on SEV-1) | specified for follow-on | partial (chat-agent input) | partial (PagerDuty) | no | no | no | partial (SRE freeze) | partial (site events) | partial | no | partial (DD Incidents) | YES (native) | no | partial (PD) |
| Baseline-history → maturity dashboard | YES | no | no | no | no | no | no | no | no | no | no | partial (SLO trend) | partial (baseline tables) | partial (drift trend) |
| Sample Ratio Mismatch / traffic-allocation-continuity check | specified for follow-on (#10) | ? | YES | no | no | no | ? | ? | partial (routing anomaly detection) | no | no | ? | no | no |
| `suppressed_insufficient_samples` verdict variant (minimum-context guard) | specified for follow-on (#11) | ? | YES (min-context) | no | no | no | ? | ? | ? | no | no | ? | no | no |
| Per-pod / per-node verdict granularity | specified for follow-on (#12) | YES (native) | no | no | no | no | ? | ? | ? | no | no | no | no | no |
| Fail-fast / ignore policy thresholds (operator escape hatches around detector portfolio) | specified for follow-on (#13) | YES (native) | no | partial (analysis rules) | partial (thresholds) | partial (judge thresholds) | ? | ? | ? | YES (alarm severity) | partial (monitor thresholds) | partial | no | no |
| Structured lifecycle event emission (`evaluation.triggered/.started/.tick/.suppressed/.finished`) | specified for follow-on (#14) | partial (pipeline stages) | no | partial (k8s Events) | partial (webhooks) | no | ? | ? | ? | partial (CloudWatch) | partial (DD events) | YES (business events) | no | no |

Notes on the matrix:

- Honesty flag on "incident-state": DeploySignal has this **architecturally specified** (addition #6) and **not shipped** in the project. Competitors with a `partial` are functionally ahead today on this axis.
- Honesty flag on "per-verdict provenance": DeploySignal's provenance is richer (compiled_config_version + cell_key + schema_continuity + α_consumed is a wider contract than any competitor publishes), but many competitors have SOME provenance. The discriminator is what fields the provenance contains, not whether it exists.
- Honesty flag on "orchestrator-agnostic": Kayenta is a standalone REST service, which is architecturally closest to O0. Dynatrace Quality Gates are callable from any pipeline, also close. DS wins on the design intent (Argo + Flagger + Spinnaker natively targeted, plus non-K8s), not on "nobody else can be called remotely."
- "Novelty with formal bound": conformal exchangeability gives DS a genuine formal FP floor; Harness/Datadog "new error type" channels are surfaces but not bounded channels.
- **Honesty flag on W6+1 batch additions (#10–#14):** these five axes were surfaced by this competitive-landscape analysis itself + the companion `COMPETITIVE-GAPS-ADDITIONS.md` gap review. DS's entry of `specified for follow-on (#N)` is the same status class as `incident-state` (architecturally-specified, not runway-shipped). Competitors with `YES` or `YES (native)` are functionally ahead today on these axes. Follow-on Q1 implementation estimated at ~2 weeks across the 5 additions (architect's breakdown in `coordination/ARCHITECT-REPLY-27.md`).

---

## Per-competitor cards

### Lane 1 — Commercial products

#### Harness Continuous Verification / AI-Native SRE (2026)

One-line: **Node-level** metric comparison (each canary node vs each primary node) using **Symbolic Aggregate Approximation** to compute deviation in standard-deviation units; log clustering produces **Known / Unknown / Unexpected Frequency** categories; operator tunes a High/Medium/Low **sensitivity** dial; also offers a no-ML "Plain Threshold Based Verification" mode. 2026 release adds auto-generated "verification profiles" and a "Human-Aware Change Agent" ingesting Slack/Teams incident chatter. Primary-source-verified at `developer.harness.io/docs/continuous-delivery/verify/cv-concepts/machine-learning/`.

**Specific Harness contract surface worth knowing:** Fail-Fast thresholds (hit → fail without analysis) vs Ignore thresholds (below → skip analysis; above → run comparative analysis) — this is a design pattern DS could borrow in its policy layer. Log feedback supports High/Medium/No Risk tagging that persists across verifications — a learning-loop pattern adjacent to DS's L5.

**DS wins:** formal α-budget across detector families, anytime-valid sequential tests, multivariate Hotelling T², conformal novelty bound, AI-inference structural detectors, segmented baseline matrix, reversibility-aware verdicts, orchestrator-agnostic adapter. **SAA deviation-in-standard-deviations is a weaker stat than mSPRT — DS should explicitly frame this in the pitch.**

**They win or match:** distribution / GTM, integrated rollback wiring inside Harness CD, the "AI SRE" brand, incident-chat ingestion as a signal, broad APM connector library, node-level (not service-level) canary comparison is good practice DS should match (see below).

**DS needs work:** incident-chat ingestion (DS has PagerDuty-style state specified in addition #6; chat-as-signal is unspecified); auto-generated verification profiles (DS requires operator to declare SLIs per addition #3 metric registry — not unreasonable, but their zero-config story is stronger for day-one adoption). **Node-level vs service-level comparison: DS should verify it supports node-level breakdown when K8s/Argo supplies per-pod labels; otherwise DS is aggregating over pods and missing pod-specific regressions that Harness would catch.**

#### LaunchDarkly Release Guardian / Guarded Rollouts (Jan 2026)

One-line: Feature-flag-native progressive rollout that applies **sequential testing to absolute differences** (not relative %) with a **confidence interval** that must fall entirely on the worse-performance side to declare a regression; Sample Ratio Mismatch is a separate always-rollback channel; minimum-context requirement auto-rollbacks if traffic is too thin.

**DS wins:** multi-detector α-budget; multivariate; novelty channel; structural AI-inference detectors; segmented baselines; schema-continuity; reversibility-aware; orchestrator-agnostic.

**They win or match:** LD says "sequential testing" out loud and explicitly ships **absolute-difference CI with SRM** — real differentiators, primary-source-verified (`launchdarkly.com/docs/home/releases/guarded-rollouts`). Flag-flip rollback is faster than redeploy. Deep enterprise GTM.

**DS needs work:** SRM check is a nice, cheap, understandable differentiator DS doesn't have — would fit inside L0 as a traffic-allocation-continuity check alongside schema-continuity. Could be a follow-on addition. Minimum-context auto-rollback is a robustness pattern DS should borrow — verdict should be `suppressed_insufficient_samples` rather than firing or silent-proceeding.

**Open question (still):** which sequential-test family LD uses (mSPRT? GAVI? group-sequential?) — the public docs we read describe the CI-based regression criterion and explicitly name "sequential testing" but do not name the family. Stats page linked from the guarded-rollouts doc was not reachable in pass 2 either.

#### Argo Rollouts (AnalysisTemplate)

One-line: CNCF K8s progressive-delivery controller. Analysis is operator-hand-coded — metric provider + boolean condition + count + interval.

**DS wins:** every detector-related field. Argo is not a competitor — DS plugs into Argo via the Level-1 web-metric-provider path in `ORCHESTRATION-ADAPTERS.md`.

**They win or match:** market position. Argo is *the* substrate DS needs to be inside.

**DS needs work:** the actual wiring to an Argo AnalysisTemplate is deferred; runway delivered Level-1 spec, not running code.

#### Flagger (Flux)

One-line: K8s CNCF progressive-delivery operator; boolean thresholds against metric queries (Prometheus / Datadog / CloudWatch / etc.) plus a consecutive-failure count.

**DS wins:** everything statistical; Flagger is a mechanical executor DS plugs into.

**They win or match:** service-mesh integration breadth (Istio, Linkerd, App Mesh, Contour, NGINX, Gloo, Skipper, Traefik, OSM, Kuma); Flux/GitOps native.

**DS needs work:** a Flagger-provider integration. Follow-on.

#### Spinnaker + Armory + Kayenta

One-line: Multi-cloud CD platform; Kayenta is the canary judge using per-metric Mann-Whitney U with a Hodges-Lehmann tolerance band (tolerance = 0.25 × |HL|, 98% CI).

**DS wins:** anytime-valid sequential (Mann-Whitney requires fixed window); shared α across detector families (Kayenta aggregates per-metric); multivariate Hotelling T²; conformal novelty; AI-inference structural detectors; segmented baseline matrix; schema-continuity; reversibility-aware; baseline-history maturity dashboard.

**They win or match:** real statistical test (not bare threshold); well-documented and hardened; extensively used in production at Netflix/Google; Kayenta is the reference mental model for "automated canary analysis" and DS should explicitly sit in that category.

**DS needs work:** Mann-Whitney is battle-tested; DS needs to justify why sequential mSPRT is worth the complexity cost on real data (not just adversarial synthetic). Follow-on: shadow-mode comparison vs Kayenta on the first customer service.

#### Octopus Deploy

One-line: Release orchestration with explicit "roll forward" philosophy; no native automated statistical canary judge.

**DS wins:** everything in the analysis layer.

**They win or match:** the roll-forward philosophy for DB migrations is a cultural cousin of DS's reversibility classification — a friendly intellectual neighbor, not a competitor. General CD orchestration for .NET/IIS/Windows shops.

**DS needs work:** nothing competitive-layer.

#### Red Hat OpenShift Pipelines + ACM

One-line: Tekton-based CI/CD on OpenShift; progressive delivery is delegated to Argo Rollouts. ACM handles fleet/cluster lifecycle, not per-deploy verdicting.

**DS wins:** same as Argo Rollouts — DS sits on top, not against.

**They win or match:** Red Hat customer base, integrated platform story.

**DS needs work:** nothing direct.

### Lane 2 — Internal / FAANG systems (public writeups only)

#### Netflix Kayenta (original paper + open-source)

One-line: Three-cluster pattern (production / baseline / canary); Kayenta judge uses **Mann-Whitney U confidence intervals** to classify each metric as **Pass / High / Low**; final canary score is the **simple ratio of Pass metrics / total metrics** (e.g., 9/10 → 90%). Apache 2.0 open source. Primary-source-verified at `netflixtechblog.com/automated-canary-analysis-at-netflix-with-kayenta-3260bc7acc69`.

**DS wins:** anytime-valid sequential (Mann-Whitney is fixed-window); multivariate (Kayenta is per-metric + simple aggregation); novelty channel; structural detectors; segmented baseline matrix (Kayenta uses a live baseline cluster); reversibility-aware; baseline-history maturity dashboard.

**They win or match:** brand authority / academic reputation; canonical reference for "canary analysis" in the industry; Pass/High/Low + simple Pass-ratio score is easy to explain.

**DS needs work:** DS narrative must explicitly position as "next-generation Kayenta" with the second-generation stats DNA — not "what Kayenta should have been" (too dismissive of prior art). DS should borrow Kayenta's simplicity-bias framing: "we chose techniques simple to understand." The 5-family portfolio is more complex than Kayenta's; need to defend the complexity cost with demo-evidence of what simpler approaches miss (Demos 2, 4, 5 do this).

#### Google Canary Analysis Service / SRE Workbook / Borg + Sisyphus + Rapid

One-line: CAS answers "Is the canary meaningfully worse?" via A/B vs control population inside Borg; Sisyphus orchestrates rollouts; the SRE Workbook canarying chapter (pass-2 primary-source-verified at `sre.google/workbook/canarying-releases/`) is the **methodology** reference doc but does not disclose the CAS algorithm.

**SRE Workbook chapter content (verified pass 2):** narrative methodology only — canary vs control A/B framing, metric selection principles (metrics should indicate problems + be representative and attributable), canary-population-and-duration trade-offs, risks of before/after-in-time evaluation, monitoring-data requirements. **No specific statistical test family is named.** The chapter steers explicitly clear of a "deep dive into statistics."

**DS wins:** maturity dashboard frame; **the stats side of DS is concretely specified and publishable** where CAS internals are not; orchestrator-agnostic adapter for non-Google environments.

**They win or match:** scale, integration with Borg / MPM / Rapid that nobody else has; the SRE Workbook is the reference methodology doc the entire industry copies from (and DS should cite it, not compete with it).

**DS needs work:** the CAS algorithm internals remain behind an ACM paywall (Davidovic & Beyer 2018, `queue.acm.org/detail.cfm?id=3194655`) — get the full paper before claiming DS surpasses CAS on any specific technical axis. The SRE Workbook itself is methodology, not a competitor.

#### Meta Conveyor (OSDI '23)

One-line: Meta's CD substrate — 30K+ pipelines, 97% fully automated, 55% continuous. Code-dependency analysis + faulty-release prevention + in-place updates. The paper is about pipeline orchestration, not statistical canary judging.

**DS wins:** the analysis step is Conveyor's weak point in public writeup; structural detectors, novelty, compiled α-budget, segmented baselines are explicitly DS's surface.

**They win or match:** scale, uniform tool across the company, dependency-analysis substrate.

**DS needs work:** the Conveyor full-PDF was blocked at fetch. Re-read offline before claiming Conveyor lacks a specific capability.

#### LinkedIn EKG

One-line: LinkedIn's auto canary analyzer; compares canary vs control machine over a 30-min window; 10K+ changes/month; integrated with LiX A/B.

**DS wins:** every statistical and segmentation field.

**They win or match:** scale of automation; LiX integration.

**DS needs work:** no direct gap. **Note: memory / prior conversation may reference "Waterloo / Rainbow" at LinkedIn — the researcher could not verify these are public deploy-system names; only EKG surfaces publicly. Do not use Waterloo / Rainbow in customer-facing pitch without a non-public source.**

#### Uber — Micro Deploy + Argos + uVitals + uMonitor

One-line: uDeploy is the deploy platform; Micro Deploy rolls services region-by-region with auto-rollback on anomaly; Argos generates dynamic thresholds against M3 historical time-series for cyclical metrics; uMonitor + uVitals do alerting.

**DS wins:** compiled α-budget, conformal novelty, structural detectors, reversibility-aware, maturity dashboard.

**They win or match:** scale and proven reliability.

**DS needs work:** **The name "Argus" does NOT surface for Uber publicly. Uber's anomaly system is "Argos" (no 'u'). "Argus" is a separate Salesforce time-series alerting tool.** Fix in any prior references.

#### Amazon Apollo / Internal Pipelines + ECS canary (Oct 2025)

One-line: Apollo deploys to fleets; Pipelines progresses through stages with mandatory bake periods; team high-severity aggregate CloudWatch alarm triggers rollback. ECS canary (Oct 2025) brings the same pattern to managed AWS.

**DS wins:** statistical sophistication; baseline segmentation; novelty; structural detectors; schema-continuity; reversibility-aware; maturity dashboard.

**They win or match:** discipline of bake-time + composite alarms is operationally proven; very simple, very robust.

**DS needs work:** bake-time discipline is addressed by addition #4 (per-signal bake profile); DS should explicitly name this as "Amazon-style bake-time, compiled per-signal from autocorrelation." Strong framing for an AWS-shop buyer.

#### Microsoft ExP / Azure internal

One-line: Canonical large-scale online experimentation system; Benjamini-Hochberg FDR + anytime-valid discussion in the literature; not a deploy gate per se but the methodology heavily informs deploy gating.

**DS wins:** structural AI-inference detectors; conformal novelty; segmented cell matrix; schema-continuity; reversibility-aware semantics. ExP is not a deploy gate.

**They win or match:** statistical rigor and publishing record. ExP's method papers are gold-standard references. DS should cite them on the FP-control side.

**DS needs work:** none competitive; add ExP citations to the stats-rigor section of the pitch.

### Lane 3 — Observability-adjacent

#### Datadog Watchdog Deployments / Change Tracking

One-line: AI-powered always-on anomaly detection using "Robust" seasonal-trend decomposition over up to 6 weeks of history; "faulty deployment detection" compares post-deploy behavior to prior-version behavior; alert-only, not gate-and-rollback.

**DS wins:** formal α-budget; multivariate joint test; conformal novelty bound; structural AI-inference detectors; segmented cell matrix; reversibility-aware; schema-continuity; **the gate itself** (Watchdog only alerts).

**They win or match:** distribution; battle-tested anomaly engine; seasonal handling that matures over weeks; deep APM tracing; topology graph for blast-radius reasoning.

**DS needs work:** topology awareness is Datadog's strongest UX. DS emits provenance fields, not a dependency graph. Either build a thin topology overlay or cede this to integrations explicitly.

#### New Relic Change Tracking / Applied Intelligence

One-line: Records change markers on charts; correlates incidents with changes; AIOps groups related incidents into Issues; not a deploy gate.

**DS wins:** the gate itself; everything statistical; segmentation; structural detectors.

**They win or match:** the change-tracking → APM correlation UX; broad install base; Applied Intelligence noise reduction.

**DS needs work:** change-tracking UX is solid; DS should ensure provenance surface renders as a "change card" in dashboards, not raw JSON.

#### Honeycomb BubbleUp

One-line: High-cardinality observability with heatmaps; BubbleUp ranks which dimensions/values are over-represented in an outlier subset; explanatory UX is best-in-class. Not a gate.

**DS wins:** the gate itself; formal statistical guarantees; structural detectors; segmented baselines; reversibility-aware.

**They win or match:** explanatory UX is the category leader; BubbleUp's contribution analysis is a genuine complement to DS.

**DS needs work:** nothing competitive — BubbleUp would be a great *partner* UI for post-verdict explanation.

#### Dynatrace Site Reliability Guardian (Release Validation) / Davis AI / Smartscape

One-line: **Site Reliability Guardian** (the current branding; Quality Gates is the older Cloud Automation name) automates release validation against **service availability, performance, capacity, and security objectives**. Pipeline posts a `guardian.validation.triggered` business event → Workflows triggers Guardian → Guardian queries Grail via **DQL** + evaluates against configured objectives + SLOs → emits `guardian.validation.finished` events → pipeline queries result to decide promote/abort. Primary-source-verified at `docs.dynatrace.com/docs/deliver/quality-gates`.

**What Guardian does NOT appear to do (per primary-source):** no specific statistical test family is named in the release-validation docs; objectives are DQL+SLO threshold comparisons against prior builds, not hypothesis tests. No joint multivariate, no anytime-valid sequential, no novelty channel is surfaced.

**DS wins:** compiled α-budget, anytime-valid multi-detector portfolio, structural AI-inference detectors, segmented cells with confidence tags, conformal novelty, reversibility-aware semantics, schema-continuity, baseline-history maturity dashboard.

**They win or match:** Smartscape topology-driven causal analysis; enterprise distribution; Site Reliability Guardian is the closest mainstream commercial product to DS in *framing* — it treats release validation as a first-class platform concern with business-event-driven orchestration. Davis AI's agentic-rollback preview overlaps with reversibility-aware verdicts.

**DS needs work:** **This is the single closest commercial competitor in framing.** DS pitch must explicitly call out what Site Reliability Guardian doesn't do (no anytime-valid sequential, no joint multivariate, no conformal novelty, no workload-structural detectors) rather than pretending it doesn't exist. Engineer a direct "Site Reliability Guardian vs DeploySignal" one-pager. Note: Guardian's business-event-driven contract is a good design pattern — DS's O0 adapter could emit similar lifecycle events (`validation.triggered` / `.started` / `.finished` / `.objective`) to match industry expectations.

#### Splunk Observability / SignalFx

One-line: Detector-based monitoring via SignalFlow; Historical Anomaly conditions construct dynamic thresholds from selected windows; not a first-class deploy gate.

**DS wins:** all gate-side concerns; statistical sophistication; segmentation; structural detectors.

**They win or match:** SignalFlow is genuinely flexible; Splunk APM scale; integrates with Harness.

**DS needs work:** nothing competitive.

#### Grafana ML / Adaptive Alerting / Faro

One-line: Grafana ML adds metric forecasting and anomaly bands via recording rules; `grafana/promql-anomaly-detection` is an OSS framework generating anomaly-band recording rules; Faro is RUM.

**DS wins:** detector portfolio with shared α-budget; structural detectors; multivariate; conformal novelty; reversibility-aware; the gate itself.

**They win or match:** OSS substrate; the recording-rule pattern (`promql-anomaly-detection`) is the closest architectural cousin to DS's calibration compiler in the wild — a public, debuggable, open-source prior-art pattern.

**DS needs work:** DS should cite `grafana/promql-anomaly-detection` as prior art for "math at build time" in the pitch — shows DS is extending a real trajectory, not claiming a unique idea out of whole cloth.

### Lane 4 — production-specific / ML-platform lens

#### the target platform Lakehouse Monitoring / MLflow Model Monitoring

One-line: Lakehouse Monitoring tracks data/model drift over inference tables; MLflow + Mosaic AI Model Serving + Deployment Jobs cover model lifecycle; no first-class progressive-delivery decision engine for services.

**DS wins:** AI-inference structural detectors (kv_saturation, mfu_collapse, hbm_elevation, collective_ops, slowbleed) are exactly the gap the target platform does not fill; conformal novelty; sequential anytime-valid; multivariate Hotelling T²; reversibility-aware verdicts; orchestrator-agnostic; baseline-history → maturity dashboard; α-budget contract.

**They win or match:** unified data + model platform; Unity Catalog governance; native to the Lakehouse pitch.

**DS needs work:** this is THE pitch audience. Frame as: "Lakehouse Monitoring covers the data/model drift side of the house; DeploySignal is the missing infrastructure-side and service-deploy-gate layer. Together they cover the full lifecycle." Not competitive; complementary. Mandatory pitch framing.

#### the target platform Asset Bundles / Deployment Jobs / IDE for DE

One-line: Asset Bundles + Deployment Jobs + new IDE for Data Engineering provide CI/CD for notebooks, jobs, pipelines; not a service-level canary judge.

**DS wins:** every deploy-judge dimension.

**They win or match:** native to the target customers; Bundles are the GitOps pattern for the Lakehouse.

**DS needs work:** integration story with Bundles for triggering calibration-compiler runs from CI — architecture-specified, for follow-on.

#### Snowflake DataOps

One-line: Liquibase / dbt / dataops.live patterns + native DCM Projects; CI/CD for schema and data pipelines. Not a statistical canary for live workloads.

**DS wins:** entirety of the analysis-engine layer.

**They win or match:** native to Snowflake / dbt customers; mature change-management pattern.

**DS needs work:** none direct.

#### Microsoft Fabric + Purview Unified Catalog

One-line: Data quality scans + materialized lake-view DQ reports + Data Activator rules; not a service-level deploy gate.

**DS wins:** entirety of the analysis-engine layer.

**They win or match:** native to Fabric customers.

**DS needs work:** none direct.

#### Hugging Face / Weights & Biases — model-deploy validation

One-line: W&B LLM Evaluation Jobs + Models + Launch run benchmark suites; HF eval ecosystem covers batch eval; gating is *evaluate-pre-deploy*, not progressive-delivery-with-rollback.

**DS wins:** live-traffic sequential analysis; structural workload detectors; infrastructure multivariate; conformal novelty; segmented cell baselines; reversibility-aware; orchestrator integration.

**They win or match:** pre-deploy eval suites (a complement, not a competitor).

**DS needs work:** explicit upstream integration story with eval suites — "eval score is a Tier-1 SLI that feeds the gate" — is deferred but should be a pitch talking point.

#### Anthropic / OpenAI public writeups on eval-gated deploys

One-line: Public writeups focus on pre-deploy alignment / behavioral evals (Anthropic Bloom; the joint Anthropic-OpenAI alignment exercise). No public detail on the runtime progressive-delivery loop for serving fleets.

**DS wins:** runtime canary semantics; infra-side structural detectors; baseline cell matrix.

**They win or match:** the "eval-gated release" pattern is mainstream; pre-deploy evals belong upstream of DS, not in competition.

**DS needs work:** none competitive. DS's Demo 4 (stylized Anthropic-2025 quality regression) already uses this frame.

#### Arize / Fiddler / WhyLabs — ML observability

One-line: Drift, performance, fairness, and LLM guardrails (prompt-injection, toxicity, hallucination); post-deploy monitoring with some pre-prod evaluation. Not a statistical canary judge.

**DS wins:** the deploy gate itself; AI-inference structural detectors (vs LLM-content detectors); compiled α-budget; orchestrator-agnostic adapter; reversibility-aware verdicts.

**They win or match:** LLM-content guardrails (prompt injection, toxicity, hallucination); explainability / SHAP; bias / fairness monitoring; deep ML observability surface.

**DS needs work:** **LLM-content safety guardrails are a real category DS does not address and should not claim.** Cede or partner. Could be a future Family F if demanded, but not current scope or for follow-on Q1.

---

## Top 5 real threats

Ranked by "how close is their roadmap to DS's pitch frame":

1. **LaunchDarkly Release Guardian (Jan 2026 sequential testing)** — the only commercial product actually saying "frequentist sequential testing" and shipping SRM.
2. **Harness AI-Native SRE (2026)** — owns CD pipelines; new "AI auto-builds verification profiles" + incident-chat ingestion is direct overlap on the self-tuning-gate pitch.
3. **Dynatrace Quality Gates + Davis AI agentic rollback (Preview)** — closest to DS in *framing*; release validation as a first-class platform concern; topology-aware causal explanations; agentic rollback proposer overlaps with reversibility-aware.
4. **Datadog Watchdog Deployments + Change Tracking** — owns the observability substrate most teams already trust. If Datadog ships a gate API in front of Argo, that's the fastest commercial wedge.
5. **Spinnaker + Kayenta at Netflix/Google scale** — the default mental model for "canary analysis." If a buyer's team has already adopted Kayenta, displacement is hard.

## Top 5 credibility-moat items (defensible edges)

1. **Calibration compiler with versioned `CompiledConfig` artifact + per-verdict provenance.** No competitor publicly ships build-time-derived thresholds with α-budget contract and `compiled_config_version` on every verdict. Closest cousin: `grafana/promql-anomaly-detection` — a one-detector hand-roll recording-rule pattern.
2. **Five-detector portfolio sharing a single α budget** — Hotelling T² with Ledoit-Wolf + conformal Mahalanobis novelty + BOCPD + 16 AI-inference structural detectors. Every commercial competitor is single-method.
3. **Truncated mSPRT + Page-CUSUM (anytime-valid sequential).** Only LaunchDarkly says "sequential" out loud and they don't name the family. Kayenta is fixed-window. Datadog/NewRelic/Honeycomb are detect-and-alert, not gate-and-judge.
4. **Reversibility-aware verdict semantics (`pause_and_alarm` for forward-only changes).** Octopus preaches "roll forward" philosophically; nobody else encodes it as a verdict type. Resonates immediately with anyone who has rolled back a schema migration.
5. **Service-maturity dashboard from versioned baseline archive.** No competitor frames the deploy gate as the substrate for platform-engineering maturity trending (baseline p99 down = service got faster; rollback frequency down = deploys got safer). Unique second value prop reusing the same data.

## Top 5 honest gaps

1. **Distribution and brand.** Harness, LaunchDarkly, Datadog, Dynatrace, New Relic, Splunk, Honeycomb, the target platform all have sales motions and customer trust DS does not. Concede on GTM until the first lighthouse customer ships.
2. **Topology / causal RCA UX.** Dynatrace Smartscape + Datadog Service Map turn a verdict into "here's the cause-and-effect chain." DS emits provenance fields, not a topology graph. Either build a thin topology overlay or cede to integrations.
3. **LLM-content safety guardrails.** Fiddler Guardrails, WhyLabs LangKit, Arize bias/safety own this. DS addresses infrastructure-side AI signals, not output-content quality. Concede or partner.
4. **Pre-deploy evaluation batteries.** W&B / HF / Anthropic Bloom / OpenAI Evals are the upstream gate. DS is the runtime gate; integrate with eval results, don't duplicate.
5. **In-pipeline native CD UX (visual designer, RBAC, secret stores).** Harness/Spinnaker/Argo CD/Octopus have a decade head start. DS must position as "the analysis engine inside your existing rollout controller," not as a new pipeline product. The O0 adapter is the right move; sell it that way explicitly.

---

## What this comparison says about the pitch

A Claude-based TPM reading this document should walk away with these calibrated talking points:

**Lead with what nobody else has:** The calibration compiler + versioned `CompiledConfig` + α-budget contract. This is the architectural innovation. Every other axis — sequential, multivariate, novelty, structural — is a *consequence* of the compiler. Lead there.

**Second value prop — maturity dashboard — is orthogonal to every competitor.** Even Dynatrace Quality Gates, which is closest in framing, does not frame deploy-gate output as the substrate for service/engineering/product maturity trending. Use this in every pitch.

**Head-to-head framings to pre-build:**
- DS vs Kayenta — "second-generation ACA" narrative, citing Kayenta's Mann-Whitney + per-metric limitations directly.
- DS vs Dynatrace Quality Gates — the closest commercial competitor; needs a direct one-pager.
- DS vs Harness CV — the largest commercial wedge on AI-SRE positioning.
- DS vs LaunchDarkly Guardian — defensively, since LD is the only one saying "sequential" out loud.
- DS inside Argo Rollouts — the Level-1 metric-provider slot positioning; the "we're the intelligence, not the pipeline."

**Concessions to lead with (calibrated confidence, not over-claiming):**
- Pre-deploy evals are upstream (W&B / HF / Bloom). DS integrates with them.
- LLM-content guardrails are not DS's lane (Fiddler / Arize / WhyLabs). DS addresses infra + service SLIs.
- Topology-driven RCA is Dynatrace and Datadog territory; DS provenance is structured but not graph-native.
- Distribution / brand lag the incumbents; DS needs lighthouse customer before commercial motion.

---

## Statistical foundations — critique, defense, and SOTA-upgrade analysis

_Added 2026-04-19 PM in response to a direct question from John: "What are the arguments against relying on the mathematical models we've chosen? Does it represent state-of-the-art for deployment metric analysis?" Routed to both TPM and architect for awareness — the conclusions reshape the pitch's calibrated-confidence stance on statistical claims, and the recommended for follow-on upgrade sequence is an architect input._

### Per-family honest critique

**Family A (Page-CUSUM with mixture prior — ships under a legacy `mSPRT.ts` filename per `ARCHITECT-REPLY-05`; `NORTH-STAR-ARCHITECTURE.md` §L2 line 113 still says "truncated mSPRT" and is stale per REVIEWER-REPORT-07 D1).** The "always-valid" guarantee from Ville's inequality assumes observations are i.i.d. under the null. Deploy metrics are almost never i.i.d. — p99 latency is heavy-tailed and autocorrelated; error rates are bursty; cost-per-request aggregates over billing windows. τ² IS compiler-derived (`tools/calibrate.ts:445` emits `τ² = δ_min² / 4` where `δ_min = max(0.05 × mean, 2 × std)`), so the assumption-violation on τ² is weaker than a pure hand-specified prior would imply — but the constants 4, 0.05, 2 are still operator-chosen and the i.i.d. assumption is the bigger problem. Sequential tests also pay a known efficiency cost vs fixed-horizon: Johari et al. (2021, *Operations Research*) show always-valid CIs shrink as O(√(log log T / T)) vs O(√(1/T)) for fixed-horizon. Kayenta's Mann-Whitney U is actually *more* robust to distributional assumptions than Page-CUSUM in some regimes.

**Family B (16 hand-designed structural signatures).** This is the heart of the critique DS levels at the old engine — "hand-tuned classifiers don't generalize." DS replies that it tunes *numbers* via the compiler and only hand-designs *structure*, but the structure itself is still hand-curated by one engineer. Selection bias: 16 patterns chosen from what's been observed or read about LLM serving; the real distribution of AI-inference failures at production scale may be meaningfully different. Outside AI inference — data plane, event streams, batch, ML training — each workload needs its own structural library, each with the same selection-bias problem. There is no principled reason to believe 16 is the right number, or that these 16 are the right 16.

**Family C (Hotelling T² + sequential MMD).** Hotelling T² assumes multivariate normality of the signal vector. Real telemetry vectors are not multivariate normal — mixtures of heavy-tailed, bounded, and count variables. In small per-cell samples (~95 samples per 2-D hour×day cell for the demo baseline), the χ² approximation is shaky. Ledoit-Wolf shrinkage helps *covariance estimation*, not the distributional assumption. Sequential MMD is nonparametric and would fix most of this — but it's architecturally specified, not shipped. So the Family C running today is the weaker of the two DS designed.

**Family D (spectral ACF peak + BOCPD).** Spectral peak detection needs a frequency band; oscillations outside the configured band are missed. BOCPD's hazard-rate parameter is operator-tunable or must be fit from labeled regime changes (which DS doesn't have). Both are univariate, so they miss joint regime change. BOCPD is a 2007 method; recent change-point-detection literature (neural CPD, e-process CPD from the Ramdas group) beats it on standard benchmarks.

**Family E (Mahalanobis novelty scored against parametric-Gaussian bootstrap — shipped code does NOT use a real held-out calibration set as `NORTH-STAR-ARCHITECTURE.md` §L2 line 121 says; REVIEWER-REPORT-07 D2 flagged this divergence).** What's actually shipped: `tools/calibrate.ts:540` draws 20K `N(0, Σ)` vectors and Mahalanobis-scores them at compile time; `engine/detectors/conformal.ts:68` uses the standard unweighted plus-one-corrected empirical p-value. Under Gaussian Σ the scores are χ-distributed with p dof, so formal FP control holds under the Gaussian model — but technically calling this "conformal" is a misnomer in the exchangeability-guarantee sense, since there's no real held-out calibration set. The exchangeability critique applies to the parametric-bootstrap path too — deploy traffic is never Gaussian with the baseline's Σ (diurnal cycles, tenant shifts, seasonality violate it). Addition #2 (segmented cells) reduces the violation; doesn't remove it. Mahalanobis also only detects *point* novelty; distributional-shape novelty (variance changes, multimodality) is invisible. The ICLR 2026 ACAD-TSFM weighted-quantile variant is architecture-spec'd but not shipped.

**Cross-cutting.** The shared α budget is **model-conditional**, not unconditional. Family A has formal FP control under its i.i.d.-Gaussian null + compiler-derived τ²; Family C has formal FP control under multivariate-Gaussian Σ; Family E has formal FP control under the same Gaussian-Σ model (shipped parametric bootstrap produces χ-distributed scores). Each family's guarantee holds *conditional on its own null-distribution assumption being satisfied*. If real production data violates any family's assumption — and most do somewhere — that family's contribution to the joint FP rate is higher than the budget claims. "10⁻³ per deploy" is aspirational under the stated model; empirical on real baselines will be somewhere else. The calibration compiler produces byte-identical config from same inputs — but the *inputs themselves* (baseline window, α allocation, policy profile, `TAU_SQUARED_DIV`, `FAMILY_E_CALIBRATION_SIZE`) are operator judgments. And everything DS has calibrated to date is on synthetic data that's internally consistent with each family's null model; real production baselines contain anomalies, autocorrelation, noisy tenants, and drift that will probe these assumptions in ways the synthetic generator doesn't.

### What's SOTA in 2024-2026 that DS doesn't currently use

- **Betting-based e-processes and game-theoretic sequential tests** (Ramdas, Waudby-Smith, Howard et al., 2021-2024) — largely superseded mSPRT in the always-valid literature. Relax i.i.d. assumption, tighter bounds in practice.
- **Foundation-model time-series anomaly detectors** — TimeGPT, Moirai, Chronos, TSFM-AD; ACAD-TSFM (ICLR 2026) is cited in DS's own architecture doc but not shipped.
- **Transformer-based change-point detection** and **score-based CPD** — beat BOCPD on standard benchmarks.
- **Robust covariance estimators** — Minimum Covariance Determinant, MRCD, OGK — stronger than Ledoit-Wolf shrinkage when there are outliers in the baseline (there always are).
- **Causal-inference integrations** — DID, synthetic control, propensity-score matching, switchback — table-stakes in modern A/B-testing literature. DS has these architecturally specified (additions #1, #7) but not shipped.

### The strongest steelman against DS's current approach

*"You've bet on seven classical-statistics machines, each with known distributional assumptions that real deploy metrics routinely violate. Your promised false-positive floor is notional, not guaranteed. A transformer-based anomaly detector trained on your audit log would probably match or beat any single family on any held-out benchmark, with less theory and less operator burden. Your real moat is the composition and the compile-step — not the detectors themselves. And the composition is only as good as its weakest family's null-distribution fidelity."*

### The defense

**(1) Auditability is a first-order requirement for gating, not a nice-to-have.** A neural detector that beats DS on benchmark recall is worse in the gating context if its answer to "why did you roll back my deploy" is "the model said so." DS's per-verdict provenance is the contract oncall needs. Alerting and gating are different optimization problems — DS is optimized for the latter.

**(2) Rigor + composability + cheap runtime is a Pareto-defensible point.** Each family individually is inferior to a well-tuned modern alternative. In combination, with a shared α budget, at microseconds-per-tick runtime, with reproducible builds from versioned config — DS is in a region of the design space that no shipped competitor occupies. Commercial competitors (Kayenta, Harness CV, LaunchDarkly Guardian, Dynatrace SRG) all use single methods with looser guarantees. Academic SOTA detectors are not shipped as gates anywhere.

**(3) The architecture accommodates SOTA.** Family C already specifies sequential MMD; Family E already specifies ACAD-TSFM; additions #1 and #7 already specify DID and propensity matching. The calibration compiler is explicitly pluggable — swapping detectors is a compile-time change, not an architectural change. DS shipped simpler variants first because they're defensible on small synthetic baselines; for follow-on work on real production data is where SOTA variants plug in.

### Honest pitch framing

_"DS is principled, auditable, composable, and follow-on-extensible — Pareto-defensible against both commercial products (which are simpler) and academic detectors (which are not shipped as gates). It is not bleeding-edge on any single statistic and does not claim to be."_

This lands better than "we have formal α guarantees" — because the formal α guarantees are notional until real-data calibration proves them. It lines up with the calibrated-confidence posture DS is already committed to in the PM-critique response (deleted).

### Architecture compatibility with SOTA — by design

DS's portfolio fusion and α-budget framework doesn't care what statistic each family produces — it just needs `{verdict, statistic, threshold, alpha_consumed, reason_code, provenance}` from each. The calibration compiler's contract is "take baseline + α allocation, emit versioned CompiledConfig" — whatever's inside a family is replaceable behind that contract. The `CompiledConfig` schema already has per-family blocks designed to hold arbitrary learned parameters. So the architecture absorbs SOTA upgrades cleanly.

**The one architectural principle at risk** is "math at build time; arithmetic at runtime." Some SOTA upgrades preserve it (classical e-processes, MMD, robust covariance). Others break it (foundation-model novelty, transformer CPD) — they put neural inference in the runtime path. Not a disqualifier, but it changes the pitch claim "microseconds per tick" and adds GPU/accelerator operational burden.

### Compute penalties per SOTA upgrade

| Upgrade | Replaces | Runtime cost per tick | Compile-time cost | Operational burden |
|---|---|---|---|---|
| Betting-based e-processes (Howard/Ramdas) | mSPRT in Family A | Same (~μs; log-sum-exp) | ~same | none |
| Sequential MMD with RBF kernel | Hotelling T² in Family C | Low (O(nm), ~ms) | 10-100× (bootstrap null) | none |
| Robust covariance (MCD / MRCD / OGK) | Ledoit-Wolf in Family C | Zero (same T² arithmetic) | 10-100× (iterative fit) | none |
| Weighted-quantile conformal (Barber 2023) | Standard conformal in Family E | Same (p-value lookup) | ~same | none |
| Neural CPD / score-based CPD | BOCPD in Family D | Medium (1-10ms with small NN) | Training (minutes-hours) | Model artifact + retrain cadence |
| Foundation-model anomaly (ACAD-TSFM / TimeGPT / Moirai) | Conformal Mahalanobis in Family E | **High (10-100ms per tick, GPU recommended)** | Zero-shot: low; fine-tuned: hours on GPUs | MLflow + Unity Catalog + GPU quota + retrain |

The boundary is sharp: **is there a neural forward pass in the runtime path?** If no, the upgrade is essentially free at runtime. If yes, DS's "arithmetic at runtime" principle is gone and the cost is real. Storage also scales with neural-detector embeddings per cell × history — gigabytes per service for a foundation-model Family E, versus megabytes for everything classical.

### Does the framework + SOTA detectors produce a better overall result? — yes, and the moat sharpens

Three reasons:

**1. Recall gains per family compound.** Each SOTA alternative beats its classical predecessor on standard benchmarks (modestly for Family A e-processes, significantly for Family E foundation-model detectors). Stacking them in DS's shared-α portfolio gives multiplicative coverage gains, not additive.

**2. The moat moves to where it always belonged.** DS's real defensibility is the calibration compiler + portfolio composition + reversibility/schema/cell/provenance contract, not any individual detector. Today's pitch is "principled classical stats, composed well." After SOTA upgrades, the pitch becomes "2026 SOTA detectors, composed well, with formal FP control and auditable gating" — strictly harder for competitors to match. LaunchDarkly / Dynatrace / Harness don't have the compiler + contract; foundation-model-based AIOps vendors don't have the gating contract + α budget. DS with SOTA inside is a unique combination.

**3. Operational burden lands in the target platform' sweet spot.** Neural detectors need MLflow, Unity Catalog, GPU quota, retrain cadence — which the target platform provides as platform. Foundation-model Family E at production scale is *easier* to operate than at any other potential home. Pitch-positive.

**Important caveat:** The α budget gets **harder, not easier**, after SOTA upgrades. Neural detectors' null distributions are non-analytical, so α calibration depends entirely on bootstrap-from-healthy-baseline. That procedure needs more samples than synthetic-project scale to be trustworthy. So SOTA upgrades ship *after* the first follow-on period of real-production baseline accumulation — roughly months 3-6, not month 1.

### Recommended upgrade sequence — compressed

_Revised 2026-04-19 PM: John pulled Tier 1 forward from follow-on to immediate work under continuous-flow cadence + current high-resourcing posture (architect + TPM + 2× Mac Claude + Reviewer). Tier 2/3 remain gated on real-production-baseline accumulation._

**Tier 1-SOTA — in flight as of 2026-04-20. Low/no compute penalty, strict-additive on CompiledConfig (no v5 bump).**
- Sequential MMD (NORTH-STAR §L2 Family C spec) — confirmed NOT shipped today; registry slot `sequential_mmd_joint_vector` reserved in `audit/SCHEMA.md:220`. Bundles with Addition #18 brief per TPM-REPLY-30 lean.
- Addition #18 — Robust covariance (MCD or MRCD) for Family C. Replaces shipped Ledoit-Wolf path (`tools/calibrate.ts:387-428`). Runtime T² arithmetic unchanged (`engine/detectors/hotelling.ts`). Architect brief pending as ARCHITECT-REPLY-33.
- Addition #17 — Betting-based e-processes for Family A. Replaces shipped Page-CUSUM with mixture prior (`engine/detectors/mSPRT.ts:81`; filename is legacy). Folds §L2 D1 text update. Architect brief pending as ARCHITECT-REPLY-34.
- Addition #19 — Weighted-quantile conformal for Family E. Replaces or reweights the shipped parametric-Gaussian bootstrap (`tools/calibrate.ts:540`) + unweighted empirical p-value (`engine/detectors/conformal.ts:68`). Folds §L2 D2 text + `conformal.ts:6` header update. Architect brief pending as ARCHITECT-REPLY-35.

TPM routing for Tier 1-SOTA (active as of 2026-04-20): **REVIEWER-REPORT-07 delivered** (Reviewer confirmed all four land strict-additive; flagged shipped-vs-spec divergences D1 Page-CUSUM and D2 parametric-bootstrap for architect to fold into briefs). **TPM-REPLY-30 dispatched** to architect 2026-04-20 AM requesting ARCHITECT-REPLY-33 (#18 + Sequential MMD bundled), REPLY-34 (#17 e-processes), REPLY-35 (#19 weighted conformal). **Mac Claude currently on Addition #5** (reversibility, final competitive-parity Tier 1 piece); SOTA batch queues after #5 merges. **Session 1 (main)** takes #18 + MMD; **Session 2** takes #17 or #19 in whichever order architect briefs land.

**Tier 2 — needs real-production-baseline history; gated on first follow-on customer service shadow mode. Medium compute cost, shadow-mode first.**
- Score-based CPD for Family D — compared in dashboard against BOCPD before promote
- Zero-shot foundation-model novelty (Chronos / Moirai) for Family E — shadow-only, compared against conformal Mahalanobis in the maturity dashboard

**Tier 3 — gated on first follow-on customer + MLflow/UC integration. High compute cost.**
- Fine-tuned foundation-model Family E (ACAD-TSFM style)
- Transformer CPD in Family D
- Possible new Family F (LLM-content guardrails) — addresses the gap Fiddler/Arize own today; requires partnership decision

### Handoff targets

_Active as of 2026-04-19 PM. Compressed timeline; Tier 1 is current work, not roadmap._

- **Reviewer (first, complete):** REVIEWER-REPORT-07 delivered 2026-04-20. Headline: all four upgrades land strict-additive on CompiledConfig (no v5 bump); shipped-vs-spec divergences D1 (Family A is Page-CUSUM not mSPRT) and D2 (Family E uses parametric-Gaussian bootstrap not held-out calibration) should fold into architect briefs.
- **Architect (second, in progress):** TPM-REPLY-30 dispatched 2026-04-20 AM requesting ARCHITECT-REPLY-33 (#18 + Sequential MMD, bundled per TPM lean), REPLY-34 (#17 e-processes, folds §L2 D1 text), REPLY-35 (#19 weighted conformal, folds §L2 D2 text + conformal.ts:6 header). Structural decisions surfaced per addition for architect sign-off in the briefs.
- **Mac Claude session 1 (main branch):** implement Sequential MMD + MCD/MRCD in Family C. Single PR preferred. Queued behind #5 reversibility merge.
- **Mac Claude session 2 (post-ws3-demo wrap):** take #17 or #19 in whichever order architect briefs land. Do not start both simultaneously. Queued behind post-Tier-1 retrofit session (#10/#13 lifecycle events via #14 contract).
- **TPM (this session and future):** draft handoff briefs under `coordination/handoffs/` after architect briefs land; maintain STATUS.md NS row; enforce standing guardrails (arithmetic-at-runtime preserved, 158+ tests green, ≥97.5% TP / 0% FP adversarial floor, `compiler_version` bump per upgrade — strict-additive so no `CompiledConfig.version` bump needed).
- **Pitch impact (deferred, build-first posture):** when pitch polish resumes, add the steelman + defense pair to the PM-critique response (deleted) as a new Q/A. Framing shifts from "we have formal α guarantees" to "principled, auditable, composable, running 2026 SOTA detectors inside a unique gating contract." The formal-guarantees claim gets empirical validation as Tier 1 ships and baselines accumulate.

---

## Open research questions — next pass

1. **LaunchDarkly sequential-test family.** Public Guarded Rollouts doc names "sequential testing" and describes the absolute-difference-CI criterion, but does not name the family (mSPRT? GAVI? group-sequential?). Statistics page at `/docs/home/experimentation/statistics` was not reachable in pass 2. Worth a direct fetch when the LD docs URL structure stabilizes, or a careful read of their blog archive.
2. **Datadog Watchdog Deployments algorithm details.** The "Robust" seasonal-trend-decomposition algorithm's specifics are referenced but not fully spec'd in the public docs reachable in either pass. Datadog's docs are JS-heavy SPAs that don't render cleanly in Chrome text extraction — may need screenshots + OCR or a targeted API call.
3. **Meta Conveyor (OSDI '23).** Full PDF not re-attempted in pass 2. Re-read offline before claiming Conveyor lacks specific anomaly-detection capability.
4. **Google CAS algorithm internals.** ACM Queue article (Davidovic & Beyer 2018) is paywalled; full method was not reached. Obtain the article directly.
5. **Dynatrace Davis agentic rollback (Preview).** Is the preview reversibility-aware? Could substantially narrow DS's edge on that axis.
6. **the target platform internal deploy tooling.** Public docs cover Asset Bundles + MLflow + Lakehouse Monitoring; internal the target platform deploy-gate tooling (if any) is not surfaced. Worth asking during the the target audience directly.
7. **LinkedIn "Waterloo" and "Rainbow"** — verify whether these are real internal names or a memory error; EKG is the only public LinkedIn canary name.
8. **Uber "Argus" disambiguation** — confirm the Uber system is "Argos" (no 'u'); "Argus" is Salesforce.

---

## Source index (deduplicated)

### Lane 1 — Commercial

Harness:
- [Verify Overview](https://developer.harness.io/docs/continuous-delivery/verify/verify-deployments-with-the-verify-step/)
- [ML Usage in CV](https://developer.harness.io/docs/continuous-delivery/verify/cv-concepts/machine-learning/)
- [Interpret Log Verification Results](https://developer.harness.io/docs/continuous-delivery/verify/cv-results/interpret-log-results/)
- [Harness AI Deployment Verification](https://www.harness.io/products/continuous-delivery/ai-assisted-deployment-verification)
- [Harness AI Jan 2026 updates](https://www.harness.io/blog/harness-ai-january-2026-updates)
- [Release Orchestration AI verification (Long Island NY, 2026-03-31)](https://www.longisland-ny.com/2026/03/31/harness-rolls-out-release-orchestration-features-with-ai-enabled-verification-and-rollback/)
- [Continuous Verification Demystified](https://www.harness.io/blog/continuous-verification-demystified)

LaunchDarkly:
- [Guarded rollouts](https://launchdarkly.com/docs/home/releases/guarded-rollouts)
- [Creating guarded rollouts](https://launchdarkly.com/docs/home/releases/creating-guarded-rollouts)
- [Managing guarded rollouts](https://launchdarkly.com/docs/home/releases/managing-guarded-rollouts)
- [Sample ratio mismatch](https://launchdarkly.com/docs/home/experimentation/sample-ratios)
- [Meet Release Guardian](https://launchdarkly.com/blog/meet-release-guardian/)
- [PagerDuty + Guardian](https://launchdarkly.com/docs/integrations/pagerduty-guardian-edition)

Argo Rollouts:
- [Analysis & Progressive Delivery](https://argo-rollouts.readthedocs.io/en/stable/features/analysis/)
- [analysis.md (GitHub)](https://github.com/argoproj/argo-rollouts/blob/master/docs/features/analysis.md)
- [Prometheus plugin sample](https://github.com/argoproj-labs/rollouts-plugin-metric-sample-prometheus)
- [Kayenta integration](https://argo-rollouts.readthedocs.io/en/stable/analysis/kayenta/)

Flagger (Flux):
- [Metrics Analysis (Flux mirror)](https://fluxcd.io/flagger/usage/metrics/)
- [metrics.md (GitHub)](https://github.com/fluxcd/flagger/blob/main/docs/gitbook/usage/metrics.md)
- [Flagger repo](https://github.com/fluxcd/flagger)
- [Istio Canary tutorial](https://docs.flagger.app/tutorials/istio-progressive-delivery)

Spinnaker / Kayenta / Armory:
- [Kayenta repo](https://github.com/spinnaker/kayenta)
- [Mann-Whitney classifier source](https://github.com/spinnaker/kayenta/blob/master/kayenta-judge/src/main/scala/com/netflix/kayenta/judge/classifiers/metric/MannWhitneyClassifier.scala)
- [Canary config docs (GitHub)](https://github.com/spinnaker/kayenta/blob/master/docs/canary-config.md)
- [How canary judgment works](https://spinnaker.io/docs/guides/user/canary/judge/)
- [Mann-Whitney shortcomings issue](https://github.com/spinnaker/spinnaker/issues/6278)
- [Armory ACA docs](https://docs.armory.io/continuous-deployment/spinnaker-user-guides/canary/kayenta-canary-use/)
- [Performing ACA across cloud platforms (LaunchDarkly blog)](https://launchdarkly.com/blog/performing-automated-canary-analysis-across-a-diverse-set-of-cloud-platforms-with-kayenta-and-spinnaker/)

Octopus:
- [Modern deployment & rollback strategies (PDF)](https://i.octopus.com/whitepapers/modern-deployment-and-rollback-strategies.pdf)
- [Rollback Strategies blog](https://octopus.com/blog/rollback-strategies)
- [DB Backups & Rollbacks](https://octopus.com/docs/deployments/databases/common-patterns/backups-rollbacks)
- [K8s Canary Tutorial](https://octopus.com/devops/kubernetes-deployments/canary-deployments/)

OpenShift:
- [Canary deployment with Argo Rollouts on OpenShift (RH)](https://developers.redhat.com/articles/2024/05/28/canary-deployment-strategy-argo-rollouts-and-openshift-service-mesh)
- [OpenShift Pipelines product](https://www.redhat.com/en/technologies/cloud-computing/openshift/pipelines)
- [Progressive Delivery with OpenShift GitOps](https://medium.com/@dlakshma/progressive-delivery-with-openshift-gitops-operator-part-1-d851cf33f40c)
- [Sample AI-powered Argo plugin](https://github.com/kdubois/progressive-delivery)

### Lane 2 — Internal / FAANG

Netflix Kayenta:
- [Automated Canary Analysis at Netflix with Kayenta](https://netflixtechblog.com/automated-canary-analysis-at-netflix-with-kayenta-3260bc7acc69)
- [Introducing Kayenta (Google Cloud)](https://cloud.google.com/blog/products/gcp/introducing-kayenta-an-open-automated-canary-analysis-tool-from-google-and-netflix)

Google:
- [Canary Analysis Service (ACM Queue, Davidovic & Beyer 2018)](https://queue.acm.org/detail.cfm?id=3194655)
- [SRE Workbook — Canarying Releases](https://sre.google/workbook/canarying-releases/)
- [SRE Book — Release Engineering](https://sre.google/sre-book/release-engineering/)
- [Release Eng Best Practices @ Google (LISA15)](https://www.usenix.org/sites/default/files/conference/protected-files/lisa15_slides_mcnutt.pdf)

Meta Conveyor:
- [Conveyor paper PDF (USENIX)](https://www.usenix.org/system/files/osdi23-grubic.pdf)
- [USENIX OSDI '23 page](https://www.usenix.org/conference/osdi23/presentation/grubic)
- [Talk video (YouTube)](https://www.youtube.com/watch?v=N7Ocd3xaz9U)

LinkedIn EKG:
- [Monitoring the Pulse of LinkedIn](https://engineering.linkedin.com/blog/2015/11/monitoring-the-pulse-of-linkedin)
- [Production testing with dark canaries](https://www.linkedin.com/blog/engineering/infrastructure/production-testing-with-dark-canaries)

Uber:
- [Micro Deploy](https://www.uber.com/blog/micro-deploy-code/)
- [Observability at Scale](https://www.uber.com/blog/observability-at-scale/)
- [uVitals](https://www.uber.com/blog/uvitals-an-anomaly-detection-alerting-system/)
- [Argos real-time alerts](https://eng.uber.com/argos-real-time-alerts/)
- [Model-agnostic anomaly detection](https://www.uber.com/blog/anomaly-detection/)
- [Safe and Fast Deploys at Planet Scale (InfoQ)](https://www.infoq.com/articles/uber-deployment-planet-scale/)
- [Salesforce Argus (disambiguation)](https://engineering.salesforce.com/argus-time-series-monitoring-and-alerting-d2941f67864/)

Amazon:
- [The Story of Apollo](https://www.allthingsdistributed.com/2014/11/apollo-amazon-deployment-engine.html)
- [Going faster with continuous delivery (Builders' Library)](https://aws.amazon.com/builders-library/going-faster-with-continuous-delivery/)
- [Automating safe hands-off deployments (Builders' Library)](https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/)
- [ECS canary deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/canary-deployment.html)
- [Automate rollbacks for ECS w/ CloudWatch](https://aws.amazon.com/blogs/containers/automate-rollbacks-for-amazon-ecs-rolling-deployments-with-cloudwatch-alarms/)

Microsoft ExP:
- [ExP Platform homepage](https://exp-platform.com/)
- [Patterns of Trustworthy Experimentation — During-Experiment](https://www.microsoft.com/en-us/research/group/experimentation-platform-exp/articles/patterns-of-trustworthy-experimentation-during-experiment-stage/)
- [A/B Testing Infrastructure Changes at ExP](https://www.microsoft.com/en-us/research/group/experimentation-platform-exp/articles/a-b-testing-infrastructure-changes-at-microsoft-exp/)
- [Alerting in ExP](https://www.microsoft.com/en-us/research/articles/alerting-in-microsofts-experimentation-platform-exp/)
- [Online Experimentation at Microsoft (PDF)](https://exp-platform.com/Documents/ExP_DMCaseStudies.pdf)

Methodology anchors:
- [Always Valid Inference (Johari et al., arXiv)](https://arxiv.org/pdf/1512.04922)
- [Always Valid Inference (Operations Research)](https://pubsonline.informs.org/doi/pdf/10.1287/opre.2021.2135)
- [Spotify Engineering — Choosing a Sequential Testing Framework](https://engineering.atspotify.com/2023/03/choosing-sequential-testing-framework-comparisons-and-discussions)

### Lane 3 — Observability-adjacent

Datadog:
- [Watchdog product](https://www.datadoghq.com/product/platform/watchdog/)
- [Watchdog docs](https://docs.datadoghq.com/watchdog/)
- [Watchdog blog](https://www.datadoghq.com/blog/watchdog/)
- [AIOps early anomaly detection](https://www.datadoghq.com/blog/early-anomaly-detection-datadog-aiops/)
- [Anomaly Monitor docs](https://docs.datadoghq.com/monitors/types/anomaly/)
- [Algorithms reference](https://docs.datadoghq.com/dashboards/functions/algorithms/)

New Relic:
- [Change Tracking overview](https://docs.newrelic.com/docs/change-tracking/overview/)
- [Record and view deployments](https://docs.newrelic.com/docs/apm/apm-ui-pages/events/record-deployments/)
- [Anomaly detection](https://docs.newrelic.com/docs/alerts-applied-intelligence/applied-intelligence/anomaly-detection/anomaly-detection-applied-intelligence/)
- [Applied Intelligence platform](https://newrelic.com/platform/applied-intelligence)
- [Change Tracking blog](https://newrelic.com/blog/how-to-relic/change-tracking-for-performance-velocity)

Honeycomb:
- [BubbleUp product](https://www.honeycomb.io/platform/bubbleup)
- [BubbleUp anomaly](https://www.honeycomb.io/bubbleup/)
- [Identify Outliers (docs)](https://docs.honeycomb.io/investigate/analyze/identify-outliers/)
- [Anomaly Detection blog](https://www.honeycomb.io/blog/introducing-anomaly-detection-early-warning-system-service-health)
- [Honeycomb Intelligence](https://www.honeycomb.io/platform/intelligence)
- [SLO Detail View](https://docs.honeycomb.io/reference/honeycomb-ui/slos/slo-detail-view)

Dynatrace:
- [Davis AI docs](https://docs.dynatrace.com/docs/discover-dynatrace/platform/davis-ai)
- [Release validation docs](https://docs.dynatrace.com/docs/platform-modules/automations/cloud-automation/release-validation)
- [Quality Gates blog](https://www.dynatrace.com/news/blog/answer-driven-release-validation-with-dynatrace-saas-cloud-automation/)
- [What is release validation](https://www.dynatrace.com/news/blog/what-is-release-validation/)
- [Dynatrace Intelligence](https://www.dynatrace.com/platform/artificial-intelligence/)
- [Smartscape](https://www.dynatrace.com/platform/application-topology-discovery/smartscape/)

Splunk Observability:
- [Detectors API](https://dev.splunk.com/observability/docs/detectors)
- [Detector examples](https://dev.splunk.com/observability/docs/detectors/detector_examples/)
- [Built-In Anomaly Detection algorithm blog](https://www.splunk.com/en_us/blog/devops/deep-dive-built-anomaly-detection-algorithm-works.html)
- [signalfx_detector Terraform](https://registry.terraform.io/providers/splunk-terraform/signalfx/latest/docs/resources/detector)
- [Splunk Observability via Harness](https://developer.harness.io/docs/continuous-delivery/verify/configure-cv/health-sources/signalfx/)

Grafana:
- [Grafana ML metric forecasting docs](https://grafana.com/docs/grafana-cloud/machine-learning/dynamic-alerting/forecasting/)
- [promql-anomaly-detection framework](https://github.com/grafana/promql-anomaly-detection)
- [Adaptive Traces investigate anomalies](https://grafana.com/docs/grafana-cloud/adaptive-telemetry/adaptive-traces/manage-recommendations/investigate-anomalies/)
- [Adaptive alerting webinar](https://grafana.com/go/webinar/grafana-machine-learning-adaptive-alerting/)

### Lane 4 — the target platform / ML-platform

the target platform:
- [Lakehouse Monitoring product](https://www.databricks.com/product/machine-learning/lakehouse-monitoring)
- [MLflow on the target platform (AWS docs)](https://docs.databricks.com/aws/en/mlflow)
- [Lakehouse Monitoring for GenAI](https://docs.databricks.com/aws/en/generative-ai/agent-evaluation/monitoring)
- [Quality Forecasts blog](https://www.databricks.com/blog/ensuring-quality-forecasts-databricks-lakehouse-monitoring)
- [the target platform Labs CI/CD Templates blog](https://www.databricks.com/blog/2020/06/05/automate-continuous-integration-and-continuous-delivery-on-databricks-using-databricks-labs-ci-cd-templates.html)
- [IDE for Data Engineering](https://www.databricks.com/blog/new-way-build-pipelines-databricks-introducing-ide-data-engineering)
- [Notebook best practices](https://docs.databricks.com/aws/en/notebooks/best-practices)

MLflow:
- [Model Registry Workflows](https://mlflow.org/docs/latest/ml/model-registry/workflow/)
- [Model Registry overview](https://mlflow.org/docs/latest/model-registry/)
- [Workspace Model Registry (the target platform)](https://docs.databricks.com/aws/en/machine-learning/manage-model-lifecycle/workspace-model-registry)

Snowflake:
- [DevOps with Snowflake](https://docs.snowflake.com/en/developer-guide/builders/devops)
- [DataOps.live AI CI/CD](https://www.dataops.live/ai-powered-ci-cd-for-snowflake)
- [Liquibase guide](https://www.liquibase.com/resources/guides/bringing-ci-cd-discipline-to-snowflake-schema-changes)
- [dbt CI/CD on Snowflake](https://docs.snowflake.com/en/user-guide/data-engineering/dbt-projects-on-snowflake-ci-cd)

Microsoft Fabric:
- [Data Quality for Fabric Lakehouse (Purview)](https://learn.microsoft.com/en-us/purview/unified-catalog-data-quality-fabric-lakehouse)
- [Building DQ into Fabric (endjin)](https://endjin.com/blog/2025/10/building-data-quality-into-microsoft-fabric)
- [Materialized lake-view DQ report](https://learn.microsoft.com/en-us/fabric/data-engineering/materialized-lake-views/data-quality-reports)

W&B / HF:
- [W&B LLM Evaluation Jobs](https://docs.wandb.ai/models/launch)
- [HF evaluate considerations](https://huggingface.co/docs/evaluate/considerations)
- [lighteval EvaluationTracker](https://huggingface.co/docs/lighteval/en/package_reference/evaluation_tracker)

Anthropic / OpenAI:
- [Anthropic-OpenAI alignment exercise (Anthropic)](https://alignment.anthropic.com/2025/openai-findings/)
- [Anthropic-OpenAI exercise (OpenAI)](https://openai.com/index/openai-anthropic-safety-evaluation/)
- [Bloom: open-source automated behavioral evals](https://alignment.anthropic.com/2025/bloom-auto-evals/)
- [Demystifying Evals for AI Agents (Anthropic)](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

Arize / Fiddler / WhyLabs:
- [Index.dev Arize vs Fiddler vs WhyLabs](https://www.index.dev/skill-vs-skill/ai-arize-vs-fiddler-vs-whylabs)
- [Comprehensive ML Monitoring Tools (Medium)](https://medium.com/@tanish.kandivlikar1412/comprehensive-comparison-of-ml-model-monitoring-tools-evidently-ai-alibi-detect-nannyml-a016d7dd8219)
- [10 Best AI Observability 2026 (TrueFoundry)](https://www.truefoundry.com/blog/best-ai-observability-platforms-for-llms-in-2026)
- [Top AI Observability Tools (Actian)](https://www.actian.com/blog/data-observability/ai-observability-tools/)

---

## Research honesty notes

1. **Pass 1 (market-researcher agent) was blocked on many primary docs** — WebFetch couldn't reach datadoghq.com, launchdarkly.com, developer.harness.io, docs.flagger.app, argo-rollouts.readthedocs.io, netflixtechblog.com, queue.acm.org, sre.google, www.usenix.org, spinnaker.io, dynatrace.com.
2. **Pass 2 (Claude-in-Chrome) verified the highest-value competitors directly.** Upgraded from snippet-based to primary-source: LaunchDarkly Guarded Rollouts, Netflix Kayenta tech blog, Google SRE Workbook canarying chapter, Dynatrace Site Reliability Guardian / Release Validation, Harness CV ML Concepts. Findings reflected in the per-competitor cards above and prefaced with "Primary-source-verified at <url>".
3. **Still not reached in pass 2:** Datadog Watchdog blog and docs (JS-heavy SPA did not render article content cleanly); ACM Queue CAS article (Davidovic & Beyer 2018, paywall); Meta Conveyor OSDI '23 PDF (not attempted in pass 2); LaunchDarkly statistics page (navigation did not complete). These remain in the "open research questions" section.
4. **GitHub source for Kayenta was directly accessible in pass 1.** Mann-Whitney constants (tolerance 0.25, conf 0.95, Hodges-Lehmann band) are confirmed from source. Pass 2 confirmed the tech-blog-level description (Pass/High/Low classification + simple Pass-ratio score).
5. **"Waterloo / Rainbow" at LinkedIn** — could not verify these are LinkedIn-internal deploy systems in any public writeup. Public name is **EKG**. Drop "Waterloo / Rainbow" or source from a non-public note before using in pitch.
6. **"Argus" at Uber** — not a real Uber-public product name. Uber's anomaly system is **Argos** (no 'u'). "Argus" is Salesforce's time-series alerting tool.
7. **Meta Conveyor (OSDI '23) full PDF was blocked in pass 1 and not re-attempted in pass 2.** Analysis-step claims about Conveyor remain conservative; re-read offline before claiming Conveyor lacks any specific capability.

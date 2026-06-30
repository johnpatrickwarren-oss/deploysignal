# Anytime-Valid Deploy Gating for AI Inference: A Ville-Bounded Detector Portfolio Compiled from Service-Level Baselines

*Workshop draft. Standard academic tone; claims are scoped to what the
reference implementation actually validates.*

---

## Abstract

Deployment decisions for AI inference services — promote a canary, keep
observing, or roll back — are today made by fixed thresholds on dashboards or by
manual judgment. Both fail the same way: an operator who watches a metric stream
and reacts when it looks wrong is implicitly running a sequential test, and the
Type-I (false-rollback) rate of repeated peeking at a fixed-horizon test inflates
toward one. We present **DeploySignal**, a deploy-gate engine built on
*e-processes* — anytime-valid sequential tests whose wealth statistic may be
inspected at every tick, under data-dependent stopping, without inflating the
error rate (Ramdas et al., 2023). DeploySignal runs a portfolio of five detector
families spanning per-signal change detection, multivariate regression,
distributional novelty, temporal structure, and hand-designed structural
signatures, staged across a sequential gate pipeline and fused under an
explicitly allocated per-deploy false-positive budget ($\alpha = 10^{-3}$). A
calibration compiler turns a curated healthy-traffic baseline and a service
profile into a deterministic threshold set, moving all matrix-factorization work
to compile time so per-tick evaluation is sub-millisecond. We describe the
architecture, with emphasis on the **slowbleed** detector for correlated
sub-threshold drift; report the engine's empirical behavior on a 120-scenario
adversarial suite and five reconstructed public-postmortem regressions; and are
explicit about what remains validated only on synthetic baselines.

---

## 1. Introduction

A canary rollout exposes a new model, weight set, or serving configuration to a
slice of production traffic and emits a stream of per-tick metric aggregates. The
operator must repeatedly decide whether to **proceed** (promote), **extend**
(keep observing), or **rollback**. The decision should control the false-rollback
rate at a stated budget, terminate in finite time, and not require a sample size
fixed before the canary starts.

AI inference workloads make this harder than a generic web A/B test in three
ways. **(1) Heavy-tailed, multi-scale latency.** Token-level streaming produces
TTFT (time-to-first-token), inter-token latency, and end-to-end p99 that move on
different timescales; a mean comparison misses tail regressions. **(2)
Quality metrics with no ground truth at serve time.** Eval score, refusal rate,
tool-call success, and output-length drift are noisy, slow to warm up, and can
regress without any latency or cost signal moving. **(3) Hardware-coupled failure
modes.** KV-cache saturation, MFU (model-FLOP-utilization) collapse, and HBM
spill produce characteristic joint signatures that precede the SLO breach they
eventually cause. These properties make a single fixed-horizon comparison
inappropriate: the relevant question is not "is the mean different after $n$
samples?" but "as evidence accumulates, has the deploy departed from healthy
behavior — and may I stop and act the moment it has?"

That is a *sequential* testing problem with optional stopping, and the modern
tool for it is the **e-process**. DeploySignal is a reference architecture and
implementation that assembles e-process detectors into a deployable gate. Our
contributions are architectural rather than theoretical: (i) a staged gate
pipeline that runs cheap deterministic checks before expensive statistics; (ii) a
five-family detector portfolio under a single explicitly-budgeted error
allocation; (iii) the slowbleed detector for correlated low-amplitude drift;
(iv) a deterministic calibration compiler from service baselines to thresholds;
and (v) a replay-clean audit substrate giving full provenance from observation to
verdict.

---

## 2. Background

**E-values and e-processes.** An e-variable for a null $H_0$ is a nonnegative
random variable with $\mathbb{E}_{H_0}[E]\le 1$; an e-process $(E_t)$ is
dominated by a nonnegative supermartingale under every law in $H_0$ (Vovk &
Wang, 2021; Ramdas et al., 2023; Ramdas & Wang, 2025). The operational
consequence is **Ville's inequality** (Ville, 1939): for a nonnegative
supermartingale $M_t$ with $M_0=1$,
$\Pr_{H_0}(\sup_t M_t \ge 1/\alpha) \le \alpha$. Thresholding $M_t \ge 1/\alpha$
is therefore valid *at every tick simultaneously* and under data-dependent
stopping — exactly the peeking behavior real operators exhibit. This is the
anytime-valid analogue of a fixed-$\alpha$ test.

**The betting view.** A clean way to construct an e-process is as gambler's
wealth: start at $1$, and at each step bet a predictable fraction $\lambda_t$ on
a payoff that is unfavorable under $H_0$, so
$M_t = \prod_{s\le t}(1+\lambda_s z_s)$ is a supermartingale by construction
(Shafer, 2021, *Testing by Betting*; Waudby-Smith & Ramdas, 2024). Wealth that
grows is evidence against the null. The strategy for choosing $\lambda_t$ is a
design choice; DeploySignal uses GRAPA with an Online-Newton-Step fallback
(Cutkosky & Orabona, 2018), bounding bets to keep the wealth factor positive.

**Relation to classical sequential tests.** Wald's SPRT and Page's CUSUM are
likelihood-ratio processes — e-processes for a point alternative. The e-process
framework recovers them and extends to composite nulls (via mixtures; Robbins,
1970; Howard et al., 2021) and nonparametric nulls (via betting and kernels;
Shekhar & Ramdas, 2023). DeploySignal deliberately co-ships a classical
mixture-prior CUSUM *and* a betting e-process per signal, so the anytime-valid
construction sits beside the classical one it generalizes.

For a deployment-engineering audience the takeaway is simple: e-processes let you
*watch the statistic continuously and act on it the instant it crosses a fixed
line*, with a provable cap on false rollbacks — which is what a deploy gate
actually needs and what threshold dashboards cannot give.

---

## 3. System design

### 3.1 The gate pipeline

Each tick routes `{live, baseline, flags}` through ordered gates: **G0**
blast-radius and reversibility classification; **G1** policy (change windows,
incident state, ignore bands); **G2** approval; **G3** deploy-state; **G4**
health, where the detector portfolio runs. Early gates are deterministic and
short-circuit cheaply — a frozen change window rolls back before any statistic is
computed — so the expensive statistical evaluation runs only on deploys that
clear policy. The health gate fuses per-family verdicts: **rollback on any fire,
extend on any indeterminate, proceed only when all families are clean.**

### 3.2 The detector portfolio

A per-deploy budget $\alpha_{\text{total}}=10^{-3}$ is split across five families
by Bonferroni allocation $40/20/20/10/10$ (A/B/C/D/E):

| Family | $\alpha$ | Detector | Catches |
|---|---|---|---|
| A | $4\times10^{-4}$ | betting e-process + mixture-prior Page-CUSUM, per signal | mean shift in known SLIs |
| B | $2\times10^{-4}$* | 16 structural signatures (incl. slowbleed) | known LLM-serving failure modes |
| C | $2\times10^{-4}$ | Hotelling $T^2$ (robust $\Sigma$) + Sequential-MMD | multivariate mean + shape shift |
| D | $1\times10^{-4}$ | spectral-ACF + spectral betting e-detector + BOCPD | oscillation, regime change |
| E | $1\times10^{-4}$ | weighted-conformal Mahalanobis novelty | off-manifold joint vectors |

\* Family B is **non-$\alpha$-consuming**: its 16 patterns are hand-designed
absolute-threshold tests, not statistical tests, so its allocation is
reserved-but-not-spent in the Ville claim. The $\alpha$-participating portfolio
(A+C+D+E $= 8\times10^{-4}$) partitions into a Ville-bounded portion
(anytime-valid e-processes — Family A's betting half, Family C's safe-Hotelling
and e-MMD-betting, Family D's spectral e-detector, Family E's hedged-indicator)
and a classical-epoch portion (Family A's Page-CUSUM half, the MMD bootstrap-null
fallback), each firing on $M_t \ge 1/\alpha$ or its excursion-theory analogue.

**Family A** evaluates six SLIs — `p99_latency`, `ttft`, `eval_score`,
`tool_success_rate`, `downstream_err`, `cost_req` — independently. The betting
detector standardizes each observation to a bounded $z_t = \text{clip}((x-\mu)/3\sigma,\,\pm1)$
and advances wealth $M_t = M_{t-1}\,(1+\lambda_t z_t)$, firing at
$M_t \ge 1/\alpha_{\text{betting}}$ where
$\alpha_{\text{betting}} = (\alpha_A/6)\cdot 0.5$ (per-signal Bonferroni, then a
50/50 split with the co-shipped CUSUM).

**Family C** tests the 11-dimensional joint vector per cell. Hotelling $T^2 =
(x-\mu)^\top\Sigma^{-1}(x-\mu)$ uses a robust $\Sigma$ whose estimator is chosen
by sample size (§3.3); the safe-test variant runs a mixture-prior e-process with
$\tau^2 = 0.03\cdot\mathrm{trace}(\Sigma)/p$. The Sequential-MMD detector is a
kernel two-sample betting e-process (Shekhar & Ramdas, 2023) with a
256-dimensional random-Fourier-feature map and ONS bets bounded to
$\lambda_{\max}=0.5$. The Family-C budget splits 50/50 between the two.

**Family E** scores the joint vector by Mahalanobis distance against a
time-decay-weighted parametric-Gaussian bootstrap null (Barber et al., 2023),
firing above the weighted $(1-\alpha_E)$-quantile; effective sample size is
audit-visible.

### 3.3 The slowbleed detector (most distinctive component)

slowbleed is a **structural (Family B)** detector — notably *not* an e-process —
that addresses a failure class the statistical families are individually blind
to. It operates on the `TrendBuffer` (a bounded rolling window per signal that
exposes `slope`, normalized slope `slopeNorm`, `cv`, and a monotonicity score
`trendStrength`). slowbleed fires when **four or more of nine tracked signals
drift simultaneously**, each with `slopeNorm` in $[0.001, 0.010]$,
`trendStrength > 0`, and ratio $>2\%$ off baseline.

The semantics are a *vote* over the signal set rather than a test on any one
signal. Consider a deploy where p99 is up 1.8%, TTFT up 2.1%, tokens/turn down
1.6%, and eval-score down 0.9%. No single metric crosses its own threshold;
threshold-based monitoring sees green everywhere. But four metrics drifting
coherently in the sub-threshold band is itself distinctive, and slowbleed fires.
The detector's design hinges on `trendStrength` rather than the coefficient of
variation: smoothly trending data has *high* CV without being noisy, so CV is the
wrong noise filter; `trendStrength` separates directional movement from jitter.
slowbleed is complementary to the multivariate e-processes — Families C and E
catch *covariance-structure* shifts, while slowbleed catches *coherent marginal
drift* that may leave the covariance roughly intact. It is the single detector
with no analogue in standard SRE tooling, and it covers a large class of the
gradual-degradation scenarios in the adversarial suite.

### 3.4 The calibration compiler

`tools/calibrate.ts` (compiler v0.3.0) ingests a curated healthy-traffic
`BaselineBundle` plus a service profile and emits a deterministic
`CompiledConfig`. The baseline is stratified into per-cell statistics indexed by
`(hour_of_day × day_of_week × tenant_tier)` — e.g. $168 \times 5 = 840$ cells for
a two-week two-dimensional bundle with tenant tiering. Each cell carries a
confidence tag: `strict` ($n\ge 60$), `pooled` ($20\le n<60$, with neighbor
pooling over $\pm2$ adjacent hours then across days), or `aggregate`/`none` below
that, falling back to an across-cell aggregate.

Per family, the compiler derives: Family A mixture-prior parameters
($\delta_{\min}=\max(0.05\mu,2\sigma)$, $\tau^2=\delta_{\min}^2/4$), AR(1)
coefficients (Yule–Walker, clipped to $[-0.95,0.95]$), and bootstrapped betting
thresholds; Family C robust covariance with method chosen by sample size —
**MCD** when $n\ge\max(5p,200)$ (Rousseeuw & Van Driessen, 1999), **MRCD** for
tight samples (Boudt et al., 2020), **Ledoit–Wolf** shrinkage for $p>20$ — plus
its Cholesky factor and MMD precompute; Family D AR(1) spectral nulls via
peak-ACF bootstrap; and Family E conformal calibration scores (20,000-sample
bootstrap, sized so the minimum p-value resolves $\alpha_E=10^{-4}$). The
$\alpha$ allocation and the per-signal SLO targets ($\delta_{\min}$, bake-profile
warmup windows) come from the profile YAML.

All matrix factorization happens here; **runtime is precomputed arithmetic** —
O(p) Family A, O(p²) Family C (one Cholesky solve against precomputed
$\Sigma^{-1}$), O(1) Family B. The compile is **deterministic**: `compiled_at` is
pinned to the epoch, every stochastic step uses a fixed seed, and worker-pool
parallelism is order-independent. A byte-identity test
(`profile-streaming-byte-identity`) asserts that compiling the same baseline
twice yields a SHA-identical config (modulo diagnostic timing fields), so every
fire decision is reproducible on replay.

### 3.5 The audit substrate

Every tick emits exactly one structured record (schema v2/v2.1) carrying the
top-line verdict, per-family verdicts, each fired detector's statistic and
threshold, $\alpha$ spent, the consulted cell key and confidence, covariance
method, baseline version, and reversibility class. Records are replay-clean:
re-running the same compiled config on the same metric stream reproduces every
verdict bit-for-bit (exact-float serialization, no rounding). This gives a
complete provenance chain from raw observation to decision and supports
post-incident reconstruction of why the gate acted.

---

## 4. Case study: failure classes and configurations

DeploySignal ships a 120-scenario adversarial suite plus five regressions
reconstructed from public postmortems. We organize the discussion by the failure
*class* each detector family targets, using the actual shipped configurations.

**Sudden regression** (Family A). A step change in a single SLI — e.g. p99
jumping after a weight swap. The betting e-process accumulates wealth quickly
once $z_t$ saturates at $\pm1$; the co-shipped CUSUM provides a classical-epoch
cross-check. On the reconstructed *OpenAI 2024-12-11 routing-error ramp* and
*Anthropic 2025-09 TPU/XLA* profiles, Family A attributes to the expected signals
(`eval_score`, `p99_latency`, `cost_req`).

**Gradual degradation / slowbleed** (Family B). Correlated sub-threshold drift,
described in §3.3. This is the class that fixed-threshold canary analysis
structurally cannot catch, because every marginal stays inside its band; the
4-of-9 vote is what surfaces it.

**Distribution shift without mean change** (Families C, E). A deploy whose
per-signal means are unchanged but whose joint shape has shifted — variance
inflation, emergent bimodality, or a covariance-structure change. Hotelling $T^2$
catches elliptical mean shift; Sequential-MMD, being a characteristic-kernel test,
sees higher moments Hotelling misses; weighted-conformal Mahalanobis flags
off-manifold vectors regardless of which dimension is anomalous. This is the
documented `adv_correlated_noise` class.

**Oscillatory / regime regression** (Family D). Periodic latency spikes (e.g.
from lock contention) or a regime change not tied to a single frequency.
Spectral-ACF peak detection and the spectral betting e-detector target the
former; BOCPD targets the latter.

On the synthetic-v1 × v5 sweep (131 healthy windows × 100-tick canary, injection
at tick 30), the combined portfolio detects **5/5** of the public-postmortem
regressions, median time-to-detect $\approx 6$ ticks ($\approx 30$s at a 5s
cadence). Per-tick gate-evaluation latency on the full five-family portfolio was
measured at median $29.8\,\mu s$, p99 $62.8\,\mu s$ (Apple Silicon, Node v25.9) —
under 1% overhead on a typical 10–100 ms token-generation step. We treat these as
*characterization on synthetic baselines*, not production validation (§5).

Three profiles are shipped: `llm-inference-streaming` (11-signal joint vector,
tight TTFT/p99 SLOs), `llm-inference-batch` (10-signal), and
`generic-microservice` (Family A only, structural and multivariate families
disabled) — illustrating that the same compiler retargets to non-LLM workloads by
profile alone.

---

## 5. Limitations

We state these plainly.

- **Baselines are synthetic.** Tight $\alpha$ calibration requires on the order of
  $10^5$ healthy production runs; the shipped configs are compiled from synthetic
  baselines and five hand-curated postmortem reconstructions. The formal Ville
  bound holds by construction, but the *empirical* false-positive rate is
  characterized only on synthetic and reconstructed data.
- **Empirical FPR is not yet at the nominal bound under all nulls.** Under an
  i.i.d.-bootstrap null the observed portfolio FPR is elevated (e.g. Family D on
  KV-cache, and Family C cells affected by calibration-source incoherence between
  per-cell $\mu$ estimates); the betting and Page-CUSUM components of Family A are
  empirically Ville-clean (0 fires across $>196{,}000$ trajectories), but several
  multivariate detectors show calibration gaps traced to per-cell covariance
  shrinkage and a $\mu$-coherence bug now under remediation. This is a calibration
  issue, not a failure of the formal property.
- **Family B is heuristic.** slowbleed and the other structural signatures are
  hand-tuned thresholds with no anytime-valid guarantee; they consume no $\alpha$
  and their false-positive behavior is governed only by empirical sweep results.
- **No live orchestrator integration.** The engine is runtime-exercised
  TypeScript with a deterministic test substrate; wiring to Argo Rollouts,
  Spinnaker, or a custom operator is described but not shipped.
- **Multi-metric dependence is handled conservatively.** Correlated signals (e.g.
  latency and error rate) are combined by Bonferroni/union bounds, which are loose
  under strong dependence (§7).

---

## 6. Related work

**Fixed-threshold canary analysis.** Spinnaker **Kayenta**, **Argo Rollouts**,
and **Flagger** compare canary to baseline against operator-set thresholds or
Mann–Whitney checks at fixed intervals. They are simple and widely deployed but
have no anytime-valid guarantee and no native multivariate or novelty channel;
DeploySignal's Family B is, by design, a compiled-equivalent of this class, with
the e-process families layered on top.

**Bayesian and sequential A/B platforms.** Optimizely's always-valid inference
(Johari, Pekelis & Walsh, 2017) and mSPRT-based experimentation platforms target
the same optional-stopping problem with mixture sequential tests; LaunchDarkly's
guarded rollouts surface effect-size confidence intervals. DeploySignal adopts the
same anytime-valid foundation but generalizes from a single primary metric to a
*portfolio* under a shared budget, and adds nonparametric (kernel, conformal)
channels.

**Sequential A/B testing in industry.** Netflix, Microsoft, and others have
published sequential-testing systems for experimentation; these largely focus on
univariate or low-dimensional effect estimation. The AI-inference-specific
detector set (KV/MFU/HBM signatures, token-level quality signals) and the
slowbleed correlated-drift detector are not addressed by general A/B frameworks.

**Classical SPC.** CUSUM (Page, 1954) and SPRT (Wald, 1945) are the statistical
ancestors; multivariate SPC (Hotelling $T^2$, MEWMA) underlies Family C. The
e-process framing subsumes these as special cases while extending to composite
and nonparametric nulls.

**Cluster-scope siblings.** The same engine, vendored into the sibling product
**Tessera**, runs in steady state over a cluster: per-shard residual e-processes,
hierarchical e-value combination, and **e-BH** false-discovery-rate control (Wang
& Ramdas, 2022) across many simultaneous shard hypotheses. That one engine serves
both a finite-horizon single-deploy gate and continuous FDR-controlled cluster
observation is direct evidence of the framework's scope-generality.

---

## 7. Conclusion

DeploySignal recasts the deploy-gate decision as an anytime-valid sequential
testing problem and answers it with a portfolio of e-process detectors staged
across a gate pipeline, compiled deterministically from service baselines, and
recorded in a replay-clean audit substrate. The design's distinctive elements —
the slowbleed detector for correlated sub-threshold drift, the compile-time/
runtime split that keeps per-tick cost sub-millisecond, and the
single-engine-two-scopes relationship with cluster-scale FDR control — are
engineering contributions on top of established theory. The honest open questions
are calibration on real production baselines and dependence-aware combination of
e-values across correlated metrics: the union bound the engine currently uses is
valid but loose, and tight combination of correlated e-values is the most
practically consequential next step.

---

### References

Adams & MacKay (2007). *Bayesian online changepoint detection.* arXiv:0710.3742.
Barber, Candès, Ramdas & Tibshirani (2023). *Conformal prediction beyond
exchangeability.* Ann. Statist. 51(2).
Boudt, Rousseeuw, Vanduffel & Verdonck (2020). *The minimum regularized
covariance determinant estimator.* Stat. Comput. 30.
Cutkosky & Orabona (2018). *Black-box reductions for parameter-free online
learning in Banach spaces.* COLT.
Howard, Ramdas, McAuliffe & Sekhon (2021). *Time-uniform, nonparametric,
nonasymptotic confidence sequences.* Ann. Statist. 49(2).
Johari, Pekelis & Walsh (2017/2022). *Always valid inference: continuous
monitoring of A/B tests.* Oper. Res.
Page (1954). *Continuous inspection schemes.* Biometrika 41.
Ramdas, Grünwald, Vovk & Shafer (2023). *Game-theoretic statistics and safe
anytime-valid inference.* Statist. Sci. 38(4).
Ramdas & Wang (2025). *Hypothesis testing with e-values.* Monograph.
Robbins (1970). *Statistical methods related to the law of the iterated
logarithm.* Ann. Math. Statist. 41.
Rousseeuw & Van Driessen (1999). *A fast algorithm for the minimum covariance
determinant estimator.* Technometrics 41.
Shafer (2021). *Testing by betting: a strategy for statistical and scientific
communication.* J. R. Stat. Soc. A 184(2).
Shekhar & Ramdas (2023). *Nonparametric two-sample testing by betting.* IEEE
Trans. Inf. Theory 70(2).
Ville (1939). *Étude critique de la notion de collectif.* Gauthier-Villars.
Vovk & Wang (2021). *E-values: calibration, combination, and applications.* Ann.
Statist. 49(3).
Wald (1945). *Sequential tests of statistical hypotheses.* Ann. Math. Statist. 16.
Wang & Ramdas (2022). *False discovery rate control with e-values.* J. R. Stat.
Soc. B 84(3).
Waudby-Smith & Ramdas (2024). *Estimating means of bounded random variables by
betting.* J. R. Stat. Soc. B 86(1).

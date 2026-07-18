# Methodology

*An academic framing of the DeploySignal deploy-gate engine: the problem it
formalizes, the literature it builds on, and the architecture beyond known
theory.*

Written for a reader fluent in sequential statistics, this document separates
**established theory** (cited) from **what this codebase contributes as
engineering**.

---

## 1. Problem statement

A canary deployment exposes a new model or configuration to a fraction of live
traffic and emits a stream of metric observations
$x_1, x_2, \dots \in \mathbb{R}^p$ — per-tick aggregates of latency, throughput,
cost, and AI-specific quality and hardware signals (TTFT, eval score, KV-cache
hit rate, MFU, HBM spill). At each tick the operator must emit a
decision in $\{\textsf{proceed}, \textsf{extend}, \textsf{rollback}\}$ that
controls the false-rollback rate (Type-I error) at a stated budget $\alpha$,
terminates in finite time, and **does not require a sample size fixed in
advance**.

That last constraint is the crux. A fixed-horizon two-sample test (Welch's $t$,
a fixed-$n$ A/B comparison) is valid only if the analyst commits to $n$ before
looking and tests once. Operators do the opposite: they watch a dashboard and
react whenever something looks wrong. Each peek is an implicit test, and the
error rate of $m$ peeks at a nominal-$\alpha$ fixed-horizon test inflates toward
$1$ as $m$ grows — the *optional-stopping* problem (Johari, Pekelis & Walsh,
2017). The deploy-gate decision is therefore intrinsically a **sequential**
testing problem with data-dependent stopping, demanding a statistic valid under
*continuous monitoring* — an **anytime-valid** test.

---

## 2. Theoretical foundations

**E-values and e-processes.** An *e-variable* for a null $H_0$ is a nonnegative
random variable $E$ with $\mathbb{E}_{H_0}[E] \le 1$; an *e-process* $(E_t)$ is
upper-bounded by a nonnegative supermartingale under every distribution in $H_0$
(Ramdas, Grünwald, Vovk & Shafer, 2023; Vovk & Wang, 2021; Ramdas & Wang, 2025).
They are the natural currency of sequential inference: they multiply under
independent evidence and compose under mixtures.

**Ville's inequality** makes them *anytime-valid*. For a nonnegative
supermartingale $(M_t)$ with $M_0 = 1$,
$\Pr_{H_0}\!\big(\sup_t M_t \ge 1/\alpha\big) \le \alpha$ (Ville, 1939) — the
sequential analogue of Markov's inequality. It bounds the *running maximum*, not
a fixed-time value, so $M_t \ge 1/\alpha$ may be checked at *every* tick, under
data-dependent stopping, while keeping the Type-I rate at $\alpha$. Every
Ville-bounded detector fires on this rule, with $\alpha$ from an explicitly
allocated per-family budget.

**The betting interpretation.** An e-process can be built as gambler's wealth:
from unit wealth, each step wagers a predictable fraction $\lambda_t$ on a payoff
with mean $\le 0$ under $H_0$, so $M_t = \prod_s (1 + \lambda_s z_s)$ is a
nonnegative supermartingale by construction (Shafer, 2021, *Testing by Betting*;
Waudby-Smith & Ramdas, 2024); large terminal wealth is evidence against $H_0$.
This turns "design a sequential test" into "design a betting strategy," and the
strategy can be adaptive — GRAPA and the Online Newton Step (ONS, Cutkosky &
Orabona, 2018) choose $\lambda_t$ from realized history. Both appear in
`engine/detectors/betting-e-process.ts`.

**Sequential change detection.** Detecting *when* a stream departs from its
in-control law generalizes this to a composite, time-varying alternative. Shekhar
& Ramdas (2023) give a betting-style sequential two-sample/change test whose
wealth process is Ville-bounded; the kernel-MMD detector
(`engine/detectors/family-c-betting-e-process.ts`) implements their ONS variant.

**Why e-processes generalize CUSUM and SPRT.** Wald's SPRT (1945) optimally
tests a *simple* null against a *simple* alternative; Page's CUSUM (1954) is its
reset-at-zero cousin for unknown change-points. Both are likelihood-ratio
processes — e-processes for a point alternative. The framework recovers them as
special cases and extends to *composite* nulls (via the method of mixtures —
Robbins, 1970; Howard, Ramdas, McAuliffe & Sekhon, 2021) and *nonparametric*
nulls (via betting and kernels) where no likelihood ratio exists. The engine
keeps a mixture-prior Page-CUSUM and a betting e-process side by side in Family
A, making the generalization explicit.

---

## 3. Architectural contributions

The theory above is established; this codebase contributes an *architecture* for
turning it into a deployable gate.

**The G0–G4 sequential gate pipeline.** Each tick routes
`{live, baseline, flags}` through ordered gates (`engine/orchestrator.ts`):
**G0** blast-radius / reversibility, **G1** policy (time windows, incident
state, ignore bands), **G2** approval, **G3** deploy-state, **G4** health — where
the detector portfolio lives. Earlier gates are cheap, deterministic, and
short-circuit (a frozen change window rolls back before any statistic is
computed), so the expensive statistical work runs only on deploys that clear
policy. The portfolio fuses per-family verdicts under the rule *rollback on any
fire, extend on any indeterminate, proceed only when all clean*.

**Detector-family taxonomy.** The portfolio (`CHEAT-SHEET.md`,
`audit/SCHEMA.md`) allocates a per-deploy budget $\alpha_{\text{total}}=10^{-3}$
across five families by Bonferroni split $40/20/20/10/10$:

- **Family A — per-signal change detection** (betting/e-value): betting
  e-process *and* mixture-prior Page-CUSUM, co-shipped per signal over six SLIs
  under a 50/50 $\alpha$-split — the betting half Ville-bounded, the CUSUM half
  classical-epoch.
- **Family B — structural signatures**: sixteen hand-designed
  absolute-threshold patterns for known LLM-serving failures;
  non-$\alpha$-consuming (deterministic, not a statistical test). **slowbleed**
  lives here.
- **Family C — joint-vector regression**: Hotelling $T^2$ with robust covariance
  (MCD / MRCD / Ledoit–Wolf, chosen per cell by sample size) and a Sequential-MMD
  kernel test whose ONS betting variant is the canonical Shekhar–Ramdas detector.
- **Family D — temporal structure**: spectral-ACF peak detection (oscillation)
  plus a spectral betting e-detector and BOCPD (regime change).
- **Family E — distributional novelty**: weighted-conformal Mahalanobis scoring
  against a time-decay-weighted bootstrap null (Barber, Candès, Ramdas &
  Tibshirani, 2023), with a hedged-indicator betting variant.

**The slowbleed detector.** slowbleed is the most architecturally distinctive
detector and, notably, *not* an e-process — it is a structural (Family B)
detector on the `TrendBuffer` (`engine/core.ts`). It fires when **four or more of
nine tracked signals drift simultaneously at sub-threshold magnitude** — each
with normalized slope in $[0.001, 0.010]$, `trendStrength > 0`, and ratio $>2\%$
off baseline. *Correlated low-amplitude drift* is invisible to any per-signal
threshold (each marginal stays green) yet jointly distinctive: a deploy where p99
is up 1.8%, TTFT up 2.1%, and eval-score down 0.9% trips slowbleed though no
single metric crosses its own detector. It is a *vote* across the signal set,
complementary to the multivariate e-processes (Families C/E) that catch
covariance-structure shifts, and covers gradual degradation threshold-based SRE
tooling structurally cannot. The score that matters is `trendStrength`, not CV —
smoothly trending data has high CV without being noisy.

**The calibration compiler.** `tools/calibrate.ts` compiles a curated
healthy-baseline trace into a deterministic `CompiledConfig`: per-cell
(hour × day × tenant-tier) mean vectors, robust covariances and Cholesky
factors, AR(1) coefficients, mixture-supermartingale priors, betting baseline
pools, and conformal calibration quantiles. All matrix factorization happens at
compile time; runtime is precomputed arithmetic (O(p) Family A, O(p²) Family C,
sub-millisecond per tick). The $\alpha$ budget and thresholds compile *from* the
SLO/profile definition (`profiles/*.yaml`); the compile is deterministic —
the same input yields byte-identical output, enforced by byte-identity tests.

**The audit substrate.** Every tick emits one structured record
(`audit/SCHEMA.md`, v2/v2.1) carrying per-family verdicts, each detector's
statistic and threshold, $\alpha$ spent, the consulted cell key and confidence,
covariance method, baseline version, and reversibility class. Records are
replay-clean: the same compiled config plus the same metric stream reproduces
every verdict bit-for-bit — a complete provenance chain from raw observation to
decision, enabling post-incident reconstruction of *why* the gate acted.

---

## 4. Relationship to Tessera

The same engine, vendored into the sibling product **Tessera**, serves a
fundamentally different scope. DeploySignal answers a *single-deployment,
finite-horizon* question — "promote this canary?" Tessera runs the same
Ville-bounded primitives in *steady state* over a *cluster*: per-shard residual
semantics, hierarchical e-value combination, and **e-BH** false-discovery-rate
control (Wang & Ramdas, 2022) over the many simultaneous shard hypotheses, with a
topology-aware freeze hook. The `r92` proof-of-concept validates that the engine
ships as a consumable package across this boundary.

The methodological point is that **e-processes are scope-agnostic.** Because an
e-value is just bounded evidence under a null, the *same* wealth process that
gates one deploy in finite time also serves as one leaf in a cluster-wide FDR
procedure — e-values average and combine without re-derivation, where p-values
would need new multiplicity machinery at each scope. One detector construction,
two operational regimes, is direct evidence of the framework's generality.

---

## 5. Empirical validation against comparator baselines

External review of the portfolio detector's evaluation asked the natural
follow-up question: how does the portfolio's escaped-regression /
false-rollback / detection-delay profile compare against the two families of
gate most deployment-health tooling actually ships — a **well-tuned
single-signal threshold gate** (metric-threshold checks à la
Flagger/Argo-Rollouts) and a **well-tuned canary-vs-control statistical
judge** (Mann-Whitney canary analysis à la Spinnaker/Kayenta)? A comparison
against an untuned or strawman baseline is not informative, so the harness
pre-registers the comparator arms, the tuning procedure, the evaluation
splits, and the exact endpoints *before* any comparator code is written —
[`runs/comparator-baseline/ENDPOINTS.md`](runs/comparator-baseline/ENDPOINTS.md)
is committed and frozen ahead of the implementation, and the harness
hard-fails at runtime if its own CLI arguments disagree with that frozen
document. This pre-registration discipline is the point: the tuning
procedure cannot be adjusted after seeing evaluation-split results, and a
post-hoc endpoint addition fails CI in the same PR that adds it (the harness
asserts the emitted report's metric keys equal exactly the pre-registered
set).

The committed run —
[`runs/comparator-baseline/report-synthetic-v1.json`](runs/comparator-baseline/report-synthetic-v1.json)
and its human-readable
[`SUMMARY-synthetic-v1.md`](runs/comparator-baseline/SUMMARY-synthetic-v1.md)
— is the exact registered command (no ad hoc parameter overrides) against
the `synthetic-v1` baseline. Both comparator arms tune to zero false fires
on a held-out, healthy-only tuning split (no regression-profile peeking,
mirroring how such gates are tuned in production) and hold that guarantee
on the evaluation split with no leakage, at a measurable cost in escaped
regressions relative to the portfolio — exactly the kind of power/false-alarm
trade-off this class of study exists to surface. This harness supersedes any
prior, non-pre-registered comparator work in this codebase; no result from
any such prior attempt was consulted in writing ENDPOINTS.md or the code
that implements it.

---

## 6. Open problems

1. **Optimal detector-portfolio composition.** The $40/20/20/10/10$ allocation
   and five-family roster are hand-set. Which subset of detectors and what
   $\alpha$ split maximizes detection power per unit false-rollback budget for a
   *given* metric profile (latency- vs. quality- vs. cost-dominated)? A
   principled portfolio-selection theory — possibly itself an e-value-weighting
   problem — is open.

2. **Betting calibration under non-stationary baselines.** GRAPA/ONS choose bets
   from realized moments assuming a fixed in-control law per cell, but real
   baselines drift (diurnal load, model refreshes). Keeping the wealth process
   Ville-valid while *adapting* the reference distribution — without the
   adaptation itself leaking Type-I error — is unresolved; weighted-conformal
   scoring (Family E) is a partial answer for novelty, not for the betting
   families.

3. **Correlated multi-metric e-value combination.** Latency and error rate are
   strongly correlated; multiplying their per-signal e-values double-counts
   shared evidence, while a Bonferroni split is loose. Tight, dependence-aware
   combination of e-values across correlated metrics — beyond the conservative
   union bound the engine uses today — is the most immediately practical open
   question.

---

### References

Adams & MacKay (2007), *Bayesian online changepoint detection*.
Barber, Candès, Ramdas & Tibshirani (2023), *Conformal prediction beyond
exchangeability*, Ann. Statist.
Boudt, Rousseeuw, Vanduffel & Verdonck (2020), *The minimum regularized
covariance determinant estimator*, Stat. Comput.
Cutkosky & Orabona (2018), *Black-box reductions for parameter-free online
learning*.
Howard, Ramdas, McAuliffe & Sekhon (2021), *Time-uniform, nonparametric,
nonasymptotic confidence sequences*, Ann. Statist.
Johari, Pekelis & Walsh (2017/2022), *Always valid inference*, Oper. Res.
Li & Chen (2019), *Sequential MMD tests*.
Page (1954), *Continuous inspection schemes*, Biometrika.
Ramdas, Grünwald, Vovk & Shafer (2023), *Game-theoretic statistics and
safe anytime-valid inference*, Statist. Sci.
Ramdas & Wang (2025), *Hypothesis testing with e-values* (monograph).
Robbins (1970), *Statistical methods related to the law of the iterated
logarithm*.
Rousseeuw & Van Driessen (1999), *A fast algorithm for the MCD estimator*,
Technometrics.
Shafer (2021), *Testing by betting*, J. R. Stat. Soc. A.
Shekhar & Ramdas (2023), *Nonparametric two-sample testing by betting*,
IEEE Trans. Inf. Theory.
Ville (1939), *Étude critique de la notion de collectif*.
Vovk & Wang (2021), *E-values: calibration, combination, and applications*,
Ann. Statist.
Wald (1945), *Sequential tests of statistical hypotheses*.
Wang & Ramdas (2022), *False discovery rate control with e-values*, J. R.
Stat. Soc. B.
Waudby-Smith & Ramdas (2024), *Estimating means of bounded random variables
by betting*, J. R. Stat. Soc. B.

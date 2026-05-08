# Detector Math Research — TPM Brief

_Owner: TPM (laptop Cowork). Drafted: 2026-04-16._
_Status: Research only. No engine changes implied. All integration work is WS1-owned (Mac Claude Code)._

This doc answers John's question: "What's the latest math we could add as detectors to DeploySignal?" It is scoped as a TPM-level trade-off brief — each technique is ~1 paragraph covering what it detects, the math in one line, signal/compute cost, and fit to the current engine (`engine/core.ts` TrendBuffer contract, `engine/gates/health.ts` detector list).

It does **not** prescribe an implementation. When WS1 picks its next cycle, this doc is the menu to pick from.

---

## TL;DR

The four-layer stack John sketched — **CUPAC-adjusted canary metrics → mSPRT on primary SLIs → sequential MMD on the joint vector → conformal anomaly scoring → verdict fusion** — is a well-formed, modern detector stack and maps cleanly onto DeploySignal's gate architecture. Each layer catches a different class of failure, so running them in parallel and fusing verdicts (rollback on any fire, extend on any indeterminate, promote only when all clean) gives coverage the current single-detector-fires-wins model can't match.

The tension to be aware of: every layer added costs scenario-pool effort (adversarial tests to validate TP), baseline-management complexity (Phase 4 of WS2), and audit schema surface. Doing all four at once would blow past the "never more than one scenario family per cycle" guardrail. Sequencing matters more than selection.

Recommended phasing, in rough order of insight-per-cost:

1. **mSPRT on primary SLIs** — closest to the current detector idiom, largest coverage gain, clearest theoretical guarantees, lowest scenario-pool cost.
2. **Sequential MMD on joint vector** — directly addresses `adv_correlated_noise` (one of the 3 documented structural gaps) and the shadow-model bleed family.
3. **CUPAC adjustment** — a preprocessing layer, not a detector. Shrinks noise so layers 1 & 2 can tighten thresholds. Requires offline-trained prediction models.
4. **Conformal anomaly scoring** — novelty detector for failure modes the other three layers don't anticipate. Requires a baseline "model of the world," so it is the largest lift.

The rest of this doc explains each layer, then surveys adjacent techniques (matrix profile, BOCPD, Hotelling T², wavelet/FFT, etc.) that might earn a spot later.

---

## What's already in the engine (baseline to compare against)

The current detector math, as of Phase 1.5 merge (2026-04-16):

- **TrendBuffer** (`engine/core.ts`): 10-sample rolling window per signal. OLS linear regression for `slope`/`slopeNorm`, coefficient of variation `cv`, range, a custom `trendStrength ∈ [0,1]` score (slope × stability bonus − noise penalty), and a 3-point rate-of-change `roc`.
- **Gates**: G0–G4 pipeline (blast → policy → approval → state → health). First detector to fire wins; no cross-detector fusion beyond `slowbleed`'s 4-of-9 vote.
- **Detectors in G4**: 22 rollback + 9 extend, mostly per-signal threshold checks with `effectiveThreshold` trend-discount. The architecturally distinctive ones — `slowbleed`, `mfu_collapse`, `kv_saturation`, `hbm_elevation`, `hbm_spill_roll`, `collective`, `capacity`, `gpu_eff` — encode AI-inference-specific patterns.
- **Known structural gaps**: `adv_oscillating_cache_signal` (needs spectral analysis), `adv_correlated_noise` (needs covariance), `adv_collective_ops_flap` (sub-tick sampling, not a math problem).

What the baseline is missing, in statistical terms:
- **No always-valid inference.** Detectors check a threshold per tick. There is no formal Type-I-error budget over the 32-tick run.
- **No multivariate test.** Signals are evaluated independently. `slowbleed` counts how many signals drift but does not model their covariance.
- **No variance-reduction preprocessing.** Every detector is fighting the raw noise level of the metric. If a metric is noisy, its threshold must be loose — which weakens TP.
- **No "unknown unknown" channel.** All 31 detectors fire on patterns the engine was hand-taught to look for. Novelty is invisible.

Each proposed layer below plugs one of those holes.

---

## The 4-layer stack

### Layer 1 — CUPAC-adjusted canary metrics (variance reduction, preprocessing)

**What it is.** CUPED (Microsoft, Deng et al. 2013) and its successor CUPAC (DoorDash, Li/Tang/Bauman 2020) reduce the variance of an observed metric by regressing out a covariate that is correlated with the metric but unaffected by the intervention. CUPED uses pre-experiment observations of the same metric as the covariate. CUPAC generalizes: the covariate is the output of a machine-learning model trained on features known at deploy time (traffic mix, time of day, request-shape priors, etc.). DoorDash reported ~25% test-duration reduction while preserving power.

**Math in one line.** `Y_adj = Y − θ·(X − E[X])` where `X` is the covariate (or ML prediction) and `θ = Cov(Y,X)/Var(X)`. Variance of `Y_adj` is `Var(Y)·(1 − ρ²)` where `ρ` is the correlation between `Y` and `X`.

**What it detects.** Nothing by itself. It is a preprocessing layer that makes every _other_ detector more sensitive. The tighter the correlation between the covariate and the live signal, the lower the effective noise floor, the tighter the thresholds downstream detectors can safely use without blowing FP rate.

**Fit to DeploySignal.** Natural home is pre-TrendBuffer: before `push()`, subtract the CUPAC prediction from each raw sample. Signals that have stable traffic-correlated baselines (p99 latency, cost/req, tokens/turn) benefit most. Signals that are already scale-free ratios (collective_ops = 0.9997) benefit least.

**Costs & risks.**
- Requires an offline-trained per-signal model. This is a real production dependency — must live somewhere with a refresh schedule. Shadow-mode history from WS2 Phase 3 is the natural training data source.
- Model drift on the predictor is now a new failure mode. A stale predictor adds bias, not just noise.
- Detectors that currently rely on raw signal values (`kv_saturation` checks `ratio ≥ 1.04`) would need re-validation against adjusted values.

**Why not first.** It only pays off if downstream detectors can actually consume the tighter noise floor — i.e., if we have detectors whose theoretical FP rate scales with metric variance. The current hand-tuned thresholds don't. Layer 2 (mSPRT) does. So CUPAC earns its cost only after mSPRT is in.

---

### Layer 2 — mSPRT on primary SLI metrics (sequential hypothesis testing)

**What it is.** The mixture Sequential Probability Ratio Test (Robbins 1970; Johari, Pekelis, Walsh 2015 for the modern A/B testing formulation deployed at Optimizely) is the right statistical object when you want to make a "is the canary regressing?" decision _continuously_ without burning Type I error on every tick. Standard SPRT tests a simple alternative; mSPRT mixes over a family of alternatives (typically a Gaussian prior on the effect size), which gives you a single p-value process that is always-valid — you can peek at every tick and the false-alarm probability stays bounded.

**Math in one line.** `p̃_n = 1 / max_{k≤n} Λ_k`, where `Λ_k` is the mixture likelihood ratio of the observed metric stream under `H₁: μ_treatment − μ_baseline = δ, δ ~ N(0, τ²)` against `H₀: δ = 0`. Reject `H₀` (fire rollback) when `p̃_n < α`.

**What it detects.** Shifts in the mean of a single SLI relative to baseline, with formal Type I control across the entire run. Primary targets: `p99_latency`, `ttft`, `eval_score`, `downstream_err`, `tool_success_rate`. Replaces the current "threshold ratio + trend discount" idiom with a principled test.

**Fit to DeploySignal.** Highest-affinity layer. mSPRT naturally extends the per-signal detector pattern in `engine/gates/health.ts`; each rollback def in `ROLLBACK_DEFS` could, in principle, be a call to `mSPRT.pvalue()` against the scenario baseline. The `TrendBuffer` already holds the sample history; adding mixture-likelihood bookkeeping per signal is a bounded change.

**Costs & risks.**
- Needs a mixing-variance `τ²` per signal. That is a per-signal prior on "how big would a real regression be?" — has to be either documented, learned from historical deploys (post-WS2 Phase 3), or set conservatively.
- The always-valid guarantee is asymptotic in a technical sense. With 32 ticks per scenario and quality signals only warming up at tick 4+, the finite-sample FP rate needs empirical calibration against the clean scenario pool.
- Replaces a chunk of existing detector code. That is not free — many of the numeric cutoffs in `health.ts` are the output of the self-improving tuning loop, so the adversarial suite would need a clean re-sweep.

**Adjacent variant worth knowing.** "Truncated mSPRT" (arxiv 2509.07892, 2025) tests for _practically_ significant effects — rejects `H₀` only for `|δ| > δ_min`. This is the right shape for DeploySignal because we don't want to rollback on a statistically real but operationally meaningless regression.

---

### Layer 3 — Sequential MMD on the joint metric vector (multivariate drift)

**What it is.** Maximum Mean Discrepancy (Gretton et al. 2012, JMLR) is a kernel-based, nonparametric two-sample test. Given samples from `P` and `Q`, it measures `||μ_P − μ_Q||_H²` in a reproducing kernel Hilbert space. With a characteristic kernel (RBF), MMD = 0 iff `P = Q` — it sees every moment of the distribution, not just the mean. Sequential / streaming MMD variants update the statistic incrementally as new samples arrive. Recent work (2024–2025) includes euMMD for univariate data (Springer 2024), randomly-projected MMD for high dimension (Springer 2025), and signature-MMD for path distributions (arxiv 2506.01718, 2025).

**Math in one line.** Biased estimator: `MMD²_biased(X, Y) = (1/n²) Σᵢⱼ k(xᵢ,xⱼ) + (1/m²) Σᵢⱼ k(yᵢ,yⱼ) − (2/nm) Σᵢⱼ k(xᵢ,yⱼ)`. Threshold via permutation null or closed-form Gaussian-tail bound.

**What it detects.** Joint-distribution drift across the signal vector `(p99, ttft, tokens_turn, kv_cache, cost_req, downstream_err, mfu, hbm_spill, collective_ops, eval_score, refusal_rate, ...)`. Catches exactly the pattern the current engine _can't_: the case where every marginal stays within threshold but the joint structure has shifted. This is the `adv_correlated_noise` gap. It is also the natural detector for the queued shadow-model bleed family (the whole point of that family is joint distributional drift during model swap).

**Fit to DeploySignal.** Plugs in as a new G4 detector that doesn't look at any individual signal, but at the vector. It would need a reference sample — most likely the scenario's `baseline` replicated with its per-signal noise envelope, or a rolling window from early-run ticks assumed healthy. One rollback def, one entry in the audit schema.

**Costs & risks.**
- Kernel bandwidth selection matters. The 2024 Springer paper above addresses this with a median-absolute-deviation adaptive rule — worth adopting verbatim rather than hand-tuning.
- Computational cost is O(n²) per update in the naïve formulation, though streaming variants and linear-time approximations (linear-time MMD, block-MMD) are well-studied.
- Hardest to interpret when it fires. "The joint distribution shifted" doesn't tell the oncall which signal is driving it. Mitigation: emit the per-signal contribution to the MMD statistic alongside the verdict.

**Coverage tie-in.** This is the single highest-value layer for closing documented structural gaps. If WS1 has to pick one layer this cycle, mSPRT first, MMD second.

---

### Layer 4 — Conformal anomaly scoring (novelty detection)

**What it is.** Conformal prediction (Vovk, Shafer, Gammerman 2005) gives distribution-free, finite-sample guarantees on prediction-set coverage or false-alarm rates, assuming only that calibration and test data are exchangeable. Applied to anomaly detection, you fit a model to a healthy reference, compute per-point nonconformity scores, and use the empirical quantile of those scores on a held-out calibration set as the rejection threshold. The 2024–2026 literature extends this to online / non-stationary settings: **Adaptive Conformal Anomaly Detection with Time-Series Foundation Models** (ICLR 2026, OpenReview) uses weighted-quantile bounds that adapt to distribution shift, and **Conformal Prediction for Time-series with Change Points** (NeurIPS 2025) integrates a regime-change model with online conformal bounds.

**Math in one line.** For calibration scores `s₁,…,s_n` and test score `s_{n+1}`, the conformal p-value is `p = (1 + |{i : sᵢ ≥ s_{n+1}}|) / (n+1)`. Reject as anomaly when `p < α`; FP rate bounded at `α` under exchangeability.

**What it detects.** Everything the other three layers don't think to look for. A model trained on healthy deploys learns "what a normal deploy looks like"; conformal scoring then turns any deviation into a calibrated p-value. This is the "unknown unknowns" channel — the one that catches the failure mode that isn't in the scenario pool yet.

**Fit to DeploySignal.** Biggest lift. Requires (a) a model — autoencoder, density estimator, or foundation-model-based forecaster — trained on healthy deploy trajectories, (b) a calibration set of held-out healthy deploys, (c) exchangeability management (the adaptive variants handle this, at the cost of tuning an adaptation parameter). The runtime path is cheap: score a single tick against the model, compare to calibration quantile.

**Costs & risks.**
- Training-data dependency. Healthy trajectories come from shadow mode (WS2 Phase 3) and real production post-adoption. Pre-Phase-3, calibration set is synthetic — which weakens the guarantee.
- Distribution shift breaks exchangeability. The adaptive variants (ACAD-TSFM, CPTC) exist precisely for this, but they add hyperparameters.
- Interpretability is the weakest of the four. Expect reason strings like "conformal score = 0.003" and plan for it: emit the top-contributing features alongside.

**Why last.** Zero marginal coverage over the other three layers on _known_ failure modes, high marginal coverage on _unknown_ failure modes. We don't know which category the next incident will fall into. So this layer earns its slot once shadow-mode data is flowing and the scenario-pool growth rate starts to plateau.

---

### Verdict fusion

John's sketch: **rollback if any layer fires above its threshold; extend if any is indeterminate; promote only if all are clean.**

This is the right topology. Notes on making it work cleanly inside the current gate architecture:

- **Health gate (`G4`) runs the four layers in parallel** rather than "first detector wins." That is a real design change from today. A fan-out / reduce pattern must be added to `computeVerdict` in `engine/core.ts`.
- **"Indeterminate" needs a formal state per layer.** For mSPRT it is the usual SPRT "continue" region between acceptance and rejection thresholds. For MMD and conformal, it is a confidence-interval band around the decision boundary. For CUPAC, there is no indeterminate state — it is preprocessing.
- **Any-fires-rollback is symmetric with the current model;** all-clean-promotes is stricter. Verify on the clean scenario pool: the engine today has 0% FP on 120 scenarios; a stricter promote rule should not regress that. Expect to need a "fallback to proceed on insufficient signal" tiebreak for scenarios that terminate before any layer reaches confidence (early-run cases the current `FP_CLASSIFIER_CONFIG.capacityEarlyRollbackMinTick = 8` guard exists for).
- **Audit schema impact.** Each tick would now carry four per-layer verdicts plus a fused verdict. Touches `audit/SCHEMA.md` — schema version bump, and the WS2 replay-regression golden fixture would need to be regenerated. Not a blocker, but must be flagged.

---

## Adjacent techniques (the "maybe later" bench)

Not in the four-layer stack, but worth tracking. Each one targets a specific gap or has shown up in enough production deployments to deserve consideration when the stack is in place.

**Matrix profile (Mueen et al.; STUMPY library).** For each subsequence of length `m` in a time series, compute the z-normalized Euclidean distance to its nearest neighbor; peaks are discords (anomalies), troughs are motifs (recurring patterns). Sentry uses it in production for alerting. Strengths: parameter-light, makes _motif_ discovery a first-class operation. Weakness for DeploySignal: designed for long single-signal series (thousands of points); our 32-tick windows are at the lower end of where it helps.

**Bayesian Online Changepoint Detection (Adams & MacKay 2007; BOCPD).** Tracks the posterior over "time since last changepoint" as new observations arrive. Recent work (arxiv 2510.09619, 2025) specifically couples BOCPD with SRE-aligned decision thresholds for streaming intrusion detection — very similar flavor to DeploySignal. Would slot in as an alternative framing of Layer 2, emphasizing regime-change rather than effect-size testing. Strength: natural output is "probability that this is a new regime," which is exactly the shape of an "extend" verdict. Weakness: hazard-rate hyperparameter tuning, and no native multivariate story.

**Hotelling T² and MEWMA (multivariate SPC, classical).** T² is the multivariate Shewhart chart — one-sample Mahalanobis distance to the baseline mean under the baseline covariance. MEWMA is its EWMA-smoothed version. "The T² chart performs better at quickly detecting large or isolated faults, while the MEWMA chart performs better at detecting small to moderate faults over time." Both are simpler and cheaper than MMD but assume roughly elliptical (Gaussian-shaped) baseline distributions. Worth having as a _complement_ to MMD: Hotelling T² on the low-dimensional signal subspace (11 core metrics), MMD on the full nonparametric vector. T² also integrates trivially with CUPAC-adjusted signals — literally the "correlated-noise covariance-aware signal" already in the WS1 next-cycle queue.

**Spectral / FFT / wavelet / ACF.** Directly targets the `adv_oscillating_cache_signal` gap. Any of: Welch's-method power spectral density with a peak-detection rule, autocorrelation function peak above a significance threshold, discrete wavelet transform energy in a frequency band. This is a narrow-scope detector — it catches oscillation at tick-scale frequencies and little else. Small addition, clear scenario coverage.

**Mann-Kendall trend test + Theil-Sen slope estimator (classical nonparametric trend).** Robust alternatives to the OLS slope currently in `TrendBuffer`. Mann-Kendall gives a formal p-value for the null "no monotonic trend." Theil-Sen is the median of pairwise slopes, far less sensitive to outliers than OLS. Cheap drop-in hardening for the existing `trendStrength` heuristic; might be worth doing in the same cycle as any of the above.

**Wasserstein distance / Kolmogorov-Smirnov / PSI.** Distributional tests simpler and older than MMD. PSI in particular is the standard in ML model monitoring. Would be the "cheap version" of Layer 3 if the full MMD lift is too large — less power against high-moment differences, but well-understood.

**Matrix profile + Prophet hybrid (Sentry).** If WS3 ever adds an alerting pane, the Sentry pattern (Prophet for seasonality-aware forecast, matrix profile for novelty relative to the forecast residuals) is the closest-to-production pattern that matches DeploySignal's signal taxonomy. Not a detector, more of a product pattern.

**Deep methods (autoencoders, TranAD, USAD, time-series foundation models).** Learned anomaly scorers. These are what sit _inside_ Layer 4 (conformal anomaly scoring) — conformal prediction is the wrapper that gives any such scorer formal FP-rate guarantees. The 2024–2026 survey literature (PMC 11723367, Elsevier S0952197624014817) is the reading list here. Expensive, opaque, require training infrastructure DeploySignal doesn't have today. Not for the near cycles.

---

## How this maps to WS1's current state

Re-reading STATUS.md and the workstreams memory as I finish writing this: WS1 is idle at 97.5% TP / 0% FP across 120 scenarios, with the next cycle queue currently listing _either_ the shadow-model-bleed scenario family _or_ a covariance architectural signal. Both of those are load-bearing items for this stack:

- **The shadow-model-bleed family is the natural validation target for Layer 3 (sequential MMD).** If we add the family _and_ the detector in the same cycle, we've broken the "never more than one scenario family per cycle" guardrail. So the sequencing is: add the family first under the current detector set (see what misses — probably most of them), then add MMD in the next cycle against a scenario pool that already exercises the pattern.
- **"Covariance architectural signal" in the queue = Hotelling T² (or MEWMA).** That is the classical, non-kernel version of Layer 3. Worth framing the architectural choice explicitly when WS1 picks up that item: Hotelling T² is ~1 week of work, MMD is ~2–3, and they target overlapping-but-not-identical patterns.
- **Nothing in this brief is cheap enough to ship into `main` without a full adversarial re-sweep.** Every layer touches either `TrendBuffer` (Layer 1), `ROLLBACK_DEFS` (Layer 2), the gate topology (Layer 3 + fusion), or the audit schema (all four). The `ADV_TP_THRESHOLD = 0.975` floor is defended by a full sweep; plan for that in any cycle scope.

---

## Recommended sequencing (suggested, not decided)

A plausible multi-cycle path, stated as cycles against the WS1 cadence (one scenario family + one detector family per cycle max):

1. **Cycle N** — Ship Mann-Kendall / Theil-Sen trend hardening inside `TrendBuffer`. Cheap, independent, no scenario-pool dependency. Mostly a hygiene play.
2. **Cycle N+1** — Shadow-model-bleed scenario family _only_. Document which current detectors miss what. This is the "problem statement" for Layer 3.
3. **Cycle N+2** — Hotelling T² as the covariance signal from the queue. Retires the `adv_correlated_noise` gap with a classical, well-understood detector. Validate against cycle N+1's scenarios.
4. **Cycle N+3** — mSPRT on primary SLIs (Layer 2). Replaces the per-signal threshold-ratio pattern for `p99`, `ttft`, `eval_score`, `downstream_err`. Biggest structural change yet; expect a full re-sweep and possibly a scenario-pool expansion in the same cycle.
5. **Cycle N+4** — Sequential MMD (Layer 3). Upgrade from Hotelling T² to kernel MMD for the joint-vector detector. Validation: MMD should subsume Hotelling T² verdicts plus catch higher-moment drift Hotelling misses.
6. **Post-WS2-Phase-3** — CUPAC preprocessing (Layer 1) and conformal anomaly scoring (Layer 4). Both depend on data that only shadow-mode production generates.

This sequence is deliberately conservative on guardrails (one change per cycle, full sweep each time, `main` advances only on approval). If the loop stays clean through all six cycles, the result is a system with formal FP-rate guarantees, multivariate drift detection, variance-reduced signals, and a novelty channel — i.e., exactly the four-layer stack John sketched, assembled in an order that never violates the workstream's standing rules.

---

## Open questions for John

These are the decisions that shape the above; they are not urgent, but they're the ones I'd want answered before WS1 picks up any of this.

1. **Is the target "same verdict model, better detectors" or "new verdict model (fusion)"?** The first four rows of the sequence above can ship inside the existing first-fires-wins model. The fusion model (all-clean-to-promote) is a topology change. They have different risk profiles.
2. **How hard is the "formal FP control" requirement?** Current engine delivers empirical 0% FP across 120 scenarios but has no theoretical bound. mSPRT and conformal both offer bounds; they also both require commitments about exchangeability and priors that the engine doesn't currently make.
3. **Where does the training data for Layers 1 and 4 come from?** Shadow-mode history from WS2 Phase 3 is the natural answer, but that is weeks out. Synthetic alternatives work for validation; they do not give true distribution-free guarantees.

---

## Sources

**Variance reduction (Layer 1):**
- [CUPAC — DoorDash engineering](https://careersatdoordash.com/blog/improving-experimental-power-through-control-using-predictions-as-covariate-cupac/)
- [CUPED / CUPAC technical walkthrough](https://j-sephb-lt-n.github.io/exploring_statistics/cuped_cupac_and_other_variance_reduction_techniques.html)
- [Etsy Engineering — predicted control variates](https://www.etsy.com/codeascraft/reducing-experiment-duration-with-predicted-control-variates)

**Sequential testing (Layer 2):**
- [Always Valid Inference — Johari, Pekelis, Walsh (arXiv 1512.04922)](https://arxiv.org/pdf/1512.04922)
- [Always Valid Inference — Operations Research final version](https://pubsonline.informs.org/doi/pdf/10.1287/opre.2021.2135)
- [Truncated mSPRT for practical significance (arXiv 2509.07892, 2025)](https://arxiv.org/html/2509.07892v1)
- [SPRT / mSPRT explainer](https://medium.com/@carey.chou/sequential-probability-ratio-test-sprt-and-mixture-sprt-msprt-d2a6ef85ff77)

**Kernel MMD (Layer 3):**
- [Gretton et al. — A Kernel Two-Sample Test (JMLR 2012)](https://jmlr.csail.mit.edu/papers/v13/gretton12a.html)
- [euMMD — efficient univariate MMD (Stat & Comp, 2024)](https://link.springer.com/article/10.1007/s11222-023-10271-x)
- [Adaptive-bandwidth MMD for separable metric spaces (Stat & Comp, 2024)](https://link.springer.com/article/10.1007/s11222-024-10483-9)
- [Randomly-projected multivariate MMD (Stat & Comp, 2025)](https://link.springer.com/article/10.1007/s11222-025-10627-5)
- [Signature MMD for path distributions (arXiv 2506.01718, 2025)](https://arxiv.org/abs/2506.01718)

**Conformal anomaly detection (Layer 4):**
- [Adaptive Conformal Anomaly Detection with Time-Series Foundation Models (ICLR 2026)](https://iclr.cc/virtual/2026/poster/10011253)
- [ACAD-TSFM paper PDF (OpenReview)](https://openreview.net/pdf/f683f9a6c7bdba56dd602884d3df0c16a8b0a309.pdf)
- [Conformal Prediction for Time-series with Change Points (NeurIPS 2025)](https://openreview.net/forum?id=HgLaVgCpCl)
- [Robust Conformal Outlier Detection under Contaminated Reference Data (ICML 2025)](https://icml.cc/virtual/2025/poster/43852)

**Adjacent bench:**
- [STUMPY docs — matrix profile](https://stumpy.readthedocs.io/en/latest/Tutorial_The_Matrix_Profile.html)
- [Sentry — matrix profile + Prophet in production](https://blog.sentry.io/time-series-monitoring-anomaly-detection-matrix-profile-prophet/)
- [BOCPD explainer — Gundersen](https://gregorygundersen.com/blog/2019/08/13/bocd/)
- [Risk-calibrated BOCPD for streaming SRE decisions (arXiv 2510.09619, 2025)](https://arxiv.org/abs/2510.09619)
- [Hotelling T² / MEWMA overview](https://trgrimm.github.io/posts/2024/03/t2_mewma/)
- [Deep anomaly detection in multivariate time series — survey (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11723367/)
- [Online model-based anomaly detection — taxonomy (Elsevier 2024)](https://www.sciencedirect.com/science/article/pii/S0952197624014817)

# Report — Effect-Size Sweep

- **Study id:** 2026-07-effect-size-sweep
- **Run:** `results/run-2026-08-04T04583Z/` — deploysignal SHA in the manifest, engine pin
  `#v0.6.6-pre` (installed 0.6.6-pre), scenario-file SHA-256 in the manifest, node v25.9.0.
- **Endpoints and thresholds** were frozen in `PREREGISTRATION.md` (committed 2026-07-31, before
  any run; merged as PR #64). Verdicts below are recorded **as computed**; no threshold was moved.
- Runtime: 0.2 s for 12,576 arm-trials (8 δ × 3 arms × 131 scenarios × 4 signals).

## 0. The headline, stated against the study's own expectation

The literature this study cites predicts the anytime-valid tax concentrates at small effects. **The
measured sign is the opposite on this corpus:** the Ville-bounded mixture supermartingale dominates
the retired classical Page-CUSUM at every δ below 2.5, overwhelmingly so at small δ (δ=1: mixture
0.969, classical **0.011**). E1 therefore **FAILS** — not marginally, but with its predicted
direction reversed. A post-hoc diagnostic (§4) attributes most of the gap to the shipped τ²
derivation mistuning the classical prior, and the remainder to the construction itself — and both
components favour the anytime-valid arm.

## 1. Detection rates (α = 3.333×10⁻⁵ per signal, identical across arms)

| δ (σ units) | classical | betting | mixture | gap (classical − mixture) |
|---|---|---|---|---|
| 0.25 | 0.000 | 0.006 | 0.006 | −0.006 |
| 0.5  | 0.000 | 0.040 | 0.086 | −0.086 |
| 0.75 | 0.000 | 0.403 | 0.597 | −0.597 |
| 1.0  | 0.011 | 0.849 | 0.969 | −0.958 |
| 1.5  | 0.260 | 0.994 | 1.000 | −0.740 |
| 2.0  | 0.895 | 0.998 | 1.000 | −0.105 |
| 2.5  | 1.000 | 1.000 | 1.000 | 0.000 |
| 3.0  | 1.000 | 1.000 | 1.000 | 0.000 |

**False alarms: 0 of 12,576 arm-trials** (fires before the injection tick). At this α, nominal
expectation over the pre-injection window is ≪ 1.

## 2. Endpoint verdicts (as computed)

### E1 — Monotone widening of the tax → **FAIL** *(confounded; see §3)*

`gap(δ)` is not monotonically non-increasing (it falls to −0.958 at δ=1 then rises), and
`gap(0.25) − gap(3.0) = −0.006`, against the required ≥ 0.10.

```
E1: monotone=false span=-0.0057 verdict=FAIL
```

The pre-registered prediction — the anytime-valid arm pays at small effects — is not merely
unsupported; the measured gap has the opposite sign at every δ where the arms differ.

### E2 — Ville-internal comparison → **FAIL** *(the unconfounded endpoint)*

`|D(betting, δ) − D(mixture, δ)|` reaches **0.195 at δ=0.75** (0.403 vs 0.597), against the 0.10
bar. Both arms are Ville-bounded, so this is a **construction** difference, which is what the
endpoint existed to localise: the aGRAPA betting process, standardising at 3σ and accruing wealth
multiplicatively, lags the Gaussian-mixture supermartingale through the 0.5–1σ band and converges
above 1.5σ.

```
E2: max_abs_diff=0.1947 verdict=FAIL
```

### E3 — Absorption threshold → **PASS**

`δ* = 0.75` — the smallest grid δ at which the mixture reaches 50% detection — against the bound
≤ 2.5.

```
E3: delta_star=0.75 verdict=PASS
```

Engine ADR 0025's "the free-φ composite null absorbs small steps" does not transfer to this
per-signal Family A construction: at fixed known φ=0, the mixture detects 0.75σ steps in a
100-tick canary more often than not.

## 3. Interpretation decisions (where the pre-registration left a reading open)

Per the house template, the reading most likely to make the test harder to pass was taken where a
choice was genuinely free; each is recorded:

1. **Four signals, not six.** The corpus defines a noise model only for `p99_latency`, `ttft`,
   `cost_req`, `downstream_err` (the healthy-infra jitter block in `engine/scenarios/slow_burn.ts`).
   `eval_score` and `tool_success_rate` have no corpus noise model and inventing one is exactly the
   fallback rule's prohibition — excluded, reported here.
2. **Noise = the corpus's own model:** `v = mean × (1 + c·U[0,1])` per signal; σ_baseline derived
   empirically per `inject-regression.ts:_meanSigma` over a 500-tick calibration window; the
   detector is calibrated from the same window (matched μ̂, σ̂).
3. **Injection at tick 30 of 100** — the documented suite convention.
4. **Paired trajectories:** all three arms see the identical series per (scenario, signal, δ);
   seeds are `mulberry32(fnv1a(scenario|signal|δ))`. No `Math.random` anywhere.
5. **Analytical thresholds (`1/α`) for all arms** — not the shipped bootstrap-quantile
   substitution, which is overwhelmingly conservative (median 2.4×10⁴ × `1/α`) and would have
   varied a second thing between what the arms' validity classes claim and what fires.
6. **Classical τ² = the shipped derivation** `(max(0.05μ̂, 2σ̂)/2)²`. On this corpus that is
   μ-dominated for every signal (τ/σ = 0.0866/c ≈ 2.9–10.8), which is itself a finding — see §4.
7. **Detection** = first fire in [30, 99] with no earlier fire; pre-injection fires are false
   alarms, reported separately; `D` = detections/trials.

**The confound, §3 of the pre-registration, plus one axis found by running:** classical and
mixture differ in bound, reset, increment shape — and, in the shipped configuration, **prior
scale** (τ² μ-dominated vs σ²-prior). Every classical comparison above is confounded on all four.
The E1 verdict stands as computed; its *attribution* is §4's job.

## 4. Post-hoc observations (not pre-registered — no verdicts attach)

- **The matched-prior rerun** (`analysis/posthoc_matched_prior.mjs`, identical trajectories,
  classical forced to τ² = σ̂²): the gap shrinks but keeps its sign — classical_matched 0.609 vs
  mixture 0.969 at δ=1; 0.084 vs 0.597 at δ=0.75; parity from 1.5σ. So the shipped τ² mistuning
  explains **most** of the primary gap and the classical construction (reset-at-zero, two-sided
  quadratic increment: positive drift requires δ ≳ 0.62σ at matched prior) explains the rest.
  **Both components favour the anytime-valid arm.**
- **The shipped classical CUSUM was near-blind to sub-2σ shifts on low-CV signals.** With
  τ = 0.0866σ/c, a c = 0.008 signal carries a ~10.8σ prior: the detector was tuned for
  order-of-magnitude regressions. Its 35.50-vs-23.45 NAB advantage over the mixture (retracted
  evidence, 2026-07-31) coexists with near-zero power here — different corpus, different
  effect-size regime, and no contradiction.
- **E2's failure is information, not damage:** through the 0.5–1σ band the mixture supermartingale
  is the strongest Family A arm, and the co-shipped betting process pays up to 19 points of
  detection for its nonparametric robustness. That trade was previously unmeasured.
- **What this does and does not say about the wiki's cost question.** It does not contradict the
  literature's like-for-like measurements (UI vs LRT, tuned CS vs CLT width — those compare
  matched constructions). It says the portfolio's own anytime-valid arms carry **no measured power
  tax against the arm they replaced** — the replacement was an upgrade at small effects even
  before its validity properties are counted.

## 5. Reproduction

```sh
node studies/effect-size-sweep/analysis/run_sweep.mjs          # refuses an existing run dir
node studies/effect-size-sweep/analysis/posthoc_matched_prior.mjs
node studies/effect-size-sweep/analysis/check_report.mjs       # report ↔ endpoints.json consistency
```

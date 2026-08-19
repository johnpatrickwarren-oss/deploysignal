# Report — BurstGPT on a real time axis

- **Study id:** 2026-08-burstgpt-real-axis. **Register:** `~/concord/knowledge/WORKLIST.md` C56.
- **Run:** `results/run-20260819T020827Z/` — repo SHA, bundle SHA-256, seeds and command in the
  manifest; node v25.9.0. Supersedes `run-20260819T020655Z` (endpoint-R NaN from six all-idle
  cells, fixed test-first) which superseded `run-20260819T020507Z` (instrument tolerance
  mis-calibrated at ~2.6σ); both prior runs are retained with the defects named in the manifests
  and in `PREREGISTRATION.md`'s dated amendments. **S and D are byte-identical between the
  superseded 020655Z run and the decisive run** — the R fix changed nothing else.
- **Estimands, bars and verdict rules** froze in `PREREGISTRATION.md` before any statistic was
  computed (commit `1447fbd`). Verdicts below are recorded as computed; no bar moved. Harness
  catch count: 0 (the harness contains no catch blocks; any exception aborts the run).
- **Substrate:** `runs/baselines/real-burstgpt-v2/bundle.jsonl`, sha256 `1b7b8ec4…` — 174,234
  real 5 s ticks (10.08 days), 34,202 observed (≥1 request), 140,032 count-0 ticks treated as
  **missing, never zero**. Gate printed `study is EXECUTABLE`; all six instrument checks passed,
  including I3: on white-noise costs the naive zero-filled ACF manufactures lag-1 dependence of
  0.325 from the arrival pattern alone while the registered missing-aware estimator reports
  −0.021. That is the estimand trap, demonstrated on this exact missingness pattern.

## 0. The headline

**C30's serial verdict survives the real time axis, and the cv it could not decompose is mostly
not cost variation.** At real 5 s lags the cost process's serial dependence is non-zero
(S-V1) and AR(1) remains inadequate (S-V2) — both of C30's findings stand on the axis that
actually exists, with the dependence measuring *stronger* than the v1-axis numbers. And the
decomposition C30 registered as impossible (its item-1 caveat) is now measured: **69.0% of the
within-cell variance of bucket-mean cost is small-sample averaging noise over variable bucket
occupancy; the underlying between-bucket cost variation has cv 0.3938**, roughly half the
headline cv C30 could report.

| id | Endpoint | Number | Verdict |
|---|---|---|---|
| **S-V1** | cost serial dependence at real 5 s lags | φ̂ = 0.4019, 95% CI [0.2180, 0.5213] | **NON-ZERO** (CI excludes 0) |
| **S-V2** | AR(1) adequacy on the real axis | \|ρ̂₂ − φ̂²\| = 0.1145 > 0.05 | **INADEQUATE** |
| **D-V1** | cv decomposition | averaging share 0.6905, between share 0.3095 | **PUBLISHED** (all gates passed) |
| **R-V1** | arrival serial dependence (within-cell) | φ̂ = 0.0144, 95% CI [0.0033, 0.0397] | **NON-ZERO** (barely; CI excludes 0) |
| **R-V2** | arrival AR(1) adequacy | \|ρ̂₂ − φ̂²\| = 0.0204 ≤ 0.05 | **ADEQUATE** |
| **R-V3** | hour-of-day periodicity of arrivals | amplitude 4.2098, split-half ρ = 0.1898 | **NOT PRESENT** (replication bar failed) |

Predictions (§9 of the pre-registration): S as predicted; D executable as predicted, with the
averaging share well above the predicted floor of 0.2; **R-V3 departs from the prediction** —
I predicted hour-of-day periodicity would fire, and it failed the replication bar exactly as it
did for C30 on the synthetic axis (0.1898 here vs C30's 0.371 there, both < 0.5).

## 1. Endpoint S — the serial structure, on lags that are real seconds

Frame: 33,811 usable ticks in 128 included `(hour_of_day, day_of_week)` cells (34 cells under
the 30-observed-tick floor excluded, 391 ticks; no zero-mean cells). Within-cell residual cv:
0.7556. Every published lag clears the 2,000-pair floor (15,751–16,085 pairs).

| lag (×5 s) | measured ρ̂ | pairs | AR(1) prediction (φ̂ᵏ) |
|---|---|---|---|
| 1 | 0.3003 | 15,751 | 0.4019 |
| 2 | 0.2760 | 15,965 | 0.1615 |
| 3 | 0.2685 | 16,085 | 0.0649 |
| 4 | 0.2541 | 16,071 | 0.0261 |
| 5 | 0.2539 | 15,966 | 0.0105 |
| 6 | 0.2482 | 15,932 | 0.0042 |
| 7 | 0.2556 | 15,923 | 0.0017 |
| 8 | 0.2212 | 15,830 | 0.0007 |

φ̂ = 0.4019 (OLS through the origin over lag-1 pairs, n = 15,751), circular moving-block
bootstrap 95% CI [0.2180, 0.5213] (720-tick blocks, 1,000 resamples, seed 42). The CI excludes
zero: **S-V1 NON-ZERO**. The adequacy check compares ρ̂₂ = 0.2760 against φ̂² = 0.1615:
gap 0.1145 > 0.05, so **S-V2 AR(1) INADEQUATE** and no φ is published — the measured ACF is
the result. The decay is nearly flat across eight real-5 s lags where AR(1) demands geometric
collapse: the long-range-dependence signature C30 saw on the compressed axis is a property of
the real one.

**Relation to C30, stated precisely.** C30's φ̂ = 0.2488 and lag-1 ACF 0.2485 were measured on
v1's array-index axis (80.4% of real ticks absent, 10.08 days compressed into ~47.5 synthetic
hours) and stand as measured on that axis. On the real axis the same quantities measure
**larger** (lag-1 0.3003; φ̂ 0.4019): v1's "adjacent" pairs mixed true 5 s gaps with
arbitrarily long ones, which attenuated the dependence. The AR(1) rejection is unchanged in
kind. Nothing here retracts a C30 number; the v1-axis measurements were correct measurements
of a series whose axis was not the one assumed.

**φ̂ vs ρ̂(1), and why they differ (0.4019 vs 0.3003).** The two estimators are both as
registered and differ only in denominator: φ̂ normalises by the variance of pair-participating
ticks, ρ̂ by the variance of all observed ticks. *Inference:* pair-participating ticks sit
inside arrival runs, where occupancy is higher and the averaging noise in the bucket mean is
smaller (exactly endpoint D's mechanism), so the pair-restricted denominator is smaller. The
divergence is itself evidence of occupancy-dependent variance, and it is why the adequacy
verdict is what carries weight rather than any single φ.

Secondary (no cell centring, reported and not adopted): φ̂ = 0.7223, CI [0.5520, 0.8144],
cv 0.8123, AR(1) likewise inadequate. As in C30, the primary within-cell frame gives the
smaller φ.

## 2. Endpoint D — the cv, decomposed at last

Model: `E[e²_t] ≈ σ²_B + σ²_W / n_t` over 33,811 observed ticks (frame as in §1); OLS of the
squared within-cell deviation on inverse occupancy.

| | value |
|---|---|
| σ̂²_B (between-bucket, intercept) | 2.0115e-4 |
| σ̂²_W (per-request, slope) | 6.2647e-4 |
| mean(1/n_t) | 0.7162 |
| total within-cell variance | 6.4982e-4 |
| **averaging-noise share ŝ** | **0.6905** |
| **between-bucket share** | **0.3095** |
| between-bucket cv (√σ̂²_B / mean cost) | **0.3938** |
| total cv in this frame | 0.7079 |
| mean observed cost | 0.03601 USD/request |

Both components positive; model adequacy passed at Pearson 0.9401 across all 7 occupancy bins
(bin floor 200 ticks; the fitted line tracks the binned means from n = 1 through n ≥ 11):
**D-V1 PUBLISHED.**

Reading: about **69% of what C30 measured as cv = 0.7603 is small-sample averaging** — the
bucket mean of a handful of heterogeneous requests jitters because n_t is small (median
occupancy is 1–2 requests per populated 5 s bucket; mean 5.85), not because the underlying
per-bucket cost level moves that much. The underlying between-bucket variation, cv 0.3938, is
what a cost-level detector is actually chasing.

Diagnostic (descriptive, no verdict): Spearman rank correlation between bucket-mean cost and
occupancy is −0.1123 — a mild negative cost–occupancy dependence, which assumption A-D3
(occupancy-independent μ_t) excludes. It qualifies the share estimate; with |ρ| ≈ 0.11 the
qualification is mild, and the binned adequacy at 0.9401 says the 1/n law dominates the signal.

*Post-hoc, labelled as such, no verdict attached:* if the averaging noise is serially
independent (it is, mechanically, across disjoint request sets under A-D2), the observed ACF is
the underlying mean-cost process's ACF attenuated by the between-bucket share:
ρ_μ(1) ≈ 0.3003 / 0.3095 ≈ 0.97. Taken at face value this says the per-bucket mean cost is a
*highly persistent* process observed through occupancy noise. I flag it because it coheres with
the flat ACF, and I attach no verdict because it leans on every assumption of the decomposition
at once and was computed after seeing both results.

## 3. Endpoint R — the arrival process itself

Fully observed; no missingness convention. Frame: 168,474 usable ticks in 162 cells (the 6
all-idle `(hod, dow)` cells are excluded per the amended frame rule — they are the cells where
nothing ever arrives in this slice).

**Serial (R-V1, R-V2).** Within-cell φ̂ = 0.0144, CI [0.0033, 0.0397] — the CI excludes zero,
so dependence is formally NON-ZERO, but at 0.014 with within-cell cv 6.3813 it is negligible in
size; and the adequacy gap is 0.0204 ≤ 0.05, so **AR(1) is ADEQUATE** for arrivals — the first
adequacy pass any series in this line of studies has produced. Once the elapsed-time
hour × day cell means are removed, per-5 s arrival counts are close to serially independent.

**Periodic (R-V3).** Hour-of-day amplitude 4.2098 clears the 0.05 amplitude bar by two orders
of magnitude, but the first-half profile correlates with the second-half profile at Pearson
**0.1898 < 0.5**: **NOT PRESENT** under the frozen rule. With ~10 real diurnal cycles
available, the elapsed-time daily profile still does not replicate across halves.
*Inference:* the arrival process is dominated by non-stationary bursts on day-plus scales
rather than a stable daily cycle; the "diurnality" a naive reading of the amplitude suggests
does not survive a held-out split, echoing C30's failed replication (0.371) on the synthetic
axis. (Phase caveat: hours are real modulo one unknown offset; both statistics used here are
rotation-invariant, so the unknown phase cannot produce this failure.)

**Joint reading of S and R, stated because it is the study's most useful shape:** the *cost*
process carries slowly-decaying serial dependence at real lags while the *arrival-count*
process, within-cell, is nearly white. The persistence lives in what requests cost (token
volumes), not in how many arrive.

## 4. Instruments and gate

All six pre-registered instrument checks passed in the decisive run against the real
observation pattern: I1 recovered φ = 0.25 as 0.2362 with the adequacy check passing; I2
white-noise φ̂ = −0.0205 within the amended ±0.03; I3 naive-vs-aware 0.325 vs −0.021; I4a/I4b
recovered target shares 0.2/0.8 as 0.2134/0.7966; I5 degenerate share 0.0045 ≤ 0.05. Gate:
bundle sha256 matches the pinned value; 174,234 ticks; Σ counts = 200,000; 140,032 count-0
ticks; 1,503 zero-cost observed ticks.

## 5. Provenance

Three runs, append-only, all retained: `run-20260819T020507Z` (NOT-EXECUTABLE; I2 tolerance
mis-calibrated — the bar sat at ~2.6σ of a null distribution never computed; no endpoint ran),
`run-20260819T020655Z` (endpoint-R NaN; S and D valid and identical to final),
`run-20260819T020827Z` (decisive). Each supersession names its defect in the superseding
manifest; both fixes were made test-first and are documented as dated amendments in
`PREREGISTRATION.md`. Every number above is machine-checked against the decisive run's
`results.json` by `analysis/check_report.mjs` (exit 1 on drift). No model calls, no network;
seeds: bootstrap 42, instruments 101/102/104/105/106.

## 6. Scope — what this study did not do

- **It does not retract any C30 number.** v1-axis measurements stand for the axis they were
  measured on; this study measured the axis that exists.
- **It does not touch** `engine/scenarios/corpus-noise-model.json`, its loader, either bundle,
  or any detector. Whether the artifact should carry real-axis parameters is an operator
  decision this report informs and does not make.
- **It does not re-run C9 or C11**, and it publishes no φ (AR(1) remains inadequate for cost).
- **Day-of-week periodicity was never in scope** (10.08 days < the 14-day minimum, declared in
  advance).
- **The A6 disclosure is inherited:** `cost_req` is derived — 5 s-bucketed token volume under a
  constant price — so "cost variation" throughout means token-volume variation under the
  recovered GPT-4 pricing.
- **The decomposition rests on stated assumptions** (constant per-request variance,
  within-bucket independence, occupancy-independent means); the Spearman −0.1123 diagnostic
  shows the last is mildly violated. The share is published under those assumptions, not free
  of them.
- **Absolute phase is unknowable from this source**; every hour-of-day statement is modulo one
  unknown rotation.

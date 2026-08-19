# Pre-registration — BurstGPT on a real time axis

- **Study id:** 2026-08-burstgpt-real-axis
- **Register:** `~/concord/knowledge/WORKLIST.md` C56.
- **Question:** does C30's serial verdict (φ̂ = 0.2488, AR(1)-adequacy REJECTED, both measured on
  `real-burstgpt-v1`'s array-index axis) survive lags that are real seconds, and how much of C30's
  measured cv = 0.7603 is per-request cost variation vs small-sample averaging over variable bucket
  occupancy?
- **Substrate:** `runs/baselines/real-burstgpt-v2/bundle.jsonl` — read-only evidence. Nothing else
  is read for scoring; nothing in `runs/` or `engine/` is written.
- **Pre-registered:** 2026-08-18, deploysignal branch `study/burstgpt-real-axis` from `main`
  `51ef70b`.
- **Template:** `studies/corpus-noise-v2/PREREGISTRATION.md` (C30); provenance rules transfer
  verbatim (§8).

This file is committed **before any statistic is computed**. The estimands in §2, estimators in §4,
bars in §5, and NOT-EXECUTABLE conditions in §6 freeze at that commit. A failed endpoint is a
publishable result; no bar moves afterwards. §9 states the expected outcome before the run so a
surprise is visible as a surprise.

**What this study does not touch, frozen as scope:** `real-burstgpt-v1` and `-v2` (read-only);
`engine/scenarios/corpus-noise-model.json` and its loader; every C30 number (v1-axis measurements
**stand as measured on that axis** whatever this study finds — the question is survival on the real
axis, not retraction). Whether any artifact updates follow the verdicts is an operator decision
outside this study. Compute-only: no model calls, no network.

---

## 1. The estimand trap, and why the estimand must be named first

In v2, `cost_req[t] = 0` means one of two things and `auxiliary_series.requests_per_tick[t]`
disambiguates: count > 0 is a real zero-token request; count = 0 is **no observation** — the bucket
mean is undefined and stored as 0 by the loud-zero-fill convention
(`tools/_ingest-real-trace-burstgpt.ts`, filter
`burstgpt_v2:full_tick_range_zero_filled_cost_requests_per_tick_disambiguator`). **80.4% of ticks
(140,032 of 174,234) are count-0.** An ACF computed naively over the zero-filled `cost_req` series
therefore measures mostly the arrival process (observed vs not), not cost dependence. Instrument
check I3 (§7) demonstrates this on synthetic data where the cost truth is white noise.

Every endpoint below names its estimand as a property of a defined process, before any estimator.

## 2. Estimands (frozen)

Three targets, exactly the three the C56 brief lists as defensible. S and D answer the register
question's two halves; R is secondary context (burstiness and periodicity of the arrival process,
which is fully observed).

- **S — serial structure of the cost process at real lags.** Estimand: the lag-k autocorrelation,
  k = 1…8 at true lag k×5 s, of the within-cell residual cost process **conditional on observation**
  — i.e. over ticks with ≥1 arrival — treating count-0 ticks as missing, never as zero.
- **D — decomposition of the within-cell variance of bucket-mean cost.** Estimand: the split of
  Var(bucket mean) into **between-bucket** variation of the underlying mean cost (σ²_B) and
  **within-bucket averaging noise** (σ²_W / n_t, per-request variance divided by occupancy), under
  the model in §4-D. This is what C30's cv = 0.7603 could not decompose (its item-1 caveat).
- **R — the arrival process itself** (`requests_per_tick`): its serial dependence at real lags and
  its hour-of-day periodicity. Fully observed; no missingness convention needed.

## 3. Frame (frozen)

Matches C30's primary frame so S is the direct heir of C30 §1.

- **Observed tick:** `requests_per_tick[t] ≥ 1`. Observed set O before cell exclusions: 34,202
  ticks (a structural fact of the bundle, §6 gate).
- **Cells:** `(hour_of_day[t], day_of_week[t])` as stored in the bundle — real elapsed-time cells
  modulo one unknown phase offset (bundle filter
  `burstgpt_v2:clock_elapsed_from_trace_start_no_wall_anchor_phase_unknown`). All S and D analyses
  are within-cell: residual `r_t = x_t / m_cell(t)`, `m_cell` = mean of observed `cost_req` in that
  cell. Cells with **< 30 observed ticks** are excluded from O (exclusion count reported).
- **Deviations:** `d_t = r_t − 1`.
- **Secondary (reported, never adopted):** the same S statistics with no cell centring.
- For R, the same frame with all 174,234 ticks observed.

Rationale, declared before seeing any number: cell centring removes low-frequency structure the
engine's per-cell calibration already handles, and C30 predicted (correctly) that it yields the
smaller φ — the reading harder on the premise that serial structure matters.

## 4. Estimators (frozen)

Deterministic throughout. Seeded `mulberry32` where randomness is needed; no `Math.random`, no
`Date.now`/`new Date` anywhere in the harness or its outputs (harness-discipline rule 4; the run
stamp is passed in from the shell).

**S — missing-aware ACF and AR(1) fit.**

1. Pair set `P_k` = ordered pairs `(t, t+k)` with both ticks observed **and in the same cell**
   (C30 excluded cell-crossing pairs; so does this).
2. `ρ̂(k) = [ Σ_{P_k} d_t·d_{t+k} / |P_k| ] / σ̂²` with `σ̂² = Σ_O d_t² / |O|` — pairwise-complete
   products at true lags over a common variance. (May exceed [−1, 1] slightly by construction;
   reported as computed.)
3. `φ̂` = OLS slope of `d_{t+k}` on `d_t` through the origin over `P_1` (C30's estimator restricted
   to observed pairs).
4. **95% CI on φ̂ by circular moving-block bootstrap on the full 174,234-tick lattice** — blocks of
   **720 ticks (1 h)**, 1,000 resamples, `mulberry32(42)`. Blocks carry `(d_t, observed?)` jointly,
   so the missingness pattern travels with the data; pairs are formed only inside a block, never
   across a join. φ is declared **non-zero iff the CI excludes 0**.
5. **AR(1) adequacy, identical bar to C30:** AR(1) is **inadequate iff `|ρ̂(2) − φ̂²| > 0.05`.**
   No φ is published from a series AR(1) does not fit; the measured ACF is published instead.

**D — variance decomposition by inverse-occupancy regression.**

Model, with assumptions named: per-request costs within bucket t are draws with mean μ_t and
constant variance σ²_W (constant across buckets — assumption A-D1); the bucket mean over n_t
requests then satisfies `E[(x_t − μ_t)²] = σ²_W / n_t` (within-bucket independence — assumption
A-D2); μ_t varies between buckets with within-cell variance σ²_B (occupancy-independent —
assumption A-D3). Then for the within-cell deviation `e_t = x_t − m_cell(t)`:

`E[e_t²] ≈ σ²_B + σ²_W / n_t`

1. OLS of `y_t = e_t²` on `1/n_t` over observed ticks in included cells: intercept `â` estimates
   σ²_B, slope `b̂` estimates σ²_W. (Raw-dollar units, not residual units, so the components are
   interpretable; the share statement below is scale-free.)
2. **Averaging-noise share** `ŝ = b̂·mean(1/n_t) / (â + b̂·mean(1/n_t))`, the fraction of the
   within-cell variance of bucket-mean cost attributable to small-sample averaging. Between-bucket
   share = 1 − ŝ. Also reported: the implied between-bucket cv (`√â / mean(x)`) next to the total
   within-cell cv, both in this frame.
3. **Model adequacy, frozen:** bin observed ticks by occupancy — n = 1, 2, 3, 4, 5, 6–10, ≥ 11 —
   drop bins with < 200 ticks, and require Pearson correlation ≥ 0.5 between the binned means of
   `y_t` and the fitted `â + b̂/n̄_bin` across surviving bins. Below the bar, the linear-in-1/n
   model is declared inadequate: â, b̂ are reported descriptively and **no share is published**
   (§6 D-NE2).
4. **Diagnostic (descriptive, no verdict):** Spearman rank correlation between `x_t` and `n_t`
   over observed ticks — a nonzero value flags cost–occupancy dependence that assumption A-D3
   excludes; it qualifies the share, it does not void it.

**R — arrival process.**

1. Serial: same within-cell ACF and φ̂ machinery as S applied to `requests_per_tick` (no
   missingness — every tick observed), lags 1–8, same CI method, same adequacy bar.
2. Periodic: hour-of-day profile = 24 hod-cell means of `requests_per_tick` divided by the grand
   mean; amplitude `A = (max − min) / mean`. **Present iff `A ≥ 0.05` AND** the profile computed
   on the first half of the tick range correlates with the second-half profile at Pearson
   `ρ ≥ 0.5` (C30's bars, now testable: ~10.08 complete 24 h cycles ≥ the minimum 3). The profile
   is identified **modulo one unknown rotation** (no wall anchor); amplitude and split-half
   replication are rotation-invariant, so the phase caveat qualifies the profile's labels, not the
   verdict.
3. **Day-of-week is out of scope by A5, declared now:** 10.08 days < the 14-day minimum. Not an
   endpoint; nothing about day-of-week periodicity is claimed.

## 5. Endpoints and verdicts (frozen)

| id | Endpoint | Verdict rule |
|---|---|---|
| **S-V1** | Cost serial dependence at real 5 s lags is non-zero | φ̂ 95% bootstrap CI excludes 0 |
| **S-V2** | AR(1) adequacy on the real axis | inadequate iff `|ρ̂(2) − φ̂²| > 0.05` |
| **D-V1** | The cv decomposition | shares published iff executable per §6; the two shares and the implied between-bucket cv are the result |
| **R-V1** | Arrival serial dependence | same rule as S-V1, on `requests_per_tick` |
| **R-V2** | Arrival AR(1) adequacy | same rule as S-V2 |
| **R-V3** | Hour-of-day periodicity of arrivals | present iff `A ≥ 0.05` AND split-half `ρ ≥ 0.5` |

The report states every endpoint's number and verdict, as computed. **"Does C30's serial verdict
survive?" is answered by S-V1 + S-V2 jointly:** survival means dependence still non-zero and AR(1)
still inadequate on the real axis. Any other combination is reported as what it is — a real-axis
finding that differs from the v1-axis one, with C30's numbers still standing for the axis they
were measured on.

## 6. NOT-EXECUTABLE conditions (frozen — what voids the instrument rather than scoring it)

**Gate (runs before any endpoint; the run aborts and reports NOT-EXECUTABLE if any fails):**

- G1: `runs/baselines/real-burstgpt-v2/bundle.jsonl` sha256 =
  `1b7b8ec46bbdac4edf4590c885950801d6236826f6ead406c59d3bc8b2241d90` (the artifact this file was
  written against, on `main` `51ef70b`).
- G2: 174,234 ticks in all four arrays (`cost_req`, `requests_per_tick`, `hour_of_day`,
  `day_of_week`); Σ `requests_per_tick` = 200,000; count-0 ticks = 140,032; observed ticks with
  `cost_req = 0` = 1,503. All are published structural facts of the bundle
  (`runs/baselines/BURSTGPT-V2-OUTCOME.md`; C30 §4).
- G3: every instrument check in §7 passes.

**Per-endpoint:**

- S-NE1: `|P_1| < 2,000` or `|P_2| < 2,000` → S is NOT-EXECUTABLE (the A4 logic: SE ≈ n^(−1/2);
  2,000 gives ≈ 0.022). Individual lags k ≥ 3 with `|P_k| < 2,000` are reported as
  `insufficient_pairs`, without a number.
- D-NE1: `â ≤ 0` or `b̂ ≤ 0` → the decomposition is NOT-EXECUTABLE (variance components are
  nonnegative; a negative estimate means the model cannot describe this data). â, b̂ still
  reported descriptively.
- D-NE2: the §4-D adequacy correlation < 0.5 → no share published; â, b̂ descriptive only.
- D-NE3: fewer than 3 occupancy bins survive the 200-tick floor → adequacy is unassessable → same
  consequence as D-NE2.

A NOT-EXECUTABLE outcome closes C56 per the register ("write the report whatever the verdicts").

## 7. Instrument checks (frozen, run before the measurement, tolerances declared now)

The estimators in §4 are new code; each is validated against synthetic data with known truth
**using the real bundle's observation pattern** (the counts array — no cost statistic is computed
before the gate). All synthetic generation is `mulberry32`-seeded; seeds fixed in the harness.

| id | Construction | Must satisfy |
|---|---|---|
| I1 (fire) | AR(1), φ = 0.25, innovations N(0,1), length 174,234, masked by the real observation pattern; §4-S estimator | `|φ̂ − 0.25| ≤ 0.03` and adequacy check **passes** (it is AR(1)) |
| I2 (no-fire) | White noise N(0,1), same mask | `|φ̂| ≤ 0.02` and `max_{k≤8} |ρ̂(k)| ≤ 0.03` |
| I3 (the trap, demonstrated) | I2's white-noise costs zero-filled at unobserved ticks, **naive** full-series ACF | naive lag-1 ACF ≥ 0.10 while the §4-S estimator on the same data reports `|φ̂| ≤ 0.02` — i.e. the naive estimator manufactures dependence from arrivals and the registered one does not |
| I4a (decomposition, between-dominated) | Synthetic (μ_t, n_t): n_t = real counts at observed ticks; σ²_B, σ²_W chosen so true averaging share = 0.2 | `|ŝ − 0.2| ≤ 0.10` |
| I4b (decomposition, averaging-dominated) | As I4a with true share = 0.8 | `|ŝ − 0.8| ≤ 0.10` |
| I5 (degenerate) | σ²_W = 0 (pure between) | `ŝ ≤ 0.05` |

A failed instrument check is a code defect: fix test-first, and the fix is a rerun cause under
provenance rule 3. Instrument results are written into the run directory alongside the
measurement.

## 8. Provenance rules (verbatim from the C30 template)

1. This file is committed **before any run**.
2. Every run writes an append-only `results/run-<UTC>/manifest.json`: repo SHA, bundle SHA-256,
   seeds, command, versions. The run directory refuses to overwrite an existing one. No result is
   ever overwritten. The UTC stamp is supplied by the invoking shell, never read from the clock by
   the harness.
3. A rerun is permitted **only** for a code defect, fixed test-first, with the superseding run's
   manifest naming the defect; the prior run remains.
4. The report states every endpoint's number and verdict, including NOT-EXECUTABLE.
5. Report numbers are **machine-checked against the run JSON** by `analysis/check_report.mjs`
   (exit 1 on drift). One report path only.
6. Any `catch` in the harness increments a visible failure counter that the results JSON and the
   report print; a nonzero count is part of the result.
7. **Stopping rule:** the study is one deterministic decisive run on the full fixed bundle
   (instrument checks, then gate, then endpoints, in that order, in one invocation). There is no
   flexible N and nothing to pilot: the data is fixed and the harness is seeded.
8. No model is invoked and no network is touched; the manifest records `model_calls: none`.

## 9. Predicted outcome, stated before the run

- **S:** dependence survives and AR(1) stays inadequate (S-V1 non-zero, S-V2 inadequate). Grounds:
  C30's post-hoc showed dependence *strengthening* when zero-cost ticks were dropped, and the slow
  ACF decay was attributed to bursty arrivals, which are real structure, not an axis artifact. The
  real-axis φ̂ has no strong prior; it need not be near 0.2488, since v1's lag-1 pairs mixed true
  5 s gaps with arbitrarily long ones.
- **D:** executable, with a **non-trivial averaging share** (ŝ > 0.2) — mean occupancy over
  observed ticks is ≈ 5.85 requests, small enough for 1/n noise to matter if per-request dispersion
  is large.
- **R:** hour-of-day periodicity present (R-V3 fires) — BurstGPT is described upstream as strongly
  diurnal, and ~10 real cycles are available. Arrival AR(1): no prediction.

A departure from any of these is reported as a departure, not adjusted for.

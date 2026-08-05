# Report — Corpus Noise Model v2

- **Study id:** 2026-08-corpus-noise-v2. **Register:** `~/concord/knowledge/WORKLIST.md` C30.
- **Run:** `results/run-20260805T232134Z/` — repo SHA, bundle SHA-256s and frozen constants in the
  manifest, node v25.9.0. Supersedes `run-20260805T231835Z` for a code defect (§3.3); the prior run
  is retained.
- **Bars, method and the predicted outcome** were frozen in `PREREGISTRATION.md`, committed before
  any parameter was fitted (PR #70). Verdicts below are recorded **as computed**; no bar was moved.

## 0. The headline

**Of the six Family A signals, one has a real source in this repo, and even it cannot supply the
parameter C30 was chiefly after.**

| Signal | Marginal | Serial (AR(1) φ) | Periodic |
|---|---|---|---|
| `cost_req` | **SOURCED** — BurstGPT, 34,202 ticks | **AR(1) REJECTED** (§4 S.3) | **A5** — 2 diurnal cycles |
| `eval_score` | **A2** — construct mismatch | **A2 + A3** | **A2 + A3** |
| `p99_latency` | **A1** | **A1** | **A1** |
| `ttft` | **A1** | **A1** | **A1** |
| `downstream_err` | **A1** | **A1** | **A1** |
| `tool_success_rate` | **A1** | **A1** | **A1** |

Two things follow, and the second is the one that changes what anyone should do next.

**C30's premise is close to inverted.** The register described a corpus that "covers 4 of 6 signals",
with the uncovered two as the gap. The four it covers are covered by *invented* constants, and
**three of those four — `p99_latency`, `ttft`, `downstream_err` — have no real source in this repo
either.** The signal that does have one, `cost_req`, is one both sweeps already used. The exclusion
the sweeps made was correct, and lifting it is not possible from repo data; what the sweeps did
*not* know is that most of what they included rests on the same footing as what they excluded.

**The φ≠0 upgrade C30 asked for cannot be built, and not for want of data.** `cost_req` has 34,202
real ticks and unambiguous serial dependence — φ̂ = 0.2488, bootstrap CI [0.1325, 0.3494], which
excludes zero. The pre-registered AR(1) adequacy check (§4 S.3) rejects it anyway: the measured ACF
decays far too slowly for any AR(1) process. This is one of the two falsifiers named in
`PREREGISTRATION.md` §9, and it fired.

## 1. `cost_req` — what was sourced

**Source:** `real-burstgpt-v1`, 34,202 ticks across 48 (hour × day) cells, 5 s bucketing from real
timestamps. **A6 disclosure:** the signal is derived — mean per-request cost within each 5 s bucket,
tokens × a per-model pricing overlay (`tools/_ingest-real-trace-burstgpt.ts:65,107-111`). Its
variation is that of real 5 s-bucketed token volume under a constant price, and every use below
carries that reading.

### Marginal — sourced, and the incumbent constant is wrong by two and a half orders of magnitude

| | value |
|---|---|
| `cv` (within-cell, §3 primary) | **0.7603** |
| incumbent corpus `cv` for `cost_req` | 0.001732 (`c = 0.006`, `cv = c/√12`) |
| ratio | **439×** |
| sample skewness | 2.946 |
| n | 34,202 |

KS distance to each candidate family, standardized residual:

| family | KS |
|---|---|
| lognormal | 0.1073 *(best parametric)* |
| uniform *(the incumbent's family)* | 0.1352 |
| gamma | 0.2394 |

**No parametric family clears the 0.05 bar**, so per §4 M.4 the artifact ships the **empirical
quantile function** (101-point grid of the standardized residual). The incumbent's uniform is the
second-worst of the three candidates.

*The scale finding does not by itself re-open either sweep.* Both index effects in units of
`σ_baseline` estimated from the same jitter (`run_sweep.mjs`, `delta × sigma`), and the Family A
arms standardize by `σ̂`, so a 439× change in scale cancels. **The shape finding is the one with
teeth**: a skewness of 2.95 against a uniform's 0 is not a scale difference, and it does not cancel.

### Serial — AR(1) fitted, then rejected

φ̂ = **0.2488** (OLS through the origin on within-cell pairs, n = 34,106 pairs), bootstrap 95% CI
**[0.1325, 0.3494]** — serial dependence is real and the CI excludes zero.

The pre-registered adequacy check compares ρ̂₂ against φ̂²:

| lag | measured ACF | AR(1) prediction (φ̂ᵏ) |
|---|---|---|
| 1 | 0.2485 | 0.2485 |
| 2 | **0.2380** | **0.0619** |
| 3 | 0.2239 | 0.0153 |
| 4 | 0.2028 | 0.0038 |
| 5 | 0.1921 | 0.0009 |
| 8 | 0.1551 | 0.0000 |

`|ρ̂₂ − φ̂²| = 0.1761 > 0.05`. **AR(1) is declared inadequate and no φ is published.** The ACF decays
roughly linearly across eight lags where AR(1) requires geometric decay to nothing by lag 4. This is
long-range dependence — the signature of bursty request arrivals, which is what the underlying trace
is — and an AR(1) φ fitted to it would misdescribe the process at every lag but the first.

*Secondary analysis (§3, no cell centring), reported as pre-registered:* `cv` = 0.8116, φ̂ = 0.4478.
As §3 predicted before the fit, the primary within-cell frame gives the **smaller** φ. The secondary
is not adopted.

### Periodic — A5, and it would have failed the replication bar anyway

BurstGPT spans **exactly 2 complete diurnal cycles** (48 hour-cells, 2 distinct day-of-week values)
against the pre-registered minimum of 3 for hour-of-day and 14 days for day-of-week. **A5 fires.**

Reported as non-qualifying descriptive evidence, per §5: the hour-of-day amplitude is 1.339, which
would clear the 0.05 amplitude bar comfortably — but the held-out split correlation is **0.371**,
below the 0.5 replication bar. So even setting A5 aside, the diurnal profile measured on the first
half does not predict the second. Day-of-week amplitude is 0.131 across the two days present.

## 2. The five signals with no source

- **`p99_latency`, `downstream_err` — A1, and absent by ingest record rather than by omission.**
  BurstGPT's README carries `burstgpt_no_p99_latency:elapsed_ms_field_absent_in_actual_csv` and
  `burstgpt_no_downstream_err:service_error_log_type_absent_in_actual_csv`. The fields do not exist
  in the source CSV. *To lift:* a trace carrying per-request latency and a service-error log.
- **`ttft`, `tool_success_rate` — A1.** No bundle in `runs/baselines/` carries either at any tick.
- **`eval_score` — A2, with A3 compounding it.** The only source is
  `real-huggingface-lmsys-arena-v1`, whose `eval_score` takes **exactly 2 distinct values, 0 and 1**
  — a binary pairwise arena outcome, `winner_model_a ? 1 : 0`
  (`tools/_ingest-real-trace-huggingface.ts:20`). The corpus's `eval_score` is a continuous quality
  benchmark on [0,1] with baseline 0.87 (`engine/scenarios/slow_burn.ts:38`). A Bernoulli
  win-indicator and a continuous quality score do not measure the same thing, so the arena data's
  dispersion is not this signal's jitter. A3 compounds it for the serial and periodic groups: that
  bundle has no real timestamps at all (`void tickSeconds`,
  `tools/_ingest-real-trace-huggingface.ts:158`), so its row order is not time order.
  *To lift:* a per-tick continuous eval score from a served model, logged alongside serving
  telemetry, with real timestamps.

**`runs/diagnostics/signal-distribution-*.csv` covers all six signals and is not a source** — it is
computed from `runs/baselines/synthetic-v1/bundle.jsonl`
(`tools/diagnostic/cross-signal-sigma-audit.js:18`). Fitting the corpus's noise model to it would be
circular. **`regression-profiles/*.yaml` is not a source either**: the five public-postmortem
profiles carry injection deltas, not healthy per-tick series.

## 3. Interpretation decisions, and two gaps in my own pre-registration

Per the house template, where a reading was genuinely free I took the one that makes the study
harder to pass. Both gaps below are places `PREREGISTRATION.md` under-specified; each is recorded
rather than silently resolved.

**3.1 — The four-way argmin was degenerate.** §4 M.3–4 lists four candidate families "including the
empirical quantile function" and says the recommendation is the argmin, with the empirical as the
fallback above KS 0.05. Those two sentences cannot both hold literally: the empirical CDF's KS
distance to its own sample is 0 by construction, so a four-way argmin always selects it and the 0.05
branch is unreachable. **Resolved as: argmin over the three parametric families; empirical is the
fallback.** This is the harder reading — it requires a parametric family to clear 0.05 on its own
merits, and none did.

**3.2 — No multi-source selection rule was pre-registered.** Two bundles carry `cost_req`. §5 defines
the bars per source but never says how to choose among sources. **Resolved as: a bundle that fails a
bar cannot supply the groups that bar kills; among bundles that pass, the primary is the one failing
fewest bars, ties broken by length** (`analysis/_source_selection.mjs`). Non-primary sources are
reported as cross-checks only.

**3.3 — The first run had a code defect, and this is what it was.** `run-20260805T231835Z` ranked
candidate sources by series length alone. `real-huggingface-lmsys-arena-v1` is longer (39,712 vs
34,202), so `cost_req` was fitted from it — and it fails A3. That run published φ = −0.0014, CI
[−0.0112, 0.0106], "AR(1) adequate", fitted on the row order of a shuffled Kaggle CSV. It is exactly
the failure A3 exists to prevent, and it would have read as a clean null result.

Fixed test-first per §7.3: `analysis/test_source_selection.mjs` was written first and failed on the
defective run (`cost_req sourced from real-huggingface-lmsys-arena-v1, which has no real
timestamps`), then `_source_selection.mjs` was extracted to make it pass. Six tests, all passing.
The superseded run is retained and its defect is named in the superseding run's manifest.

*The cross-check confirms how much the defect mattered:* LMSYS's `cost_req` marginal gives cv 1.022
and skewness 5.60 against BurstGPT's 0.760 and 2.95 — a different distribution, because it is a
per-request cost rather than a 5 s-bucketed mean.

## 4. Post-hoc — the empty-bucket artifact (no verdict attaches)

Not pre-registered. `analysis/posthoc_empty_buckets.mjs`, written after seeing the fit.

BurstGPT's ingest emits `cost_req = 0` for a 5 s bucket in which no request arrived
(`costs.length > 0 ? mean : 0`). **1,503 of 34,202 ticks (4.39%) are such structural zeros** — they
encode "no traffic", not "a request that cost nothing". `PREREGISTRATION.md` did not anticipate
this, and both the marginal scale and the ACF are affected by it.

Recomputed with idle ticks dropped:

| | as pre-registered | idle ticks dropped |
|---|---|---|
| `cv` | 0.7603 | 0.7125 |
| lag-1 ACF | 0.2485 | 0.2924 |
| lag-2 ACF | 0.2380 | 0.2781 |
| lag-8 ACF | 0.1551 | 0.1821 |
| AR(1) adequate? | **no** | **no** |

**The AR(1)-inadequacy verdict survives.** Dropping the zeros makes the serial dependence *stronger*,
not weaker, and the ACF still decays far too slowly. The slow decay is a property of real arrival
structure, not of the zero-fill. The primary result stands as pre-registered and as computed.

*What this study cannot quantify:* the bundle stores only the bucket mean, not the request count per
bucket, so I cannot separate how much of the measured dispersion is per-request cost variation from
how much is small-sample averaging over a variable number of arrivals. That is a limitation of the
stored artifact, not of the method, and it would be lifted by an ingest that also emits per-bucket
counts.

## 5. The artifact

`engine/scenarios/corpus-noise-model.json` — the derived model — and
`engine/scenarios/corpus-noise-model.ts`, a typed loader. Both are **additive**; the incumbent
constants in `engine/scenarios/slow_burn.ts:43-55` are untouched, so no study in flight changes
underneath its author.

The loader's design point is that it **refuses**:

```
samplerFor('p99_latency', 42)
  → Error: p99_latency.marginal is not sourced [A1]. no bundle in runs/baselines/ carries
    per-tick data for p99_latency. To lift this: a baseline bundle in runs/baselines/
    carrying per-tick p99_latency. Do not substitute a default.

assertSourced('cost_req', 'serial')
  → Error: cost_req.serial is not sourced [§4 S.3]. |rho2 − phi²| = 0.1761 > 0.05;
    AR(1) does not describe this series, so no phi is published.
```

`sourcedSignals()` returns `['cost_req']`. `samplerFor('cost_req', seed)` returns a seeded,
deterministic multiplicative sampler drawing from the measured empirical residual distribution. A
consumer that wants a default gets an exception instead, because a silent fallback is how invented
constants enter a study in the first place.

## 6. Which frozen studies become re-runnable — and which do not

**Not re-run here; C9 and C11 are out of scope per `PREREGISTRATION.md` §8.** What changes for them:

1. **Neither sweep's exclusion of `eval_score` and `tool_success_rate` lifts.** Both remain
   unsourceable (A2, A1). `studies/effect-size-sweep/REPORT.md` §3.1 and the drift sweep's inherited
   exclusion were correct, and are now correct on measured grounds rather than on absence of
   evidence. Their scope-limit lines should say so.
2. **No study becomes re-runnable at φ≠0 as an AR(1) process.** This is the substantive correction to
   C30. The one signal with real data has serial dependence AR(1) does not describe, so a corpus
   driven at AR(1) φ would still be inventing its serial model — merely with a number attached. The
   φ ≤ 0.95 envelope bound in `stats/power-per-cell-2026-08-05` is stated in AR(1) terms and remains
   an oracle-battery result; nothing here validates it against real telemetry, and nothing here
   contradicts it.
3. **A shape-robustness re-run of the effect-size sweep on `cost_req` alone is now possible** and was
   not before. The empirical residual distribution is sourced and shippable, so the sweep's Family A
   arms can be driven through real-shaped heavy-tailed noise (skew 2.95) instead of uniform, at
   matched δ. Because δ is in σ units, this isolates the *shape* effect from the scale.
4. **A serial-dependence study on `cost_req` is possible if it is constructed from the measured ACF
   or by block-bootstrapping the real residual series — not from an AR(1) φ.** Naming the
   construction matters: "the corpus now has φ ≠ 0" would be false.
5. **Seasonal and benign-regime studies remain impossible.** A5 blocks the only candidate, and no
   other repo source spans three days.

## 7. What I did not do

- **Did not re-run C9 or C11**, and did not change any detector, any scenario, or the incumbent
  jitter constants.
- **Did not ingest external data.** The derivation drew only on sources already in the repo, per
  §8. Every A1 verdict is therefore a statement about *this repo*, not about whether such data
  exists in the world — it plainly does, and §2 names what each one would need.
- **Did not fit `tokens_turn` or `kv_cache`**, which do have real data (Azure, Mooncake, LMSYS) but
  are not Family A signals and are not what the sweeps were blocked on.
- **Did not adopt the secondary (no cell centring) analysis**, which gives a larger φ̂ = 0.4478 and
  would have made the serial finding look stronger. The pre-registered primary stands.
- **Did not resolve** whether the measured `cost_req` dispersion is per-request cost variation or
  small-sample averaging over arrivals (§4) — the stored bundle cannot answer it.

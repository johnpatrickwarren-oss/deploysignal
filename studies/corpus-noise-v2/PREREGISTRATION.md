# Pre-registration — Corpus Noise Model v2

- **Study id:** 2026-08-corpus-noise-v2
- **Register:** `~/concord/knowledge/WORKLIST.md` C30.
- **Layer under test:** the **substrate**, not a detector. The object being derived is the
  healthy-baseline noise model that `runs/adversarial-scenarios.json` scenarios are driven through.
- **Pre-registered:** 2026-08-05
- **Template:** `studies/effect-size-sweep/PREREGISTRATION.md`; provenance rules (§7) transfer
  verbatim.

This file is committed **before any parameter is fitted**. The admissibility bars in §5 and the
method in §4 are frozen as of this commit. **A signal that no source can supply is a publishable
result**; the bars do not move afterwards to admit a source that failed them. §9 states the outcome
I expect *before* fitting, so that a surprise is visible as a surprise.

---

## 0. The defect this study addresses

The corpus models healthy telemetry as **iid multiplicative uniform jitter**:

```
v = mean × (1 + c·U[0,1])              engine/scenarios/slow_burn.ts:43–55
c = { p99_latency: 0.008, ttft: 0.008,
      cost_req: 0.006, downstream_err: 0.03 }   studies/effect-size-sweep/analysis/run_sweep.mjs:35
```

giving `cv = c/√12` ∈ {0.231%, 0.231%, 0.173%, 0.866%} — the "cv 0.17–0.87%" in the register. The
constants are invented; no derivation exists in the repo for any of them.

Three consequences, all measured, all on record:

1. **Two of six Family A signals have no corpus noise model at all.** `eval_score` and
   `tool_success_rate` were excluded from the effect-size sweep on exactly this ground
   (`studies/effect-size-sweep/REPORT.md` §3.1: "inventing one is exactly the fallback rule's
   prohibition — excluded"), and the drift sweep inherited the exclusion.
2. **φ = 0 by construction.** `stats/power-per-cell-2026-08-05` establishes that safe-t breaks
   between φ = 0.95 and φ = 0.99 and that UI's power decays smoothly to zero as φ → 1. Nothing on
   this corpus can reach that regime, because the corpus has no serial dependence to reach it with.
3. **No seasonal or benign-regime structure**, so a false-alarm number measured here is a
   false-alarm number against white noise.

## 1. What is being derived

For each of the **six Family A signals** — `p99_latency`, `ttft`, `eval_score`,
`tool_success_rate`, `downstream_err`, `cost_req` — one of exactly two outcomes:

- **SOURCED**: a parameter set with provenance naming the bundle, the tick count, the cells, and
  the ingest caveat filters it inherits; or
- **CANNOT-BE-SOURCED**: the admissibility criterion it failed (§5) and a statement of what data
  would be needed to lift it.

A parameter group may be sourced while another is not for the same signal (e.g. marginal sourced,
serial not). Each group carries its own verdict.

**Three parameter groups per signal:**

| Group | Parameters |
|---|---|
| **M** — marginal | distribution family, scale as `cv` |
| **S** — serial | AR(1) `φ`, plus the lag-2…5 ACF used to check AR(1) adequacy |
| **P** — periodic | hour-of-day multiplicative profile and its amplitude; day-of-week likewise |

## 2. Source inventory — structural facts, established before fitting

Everything in this section is a count or a schema fact, not a fitted quantity. It is recorded here
so the bars in §5 cannot be tuned to the answer after the fact.

The repo holds five baseline bundles in `runs/baselines/`, four of them real. Per-tick coverage,
counted from the bundles:

| bundle | ticks | (hour,day) cells | real timestamps? | signals with per-tick data |
|---|---|---|---|---|
| `real-burstgpt-v1` | 34,202 | 48 (= 48 h, 2 dow) | yes, 5 s bucketing | `cost_req` |
| `real-huggingface-lmsys-arena-v1` | 39,712 | 56 | **no** — `synthetic_timestamp_derivation:row_index_x_tick_seconds` | `eval_score`, `tokens_turn`, `cost_req` |
| `real-azure-llm-inference-v1` | 701 | 1 | yes, 5 s bucketing | `tokens_turn` |
| `real-mooncake-v1` | 708 | 1 (`mooncake_window:1hour_single`) | yes, 5 s bucketing | `kv_cache`, `tokens_turn` |
| `synthetic-v1` *(for contrast)* | 16,000 | 168 | n/a — generated | 15 |

Counts agree with `~/concord/knowledge/stats/family-c-reachability-2026-08-04`, measured
independently on 2026-08-04.

Facts that bear directly on the bars:

- **Cadence matches.** Every real ingest buckets at `tick_seconds = 5`
  (`tools/_ingest-real-trace-{azure,burstgpt,mooncake}.ts`), and the corpus tick is 5 s
  (`CHEAT-SHEET.md:143`, "6 ticks (~30s @ 5s cadence)"). No resampling is needed, and an AR(1) φ
  fitted on a real bundle transfers to a corpus tick without a cadence conversion. This is a
  precondition, and it holds.
- **LMSYS carries no clock.** `tools/_ingest-real-trace-huggingface.ts:153–158` maps row index to
  tick and then discards the cadence (`void tickSeconds;`, line 158). Its `hour_of_day` is
  manufactured from row order in a shuffled Kaggle CSV.
- **LMSYS `eval_score` is a binary pairwise arena outcome**, `winner_model_a==1 ? 1.0 : 0.0`
  (`tools/_ingest-real-trace-huggingface.ts:20–22`). The corpus's `eval_score` is a continuous
  quality benchmark on [0,1] with baseline 0.87 (`engine/scenarios/slow_burn.ts:38`).
- **BurstGPT `cost_req` is derived**: tokens × a per-model pricing overlay
  (`tools/_ingest-real-trace-burstgpt.ts:65`). Its variation is that of real 5 s-bucketed token
  volume under a constant price.
- **`p99_latency` and `downstream_err` are absent by ingest, not by omission.** BurstGPT's README
  records `burstgpt_no_p99_latency:elapsed_ms_field_absent_in_actual_csv` and
  `burstgpt_no_downstream_err:service_error_log_type_absent_in_actual_csv` — the fields do not
  exist in the source CSV.
- **`runs/diagnostics/signal-distribution-*.csv` is not a source.** It covers all six signals, but
  `tools/diagnostic/cross-signal-sigma-audit.js:18` reads
  `runs/baselines/synthetic-v1/bundle.jsonl`. Fitting the corpus's noise model to it would be
  circular.
- **`regression-profiles/*.yaml` is not a source for this study.** The five public-postmortem
  profiles carry *fault shapes* — injection deltas and offsets — not healthy per-tick series. They
  can source an effect, not a noise model.

## 3. Frame: the noise model is a **within-cell** model

The engine maintains trend buffers and calibrates per `(hour × day × workload × tenant × region)`
cell (`CHEAT-SHEET.md:17`). The jitter a detector sees is therefore what remains *inside* a cell
after cell-level structure is accounted for, and that is what the corpus constant `c` stands in for.

**Frozen primary analysis:** all M and S parameters are fitted to the within-cell residual
`r_t = v_t / m_{cell(t)}`, where `m_{cell}` is the mean of that `(hour_of_day, day_of_week)` cell.
Pairs crossing a cell boundary are excluded from the serial fit.

**Frozen secondary analysis:** the same parameters on the raw series with no cell centring,
reported alongside. Where the two disagree materially the difference is itself reported; the primary
is not swapped for the secondary.

Rationale, declared before seeing either number: cell centring removes low-frequency structure the
engine already handles, and leaving it in inflates both `cv` and `φ`. The primary is the reading
that gives the *smaller* φ, i.e. the one less favourable to the claim that the corpus needs a
serial-dependence upgrade. That is the harder test of this study's own premise.

## 4. Method (frozen)

Deterministic throughout. Seeded `mulberry32(42)` where randomness is needed; no `Math.random`, no
`Date`.

**M — marginal.**
1. Compute `r_t` per §3. `cv = sd(r)` (pooled over cells; `mean(r) = 1` by construction).
2. Standardise: `z = (r − 1)/cv`.
3. Fit four candidate families to `z` by method of moments on the pooled residual: **uniform** (the
   incumbent), **lognormal**, **gamma**, and the **empirical quantile function**.
4. Report the Kolmogorov–Smirnov distance of each. **The recommended family is the argmin.** If the
   argmin's KS distance exceeds **0.05**, the artifact ships the empirical quantile function
   instead of a parametric family.
   *This is a fixed effect-size bar, not a significance test.* At n ≈ 34,000 every parametric family
   will be rejected by a KS **test**; that fact carries no information and no p-value is computed.

**S — serial.**
1. `φ̂` = OLS slope of `(r_t − 1)` on `(r_{t−1} − 1)` through the origin, over within-cell pairs only.
2. 95% CI by **moving-block bootstrap**: block length 100, 1,000 resamples, `mulberry32(42)`.
   **φ is declared non-zero iff the CI excludes 0.**
3. **AR(1) adequacy check, frozen:** compute the sample ACF at lags 2–5. If `|ρ̂₂ − φ̂²| > 0.05`,
   AR(1) is declared **inadequate** for that signal; the artifact then ships the measured ACF and
   the report says AR(1) does not describe this series. A φ is not published from a series AR(1)
   does not fit.

**P — periodic.**
1. Hour-of-day profile = the 24 cell means divided by the grand mean; likewise day-of-week.
2. Amplitude `A = (max − min)/mean` of the profile.
3. **Declared present iff `A ≥ 0.05` AND** the profile fitted on the first half of the series
   correlates with the second-half profile at Pearson `ρ ≥ 0.5` (a held-out replication, not a fit
   statistic).

## 5. Admissibility bars → what CANNOT-BE-SOURCED means (frozen)

A signal's parameter group is **CANNOT-BE-SOURCED** if any listed criterion fires. The report names
the criterion code.

| Code | Criterion | Groups it kills |
|---|---|---|
| **A1** | No bundle in `runs/baselines/` carries per-tick data for the signal. | M, S, P |
| **A2** | **Construct mismatch** — the trace's quantity and the corpus's signal do not measure the same thing, judged against the corpus baseline's units and range and the ingest mapper's definition. | M, S, P |
| **A3** | **No real timestamps** — the ingest applies a synthetic-timestamp derivation. | S, P (M may still pass) |
| **A4** | **Too short** — fewer than **2,000** within-cell-usable ticks (φ̂ SE ≈ n^(−1/2); 2,000 gives ≈ 0.022). | S |
| **A5** | **Too few cycles** — fewer than **3** complete diurnal cycles kills hour-of-day; fewer than **14** days kills day-of-week. Two cycles cannot separate a diurnal profile from a single event or a slow trend. | P |
| **A6** | **Derived, not measured** — the signal is a deterministic transform of another measured quantity. **This does not kill the group.** It is a mandatory disclosure: the parameters are sourced for the underlying quantity under the named transform, and the report says so at every use. | — |

A CANNOT-BE-SOURCED entry is not a gap to be filled by judgement later. The artifact carries no
parameters for it, and any study needing that signal must either bring data or declare the signal
out of scope, exactly as the two sweeps did.

## 6. The artifact (specified before it is built)

`engine/scenarios/corpus-noise-model.json` — the derived model, consumable without re-deriving —
and `engine/scenarios/corpus-noise-model.ts`, a typed loader exposing a **seeded sampler** per
sourced signal and **throwing** on a signal marked `cannot_be_sourced`. Throwing is deliberate: a
consumer that reaches for an unsourced signal must fail loudly rather than fall back to a default.

Per-signal record, frozen shape:

```
{ signal, marginal: {status, family, cv, ks_distances, ...} | {status:"cannot_be_sourced", criterion, what_would_be_needed},
  serial:   {status, phi, ci, acf_lags_2_5, ar1_adequate} | {status:"cannot_be_sourced", ...},
  periodic: {status, hour_of_day, day_of_week, amplitude} | {status:"cannot_be_sourced", ...},
  provenance: {bundle, ticks, cells, caveat_filters_applied, derived_from} }
```

The incumbent constants stay in `slow_burn.ts` untouched by this study; the artifact is additive.
Retiring them is a consumer-side decision for whichever sweep adopts the artifact first, not a
change this study makes to code under other studies' feet.

## 7. Provenance rules (verbatim from the effect-size-sweep template)

1. This file is committed **before any run**.
2. Every run writes an append-only `results/run-<UTC>/manifest.json`: repo SHA, bundle SHA-256s,
   seeds, command, versions. No result is ever overwritten.
3. A rerun is permitted **only** for a code defect, fixed test-first, with the superseding run's
   manifest naming the defect; the prior run remains.
4. The report states every signal's verdict per parameter group, including CANNOT-BE-SOURCED.
5. Report numbers are **machine-checked against the run JSON** by
   `analysis/check_report.mjs`. One report path only.

## 8. Scope

**Out of scope, deliberately:**

- **Re-running C9 (effect-size sweep) or C11 (drift-regime sweep).** Both are frozen results. The
  report states which of their exclusions and scope limits the artifact lifts, and stops there.
- **Changing any detector.** This is a substrate study.
- **Ingesting new external data.** The derivation may draw only on sources already in the repo.
  Where that yields CANNOT-BE-SOURCED, that is the finding, and the fix is an ingestion brief, not
  a fitted guess.
- **`tokens_turn` and `kv_cache`.** Real data exists for both, but neither is a Family A signal and
  neither is what the sweeps were blocked on. Noted where they corroborate; no parameters shipped.

## 9. Predicted outcome, stated before fitting

From §2's structural facts alone, and recorded so a departure is visible:

| Signal | M | S | P |
|---|---|---|---|
| `cost_req` | sourced (BurstGPT, A6 disclosure) | sourced | **A5** — 2 diurnal cycles, not 3 |
| `eval_score` | **A2** — binary arena outcome vs continuous benchmark | **A2 + A3** | **A2 + A3** |
| `p99_latency` | **A1** | **A1** | **A1** |
| `ttft` | **A1** | **A1** | **A1** |
| `downstream_err` | **A1** | **A1** | **A1** |
| `tool_success_rate` | **A1** | **A1** | **A1** |

If this is what the fit returns, the honest headline is that **the corpus's noise model can be
sourced for one signal of six**, and that C30's premise — that the covered four are fine and the
uncovered two are the gap — is close to inverted: three of the four signals both sweeps *did* use
have no real source in this repo either.

Two things could falsify the prediction and would be reported as such: `cost_req` failing the AR(1)
adequacy check (§4 S.3), which would mean no φ is publishable even where data exists; or the
LMSYS `eval_score` marginal surviving A2 on a defensible reading, which would source one more
signal's M group.

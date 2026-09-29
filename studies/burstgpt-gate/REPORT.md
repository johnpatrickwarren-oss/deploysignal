# Report — the Family-A gate on BurstGPT v2 cost per request (`2026-09-burstgpt-gate`, T3)

- **Study id:** `2026-09-burstgpt-gate`. Register: knowledge `WORKLIST.md` C85 part 2.
- **Run:** `results/run-20260929T015953Z/`, the registered command
  `node studies/burstgpt-gate/harness/run.mjs --mode full` at harness commit `f521698` (branch
  `wt/burstgpt-gate`, no tracked changes), engine pin `v0.12.2-pre`, installed 0.12.2-pre, resolved
  `0434afcd…`; Node v25.9.0. Bundle sha256 `1b7b8ec46bbd…` equal to the registered value.
  **Exceptions: 0.** Compile succeeded through `generic-microservice@1.0.0` with no override:
  `family_a_signals` `p99_latency, downstream_err, cost_req`, Bonferroni factor 3, 120 cells of
  which 42 carry Family A parameters, `cost_req` compiled as `heavy_tail` with raw mean 0.0339, σ²
  3.98×10⁻⁴, φ 0.098, no σ floor, threshold kind `ville`. The §5 smoke passed (a ×3 cost injection on
  window 0 fired on `cost_req` at tick 2; `family_A_shadow` was non-empty on every present tick of
  every window, `shadow_empty_present_total` 0).
- **Endpoints, bars and predictions** were frozen in `PREREGISTRATION.md` (commit `43c11a2`,
  before any harness code). Verdicts below are recorded **as computed**; no bar was moved.
- **Executable:** yes. 14,519 study ticks at 60 s, 4,970 missing (0.342); calibration ticks
  `[0, 5760)`, 3,522 present in 561 contiguous runs; 87 null windows of 100 ticks, none voided.

## 0. The headline

**E1: FAIL.** Over 87 consecutive 100-tick windows after the four-day calibration, the Family-A
gate on `cost_req` rolled back **13/87** (rate **0.1494**, one-sided 95% upper bound **0.2270**,
**2.49 per 1,000** present ticks over 5,230). The registered bar is 0.05. Registered prediction P1
put the rate at 0.25 or more; the verdict it predicted held, its point figure did not.

**The fires follow the traffic.** Windows over days 4 to 8 (sparse traffic, 58 windows) rolled back
**5/58** (0.0862); windows over days 9 and 10 (five to six times the request rate, 29 windows)
rolled back **8/29** (0.2759), and six of the last seven windows of the trace, where no tick is
missing, fired at ticks 29, 2, 1, 2, 15 and 66. Fired windows had a missing share of **0.061**
against **0.341** for unfired windows. The median fire tick is 33.

## 1. Endpoints

| Endpoint | Value | Bar | Verdict |
|---|---|---|---|
| E1 false-rollback rate, 87 windows | 13/87 = 0.1494 (upper 0.2270; 2.49 per 1,000 present ticks) | ≤ 0.05 | **E1: FAIL** |
| E1 split (report) | days 4–8: 5/58 = 0.0862; days 9–10: 8/29 = 0.2759 | — | reported |
| E2 instrument | hash ok, compile ok, exceptions 0 | | **E2: PASS** |

## 2. Predictions

- **P1 half held.** E1 fails; the point figure "at least 0.25" is not reached (0.1494).
- **P2 held.** The `days_9_to_10` rate (0.2759) exceeds the `days_4_to_8` rate (0.0862).
- **P3 held.** E2 passes.

## 3. What this establishes, and what it does not

*Observation.* At the pin, the shipped generic profile compiled from four days of a real request
stream's cost per request, at 1/α with α_total = 10⁻³ split three ways, rolls back one 100-tick
canary in seven on the following six days, and one in four once the traffic regime changes.

*Inference.* The regime-change fires are consistent with the wiki's measurement that 69% of this
series' tick-level variance is small-sample averaging (`stats/burstgpt-real-axis-2026-08-18`): the
calibration's σ² is dominated by sparse ticks, and dense ticks carry a different distribution of
the per-tick mean, so a benign traffic increase reads as a shift. The sparse-day fires (5/58) are
the plug-in path's own rate on this heavy-tailed series (cv 0.76, AR(1) inadequate). Neither
inference was tested here.

**Not established.** Anything multivariate; the twin path, PROCEED semantics, deploys; whether
weighting the calibration by requests, a request-count floor per tick, a longer calibration or the
bootstrap thresholds (not stamped without Family D) change the rate; anything about `p99_latency` or
`downstream_err`, absent from this bundle.

## 4. Not measured

Any signal but `cost_req`; the 5-second tick; imputation of empty ticks; Families B–E; the
bootstrap thresholds; windows other than 100 ticks; α other than 10⁻³; the estimation-robust
constructions; the unknown clock phase.

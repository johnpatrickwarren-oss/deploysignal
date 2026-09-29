# Pre-registration — the Family-A gate on BurstGPT v2 cost per request (`2026-09-burstgpt-gate`, tier T3)

- **Study id:** `2026-09-burstgpt-gate`
- **What it serves:** C85 part 2 (knowledge `WORKLIST.md`): the second of the three real-data runs
  John ordered on 2026-09-28. Part 1 ([[stats/gwdg-gate-2026-09-29]]) measured the temporal path on
  multivariate GPU telemetry. This part measures it on the one request-log signal the repo can
  source from a real trace, `cost_req` from BurstGPT (Zenodo-free, GitHub `HPMLL/BurstGPT`),
  through the shipped `generic-microservice` profile with no study-specific profile at all.
- **Tier:** T3 (real telemetry). Not deploy-shaped: one aggregate series, no version change, no
  canary, no control. A result bears on the calibration compiler and Family A on a real
  heavy-tailed, serially dependent, sparse request stream.
- **Repo:** deploysignal `main` `d57c681` (after PR #127; branch `wt/burstgpt-gate`, worktree). **Engine:**
  `@johnpatrickwarren-oss/deploysignal-engine` v0.12.2-pre, resolved
  `0434afcdc7a4716788dc81427295c6c4cd14e019`. Node v25.9.0, darwin.
- **Status: REGISTERED, NOT RUN.** A later change is an amendment, appended and dated, before the run.

## 0. Disclosures

- (a) Seen before registration, none a study result: the bundle's README and manifest; the
  substrate facts in §1 (tick counts, missing shares per day, the count of 100-tick windows),
  computed from `bundle.jsonl` by a census that never ran a detector; the two wiki pages on this
  bundle ([[stats/burstgpt-v2-2026-08-18]], [[stats/burstgpt-real-axis-2026-08-18]]: cost per
  request has cv 0.76, lag-1 ACF 0.30 with a near-flat decay through lag 8, AR(1) inadequate, and
  69% of the tick-level variance is small-sample averaging).
- (b) The bundle's clock is elapsed seconds from the trace start with no wall anchor
  (`caveat_filters_applied`), so `hour_of_day` is real modulo an unknown phase. The compiler's
  hour cells therefore group ticks by a consistent but unlabelled hour. Disclosed; no change.
- (c) 80.4% of the bundle's 5-second ticks carry no requests. A tick with no requests is not an
  observation of cost per request; the harness treats it as missing (absent from `liveMetrics`),
  the gate's shipped behaviour on an absent signal, and never as a zero. Nothing is imputed.
- (d) Days 9 and 10 of the trace (of 10.08) carry five to six times the request rate of days 0–8
  (populated 5-second ticks 0.54 and 0.99 against 0.09–0.22). That is a workload change inside the
  null stretch, not a fault; the primary endpoint includes those windows (the reading that makes
  the bar harder to clear) and the split is reported beside it.
- (e) `cost_req` is one of the engine's six default signals, so its Family A fires carry rollback
  authority by grandfathering (`FAMILY_A_ROLLBACK_AUTHORITY`); its signal class is `heavy_tail`
  (log transform at compile and run time). No bootstrap thresholds are stamped (the profile has
  Family D off; [[stats/gwdg-gate-2026-09-29]] finding 2), so the detectors run at Ville's 1/α.
- (f) The `generic-microservice` profile names `p99_latency` and `downstream_err` too; the bundle
  carries neither, the compiler drops absent signals (`filterPresentFamilyASignals`) and the
  Bonferroni factor stays at the profile's three, which is conservative for the one signal that
  runs. Recorded from the compiled config; no override.
- (g) Determinism as in part 1: fixed compiler seeds, no RNG in the harness, no wall clock in a
  tracked artifact.

## 1. Substrate

`runs/baselines/real-burstgpt-v2/bundle.jsonl` (tracked; sha256
`1b7b8ec46bbdac4edf4590c885950801d6236826f6ead406c59d3bc8b2241d90`, asserted by the harness before
any window runs) with its `manifest.json`: 174,234 five-second ticks (10.08 days),
one tenant, `cost_req` and the auxiliary `requests_per_tick`.

**Study tick: 60 s** (12 bundle ticks). Per study tick, `cost_req` = Σ(cost × requests) / Σ
requests over the bundle ticks with requests > 0; **missing** when the sum of requests is 0.
`hour_of_day` = the bundle's value at the first sub-tick. Census, from the bundle: 14,519 study
ticks, 4,970 missing (0.342); per-day missing share 0.35, 0.35, 0.36, 0.49, 0.41, 0.31, 0.32,
0.37, 0.27, 0.23, 0.00.

## 2. Windows

- **Calibration:** study ticks `[0, 5760)` (four days), 3,522 present. Bundle runs are the maximal
  contiguous present stretches; `cell_dim: 'hour_of_day'`; compiled with
  `node tools/calibrate.js --baseline <dir> --alpha 1e-3 --families A --profile_ref generic-microservice@1.0.0 --out <cfg>`.
- **Null windows:** consecutive, non-overlapping 100-tick windows from tick 5,760:
  `W_k = [5760 + 100k, 5860 + 100k)`, `k = 0 … 86` (87 windows; the trailing 59 ticks are unused).
  A window is scored whatever its missing share; the share is recorded. `k ≤ 57` ends before day
  9 (`days_4_to_8`, 58 windows); `k ≥ 58` is `days_9_to_10` (29 windows).
- **Gate per window:** a fresh `TrendBuffer(10)` and fresh detector state; `orchestrate` once per
  present tick with `fusionTopology: 'portfolio'`, `totalTicks: 100`, `hoursElapsed = t / 60`,
  `currentHourOfDay` from the tick, the part-1 scenario (risk medium, change type `config`, flags
  false, baseline = the aggregate cell mean). Missing ticks are passed with no `cost_req` (the tick
  still counts toward `totalTicks`). Outcome: `rollback` at the first rollback tick, else
  `proceed` at tick 99.

## 3. Endpoints

- **E1 — false-rollback rate over the 87 windows.** PASS iff rollbacks / 87 ≤ 0.05. Reported: the
  one-sided 95% Clopper–Pearson upper bound, the rate per 1,000 present ticks, the rate in each of
  the two day groups, the median fire tick, and the missing share of the fired and unfired windows.
- **E2 — instrument:** bundle hash verified, compile succeeded, zero harness exceptions.

## 4. Predictions

- P1: E1 FAILS: at least 0.25 of windows roll back. The wiki's measurements of this series (cv
  0.76, flat ACF, AR(1) inadequate) are the plug-in path's failure conditions.
- P2: the `days_9_to_10` rate is at least the `days_4_to_8` rate (the workload change).
- P3: E2 holds.

## 5. Instrument checks and NOT-EXECUTABLE conditions

Smoke before the run, not scored: (i) the compiled config carries `cost_req` parameters
(finite mean, σ², φ) and no other Family A signal; (ii) window `k = 0` with every present cost
multiplied by 3 from its first tick ends `rollback` on `cost_req`; (iii) the same window
unmodified runs the detectors on every present tick (`family_A_shadow` non-empty).

- Bundle hash mismatch, compile failure, or fewer than 60 scorable windows: **NOT EXECUTABLE**.
- A harness exception in a window voids it and is counted; more than 5% voided: **NOT
  EXECUTABLE**. A void run is preserved with its computed numbers.

## 6. What this can and cannot show

No authority moves. A PASS is the first real request-stream null result for the temporal path
at this pin on a single signal. A FAIL refutes the shipped path's false-rollback claim on a real,
sparse, heavy-tailed request stream at 100-tick canaries. Nothing here bears on multivariate
detection, the twin path, PROCEED semantics or deploys.

## 7. Not measured

Any signal but `cost_req`; the 5-second tick; imputation of empty ticks; Families B–E; the
bootstrap thresholds; windows longer or shorter than 100 ticks; α other than 10⁻³; the
estimation-robust constructions; the unknown clock phase.

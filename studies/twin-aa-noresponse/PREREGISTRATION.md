# Pre-registration — the twin gate's real-service A/A with the unanswered-requests metric declared, at one task per arm (`2026-10-twin-aa-noresponse`, T3)

- **Study id:** `2026-10-twin-aa-noresponse`
- **Status: REGISTERED, NOT RUN.** Written 2026-10-20 before any harness, template, service or
  infrastructure change for this study. A later change is a dated amendment, appended, before the
  run it affects.
- **What it serves:** ADR 0001 D1 item 6 (`decisions/0001-twin-rollback-authority.md`). An eligible
  session must declare a `rate` metric counting requests the target never answered, and "that
  metric needs an A/A with it declared before a service's qualification counts it (none has run)".
  The fault study measured its power (`AB-reset-nr`, 20 of 20 at tick 12,
  `studies/twin-fault-shapes/REPORT.md`) and said in its Amendment 2: "no A/A has run with
  `no_response` declared … an argument, not a measurement".
- **Inherits, by reference and unchanged:** `studies/twin-aa-onebox/PREREGISTRATION.md` with its
  Amendments 1–3, and through it the second and first real-service A/As: the service at a p99 of
  about 76 ms (seeded lognormal delay, median 30 ms, σ 0.4), the 0.5% 503 fraction in every arm and
  prod, `p99_latency` as a `sign` metric with `margin: { relative: 0.10 }`, `http_5xx` as a `rate`
  metric, the three-target-group topology at equal arm weights, one task per arm with each arm
  pinned to a subnet (lanes 0–1 same AZ, lanes 2–3 across AZs), 60 s ticks, W = 15, T = 60, the
  scored and W0 sessions, global run indices, void rules V1–V8 and V10, Amendment 3's V6/V7
  attribution, NOT-EXECUTABLE and abort, records, the observe-only runner. The `no_response`
  construction is the fault study's Amendment 2, unchanged. Only what this document states differs.

## 0. Disclosures

- (a) Known at registration: every earlier twin study's result, including the onebox A/A (O1, O2
  PASS, 0 of 100 each at one task per arm) and the fault study's readout of unanswered requests
  per tick: **6.08 on the canary and 0.00 on the control** in `AB-reset-nr` (four tasks per arm, no
  resets on the control).
- (b) That readout is why this design injects resets in both arms. An A/A on the service as it
  stands would give the metric no events in either arm, and the `rate` kind takes no step on a tick
  with no events. Such a study would show that a silent metric stays silent. The 5xx metric's null
  was measured on a base rate of 0.5% in every arm for the same reason; this study gives
  `no_response` the matching base rate of unanswered requests.
- (c) A real service's unanswered requests come from many sources (task restarts, idle-timeout
  races, client resets, CloudWatch publication offsets between `RequestCount` and the status-class
  sums). This study injects one source, server-side socket resets at a fixed fraction, identical in
  both arms. Publication offsets are present as they are on any ALB lane; the other sources are not
  represented.
- (d) The operator is the author; `TWIN_ARM_AUTHORITY` stays `advisory`.

## 1. What changes

### 1.1 Resets in every arm (the null's base rate)

`RESET_FRACTION` = **0.005** in both arms and in prod: the service destroys the socket without a
reply on that deterministic fraction of requests (`studies/twin-aa-real/infra/service/server.mjs`,
the `AB-reset` mechanism). The lane template gains a parameter `ResetFraction` (default `"0"`, so
every earlier lane configuration is unchanged) that sets `RESET_FRACTION` in the shared task
definition, the way `Fault503Fraction` sets the 503 fraction. Every canary override stays empty:
both arms and prod run one task-definition revision (R5). At about 1,220 requests per arm per tick
this is about 6 unanswered requests per arm per tick, the canary's rate in `AB-reset-nr`.

### 1.2 The metric table

| twin metric | kind | worse | tolerance | margin |
|---|---|---|---|---|
| `http_5xx` | rate | higher | 0.2 | — |
| `p99_latency` | sign | higher | 0.15 | relative 0.10 |
| `no_response` | rate | higher | 0.2 | — |

`no_response` events = `RequestCount` − (`HTTPCode_Target_2XX_Count` + `3XX` + `4XX` + `5XX`) per
arm, Sum over the window, clamped to [0, total]; total = `RequestCount`; the three extra sums from
one further `GetMetricData` call per window with the registered retries, a window whose extra fetch
fails on all attempts being a fetch failure (V3). With three metrics the per-metric rollback
threshold is 3/α = 60 (Bonferroni).

### 1.3 Size

One cell, `AA-nr`. 25 runs per lane, four lanes: **100 executable runs**. A/A bar at R = 100 as in
every earlier A/A: B = 0.05 + 2.58 · √(0.05 · 0.95 / 100) = **0.1062**, at most **10 of 100**. The
cell stops early, with N1 failed, at 11 executable rollbacks. 150 attempts cap.

Placement strata are not endpoints here: the onebox study measured both (0 of 100 each) and ADR 0001
item 7 makes placement no condition. The lanes keep their deployed placements, and per-stratum
counts are reported without a verdict.

What R = 100 resolves: the chance the count exceeds 10 is 0.011 at a true rate of 0.05, 0.417 at
0.10, 0.901 at 0.15. The one-sided 95% upper bound after 0, 2 and 5 rollbacks is 0.030, 0.062 and
0.102.

## 2. Endpoints

- **N1.** False-rollback count (scored session, any metric) ≤ 10 of 100 executable.
- **N2.** Sample-ratio halts in at most 2 attempted runs.
- **N3 (sensitivity).** Rollbacks among executable runs plus rollbacks reached in void runs: at
  most 10.
- **N4 (the base rate was delivered).** The median over executable runs of the per-run mean
  unanswered requests per scored tick lies in [3, 12] **in each arm**. If N4 fails, the study is
  **NOT EXECUTABLE** for its purpose: N1 is reported but does not measure the metric under a base
  rate. N4 is a check on the instrument, not on the gate.

Report-only: rollbacks by detector; unanswered requests per tick per arm (distribution over runs);
the share of scored ticks on which `no_response` had zero events in both arms; the largest
`no_response` rollback e-value per run; ticks on which the control arm's count exceeds the
canary's by more than 10 (publication offsets); per-stratum counts; the W0 session; and a replay of
every run's stored scored ticks through the gate **without** `no_response` (two metrics, threshold
40), committed before run 0, to show what declaring the third metric costs.

## 3. Predictions (registered)

- **R1.** N1 holds with 0 to 3 rollbacks; confidence moderate. The `rate` kind's null on target 5xx
  has held in 344 real runs at a matching base rate; resets at the same rate on identical arms
  should behave the same. The risk I can name is publication offsets: a request counted in one
  minute's `RequestCount` and answered in the next minute's status sums leaves an apparent
  unanswered request in one window and a negative (clamped to 0) count in the next. The clamp
  makes such offsets one-sided. They are symmetric between arms in expectation, but the clamp
  turns them into extra events, and at one task per arm I do not know their size.
- **R2.** `twin_rate_no_response` fires in at most 2 of the 100 runs.
- **R3.** N4 holds: about 6 unanswered requests per arm per tick (between 5 and 8 in each arm).
- **R4.** N2 holds with 0 halts.
- **R5.** The two-metric replay gives 0 or 1 rollbacks.

## 4. What each outcome would mean (for ADR 0001 D1 item 6)

- N1 and N4 hold: the `no_response` construction has a measured A/A at one task per arm, under a
  base rate of one injected source, and a service's D2 qualification may count it.
- N1 fails with rollbacks on `no_response`: the construction is not eligible as registered.
  Publication offsets (§3 R1) are the first candidate; the report says whether the offset readout
  supports that, and nothing is changed by hand.
- N4 fails: the instrument did not deliver the base rate; N1 is reported, not cited.

## 5. Void, NOT-EXECUTABLE, abort

As inherited (V1–V8, V10), plus the extra fetch's failure as V3 (§1.2) and N4's NOT-EXECUTABLE
condition (§2). The template change in §1.1 is deployed by a stack update per lane before run 0
and recorded; a run whose task-definition revision differs from the recorded one is void (V9, as in
the fault study).

## 6. Pins (to be completed by a dated amendment before run 0)

Engine `v0.13.0-pre` `de25786…`, unchanged from every real-service study; the tree hashes of the
runner, analysis, gate service, sources, `engine/gates`, `engine/guarantees.ts`, service source and
lane template; the image digest (`old-v3-20261001` unless the amendment says otherwise; the image
already implements `RESET_FRACTION`); the lane parameters; the lane configs. The runner is the
onebox study's with the study id, the cell id and the fault study's `no_response` fetch and
metric; the analysis and the two-metric replay are committed before run 0.

## 7. Ship rule

None of its own; it moves no authority. N1 with N4 sets whether ADR 0001 D1 item 6's metric has
the A/A the item requires.

## 8. Not measured

Unanswered requests from sources other than server-side resets (§0 (c)); a quiet service (no base
rate), where the metric takes no step; four or more tasks per arm with this metric; a fast service;
power at one task per arm; regions; the proceed side; the product's own CloudWatch source, which
does not yet compute `no_response` (the study's runner does, as the fault study's did).

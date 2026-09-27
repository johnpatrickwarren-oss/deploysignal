# Pre-registration — local A/A of the twin gate (`2026-09-twin-aa-local`, Plan D tier T2)

- **Study id:** `2026-09-twin-aa-local`
- **What it serves:** engine ADR 0036's premise ("randomized routing, no arm-level effect on any
  tick") exercised end to end through DeploySignal's gate service in `mode: "twin"`, against two
  real OS processes of one service file behind a real HTTP router. It is the first run of the
  twin path on anything other than the synthetic generator of engine study `2026-09-twin-null`.
- **Tier:** T2 (local processes on one machine). It is NOT the real-service A/A test (T3) that
  DORMANCY.md's activation mechanism names. Nothing here changes `TWIN_ARM_AUTHORITY`, which stays
  `'advisory'`, and no result of this study may be cited as real-service validity.
- **Repo:** deploysignal at `5f0075b` (branch `wt/twin-aa-local`). **Engine:**
  `@johnpatrickwarren-oss/deploysignal-engine` v0.12.0-pre, resolved `10c96910cc9f293c2b02bdfdb707f883d9cefb77`
  (package-lock.json). Node v25.9.0, darwin, 10 cores. No Docker.
- **Status: REGISTERED, NOT RUN.** A later change is an amendment, appended and dated, before the run.

## 0. Disclosures

- (a) A prior agent drafted a Docker-based design for this test. It ran nothing, and no result of
  any kind has been seen from it. This registration does not use that draft.
- (b) The 5xx draw is independent per request inside each process (§1). The rate A/A cells
  therefore test the pipeline (routing, counting, aggregation, the HTTP contract, the sample-ratio
  guard), not a real arm-level mechanism. The one path by which real process behaviour can reach
  the rate metric is an upstream error or timeout at the router, counted as a 5xx (§1). Latency is
  the only metric that picks up real per-process noise: scheduling, garbage collection, timer
  coalescing, socket and event-loop contention.
- (c) Seen before registration, none of it a study result:
  1. A throughput check in the session scratchpad (a trivial two-hop `node:http` chain: one
     router, two services, 64 concurrent keep-alive clients, no gate, no statistic): about 25k
     requests/s. Used only to size §3.
  2. A synthetic prediction run in the scratchpad that calls the pinned engine's
     `per-shard/twin-gate.js` directly with the §1 generator's distributions (in-process draws,
     no processes, router or gate service). Its numbers are the point predictions in §5. The script
     is committed unchanged with the harness as `analysis/predict_sim.cjs`.
  3. A smoke check of the gate service's twin API (one create, one tick, one replayed tick, one
     refused `canary_weight: 0.1` create without the opt-in), to confirm the contract shape.
- (d) One machine, four node processes plus the gate. The two service processes share the CPU,
  the kernel and the router; they differ in PID, port, V8 heap, event loop and seed. Persistent
  arm-level state that needs separate hosts, AZs, pods, cold fleets or different traffic paths
  cannot occur here. A pass at T2 says nothing about those.
- (e) Latency measurements come from the wall clock of real processes and are not reproducible bit
  for bit. Routing, 5xx outcomes and drawn latencies are reproducible from the seeds (§1).

## 1. System under test

One source file, `harness/service.mjs`, launched as two OS processes from the same file with the
same code: control on one port, canary on another. Each process takes `--seed` and, for the canary
in A/B cells only, `--fault-5xx-mult` or `--fault-latency-mult` (default 1).

- Per request the service reads `(run, tick, idx)` from headers the router forwards and draws from
  its own counter-based generator keyed on `(seed, run, tick, idx)` (a 32-bit integer mixing hash,
  so every draw is a pure function of the key):
  - 5xx: status 503 with probability `p · fault_5xx_mult`, p = 0.02; otherwise 200.
  - latency: `L = 8 ms · exp(0.5 Z) · fault_latency_mult`, Z standard normal (Box–Muller from two
    keyed uniforms). The process waits `max(1, round(L))` ms with `setTimeout`, then responds. The
    5xx and latency draws are independent.
- **Router** (`harness/router.mjs`, one process): for each request it computes
  `u = H(router_seed, run, tick, idx)` and sends the request to the canary if `u < w`, else to the
  control. The assignment is a function of the key only, fixed before any outcome exists. It
  forwards over localhost HTTP (keep-alive agent), measures upstream latency with
  `process.hrtime.bigint()` from forward to the end of the upstream response, and aggregates per
  `(run, tick, arm)`: request count, 5xx count, upstream-error count, and the latencies. Upstream
  error or a 2000 ms timeout counts as a 5xx (status 502/504) and in `upstream_errors`. p99 is the
  nearest-rank value `sorted[ceil(0.99 n) − 1]`; an arm with no requests in a tick has p99 `null`.
- **Load generator + gate client** (`harness/run.mjs`, one process): count-based ticks of
  n = 500 requests, 128 in flight, ticks strictly sequential (every request of tick t completes
  before tick t + 1 starts). After each tick it reads the router's aggregate and posts one tick to
  the gate.
- **Gate:** the worktree's build, `node service/gate-http/server.js`, one process for the whole
  run, store directory outside the repo. Per run: `POST /v1/sessions` with `mode: "twin"` and the
  cell's `twin_arm`, `deploy_ref` `aa-<cell>-r<run>`; per tick `POST /v1/sessions/{id}/ticks` with
  `canary_requests`, `control_requests`, the rate observation `http_5xx` (events and totals per
  arm) and, where declared, the sign observation `p99_latency_ms`, and `emitted_at_ts`
  `1.8e9 + 1e6·cell + 1e3·run + tick` (deterministic, the idempotency key).
- Warm-up: after each cell's processes start, 2000 requests at the cell's w go through the router
  with `run = −1`. They are not sent to the gate and not scored.
- Processes: the router and both services are started fresh per cell and stopped at the cell's end.
  The gate runs once. The harness stops every process it started on exit, error included.

### Gate configuration

All cells: `alpha_rollback` 0.05, `alpha_srm` 0.001, `max_ticks` T = 100, `http_5xx` rate metric
(`worse: higher`, tolerance 0.2), `p99_latency_ms` sign metric (`worse: higher`, tolerance 0.15)
where the cell declares it.

`alpha_proceed` is registered at **1e-12** in every cell, so the proceed test cannot end a run
within T and the rollback e-process is observed over the full horizon, as in the T1 study. A gate
at a usable `alpha_proceed` stops at the first proceed, so its rollback event is a subset of the
full-horizon event: the full-horizon false-rollback rate bounds the deployed gate's from above.
This is the harder reading. The deployed-configuration verdict at `alpha_proceed` 0.05 is
recovered exactly from the same tick responses (the engine's bet size λ does not depend on α,
`detectors/_paired-bet.js`): the first tick at which `srm_e ≥ 1000` (invalid), else any
`rollback_e ≥ rollback_threshold` (rollback), else every `proceed_e ≥ 20` (proceed). It is
reported, with no bar.

## 2. Measured quantities

Per run: the terminal verdict and tick (`rollback`, `invalid_experiment`, or `inconclusive` at
T), which metric(s) crossed, `ticks_to_detect` from the first response that carries it, and every
tick's response. Per cell: false-rollback rate (A/A) or power (A/B) = runs ending `rollback` / R,
binomial SE `√(p̂(1−p̂)/R)`; median rollback tick; `invalid_experiment` count; harness failures
(§6); upstream errors; realised canary share.

A/A bar: **B = α + 2.58 · √(α(1−α)/R)** with α = 0.05, R = 100: SE₀ = 0.0218, **B = 0.1062**
(pass if at most 10 of 100 runs roll back).

What R = 100 can and cannot distinguish. If the true false-rollback rate is p, the chance that the
count exceeds 10 is: p = 0.05 → 0.011; 0.08 → 0.18; 0.10 → 0.42; 0.12 → 0.67; 0.15 → 0.90;
0.20 → 0.994. So the bar catches a rate of 0.15 or more with probability about 0.9 and cannot tell
0.05 from 0.10. T2 detects gross failure only. It cannot confirm the Ville bound at α; T1 did that
on synthetic arms with R = 1000.

A/B: power with SE; at R = 40 the SE is 0.047 at a true power of 0.9 and 0.079 at 0.5.

Report-only premise diagnostics (A/A cells, no bar): pooled fraction of ticks with canary p99 >
control p99 (null 0.5) with its binomial SE; the lag-1 autocorrelation of that per-tick indicator
pooled within runs; mean log(canary p99 / control p99); pooled canary share of 5xx events against
the pooled traffic share.

## 3. Cells

| Cell | Kind(s) declared | w | Canary process flag | R | T | n / tick | Readout |
|---|---|---|---|---|---|---|---|
| AA-w0.5 | rate + sign | 0.5 | none | 100 | 100 | 500 | false rollback vs B |
| AA-w0.1 | rate, `allow_unequal_rate_split: true` | 0.1 | none | 100 | 100 | 500 | false rollback vs B (the premise probe) |
| AB-rate-x2 | rate + sign | 0.5 | `--fault-5xx-mult 2` | 40 | 100 | 500 | power |
| AB-lat-x1.2 | rate + sign | 0.5 | `--fault-latency-mult 1.2` | 40 | 100 | 500 | power |

Cells run in this order. A run that ends before T (terminal verdict) stops sending traffic; the next
run starts.

Seeds: S₀ = 20260926. Cell i = 1..4 in table order: `router_seed = S₀ + 7919 i`,
`control_seed = S₀ + 7919 i + 1`, `canary_seed = S₀ + 7919 i + 2`. Runs r = 0..R−1, ticks
t = 0..T−1, request index 0..n−1 within the tick.

Wall-time budget: at most 14 M requests if no run ends early (the A/B runs end at detection), under
60 minutes at 4k requests/s or more. If the harness smoke (§6) measures a throughput that cannot fit
this in 60 minutes, the sizes change by a dated amendment before the run, never after.

## 4. Primary endpoints

- E1: AA-w0.5 false-rollback rate ≤ B.
- E2: AA-w0.1 false-rollback rate ≤ B.
- E3: `invalid_experiment` in at most 1 run per A/A cell (α_srm = 0.001 per run).
- E4: AB-rate-x2 power ≥ 0.8.
- E5: AB-lat-x1.2 power ≥ 0.8.
- E6: zero harness failures and zero upstream errors in every cell.

## 5. Predictions (registered)

Point figures are from the synthetic run in §0 (c)2 (R = 1000 for A/A, 500 for A/B).

- P1: AA-w0.5 false rollback ≤ B. Synthetic figure 0.014. The rate metric has no arm-level
  mechanism (disclosure (b)); the sign metric carries real process noise, which I expect to be
  symmetric and short-lived at w = 0.5. Risk stated in advance: T1 measured sign false rollback of
  0.165 at φ = 0.5, σ_arm = 0.1 over T = 2000; a persistent per-process latency state (one process
  GC-heavy or scheduled worse for many consecutive ticks) would show here.
- P2: AA-w0.1 false rollback ≤ B. Synthetic figure 0.011. This passes by construction unless the
  pipeline is wrong, and a pass does not show that any real service may set
  `allow_unequal_rate_split`.
- P3: E3 holds: no `invalid_experiment` in either A/A cell.
- P4: AB-rate-x2 power ≥ 0.9, median rollback tick between 15 and 45 (synthetic: 1.00, median 27).
- P5: AB-lat-x1.2 power ≥ 0.9, median rollback tick between 8 and 40 (synthetic: 1.00, median 16).
  Real latency noise dilutes the fault, so a median above the synthetic figure is expected.
- P6: E6 holds: zero harness failures and zero upstream errors.
- P7 (report-only diagnostic): in AA-w0.5 the pooled fraction of ticks with canary p99 worse lies
  within 0.5 ± 3 SE.

## 6. Instrument checks and NOT-EXECUTABLE conditions

Before the run, a harness smoke at small size (not scored, not reported as a result): (i) a canary
with `--fault-5xx-mult 5` at w = 0.5 reaches `rollback` within T; (ii) an A/A run of 20 ticks
returns `extend` on every tick with nonzero counts on both arms; (iii) every process the smoke
starts is gone afterwards (no listener left on the harness ports). The smoke also measures
throughput for the §3 budget check.

Harness failure: a non-2xx gate response other than the expected `409` after a terminal verdict, a
router aggregate whose request count differs from n, a lost request, or a process exit during a
cell. Every catch in the harness increments a counter that the report prints.

- A cell with one or more harness failures is **NOT EXECUTABLE**: its runs are reported and not
  scored against its endpoint.
- If the gate process exits during the run, every cell from that point is NOT EXECUTABLE.
- Upstream errors are not harness failures; they are measurements of the system, counted and
  scored under E6.

## 7. Ship rule

This study cannot move authority, whatever it shows. Its result may be cited as "no gross failure
of the twin path on a local two-process A/A (T2)" and as clearing the way to design the T3
real-service test only if E1, E2, E3, E4, E5 and E6 all hold and no cell is NOT EXECUTABLE. Any
failure: the DORMANCY.md pointer records it, and the failure is explained before T3 is designed.
A pass leaves the premise on a real service untested; T3 remains the named condition for any
authority ADR.

## 8. Not measured

Real services, separate hosts or pods, cold fleets, AZ imbalance, production traffic, real 5xx
mechanisms, the Argo or CodeDeploy integrations, the proceed side (the rate proceed premise and a
usable `alpha_proceed` beyond the replay in §1), the missingness penalty (no observation is
withheld), and the false-rollback rate at a resolution finer than §2 states.

## Amendment 1 — 2026-09-27, before run 2

Written after run 1 (`results/run-20260927T050717Z/`, merged at bdf3f01) and before any harness
change for run 2. Run 1's ship rule was NOT MET on E6 alone; its REPORT.md attributes both
upstream-error ticks, post-hoc, to the host suspending (clamshell sleep, then maintenance sleeps).
This amendment registers a second run that holds the host awake and voids itself if the host
suspends anyway. Run 1 stands as recorded and is not re-cut.

- **(a) Same design, disjoint seeds.** Run 2 keeps §3's four cells, their order, w, flags, R
  (100, 100, 40, 40), T = 100, n = 500 requests per tick, 128 in flight, the 2000-request warm-up,
  §1's gate configuration (α_rollback 0.05, α_proceed 1e-12, α_srm 0.001, tolerances 0.2 and 0.15)
  and §2's bar B = 0.1062. The only change to the draws is a seed offset of exactly 1 000 000:
  `router_seed = S₀ + 1 000 000 + 7919 i`, `control_seed = … + 1`, `canary_seed = … + 2`, with
  S₀ = 20260926 and i = 1..4 as in §3. The largest seed run 1 or its smoke used is S₀ + 728 550
  (smoke cell i = 92), so the run-2 seeds (S₀ + 1 007 919 to S₀ + 1 031 678) are disjoint from
  every seed used so far. The harness takes the offset as `--seed-offset 1000000` and records it in
  manifest.json; offset 0 reproduces run 1's seeds.
- **(b) Host held awake.** The run is launched as
  `caffeinate -dims node studies/twin-aa-local/harness/run.mjs --mode full --seed-offset 1000000`
  from the repo root. `caffeinate` holds display, idle, disk and (on AC power only) system sleep
  assertions for the life of the process. It does not prevent clamshell sleep: the lid stays open
  for the whole run. Run 1's power log shows an earlier `caffeinate` ending 96 s before that run
  started, so the assertion is tied to the harness process here, not to a separate command.
- **(c) NOT-EXECUTABLE rule for host suspension.** The harness records the run's start and end
  wall-clock times in manifest.json and the wall duration of every scored tick (from the first
  request of the tick to the gate's response to that tick). At exit it saves the lines of
  `pmset -g log` that fall between start and end, inclusive, as `power-log.txt` in the run
  directory. The run is **void** (not executable; neither passed nor failed) if either:
  1. `power-log.txt` contains any line whose event type is `Sleep` or `DarkWake`; or
  2. any scored tick's wall duration exceeds **2000 ms**.

  The bound comes from run 1's cells that ran while the host was awake: AA-w0.5 took 663 s for
  10 000 ticks (66 ms per tick, warm-up and session creation included) and AA-w0.1 735 s for
  10 000 ticks (74 ms). Outside the two suspended ticks, the largest per-tick arm p99 in any cell
  was 207 ms. 2000 ms is about 27 times the mean tick and equal to the router's upstream timeout,
  so a tick can exceed it only if a request stalled past the timeout without the timeout firing,
  which is what host suspension produced in run 1 (28.5 s and 898.7 s stalls). A void run is
  reported with its raw data and the reason, and none of its endpoints or predictions is scored.
  It may be repeated once under this amendment, with the same seed offset. If the repeat is also
  void, the study stops and reports; there is no third attempt without a new amendment.
- **(d) Per-arm upstream errors, and a split check.** Run 1's raw cell files already hold the
  per-tick, per-arm counts (`uc`, `uk`; written by harness/run.mjs line 202), but
  analysis/summarize.mjs reported only a per-cell total, and the canary/control split of the
  AB-rate-x2 error tick (49 and 4) was found by hand. For run 2 the summary reports, per cell, the
  canary and control upstream-error totals and every tick with an upstream error: its run, tick,
  canary and control upstream errors, and canary and control requests. New report-only line, no
  bar and no verdict: for each such tick with U = canary + control upstream errors and canary
  traffic share s = canary requests / n in that tick, z = (canary upstream errors − U·s) /
  √(U·s·(1 − s)); the split is **near the traffic share** if |z| ≤ 3. The report lists each tick's z
  and whether it is near. Applied to run 1 for reference only: the AA-w0.1 tick gives z = 1.94
  (near) and the AB-rate-x2 tick z = 6.01 (not near). If run 2 has no upstream errors, the line
  reads "no upstream-error ticks".
- **(e) Unchanged.** E1–E6, P1–P7, the NOT-EXECUTABLE conditions of §6 (which still apply
  alongside (c)) and the §7 ship rule are otherwise unchanged. E6 still counts every upstream
  error in an executable run. Expected wall time with the host awake is about 25 minutes (run 1's
  awake cells at about 7000 requests/s, and about 1800 A/B ticks), inside §3's 60-minute budget;
  run 1's 70.6 minutes came from time suspended.

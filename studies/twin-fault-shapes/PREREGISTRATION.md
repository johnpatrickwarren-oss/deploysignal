# Pre-registration — three fault shapes through the twin gate on the real service: a latency regression, a smaller error-rate regression, and errors the metric cannot see (`2026-10-twin-fault-shapes`, T3)

- **Study id:** `2026-10-twin-fault-shapes`
- **Status: REGISTERED, NOT RUN.** Written before any harness, service or infrastructure change for
  this study, and while `2026-10-twin-aa-real-2`'s AA cell is still running (88 of 100 executable
  closed, 0 rollbacks; its verdict is not known). A later change is a dated amendment, appended,
  before the run it affects.
- **What it serves:** the power side of the twin gate beyond the one point measured so far (a
  uniform ×2 target-5xx fault, `studies/twin-aa-real/REPORT.md` §3b: 20 of 20). Three questions an
  authority ADR has to answer and no real-service run has: (1) does the `sign` kind **with its
  margin** detect a latency regression past the margin; (2) does the `rate` kind detect a
  regression smaller than ×2 in the time the engine's planner says; (3) what happens when the
  canary fails in a way the registered metric does not count (ELB-generated 5xx).
- **Inherits, by reference and unchanged:** `studies/twin-aa-real-2/PREREGISTRATION.md` with its
  Amendment 1, and through it `studies/twin-aa-real/PREREGISTRATION.md` with Amendments 1–3 — the
  service (seeded lognormal delay, median 30 ms, σ 0.4), four tasks per arm, the metric table with
  `p99_latency` `margin: { relative: 0.10 }`, ticks, W = 15, T = 60, the scored and W0 sessions,
  lanes and global run indices, void rules V1–V8, NOT-EXECUTABLE and abort, records, the
  observe-only runner. Only what this document states differs.

## 0. Disclosures

- (a) Known at registration: the first study's AA (12/44 false rollbacks without a margin) and
  AB-5xx (20/20, the rate detector first in 16, the unmargined sign detector first in 4); the
  second study's AA at 88 of 100 with 0 rollbacks, unverdicted. If the second study's E1 fails,
  this study does not run until that failure is explained (its §6), and this registration says so
  by amendment.
- (b) Every fault here is synthetic: an environment difference on the canary's task definition
  (the same image digest in both arms), as in the first study's AB-5xx. The cells measure the
  gate's response to a fault of a declared shape and size, not a real failure mechanism.
- (c) The operator is the author; the runner is observe-only; `TWIN_ARM_AUTHORITY` stays
  `advisory` whatever the result; nothing here is a false-rollback test (the A/A cells are the
  second study's).
- (d) The engine's planner (`per-shard/twin-planning.ts` `ticksToDetect`, v0.13.0-pre) was run
  before registration for the rate cell: at 12 bad events per tick over both arms, α 0.025 per
  metric, it returns 44 ticks at odds ×1.5 (and 26 at ×2, observed 25–26 in the first study).

## 1. Cells

All cells: canary and control on the same image and task-definition family, differing only in the
canary's environment as stated; R = 20 executable runs per cell; a cell stops at 30 attempts;
four lanes; a run ends at its scored session's terminal verdict or at 60 scored ticks.

| Cell | Canary differs by | What reaches the registered metrics |
|---|---|---|
| `AB-lat30` | `LATENCY_MEDIAN_MS` 39 instead of 30 (σ unchanged): every quantile of the delay ×1.3 | `p99_latency` canary ≈ 99 ms against ≈ 76 ms |
| `AB-5xx-1.5` | `FAULT_503_FRACTION` 0.0075 instead of 0.005: target 5xx odds ×1.5 | `http_5xx` canary ≈ 9.3 per tick against ≈ 6.2 |
| `AB-reset` | `RESET_FRACTION` 0.005: on that fraction of requests the process destroys the socket without replying (evenly spaced, counted per process like the 503 fraction); the 503 fraction stays 0.005 | nothing registered: the ALB answers the client with an ELB-generated 502, counted in `HTTPCode_ELB_5XX_Count` per load balancer (recorded per window by the runner, report-only, §3.4 of the first registration) and not in `HTTPCode_Target_5XX_Count` |

Order: `AB-lat30`, then `AB-5xx-1.5`, then `AB-reset`; each cell's canary setting is applied by a
stack update with the arms at 0 tasks and recorded before that cell's run 0.

`AB-reset` doubles the canary's user-visible failure rate (0.5% 503 plus 0.5% 502) while leaving
both registered metrics, by construction, where an A/A leaves them. It is the blind spot the first
registration's §0 (d) and §10 name ("ELB-generated 5xx").

## 2. Endpoints

Power is the share of a cell's executable runs whose **scored** session ends `rollback`.

- **F1 (`AB-lat30`).** Power ≥ 0.8: at least 16 of 20. Report-only: the median rollback tick, the
  detector that fired first in each run, the per-run share of scored ticks with canary p99 above
  control × 1.10.
- **F2 (`AB-5xx-1.5`).** Power ≥ 0.5: at least 10 of 20 within the 60-tick bake. Report-only: the
  median rollback tick against the planner's 44; the detector that fired first; the verdict of the
  runs that did not roll back.
- **F3 (`AB-reset`).** No bar. Reported: the number of 20 that roll back and on which detector;
  per run, the mean ELB-generated 5xx per tick on the lane's load balancer in the scored window
  against the lane's mean over the second study's AA runs; the canary and control `RequestCount`
  ratio (a reset request is still counted as a request by the ALB) and the sample-ratio e-value.
- **F4 (all cells).** Sample-ratio halts in at most 2 attempted runs over the study.

## 3. Predictions (registered)

- **Q1.** F1 holds with power ≥ 0.9 and a median rollback tick of 11 to 20, the `sign` detector
  firing in every rollback. Reasoning: a 30% shift against a 10% margin on per-minute p99s whose
  run-to-run noise in the second study's pre-flight was a few percent puts P(tick scores worse)
  near 1, and the e-process then needs about 11 ticks at N = 2. Confidence moderate: no margined
  sign power has been measured on a service.
- **Q2.** F2 holds with power between 0.6 and 0.9 and a median rollback tick between 35 and 55,
  the `rate` detector firing in every rollback (no early `sign` pre-emption: the margin is on).
  The planner's 44 is a median-like figure, so a 60-tick bake should catch most but not all.
- **Q3.** `AB-reset`: at most 2 of 20 roll back, and those not on evidence of the fault; ELB 5xx
  per tick on the lane rises by about 6 (0.005 × ≈1,240 canary requests) over the A/A level; the
  sample-ratio guard does not halt. The gate, as registered, does not see this failure. That is
  the expected result and the reason for the cell.
- **Q4.** F4 holds with 0 halts.

## 4. What each outcome would mean

- F1 failing: the margined `sign` kind does not detect a 30% p99 regression in an hour at this
  traffic; the margin that fixed the false rollbacks costs more power than ADR 0037's synthetic
  study measured, and the authority ADR may not claim latency detection.
- F2 failing with rollbacks near the end of the bake in the runs that did fire: the planner is
  optimistic off its verified point; the ADR states detectable effect sizes from this cell, not
  from the planner. F2 passing with a median near 44: the planner may be cited for bake sizing
  at this traffic.
- F3 as predicted: the ADR must name ELB-generated 5xx as outside the gate's sight on the
  registered CloudWatch metrics and say what an operator adds to cover it (a per-target-group
  proxy is not available from the ALB; the candidates are a client-side or mesh error rate as a
  `rate` metric). F3 with many rollbacks: something else moved (latency of surviving requests,
  request counts); reported with the detector and the tick, evidence first.

## 5. Void, NOT-EXECUTABLE, abort

As inherited. In addition, **V9**: a run whose canary tasks, as recorded by the driver's task
record after the runner exits, are not on the task-definition revision that the study record lists
for that cell (with that revision's environment read by `ecs:DescribeTaskDefinition` and recorded
before the cell's run 0) is void. Applied mechanically by the analysis script from the driver log.

## 6. Pins (to be completed by a dated amendment before run 0)

The engine tag and resolved SHA, the git tree hashes of the runner, analysis, gate service,
sources, engine gates and service source, the image digest (a new image: `RESET_FRACTION` is new
service code, off by default), the lane parameters per cell, and the lane configs. The runner is
the second study's with the study id and the cell list changed; the analysis script is committed
before run 0.

## 7. Ship rule

None of its own. This study cannot move authority and no endpoint here is necessary for the
second study's citation. Its numbers are the power evidence an authority ADR cites or declines to
cite, cell by cell.

## 8. Not measured

False rollback (the A/A studies); regressions other than +30% latency and ×1.5 errors; faults
that are bursty, localized to a subset of requests, load-dependent, or that appear as slowness
before errors; the proceed side; bakes other than 60 ticks; any real failure mechanism (§0 (b)).

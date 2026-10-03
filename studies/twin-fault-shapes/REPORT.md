# Report — four fault shapes through the twin gate on the real service (`2026-10-twin-fault-shapes`, T3)

- **Study id:** `2026-10-twin-fault-shapes`. Register: knowledge `WORKLIST.md` C84.
- **Registration:** `PREREGISTRATION.md` at `fe84ff1` (alone, before any code); Amendment 1 (pins, before
  run 0); Amendment 2 (a fourth cell, written while the third ran, with what had been seen disclosed);
  Amendment 3 (the fourth cell's pins, before its run 0). Verdicts as computed; no bar moved.
- **Configuration:** the second A/A's (`studies/twin-aa-real-2`): four lanes, four Fargate tasks per arm,
  the service at a p99 of about 76 ms, 0.5% 503s in every arm, `http_5xx` as a `rate` metric and
  `p99_latency` as a `sign` metric with a 10% relative margin, engine `v0.13.0-pre`, 60-tick bake after a
  15-tick warm-up. Every fault is a canary-only environment difference on one image. Cells 1–3 ran
  from DeploySignal `163308f`, cell 4 from `b1b1ac3` (Amendment 3); the gate, sources, engine gates and
  service trees are identical at both. Per cell: `results/runs/`, `results/operator/`,
  `results/evidence/cloudtrail-write-events-<cell>.json`, and an analysis directory named below.
  The canary task-definition revision per lane was recorded before each cell's run 0
  (`results/operator/cell-revisions.json`, V9).

## 0. The headline

| Cell | Fault on the canary | Endpoint | Observed | Verdict |
|---|---|---|---|---|
| `AB-lat30` | delay ×1.3 (p99 99 ms against 76) | F1 ≥ 16 of 20 | **20/20**, every rollback at scored tick 11 | **F1: PASS** |
| `AB-5xx-1.5` | 503 fraction 0.0075 against 0.005 | F2 ≥ 10 of 20 in 60 ticks | **20/20**, median tick 40 (38–42) | **F2: PASS** |
| `AB-reset` | socket destroyed on 0.5% of requests (ELB-generated 502) | F3 reported | **0/20**, every run `hold` at 60 | reported |
| `AB-reset-nr` | the same resets, plus a `no_response` metric | F5 ≥ 16 of 20 | **20/20**, median tick 12 (11–12) | **F5: PASS** |

F4 (sample-ratio halts ≤ 2 over the study): **0 of 81 attempts, PASS**. Predictions Q1, Q3, Q4 and Q5
held; Q2's power range (0.6–0.9) was too low (1.0) while its median-tick range (35–55) held.

Which detector fired, in every rollback of each cell: `twin_sign_p99_latency` (20), `twin_rate_http_5xx`
(20), none, `twin_rate_no_response` (20). No run in any cell rolled back on a detector other than the
one its fault addressed.

## 1. Cells

Analysis directories: `ablat30-20261002T042957Z`, `ab5xx15-20261002T133656Z` (both with the analysis
script at tree `7f66ee73…`, Amendment 1), `abreset-20261002T204510Z`, `abresetnr-20261003T001454Z`
(script at tree `5951cd68…`, Amendment 3, which adds the F5 bar and an unanswered-requests readout).

| | `AB-lat30` | `AB-5xx-1.5` | `AB-reset` | `AB-reset-nr` |
|---|---|---|---|---|
| Attempts / executable / void | 20 / 20 / 0 | 20 / 20 / 0 | 20 / 20 / 0 | 21 / 20 / 1 |
| Median p99, canary / control (ms) | 99.3 / 76.5 | 76.6 / 76.1 | 76.7 / 76.2 | 76.8 / 76.9 |
| Share of scored ticks beyond the 10% margin, min / median / max | 1.000 / 1.000 / 1.000 | 0.000 / 0.050 / 0.150 | 0.000 / 0.050 / 0.083 | 0.000 / 0.000 / 0.167 |
| Target 5xx per tick, canary / control | 6.11 / 6.15 | 9.17 / 6.09 | 6.11 / 6.11 | 6.13 / 6.07 |
| Requests per tick, canary / control | 1,220 / 1,220 | 1,220 / 1,220 | 1,219 / 1,221 | 1,222 / 1,215 |
| ELB-generated 5xx per tick on the lane's load balancer | 0.00 | 0.00 | 6.09 | 6.08 |
| Unanswered requests per tick, canary / control | — | — | — | 6.08 / 0.00 |
| Final sample-ratio e-value, min–max | 0.99–1.01 | 0.98–1.05 | 0.97–1.08 | 0.99–1.05 |
| CloudTrail write events over the cell | 448 | 426 | 415 | 430 |

Every run of every cell completed; no authority violation; no unhealthy target; every canary revision
matched the cell's record (V9); the latency scale stayed inside V8's band.

**`AB-lat30`.** A 30% latency regression against a 10% margin is detected at the first tick the test
can fire with two metrics (threshold 40, 11 ticks of unanimous evidence): the canary's p99 exceeded
the control's by more than the margin on every scored tick of every run. This is the first
real-service power measurement for the margined `sign` kind (the engine's `2026-10-twin-sign-margin`
measured it on synthetic arms).

**`AB-5xx-1.5`.** A ×1.5 error-rate regression is detected at ticks 38–42 against the planner's 44
(`per-shard/twin-planning.ts`, now verified at ×1.5 and, in the first study, at ×2: planned 26,
observed 25–26). With the margin on, the latency detector did not pre-empt (in the first study's
unmargined ×2 cell it fired first in 4 of 20).

**`AB-reset`.** The blind spot the first registration named, measured: the canary drops 0.5% of
connections, its user-visible failure rate doubles, the load balancer counts the dropped requests as
routed and answers them with its own 502, and neither registered metric moves (target 5xx equal to
two decimals, p99 unchanged, the guard at 1). Twenty runs of a doubled failure rate passed an hour of
bake untouched.

**`AB-reset-nr`.** The same fault with a third metric: requests routed minus target responses of every
status class, per arm, from one further CloudWatch call per window. Six unanswered requests per tick
on the canary against none on the control; the `rate` test rejects at tick 11–12 against a threshold
of 60 (three metrics). Registered by Amendment 2 before its code and run after the third cell closed.

## 2. The void and the attribution rule

Run 260 (lane 1, `AB-reset-nr`) is void under the committed script's V6/V7 rule: an ECS `TaskCreated`
at 22:57:39Z, three seconds after lane 1's arm-ready, carries no lane, and the script assigns such an
event to the lane whose driver logged the nearest preceding `scale` within 120 s — lane 1's, at
22:56:53Z. The surrounding events put it on lane 0: lane 0 scaled at 22:55:59Z, registered three
canary targets at 22:56:29Z and its fourth at 22:57:58Z, and reached arm-ready at 22:58:10Z; lane 1
had 4 + 4 healthy targets at its arm-ready and 4 / 4 in every window of run 260, and no listener,
service or target-group event of its own inside the run. The void stands as the mechanical rule
computed it (registered before the cell), run 260's own verdict (rollback at tick 11) is reported and
not counted, and run 263 replaced it. An interim analysis at 19 executable runs was produced at
23:36Z and discarded, not committed.

The rule mis-attributes when two lanes' scale-ups overlap, which they do whenever lanes finish runs
within a minute of each other. The first two cells' script (60 s window) left nine such events
unassigned instead (runs 191, 203–207, 212–214), none void. A `TaskCreated` carries no evidence a
`RegisterTargets` or `UpdateService` on the lane's own resources does not also carry, and those name
the lane; the onebox study's analysis is amended before its run 0 to leave lane-less `TaskCreated`
events out of the void decision and list them. This report changes nothing here.

## 3. What the fault's regularity does and does not show

The service's 503s and resets are evenly spaced per process (a counter, not a coin), so the per-tick
event counts barely vary and every run crosses the threshold within a tick or two of every other.
The cells therefore measure how fast evidence accumulates at a declared rate, and they do not
measure the spread of detection times a randomly arriving fault would show. At ×1.5 under random
arrivals some runs would cross 60 ticks; this study does not say how many.

## 4. Consequences for ADR 0001 (`decisions/0001-twin-rollback-authority.md`, §5)

- The `rate` kind on target 5xx is verified at two effect sizes on this service, ×2 (tick 25) and
  ×1.5 (tick 40), and the planner may be cited for bake sizing at this traffic.
- The `sign` kind with a 10% margin detects a 30% p99 regression in 11 ticks; its power at smaller
  regressions, and under random latency noise of a real host, is not measured.
- A metric set of target 5xx and p99 alone does not see requests the target never answers. The
  eligibility rule has to require a failure metric that counts unanswered requests; the `no_response`
  construction here does so on ALB CloudWatch data. It has not run in an A/A.

## 5. Not measured

False rollback with `no_response` declared (no A/A has run with it); faults that are bursty,
localized to a subset of requests, load-dependent, or that show as slowness before errors; timeouts
(as against resets); a real failure mechanism; onebox-sized arms; the proceed side; bakes other than
60 ticks.

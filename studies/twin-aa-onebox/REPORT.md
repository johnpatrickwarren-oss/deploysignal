# Report — the twin gate's real-service A/A on a onebox pair, same AZ and across AZs (`2026-10-twin-aa-onebox`, AA cell, T3)

- **Study id:** `2026-10-twin-aa-onebox`. Register: knowledge `WORKLIST.md` C84 (the onebox line).
- **Registration:** `PREREGISTRATION.md` at `eee08e3` (PR #148), Amendment 1 (size, 100 per
  stratum), Amendment 2 (`3c5174d`, the pins) and Amendment 3 (`aae042d`, V6/V7 attribution,
  analysis re-pinned at `4a11c74`), all before run 0. Verdicts below are recorded **as computed**; no bar
  moved.
- **Runs:** 200 executable AA runs, 2026-10-03 02:48:39Z (first arm-ready) to 2026-10-05 23:18:43Z
  (last runner exit), four lanes, **one Fargate task per arm**, 50 runs per lane, global run indices
  264–463. Image `old-v3-20261001` (seeded lognormal delay, median 30 ms, σ 0.4), 503 fraction
  0.005 in every arm, the p99 `sign` metric with `margin: { relative: 0.10 }`. Runner
  `harness/run-real.mjs` and gate at DeploySignal `aae042d`, engine `v0.13.0-pre` resolved
  `de25786c…`, Node v24.21.0, gate restarted 2026-10-03 00:37:39Z from the same commit
  (`results/operator/START.log`). Per-run files `results/runs/`, driver logs `results/operator/`,
  CloudTrail evidence `results/evidence/cloudtrail-write-events.json`, analysis
  `results/run-20261010T020414Z/`.
- **Pin verified (Amendments 2 and 3):** all 200 run manifests name `aae042d` and engine
  `0.13.0-pre` `de25786c…`; `4a11c74` is an ancestor of `aae042d` and the seven registered tree
  hashes match at `aae042d` (analysis `c1d97cf0…`).
- **The analysis and replay scripts were committed before run 0** (`committed_before_run_0: true`
  in the manifest) and ran unmodified (`analysis_tracked_changes: []`).

## 0. The headline

**O1 (same AZ): PASS**, 0 of 100. **O2 (across AZs): PASS**, 0 of 100. Each stratum's one-sided 95%
upper bound is **0.030**, against a bar of at most 10 of 100. **O3: PASS** (0 sample-ratio halts in
200 attempts). **O4: PASS** in both strata (0). 200 attempts, 200 executable, 0 void (V1–V8, V10),
0 deploy failures, 0 authority violations. The W0 session held in all 200.

Per §4 of the registration: a onebox pair at equal weights with the 10% margin is within the
measured conditions whether or not the pair shares an AZ, at this service's scale. The registered
replay (§3) puts the margin's work at one rollback in 200.

## 1. Endpoints, as registered

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| O1 same AZ | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 0/100 (upper bound 0.030) | **PASS** |
| O2 across AZs | ≤ 10 of 100 executable; stop at 11 | 0/100 (upper bound 0.030) | **PASS** |
| O3 sample-ratio halts | ≤ 2 of attempted | 0 of 200 | **PASS** |
| O4 sensitivity count | ≤ 10 per stratum | S 0, X 0 | **PASS** |

| Lane | Stratum | Baseline / canary AZ | Executable | Rollback | Median p99 ratio (canary / control) |
|---|---|---|---|---|---|
| 0 | S | 1a / 1a | 50 | 0 | 1.002 |
| 1 | S | 1b / 1b | 50 | 0 | 0.999 |
| 2 | X | 1a / 1b | 50 | 0 | 1.003 |
| 3 | X | 1b / 1a | 50 | 0 | 0.997 |

Void rules: V1–V5 from the runner's record, none. V8 (a scored tick's control p99 outside
20–400 ms), none; the per-run median control p99 ran 75.3–78.0 ms in S and 74.9–78.4 ms in X
(medians 76.3 and 76.4). V10 (a run's tasks outside its lane's registered AZs), none: every run's
driver record places its two tasks in the AZs of the table above.

V6/V7, from the CloudTrail file (2,641 write events over 2026-10-03 02:30Z – 2026-10-06 00:30Z;
four identities: the laptop operator user for the lane deploy at 02:39Z, before run 0, the
operator instance's role, ECS's service-linked role, `ecs.amazonaws.com`), evaluated on 200 of
200: no write event on a lane's resources inside any run's (arm-ready, runner-exit) interval.

Lane-less events (Amendment 3: listed, decide nothing). 149 of the 200 runs have at least one ECS
`TaskCreated` inside their interval; ECS-emitted task events name no lane. They are the other
lanes' scale-ups: the four lanes start each round within 23 s to 6.5 min of each other, so a run's
interval routinely contains the later lanes' launches. Run 364 (lane 2) is typical: lane 2's own two
`TaskCreated` at 13:03:21Z, before its arm-ready at 13:03:57Z, then pairs at 13:04:19–23Z,
13:05:03Z and 13:05:58–59Z, each a few seconds after lane 3's, lane 1's and lane 0's `scale` and
followed by two `RegisterTargets` on that lane's target groups. Over the cell: 407 `TaskCreated` =
4 for the two pre-flight rotations + 2 × 200 scale-ups + 3 more; every one after run 0 follows a
driver `scale` by at most 120 s; every one of the 200 runs logged
exactly two `RegisterTargets` on its own lane between its `scale` and its arm-ready, and none
inside its interval. Two of the 3 extra launches sit in lane 2's scale-ups for runs 372 (15:48:49Z)
and 377 (17:12:54Z), each followed by lane 2's second `RegisterTargets` and both before that run's
arm-ready: a task replaced before it became healthy. I did not place the third.

Traffic, per stratum: 1,220 requests per arm per tick on average in both arms; 6.10 / 6.10 target
5xx per tick; pooled target 5xx rate 0.0050 (S 73,197 of 14,640,972; X 73,224 of 14,642,515). The
largest rollback e-value on any scored tick of any run was 1.02 (S) and 1.01 (X) for `http_5xx` and
1.00 for `p99_latency`, against a threshold of 40. The largest final sample-ratio e-value was
1.058 (S) and 1.095 (X), against 1,000.

## 2. Predictions

- **R1 held:** O1 holds with 0 rollbacks (registered 0 to 5).
- **R2 held:** O2 holds with 0 rollbacks (registered 0 to 9, confidence low). The failure mode I
  named, lanes 2 and 3 splitting in opposite directions on one AZ difference, did not appear: their
  median p99 ratios are 1.003 and 0.997, the same size as the same-AZ lanes' 1.002 and 0.999.
- **R3 NOT held:** I predicted the unmargined replay would give 6 to 30 of 100 in S and more in X.
  It gave **0 in S and 1 in X** (§3).
- **R4 held:** 0 halts.
- **R5 held:** `twin_rate_http_5xx` fired in 0 of 200 runs (registered at most 3).

## 3. The registered replay (report-only, no verdict)

`analysis/replay.mjs`, committed before run 0, replays each executable run's 60 stored scored tick
bodies through the engine's gate at the pin with the p99 margin at 0, 0.05 and 0.10
(`results/run-20261010T020414Z/replay.json`; the 0.10 replay reproduces the runs' 200 holds):

| p99 margin | S rollbacks of 100 | X rollbacks of 100 |
|---|---|---|
| 0 (ADR 0036 scoring) | 0 | **1** (run 348, lane 2, tick 27, `p99_latency`) |
| 0.05 | 0 | 0 |
| 0.10 (as run) | 0 | 0 |

At one task per arm the unmargined `sign` kind rolled back once in 200, against once in 100 at
four tasks per arm in `2026-10-twin-aa-real-2`. The per-run share of scored ticks with canary p99
above control p99 ran 0.333–0.633 in S and 0.300–0.650 in X (median 0.500 in both); the share
beyond the 10% margin ran 0.000–0.117 per run in both strata (median 0.050). On this service the
host-level offsets I expected one task per arm to put back are not visible at the p99 scale: the
arms look exchangeable to the unmargined statistic at one task as at four. The margin is insurance
here, as at four tasks, not a requirement.

## 4. Deviations and notes

- None against the registration's procedure: registration before code, analysis and replay before
  run 0, pins by dated amendment, verified.
- The analysis ran on 2026-10-10, four days after the cell closed (2026-10-05 23:22Z, the
  watcher's "all drivers done"); the artifacts were on the runner and operator hosts unchanged
  until then. The analysis tree at run time was the registered one (`git diff` clean against
  `c1d97cf0…`).
- The driver logs under `results/operator/` have the account id redacted; `START.log` is the
  operator instance's shared log and also carries the earlier studies' lines. Every run manifest
  lists one tolerated dirty path, `tools/calibrate/_calibrate-constants.js`, with the empty diff's
  hash (no change).
- The per-stratum stop (11 rollbacks) never came close; `results/operator/onebox-watch.log` shows 0
  in both strata at every five-minute tally.

## 5. What this establishes, and what it does not

Established (T3; one synthetic service at a p99 of about 76 ms, one region with two AZs, one seeded
load generator, one Fargate task per arm, 60-tick bake): with the `rate` kind on target 5xx and the
`sign` kind on p99 with a 10% relative margin, the twin gate produced no false rollback in 100
identical deployments with both oneboxes in one AZ, none in 100 with them in different AZs, and no
sample-ratio halt. With the two earlier studies, the `rate` kind has 0 false rollbacks in 344 real
A/A runs.

Not established: other services, in particular a fast service, where the first study's 1 ms p99
made sub-millisecond host offsets decisive (the arm-size answer here is conditional on a p99 large
against host offsets); power at onebox size (the fault study ran four tasks per arm); arm sizes two
and three with the margin; more than two AZs; regions (§0 (b)); a production host; a onebox
against the whole fleet; the proceed side (`alpha_proceed` 1e-12, every run ends `hold`); a rate
finer than the bar resolves (the bound after 0 of 100 is 0.030 per stratum); `no_response`, which
was not in this study's metric table. Authority is unchanged (`TWIN_ARM_AUTHORITY` advisory).

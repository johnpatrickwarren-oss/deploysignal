# Report — the twin gate's real-service A/A, second registration (`2026-10-twin-aa-real-2`, AA cell, T3)

- **Study id:** `2026-10-twin-aa-real-2`. Register: knowledge `WORKLIST.md` C84 (T3 line).
- **Registration:** `PREREGISTRATION.md` at `f55ef1b` (alone, before any code), Amendment 1 at
  `7ba3566` (the pin), both before run 0. Verdicts below are recorded **as computed**; no bar moved.
- **Runs:** 100 executable AA runs, 2026-09-30 14:58:24Z (first arm-ready) to 2026-10-02 01:14:36Z
  (last lane done), four lanes, four Fargate tasks per arm (two per AZ), image
  `old-v2-20260929` (seeded lognormal delay, median 30 ms, σ 0.4), 503 fraction 0.005 in every
  arm, the p99 `sign` metric with `margin: { relative: 0.10 }`, global run indices 83–182. Runner
  `harness/run-real.mjs` and gate at DeploySignal `ded4d27`, engine `v0.13.0-pre` resolved
  `de25786c…`, Node v24.21.0, gate started 2026-09-30 03:18:32Z from the same commit. Per-run files
  `results/runs/`, driver logs `results/operator/`, CloudTrail evidence
  `results/evidence/cloudtrail-write-events.json`, analysis `results/run-20261002T011901Z/`.
- **Pin verified (Amendment 1):** all 100 run manifests name `ded4d27` and engine `0.13.0-pre`
  `de25786c…`; the seven registered tree hashes match at `ded4d27`.
- **The analysis script was committed before run 0** (`6c1f378`, tree `5f70d5d0…`, §0 (c)); it ran
  unmodified. The post-hoc replay in §3 was written after the cell closed and carries no endpoint.

## 0. The headline

**E1: PASS.** 0 of 100 executable runs ended `rollback` (one-sided 95% upper bound **0.030**),
against a bar of at most 10. **E2: PASS** (0). **E3: PASS** (0 sample-ratio halts in 100 attempts).
100 attempts, 100 executable, 0 void, 0 deploy failures, 0 authority violations, no unhealthy
target. The W0 session (no warm-up exclusion) held in all 100 as well.

Per the ship rule (§7 here, §9 of the first registration) this may be cited as "no gross
false-rollback excess of the twin gate on one real service, sign kind with a 10% margin and rate
kind, three-target-group topology, 60-tick bake, tier T3". It is necessary and not sufficient for
an authority ADR, and it moves no authority.

## 1. Endpoints, as registered

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 0/100 (upper bound 0.030) | **PASS** |
| E2 sensitivity count | ≤ 10 | 0 | **PASS** |
| E3 sample-ratio halts | ≤ 2 of attempted | 0 of 100 | **PASS** |

| Lane | Attempts | Executable | Rollback | Hold |
|---|---|---|---|---|
| 0 | 25 | 25 | 0 | 25 |
| 1 | 25 | 25 | 0 | 25 |
| 2 | 25 | 25 | 0 | 25 |
| 3 | 25 | 25 | 0 | 25 |

Void rules: V1–V5 from the runner's record, none. V8 (latency scale, a scored tick's control p99
outside 20–400 ms), applied mechanically: none; the per-run median control p99 ran 75.4–78.2 ms
(median 76.3). V6/V7 from the CloudTrail file (2,046 write events over 2026-09-30 14:40Z –
2026-10-02 01:20Z; four identities: the laptop operator user for the lane deploy at 14:47Z, before
every run, the operator instance's role, ECS's service-linked role, `ecs.amazonaws.com`),
evaluated on 100 of 100: no write event on a lane's resources inside any run's (arm-ready,
runner-exit) interval.

One event the committed script could not attribute, listed and explained: an ECS `TaskCreated`
at 2026-10-01 19:42:31Z falls inside the intervals of runs 165 (lane 2) and 166 (lane 3) and names
no lane (ECS-emitted task events carry none). The script attributes such events to the lane whose
driver logged a `scale` within the preceding 60 s; lane 0's scale for run 167 was at 19:41:25Z,
66 s earlier. The surrounding events place it on lane 0: eight task creations at 19:41:32–34Z
after that scale, lane 0's canary target group registering 2, then 1, then (at 19:42:50Z) its
fourth target, and lane 0's weights going to 50/25/25 at 19:42:55Z, its arm-ready. It is a ninth
task launch during lane 0's scale-up (one canary task was replaced before it became healthy),
before lane 0's own arm-ready and on neither lane 2 nor lane 3. No run is void on it; the
script reports it as unassigned for both runs and flags none.

Traffic: 1,220 requests per arm per tick on average in both arms; 6.10 / 6.09 target 5xx per
tick; pooled target 5xx rate 0.0050 (73,177 of 14,637,652 requests). The largest rollback e-value
on any scored tick of any run was 1.13 for `http_5xx` and 1.00 for `p99_latency`, against a
threshold of 40.

## 2. Predictions

- **P1 held:** E1 holds, 0 rollbacks (registered 0 to 4).
- **P2 held:** `twin_rate_http_5xx` fired in 0 runs (registered 0 to 2).
- **P3 held:** 0 halts.
- **P4 NOT held:** I predicted the unmargined canary-worse share would still spread over 0–1
  across runs, the offsets still present and now inside the margin. It did not: the per-run share
  of scored ticks with canary p99 above control p99 ran **0.350 to 0.650, median 0.500**. At this
  latency scale and task count the arms look exchangeable to the unmargined statistic too (§3).
- **P5 held:** W0 rollbacks 0 (registered at most 10).

The analysis script's printed "Predictions" line carries the first study's labels (it is that
study's script with the registered deltas); its "P4 held (W0 rollbacks 0)" is this study's P5.

## 3. Post-hoc: what did the work (no verdict; §0 (b) said a pass would not attribute)

`analysis/replay-posthoc.mjs`, written after the cell closed, replays each run's 60 stored scored
tick bodies through the engine's gate at the pin with the p99 margin set to 0, 0.05 and 0.10
(`results/run-20261002T011901Z/replay-posthoc.json`; the 0.10 replay reproduces the runs' 100
holds):

| p99 margin | Rollbacks of 100 |
|---|---|
| 0 (ADR 0036 scoring) | **1** (run 128, tick 27, `p99_latency`) |
| 0.05 | 0 |
| 0.10 (as run) | 0 |

On these 100 runs the unmargined `sign` kind would have rolled back once. In the first study it
rolled back 12 of 44 times. The difference between the two studies is therefore mostly **the
latency scale and the task count, not the margin**: with a p99 near 76 ms and four tasks per arm
the canary is worse on half the ticks (0.35–0.65 per run), where at 1 ms and two tasks per arm it
was worse on 0–100% of ticks depending on the deployment. The share of ticks beyond the 10% margin
was 0.000–0.100 per run (median 0.050). The margin removed the one remaining rollback and leaves
the test insensitive to offsets the first study showed can exist; it is not what made these arms
exchangeable. Whether scale or task count matters more is not separated by this study.

## 4. Deviations and notes

- None against the registration's procedure: registration before code, analysis before run 0,
  the pin by dated amendment, verified.
- The runner host's copy of the first study's results was moved aside before the host was pulled
  to `ded4d27` (untracked files that are now tracked); every file then in git was byte-identical
  to its host copy.
- The driver logs under `results/operator/` have the account id redacted; `START.log` is the
  operator instance's shared log and also carries the first study's lines.

## 5. What this establishes, and what it does not

Established (T3; one synthetic service at a p99 of about 76 ms, one region, one seeded load
generator, four Fargate tasks per arm, 60-tick bake): with the `rate` kind on target 5xx and the
`sign` kind on p99 with a 10% relative margin, the twin gate produced no false rollback in 100
identical deployments, and no sample-ratio halt. Together with the first study: the `rate` kind
has 0 false rollbacks in 144 real A/A runs across both configurations and detected a ×2 fault in
20 of 20.

Not established: which of the margin, the latency scale and the task count is needed (§3 says the
margin was nearly idle here); power with the margin (`2026-10-twin-fault-shapes` is registered for
it); the proceed side (`alpha_proceed` 1e-12, every run ends `hold`); a rate finer than the bar
resolves (0.05 against 0.10 is not separated; the bound after 0 of 100 is 0.030); other services,
regions, traffic sources or task counts; a real fleet; the Argo and CodeDeploy paths. Authority is
unchanged (`TWIN_ARM_AUTHORITY` advisory).

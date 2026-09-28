# Pre-registration — real-service A/A of the twin gate (`2026-10-twin-aa-real`, Plan D tier T3)

- **Study id:** `2026-10-twin-aa-real`
- **What it serves:** engine ADR 0036's rollback premise ("randomized per-request routing, no
  arm-level effect on any tick") on a real service behind an AWS Application Load Balancer, read
  through the ALB's CloudWatch metrics and DeploySignal's gate service in `mode: "twin"`. It is the
  real-service A/A test that DORMANCY.md (Plan B, `activation_mechanism`) names as the condition
  for any authority ADR.
- **Tier:** T3 (a real service, real hosts, a real load balancer, real metric publication). It is
  the first T3 of the twin gate.
- **Repo:** deploysignal at `9c689ba` (branch `wt/twin-aa-real`). **Engine:**
  `@johnpatrickwarren-oss/deploysignal-engine` v0.12.1-pre, resolved
  `094ad2f15f0adadc94bfe191677da544f323fdaf` (package-lock.json).
- **Status: REGISTERED, NOT RUN.** No AWS resource exists for it, no credentials exist on the
  machine this was written on, and nothing has been measured. A later change is an amendment,
  appended and dated, before the first run it affects.
- **Authority:** none. `TWIN_ARM_AUTHORITY` (`engine/guarantees.ts`) stays `'advisory'` whatever
  this study shows. A pass is a necessary input to a separate authority ADR, not that ADR (§9).

## 0. Disclosures

- (a) **Earlier results are known.** Engine study `2026-09-twin-null` (T1, synthetic, run
  `run-20260926T053339Z`): false rollback 0.026 (rate, w 0.5), 0.027 (rate, w 0.1), 0.025 (sign)
  against B = 0.0678; cold canary with no warm-up 0.289 (rate) and 1.000 (sign), with a 150-tick
  warm-up 0.018 and 0.034; persistent arm-level state (AR(1), φ ≥ 0.5) 0.063 to 0.832; per-tick
  arm shocks harmless at w 0.5, 0.755 for rate at w 0.1. Study `2026-09-twin-aa-local` (T2, two
  local processes): 0/100 false rollbacks at w 0.5 and w 0.1 in each of two runs, power 40/40 for
  each injected fault; run 1 NOT MET on upstream errors attributed to host sleep, run 2 MET. Every
  number in §§3–6 is sized from these, and my predictions (§6) are informed by them.
- (b) **Conflict of interest.** The protocol's author (a Claude Code session working for John
  Warren, who owns DeploySignal) has an interest in the twin path passing. The bars, void rules
  and the sensitivity count (§5, E2) were chosen so that the reading harder to pass is the one
  scored.
- (c) **What the author has not seen.** No run of this protocol. No AWS account data. The runner
  (`harness/run-real.mjs`, committed after this file) is tested only against injected fake
  CloudWatch and gate clients.
- (d) **Unverified premises about AWS**, each stated where it applies:
  1. ALB weighted target groups route each request by weight. AWS documents the weights, not the
     algorithm; whether assignment is independent per request, and independent of the request's
     outcome, is not documented. ADR 0036 needs it. The sample-ratio guard (§5, E3) and the A/A
     itself test it indirectly; nothing here tests it directly.
  2. `HTTPCode_Target_5XX_Count` counts only responses the target generated. A target that times
     out or resets the connection produces an ELB 502/504, counted in `HTTPCode_ELB_5XX_Count`,
     which ALB publishes per load balancer, not per target group. The rate metric cannot see those
     failures in either arm.
  3. `TargetResponseTime` p99 is CloudWatch's percentile over one period, not an exact order
     statistic over the arm's requests.
  4. AWS FIS's ECS network-latency action (optional cell AB-lat, §4) shows up in
     `TargetResponseTime`. Not checked.
- (e) **Why an A/A and what it can reach.** Both arms run the same image digest and the same task
  definition revision, so H0 holds by construction for the version. What remains is everything the
  premise excludes and a real service can carry: arm-specific host placement, AZ mix, start-up
  order, noisy neighbours, target-group attributes, and the ALB's routing. Those are the objects
  of this test.

## 1. System under test: requirements the operator's service must meet

The operator (John) provides the service. It qualifies only if every item holds for the whole
study; the operator records each in the run record (§8). A requirement not met before the first
run makes the study NOT EXECUTABLE (§7), not a different study.

- **R1. HTTP service behind an ALB**, on ECS (Fargate or EC2) or EC2 Auto Scaling, one region.
  Each arm is a separately scalable set of targets registered in its own target group.
- **R2. Deterministic enough to deploy twice.** A single image digest (or AMI plus artifact
  checksum) for the "old" version, deployable as two independent task sets or services at once.
- **R3. Traffic.** At least 1000 requests per arm per 60 s tick (about 17 requests/s per arm)
  throughout the scored window, from the traffic source the operator declares before run 0 (real
  production traffic, or a load generator whose request mix and seed are recorded).
- **R4. Bad events to count.** An expected 5 or more target 5xx responses per arm per tick (T2's
  AB cells ran at 250 requests × 0.02 = 5 per arm per tick and detected a 2× fault at a median
  tick of 26 and 27). If the service's natural 5xx rate is too low, the operator may make both
  versions return 503 on a fixed fraction of requests from the same code path; that is disclosed
  in the record, and the rate cells then test routing and counting, not a real failure mechanism
  (as in T2 disclosure (b)).
- **R5. Equal arms.** `baseline-old` and `canary-new` run the same task definition revision (same
  CPU, memory, platform version or instance type, environment), the same task count (≥ 2 per arm,
  the same number in each AZ the listener serves), the same target-group attributes (health check,
  deregistration delay, slow-start duration, load-balancing algorithm), and start within 60 s of
  each other.
- **R6. Routing.** Target-group stickiness on the forward action is off; cross-zone load balancing
  is on; no listener rule routes by header, path, source or cookie to either arm; the ALB weights
  on `baseline-old` and `canary-new` are equal and unchanged for the whole study.
- **R7. Metrics.** ALB CloudWatch metrics published at 60 s resolution (the ALB default) in the
  study's region, readable with `cloudwatch:GetMetricData`.
- **R8. Host that runs the runner and the gate** stays up and awake for each run (an EC2 instance,
  or a laptop on AC power under `caffeinate -dims` with the lid open; T2 run 1 lost an endpoint to
  host sleep). The gate is `node service/gate-http/server.js` built from the repo at the runner's
  commit.

## 2. Topology

Three target groups behind one listener rule, as a weighted forward action
(ORCHESTRATION-ADAPTERS.md, "Twin gate"):

| target group   | version (A/A) | ALB weight | arm in the twin |
|----------------|---------------|------------|-----------------|
| `prod-old`     | old           | 1 − 2w     | none            |
| `baseline-old` | old           | w          | control         |
| `canary-new`   | **old**       | w          | canary          |

`canary-new` keeps its name because it is the target group a real deploy would put the new version
in; in every A/A run it carries the old version. w is chosen by the operator in [0.05, 0.25],
recorded before run 0, and fixed for the study. Within the experiment the canary's share is
w / (w + w) = 0.5 (`per-shard/twin-gate.ts:47` at v0.12.1-pre), so `canary_weight` is 0.5, `sign`
is admissible, and `allow_unequal_rate_split` is not set.

**Per run:** fresh `baseline-old` and `canary-new` targets are started together (R5), both on the
old version; the run starts at **arm-ready**, the first minute at which every target in both groups
is healthy. After the run both sets are stopped. A run never reuses a previous run's targets, so
runs are independent draws of placement and start-up. The operator's deploy automation does this;
the runner does not touch AWS resources (§3.5).

Labelling is fixed: `canary-new` is always the canary. A persistent advantage of one target group
over the other (an attribute difference, a placement pattern) is a real deployment risk, so it is
left to show up as false rollbacks rather than randomized away.

## 3. Measurement

### 3.1 Metrics (CloudWatch source, `service/sources/cloudwatch.ts`)

Per tick window, one `GetMetricData` call, namespace `AWS/ApplicationELB`, dimensions
`TargetGroup` and `LoadBalancer`, `Period` = the window:

| twin metric | kind | per arm | worse | tolerance |
|---|---|---|---|---|
| `http_5xx` | rate | events = `HTTPCode_Target_5XX_Count` Sum, total = `RequestCount` Sum | higher | 0.2 |
| `p99_latency` | sign | `TargetResponseTime` p99 | higher | 0.15 |

`canary_requests` and `control_requests` are the two `RequestCount` sums. Sums are rounded to
integers and events clamped to the total by the source; the gate refuses non-integer counts. An
absent 5xx series is zero events (ALB publishes no zero datapoints); an absent or multi-valued p99
omits the sign observation. `sign` is declared only because the within-experiment split is 0.5;
at any other split this protocol does not declare it.

Prometheus (`service/sources/prometheus.ts`) is not registered. Using it instead needs a dated
amendment before run 0 naming its queries.

Report-only, per tick (no bar): `HealthyHostCount` Minimum and `UnHealthyHostCount` Maximum per
target group, from the same client in a second `GetMetricData` call.

### 3.2 Ticks, warm-up, bake

- **Tick:** 60 s, windows aligned to UTC minute boundaries (the CloudWatch source requires a
  multiple of 60 s starting on a minute). Each window is fetched 180 s after it closes (ALB metrics
  arrive 1 to 3 minutes late; ORCHESTRATION-ADAPTERS.md "Source notes"). Up to 3 fetch attempts,
  20 s apart, each bounded at 30 s.
- **Warm-up W = 15 ticks.** Windows 0 to 14 after arm-ready are fetched and recorded and not fed
  to the scored session. T1's cold-start cells put a canary-only excess of 0.3 log units on a
  30-tick time constant; no warm-up gave 0.289 (rate) and 1.000 (sign) false rollback, a warm-up
  of 150 ticks (5 time constants) gave 0.018 and 0.034. Real start-up transients are measured in
  minutes (JIT, caches, connection pools), and here both arms start cold together, so what remains
  is the asymmetric residue. W = 15 is 5 time constants of an assumed 3-minute transient. That
  constant is an assumption, not a measurement; the report-only W0 session (§3.3) prices it.
- **Bake T = 60 scored ticks** (one hour). The false-rollback bound is anytime-valid, but a
  persistent arm-level state accumulates evidence with the horizon (T1: φ 0.5, σ_arm 0.1 gave
  0.165 for sign over 2000 ticks). The result therefore covers bakes of at most 60 ticks of 60 s;
  an authority ADR citing it may not run a longer bake on its strength.
- One run occupies W + T = 75 windows plus the 180 s settle: about 78 minutes after arm-ready.

### 3.3 Gate sessions per run

Two twin sessions on the same gate, fed from the same fetched bodies:

- **Scored session**, `deploy_ref` `t3-<cell>-l<lane>-r<run>`: fed windows W to W + T − 1 (60
  ticks). `twin_arm`: `canary_weight` 0.5, `alpha_rollback` 0.05, `alpha_proceed` 1e-12,
  `alpha_srm` 0.001, `max_ticks` 60, the two metrics of §3.1.
- **W0 session** (report-only), `deploy_ref` `…-w0`: fed every window from 0 (75 ticks, `max_ticks`
  75), same α. It is T1's W = 0 cold-start cell on a real service.

`alpha_proceed` is 1e-12 in both, as in T2: the proceed test cannot end a run within T, so the
rollback e-process is observed over the full horizon. A gate at a usable `alpha_proceed` stops at
the first proceed, so its rollback event is a subset of the full-horizon event, and the
full-horizon false-rollback rate bounds the deployed gate's from above. The deployed-configuration
verdict at `alpha_proceed` 0.05 is recovered from the same tick responses (the bet size λ does not
depend on α): the first tick with `srm_e ≥ 1000` (halt), else any `rollback_e ≥ rollback_threshold`
(rollback), else every `proceed_e ≥ 20` (proceed). It is reported with no bar.

Across the two metrics the gate splits `alpha_rollback` by Bonferroni (0.025 each).

### 3.4 Per-tick record

The runner writes, per window: its bounds, the fetch attempts and the time of the successful one,
the tick body sent, both sessions' responses, the health metrics, and the wall-clock lag of the
fetch behind window end + 180 s. Every run is one JSON file, never overwritten (§8).

### 3.5 The runner is observe-only

`harness/run-real.mjs` reads CloudWatch (`GetMetricData` only) and talks to the gate's twin HTTP
API. It never calls CodeDeploy, ECS, ELBv2 or FIS, never changes a weight, and aborts the run if a
gate tick response states an authority other than `"advisory"`. Account-specific values (region,
load balancer and target-group dimension values, gate URL) come from a config file;
`config.example.json` holds placeholders only, and the runner refuses to start with a placeholder.

## 4. Cells

| Cell | Canary target group runs | R (executable runs) | Readout | Required |
|---|---|---|---|---|
| AA | old, same digest and task definition as `baseline-old` | 100 | false rollback vs B | yes |
| AB-5xx | old, with an application flag adding target 503s at the base 5xx rate (≈ ×2) | 20 | power | optional |
| AB-lat | old, with an AWS FIS `aws:ecs:task-network-latency` experiment on the canary tasks only, delay d | 20 | power | optional |

- AA runs first. Optional cells, if run, follow all AA runs; neither is needed for the ship rule.
- AB-5xx needs the service to carry the flag in both versions' code (off in `baseline-old`); the
  fault is then a configuration difference on the canary only.
- AB-lat needs `enableFaultInjection` set on the task definition of both arms from AA run 0
  onwards (so the A/A and AB arms differ only by the FIS experiment). d = 0.2 × the median over
  executable AA runs of the per-run median control p99, rounded to the millisecond, computed
  before the first AB-lat run and recorded. The FIS target selection is the canary target group's
  tasks only; the FIS experiment template ARN is recorded.
- **Lanes.** Runs may execute in up to 4 parallel lanes, each an independent listener rule with its
  own three target groups on the same service, image and region. Lane ids 0 to 3; every run
  records its lane; the report gives per-lane counts. Run indices are global and assigned in the
  order runs start.
- No seeds: routing randomness is the ALB's, which neither the operator nor the runner controls.
  If a load generator is used, its seed is recorded per run (§8).

## 5. Endpoints

Per run, from the scored session: the terminal verdict (`rollback`, `halt` =
`invalid_experiment`, or `extend`/`hold` at T), which metric(s) crossed, the crossing tick.

A/A bar, as in T2: **B = α + 2.58 · √(α(1−α)/R)** with α = 0.05, R = 100: SE₀ = 0.0218,
**B = 0.1062**, pass if at most 10 of 100 executable runs roll back.

- **E1.** AA false-rollback rate (scored session, either metric) ≤ B: at most 10 rollbacks in 100
  executable runs.
- **E2 (sensitivity, harder reading).** Rollbacks among executable AA runs plus rollbacks reached
  in void AA runs before they were voided: at most 10. Voiding is mechanical where possible
  (§7), but a void rule that could be applied after seeing a rollback must not be able to remove
  one.
- **E3.** Sample-ratio halts (`verdict: "halt"`) in at most 2 attempted AA runs. At `alpha_srm`
  0.001 the expected count in 150 attempts is 0.15; more than 2 says the ALB is not routing at the
  declared weights, and the premise's randomization is not established on this service.
- **E4 (optional).** AB-5xx power ≥ 0.8: at least 16 of 20 executable runs roll back.
- **E5 (optional).** AB-lat power ≥ 0.8: at least 16 of 20.

**What R = 100 can and cannot resolve.** If the true false-rollback rate is p, the chance that the
count exceeds 10 is: p = 0.05 → 0.011; 0.08 → 0.176; 0.10 → 0.417; 0.12 → 0.666; 0.15 → 0.901;
0.20 → 0.994. The bar catches a rate of 0.15 or more with probability about 0.9 and cannot tell
0.05 from 0.10. The one-sided 95% Clopper–Pearson upper bound on p after 0, 2, 5 and 10
rollbacks in 100 is 0.030, 0.062, 0.102 and 0.164. A pass therefore shows the real-service
false-rollback rate is not grossly above α at this service, this topology, this configuration and
a 60-tick bake. It does not show the rate is at or below α. Separating 0.05 from 0.10 with 0.9
power would take several hundred runs, which at 78 minutes per run is outside this study.

At R = 20 the power readout has SE 0.067 at a true power of 0.9 and 0.112 at 0.5; the chance of
passing (≥ 16 of 20) is 0.997 at a true power of 0.95, 0.63 at 0.8 and 0.05 at 0.6.

**Stopping.** AA runs until 100 are executable. It stops early, with E1 failed, once 11 executable
runs have rolled back; the verdict cannot change after that. It does not stop early on a pass.

**Report-only diagnostics** (no bar, no verdict), AA cell:

- W0 session false-rollback count, beside the scored session's (the price of W = 15).
- Pooled fraction of scored ticks with canary p99 worse (null 0.5), binomial SE; lag-1
  autocorrelation of the per-tick indicator, pooled within runs.
- Between-run dispersion of that indicator: the variance of per-run counts against the
  Binomial(ticks, 0.5) variance. Persistent arm-level state within a run shows as dispersion above
  1 even when few runs roll back.
- Pooled canary share of 5xx events against the pooled canary traffic share, and the realised
  canary traffic share per run.
- Deployed-configuration verdicts (§3.3).
- Per-run health: any tick with `UnHealthyHostCount` > 0 or `HealthyHostCount` below the task
  count, by arm.
- Per-lane rollback counts; runs grouped by whether the two arms' AZ mixes matched.

## 6. Predictions (registered)

- **P1.** E1 holds. For `http_5xx` I expect it with confidence: both arms share code, host type
  and traffic, and T1 and T2 found no path to false rollback without an arm-level mechanism. For
  `p99_latency` I have no measurement to predict from: a real arm can carry persistent latency
  state (a noisy host, an AZ imbalance), and T1 measured 0.165 at φ 0.5, σ_arm 0.1 over 2000
  ticks. My point figure for the combined count is 0 to 6 rollbacks in 100, held with low
  confidence for the sign metric.
- **P2.** E2 holds, with at most 1 void run ending in rollback.
- **P3.** E3 holds with 0 halts.
- **P4.** The W0 session's rollback count is at most 10 in 100 as well, because both arms start
  cold together; if it is not, the excess is start-up asymmetry that W = 15 removed.
- **P5.** The pooled p99-worse fraction lies within 0.5 ± 3 SE, and the between-run dispersion
  ratio is below 2.
- **P6 (if run).** AB-5xx power ≥ 0.9, median rollback tick between 15 and 45 (T2 at 5 events per
  arm per tick: medians 26, 27).
- **P7 (if run).** AB-lat power ≥ 0.8. No numeric median is predicted: the effect of a FIS network
  delay on the p99 of real traffic is not known here (§0 (d)4).

## 7. Void, NOT-EXECUTABLE, and abort rules

A **void** run is reported with its raw data and reason; none of its endpoints is scored except
through E2 and E3. It is replaced by the next run index. Void rules V1 to V5 are applied by the
runner from its record, mechanically; V6 and V7 from AWS event evidence.

- **V1 Metric gap.** A scored tick with `canary_requests` or `control_requests` equal to 0, or
  without the `p99_latency` observation. (The gate scores a gap as missing with a ½ wealth factor,
  which only lowers rollback evidence; counting gapped runs would make the A/A easier to pass.)
- **V2 Sample-ratio halt.** The scored session returns `halt`. Counted under E3 as well.
- **V3 Fetch failure (the CloudWatch equivalent of a scrape outage).** A window whose
  `GetMetricData` fails on all 3 attempts, or returns `Forbidden` or `InternalError`.
- **V4 Traffic floor.** A scored tick with fewer than 500 requests in either arm (half of R3), or
  fewer than 2 target 5xx events per scored tick on average over both arms (R4's floor, loosened
  to a fifth). The rate statistic conditions on the event total, so this rule does not select on
  its outcome.
- **V5 Runner or gate failure.** The runner exits before the run ends; any gate response other than
  2xx (the expected `409` after a terminal verdict excepted); the gate restarts (the session is
  voided `service_restart` or `twin_state_lost`); or a window is fetched more than 300 s after
  window end + 180 s (the host stalled; T2's lesson).
- **V6 Deploy action during the run.** Evidence in ECS service events, CodeDeploy, or CloudTrail of
  a deployment, scaling action, task-definition change, or forced redeploy on either arm between
  arm-ready and the run's end. A target that fails health checks and is replaced by ECS without any
  such action is not void: that is arm-level behaviour the test exists to see, and it is reported.
- **V7 Routing or traffic change.** CloudTrail evidence of a change to the listener rule, the
  weights, stickiness, or either target group's attributes during the run; or a change of traffic
  source the operator recorded before looking at the run's verdict (a new client, a routing rule
  elsewhere, another team's load test). A change in traffic level alone is not void: a shared
  surge or outage reaches both arms and cancels by conditioning (T1 ran a shared 5× outage).

A run whose fresh arms never reach arm-ready is a **deploy failure**: it produces no session,
counts as an attempt, and is not void or scored.

Not void, recorded and reported: AZ mixes that differ between arms despite R5, a target replaced
by ECS on a failed health check, shared traffic surges and outages.

**Study NOT EXECUTABLE** (reported, not scored):

- Any of R1 to R8 not met before run 0.
- 150 attempted AA runs (deploy failures included) without 100 executable ones.
- The engine pin, the gate build, or the runner changes between runs without a dated amendment;
  runs after the change are not executable.
- The runner or gate on the runner host reports an authority other than `"advisory"`.

**Abort.** The operator may stop the study at any time (OPERATOR.md, "Abort"). An aborted study is
reported with every run so far and no verdict on any endpoint whose run count is incomplete. A
partial AA cell is never scored against B at a smaller R.

## 8. What the operator records

Before run 0 (one study record): region; account id withheld from the repo; ALB and listener-rule
identifiers; the three target groups and w; target-group attributes; stickiness and cross-zone
settings; the old version's image digest (or AMI and artifact checksum) and its source commit;
task definition revision; launch type and platform version, or instance type; tasks per arm per
AZ; the traffic source and, for a load generator, its request mix and seed; whether both versions
return a deliberate 503 fraction (R4) and its value; `enableFaultInjection` if AB-lat is planned.

Per run: run index and lane; the image digest of each arm (must be equal in AA); both arms' task
ARNs and their AZs; arm-ready time; runner start and end; any ECS, CodeDeploy or CloudTrail events
in the window; AB fault settings (flag value, FIS template and experiment ids, d); the load
generator seed if any; the deploy SHA of the repo the runner and gate ran from. The runner records
its own commit, Node version, engine pin, a SHA-256 of the config, and every tick (§3.4).

Results: one JSON file per run under `results/runs/`, never overwritten, then a summary run
directory `results/run-<UTC>/` with `manifest.json`, `REPORT.md` and the endpoint table, written by
an analysis script committed before the first run it summarizes. The report states every
endpoint's number and verdict.

## 9. Ship rule

This study cannot move authority, whatever it shows.

If E1, E2 and E3 hold and the study is executable, the result may be cited as "no gross
false-rollback excess of the twin gate's rollback test on one real service under the three-target-
group topology, 60-tick bake, tier T3". That pass is **necessary and not sufficient** for rollback
authority. Authority needs its own ADR, which must at least address:

- power on a real service (E4 and E5 if run; otherwise other evidence, or the ADR says power is
  unmeasured);
- the proceed side, which this study does not test (`alpha_proceed` 1e-12);
- the resolution limit in §5 (0.05 against 0.10 is not separated);
- generality beyond one service, one region and one traffic source;
- the unverified premises of §0 (d), in particular per-request ALB routing and the ELB-5xx blind
  spot;
- the Argo and CodeDeploy paths, which this runner does not exercise.

Any failure of E1, E2 or E3: DORMANCY.md's Plan B entry records it, no authority ADR may cite this
study, and the failure is explained before any further T3 is designed.

## 10. Not measured

The proceed side; `allow_unequal_rate_split` at any split other than 0.5 (an opt-in there needs its
own A/A at that split); Prometheus sources; the Argo Rollouts experiment path; the CodeDeploy
`AfterAllowTraffic` hook; ELB-generated 5xx; services other than the one provided; bakes longer
than 60 ticks; tick lengths other than 60 s; and any false-rollback rate at a resolution finer than
§5 states.

## Amendment 1 — 2026-09-27, before run 0

Written after a review of PR #115 and before any run, any AWS resource, or any data. Nothing has
been measured. Where this amendment and §§0–10 differ, this amendment governs. The runner and
OPERATOR.md are changed after this commit, to match it.

- **(a) E2 counts every rollback and every abort.** E2 replaces §5's wording: the count is the
  rollbacks among executable AA runs, plus every void AA run in which **either** session (scored
  or W0) reached `rollback` at any tick, whatever its timing relative to the void, plus every AA
  run the operator aborted (§7 "Abort", OPERATOR.md), each counted as a rollback. Pass: at most 10.
  A run is counted once however many of these apply.
- **(b) Weights between runs; V7 covers only the run.** R6's "unchanged for the whole study"
  is replaced: between runs the operator may set the `baseline-old` and `canary-new` weights to 0,
  or register the new targets before deregistering the old ones, so that live traffic never
  reaches an empty target group. During a run (arm-ready to the runner's exit) the weights are
  equal and unchanged. Every weight change is recorded in the per-run record (§8) with its time
  and the CloudTrail event id. V7 voids a change to the listener rule, the weights, stickiness or
  target-group attributes only when it falls inside a run.
- **(c) Routing rules and lanes.** R6's "no listener rule routes by header, path, source or cookie
  to either arm" is replaced by "no listener rule routes to one arm and not the other". Lanes
  (§4) stay allowed, with a disclosure: parallel lanes share time, the region, the service's
  dependencies and possibly the load balancer, so runs in different lanes that overlap in time are
  not independent, and a shared cause can produce rollbacks in several at once. Report-only
  addition to §5: the rollbacks (E2's count) grouped by run start time, with the number of pairs
  of rollback runs that overlap in time against the number expected if rollbacks fell on runs at
  random (a permutation over the executed runs' start times, 10 000 draws, seed 20260926). All
  lanes run from one host and write to one results directory; the run index is checked globally,
  across lanes: a (cell, run index) already recorded in any lane is refused.
- **(d) Replay wording.** §3.3's deployed-configuration replay reads: at each tick, in order, the
  sample-ratio test (`srm_e ≥ 1000`, halt), then rollback (any metric's `rollback_e ≥
  rollback_threshold`), then proceed (every metric's `proceed_e ≥ 20`); the first tick at which one
  of these holds gives the verdict, and the order within a tick is that of the engine's `decide()`
  (`per-shard/twin-gate.ts:159-167` at v0.12.1-pre).
- **(e) V3 made exact.** V3 replaces §7's wording: a window is void (a) on its first
  authorization failure, without retry (an SDK error named `AccessDeniedException`,
  `AccessDenied`, `UnrecognizedClientException`, `InvalidClientTokenId`, `ExpiredTokenException`
  or `ExpiredToken`, or a query result with status `Forbidden`); or (b) when three attempts, 20 s
  apart, all fail with any other error (throttling, a timeout, a service 5xx, a query status
  `InternalError`). A window that succeeds on a retry is kept, and its attempts are recorded.
- **(f) Authority is a study-level flag.** A gate tick response with an authority other than
  `"advisory"` stops the run, is recorded as a distinct `authority` flag (not a V5 runner error),
  and makes the study NOT EXECUTABLE (§7), for every run from that one on.
- **(g) Operator discretion bounded.**
  1. The runner starts no later than 300 s after arm-ready. The operator passes arm-ready to the
     runner, which refuses a value more than 300 s in the past or more than 60 s in the future and
     records it. Window 0 is the first minute boundary after the runner starts.
  2. AB-5xx: the flag's 503 fraction is fixed and recorded before the first AB-5xx run, from the
     executable AA runs' pooled target 5xx rate (the fraction equals that rate, rounded to 4
     decimal places). It does not change within the cell.
  3. Each optional AB cell stops at 30 attempts (deploy failures included). Fewer than 20
     executable runs at that point makes the cell NOT EXECUTABLE; it is reported and not scored.
- **(h) Output is append-only.** §3.4 and §8 are made exact. Per run the runner creates, each with
  exclusive create (no file is ever rewritten): `<cell>-l<lane>-r<run>-<UTC>.jsonl`, one header
  line and then one line appended per window, holding the raw `GetMetricData` responses beside
  the transformed tick body and both sessions' responses; and `<…>.summary.json`, written once at
  exit or on SIGINT. During a run the runner prints progress (the window count) only; verdicts go
  only to the files, so the operator's records under (b) and V7 are made without seeing them.
- **(i) Code provenance.** The runner refuses to start if the git tree has a modified tracked file,
  except `tools/calibrate/_calibrate-constants.js`, which the build regenerates from its `.ts`
  source on every compile; its diff hash is recorded. The gate's build cannot be checked from the
  runner: `/healthz` reports no commit. R8 therefore adds: the gate is started from the same
  checkout as the runner, after the build, and the operator records its start time and the commit;
  the runner records the gate's `/healthz` body. The gate's commit is operator-attested, not
  verified.

## Amendment 2 — 2026-09-27, before run 0 (stall bursts)

Written after Amendment 1 and before any run, AWS resource or data. It adds measurements and a
report-only analysis; it changes no bar, endpoint, void rule or prediction.

**The finding.** In study `2026-09-twin-aa-local` run 1 (`results/run-20260927T050717Z/`, cell
`AB-rate-x2`, run 20, tick 13), the host slept for about 899 s (the tick's p99 on both arms is
898 676 ms and 898 676 ms). At wake the router's overdue timeouts fired as a batch, and a request
survived only if its arm's response reached the router first. The tick's upstream errors split
49 canary and 4 control, against 256 and 244 requests (`cell-AB-rate-x2.json`, fields `uc`, `uk`,
`nc`, `nk`; the split's z is 6.01, Amendment 1 (d) of that study). The coordinator's review
(item 4, 2026-09-27) puts the requests in flight at the stall at 65 canary and 63 control; the
recorded data holds per-tick totals, not in-flight counts, so that figure is not checked here.
The rate statistic read the burst as 53 independent events: that run's `http_5xx` rollback e-value
went from 3.61 at tick 12 to 4.96 at tick 13 (the tick responses' `m` field).

A pause in shared infrastructure (a load balancer or proxy node's GC pause, CPU throttling, a VM
live migration) can do the same on a real service: one common cause, many correlated errors,
split unevenly between the arms by timing. That is a premise boundary for the `rate` kind. ADR
0036's rollback null treats bad events within an arm-tick as draws allocated between the arms at
random given the totals; a correlated burst allocated by a timing race is outside it.

- **(a) Per-tick measurements.** Each window's record gains, per arm (target group), from one
  extra `GetMetricData` call on the same client:
  - `TargetResponseTime` **Maximum** and **p99** (seconds);
  - `HTTPCode_Target_5XX_Count` Sum (already in the tick body as the rate observation's events,
    and recorded again here from the raw response);
  - `TargetConnectionErrorCount` Sum: connections from the ALB to the arm's targets that failed.
    It is the nearest per-target-group equivalent of T2's upstream errors.

  Per load balancer only, since ALB does not publish them per target group:
  `HTTPCode_ELB_5XX_Count` and `HTTPCode_ELB_504_Count` Sum. Requests the ALB times out or cannot
  forward (ELB 502/504) cannot be assigned to an arm from CloudWatch; §0 (d)2 already names that
  gap. The per-load-balancer counts include `prod-old`'s traffic.

  An absent datapoint is recorded as `null`, not zero, except for the count metrics, which ALB does
  not publish when zero; those are recorded as the raw empty series beside the transformed value.

  The operator records the ALB's idle timeout (`idle_timeout.timeout_seconds`, default 60 s) and,
  for a load generator, its client timeout, before run 0 (§8). The runner's config carries the
  idle timeout so each run file holds it.
- **(b) Report-only stall-burst analysis** (no bar, no verdict, no effect on any endpoint or void
  rule). A **stall tick** is a scored or W0 tick in which either arm's `TargetResponseTime`
  Maximum is at least half the recorded idle timeout, or the load balancer's
  `HTTPCode_ELB_504_Count` is above 0. Half the timeout, not the full timeout, because a request
  the ALB times out is answered with a 504 and may not reach `TargetResponseTime` at all. For each
  stall tick the report lists: run, lane, tick; both arms' Maximum and p99; both arms' target 5xx
  and connection-error counts; the ELB 5xx and 504 counts; the canary's share of the tick's target
  5xx against its traffic share, with z = (canary 5xx − E·s) / √(E·s·(1 − s)) for E the tick's
  target 5xx total and s the canary's request share (not defined for E = 0); and the tick's
  contribution to the `http_5xx` rollback e-value, ln(rollback_e at the tick / rollback_e at the
  previous tick) from the gate responses. For every AA run that rolled back (E2's count), the
  report states whether its crossing tick, or the tick before it, was a stall tick.
- **(c) Stall bursts count.** A false rollback driven by a stall burst **counts** under E1 and E2
  like any other. A stall is not a void condition (V1–V7 are unchanged): a pause in shared
  infrastructure is part of the real environment an authority ADR would face. The analysis in (b)
  attributes a rollback to a stall; it never excuses one, never removes a run, and never changes a
  verdict.

## Amendment 3 — 2026-09-28, before run 0 (re-pin; unforeseen execution failures)

Written before any run, AWS resource or data. Nothing has been measured. It changes no bar,
endpoint, prediction or existing void rule.

- **(a) Re-pin.** The runs execute from the DeploySignal commit on `main` that carries this
  amendment, or a later one reached only by a further dated amendment, with the engine at
  `v0.12.2-pre`, resolved `0434afcdc7a4716788dc81427295c6c4cd14e019` (package-lock.json). The
  changes on the twin path since the registration's `9c689ba` and `v0.12.1-pre`:
  1. Each entry of a tick response's `metrics[]` gains `detector_id`, the engine registry id
     `twin_<kind>_<id>` (DeploySignal #119). The runner stores responses verbatim (Amendment 1 (h))
     and reads `verdict` and `tick` only (`harness/run-real.mjs`), so the added field changes
     nothing it scores.
  2. The engine adds `DETECTOR_KINDS.twin` to its registry (engine #107). No file under the
     engine's `per-shard/` or `detectors/` differs between `v0.12.1-pre` and `v0.12.2-pre`, so
     the references to `per-shard/twin-gate.ts` at `v0.12.1-pre` in §2 and Amendment 1 (d) hold
     unchanged.

  DeploySignal changes off the twin path (Family B authority #118, the browser bundle #121, the
  artifact policy gate #123) do not reach a `mode: "twin"` session: the gate service steps the twin
  arm directly (`service/gate-http/_gate-twin.ts`, `stepTwinArm`) and runs no rule table.
- **(b) Unforeseen execution failures.** Pre-registration rule 7 was widened on 2026-09-28
  (knowledge `methodology/pre-registration-discipline`). For this study it reads:
  1. A failure that V1–V7, §7's NOT-EXECUTABLE conditions and Amendments 1–2 do not cover may void
     a run only on evidence independent of the gate responses and of every endpoint: AWS events
     (CloudTrail, ECS service events, AWS Health), the runner's or the host's logs, or CloudWatch
     series the gate does not read. A verdict, an e-value, or a 5xx count is never such evidence.
  2. Before the next run, a dated amendment adds the failure as a void rule the runner or the
     operator can apply mechanically, and applies it to every run already executed and every later
     run, whatever each run's verdict.
  3. A run voided that way stays in E2's count if either of its sessions reached `rollback`
     (Amendment 1 (a)), so a void rule added mid-study can never remove a rollback from E2.
  4. A voided run is replaced by the next run index (§7), inside the 150-attempt cap. It is not
     repeated under its own index.

# Pre-registration — the twin gate's real-service A/A on a onebox pair, with the pair in the same AZ and across AZs (`2026-10-twin-aa-onebox`, T3)

- **Study id:** `2026-10-twin-aa-onebox`
- **Status: REGISTERED, NOT RUN.** Written before any harness, service or infrastructure change for
  this study, while `2026-10-twin-fault-shapes`'s third cell is running. A later change is a dated
  amendment, appended, before the run it affects.
- **What it serves:** the deployment model the gate has to fit (John, 2026-10-02: "rollouts are
  nearly always staggered, and should be deployed to a onebox first in each region"; "regions will
  vary anyway … AZs should match, but often times they are not completely identical either").
  A onebox canary is one host per arm. The two real-service A/As ran two tasks per arm (E1 FAIL
  12/44 on a 1 ms service without a margin) and four (E1 PASS 0/100 on a 76 ms service with a 10%
  margin). One task per arm is the size at which host-level and AZ-level differences are largest
  and it has not been measured. ADR 0001's eligibility rule needs it.
- **Inherits, by reference and unchanged:** `studies/twin-aa-real-2/PREREGISTRATION.md` with its
  Amendment 1, and through it `studies/twin-aa-real/PREREGISTRATION.md` with Amendments 1–3 — the
  service at a p99 of about 76 ms (seeded lognormal delay, median 30 ms, σ 0.4), the 0.5% 503
  fraction in every arm, the metric table with `p99_latency` `margin: { relative: 0.10 }`, the
  three-target-group topology with equal arm weights, 60 s ticks, W = 15, T = 60, the scored and W0
  sessions, global run indices, void rules V1–V8, NOT-EXECUTABLE and abort, records, the
  observe-only runner. Only what this document states differs.

## 0. Disclosures

- (a) Known at registration: both earlier A/As and their post-hoc replay (without the margin the
  second study's 100 runs give 1 rollback; the latency scale and the task count, not the margin,
  account for most of the change from the first study); the fault study's first two cells (20/20
  each). The design below is chosen knowing that the first study's failure was a small-arm,
  fast-service effect.
- (b) The comparison is always **within a region**: a canary onebox against a baseline onebox on
  the old version in the same region. Nothing here compares regions, and the study has one region
  (us-east-1, two AZs). Regional variation is therefore not measured; it is cancelled by design as
  long as both oneboxes are in one region, and that is the only claim made about it.
- (c) "Onebox" here is one Fargate task (0.25 vCPU, 0.5 GB) per arm on a synthetic service. It is
  not a production host. The operator is the author; `TWIN_ARM_AUTHORITY` stays `advisory`.
- (d) A onebox canary against the whole old fleet is an unequal split and is **not** this study:
  the engine refuses the `sign` kind at unequal weights (T1: false rollback 1.000) and measured
  0.755 for the `rate` kind at weight 0.1 with arm-level noise. The topology stays a canary onebox
  beside a baseline onebox at equal weights, the rest of the traffic on `prod-old`.

## 1. What changes

### 1.1 One task per arm (R5 as amended for this study)

`baseline-old` and `canary-new` run **one** task each, the same task-definition revision, started
within 60 s of each other (`rotate-arms.sh start --tasks 1`; `tasks_per_arm: 1` in each lane
config). `prod-old` is unchanged at two tasks. Each arm then carries about 1,220 requests and 6
target 5xx per tick on a single task.

### 1.2 Where each onebox sits: two strata, fixed per lane

Each arm's service is pinned to one subnet (one AZ) by lane-stack parameters, so the pair's
placement is designed and recorded, not left to the scheduler:

| Lane | Baseline onebox | Canary onebox | Stratum |
|---|---|---|---|
| 0 | us-east-1a | us-east-1a | **S (same AZ)** |
| 1 | us-east-1b | us-east-1b | **S (same AZ)** |
| 2 | us-east-1a | us-east-1b | **X (across AZs)** |
| 3 | us-east-1b | us-east-1a | **X (across AZs)** |

Stratum X assigns the canary to each AZ once, so an AZ-level difference does not line up with the
arm role across the stratum. The load balancer stays in both AZs with cross-zone on. Each run's
task record (the driver's `tasks` line) carries both tasks' AZs; a run whose tasks are not in its
lane's registered AZs is void (**V10**), applied mechanically by the analysis script.

### 1.3 Size

25 runs per lane: **50 executable runs in S and 50 in X**. A/A bar at R = 50, as in the earlier
studies' formula: B = 0.05 + 2.58 · √(0.05 · 0.95 / 50) = **0.1295**, at most **6 of 50**. Each
stratum stops early, with its endpoint failed, at 7 executable rollbacks; the other stratum
continues. 75 attempts cap per stratum.

What R = 50 resolves: the chance the count exceeds 6 is 0.012 at a true rate of 0.05, 0.23 at
0.10, 0.64 at 0.15, 0.90 at 0.20 and 0.99 at 0.27 (the first study's rate). The one-sided 95%
upper bound after 0, 2 and 6 rollbacks in 50 is 0.058, 0.121 and 0.223. A pass says the rate is
not grossly above α for that stratum; it is weaker than the second study's 0 of 100.

## 2. Endpoints

- **O1 (same AZ).** False-rollback count in stratum S (scored session, either metric) ≤ 6 of 50.
- **O2 (across AZs).** The same in stratum X, ≤ 6 of 50. Its own endpoint, not pooled with O1.
- **O3.** Sample-ratio halts in at most 2 attempted runs over the study.
- **O4 (sensitivity).** In each stratum, rollbacks among executable runs plus rollbacks reached in
  void runs: at most 6.

Report-only, per stratum: rollbacks by detector; the per-run share of scored ticks with canary p99
above control p99, unmargined and beyond the 10% margin; the per-run median p99 of each arm and
their ratio; the W0 session; and a replay of every run's stored scored ticks through the gate with
the margin at 0 and 0.05 (`analysis/replay.mjs`, committed before run 0 — in the second study the
replay was post-hoc; here its script is registered, its numbers still carry no verdict).

## 3. Predictions (registered)

- **R1.** O1 holds with 0 to 3 rollbacks. One task per arm puts back the host-level differences
  the second study averaged over four tasks, but at a 76 ms p99 the first study's offsets
  (0.01–2 ms) are under 3% and the margin is 10%. Confidence moderate.
- **R2.** O2 holds with 0 to 5 rollbacks; confidence low. I have no measurement of the
  cross-AZ p99 difference for a single task at this scale. If AZ-level offsets reach a tenth of
  the p99, this stratum fails and lane 2 and lane 3 fail in opposite directions of the same AZ
  difference (one rolls back often, the other never).
- **R3.** The unmargined replay gives more rollbacks than the second study's 1 of 100: 3 to 15 of
  50 in S and more in X, i.e. the margin does real work at this arm size.
- **R4.** O3 holds with 0 halts.
- **R5.** `twin_rate_http_5xx` fires in at most 2 of the 100 runs.

## 4. What each outcome would mean (for ADR 0001's eligibility rule)

- O1 and O2 hold: a onebox pair at equal weights, margin 10%, is within the measured conditions
  whether or not the pair shares an AZ, at this service's scale.
- O1 holds, O2 fails: the eligibility rule requires the canary and baseline oneboxes in the same
  AZ, and says so.
- O1 fails: one task per arm is outside the measured conditions even with the margin; the rule
  states a minimum arm size from the second study (four) and the per-service qualification is the
  only route for a onebox.
- R3 (the unmargined replay) decides how the ADR describes the margin: required at onebox size,
  or insurance as at four tasks.

## 5. Void, NOT-EXECUTABLE, abort

As inherited (V1–V8), plus V10 (§1.2). A onebox arm has no redundancy: a task that fails its
health check leaves its arm empty until ECS replaces it. Such a run is void under V1 (a scored
tick with zero requests in an arm) or V4, as registered; the count of such runs is reported per
stratum and not replaced beyond the attempt cap.

## 6. Pins (to be completed by a dated amendment before run 0)

Engine tag and resolved SHA; the tree hashes of the runner, analysis, gate service, sources,
engine gates and service source; the image digest; the lane parameters (subnet pinning per lane);
the lane configs. The runner is the second study's with the study id and `tasks_per_arm` 1; the
analysis and replay scripts are committed before run 0.

## 7. Ship rule

None of its own; it cannot move authority. Its endpoints set the arm-size and placement clauses of
ADR 0001's eligibility rule, stratum by stratum.

## 8. Not measured

Regions (one region; §0 (b)); a production host; a onebox against the whole fleet (§0 (d)); more
than two AZs; power at onebox size (the fault study ran four tasks per arm); the proceed side;
arm sizes two and three with the margin.

## Amendment 1 — 2026-10-02, before any code, deploy or run (the size: 100 per stratum)

John, 2026-10-02, on being shown what each size resolves: "let's do option 1" (100 runs per
stratum). §1.3 chose 50 per stratum to keep the study at 35 hours, a budget choice the registration
made without asking. Nothing has been built, deployed or run. This amendment replaces every size
and bar that followed from 50; nothing else changes.

- **Size (replaces §1.3).** 50 runs per lane: **100 executable runs in S and 100 in X**, 200 in
  all. A/A bar at R = 100, as in both earlier studies: B = 0.05 + 2.58 · √(0.05 · 0.95 / 100) =
  **0.1062**, at most **10 of 100**. Each stratum stops early, with its endpoint failed, at 11
  executable rollbacks; the other continues. 150 attempts cap per stratum.
- **What R = 100 resolves.** The chance the count exceeds 10 is 0.011 at a true rate of 0.05,
  0.176 at 0.08, 0.417 at 0.10, 0.666 at 0.12, 0.901 at 0.15 and 0.994 at 0.20. The one-sided 95%
  upper bound after 0, 2, 5 and 10 rollbacks in 100 is 0.030, 0.062, 0.102 and 0.164. Each
  stratum is then directly comparable to `2026-10-twin-aa-real-2` (0 of 100 at four tasks per arm).
- **Endpoints (replace the counts in §2).** O1: ≤ 10 of 100 in S. O2: ≤ 10 of 100 in X. O3
  unchanged (≤ 2 halts over the study). O4: in each stratum, rollbacks among executable runs plus
  rollbacks reached in void runs, at most 10.
- **Predictions (replace the counts in §3; the reasoning stands).** R1: O1 holds with 0 to 5
  rollbacks. R2: O2 holds with 0 to 9, confidence low. R3: the unmargined replay gives 6 to 30 of
  100 in S and more in X. R5: `twin_rate_http_5xx` fires in at most 3 of the 200 runs.
- **Time and cost, for the record.** About 70 hours on four lanes; about $28 gross at list prices
  (8 arm tasks, the lanes' base cost, CloudWatch reads).

## Amendment 2 — 2026-10-02, before run 0 (the pins, §6)

Written before any run, lane deploy or host change for this study, while
`2026-10-twin-fault-shapes`'s third cell is running. It changes no bar, endpoint, prediction or
void rule.

- **Engine.** `v0.13.0-pre`, resolved `de25786c0a6b15935aa9416b04359f6a3e309106`, unchanged from the
  second study and the fault study.
- **The trees the runs execute from.** The runner host runs DeploySignal `main` at `375c165` (PR #149)
  or a later `main` commit whose git tree hashes at every path below are identical; the report
  verifies each against the run commit recorded in every run's manifest:

  | Path | Tree at `375c165` |
  |---|---|
  | `studies/twin-aa-onebox/harness` | `c1eb4f1fa6a0c4407d32cfec81279ad53c70abcd` |
  | `studies/twin-aa-onebox/analysis` | `4bb5c8682fa2c478f78a131688fc2543c7eb4a6b` |
  | `service/gate-http` | `5e0f86e3a05d9165e18009299f7010a7d451529e` |
  | `service/sources` | `c10785a9612812b4c7b063c6f10d93b008918523` |
  | `engine/gates` | `7eb52c902cbde9c37fd982b5552533f8011042a2` |
  | `engine/guarantees.ts` | `c99401c57fa2a5a048e8598d9786a06d5e700e1f` |
  | `studies/twin-aa-real/infra/service` | `6f65c09e3cd4444fc47a470debf1372638d0b5c4` |

  The gate is restarted from the run commit and its start time and `git rev-parse HEAD` recorded,
  after the fault study's last cell has closed and its artifacts are pulled.
- **Service image (R2).** `twin-aa-service:old-v3-20261001` = `sha256:11b0f047493f6df41ad82612c6f111a7fa508a7392d18fe81a6150d41997ea30`,
  the fault study's image (service tree `6f65c09e…`), with every canary override empty: both arms
  and prod on one task-definition revision, `FAULT_503_FRACTION` 0.005, `LATENCY_MEDIAN_MS` 30,
  `LATENCY_SIGMA` 0.4, `RESET_FRACTION` unset (0).
- **Placement per lane** (lane template at `375c165`; the network stack's subnet list is
  `us-east-1a`, `us-east-1b` in that order, read 2026-10-02):

  | Lane | `BaselineSubnetIndex` | `CanarySubnetIndex` | Stratum |
  |---|---|---|---|
  | 0 | 0 (1a) | 0 (1a) | S |
  | 1 | 1 (1b) | 1 (1b) | S |
  | 2 | 0 (1a) | 1 (1b) | X |
  | 3 | 1 (1b) | 0 (1a) | X |

- **Lane configs and drivers.** `studies/twin-aa-onebox/lane<N>.json` = the second study's with
  `study_id` `2026-10-twin-aa-onebox` and `tasks_per_arm` 1;
  `RUNNER=studies/twin-aa-onebox/harness/run-real.mjs ALLOW_ONEBOX=1 drive-lane.sh --cell AA
  --tasks 1 --runs 50` per lane, global run indices continuing after the fault study's last. The
  per-stratum stop (11 executable rollbacks) is applied by the operator's watcher, which stops that
  stratum's two drivers; a run in flight at the stop finishes and is counted.
- **Pre-flight.** One rotation at one task per arm on a same-AZ lane and one on a cross-AZ lane
  (not runs), to read R3, R4, the p99 scale and both tasks' AZs before run 0.

## Amendment 3 — 2026-10-03, before run 0 (the analysis script's V6/V7 attribution)

Written before any run, deploy or host change for this study. It changes no bar, endpoint or
prediction. It changes how one void rule is applied and re-pins the analysis tree.

- **Why.** `2026-10-twin-fault-shapes` run 260 was voided by the analysis rule this study inherited:
  an ECS `TaskCreated` event (which names no lane) three seconds after lane 1's arm-ready was
  attributed to lane 1 by the nearest preceding `scale` within 120 s, while the surrounding events
  (lane 0's `RegisterTargets` nineteen seconds later, lane 1's 4 / 4 healthy targets in every window)
  put the task on lane 0's scale-up. Two lanes' scale-ups overlap whenever runs finish within a
  minute of each other, which they do.
- **The rule (V6/V7).** Only CloudTrail write events that name the lane's resources — its listener,
  its target groups, its cluster and services — decide a void. Lane-less events inside a run's
  interval are listed in the run's record and the report, and decide nothing. A task that ECS
  replaces within a run still registers on the lane's own target group, which names the lane, and
  §7 of the first registration already says such a replacement is reported, not void.
- **Pin.** `studies/twin-aa-onebox/analysis` tree `c1d97cf0e3e3ee4fe964fbba8cf0b071611d6e9c`
  (DeploySignal `main` `4a11c74`, PR #159) replaces Amendment 2's `4bb5c868…`. Every other tree in
  Amendment 2's table is unchanged at `4a11c74`; the runs execute from `4a11c74` or a later `main`
  commit whose trees match.

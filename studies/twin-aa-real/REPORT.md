# Report — the twin gate's real-service A/A (`2026-10-twin-aa-real`, AA cell, T3)

- **Study id:** `2026-10-twin-aa-real`. Register: knowledge `WORKLIST.md` C84 (T3 line).
- **Registration:** `PREREGISTRATION.md` at `54e6be5`, Amendments 1–3 (`9d5078d`, `5a345f2`, `ef7a5ab`),
  all before run 0. Verdicts below are recorded **as computed**; no bar was moved.
- **Runs:** 44 executable AA runs, 2026-09-29 06:20:55Z (first arm-ready) to 19:56:30Z (last runner
  exit), four lanes on one internal ALB per lane in us-east-1, two Fargate tasks per arm, one per AZ.
  Runner `harness/run-real.mjs` at repo `61794dc` (tolerated dirt: `tools/calibrate/_calibrate-constants.js`
  only), engine pin `v0.12.2-pre` resolved `0434afcd…`, Node v24.21.0, gate `service/gate-http` from the
  same checkout (started 03:53:54Z, `/healthz` `ok` on every run). Per-run files
  `results/runs/AA-l<lane>-r<k>-<UTC>.{jsonl,summary.json}`, never rewritten; driver logs
  `results/operator/runs/`; CloudTrail evidence `results/evidence/cloudtrail-write-events.json`;
  analysis `results/run-20260929T200357Z/` (`analysis/analyze.mjs`).
- **Stopped by the registered rule** at 18:47:54Z, when the eleventh executable rollback closed
  (§5: "stops early, with E1 failed, once 11 executable runs have rolled back"). Three runs in flight
  at that moment (60, 61, 62) ran to their own end and are counted; one of them rolled back.

## 0. The headline

**E1: FAIL.** 12 of 44 executable runs ended `rollback` (rate **0.2727**; one-sided 95% bounds
0.166–0.404) against a bar of at most 10 in 100 (B 0.1062). **E2: FAIL** (12 > 10). **E3: PASS**
(0 sample-ratio halts in 63 attempts). Registered predictions: P1 not held, P2 not held, P3 held,
P4 not held (the W0 session rolled back in 14 of 44).

**Every rollback is the `p99_latency` sign detector.** `twin_sign_p99_latency` reached its
threshold (40 = 2/α) in all 12; `twin_rate_http_5xx` fired in none (final-tick e-values
0.90–1.00), and the sample-ratio guard's e-value stayed within 0.99–1.04 throughout.

| Lane | Attempts | Executable | Rollback | Hold |
|---|---|---|---|---|
| 0 | 18 | 11 | 3 | 8 |
| 1 | 16 | 11 | 4 | 7 |
| 2 | 15 | 11 | 3 | 8 |
| 3 | 14 | 11 | 2 | 9 |

| Rollback run | Lane | Scored tick | W0 tick | Fired | Canary-worse share |
|---|---|---|---|---|---|
| 26 | 3 | 19 | 32 | `twin_sign_p99_latency` | 0.842 |
| 29 | 1 | 11 | 13 | `twin_sign_p99_latency` | 1.000 |
| 32 | 3 | 13 | 27 | `twin_sign_p99_latency` | 0.923 |
| 35 | 2 | 11 | 21 | `twin_sign_p99_latency` | 1.000 |
| 39 | 0 | 14 | 13 | `twin_sign_p99_latency` | 0.929 |
| 44 | 1 | 13 | 22 | `twin_sign_p99_latency` | 0.923 |
| 45 | 2 | 33 | 32 | `twin_sign_p99_latency` | 0.758 |
| 47 | 1 | 13 | 17 | `twin_sign_p99_latency` | 0.923 |
| 54 | 1 | 48 | 62 | `twin_sign_p99_latency` | 0.729 |
| 57 | 2 | 11 | 16 | `twin_sign_p99_latency` | 1.000 |
| 59 | 0 | 31 | 41 | `twin_sign_p99_latency` | 0.774 |
| 62 | 0 | 23 | 16 | `twin_sign_p99_latency` | 0.826 |

Median scored rollback tick 14 (range 11–48) of a 60-tick bake. "Canary-worse share" is the
fraction of the scored ticks the session used on which the canary's CloudWatch p99 was above the
control's (post-hoc descriptive, computed by `analyze.mjs` from the stored tick bodies).

## 1. Endpoints (§5), as registered

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 12/44 = 0.2727 (0.166–0.404) | **FAIL** |
| E2 sensitivity count (rollbacks + rollbacks in voided runs + aborts) | ≤ 10 | 12 | **FAIL** |
| E3 sample-ratio halts | ≤ 2 of attempted | 0 of 63 | PASS |

Executable 44, void 0, deploy failures 17, attempts interrupted before arm-ready 2 (§2), authority
violations 0 (every response `advisory`), runs with an unhealthy target 0, ECS task replacements 0.
V6/V7 evaluated on 44 of 44 runs from the CloudTrail file: no write event on a lane's listener,
target groups or services inside any run's (arm-ready, runner-exit) interval. The 757 write events
over the cell come from three identities only: the operator instance's role, ECS's service-linked
role, and `ecs.amazonaws.com`.

Traffic: 1,217 requests per minute per arm on average (canary 1,217, control 1,218), 6.08 / 6.09
target 5xx per tick, pooled target 5xx rate **0.0050** (26,304 of 5,259,682 requests over every
scored tick), both arms equal to four decimals. R3 and R4 held on every tick (no V4 void).

## 2. What happened during the cell, in order

- **Run indices 0–18 are attempts with no run.** The first driver start (05:44Z) failed on every
  rotation: the operator instance's role allowed `ecs:UpdateService` only under a
  `aws:cloudformation:stack-name` tag that CloudFormation puts on listeners but not on ECS services.
  Indices 0–16 are logged deploy failures (rc 254, `AccessDeniedException`); 17 and 18 were
  interrupted between `attempt` and the failure line when the drivers were killed. No arm task
  started, no runner started. Fix: PR #134 (`e3b62b1`, UpdateService scoped by service ARN), the
  operator stack updated in place; a dry rotation on lane 0 (06:19:43Z–06:20:31Z, not a run)
  confirmed it. Indices are global and never repeated (§4), so the cell runs from index 19.
- **Runs 19–59** executed from 06:20:44Z under four drivers with a shared index file. Every runner
  exited 0; every run completed its 75 windows or reached a terminal verdict; no void rule fired.
- **The stop rule tripped at 18:47:54Z** when runs 57 and 59 (the tenth and eleventh rollbacks)
  closed in the same poll. The drivers were killed so no new attempt started. Lane 1's run 58 had
  exited 17 s earlier; its driver was killed after the tasks-and-stop step and before the CloudTrail
  step, which was done by hand (recorded in that run's log). Runs 60, 61 and 62 were in flight and
  ran to their own end (19:19Z, 19:58Z, 19:31Z), closed by hand in the same order the driver uses.
  Run 62 rolled back (the twelfth); 60 and 61 held in the scored session and rolled back in W0.

## 3. Post-hoc observations (no verdict)

**The arms are seldom exchangeable in p99 latency, and the direction is set per deployment.**
Over the ticks the scored session used, the canary's p99 exceeded the control's on 73–100% of
ticks in the 12 rollback runs, and on 0–68% (median 0.300) of ticks in the 32 holds: in 10 holds
the share was at most 0.2, i.e. the canary was persistently *better* and only the one-sided test
kept the run from firing. Two fresh Fargate tasks per arm, one per AZ, on the same task definition
and image, differ by 0.01–2 ms at a p99 of about 1 ms, and the difference holds for the length of
a run. This is the arm-level state ADR 0036's premise excludes ("no arm-level effect on any tick"),
the case the registration flagged as its low-confidence prediction for the latency metric (§6 P1),
and the mechanism the mini study (`stats/mini-twin-aa-2026-09-29`) showed on cores.

**The sign kind carries no magnitude.** A tick scores "canary worse" whenever the canary's value is
above the control's by any amount (engine `detectors/twin-contrast.ts:154-155`, `x: worse ? 1 : 0`,
rollback null ½); the tolerance parameter bounds the proceed side only. A persistent offset of any
size therefore reaches 2/α in about 11 ticks.

**A relative margin scan on the stored p99 pairs** (design input for a margin ADR, not a verdict):
counting a tick as worse only when canary > control × (1 + m), the number of the 44 runs whose
canary-worse share is at least 0.65 is 15 at m = 0, 8 at 0.05, 6 at 0.10, 3 at 0.25, 1 at 0.50 and
0 at 1.00. On a 1 ms service a 25% margin is 0.25 ms; whether a margin at SLO scale suffices on a
slower service is unmeasured.

**The `rate` kind on 5xx behaved as registered:** no fire in 44 runs, e-values within 0.90–1.00,
with the two arms' 5xx rates equal to four decimals. This is the prediction the registration held
with confidence (§6 P1, `http_5xx`).

## 4. Deviations, stated

- **The analysis script was written after the runs.** §8 asks for it to be committed before the
  first run it summarizes. `analysis/analyze.mjs` counts fields the runner and the driver wrote
  before it existed (verdicts, ticks, void reasons, times) and applies the registered bars; it moves
  nothing. The CloudTrail evidence file was pulled after the cell (20:00Z) over 05:40Z–20:10Z.
- **The runs executed from `61794dc`, not the Amendment 3 commit `ef7a5ab`,** and no dated amendment
  names `61794dc`. Between the two, the twin path (`service/gate-http`, `service/sources`,
  `engine/gates`, `studies/twin-aa-real/harness`, the engine pin) differs only in
  `service/gate-http/README.md` (+13 lines). Nothing changed between runs.
- **The driver's own CloudTrail lookup is account-wide** (`infra/scripts/rotate-arms.sh:91`) and runs
  120 s after the stop, so its lines show other lanes' rotations and sometimes miss the lane's own
  stop events. It is the operator's contemporaneous note; the evidence of record is the per-lane
  assignment in `results/evidence/` and `analyze.mjs`'s V6/V7 pass (§1).
- **Cell size:** 44 executable of the registered 100, ended by the registered stop rule, not by
  abort. E1's verdict cannot change at 100 (§5).

## 5. What this establishes, and what it does not

Established (T3, one service, one region, one traffic source, two tasks per arm, 60-tick bake):
the twin gate's `sign` kind on CloudWatch p99 latency false-rolls-back at about 0.27 per run on a
real ALB service under per-request weighted routing, because fresh task pairs carry a persistent
latency offset the test has no magnitude to ignore; the `rate` kind on target 5xx produced no false
rollback in 44 runs; the sample-ratio guard never fired. Under §9, no authority ADR may cite this
study, DORMANCY.md's Plan B entry records the failure, and the failure is explained (§3) before
any further T3 is designed.

Not measured: power (AB-5xx and AB-lat did not run; AB-5xx follows this report, §4 of the
registration); the proceed side (`alpha_proceed` 1e-12); more than two tasks per arm; a service
with a p99 above about 1 ms; the `sign` kind with any margin; Prometheus sources; the Argo and
CodeDeploy paths; ELB-generated 5xx.

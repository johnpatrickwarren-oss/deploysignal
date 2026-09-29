# Pre-registration — the twin gate's real-service A/A, second registration: a margin on the sign kind, a slower service, four tasks per arm (`2026-10-twin-aa-real-2`, T3)

- **Study id:** `2026-10-twin-aa-real-2`
- **Status: REGISTERED, NOT RUN.** Written before any harness, service or infrastructure change
  for this study. A later change is a dated amendment, appended, before the run it affects.
- **What it serves:** the condition `2026-10-twin-aa-real` (`studies/twin-aa-real/REPORT.md`,
  2026-09-29) failed and its report set: whether the twin gate's `sign` kind on p99 latency, with
  a declared margin (engine ADR 0037), keeps its false-rollback bound on a real ALB service whose
  p99 sits well above task-placement noise, with more than two tasks per arm; and whether the
  `rate` kind on 5xx stays clean under the same conditions.
- **Inherits, by reference and unchanged:** `studies/twin-aa-real/PREREGISTRATION.md` with
  Amendments 1–3 — §1 R1–R8 (with R5's task count as amended below), §2 topology, §3.1 metrics
  and source, §3.2 ticks / warm-up W = 15 / bake T = 60, §3.3 sessions (scored and W0), §3.4 tick
  record, §3.5 observe-only runner, §4 lanes and global run indices, §5 endpoints E1–E3 and bars
  (R = 100, B = 0.1062, stop at 11 rollbacks), §7 void rules V1–V7, NOT-EXECUTABLE and abort, §8
  records, §9 ship rule, §10 not measured. Only what this document states differs.

## 0. Disclosures

- (a) The previous cell's result is known: 12 of 44 A/A runs rolled back, all on
  `twin_sign_p99_latency`, on a synthetic service with a p99 of about 1 ms and two Fargate tasks
  per arm; the 5xx rate kind fired in none. The margin below was designed from its stored p99
  pairs (engine study `2026-10-twin-sign-margin`, replay: 12/44 → 2/44 at a 10% relative margin →
  0/44 at 25%). That replay is post-hoc by construction; this study is the confirmatory test on
  fresh runs and a changed service, and its prediction is registered here before any of them.
- (b) Three things change at once from the first registration: the margin, the service's latency
  scale and the task count per arm. If E1 holds, the study does not say which change did it; the
  report says so. If E1 fails, §6 names what would be learned.
- (c) The first registration's §8 asked for the analysis script before the first run it
  summarizes; the first study wrote it after. This study commits `analysis/analyze.mjs` (the first
  study's script, moved and pointed at this study's directories, with the bars unchanged) **before
  run 0**, and the report says whether that held.
- (d) The operator is the author (John's AWS account, one region); the runner is observe-only as
  before; `TWIN_ARM_AUTHORITY` stays `advisory` whatever the result.

## 1. What changes

### 1.1 The service (`studies/twin-aa-real/infra/service/server.mjs`, one image, both arms)

Each non-health request waits a seeded lognormal delay before replying, on top of the existing
small CPU work: delay = `LATENCY_MEDIAN_MS · exp(LATENCY_SIGMA · z)`, z from a per-process
deterministic generator (mulberry32 seeded from `ARM` and the process start time, recorded in the
`/healthz` body), `LATENCY_MEDIAN_MS` = 30, `LATENCY_SIGMA` = 0.4. Expected per-request p99 ≈
30 · e^(0.4 · 2.326) ≈ 76 ms; the ALB's per-minute `TargetResponseTime` p99 per target group is
then about 70–80 ms, against which the first study's placement offsets (0.01–2 ms) are 0.01–3%.
The 503 fraction stays at 0.005 in every arm (R4, disclosed as before). Same digest in both arms.

### 1.2 Tasks per arm (R5 as amended)

Four tasks per arm, two per AZ (`rotate-arms.sh start --tasks 4`; `tasks_per_arm: 4` in each lane
config). Both arms still start within 60 s of each other on the same task-definition revision.
`prod-old` is unchanged. Per-request routing across four targets per arm averages four placement
offsets instead of two.

### 1.3 The p99 metric (§3.1 as amended)

| twin metric | kind | per arm | worse | tolerance | margin |
|---|---|---|---|---|---|
| `http_5xx` | rate | as before | higher | 0.2 | — |
| `p99_latency` | sign | `TargetResponseTime` p99 | higher | 0.15 | `{ relative: 0.10 }` |

A tick scores "canary worse" only when the canary's p99 exceeds the control's by more than 10%
(engine `detectors/twin-contrast.ts`, ADR 0037). The margin is declared in the lane config's
`twin_arm.metrics[]` and passed through DeploySignal's gate service (PR #136). Why 0.10: on the
first study's pairs it removed 10 of the 12 rollbacks; on a service whose p99 is 70× larger, the
same absolute offsets are far inside it; it is also a regression an operator would notice (a
tenth of the p99). The engine's `2026-10-twin-sign-margin` measured the margined kind's false
rollback at 0.000–0.037 under offsets up to 0.9 of the margin (T1).

### 1.4 Engine and repo pin

Engine `v0.13.0-pre` (ADR 0037) through DeploySignal's re-pin (PR #136). The runs execute from the
DeploySignal `main` commit that carries this registration's Amendment 0-style pin line, to be
added by a dated amendment naming the exact commit and the resolved engine SHA **before run 0**
(the first study ran from a later commit than its amendment named; this study names the commit
it runs from).

### 1.5 The analysis script

`studies/twin-aa-real-2/analysis/analyze.mjs` and `cloudtrail-evidence.mjs`: the first study's
scripts with paths and the study id changed, committed before run 0 (§0 (c)). The endpoint table,
per-lane counts, rollback ticks, the firing detector, the canary-worse share and the V6/V7 pass
are computed as there.

## 2. Cells and size

AA only, R = 100 executable runs, four lanes, the AB cells of the first registration not
re-registered here (AB-5xx runs under the first registration on the unmargined configuration and
is reported there). Stop at 11 executable rollbacks with E1 failed, or at 100 executable runs.
150 attempts cap.

## 3. Endpoints (§5 of the first registration, unchanged)

- **E1.** AA false-rollback rate (scored session, either metric) ≤ B = 0.1062: at most 10 of 100.
- **E2.** Rollbacks among executable runs plus rollbacks reached in void runs: at most 10.
- **E3.** Sample-ratio halts in at most 2 attempted runs.

Report-only: rollbacks by detector; the canary-worse share per run at margin 0 and at 0.10; the
per-run median control p99 (to state the service's latency scale as run); the W0 session.

## 4. Predictions (registered)

- **P1.** E1 holds, with 0 to 4 rollbacks in 100, all from `twin_sign_p99_latency` if any. Held
  with moderate confidence: the margin removed 10 of 12 on a service where offsets were 1–100% of
  the p99; here they should be under 3%, and four targets per arm average them further. What
  would move me: a persistent per-arm latency difference at the 10% scale on Fargate, which the
  first study did not see in absolute terms (its largest was 2 ms).
- **P2.** `twin_rate_http_5xx` fires in 0 to 2 runs (as before; both arms' 5xx rates equal to four
  decimals in the first study).
- **P3.** E3 holds with 0 halts.
- **P4.** The unmargined canary-worse share (report-only) still spreads over 0–1 across runs: the
  offsets are still there, now inside the margin.
- **P5.** W0 rollbacks at most 10 in 100.

## 5. Void, NOT-EXECUTABLE and abort: as the first registration §7 and Amendment 3 (b), plus

- **V8 Latency scale.** A scored tick whose control p99 is below 20 ms or above 400 ms (the
  service is not running at its declared scale, or is saturated): void. Applied mechanically by
  the analysis script from the stored tick bodies, before any verdict is read.

## 6. What a failure would mean

E1 failing with rollbacks on `twin_sign_p99_latency` at a 10% margin on a 75 ms service with four
tasks per arm says the arms differ persistently by more than a tenth of their p99 under identical
code, and the `sign` construction with a margin is refused for latency at this scale; the fallback
named in ADR 0037's reversal (latency as a `rate` over an SLO threshold, from an application
histogram) becomes the next design. E1 failing on `twin_rate_http_5xx` contradicts both prior
studies and would be reported as an unexplained arm-level 5xx asymmetry, evidence first.

## 7. Ship rule (§9 of the first registration, unchanged)

This study cannot move authority. A pass may be cited as "no gross false-rollback excess of the
twin gate on one real service, sign kind with a 10% margin and rate kind, three-target-group
topology, 60-tick bake, tier T3", necessary and not sufficient for an authority ADR, which must
still address power (AB-5xx under the first registration), the proceed side, resolution (0.05
against 0.10 not separated), generality, and the paths not exercised.

## 8. Not measured

Everything in the first registration's §10; a margin other than 0.10 relative; an absolute
margin; a service p99 other than about 75 ms; task counts other than four; whether the margin,
the scale or the task count is the operative change (§0 (b)).

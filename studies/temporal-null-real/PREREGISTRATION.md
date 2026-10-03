# Pre-registration — the temporal path's null on real undeployed traffic (`2026-10-temporal-null-real`, T3 replay)

- **Study id:** `2026-10-temporal-null-real`. Register: knowledge `WORKLIST.md` C87 (the temporal path's
  authority) and the question of 2026-10-03: can the advisory families be combined into evidence?
  Only if each has a measured null. None has one on real traffic. This study measures it.
- **Tier:** T3 replay. Real CloudWatch series from a service that was not deployed during the
  evaluation window, replayed through the engine's temporal path exactly as the corpus sweep drives
  it (`test/w4-full-sweep.test.ts`: `orchestrate` per tick with a compiled config). No lane, task or
  gate on AWS is touched; the onebox A/A running on the same lanes is unaffected.
- **Status: REGISTERED, NOT RUN.** Committed alone, before the harness. A later change is an
  amendment, appended and dated. The data fetch, the calibration and the replay all happen after
  this commit; the raw CloudWatch pulls are committed with the results so the replay is repeatable.

## 0. Disclosures

- The temporal path's signal set is built for LLM serving (`p99_latency, ttft, tokens_turn, kv_cache,
  cost_req, downstream_err, mfu, …`). An HTTP service has two of them: `p99_latency` and an error
  rate, which this study maps to `downstream_err`, plus `traffic_pct`. Families C and E compile no
  cells from such a bundle (interface smoke on synthetic two-signal data, 2026-10-03, not real
  data); Families A and D do, B is the hand-tuned rules. The result is therefore the null of
  Families A, B and D on the two signals a web service has, not of the whole path.
- The series is not stationary in traffic. The service (`prod-old`, weight 50) served about 81
  requests per second with the study arms scaled to zero and about 42 with them up; the arms came
  and went with the fault study's cells. The temporal path meets traffic that varies two-fold with
  no deploy, which is a null an operator's service presents daily. Sessions are reported by
  traffic regime.
- One no-change deploy is inside the series: at 2026-10-02T01:30Z the `prod-old` task definition
  moved from image `old-v2-20260929` to `old-v3-20261001` (the latter adds an environment variable
  the service reads only when set; the service's behaviour at this configuration is identical) and
  its tasks restarted. The evaluation window starts there on purpose: the first session on each
  lane is a null deploy with a cold start. These four sessions are reported separately and counted.
- The operator's calibration history is 34.6 hours. The shipped cell dimension
  (`hour_of_day × day_of_week`) is then mostly `aggregate` fallback. That is the calibration a new
  service has in its first week; the study does not pretend otherwise.
- The twin A/A on the same lanes measured the twin, not this path; its outcomes do not inform this
  registration. The temporal detectors' corpus results (131 of 131 detected on synthetic
  trajectories) say nothing about a real null; that is the gap.
- Smoke on synthetic data only: the calibrator (`tools/calibrate.js --families A,B,C,D,E`) compiles
  the two-signal bundle; `orchestrate` proceeds on a flat null and rolls back on ×1.5 latency and
  ×3 error synthetic regressions (`family_A_p99_latency`, `family_A_betting_downstream_err`). No
  real series has been fetched or looked at beyond hourly request totals, which fixed the window.

## 1. Data

Per lane ℓ ∈ {0,1,2,3}, the `prod-old` target group of load balancer `twin-aa-l<ℓ>`, CloudWatch
`AWS/ApplicationELB` at period 120 s (two-minute ticks; percentiles computed by CloudWatch over the
period): `TargetResponseTime` p99 → `p99_latency` in ms; `HTTPCode_Target_5XX_Count` Sum ÷
`RequestCount` Sum → `downstream_err` (absent 5XX datapoint = 0); `RequestCount` Sum ÷ 9,740 →
`traffic_pct` (9,740 = two minutes at the full 81 rps, so the regimes read 1.0 and 0.5);
`HealthyHostCount` for the void rule. Window: **2026-09-30T14:51Z** (the second A/A's stack update,
after which `prod-old`'s configuration never changed) to **2026-10-03T05:00Z**.

- **Calibration:** 2026-09-30T14:51Z → 2026-10-02T01:30Z (1,039 two-minute ticks per lane), cut into
  contiguous 32-tick runs (32 per lane, 128 in all), one tenant `prod-old`, hour-of-day and
  day-of-week per tick in UTC, `cell_dim hour_of_day_x_day_of_week`, compiled by
  `node tools/calibrate.js --baseline <bundle> --alpha 1e-3 --families A,B,C,D,E`. The compiled
  config is committed before the replay. Nothing in it is tuned after a session is scored.
- **Evaluation:** 2026-10-02T01:30Z → 2026-10-03T05:00Z (825 ticks per lane), cut into contiguous
  non-overlapping sessions of 32 ticks (64 min): **25 per lane, 100 in all**, session 0 of each lane
  beginning at the restart. Residual ticks after the 25th session are unused.

## 2. The replay

Per session: `orchestrate({ liveMetrics, scenario, hoursElapsed, trendBuffer (10), tick, totalTicks: 32,
compiledConfig, currentHourOfDay, currentDayOfWeek (UTC, from the tick's wall clock), fusionTopology:
'portfolio' })`, exactly as `test/w4-full-sweep.test.ts` `runOne`. `scenario`: `riskLevel 'high'`,
`bakeHours 64/60`, `changeType 'config'`, `author 'human'`, `timeWindow 'ok'`, flags as the sweep's
clean scenario (all policy gates false, `zeta` and `approval` true), `baseline` = the calibration
window's per-lane means of `p99_latency` and `downstream_err` and `traffic_pct` 1.0. DeploySignal
`main` at the commit carrying the harness; engine as pinned there (`v0.13.0-pre`). Authority
constants are irrelevant: fires are counted whatever their authority.

Per session, recorded: the final verdict (`rollback` at its tick, `proceed`, or `extend` at 32);
every id in `healthResult.rollback` and `healthResult.extend` on every tick with its first tick;
the family of each id by prefix (`family_A_`, `family_B`/rule ids, `family_C_`, `family_D_`,
`family_E_`); the session's traffic regime (mean `traffic_pct` ≥ 0.9 → `full`, ≤ 0.6 → `half`, else
`mixed`); whether it is a restart session.

## 3. Void rules

A session is void if any tick has `HealthyHostCount` < 2 for `prod-old`, or a missing
`RequestCount` datapoint (no traffic in a two-minute window), or `RequestCount` < 2,000 (a
third of the half-traffic regime). Void sessions are listed, not scored, not replaced.
NOT EXECUTABLE: more than 10 of 100 sessions void; or the compiled config carries no Family A
cells; or the calibration window has a gap of more than 30 ticks on any lane.

## 4. Endpoints

α_total per session is 0.001 (the shipped budget: A 0.0004, B 0.0002, C 0.0002, D 0.0001, E 0.0001;
whatever the compiler emits for this bundle is recorded and used). With N executable sessions the
test is one-sided binomial against the declared rate at level 0.01.

- **E1 (false rollback).** Sessions ending `rollback` among the executable ones. At N = 100 and
  α_total 0.001: P(≥2) = 0.0046, so **PASS at 0 or 1, FAIL at 2 or more**. The point figure and its
  exact 95% upper bound are reported.
- **E2 (per-family fire rate).** For each family, sessions with at least one rollback-class fire
  from it, against its α share. At N = 100: A (0.0004) FAIL at ≥ 2; B holds are not rollbacks and
  are reported as counts; C and D (0.0002, 0.0001) FAIL at ≥ 2 (P(≥2) ≤ 0.0002); E likewise.
  A family that PASSES has a calibrated e-value on this traffic for these two signals and may be
  combined with other passing families by averaging; a family that FAILS stays advisory with its
  measured rate.
- **E3 (where the fires are).** Reported: fires by traffic regime (full / half / mixed) and in the
  four restart sessions; concordance (sessions with fires from two or more families).
- **E4 (extend/hold).** Sessions ending `extend` and the ids that held them; no bar.

## 5. Predictions (registered)

- P1: E1 FAILS, 3–15 rollback sessions of 100 (moderate confidence). Mechanism: the two-fold
  traffic change moves per-task load and so p99 by more than a δ_min calibrated from 34 h, and the
  `aggregate` fallback cells carry the whole series' variance, not the hour's.
- P2: most rollback fires are in `mixed` sessions (a regime change inside the session) and in the
  four restart sessions; `full` and `half` sessions without a change inside them fire rarely.
- P3: Family A fires in more sessions than Family D; Family B holds (extend) in more sessions than
  either fires.
- P4: if P1 is wrong and E1 PASSES, the A and D rates are still above their shares (E2 FAILS for at
  least one), because α_total is split five ways and a single family's share at N = 100 is tested
  at 0.04 expected fires.

## 6. What a result does and does not establish

A PASS on E1 and E2 for a family gives it a measured null on one HTTP service's two signals for 64-minute
sessions with 34 hours of calibration, under two-fold traffic variation; it does not transfer to
other services, longer bakes, more signals or richer calibration. A FAIL says the path, as shipped
and calibrated the way an operator would calibrate it in week one, fires on a service that did not
change; it does not say whether more history would fix it (not measured here). Neither outcome
touches the twin's result or ADR 0001.

## 7. Not measured

Families C and E (no cells from two signals); the LLM-serving signals; calibration longer than 34 h;
sessions longer than 64 min; the `hour_of_day` cell dimension; the recalibration path
(`tools/recalibrate`); the gate HTTP service (the engine is called directly); detection power
(no regression is injected — this is a null study only).

# 2026-09-twin-aa-local — run-20260927T050717Z (tier T2, local processes)

Registered: ../../PREREGISTRATION.md (commit 90aae26). Harness: bf95164. Repo base 5f0075b. Engine
v0.12.0-pre (10c9691). Node v25.9.0, darwin, 10 cores. Harness exit 0; 0 harness failures; 0
listeners left on the harness ports. Authority unchanged: every tick body carried
`"authority":"advisory"`, and nothing here is a real-service (T3) result.

**Verdict: ship rule NOT MET, on E6 alone.** E6 counted 178 upstream errors (125 in AA-w0.1, 53 in
AB-rate-x2), each confined to one tick. The post-hoc section attributes both ticks to the host
machine suspending (lid closed at 22:29:58 local, then maintenance sleep), not to the system under
test. That attribution is post-hoc. It does not change the verdict, because the registration counts
upstream errors as measurements and has no NOT-EXECUTABLE condition for host suspension.
E1–E5 were met as registered.

## Results as computed (analysis/summarize.mjs; pinned by analysis/check_report.mjs)

| cell | runs | rollbacks | rate | SE | bar | median tick | invalid | inconclusive | harness failures | upstream errors |
|---|---|---|---|---|---|---|---|---|---|---|
| AA-w0.5 | 100 | 0 | 0.0000 | 0.0000 | 0.1062 | – | 0 | 100 | 0 | 0 |
| AA-w0.1 | 100 | 0 | 0.0000 | 0.0000 | 0.1062 | – | 0 | 100 | 0 | 125 |
| AB-rate-x2 | 40 | 40 | 1.0000 | 0.0000 | – | 27 | 0 | 0 | 0 | 53 |
| AB-lat-x1.2 | 40 | 40 | 1.0000 | 0.0000 | – | 15.5 | 0 | 0 | 0 | 0 |

| endpoint | result |
|---|---|
| E1 | MET |
| E2 | MET |
| E3 | MET |
| E4 | MET |
| E5 | MET |
| E6 | NOT MET |

| prediction | scored |
|---|---|
| P1 | HELD |
| P2 | HELD |
| P3 | HELD |
| P4 | HELD |
| P5 | HELD |
| P6 | NOT HELD |
| P7 | HELD |

| cell | rollbacks by metric | canary share (requests) | canary share (5xx) | deployed replay at alpha_proceed 0.05 | median ticks_to_detect |
|---|---|---|---|---|---|
| AA-w0.5 | – | 0.4998 | 0.5005 | no_terminal_by_T 68, proceed 32 | 116 |
| AA-w0.1 | – | 0.1003 | 0.1004 | no_terminal_by_T 100 | 206 |
| AB-rate-x2 | http_5xx 40 | 0.4996 | 0.6630 | rollback 40 | 104 |
| AB-lat-x1.2 | p99_latency_ms 40 | 0.5004 | 0.5030 | rollback 40 | 112 |

| cell | sign ticks | fraction canary p99 worse | SE | lag-1 autocorrelation | mean log(canary p99 / control p99) |
|---|---|---|---|---|---|
| AA-w0.5 | 10000 | 0.5029 | 0.0050 | 0.0136 | 0.0005 |
| AB-rate-x2 | 1085 | 0.4728 | 0.0152 | -0.0134 | -0.0052 |
| AB-lat-x1.2 | 694 | 0.8646 | 0.0130 | 0.0009 | 0.1823 |

Ship rule (§7): NOT MET

"rate" is false rollback in the A/A cells and power in the A/B cells. Bar B = 0.05 + 2.58·√(0.05·0.95/100)
= 0.1062 (at most 10 of 100 runs). "median tick" is the tick at which the gate returned `rollback`.
Every A/A run ended `inconclusive` at T = 100 because `alpha_proceed` is 1e-12 (registration §1).
The deployed replay re-reads the same tick responses at `alpha_proceed` 0.05 and carries no bar.

## Predictions (§5)

| Prediction | Held? | Numbers |
|---|---|---|
| P1 AA-w0.5 false rollback ≤ B (synthetic 0.014) | HELD | 0 / 100 (0.0000); rate metric 0, sign metric 0 |
| P2 AA-w0.1 false rollback ≤ B (synthetic 0.011) | HELD | 0 / 100 (0.0000) |
| P3 no `invalid_experiment` in either A/A cell | HELD | 0 and 0 |
| P4 AB-rate-x2 power ≥ 0.9, median tick in [15, 45] (synthetic 1.00, 27) | HELD | 40 / 40 (1.0000), median 27 |
| P5 AB-lat-x1.2 power ≥ 0.9, median tick in [8, 40] (synthetic 1.00, 16) | HELD | 40 / 40 (1.0000), median 15.5 |
| P6 zero harness failures and zero upstream errors | NOT HELD | 0 harness failures; 178 upstream errors in 2 ticks |
| P7 AA-w0.5 fraction of ticks with canary p99 worse within 0.5 ± 3 SE | HELD | 0.5029, SE 0.0050 (limits 0.485 to 0.515) |

## What the numbers can and cannot say

- 0 of 100 false rollbacks in each A/A cell is the result the bar can see. With R = 100 the bar
  catches a true rate of 0.15 or more with probability about 0.9. It cannot separate 0.05 from
  0.10. A 95% upper bound on the true rate from 0/100 is 0.030 (rule of three). That bound is on
  this machine and this service only.
- AA-w0.1 passes by construction unless the pipeline is broken (disclosure (b)): the 5xx draw has no
  arm-level mechanism. This result does not show that any real service may set
  `allow_unequal_rate_split`.
- The sign metric carried real per-process latency noise. Over 10 000 AA-w0.5 ticks the canary's
  p99 was worse on 0.5029 of them, with lag-1 autocorrelation 0.0136 and mean log ratio 0.0005.
  On one machine I found no persistent arm-level latency state between two processes. Disclosure (d)
  lists what this setup cannot produce: separate hosts, pods, cold fleets and AZs.
- Both A/B cells detected the injected fault in every run, at medians 27 and 15.5 ticks, within one
  tick of the synthetic predictions. The AB-rate-x2 rollbacks all came from `http_5xx`, and the
  AB-lat-x1.2 rollbacks all came from `p99_latency_ms`. No rollback in either A/B cell was
  attributed to the metric that carried no fault.
- `median ticks_to_detect` is the gate's planning figure for a regression at each metric's
  tolerance, not at the injected size. It is reported, not scored.

## Post-hoc: the upstream errors and the wall time (labelled post-hoc; carries no verdict)

- The registration budgeted 60 minutes. The run took 4235 s (70.6 min). The A/A cells took 663 s
  and 735 s at 7543 and 6802 requests/s. The A/B cells took 979 s and 1857 s at 554 and 187
  requests/s.
- macOS power log (`pmset -g log`): "Entering Sleep state due to 'Clamshell Sleep'" at 22:29:58
  local, then "Maintenance Sleep" of about 901 s at 22:31:14, 22:47:00 and 23:02:46, separated
  by 45 s DarkWake windows. Before 22:29:58 there was no sleep during the run. cell-AA-w0.1.json
  was written at 22:30:35. Both A/B cells ran entirely inside DarkWake windows.
- The AA-w0.1 error tick (run 99, tick 14) straddles 22:29:58. Both arms' p99 is about 28.5 s
  (28543 / 28535 ms), and the upstream errors are 19 canary and 106 control, against 50 and 450
  requests, which matches the traffic share. The 2000 ms router timeout could not fire while the
  host was suspended.
- The AB-rate-x2 error tick (run 20, tick 13) has both arms' p99 at about 898.7 s (898677 /
  898676 ms), which matches one maintenance sleep. Its 53 upstream errors split 49 canary and
  4 control. That tick pushed its run's rollback e-value from 3.61 to 4.96. The run rolled back at
  tick 28. This cell already detected the fault in 40 of 40 runs, so the tick moved no endpoint
  except E6.
- The AB-lat-x1.2 cell shows no request-level stall. Its slowness is time spent suspended between
  requests.
- What this means for the harness: a T2 run on a laptop needs the host held awake (`caffeinate -i`
  or equivalent) and a wall-clock check that marks any tick whose duration exceeds a stated bound.
  Neither was registered. A rerun would need a dated amendment or a new registration before it
  runs. This report does not re-cut this run.

## Not measured

Real services, separate hosts, pods or AZs, cold fleets, production traffic, real 5xx mechanisms,
the Argo and CodeDeploy integrations, the proceed side beyond the report-only replay, the
missingness penalty, and any false-rollback rate below what R = 100 resolves.

## Post-run notes (2026-09-27, independent review; no numbers or verdicts above are changed)

- The host-suspension attribution in the post-hoc section explains the STALL of the AB-rate-x2 error
  tick (run 20, tick 13: both arms' p99 at 898.7 s against a 901 s maintenance sleep). It does not
  explain the SPLIT: 49 canary and 4 control upstream errors against 256 and 244 requests. A sleep
  that suspends both arms equally predicts a split near the traffic share, as the AA-w0.1 error tick
  shows. The canary process in this cell carried the registered 2× 5xx fault flag; whether that flag,
  the router's timeout path, or something else produced the skew is unexplained. The tick added
  spurious 5xx to the canary side of the scored rate statistic (canary 5xx 17 → 60 → 6 over ticks
  12–14; rollback e-value 3.61 → 4.96). The cell detected the fault in 40 of 40 runs, so it moved
  no endpoint except E6.
- At run time the worktree carried an uncommitted change to tracked
  `tools/calibrate/_calibrate-constants.js` (recorded in manifest.json `tracked_changes`; the
  known stale compiled artifact, Family E α fraction 0.10 → 0). No file on the twin path imports it
  (checked: service/, engine/). It is not committed.
- No sleep-prevention assertion was active during the run: `pmset` shows a `caffeinate` assertion
  ending ("ClientDied") at 22:05:41, 96 s before the run started at 22:07:17.
- `analysis/summarize.mjs` writes `endpoints.json` into the run directory when invoked from the
  command line (summarize.mjs:172-176); its header comment ("reads only the run directory") omits
  that. `check_report.mjs` imports it and does not write.
- A second run is registered separately as a dated amendment (host held awake; a not-executable
  rule for host suspension; per-arm upstream errors recorded). This run's verdict stands as recorded.

## Post-run note 2 (2026-09-27, investigation of the 49/4 split; no number or verdict changes)

- **Correction to the post-hoc section.** It says "the 2000 ms router timeout could not fire while
  the host was suspended". That holds during the sleep; at wake every overdue timeout fired in one
  batch. In the AA-w0.1 error tick, 125 of 126 stalled requests became upstream errors.
- **Most likely mechanism for the AB-rate-x2 split (run 20, tick 13), inferred, not reproduced.**
  From latency_sum / 898.7 s, 65 canary and 63 control requests were in flight when the host slept
  (128 = the harness concurrency; the split matches the traffic share). At wake a stalled request
  survived only if its arm's response reached the router before the batch of overdue 2000 ms
  timeouts ran (harness/router.mjs:85-88). 49 of 65 canary and 4 of 63 control died. The 53 errors
  are one correlated wake outcome, so the z = 6.01 against the traffic share, which assumes 53
  independent draws, does not apply. Why the control's responses arrived first was not determined.
- **Ruled out:** more canary requests in flight (65/63; 503s and 200s share one code path,
  harness/service.mjs:31-36); per-arm keep-alive pools (same Agent and keepAliveTimeout for both
  arms); request ordering (no 53-request window holds more than 33 canary requests); the fault
  flag counted as an upstream error (a 503 completes without upstreamError, harness/router.mjs:82).
  A scratch SIGSTOP/SIGCONT re-run gave symmetric mass timeouts, not a one-sided split.
- **Bearing on the premise.** A common-cause stall can put one correlated burst of errors on one arm,
  which the rate statistic reads as many independent events. Run 2 (no stall; longest tick
  277.9 ms) says nothing about this. The T3 registration's Amendment 2 records per-arm stall data and
  a report-only stall-burst analysis.

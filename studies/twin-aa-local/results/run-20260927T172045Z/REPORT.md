# 2026-09-twin-aa-local — run-20260927T172045Z (run 2, Amendment 1; tier T2, local processes)

Registered: ../../PREREGISTRATION.md §§1–8 (commit 90aae26) and Amendment 1 (commit 10aa849,
committed before any harness change). Harness: 1df2409, plus 3b531d1 (power source recorded, not
scored). Run at repo HEAD 3b531d1. Engine v0.12.0-pre (10c9691). Node v25.9.0, darwin, 10 cores.
Seed offset 1 000 000 (AA-w0.5 router seed 21268845 = 20260926 + 1 000 000 + 7919).
Harness exit 0; 0 harness failures; 0 listeners left on the harness ports (checked by the harness
and again with `lsof` after exit). Authority unchanged: every gate tick response carried
`"authority":"advisory"` (harness/run.mjs counts any other value as a harness failure; there were 0), and nothing here is a
real-service (T3) result.

**Run executable (Amendment 1 (c)): yes.** The run went from 2026-09-27 17:20:45Z to 17:45:57Z
(1512 s) under `caffeinate -dims`, on AC power at start and end, lid open. `power-log.txt` holds
the 219 `pmset -g log` lines in that window: 218 `Assertions` lines (including the harness's own
`caffeinate` PID 91745 holding PreventSystemSleep from 10:20:45 local) and the closing summary
line. None has event type `Sleep` or `DarkWake`. The longest scored tick was 277.9 ms against the
2000 ms bound.

**Verdict: ship rule MET.** E1–E6 met; P1–P7 held; no cell NOT EXECUTABLE; zero upstream errors,
so the split check has no tick to test.

## Results as computed (analysis/summarize.mjs; pinned by analysis/check_report.mjs)

| cell | runs | rollbacks | rate | SE | bar | median tick | invalid | inconclusive | harness failures | upstream errors |
|---|---|---|---|---|---|---|---|---|---|---|
| AA-w0.5 | 100 | 0 | 0.0000 | 0.0000 | 0.1062 | – | 0 | 100 | 0 | 0 |
| AA-w0.1 | 100 | 0 | 0.0000 | 0.0000 | 0.1062 | – | 0 | 100 | 0 | 0 |
| AB-rate-x2 | 40 | 40 | 1.0000 | 0.0000 | – | 26 | 0 | 0 | 0 | 0 |
| AB-lat-x1.2 | 40 | 40 | 1.0000 | 0.0000 | – | 13 | 0 | 0 | 0 | 0 |

| endpoint | result |
|---|---|
| E1 | MET |
| E2 | MET |
| E3 | MET |
| E4 | MET |
| E5 | MET |
| E6 | MET |

| prediction | scored |
|---|---|
| P1 | HELD |
| P2 | HELD |
| P3 | HELD |
| P4 | HELD |
| P5 | HELD |
| P6 | HELD |
| P7 | HELD |

| cell | rollbacks by metric | canary share (requests) | canary share (5xx) | deployed replay at alpha_proceed 0.05 | median ticks_to_detect |
|---|---|---|---|---|---|
| AA-w0.5 | – | 0.5003 | 0.5008 | no_terminal_by_T 67, proceed 33 | 116 |
| AA-w0.1 | – | 0.1002 | 0.1012 | no_terminal_by_T 100 | 206 |
| AB-rate-x2 | http_5xx 40 | 0.4992 | 0.6711 | rollback 40 | 103 |
| AB-lat-x1.2 | p99_latency_ms 40 | 0.4994 | 0.4948 | rollback 40 | 112 |

| cell | sign ticks | fraction canary p99 worse | SE | lag-1 autocorrelation | mean log(canary p99 / control p99) |
|---|---|---|---|---|---|
| AA-w0.5 | 10000 | 0.4957 | 0.0050 | -0.0119 | -0.0015 |
| AB-rate-x2 | 1055 | 0.5052 | 0.0154 | -0.0408 | 0.0043 |
| AB-lat-x1.2 | 616 | 0.8929 | 0.0125 | -0.0751 | 0.1907 |

Run executable (Amendment 1 (c)): YES (seed offset 1000000, tick wall bound 2000 ms, 0 void reason(s))

| cell | longest tick (ms) | upstream errors canary | upstream errors control | upstream-error ticks |
|---|---|---|---|---|
| AA-w0.5 | 138.5 | 0 | 0 | 0 |
| AA-w0.1 | 277.9 | 0 | 0 | 0 |
| AB-rate-x2 | 114.6 | 0 | 0 | 0 |
| AB-lat-x1.2 | 150.8 | 0 | 0 | 0 |

Upstream-error split (Amendment 1 (d), report-only): no upstream-error ticks

Ship rule (§7): MET

"rate" is false rollback in the A/A cells and power in the A/B cells. Bar B = 0.05 + 2.58·√(0.05·0.95/100)
= 0.1062 (at most 10 of 100 runs). "median tick" is the tick at which the gate returned `rollback`.
Every A/A run ended `inconclusive` at T = 100 because `alpha_proceed` is 1e-12 (registration §1).
The deployed replay re-reads the same tick responses at `alpha_proceed` 0.05 and carries no bar.
"longest tick" is from the first request of a tick to the gate's response to it.

## Predictions (§5)

| Prediction | Held? | Numbers |
|---|---|---|
| P1 AA-w0.5 false rollback ≤ B (synthetic 0.014) | HELD | 0 / 100 (0.0000); rate metric 0, sign metric 0 |
| P2 AA-w0.1 false rollback ≤ B (synthetic 0.011) | HELD | 0 / 100 (0.0000) |
| P3 no `invalid_experiment` in either A/A cell | HELD | 0 and 0 |
| P4 AB-rate-x2 power ≥ 0.9, median tick in [15, 45] (synthetic 1.00, 27) | HELD | 40 / 40 (1.0000), median 26 |
| P5 AB-lat-x1.2 power ≥ 0.9, median tick in [8, 40] (synthetic 1.00, 16) | HELD | 40 / 40 (1.0000), median 13 |
| P6 zero harness failures and zero upstream errors | HELD | 0 harness failures; 0 upstream errors |
| P7 AA-w0.5 fraction of ticks with canary p99 worse within 0.5 ± 3 SE | HELD | 0.4957, SE 0.0050 (limits 0.485 to 0.515) |

## Upstream-error split (Amendment 1 (d), report-only)

No tick in any cell had an upstream error, on either arm, so no z was computed. Run 1's AB-rate-x2
split (49 canary, 4 control against 256 and 244 requests; z = 6.01) is not reproduced or explained
by this run: with the host awake the router never timed out or errored, in the faulted cell or
elsewhere.

## What the numbers can and cannot say

- 0 of 100 false rollbacks in each A/A cell, again. With R = 100 the bar catches a true rate of 0.15
  or more with probability about 0.9 and cannot separate 0.05 from 0.10. The 95% upper bound from
  0/100 is 0.030 (rule of three), on this machine and this service only. Pooling with run 1 is not
  registered and is not done here.
- The 5xx draw is independent per request inside each process, so the rate metric's A/A cells
  (both AA-w0.5 and AA-w0.1) test the pipeline and the routing, not a real arm-level mechanism
  (disclosure (b)). AA-w0.1 passes by construction unless the pipeline is broken. It does not show
  that any real service may set `allow_unequal_rate_split`.
- The sign metric carried real per-process latency noise: over 10 000 AA-w0.5 ticks the canary's
  p99 was worse on 0.4957 of them, lag-1 autocorrelation -0.0119, mean log ratio -0.0015. On one
  machine I found no persistent arm-level latency state between two processes.
- Both A/B cells detected the injected fault in every run, at medians 26 and 13 ticks (synthetic 27
  and 16). AB-rate-x2 rollbacks all came from `http_5xx`, AB-lat-x1.2 rollbacks all from
  `p99_latency_ms`.
- Wall time was 1512 s, inside §3's 60-minute budget. Mean tick 68.1, 70.6, 69.0 and 80.8 ms by
  cell, consistent with run 1's awake cells (66 and 74 ms).

## Relation to run 1

Run 1 (run-20260927T050717Z) stands as recorded: ship rule NOT MET on E6. This run is a second,
separately registered run with disjoint seeds, not a re-cut of run 1. Run 1's upstream errors
coincided with host suspension; this run, with the host held awake and a void rule registered in
advance, recorded none. That is consistent with the post-hoc attribution in run 1's report and does
not by itself prove it, and it leaves run 1's skewed AB-rate-x2 split unexplained.

## Not measured

Real services, separate hosts, pods or AZs, cold fleets, production traffic, real 5xx mechanisms,
the Argo and CodeDeploy integrations, the proceed side beyond the report-only replay, the
missingness penalty, and any false-rollback rate below what R = 100 resolves. A pass here is "no
gross failure of the twin path on a local two-process A/A (T2)" (§7). It moves no authority;
`TWIN_ARM_AUTHORITY` stays `'advisory'`, and T3 remains the named condition for any authority ADR.

## Run notes

- At run time the worktree carried the build's uncommitted rewrite of tracked
  `tools/calibrate/_calibrate-constants.js` (manifest.json `tracked_changes`), the known stale
  compiled artifact, as in run 1. It is not committed.
- Before the run, the §6 smoke passed at seed offset 1 000 000 (scratchpad output, not a result):
  the 5× fault rolled back in both runs (ticks 14, 13); both 20-tick A/A runs stayed `extend` to T;
  0 harness failures; no listeners left.

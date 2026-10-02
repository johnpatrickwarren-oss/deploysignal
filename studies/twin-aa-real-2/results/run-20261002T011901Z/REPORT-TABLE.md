# Endpoint table — AA cell (generated 2026-10-02T01:19:01.775Z)

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 0/100 = 0.000 (95% one-sided bounds 0.000–0.030) | PASS |
| E2 sensitivity count | ≤ 10 | 0 | PASS |
| E3 sample-ratio halts | ≤ 2 of attempted | 0 of 100 | PASS |

Attempts 100: deploy failures 0 (runs none), attempts interrupted before arm-ready 0 (runs none), runs with a runner 100; summaries 100; executable 100; void 0; stop rule tripped: false.

Post-hoc, no verdict — share of scored ticks with canary p99 above control p99, over the ticks the scored session used: holds (n 100) min 0.350, median 0.500, max 0.650; rollbacks min Infinity, max -Infinity. Fired by detector: {}.

| Lane | Attempts | Executable | Rollback | Hold |
|---|---|---|---|---|
| 0 | 25 | 25 | 0 | 25 |
| 1 | 25 | 25 | 0 | 25 |
| 2 | 25 | 25 | 0 | 25 |
| 3 | 25 | 25 | 0 | 25 |

| Rollback run | Lane | Scored tick | W0 tick | Fired | p99 canary-worse share |
|---|---|---|---|---|---|

Predictions: P1 held; P2 held; P3 held; P4 held (W0 rollbacks 0).
V6/V7: evaluated on 100 of 100 runs; flagged none. Authority violations 0. Runs with any unhealthy target none.

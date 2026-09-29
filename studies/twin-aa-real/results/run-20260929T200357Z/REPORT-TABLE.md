# Endpoint table — AA cell (generated 2026-09-29T20:03:57.271Z)

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 12/44 = 0.273 (95% one-sided bounds 0.166–0.404) | FAIL |
| E2 sensitivity count | ≤ 10 | 12 | FAIL |
| E3 sample-ratio halts | ≤ 2 of attempted | 0 of 63 | PASS |

Attempts 63: deploy failures 17 (runs 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16), attempts interrupted before arm-ready 2 (runs 17, 18), runs with a runner 44; summaries 44; executable 44; void 0; stop rule tripped: true.

Post-hoc, no verdict — share of scored ticks with canary p99 above control p99, over the ticks the scored session used: holds (n 32) min 0.000, median 0.300, max 0.683; rollbacks min 0.729, max 1.000. Fired by detector: {"twin_sign_p99_latency":12}.

| Lane | Attempts | Executable | Rollback | Hold |
|---|---|---|---|---|
| 0 | 18 | 11 | 3 | 8 |
| 1 | 16 | 11 | 4 | 7 |
| 2 | 15 | 11 | 3 | 8 |
| 3 | 14 | 11 | 2 | 9 |

| Rollback run | Lane | Scored tick | W0 tick | Fired | p99 canary-worse share |
|---|---|---|---|---|---|
| 26 | 3 | 19 | 32 | twin_sign_p99_latency | 0.842 |
| 29 | 1 | 11 | 13 | twin_sign_p99_latency | 1.000 |
| 32 | 3 | 13 | 27 | twin_sign_p99_latency | 0.923 |
| 35 | 2 | 11 | 21 | twin_sign_p99_latency | 1.000 |
| 39 | 0 | 14 | 13 | twin_sign_p99_latency | 0.929 |
| 44 | 1 | 13 | 22 | twin_sign_p99_latency | 0.923 |
| 45 | 2 | 33 | 32 | twin_sign_p99_latency | 0.758 |
| 47 | 1 | 13 | 17 | twin_sign_p99_latency | 0.923 |
| 54 | 1 | 48 | 62 | twin_sign_p99_latency | 0.729 |
| 57 | 2 | 11 | 16 | twin_sign_p99_latency | 1.000 |
| 59 | 0 | 31 | 41 | twin_sign_p99_latency | 0.774 |
| 62 | 0 | 23 | 16 | twin_sign_p99_latency | 0.826 |

Predictions: P1 NOT held; P2 NOT held; P3 held; P4 NOT held (W0 rollbacks 14).
V6/V7: evaluated on 44 of 44 runs; flagged none. Authority violations 0. Runs with any unhealthy target none.

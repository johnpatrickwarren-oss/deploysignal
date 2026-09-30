# Endpoint table — AB-5xx cell (generated 2026-09-30T03:14:26.158Z)

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 10 of 100 executable (B 0.1062); stop at 11 | 20/20 = 1.000 (95% one-sided bounds 0.861–1.000) | not applicable (AB cell) |
| E2 sensitivity count | ≤ 10 | 20 | not applicable (AB cell) |
| E3 sample-ratio halts | ≤ 2 of attempted | 0 of 20 | PASS |
| E4 AB-5xx power | ≥ 16 of 20 executable roll back | 20/20 = 1.000, median rollback tick 25 (ticks 11, 11, 13, 14, 25, 25, 25, 25, 25, 25, 25, 25, 26, 26, 26, 26, 26, 26, 26, 26) | PASS |
P6 (power ≥ 0.9, median tick 15–45): held. Mean target 5xx per tick canary 12.21 / control 6.1. Non-rollback verdicts: none. Rate detector fired in 16 of 20 rollbacks; the sign detector fired first in 4 (68@14, 74@11, 75@11, 80@13).

Attempts 20: deploy failures 0 (runs none), attempts interrupted before arm-ready 0 (runs none), runs with a runner 20; summaries 20; executable 20; void 0; stop rule tripped: null.

Post-hoc, no verdict — share of scored ticks with canary p99 above control p99, over the ticks the scored session used: holds (n 0) min —, median —, max —; rollbacks min 0.038, max 1.000. Fired by detector: {"twin_rate_http_5xx":16,"twin_sign_p99_latency":4}.

| Lane | Attempts | Executable | Rollback | Hold |
|---|---|---|---|---|
| 0 | 5 | 5 | 5 | 0 |
| 1 | 5 | 5 | 5 | 0 |
| 2 | 5 | 5 | 5 | 0 |
| 3 | 5 | 5 | 5 | 0 |

| Rollback run | Lane | Scored tick | W0 tick | Fired | p99 canary-worse share |
|---|---|---|---|---|---|
| 63 | 0 | 26 | 13 | twin_rate_http_5xx | 0.769 |
| 64 | 1 | 26 | 25 | twin_rate_http_5xx | 0.500 |
| 65 | 2 | 26 | 26 | twin_rate_http_5xx | 0.692 |
| 66 | 3 | 26 | 25 | twin_rate_http_5xx | 0.462 |
| 67 | 1 | 25 | 25 | twin_rate_http_5xx | 0.240 |
| 68 | 0 | 14 | 24 | twin_sign_p99_latency | 0.929 |
| 69 | 2 | 25 | 26 | twin_rate_http_5xx | 0.040 |
| 70 | 3 | 26 | 25 | twin_rate_http_5xx | 0.654 |
| 71 | 0 | 26 | 25 | twin_rate_http_5xx | 0.038 |
| 72 | 1 | 25 | 26 | twin_rate_http_5xx | 0.360 |
| 73 | 2 | 25 | 26 | twin_rate_http_5xx | 0.640 |
| 74 | 3 | 11 | 19 | twin_sign_p99_latency | 1.000 |
| 75 | 3 | 11 | 21 | twin_sign_p99_latency | 1.000 |
| 76 | 0 | 25 | 25 | twin_rate_http_5xx | 0.080 |
| 77 | 1 | 26 | 25 | twin_rate_http_5xx | 0.192 |
| 78 | 2 | 25 | 26 | twin_rate_http_5xx | 0.360 |
| 79 | 3 | 25 | 18 | twin_rate_http_5xx | 0.800 |
| 80 | 0 | 13 | 18 | twin_sign_p99_latency | 0.923 |
| 81 | 1 | 25 | 25 | twin_rate_http_5xx | 0.040 |
| 82 | 2 | 26 | 25 | twin_rate_http_5xx | 0.346 |

Predictions: P1 NOT held; P2 NOT held; P3 held; P4 NOT held (W0 rollbacks 20).
V6/V7: evaluated on 20 of 20 runs; flagged none. Authority violations 0. Runs with any unhealthy target none.

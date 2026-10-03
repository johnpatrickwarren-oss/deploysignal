# AB-5xx-1.5 — endpoint table (generated 2026-10-02T13:36:56.664Z)

| F2 power | ≥ 10 of 20 executable roll back | 20/20 = 1.000, median rollback tick 40 (ticks 38, 39, 39, 39, 39, 39, 40, 40, 40, 40, 40, 40, 41, 41, 41, 41, 41, 42, 42, 42) | PASS |

Attempts 20 (deploy failures none); summaries 20; executable 20; void 0; halts 0; authority violations 0.
Fired by detector: {"twin_rate_http_5xx":20}. Non-rollback: none.
Median p99 (ms) canary 76.6 / control 76.1; share of scored ticks with canary p99 > control × 1.10: min 0.000, median 0.050, max 0.150.
Mean per tick: target 5xx canary 9.17 / control 6.09; requests canary 1220 / control 1220; ELB-generated 5xx on the lane's load balancer 0.00; final sample-ratio e-value 0.98–1.05.
V6/V7 evaluated on 20 of 20; flagged none. Canary revisions twin-aa-l0-canary-ab:3, twin-aa-l1-canary-ab:3, twin-aa-l2-canary-ab:3, twin-aa-l3-canary-ab:3; control twin-aa-l0:3, twin-aa-l1:3, twin-aa-l2:3, twin-aa-l3:3.

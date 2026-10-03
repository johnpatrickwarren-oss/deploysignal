# AB-lat30 — endpoint table (generated 2026-10-02T04:29:57.144Z)

| F1 power | ≥ 16 of 20 executable roll back | 20/20 = 1.000, median rollback tick 11 (ticks 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11) | PASS |

Attempts 20 (deploy failures none); summaries 20; executable 20; void 0; halts 0; authority violations 0.
Fired by detector: {"twin_sign_p99_latency":20}. Non-rollback: none.
Median p99 (ms) canary 99.3 / control 76.5; share of scored ticks with canary p99 > control × 1.10: min 1.000, median 1.000, max 1.000.
Mean per tick: target 5xx canary 6.11 / control 6.15; requests canary 1220 / control 1220; ELB-generated 5xx on the lane's load balancer 0.00; final sample-ratio e-value 0.99–1.01.
V6/V7 evaluated on 20 of 20; flagged none. Canary revisions twin-aa-l0-canary-ab:2, twin-aa-l1-canary-ab:2, twin-aa-l2-canary-ab:2, twin-aa-l3-canary-ab:2; control twin-aa-l0:3, twin-aa-l1:3, twin-aa-l2:3, twin-aa-l3:3.

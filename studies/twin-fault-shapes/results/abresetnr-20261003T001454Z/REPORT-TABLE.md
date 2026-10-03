# AB-reset-nr — endpoint table (generated 2026-10-03T00:14:54.638Z)

| F5 power | ≥ 16 of 20 executable roll back | 20/20 = 1.000, median rollback tick 12 (ticks 11, 11, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12) | PASS |

Attempts 21 (deploy failures none); summaries 21; executable 20; void 1 (260: V6/V7 write event on the lane's resources inside the run: TaskCreated@2026-10-02T15:57:39-07:00); halts 0; authority violations 0.
Fired by detector: {"twin_rate_no_response":20}. Non-rollback: none.
Median p99 (ms) canary 76.8 / control 76.9; share of scored ticks with canary p99 > control × 1.10: min 0.000, median 0.000, max 0.167.
Mean per tick: target 5xx canary 6.13 / control 6.07; requests canary 1222 / control 1215; ELB-generated 5xx on the lane's load balancer 6.08; final sample-ratio e-value 0.99–1.05.
Unanswered requests per tick (no_response): canary 6.08 / control 0.00.
V6/V7 evaluated on 21 of 21; flagged 260. Canary revisions twin-aa-l0-canary-ab:4, twin-aa-l1-canary-ab:4, twin-aa-l2-canary-ab:4, twin-aa-l3-canary-ab:4; control twin-aa-l0:3, twin-aa-l1:3, twin-aa-l2:3, twin-aa-l3:3.

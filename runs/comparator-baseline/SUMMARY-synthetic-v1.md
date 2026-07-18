# Comparator-Baseline Report

Generated: 2026-07-17T08:41:56.461Z
Endpoints version: `v1` (sha256 `b3105daa20d254770c62c3b28b07ed9b62cada2c7ec5123e6bdb4eb69546397b`)
Baseline: `synthetic-v1` · Compiled config: `runs/compiled-configs/v5-sequential-e-process.json` · Engine: `0.6.1-pre`

## Primary endpoints

| Arm | Escaped regressions | False rollbacks | Delay median (ticks) | Delay p95 (ticks) |
|---|---|---|---|---|
| `portfolio_alpha` | 40 (40.0%) | 33 (25.2%) | 24.5 | 50 |
| `portfolio_combined` | 33 (33.0%) | 131 (100.0%) | 20 | 50 |
| `threshold_tuned` | 67 (67.0%) | 0 (0.0%) | 31 | 67 |
| `canary_tuned` | 80 (80.0%) | 0 (0.0%) | 10 | 10 |
| `combined_tuned` | 47 (47.0%) | 0 (0.0%) | 10 | 67 |
| `combined_default` | 28 (28.0%) | 3 (2.3%) | 20 | 40 |

## Escaped regressions by profile

| Arm | anthropic_tpu_output_corruption_step_2025_09 | anthropic_xla_precision_drift_2025_08 | cloudflare_worker_kv_degradation_2024_03 | github_availability_latency_regression_2024_06 | openai_routing_error_ramp_2024_12_11 |
|---|---|---|---|---|---|
| `portfolio_alpha` | 0/20 | 20/20 | 0/20 | 0/20 | 20/20 |
| `portfolio_combined` | 0/20 | 16/20 | 0/20 | 0/20 | 17/20 |
| `threshold_tuned` | 20/20 | 20/20 | 6/20 | 1/20 | 20/20 |
| `canary_tuned` | 0/20 | 20/20 | 20/20 | 20/20 | 20/20 |
| `combined_tuned` | 0/20 | 20/20 | 6/20 | 1/20 | 20/20 |
| `combined_default` | 0/20 | 10/20 | 0/20 | 0/20 | 18/20 |

## Tuned parameters

- threshold_tuned: `m=1`, k per signal: `{"p99_latency":3.5,"ttft":3.5,"cost_req":3,"downstream_err":3.5,"eval_score":2,"tool_success_rate":2}`
- canary_tuned: `alpha=0.01`, `W=10`
- combined_tuned escalation: chosen `{"alpha":0.01,"m":1}`


# Real-data baseline bundle: real_burstgpt

Generated: 2026-08-19T00:43:57.824Z

Source: Q60 Slice 1 ingestion via tools/ingest-public-dataset.ts.

## Dataset identity

- upstream: https://github.com/HPMLL/BurstGPT @ cf9d05e565c28b4b35ca346071966b2773ca9ad6, file data/BurstGPT_1.csv
- sha256: 46fc9480ef0b748ecb2b51d512ff08c196b031782cbe6f78e28044d768e86d5a (50,853,373 bytes; 1,429,737 data rows; re-fetched 2026-08-18 from raw.githubusercontent.com at the pinned revision — identical to the 2026-05-01 acquisition)
- row scope: first 200,000 rows — the v1 slice, recovered 2026-08-18 by bit-exact reproduction of real-burstgpt-v1 (34,202 populated buckets, 0 mismatches)
- pricing: cost/request = request_tokens x 3e-5 + response_tokens x 6e-5 USD (GPT-4 $0.03/$0.06 per 1K), recovered by exact match against v1 tick 0
- tick: 5 s; clock: elapsed-seconds from trace start, full tick range so tick x 5 s IS real elapsed time; no wall-clock anchor exists upstream (README states durations only) — hour_of_day is real modulo an unknown phase
- raw CSV stays outside the repo per Q60 anti-scope; re-acquire via the pinned URL + sha256 above

## Caveat filters applied

- burstgpt_v1_a1:cost_req_only_scope
- burstgpt_no_p99_latency:elapsed_ms_field_absent_in_actual_csv
- burstgpt_no_downstream_err:service_error_log_type_absent_in_actual_csv
- burstgpt_v2:full_tick_range_zero_filled_cost_requests_per_tick_disambiguator
- burstgpt_v2:clock_elapsed_from_trace_start_no_wall_anchor_phase_unknown

## Signals populated

- cost_req

## Auxiliary series (non-signal; outside every calibration path)

- requests_per_tick

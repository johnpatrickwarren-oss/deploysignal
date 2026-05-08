# synthetic-v1

Synthetic healthy-baseline bundle, emitted by `tools/gen-synthetic-baseline.ts`.

## Files
- `manifest.json` — header (version, seed, n_runs, ticks, signals, factor stds)
- `bundle.jsonl` — one run per line; each line = `{ tenant_id, signal_series: { <signal>: number[ticks] }, hour_of_day: number[ticks] }` (W2: hour_of_day per-tick labels enable cell-wise compilation)

## Determinism
Seeded with `--seed 42` → identical bytes on re-run. Verify with `diff bundle.jsonl <re-run>/bundle.jsonl`.

## Consumption
`tools/calibrate.ts` loads `bundle.jsonl` line-by-line and reconstructs a `BaselineBundle` (see `engine/types.ts`).

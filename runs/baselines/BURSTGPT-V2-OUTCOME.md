# BurstGPT re-ingest outcome (WORKLIST C37) — v2 bundle shipped

2026-08-18. Branch outcome: **`real-burstgpt-v2/` shipped**; the CANNOT-RE-ACQUIRE branch was not
needed. This file is the C37 close marker; the register tests its presence on `main`.

## Dataset identity — recovered, then re-acquired

The v1 bundle recorded no dataset URL, revision, or checksum. Both are now established:

- **Upstream**: `https://github.com/HPMLL/BurstGPT` @ `cf9d05e565c28b4b35ca346071966b2773ca9ad6`,
  file `data/BurstGPT_1.csv` — sha256
  `46fc9480ef0b748ecb2b51d512ff08c196b031782cbe6f78e28044d768e86d5a`, 50,853,373 bytes, 1,429,737
  data rows (the trace's first 2 months; upstream README states durations only, no wall-clock
  anchor). Re-fetched 2026-08-18 from `raw.githubusercontent.com` at the pinned revision;
  **checksum identical** to the 2026-05-01 acquisition clone.
- **The v1 invocation, recovered by reproduction**: first 200,000 rows, 5 s ticks, pricing
  `request_tokens × 3e-5 + response_tokens × 6e-5` USD (GPT-4 $0.03/$0.06 per 1K),
  `tenant_id: burstgpt-aggregate`. Running the committed v1 tool with these arguments against the
  re-acquired CSV reproduces `real-burstgpt-v1` **bit-exactly**: all 34,202 cost values, 0
  mismatches, identical `hour_of_day`/`day_of_week`. v1 is untouched and remains cited evidence.

## The three C30 caveats — which lifted

1. **Dispersion vs averaging — LIFTED.** v2 carries `requests_per_tick` (as `auxiliary_series`,
   outside every calibration path), so the mean-cost cv can now be decomposed into per-request
   variation vs small-sample averaging. Sum = 200,000, exactly the row scope. The 1,503
   zero-cost populated ticks C30 counted are now disambiguated by construction from empty buckets
   (count > 0 with cost 0 = real zero-token requests; count 0 = no arrivals).
2. **The time axis — LIFTED, and the answer is the bad branch of C30's dichotomy.** The 200k-row
   slice spans **10.08 real days = 174,234** 5 s buckets; v1 kept only the **34,202 populated
   ones — 80.4% of the time axis was dropped**, and array adjacency compressed 10.08 days into
   ~47.5 synthetic hours. C30 wrote "if it is sparse they are not [negligible]"; it is sparse.
   v2 emits the full tick range (empty buckets present, cost 0 + count 0, stamped in
   `filters_applied`), so every lag is a real 5 s lag. **Whether C30's φ̂ = 0.2488 and the AR(1)
   rejection survive the real axis is a separate pre-registered study, deliberately not run here**
   (this item produces data, not a re-derivation).
3. **The clock — PARTIALLY LIFTED.** Source timestamps are elapsed-seconds from trace start with
   no wall anchor anywhere upstream, so an absolute `hour_of_day` is unobtainable — now a
   **recorded property** of the dataset (README + `filters_applied` stamp) rather than a
   rediscovery. But with the full tick range, `tick × 5 s` IS real elapsed time, so v2's
   `hour_of_day`/`day_of_week` are real up to one unknown phase offset, and the slice carries
   ~10 real diurnal cycles (v1's synthetic axis showed ~2). Periodicity is now measurable in
   elapsed time; absolute phase is not.

## The leak check found a real leak, fixed before shipping

`signal_series` was the brief's suggested home for the counts. Compiling a draft v2 bundle with
families enabled showed the family-D calibrator stamps **per `signal_series` key**: the counts
series grew its own `family_D` spectral params on all 840 cells. The counts therefore ship as
`BundleRun.auxiliary_series` — a new, additive field no calibration path reads. Verified: the v2
compile is `requests_per_tick`-free and its 840-cell set is identical to v1's.

## Scope held

- `real-burstgpt-v1` byte-identical; the v1 mapper untouched (`mapBurstGPTRowsV2` is a separate
  function).
- `engine/scenarios/corpus-noise-model.json` untouched; its loader still throws for every signal
  C30 marked unsourceable.
- No parameter re-derived, no study re-run. The φ-on-a-real-axis question is registered work for
  a successor study, not this artifact.
- Raw CSV stays outside the repo (Q60 anti-scope); re-acquisition is mechanical from the pinned
  URL + sha256 above.

# Pre-registration — the two-sample betting kind replayed over the stored twin runs (`2026-10-twin-two-sample-replay`, T3 replay)

- **Study id:** `2026-10-twin-two-sample-replay`. Register: knowledge C84/C87 (the designed-null programme,
  step 4); engine ADR 0042 (`detectors/twin-two-sample.ts`, study `2026-10-twin-two-sample`, T1, running at
  registration); the May 2026 claim that the portfolio finds patterns per-metric detectors miss.
- **The question.** On the real twin runs already stored, what is the two-sample kind's false-rollback rate
  under the A/A at two, four and one tasks per arm, and what does it do on the four fault shapes?
- **Tier:** T3 replay over stored per-tick two-arm bodies; no AWS; no authority.
- **Engine:** `dist/detectors/twin-two-sample.js` at engine commit `bfbc0a3` (the ADR 0042 implementation
  with Amendment 1's two power devices), pinned by sha256 in the harness; loaded from a local checkout as
  the GWDG replays did. DeploySignal stays pinned to `v0.13.0-pre`.
- **Status: REGISTERED, NOT RUN.** Committed alone, before the harness.

## 0. Disclosures

- The T1 study's **full run had not finished** at this registration. Its 20-replication smoke (discarded,
  not a result) showed the kind firing on a persistent offset at 0.9 of the margin (20 of 20) and under
  per-arm autocorrelation at σ 0.3 (10 of 20): the coordinate-wise shrink does not give a two-sample test the
  sign kind's margin property, because a sub-margin offset leaves the shrunk differences asymmetric, and a
  predictable witness exploits per-arm memory. I therefore expect this kind to fail the A/A on real arms,
  which carry both (persistent per-task p99 offsets, `2026-10-twin-aa-real`), and I register that as P1.
- The runs' per-metric verdicts are known in full (first A/A 12/44, second 0/100, onebox 0/N so far, fault
  cells 20/20, 20/20, 0/20, 20/20). The replay's bars are the registered studies' own bars, for
  comparability, and are not tuned to the kind.
- The onebox runs are read as they stand at run time (closed runs only); their count is recorded.

## 1. Data

Per run, the stored `.jsonl`: `type: 'window'` records with `scored_tick: true` (the 60 scored ticks),
`body.observations.http_5xx.{canary_events, canary_total, control_events, control_total}` and
`body.observations.p99_latency.{canary, control}` (seconds). Coordinates per arm per tick: **c1** = events /
total (the 5xx rate), **c2** = p99 in ms. Studies and runs:

| Study | Runs | Tasks per arm | Per-metric result |
|---|---|---|---|
| `studies/twin-aa-real` AA cell | 44 executable (the committed `results/runs/AA-*`) | 2 | E1 FAIL 12/44 |
| `studies/twin-aa-real-2` AA | 100 | 4 | E1 PASS 0/100 |
| `studies/twin-aa-onebox` AA (closed at run time, from the host) | N | 1 | running, 0 so far |
| `studies/twin-fault-shapes` AB-lat30, AB-5xx-1.5, AB-reset, AB-reset-nr | 20 each (executable) | 4 | 20/20, 20/20, 0/20, 20/20 |

Voided runs under their study's rules are excluded (the summaries' `void_reasons`). The two-sample kind is
stepped once per scored tick with `x = [c1_canary, c2_canary]`, `y = [c1_control, c2_control]`; a tick
with a non-finite coordinate is `missing`.

## 2. Arms

- **TS-m**: `coordinates [{ id: 'http_5xx', margin: { relative: 0.2 } }, { id: 'p99_latency', margin: { relative: 0.10 } }]`
  (the per-metric kinds' own margins), `alpha 0.05`, `window 200`, `localWindow 20`. Primary.
- **TS-0**: the same with no margins. Reported.
- Fresh state per run; rollback at the first scored tick at which the kind fires; else `hold` at 60.

## 3. Endpoints

- **E1 — false rollback on the A/A runs, TS-m**, per study: twin-aa-real ≤ 0.1062 of 44 (that study's bar),
  twin-aa-real-2 ≤ 0.1062 of 100 (its bar was ≤ 10 of 100), onebox ≤ 0.1062 of N. Reported beside each: the
  per-metric result on the same runs.
- **E2 — the fault cells, TS-m**: rollbacks of 20 per cell and the median tick, beside the per-metric kinds'
  (AB-lat30 20/20 at 11; AB-5xx-1.5 20/20 at 40; AB-reset 0/20; AB-reset-nr 20/20 at 12). Report only: the
  cells were built for single-metric faults and a pattern test adding detections there would be surprising.
- **E3 — TS-0**, report only.
- **E4 — instrument:** 0 exceptions; module hash pinned; run counts equal the studies' executable counts.

## 4. Predictions

- P1: E1 **FAILS on the first A/A** (two tasks, persistent offsets): 15–30 of 44, more than the sign kind's 12.
  **FAILS on the second** (four tasks): 8–30 of 100, where the sign kind with the margin gave 0 and without it
  1. **Fails on onebox** at a rate at least the second's. Mechanism: the smoke's two findings.
- P2: AB-lat30 and AB-5xx-1.5 roll back 20/20 later than the per-metric kinds (medians 20–40 and 40–60);
  AB-reset 0–5 of 20 (the kind sees nothing the metrics do not carry); AB-reset-nr not applicable (its
  `no_response` metric is not a coordinate here) and is replayed on the two coordinates only: 0–5 of 20.
- P3: TS-0 has more rollbacks than TS-m in every row.
- P4: E4 holds.

## 5. What a result does and does not establish

If P1 holds, the two-sample kind cannot carry authority on real arms as constructed, and the reason is
structural: arms with persistent offsets or memory are not exchangeable given the past, and a test that
uses the whole distribution cannot be given the direction-only margin that saved the sign kind. The
pattern-finding claim of May 2026 then has no real-data support at any point in the project. If P1 fails
and E1 holds, the kind has a real null at these arm sizes and the fault cells say what it adds.

## 6. NOT EXECUTABLE

A module hash other than the pinned one; exceptions in more than 5% of runs; a run count differing from
the studies' executable counts.

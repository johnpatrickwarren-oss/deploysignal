# Report — the two-sample betting kind replayed over the stored twin runs (`2026-10-twin-two-sample-replay`, T3 replay)

- **Registration:** `PREREGISTRATION.md` at `ffbcb7c`, alone, with the T1 smoke's findings disclosed; harness
  `888753c`; Amendment 1 (`6ccfbab`) after a void run and before the scored one. Verdicts as computed.
- **Void run:** `results/void-20261003T145930Z-prefix-collision/`: the `AB-reset` row swept in the `AB-reset-nr`
  files. Preserved unscored.
- **Scored run:** `results/run-20261003T150053Z/`, engine module `01afa96cbe0f…` (engine commit `b78c152`,
  ADR 0042 implementation with Amendment 1), DeploySignal `6ccfbab`, 32 closed onebox runs at run time
  (`manifest.json` records the directory). 0 exceptions. **The engine's T1 study (`2026-10-twin-two-sample`)
  was still running when this report was written**; its result is filed separately.

## 0. The headline

| Runs | Tasks per arm | Two-sample kind, margins (TS-m) | Two-sample, no margins (TS-0) | Per-metric kinds on the same runs | Verdict (bar 0.1062) |
|---|---|---|---|---|---|
| first A/A, 44 | 2 | **7 / 44** (upper 0.278), median tick 31 | 9 / 44 | 12 / 44 (all `sign`, unmargined) | **FAIL** |
| second A/A, 100 | 4 | **12 / 100** (upper 0.187), median tick 50 | 0 / 100 | 0 / 100 | **FAIL** |
| onebox A/A, 32 closed | 1 | 0 / 32 (upper 0.089) | 0 / 32 | 0 / 32 so far | PASS at N = 32 |
| `AB-lat30`, 20 | 4 | 0 / 20 in the **11** ticks available | 0 / 20 | 20 / 20 at tick 11 | reported |
| `AB-5xx-1.5`, 20 | 4 | **20 / 20 at median tick 30** (40 available) | 17 / 20, median 31 | 20 / 20 at tick 40 | reported |
| `AB-reset`, 20 | 4 | 1 / 20 (tick 46) | 0 / 20 | 0 / 20 | reported |
| `AB-reset-nr`, 21 | 4 | 0 / 21 in the **12** ticks available | 0 / 21 | 20 / 20 at tick 12 on `no_response` | reported |

Missing coordinates: none in any run.

## 1. Readings

**The kind fails the A/A at two and at four tasks per arm, and the mechanism is in the error-rate
coordinate.** On the second A/A, where the per-metric kinds gave 0 of 100 with the margin and 1 of 100
without, the two-sample kind with margins rolled back 12. Replayed with one coordinate at a time (a
diagnostic on the same run, no verdict): the 5xx-rate coordinate alone gives 12 / 100 with its margin and
7 / 100 without; the p99 coordinate alone gives 0 / 100 either way; both coordinates without margins give
0 / 100, the p99 coordinate diluting the rate's signal. The service's 503s come from a per-task counter,
so each arm's per-tick error count carries the phase of its four counters, a memory that persists from
tick to tick. The per-metric `rate` kind conditions on each tick's totals and is indifferent to that
memory; a predictable witness built from past ticks is not, and under arm-level autocorrelation the
pair is not exchangeable given the past. The T1 smoke's finding (per-arm AR(1) at σ 0.3 fires half the
time) is the same mechanism. The 12 fires are late (ticks 30–55), as a learned witness's are.

**At two tasks the kind fires on different runs than the sign kind did.** The 7 TS-m rollbacks on the
first A/A are all on runs the per-metric kinds held; the 12 sign-kind rollbacks (persistent p99 offsets,
direction only) are all held by the two-sample kind. Two tests of two different departures from
exchangeability; neither is a null the other certifies.

**At one task per arm, 0 of 32**, with an upper bound of 0.089 that the registered bar does not resolve.
Read with the rest: not evidence of validity.

**On the fault cells.** The two cells whose per-metric kinds rolled back at ticks 11 and 12 left the
two-sample kind 11 and 12 ticks, and it did not fire in them (Amendment 1 states this). On `AB-5xx-1.5`,
where 40 ticks were available, it rolled back 20 of 20 at a median of tick 30 against the `rate` kind's 40:
faster, on the same coordinate the A/A shows it mis-reads under the null. On `AB-reset` it fired once in
20 (tick 46) where the per-metric kinds fired never: one fire at a 5% level over 20 runs says nothing.

## 2. Predictions against results

- P1: first A/A predicted 15–30, **observed 7** (fails the bar, below the range, and on different runs than
  the sign kind); second A/A predicted 8–30, **observed 12**, in range; onebox predicted at least the
  second's rate, **observed 0 / 32**, wrong so far (the one-task arms' per-tick counts are about a quarter
  of the four-task arms', and the counter memory with them).
- P2: `AB-5xx-1.5` predicted 20 / 20 later than the rate kind (40–60); **observed earlier, 30**. `AB-reset`
  0–5: 1. `AB-lat30` and `AB-reset-nr`: not evaluable beyond the available ticks, as the amendment states.
- P3: TS-0 more rollbacks than TS-m in every row: **wrong** in two of three A/A rows (9 vs 7, 0 vs 12).
- P4 held.

## 3. What this establishes

The two-sample betting kind, as constructed in ADR 0042, does not hold its null on real randomized arms
at two or four tasks per arm, and the reason is structural rather than a defect: arms carry memory (a
counter's phase, a task's persistent offset), a predictable witness learns it, and the coordinate-wise
shrink cannot restore the sign kind's property because the shrunk differences stay asymmetric under a
sub-margin offset. The per-metric kinds survive the same arms because the `rate` kind conditions on
each tick and the `sign` kind discards magnitude. **The May 2026 claim that the portfolio finds patterns
per-metric detectors miss has, at the end of this programme, no real-data support at any point.** The
one place the two-sample kind beat a per-metric kind (tick 30 against 40 on `AB-5xx-1.5`) is on the
coordinate where it also produced 12 false rollbacks in 100. No authority changes.

## 4. Not measured

The onebox runs beyond 32; a two-sample test that conditions on per-tick totals (a paired-permutation
construction) rather than learning a witness; coordinates other than these two; the engine's T1 result.

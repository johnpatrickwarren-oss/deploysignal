# Report — the temporal path's null on real undeployed traffic (`2026-10-temporal-null-real`, T3 replay)

- **Registration:** `PREREGISTRATION.md` at `fa3dad9`, alone; harness `3079339`; raw series, calibration
  bundle and compiled config `89cf866`, all before the replay. No amendment. Verdicts as computed.
- **Run:** `results/run-20261003T053942Z/` from DeploySignal `89cf866` (engine `v0.13.0-pre`), compiled
  config sha256 `12b4729944e2…`. 100 sessions, 100 executable, 0 void, 0 harness failures; the three
  NOT-EXECUTABLE conditions did not trigger (0 void, Family A cells present, no calibration gap).
- **Verdicts:** E1 PASS (0 of 100), E2 Family A PASS (0 of 100), E3 and E4 reported. **Family D was not
  exercised** (§2), so its registered E2 line is vacuous and carries no verdict here.

## 0. The headline

Replayed through the shipped temporal path, calibrated from 34.6 hours of its own history the way an
operator would in week one, **100 sessions of 64 minutes on a service that did not change produced
0 rollbacks and 0 rollback-class fires from any family.** Family A's two detectors on `p99_latency`
and `downstream_err` did not fire once across 3,200 ticks, through 19 full-traffic sessions, 63
half-traffic sessions, 18 sessions with a two-fold traffic change inside them, and the four sessions
that begin at a cold restart. Family B held `low_traffic` at some tick in 81 sessions and rolled
nothing back; every session ended `proceed`.

| Endpoint | Registered bar | Result | Verdict |
|---|---|---|---|
| E1 false rollback | ≤ 1 of 100 at α_total 0.001 | 0 of 100; exact 95% upper bound 0.030 | **PASS** |
| E2 Family A | ≤ 1 of 100 at share 0.0004 | 0 of 100 | **PASS** |
| E2 Family D | ≤ 1 of 100 at share 0.0001 | not evaluated (§2) | — |
| E2 Families C, E | — | no cells compiled from two signals; no fires | — |
| E3 by regime | reported | full 0/19, half 0/63, mixed 0/18; restart 0/4; concordance 0 | — |
| E4 holds | reported | `low_traffic` in 81 sessions; 0 sessions end `extend`, 100 `proceed` | — |

What the PASS does and does not say: 100 sessions rule out a per-session false-rollback rate above
about 3%; they cannot confirm one as small as the 0.0004 budget. Family A is "not inconsistent with
its α on this service", not "shown to hold its α".

## 1. The series

Four lanes' `prod-old` target groups at two-minute resolution, 1,865 ticks each with no missing
datapoint; evaluation 825 ticks per lane. p99 over the evaluation window: median 76.4 ms, range
71.5–82.5; the half-traffic median (76.40) and the full-traffic median (76.30) differ by 0.1 ms,
so the two-fold traffic change moved per-task load but not p99 at this service's load. Error
rate 0.00500, as configured. Healthy hosts never below 2. Calibration: Family A δ_min 3.8 ms on p99
(τ² 3.65, so a per-tick σ of about 1.9 ms), 68 strict cells, 2 pooled, 770 none (aggregate fallback).

## 2. Family D was not exercised — a compiler / runtime inconsistency

The compiler attached Family D parameters for `p99_latency`, `downstream_err` and `traffic_pct`
(`baseline_cells.aggregate_fallback.family_D`). The runtime evaluates Family D only over
`FAMILY_D_SIGNALS` from `@johnpatrickwarren-oss/deploysignal-engine/detectors/spectral`, which is
`['kv_cache']` at `v0.13.0-pre` (`engine/gates/_health-detectors.ts:301`). This service has no
`kv_cache`, so the loop body never ran, `family_D_shadow` was never set, and the harness's "0 PASS"
for D is a count of nothing. Called directly on a real 30-tick long view, the evaluator returns
`clean` (statistic 0.27 against threshold 0.69), so it would run if the signal list included p99;
it does not. The engine's compiler and runtime disagree about which signals Family D watches; this
report records it and changes nothing. Filed to the wiki worklist.

The same dispatch wraps Family D in a bare `catch (_e) { /* silent */ }`. Had the evaluator thrown,
the result would have been indistinguishable from "clean". The direct call above is how this
report knows it did not.

## 3. Predictions against results

- P1 said E1 FAILS with 3–15 rollbacks (moderate confidence). **Wrong.** 0. The mechanism I named —
  the two-fold traffic change moving p99 beyond a δ_min calibrated from 34 h — did not occur: the
  traffic change did not move p99 (§1), and δ_min at 3.8 ms is about two per-tick σ.
- P2 (fires concentrated in `mixed` and restart sessions) is moot with no fires.
- P3 said Family A fires in more sessions than D and B holds in more than either fires. D was not
  evaluated; B held in 81 sessions against A's 0, so the second clause held trivially.
- P4 (if E1 passes, E2 still fails for A or D) **wrong**: A had 0 fires.

## 4. Post-hoc instrument check (no verdict)

To show the null is not a blind detector: lane 0 session 5 replayed with the recorded series
multiplied from tick 8 — p99 ×1.5 rolls back at tick 8 (`family_A_p99_latency`); p99 ×1.3 at tick 9;
p99 ×1.05 (3.8 ms, one δ_min) at tick 17; `downstream_err` ×3 at tick 18
(`family_A_betting_downstream_err`). Family A on this calibration detects a 5% p99 shift inside a
64-minute session and fired on none of the 100 real ones. These are labelled post-hoc and support
no claim about power.

## 5. Consequence for the question that motivated the study

Family A on these two signals now has one measured real-traffic null: 0 of 100 sessions on one
HTTP service, 64-minute sessions, 34-hour calibration, two-fold traffic variation, upper bound 3%.
That is the condition the 2026-10-03 note set for an advisory family to count as evidence that can
be averaged with others. It is met for A on this service at the strength 100 sessions give and not
for any other family: C and E compile nothing from two signals, D is not evaluated on them, B is a
rule set with no α. Whether this changes C87's disposition of Family A is a decision, not a finding;
the study did not test detection on anything but the instrument check.

## 6. Not measured

Families C, D and E on real traffic; the LLM-serving signals; calibration longer than 34.6 h or
other than `hour_of_day × day_of_week`; sessions longer than 64 min or ticks other than 2 min; the
recalibration path; the gate HTTP service; detection power (null study only); any service but this
one; a per-session rate below 3% (the resolution of 100 sessions).

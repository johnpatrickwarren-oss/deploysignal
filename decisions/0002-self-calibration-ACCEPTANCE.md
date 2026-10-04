# ADR 0002 — acceptance report for study `2026-10-self-calibration` (2026-10-03)

Run on the implementation in this PR (`tools/self-calibrate.ts`, `service/session/self-calibration.ts`, the
`self_calibration` field on tick and verdict responses), by `test/self-calibration.test.ts`; A4 against the GWDG
dataset present locally (`GWDG_DATA`), so A4 is reported here and skipped in CI.

| Item | Registered expectation | Result |
|---|---|---|
| A1 reproduction | 100 sessions, 0 fires, upper 0.030, `low_traffic` in 81, Family A on two signals | **holds** (the four `prod-old` raw series, calibration end 2026-10-02 01:30Z) |
| A2 exclusion | windows containing a change excluded and listed; session count falls by the sessions they cover | **holds** (two declared windows + one lifecycle-store session: every 64-minute block they touch, on every lane, is void with reason `change window`; sessions = 100 − those) |
| A3 the field | served on every tick and verdict; `null` without a record; `stale` when older than its span or on a changed config | **holds** (tick and `GET /v1/verdict`; the HTTP contract test gains the eighth key) |
| A4 a failing substrate | the GWDG unit the gate study rolled back reports a rate consistent with that study for the same window | **holds in the study's configuration and not in the shipped one, and the record says why**: with `--families A`, `hour_of_day` cells and risk `medium` as `2026-09-gwdg-gate` ran, 1 of 1 session rolls back on `SM_CLOCK` (the study: tick 92); with the shipped family set the compiler stamps a bootstrap betting threshold of 1.2 × 10¹⁹ on Family A (Family D compiling triggers the stamp, knowledge `stats/gwdg-gate-2026-09-29` finding 2), the detector cannot fire, and the record marks the signal `unreachable` |

**What A4 taught the feature.** "Calibrate as production would" has a production that, on this series, cannot
alarm, not because the null holds but because the threshold is absurd. A self-calibration record therefore
carries each Family A signal's compiled betting threshold against the Ville threshold n/α_A and flags
`unreachable` where the ratio exceeds 1,000; the served summary names those signals. Without that, the
feature would have reported "0 fires in N sessions" for a detector that was switched off, which is the
opposite of what ADR 0002 exists to prevent.

**A confound found on the way, stated for the record.** `2026-10-temporal-null-real` compiled with the full
family set and so ran Family A at bootstrap thresholds (1,973 on p99, 68 on the error rate) rather than the
Ville 15,000; `2026-09-gwdg-gate` compiled Family A alone and ran at Ville. Its 0 of 100 was measured at
thresholds lower than Ville and stands a fortiori; the comparison across the three substrates in
`stats/temporal-null-real-2026-10-03` mixes threshold rules and should say so (wiki follow-up).

**Acceptance rule:** A1–A4 hold. ADR 0002 ACCEPTED on merge of this PR. Not measured: a CloudWatch or
Prometheus fetch inside the tool (it takes raw tick files; the fetch stays with the study harnesses until a
source adapter is wired); attachment to individual advisory fires (C87's `advisory_fires` is not on main;
the whole summary is served on every tick and verdict instead).

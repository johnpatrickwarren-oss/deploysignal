# Report — the twin gate's `sign` kind as an A/A on same-cluster core pairs of the mac mini (`2026-09-mini-twin-aa`, T3, single box)

- **Study id:** `2026-09-mini-twin-aa`. Register: knowledge `WORKLIST.md` C86.
- **Run:** `results/run-20260929T022254Z/`, the registered command
  `node studies/mini-twin-aa/harness/run.mjs --mode full` at harness commit `55b687b` (branch
  `wt/mini-twin-aa`, no tracked changes), engine pin `v0.12.2-pre`, installed 0.12.2-pre, resolved
  `0434afcd…`, DeploySignal's own twin wrapper (`engine/gates/_health-twin.ts`); Node v25.9.0.
  All ten data hashes verified. **Exceptions: 0.** Wall time 2 s.
- **Endpoints, bars, arms and predictions** were frozen in `PREREGISTRATION.md` (commit `75521c4`,
  before any harness code) and amended once from the §6 smoke before any run (Amendment 1,
  `55b687b`: the layout check reads residency over the whole substrate; the swap check's mirror
  is `rollback → proceed`). Verdicts below are recorded **as computed**; no bar was moved.
- **Executable:** yes. 650,840 raw samples, 74,987 study ticks at 10 s (every tick has a sample),
  208 one-hour windows, all 208 scorable; every core's residency correlates best with its declared
  cluster (E 0.81–0.96, P0 0.85–0.86, P1 0.68–0.93). The smoke passed (a +20 residency injection
  fires at tick 8; a rollback window with the arms swapped ends `proceed`; accounting holds).

## 0. The headline

**E1: FAIL.** Pooled over the six same-cluster pairs, **594/1248** windows ended `rollback` (rate
**0.4760**, upper 95% bound **0.4996**), against the gate's own α_rollback of 0.05. Registered
prediction P1 (FAIL, pooled rate ≥ 0.20) held.

**The failure is persistent placement, and it is cluster-specific.**

| Pair | Cluster | Rollback | Proceed | Inconclusive | Tie share | Median rollback tick |
|---|---|---|---|---|---|---|
| `c0`–`c1` | E | 208/208 = 1.0000 | 0 | 0 | 0.011 | 8 |
| `c2`–`c3` | E | 208/208 = 1.0000 | 0 | 0 | 0.011 | 8 |
| `c4`–`c5` | P0 | 4/208 = 0.0192 | 1 | 203 | 0.986 | 29 |
| `c6`–`c7` | P0 | 1/208 = 0.0048 | 9 | 198 | 0.986 | 317 |
| `c9`–`c10` | P1 | 88/208 = 0.4231 | 120 | 0 | 0.062 | 8 |
| `c11`–`c12` | P1 | 85/208 = 0.4087 | 123 | 0 | 0.038 | 8 |
| `c0`–`c9` (arm X) | E/P1 | 208/208 = 1.0000 | 0 | 0 | 0.014 | 8 |

- **E-cluster:** every window rolled back, at a median of 8 ticks (80 s): the first-named core
  carries more residency than its neighbour on nearly every non-tied tick, hour after hour. That is
  persistent arm-level state of the kind ADR 0036 names, on real hardware, at this tick scale.
- **P1-cluster:** every window reached a terminal verdict within about 8 ticks, 42% `rollback` and
  58% `proceed`. Within an hour one core of the pair is consistently busier; which one varies by
  window (by day: 7–15 of 24 windows rolled back). The sign test sees P(canary worse) far from ½
  in both directions; an A/A pair passes the premise only if placement is symmetric, and here it
  is stable within the hour and unstable across hours.
- **P0-cluster:** idle for the ten days (tie share 0.986), so 96–98% of windows ended
  `inconclusive` at `max_ticks` and the two pairs clear the bar on ties, not on exchangeability.
- **Arm X** (control, E-core against P-core) rolled back in every window, median tick 8, p90 8,
  maximum 34: the instrument rejects a pair it should reject, quickly.

## 1. Endpoints

| Endpoint | Value | Bar | Verdict |
|---|---|---|---|
| E1 pooled false rollback, arm S | 594/1248 = 0.4760 (upper 0.4996); per pair: 1.0000, 1.0000, 0.0192, 0.0048, 0.4231, 0.4087 | ≤ 0.05 | **E1: FAIL** (two P0 pairs pass, on ties) |
| E2 outcome mix, arm S | proceed 253, inconclusive 401, rollback 594, invalid_experiment 0; tie share 0.889 pooled; skipped 0 | — | reported |
| E3 arm X | 208/208 rollback, median tick 8 | — | reported |
| E4 instrument | hashes ok, exceptions 0, 208 scorable windows, layout confirmed | | **E4: PASS** |

## 2. Predictions

- **P1 held.** E1 fails pooled (0.4760 ≥ 0.20) and on (`c0`,`c1`). Its second named pair,
  (`c4`,`c5`), passed because the P0 cluster was idle (see P3), not because placement was symmetric.
- **P2 held.** Arm X rolled back in 1.00 of windows (bar 0.90) at a median tick of 8 (bar < 60).
- **P3 held.** P0 tie share 0.986 (bar > 0.50); 401 of 416 P0 windows ended `inconclusive`.
- **P4 held.**

## 3. What this establishes, and what it does not

*Observation.* Two cores of one cluster under no intervention are not exchangeable tick by tick:
on the busy E-cluster one core is persistently busier and the twin's sign test rejects the pair in
80 s, every hour, for ten days; on the P1-cluster the busier core changes from hour to hour and the
test rejects or clears within about 80 s either way. Only an idle cluster passes, on ties.

*Inference.* The pairing premise "no arm-level effect on any tick" is not a property of hardware
units sharing a box; it is a property of how load reaches the units. Per-request randomized
routing is what would make two service instances exchangeable, and it is what a core pair lacks.
For the real-service A/A this sharpens the question: it must show that routing removes the
persistent asymmetry this box shows without it. It also shows the sign kind's speed on a
persistent offset: ~8 ticks at tolerance 0.15 and α 0.05 when P(worse) is near 0 or 1.

**Not established.** Anything about request-routed services, the `rate` kind, the sample-ratio
guard under real routing (counts are constants here), fleets, FDR, deploys, or any tick scale,
window or tolerance but the registered ones. `TWIN_ARM_AUTHORITY` stays `'advisory'`; the
real-service A/A remains the condition for any authority ADR.

## 4. Not measured

Requests and routing; the `rate` kind; `core_mhz`; ticks other than 10 s, windows other than 1 h,
tolerances other than 0.15; the post-gap days on the mini; the Phase 2 interventions; the
missingness penalty (no tick was missing at 10 s); cross-cluster pairs other than (`c0`,`c9`).

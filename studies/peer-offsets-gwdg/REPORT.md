# Report — offsets and margin floors from each GPU's own pre-window, on the same windows (`2026-10-peer-offsets-gwdg`, T3 replay)

- **Registration:** `PREREGISTRATION.md` at `4c6adee`, alone; harness `9feb784`; no amendment. Verdicts as computed.
- **Run:** `results/run-20261003T141627Z/`: 44 null and 40 detection windows, arms FL90 (primary) and FL75,
  engine module `6ff4582a0de8…` (engine PR #118, `v0.16.0-pre` candidate, checkout `e768c05`), DeploySignal
  `9feb784`; 0 exceptions, 0 hash mismatches, 0 voids. Not NOT-EXECUTABLE.
- **Disclosed:** the smoke before the scored run computed the arm on one file's eight windows and I looked
  at one window's offsets and e-value trace to confirm the offsets enter the scoring (fires at tick 138
  with them against 35 without); no bar or prediction changed.

## 0. The headline

| Null on the same 44 healthy windows | Healthy windows rolled back | Incident windows rolled back |
|---|---|---|
| own four-day history (`2026-09-gwdg-gate`) | 40 / 44 = 0.909 | 34 / 40 |
| node-mates, fixed 10% margin (`2026-10-peer-rank-gwdg`) | 26 / 44 = 0.591 | 28 / 40 |
| node-mates, each pair's pre-window offset and q0.90 floor (**this study, FL90**) | **13 / 44 = 0.295** (upper 95% 0.428; 1.03 per 1,000 ticks) | 16 / 40, every one before `I` |

| Endpoint | Bar | Result | Verdict |
|---|---|---|---|
| E1 false rollback, FL90 | ≤ 0.05 | 13 / 44 | **FAIL** |
| E2 detection, FL90 | ≥ 0.50 | 16 / 40 = 0.400; median lead −17.8 h; 16 of 16 before `I` | **FAIL** |
| E4 FL75 | reported | null 18 / 44; detection 22 / 40 | — |
| E5 instrument | — | holds | — |

## 1. Readings

**Each step halves the false-rollback count and none reaches the bar.** 40, 26, 13. The offsets and
floors remove the persistent two-working-two-idle structure where it persists: in five files the
earlier study rolled back all four GPUs and this one rolls back none in four of them. What remains
fires at the same early ticks (14, 15, 37, 39) in 11 of 13 cases: a gap that was one thing in the
pre-window and another from the scored window's first tick.

**The gap drifts even when the roles do not.** The temperature-rank diagnostic changed by a full rank
in only 4 of 44 null windows, and 2 of those rolled back; the other 11 rollbacks are units whose
hot-or-cold role held and whose gap moved anyway. The smoke's example is typical: a GPU that ran 26%
hotter than two idle mates in the pre-window (floor 0.49) ran 2.5–3.2× hotter in the scored window,
because the idle GPUs cooled from 45 °C to 28 °C over the intervening days. The premise ADR 0041 asks
the consumer to state, "the gap after lies within the range it occupied before, up to the declared
quantile", does not hold on this cluster between windows a day or more apart.

**The floors say so.** Of 1,554 pair-signal floors, 1,003 exceed the 10% spec margin (binding), 581
exceed 0.50 and 224 exceed 1.00: the pre-window gap itself was unstable for a third of the pairs.
Median floors by signal: `GPU_UTIL` 1.00 and `MEM_COPY_UTIL` 1.00 (utilisation swings between 0 and
100 within four days), `SM_CLOCK` 0.85, `POWER_USAGE` 0.59, `GPU_TEMP` 0.21, `MEMORY_TEMP` 0.08,
`MEM_CLOCK` 0.00. A floor of 1.00 removes the pair; the remaining 13 rollbacks come through the
pairs the pre-window called stable. 210 pair-signals were dropped for fewer than 144 common ticks.

**Detection is not detection, again.** All 16 incident-window rollbacks fire before the incident
day, 11 of them at the same two ticks as the null windows (−21.7 h and −17.8 h, ticks 14 and 37); no unit disappeared
by the registered rule. Of the 16, 12 are on units the temporal path also rolled back and 4 on units
it passed; 22 units the temporal path rolled back this kind held. FL75 (a tighter floor) has more of
both, 18 and 22.

## 2. Predictions against results

- P1 said 3–9 of 44, failing but far below 26. **The count is 13**, above the range and below 26; the
  mechanism I named (roles switching between windows) accounts for 2 of the 13. The actual mechanism,
  gap drift under stable roles, I did not name.
- P2 said 0.20–0.45; **0.400**, in range; the clause about not being able to tell detections from
  structure held: they fire at the null windows' ticks.
- P3 held: floors over 0.10 on 1,003 of 1,554 pairs (65%), over 1.00 on 224 (14%); FL75 more rollbacks
  on both kinds.
- P4 held.

## 3. What this establishes

Three measurements on identical windows, hardware and dates: 0.909, 0.591, 0.295. Each construction
in the designed-null series does what its study says it does, and each premise is false on this
cluster by a smaller amount than the last. The remaining premise, a gap stable across days, is not
one that node-mates under a batch scheduler satisfy, and no quantity from a pre-window can declare
a stability the hardware does not have. On this data the comparator mode needs peers that share a
workload or a pre-window that ends where the scored window begins; the former is not in the
dataset and the latter is what the twin does by running the arms at the same time. The kind is
valid where its premise holds (`2026-10-peer-offsets-2`), and this cluster is a measurement of how
rarely the premise holds for chassis-mates, not a refutation of the construction. No authority
changes.

## 4. Not measured

A pre-window adjacent to the scored window; peers by workload; additive offsets; other quantiles
than 0.90 and 0.75; other datasets.

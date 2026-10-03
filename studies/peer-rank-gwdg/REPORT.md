# Report — the rank-among-peers kind on real GPU telemetry (`2026-10-peer-rank-gwdg`, T3 replay)

- **Registration:** `PREREGISTRATION.md` at `263efa0`, alone; Amendment 1 (`79a4160`, seven signals, 14
  tests, threshold 280) and Amendment 2 (`8c794e2`, the engine pin by module hash) before any run;
  Amendment 3 (`5aaed4f`) after a void run and before the scored one. Verdicts as computed.
- **Void run:** `results/void-20261003T131943Z-instrument-defect/`, preserved unscored. The engine module
  fires and becomes terminal at its own `1/alpha`; the harness set `alpha 0.05` per spec and checked a
  Bonferroni threshold of 280 outside it, so every e-process froze at 20–30 and its "0 of 44, 0 of 40"
  measured nothing. The instrument check caught it: a planted ×3 on a unit's GPU temperature with mean
  score 1.00 over 288 ticks did not fire. After the correction the same plant fires at tick 141; ×1.3 and
  the unmodified window hold.
- **Scored run:** `results/run-20261003T132332Z/`: 44 null windows, 40 detection windows, arms M10 and M5,
  engine module `b7901965efb8…` at a checkout descending from `af805e8` (`v0.15.0-pre` candidate),
  DeploySignal `5aaed4f`; 0 exceptions, 0 hash mismatches, 0 voids. Not NOT-EXECUTABLE.
- **Disclosed:** the smoke before the scored run computed the kind on one file's eight windows (all held
  under the defective instrument) and I saw that; no bar or prediction was changed afterwards.

## 0. The headline

| Endpoint | Bar | Result | Verdict |
|---|---|---|---|
| E1 false rollback, 44 null windows, M10 | ≤ 0.05 | **26 / 44 = 0.591** (upper 95% 0.716; 2.05 per 1,000 ticks) | **FAIL** |
| E2 detection, 40 incident windows, M10 | ≥ 0.50 | 28 / 40 = 0.700; median lead −17.8 h; 27 of 28 before `I` | PASS, and not detection (§1) |
| E4 arm M5 | reported | null 32 / 44; detection 33 / 40 | — |
| E5 instrument | — | 0 exceptions; hashes verified; engine module pinned | holds |

Beside the temporal path on the same 44 windows: 40 of 44 against each GPU's own history, 26 of 44
against its node-mates at the same time. Peers at the same time are a stronger null than own history
on this hardware, and they are not a null.

## 1. Readings

**Node-mates are not exchangeable.** Nine of the 26 null rollbacks fire at tick 14, the earliest tick
at which 280 can be reached: a unit that is beyond the 10% band against all three peers from the
window's first tick. In five of the eleven files all four GPUs roll back, two on `GPU_TEMP:higher` or
`POWER_USAGE:higher` and two on the `:lower` side of the same signals. That is two GPUs working and two
idle for a day or more under a scheduler: temperatures of 80–95 °C beside 25–45 °C on the same node
(`ggpu129_2026-01-09`, null window). The kind did what it is for, and what it is for is not present:
a unit exchangeable with its peers.

**The detections are the same structure.** The lead times cluster at −21.7 h and −17.8 h, which are
ticks 14 and 37 from the detection window's start, the same ticks the null windows fire at. Of the 28
detection rollbacks, 23 are on units the temporal path also rolled back and 5 on units it passed; 11
windows the temporal path rolled back the peer kind held. No unit disappeared by the registered rule
(every signal absent while two peers report, for six ticks) in any of the 40 windows, so the
"detection at disappearance" the first study saw has no counterpart here. E2's PASS is a count of
heterogeneity reaching 280 inside a 48-hour window and supports no detection claim.

**Post-hoc, no verdict** (`analysis/posthoc-margins.mjs`, `results/run-20261003T132332Z/posthoc-margins.json`):
the same windows at relative margins 0.2, 0.3, 0.5 and 1.0 roll back 22, 21, 20 and 9 of 44 null
windows, and 19, 19, 17 and 8 of 40 detection windows. Detection tracks the null rate at every
margin. A GPU running at twice its node-mates' temperature or power for a day is ordinary on this
cluster; no margin short of "anything goes" absorbs it, and a margin that did would see nothing.

## 2. Predictions against results

- P1 said E1 fails narrowly, 3–7 of 44. **Wrong by a factor of four to eight:** 26. The mechanism I
  named (one GPU idle while three work, a 10% margin on utilisation and clocks) was the right one and
  I under-estimated how common and how large it is: the first signals are temperature and power, not
  utilisation, and the spread is two-fold, not tens of percent.
- P2 said E2 fails at 0.25–0.50 because incidents are node-level and detached GPUs cannot be
  scored. **Wrong on the number** (0.70 passes) **and the reading holds for the wrong reason**: the
  "detections" are the null structure, and no disappearance occurred.
- P3 held: M5 has 32 against 26 null rollbacks and 33 against 28 detections (1.23× and 1.18×; I said
  at least 2× and at most 1.5×, so the first clause failed).
- P4 held.

## 3. What this establishes

On this cluster a GPU's node-mates are a better null than its own four-day history (0.591 against
0.909 on the same windows) and a bad one. The construction is valid where its premise holds (the
engine study: 0.000 over 2,000 ticks at N = 4 and 16) and the premise does not hold here. The
designed-null programme's next step follows from the data: a comparator that removes each unit's
persistent offset against its peers before scoring, difference-in-differences on the pre-change
concurrent gap, or peer sets chosen by shared workload rather than by chassis. The margin alone does
not do it. Nothing here changes any authority; the twin's results are untouched.

## 4. Not measured

Peer sets other than node-mates; offset adjustment; absolute margins; detection on a cluster whose
GPUs share a workload; any other dataset.

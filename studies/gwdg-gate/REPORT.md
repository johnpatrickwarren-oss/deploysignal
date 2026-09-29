# Report — the DeploySignal temporal-path gate on GWDG GPU node telemetry (`2026-09-gwdg-gate`, T3)

- **Study id:** `2026-09-gwdg-gate`. Register: knowledge `WORKLIST.md` C85.
- **Runs:** `results/run-20260929T012317Z/` (225 s) and `results/run-20260929T012741Z/` (289 s), both
  the registered command `node studies/gwdg-gate/harness/run.mjs --mode full` at harness commit
  `af90e86` (branch `wt/gwdg-gate`, no tracked changes), engine pin `v0.12.2-pre`,
  installed 0.12.2-pre, resolved `0434afcd…`; Node v25.9.0. The second run was made because the operator
  asked for a restart while the first was being read; the first is preserved. `units.json`,
  `windows.json`, `endpoints.json` and the bundle hashes are byte-identical across the two; the
  compiled configs differ only in the compiler's `compile_phases` timings (excluded from git, hashed
  in each run's `configs.SHA256SUMS`). All 18 dataset hashes verified. **Exceptions: 0. Compiler
  failures: 0 of 88 compiles.** The §6 smoke passed under Amendment 1 (`harness/smoke.mjs`: a +5σ
  step from tick 0 on `GPU_TEMP` fires on that signal at tick 0 on arm `A` and tick 1 on `AC`;
  detectors ran on every tick).
- **Endpoints, bars, arms and predictions** were frozen in `PREREGISTRATION.md` (commit `4b97ffa`,
  before any harness code) and amended once before any run (Amendment 1, `af90e86`, from the smoke).
  Verdicts below are recorded **as computed**; no bar was moved.
- **Executable:** yes. 16 files, 64 units, 44 candidate units, 44 null units, 40 detection units,
  20 excluded (every exclusion by the calibration-ends-after-`E_first − 24 h` rule; the units and
  reasons are listed in `units.json`). §2 of the registration enumerated 40 candidates; the rules as
  written admit four more, the GPUs of the unlabelled `ggpu142_2025-03-15` file as null-only units
  (the null rule has no label requirement). Reported here, not silently applied: the primary E1 is
  on the 44 the rules give; the 40-unit figure is beside it.

## 0. The headline

**E1: FAIL on both arms, far beyond the registered prediction.** On healthy two-day windows the
Family-A-only gate rolled back **40/44** units (rate **0.9091**, one-sided 95% upper bound
**0.9683**, **12.9 per 1,000** ticks); with Family C beside it, **42/44** (**0.9545**, upper bound
**0.9919**, **18.6 per 1,000** ticks). The null windows are per-GPU telemetry from the same node,
compiled from the GPU's own preceding four days with the shipped compiler and run at Ville's 1/α
with α_total = 10⁻³. P1 predicted at least 0.25; the measurement is nine in ten.

**E2: PASS on both arms, and it carries no evidence of detection.** 34/40 (0.8500) detection
windows ended in rollback on arm `A` and 35/40 (0.8750) on `AC`, but each unit's paired null window
of the same length rolled back at a higher rate. Per unit on arm `A`: 33 units rolled back in both
windows, 3 in the null window only, 1 in the detection window only, 3 in neither; on `AC`: 35
units in both, 3 null-only, 0 detection-only, 2 neither. The median fire tick is 47 in null windows
and 11 in detection windows on arm `A` (25.5 and 11 on `AC`); the earlier detection-window fires
are consistent with a gate that fires on the first excursion it meets, not with a fault signal. A
PASS on E2 next to a 0.91 null rate is the instrument reading itself, and it is reported as such.

**Nothing fired before the hardware's own fault code, and nothing fired on disappearance.** Where
`DCGM_FI_DEV_XID_ERRORS` was nonzero inside the detection window (20 units on `A`, 17 on `AC`),
every fire came at or after the first XID tick: **0 of 18** before on `A` (median 17.5 ticks after),
**0 of 15** on `AC` (median 12 ticks after); in 17 of those units XID was already nonzero at the
window's first tick, so the reference is coarse. Four detection windows lost DCGM samples (three
GPUs of `ggpu129_2026-01-09` for 88 of 288 ticks, one GPU of `ggpu139_2025-03-21` for 23) and every
one of them ended `proceed`: an absent signal is no evidence to the gate, so the failure class the
dataset paper names as dominant, observability collapse, is invisible to it.

## 1. Endpoints

| Endpoint | Arm `A` | Arm `AC` | Bar | Verdict |
|---|---|---|---|---|
| E1 false-rollback rate on null windows | 40/44 = 0.9091 (upper 0.9683; 12.9 per 1,000 ticks over 3,096) | 42/44 = 0.9545 (upper 0.9919; 18.6 per 1,000 over 2,256) | ≤ 0.05 | **E1: FAIL**, both arms |
| E2 detection rate on detection windows | 34/40 = 0.8500 | 35/40 = 0.8750 | ≥ 0.50 | **E2: PASS**, both arms (uninformative, §0) |
| E3 lead vs `I` (report only) | median −22.2 h; early 31 of 34 | median −22.2 h; early 34 of 35 | — | reported |
| E3 lead vs first XID (report only) | 0 of 18 before; median +17.5 ticks | 0 of 15 before; median +12 ticks | — | reported |
| E4 Family C's contribution (report only) | — | +1 detection (`ggpu139_2025-03-21__gpu0`), +2 false rollbacks (`ggpu139_2025-03-21__gpu0`, `ggpu149_2025-06-12__gpu0`); C was the first detector on 9 of 42 null rollbacks and 7 of 35 detections | — | reported |
| E5 instrument | exceptions 0, compile failures 0/88, voided units 0 | | 0 exceptions; ≤ 10% compile failures | **E5: PASS** |

First signal of the null-window rollbacks on arm `A`: `POWER_USAGE` 11, `SM_CLOCK` 7, `GPU_UTIL` 7,
`GPU_TEMP` 6, `MEM_COPY_UTIL` 5, `MEMORY_TEMP` 4 (`MEM_CLOCK`, floored, never). On `AC`:
`GPU_UTIL` 13, `family_C` 9, `MEM_COPY_UTIL` 6, `SM_CLOCK` 5, `POWER_USAGE` 5, `GPU_TEMP` 2,
`MEMORY_TEMP` 2. Every unit compiled to 48 cells carrying Family A parameters (24 hours × the
aggregate and one tenant tier), all with `confidence: pooled`; the σ floor applied to `MEM_CLOCK`
on every unit and to nothing else; every threshold was `ville` (Amendment 1 §3).

## 2. Predictions

- **P1 held.** E1 fails on both arms; the point figure "at least 0.25" is exceeded by 0.66.
- **P2 half held.** E2 passes on both arms. Its second clause, "early fraction below 0.5", is
  wrong: 31 of 34 and 34 of 35 fires precede `I`. The mechanism in P2 ("mostly on the incident
  day or at disappearance") is also wrong: disappearance produced no fire at all (§0), and the
  fires are the same first-excursion fires the null windows show.
- **P3 held.** `AC` adds one detection and two false rollbacks.
- **P4 held.** E5 passes.

## 3. What this establishes, and what it does not

*Observation.* At engine `v0.12.2-pre`, a Family-A-only profile compiled by the shipped compiler
from four days of a GPU's own DCGM telemetry, run at Ville's 1/α with α_total = 10⁻³ over the
next two healthy days, rolls back 91% of units; adding Family C on the same seven signals makes it
95%. The detectors fire on the healthy data's own excursions (median 7.8 h into the window on `A`),
and no fire precedes the hardware fault code where one exists.

*Inference.* This is the estimated-baseline failure the record predicted, on the gate rather than
on a detector card: engine ADR 0012 measured per-shard `E[e|H0]` far above 1 on this dataset, and
C76 measured the same cards' false alerts flat in calibration length on NAB. A four-day calibration
of nonstationary per-GPU telemetry (`SM_CLOCK` takes 3 to 11 distinct values per unit, with σ between 86 and 594
around means of 216 to 1,307; `GPU_UTIL` is zero-inflated) is not the reference law the wealth processes need, and the
per-hour cells they run against carry 24 samples each.

**Not established.** Anything about deploys, canary-versus-control gating, the twin path, or the
decision policy: the units are GPUs that later fail, with day-level labels. Detection of the GWDG
failure class: E2 cannot be read against a 0.91 null rate, and the class's dominant signature is
metric disappearance, which the gate does not score. Whether a longer calibration, day-of-week
cells, the bootstrap thresholds (stamped only when Family D compiles), a different α, or the
engine's estimation-robust constructions (safe-t, universal inference, the randomized twin) would
change the rate: none was run. Bake lengths beyond two days on the null side.

## 4. Product findings (recorded for the wiki; none changes a verdict)

1. **Family A does not run when no hour cell reaches 20 samples.** With a 72-hour calibration
   every hour cell held 18 samples, below `MIN_SAMPLES_POOLED`
   (`tools/calibrate/_calibrate-constants.ts`), so no cell carried `family_A`; `familyAPromoted`
   (`engine/gates/health.ts`) was false and Family A was never evaluated, although the aggregate
   fallback carried every per-signal parameter. The gate emits `proceed` throughout. Amendment 1 §1.
2. **The bootstrap thresholds are stamped only when Family D compiles.**
   `tools/calibrate/_calibrate-main.ts` calls `attachFamilyDAndStamp` under `if (baselineCells &&
   emit.D)`; a profile with D off, such as `generic-microservice`, ships Family A and safe-Hotelling
   at Ville's 1/α, not at the `bootstrap_crossing_rate` thresholds `engine/guarantees.ts` describes
   for the LLM profiles. Amendment 1 §3.
3. **A constant-zero signal compiles to σ² = 0.** The compiler's σ floor is relative to the mean
   (`tools/calibrators/family-a.ts` `meanStd`), so `NVLINK_BANDWIDTH_TOTAL` at a constant 0 left
   the standardization undefined. Amendment 1 §2.
4. **Missing signals are silence.** An absent metric produces no verdict (`_page-cusum-mixture.js`,
   `live === undefined → null`; Family C returns null when any joint-vector signal is absent), so
   metric disappearance never moves the gate toward rollback (§0).
5. **`pooledN` is keyed to `p99_latency`.** In the pooled branch of
   `tools/calibrate/_calibrate-derive-cells-helpers.ts` the cell's `n_samples` is taken from
   `p99_latency` only, so every cell here reports `n_samples: 0`. No verdict here depends on it.

## 5. Post-hoc (labelled; no verdict)

- **E1 on the 40 units the registration enumerated** (the `ggpu142_2025-03-15` GPUs removed):
  arm `A` **36/40** = 0.9000, arm `AC` **38/40** = 0.9500. Same verdict.
- **Paired null/detection outcomes** (§0): on `A` 33 units rolled back in both windows, 3 in the
  null only, 1 in the detection only (lead −13.0 h), 3 in neither; on `AC` 35 units in both, 3
  null-only, 0 detection-only, 2 neither.
- **Fire timing.** Null-window fires within the first 24 ticks (4 h): 16 of 40 on `A`, 19 of 42 on
  `AC`; detection-window fires within 24 ticks: 18 of 34 and 23 of 35. Every one of the 8 units of
  `ggpu143_2025-03-21` and `ggpu149_2026-01-19` fired at tick 0 or 1 of the detection window; on
  the latter XID was already nonzero at tick 0, on the former XID never appeared.

## 6. Not measured

Deploys, canary or control arms, the twin path, Families B, D and E, `FB_USED`, the PCIe replay
counter and XID as gate signals, node-level and scrape-pipeline metrics, day-of-week cells,
calibrations longer than four days, α other than 10⁻³, the bootstrap thresholds, the
estimation-robust engine constructions, the two `when-good` aggregates, the post-incident days, and
any tuning of the compiler.

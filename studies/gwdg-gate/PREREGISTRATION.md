# Pre-registration — the DeploySignal temporal-path gate on GWDG GPU node telemetry (`2026-09-gwdg-gate`, tier T3)

- **Study id:** `2026-09-gwdg-gate`
- **What it serves:** the 2026-09-28 architecture review found that the DeploySignal gate (the
  consumer, with its calibration compiler and fused verdict) has produced no verdict on real
  telemetry at any engine pin: the only attempt, the 2026-07-17 real-trace comparator at engine
  0.6.1-pre, skipped all four request-log bundles. This is the first run of the shipped temporal
  path (Family A, and Family A + C) over real multivariate telemetry with labelled faults.
- **Tier:** T3 (real telemetry). It is **not deploy-shaped**: the units are GPUs on nodes that later
  fail; there is no version change, no canary, no control arm. A result bears on the detectors
  and the compiler on real telemetry, not on the decision policy or the twin path.
- **Repo:** deploysignal at `c012e02` (branch `wt/gwdg-gate`, worktree). **Engine:**
  `@johnpatrickwarren-oss/deploysignal-engine` v0.12.2-pre, resolved
  `0434afcdc7a4716788dc81427295c6c4cd14e019` (package-lock.json). Node v25.9.0, darwin.
- **Register:** knowledge `WORKLIST.md` C85.
- **Status: REGISTERED, NOT RUN.** A later change is an amendment, appended and dated, before the run.

## 0. Disclosures

- (a) Seen before registration, none of it a study result: the dataset's documentation and label
  tables; a coverage census of the 16 telemetry files (per file: cadence, GPU count, per-metric
  sample counts and first/last timestamps; the script is committed unchanged as
  `analysis/coverage.py`); engine ADR 0012 (2026-06-25), which ran the engine's per-detector cards
  on this dataset at an older engine and found per-shard `E[e|H0]` far above 1 after every
  preprocessing level while fleet e-BH held empirically. No detector and no gate has been run on
  the data in this session before this commit.
- (b) The labels are day-level. `incident_events.csv` gives `incidentDate` as a calendar day and
  the operators' window as `collectStart = incidentDate − 24 h`, `collectEnd = incidentDate + 2 h`.
  The onset inside the day is unknown. Every lead time below is relative to `incidentDate 00:00
  UTC` and is coarse by up to one day.
- (c) Family A's plug-in envelope is `validUnderEstimatedBaseline: false` (engine
  `detectors/validity-envelope.ts`). The study profiles grant the eight study signals rollback
  authority through `family_a_rollback_signals`, the operator decision `profiles/README.md`
  describes. The study measures the path as it would ship for such a profile.
- (d) Determinism: the compiler's bootstrap seeds are fixed constants (`tools/calibrators/family-a.ts`
  `FAMILY_A_BETTING_BOOTSTRAP_SEED` and the Family C/D siblings); the harness draws no random
  numbers and writes no wall-clock value into a tracked artifact. Run directories are named by the
  UTC start time and are append-only.
- (e) Missing values. The gate's shipped behaviour on an absent signal is used unchanged: Family A
  returns no verdict for that signal on that tick (engine `_page-cusum-mixture.js`, `live ===
  undefined → null`), the betting e-process holds, Family C skips the tick. The dataset paper
  names metric disappearance as the dominant failure signature; the harness therefore also records,
  per unit, the first detection-window tick at which any study signal is missing, beside the gate's
  fire tick. Nothing is imputed.

## 1. Substrate

GWDG GPU Node Telemetry Dataset v1.0.0 (Zenodo `10.5281/zenodo.19052367`, CC BY 4.0), the copy
Tessera fetched at `../tessera/runs/gwdg-data/gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0/`.
Frozen by `SHA256SUMS` in this directory: the 16 `*_tidy.csv.bz2` originals, the 16 decompressed
`*_tidy.csv` the harness reads, `incident_events.csv` and `manifest.csv`. The harness verifies the
four label/manifest hashes and the hash of every file it reads before any window runs; a mismatch
is NOT EXECUTABLE.

Sixteen per-incident node files (10-day spans, 10-minute cadence, four GPUs per node, 259–260
metrics each). The five `nodes_total_gpus_when_good_*` quarterly aggregates are not used.

**Study signals** (eight, per GPU, DCGM): `DCGM_FI_DEV_GPU_TEMP`, `DCGM_FI_DEV_MEMORY_TEMP`,
`DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_MEM_COPY_UTIL`,
`DCGM_FI_DEV_SM_CLOCK`, `DCGM_FI_DEV_MEM_CLOCK`, `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL`.
Excluded, with the reason: `DCGM_FI_DEV_FB_USED` and `DCGM_FI_DEV_PCIE_REPLAY_COUNTER` are present
on 60–79% of ticks in eight files and the replay counter is cumulative; `DCGM_FI_DEV_XID_ERRORS` is
the hardware's own fault code and is used only as a reference clock (`xid_first_tick`, the first
detection-window tick with a nonzero value); node-level and scrape-pipeline metrics are not per
unit.

**Events.** For a node, an event is any `incident_events.csv` row for that node, or any telemetry
file date for that node (the `ggpu142_2025-03-15_unknown-error-possibly-nongpu` file has no label
row and counts as an event).

## 2. Units and windows

Unit = (file, gpu index). Tick = one 10-minute sample on the file's timestamp grid; a signal is
missing on a tick when the tidy table has no row for (timestamp, gpu, metric).

- **Calibration window:** the first 432 ticks (72 h) from the file's first DCGM timestamp for that
  GPU. Eligible iff it ends at or before `E_first − 24 h`, where `E_first` is the node's earliest
  event inside the file span, and every study signal is present on at least 400 of its ticks.
- **Null window:** `[calibration end, E_first − 24 h)`. The unit is a **null unit** iff the window
  holds at least 144 ticks.
- **Detection window:** `[I − 24 h, I + 24 h)`, 288 ticks, where `I` is the file's own incident date
  at 00:00 UTC. The unit is a **detection unit** iff no other event of the node lies in
  `[file start, I − 24 h)` or inside the window; otherwise it is `confounded`, reported, not scored.

Applied to `manifest.csv` and `incident_events.csv` before any run, the rules give ten eligible
files, 40 candidate units: `ggpu129_2026-01-09`, `ggpu139_2025-03-21`, `ggpu142_2025-02-17`,
`ggpu142_2025-07-03`, `ggpu142_2025-09-12`, `ggpu143_2025-03-21`, `ggpu144_2025-03-21`,
`ggpu149_2025-03-21`, `ggpu149_2025-06-12`, `ggpu149_2026-01-19`. Excluded: `ggpu121_2025-02-10`
(DCGM data starts 2025-02-06 16:40, so the calibration window ends after `I − 24 h`);
`ggpu129_2026-01-13` and `ggpu129_2026-01-19` (a prior incident of the node falls inside the
calibration or null window); `ggpu142_2025-03-15` (no label row); `ggpu142_2025-03-19` and
`ggpu142_2025-03-21` (events on 03-15, 03-19 and 03-21 inside their spans). The harness re-derives
this table from the files and prints it; a difference from this paragraph is reported as such,
never silently applied. The per-signal presence floor may exclude further units; each is listed
with the failing signal.

## 3. Calibration and arms

**Bundle per unit** (the compiler's `BaselineBundle` format): `cell_dim: 'hour_of_day'`; runs are
the maximal contiguous stretches of the calibration window on which all eight signals are present;
`hour_of_day[]` from the UTC timestamp of each tick; `tenant_id` the GPU's pseudonymous uuid;
`baseline_provenance: 'real_gwdg'`; `generated_at` fixed to the dataset version string, never the
clock. Compiled with the shipped compiler and no override:
`node tools/calibrate.js --baseline <unit dir> --alpha 1e-3 --families <A|A,C> --profile_ref <profile> --out <unit>.json`.
Per-hour cells pool or fall back to the aggregate as the compiler decides; the report prints
`sigma_floor_applied` counts, cells that pooled, and every compile warning.

**Arms**, both on every unit and window:

- `A`: profile `gwdg-gpu-node-a@1.0.0`, Family A only, α_total 1e-3 (the generic-microservice
  allocation).
- `AC`: profile `gwdg-gpu-node-ac@1.0.0`, Family A 6e-4 and Family C 4e-4 on the eight-signal joint
  vector (the streaming profile's 2:1 A:C ratio).

Both profiles: structural rules off, Families D and E off, every policy-gate flag false,
`family_a_rollback_signals` = all eight, `bake_profiles: []` (the compiler's `_default` 3/3).

**Gate per window:** a fresh `TrendBuffer(10)` and fresh detector state; `orchestrate` from
`shared.js` once per tick with `fusionTopology: 'portfolio'`, `totalTicks` = the window length,
the scenario of `tools/_build-report-card-gate.js` `buildScenario` (risk medium, change type
`config`, so no warm-up; flags all false; baseline = the unit's aggregate cell means),
`hoursElapsed = tick / 6`, `currentHourOfDay` from the tick's UTC hour, no SRM, fail-fast or ignore
inputs. Outcome per window: `rollback` at the first tick whose verdict is `rollback` (a session
would stop there), else `proceed` at the last tick (the shipped collapse rule). Recorded per window:
the outcome, the fire tick, the firing families, the rollback ids on that tick, the first signal,
the count of ticks with any missing study signal, and `xid_first_tick`.

## 4. Endpoints (bars fixed here)

- **E1 — false-rollback rate on null windows**, per arm. PASS iff rollbacks / null units ≤ 0.05.
  Reported beside it: the exact 95% Clopper–Pearson upper bound and the rate per 1,000 ticks.
- **E2 — detection rate on detection units**, per arm. PASS iff windows ending `rollback` / units
  ≥ 0.50.
- **E3 — lead time**, report only, no bar: per detected unit `fire_tick − I` in hours (negative is
  before the incident day) and, where XID is nonzero in the window, `fire_tick − xid_first_tick`;
  medians, and the early fraction (fires before `I`).
- **E4 — Family C's contribution**, report only: detection units caught by `AC` and not `A`; null
  units rolled back by `AC` and not `A`.
- **E5 — instrument:** zero harness exceptions in scored windows, and calibrator failures on at
  most 10% of candidate units.

## 5. Predictions (registered, from the record)

- P1: E1 FAILS for both arms. ADR 0012 measured per-shard `E[e|H0]` far above 1 on this dataset
  after every preprocessing level, and C76 measured the same cards' false-alert rate on NAB quiet
  stretches flat in calibration length. Point figure: at least 0.25 of null units roll back within
  a 1–4 day window.
- P2: E2 passes for both arms, mostly on the incident day or at metric disappearance rather than
  early: early fraction below 0.5.
- P3: `AC` adds at most 2 detections over `A` and at least as many false rollbacks.
- P4: E5 holds.

## 6. Instrument checks and NOT-EXECUTABLE conditions

Smoke before the run, not scored and not reported as a result: (i) one unit compiled per arm and
its per-signal `baseline_mean`, `baseline_sigma_squared`, `ar1_phi` inspected finite; (ii) the gate
on that unit's null window with a +5σ step added to `DCGM_FI_DEV_GPU_TEMP` from tick 50 ends
`rollback` (a real fire on an obvious signal); (iii) the same window unmodified produces a
non-empty `evidence_outlook` on every tick (the detectors ran). A no-fire on (iii) is not required:
a false fire there is the measurement, not a defect.

- A hash mismatch on any file the harness reads is **NOT EXECUTABLE** before any window runs.
- Fewer than 20 null units, or fewer than 20 detection units, after the §2 rules: **NOT
  EXECUTABLE**.
- Calibrator failure on more than 10% of candidate units: **NOT EXECUTABLE**. Each failure is
  listed with its message.
- A harness exception in a scored window voids that unit and is counted; every catch increments a
  printed counter. More than 5% of units voided: **NOT EXECUTABLE**.
- A void run is preserved and reported with its computed numbers beside the void.

## 7. What this can and cannot show

No authority moves on any outcome. A PASS on E1 is the first real-telemetry null result for the
temporal path at this pin and may be cited only as that. A FAIL on E1 refutes the shipped path's
false-rollback claim on real multivariate telemetry at bake lengths of 1–4 days, for this
substrate. E2 measures detection of GPU faults, not deploy regressions. Nothing here bears on the
twin path, on PROCEED semantics, or on canary-versus-control gating.

## 8. Not measured

Deploys, canary or control arms, the twin path, Families B, D and E, `FB_USED`, the PCIe replay
counter and XID as gate signals, node-level and scrape-pipeline metrics, day-of-week cells, bake
lengths beyond four days, α other than 1e-3, the two `when-good` aggregates, any tuning of the
compiler, and the post-incident days after `I + 24 h`.

## Amendment 1 — 2026-09-28, before any run (from the §6 smoke, not from a result)

The §6 smoke on unit `ggpu142_2025-07-03__gpu0` (both arms compiled and run on its null window,
committed unchanged as `harness/smoke.mjs`) found two instrument facts. Neither is a study result;
both are disclosed, and the changes below apply to every unit before the first scored run.

1. **Family A never evaluated.** With a 432-tick calibration the compiler's 24 hour cells hold 18
   samples each, below `MIN_SAMPLES_POOLED = 20` (`tools/calibrate/_calibrate-constants.ts`), so no
   cell carries a `family_A` block; the gate enables Family A only when some cell does
   (`engine/gates/health.ts` `familyAPromoted`), and the aggregate fallback, which does carry the
   per-signal parameters, is never consulted. `family_A_shadow` was empty on every tick of both
   arms, and the +5σ step of check (ii) did not fire on arm `A`. This is a property of the shipped
   compiler and gate on thin calibrations, recorded for the wiki; for the study it means 72 h is
   too short. **Change:** the calibration window becomes the first **576 ticks (96 h)** and the
   per-signal presence floor **530**; the null window is `[calibration end, E_first − 24 h)` as
   before. Applied to the manifest this keeps the same ten files (each starts seven days before its
   incident); the null windows shrink from three days to two.
2. **`DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL` is identically zero** on 16 of the 40 candidate units
   (four files) and takes at most 6 values on eleven more. On a zero series the compiler emits
   `baseline_mean 0`, `baseline_sigma_squared 0` with no floor (the floor is relative to the mean),
   so the signal's z-score is undefined. **Change:** the signal is removed from both profiles; the
   study signals are the remaining **seven** and `bonferroni_factor` is 7.
   `DCGM_FI_DEV_MEM_CLOCK` is constant on every unit (one value) with a nonzero mean; the compiler's
   floor gives it σ = 10⁻³·μ and it stays: inert under calibration, a strong signal if the clock
   ever moves, and it counts in the Bonferroni split (harder to pass on detection).
3. **Thresholds.** The compiled configs carry no `betting_sliding_buffer_threshold` and no
   `sliding_buffer_threshold`: the compiler stamps the joint-AR(1) bootstrap thresholds only when
   Family D is compiled (`tools/calibrate/_calibrate-main.ts`, `if (baselineCells && emit.D)`), and
   both study profiles, like `generic-microservice`, have D off. Both arms therefore run at Ville's
   1/α (`threshold_kind: 'ville'`), which is what a Family-A-only profile ships today. Disclosed;
   no change.
4. **Seen in the smoke and disclosed:** on the unmodified null window of that one unit, arm `AC`
   rolled back at tick 14 on `hotelling_t2_safe` (wealth 4.1×10⁴ against 5,000, log-increment 3.7
   nats per tick with an eight-signal vector that included the zero NVLINK column). Arm `A` ran no
   Family A detector. Neither number is scored; the smoke is re-run under this amendment.

Unchanged: the unit and window rules other than the two numbers above, arms, α, endpoints and
bars, predictions, NOT-EXECUTABLE conditions.

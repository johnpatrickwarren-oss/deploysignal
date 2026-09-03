# Report — Valid-Path Power (C64 d)

- **Study id:** 2026-09-valid-path-power
- **Run:** `results/run-2026-09-03T18182Z/` — deploysignal SHA `5c7017bd7f7b47b64af176dbeeb872fbb8b2d482`
  (the harness commit), engine pin `#v0.6.9-pre` (installed 0.6.9-pre), scenario-file SHA-256
  `dd15a08e…` equal to the registered value.
- **Endpoints, grid, arms and the ship floor** were frozen in `PREREGISTRATION.md`
  (merged 2026-09-03 as `3251fad`, before the harness existed). Verdicts below are recorded
  **as computed**; no threshold was moved.
- Runtime: 18.4 s for 80,958 arm-trials (28 cells × 6 arms × 524 single-signal or 131 K2 group
  trajectories) at each of two α values. **Exceptions: 0. Smoke gate passed** (each arm: no fire on
  a clean canary, fire on a 3σ step; manifest `smoke`). **False alarms at the primary α: 0.**

## 0. The headline

**The inversion has a powered valid arm at the K1 canonical, and it is a terminal one.** safe-t
at known φ reads **1.0000 at 1.5σ** (floor 0.50, E1 PASS) and matches the plug-in path at every
K1 severity from 1.5σ up (tax 0, E2 PASS); against the configuration that actually ships — the
betting e-process at its bootstrap threshold — it is *more* powerful (1.0000 vs 0.7099 at 1.5σ,
E3 PASS). Its 50% point is 1.0σ against the mixture's 0.75σ, so the valid path pays one grid
step of severity below 1.5σ (0.296 vs 0.595 at 0.75σ). Every valid arm crossed **0 of 524** null
canaries at α = 0.05 (E4 PASS, all three).

**The two universal-inference arms are inert on two of the four corpus signals, and it is scale,
not power.** Universal inference plateaus at 0.607 and the sequential UI at 0.498 from 2σ to 3σ
while safe-t reads 1.000. The labelled post-hoc (§5) locates it: both detectors carry a
scale-dependent constant (a 1e-9 variance floor; a unit-variance pseudo-innovation) that
swamps the innovation variance of `cost_req` (σ̂ ≈ 7×10⁻⁶) and `downstream_err` (σ̂ ≈ 6×10⁻⁵).
On standardized input the sequential UI reads 1.000 at 3σ and 0.86 at 1.5σ. **The verdicts stand
on the raw-input arms as registered**; the finding is that "self-standardizing within class"
(`detectors/sequential-ui.ts` header) holds for validity and not for power.

**Under the registered ship rule, (a) routes safe-t at known φ.** No valid *sequential*
construction is powered as shipped, so what (a) can route is an end-of-canary decision, not a
per-tick one — the design consequence is recorded in §6.

## 1. Detection rates at the primary α = 3.333×10⁻⁵ (per signal)

Trials: 524 per single-signal cell, 131 per K2 (K = 4) cell. Terminal arms have no
time-to-detect; sequential arms' median TTD (canary ticks after onset) in parentheses.

### K1 — per-metric step (canonical 1.5σ)

| δ | safe_t | universal_inference | sequential_ui | mixture | betting | betting_shipped |
|---|---|---|---|---|---|---|
| 0.25 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| 0.5 | 0.0095 | 0.0000 | 0.0000 | 0.0725 (60) | 0.0305 (61) | 0.0000 |
| 0.75 | 0.2958 | 0.0172 | 0.0115 (66) | 0.5954 (51) | 0.3874 (57) | 0.0000 |
| 1.0 | 0.8073 | 0.1355 | 0.0992 (61) | 0.9676 (41) | 0.8359 (53) | 0.0324 (63) |
| **1.5** | **1.0000** | 0.4752 | 0.4580 (50) | **1.0000** (25) | 0.9885 (38) | **0.7099** (61) |
| 2.0 | 1.0000 | 0.5859 | 0.4943 (36) | 1.0000 (17) | 0.9981 (30) | 0.9771 (51) |
| 2.5 | 1.0000 | 0.5973 | 0.4981 (30) | 1.0000 (13) | 1.0000 (27) | 0.9866 (45) |
| 3.0 | 1.0000 | 0.6069 | 0.4981 (25) | 1.0000 (10) | 1.0000 (24) | 0.9924 (41) |

### K2 — group-in-unison at K = 4 (substitute for the K = 10 canonical; ε = 0.5σ)

| ε | safe_t | universal_inference | sequential_ui | mixture | betting | betting_shipped |
|---|---|---|---|---|---|---|
| 0.25 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| **0.5** | **0.0687** | 0.0000 | 0.0000 | **0.2901** (58) | 0.2061 (60) | 0.0000 |
| 0.75 | 0.7099 | 0.0687 | 0.0153 (68) | 0.9847 (45) | 0.8244 (55) | 0.0000 |

### K5 — slow drift (canonical 1×10⁻² σ/tick; 69 post-onset ticks ⇒ 0.69σ terminal, ≈0.35σ window mean)

| slope (σ/tick) | terminal shift | safe_t | universal_inference | sequential_ui | mixture | betting | betting_shipped |
|---|---|---|---|---|---|---|---|
| 2.5×10⁻³ | 0.17σ | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| 5×10⁻³ | 0.35σ | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| **1×10⁻²** | 0.69σ | **0.0019** | 0.0000 | 0.0000 | **0.0076** (67) | 0.0057 (67) | 0.0000 |
| 2×10⁻² | 1.38σ | 0.1393 | 0.0019 | 0.0000 | 0.4008 (63) | 0.1794 (65) | 0.0000 |

### K3, K4, K6 — characterisation rows (level detectors on non-level faults)

Every valid arm reads **0.0000** on all 12 cells. The plug-in arms read 0.0000 on every K3 and
K6 cell and 0.0019 (1 of 524) on K4 at 5σ (mixture, betting) and 8σ (mixture). Nothing here is
scored; the classes remain owned by the constructions the K-matrix records
(`spectral_bet_e_process`, `point_tail_bet_e_value`; K6 = NO).

### null cell

All six arms 0.0000 at the primary α (0 of 524).

## 2. Endpoint verdicts (as computed)

### E1 — the ship floor → **PASS**

```
E1: D_valid(K1,1.5sigma)=1.0000 arm=safe_t floor=0.50 delta*_valid=1sigma verdict=PASS
```

### E2 — the power tax at canonical → **PASS**

```
E2: tax K1=0.0000 K2(K=4)=0.2214 K5=0.0057 | K3=0.0000 K4=0.0019 K6=0.0000 verdict=PASS
```

K2's tax (0.0687 vs 0.2901, safe-t vs mixture) is the largest and sits inside the 0.25 bar by
0.03; both sides are below the floor at that cell, so the class is uncovered by either path on
this canary. K5 at canonical is inert on both sides (0.0019 vs 0.0076): a 0.69σ terminal ramp
whose window mean is ≈0.35σ is below every arm's 50% point.

### E3 — against what actually ships → **PASS**

```
E3: 1.5sigma valid=1.0000 shipped=0.7099 | 0.5sigma valid=0.0095 shipped=0.0000 verdict=PASS
```

### E4 — validity on this substrate at α = 0.05 (null cell, n = 524; bound 0.0690)

| arm | crossings | rate | verdict |
|---|---|---|---|
| safe_t | 0 | 0.0000 | PASS |
| universal_inference | 0 | 0.0000 | PASS |
| sequential_ui | 0 | 0.0000 | PASS |
| mixture | 9 | 0.0172 | — (reference 0.05) |
| betting | 20 | 0.0382 | — (reference 0.0592 with ε_T = 0.184) |
| betting_shipped | 0 | 0.0000 | — |

```
E4: safe_t=0.0000 universal_inference=0.0000 sequential_ui=0.0000 passing=safe_t,universal_inference,sequential_ui
```

The valid arms are conservative, as their constructions predict (a Bayes factor's P(e ≥ 20) is
far below 0.05; the UI's ~6× structural slack). The instrument check in §5 confirms the null
terminal e-values are the right size (safe-t mean 0.052, UI mean 0.390), so 0 crossings is
conservativeness, not a dead instrument.

### E5 — speed of the sequential valid arm (characterisation)

Median TTD in canary ticks after onset, cells with ≥ 20 detections in every arm:

| δ | sequential_ui | mixture | betting |
|---|---|---|---|
| 1.0 | 61 | 41 | 53 |
| 1.5 | 50 | 25 | 38 |
| 2.0 | 36 | 17 | 30 |
| 2.5 | 30 | 13 | 27 |
| 3.0 | 25 | 10 | 24 |

The sequential UI, where it fires, is 12–25 ticks behind the mixture and 1–12 behind the
betting arm. Its detection counts (240–261 of 524 from 1.5σ up) are the two powered signals
of four (§5).

### Ship rule (registered §4)

```
ship_rule: a_routes=true routed_arm=safe_t
```

## 3. Interpretation decisions (made once, in code)

1. **K6 re-centred on μ̂.** The engine library replaces a zero-mean series; on raw values the
   replacement is `μ̂ + σ̂·z`, so only the shape changes.
2. **Terminal window = the whole canary** [500, 600). The deploy does not know the onset. The
   window-mean shift is therefore 0.7δ.
3. **Sequential UI `changeFrom` = 500** (the deploy start), read from the first canary tick.
4. **False alarms** are sequential crossings before canary tick 30, counted and excluded from
   detections; terminal arms cannot false-alarm by construction of the single look.
5. **Shipped ratio 2.41×10⁴** applied as `derivation.betting_sliding_buffer_threshold =
   2.41×10⁴/α`, the field the shipped detector reads
   (`detectors/betting-e-process.ts`, the `threshold` line).

## 4. Scope limits — what this does not establish

- **Synthetic, iid, φ = 0 known, m = 500.** The friendliest substrate the plug-ins can be given
  (betting ε_T ≈ 0.18). The plug-ins' invalidity under estimation is C23/C58's finding and is
  not re-measured; nothing here says the plug-ins are valid.
- **Known φ is supplied, not estimated.** safe-t with the engine's default φ̂ was not run. At
  m = 500 the safe-t header places estimated φ inside its e-BH regime (cal ≳ 100); that is the
  header's claim, unmeasured here.
- **K2 at K = 4**, not the K = 10 canonical. The class carries no canonical verdict.
- **K5's canonical integrates to 0.69σ** on this canary against the K-matrix's 1.99σ over 200
  ticks; the K5 = YES on the matrix and the inert cell here are different questions.
- **Uniform noise.** Corpus jitter is `U[0, c)`, not Gaussian; E4's 0 crossings are on that
  substrate only.
- **No union across valid arms; no Bonferroni.** The valid path is its best single arm.
- **Real telemetry: none.**

## 5. Post-hoc — labelled, no verdict

`analysis/posthoc_scale.mjs`, same seeds as the run.

**Per-signal detection at K1, raw input vs standardized input `(x − μ̂)/σ̂`:**

| δ | arm | p99_latency | ttft | cost_req | downstream_err |
|---|---|---|---|---|---|
| 3.0 | safe_t (raw) | 1.000 | 1.000 | 1.000 | 1.000 |
| 3.0 | universal_inference raw → std | 0.802 → 0.802 | 0.870 → 0.870 | **0.000 → 0.809** | 0.756 → 0.802 |
| 3.0 | sequential_ui raw → std | 0.992 → 1.000 | 1.000 → 1.000 | **0.000 → 1.000** | **0.000 → 1.000** |
| 1.5 | universal_inference raw → std | 0.641 → 0.641 | 0.733 → 0.733 | **0.000 → 0.626** | 0.527 → 0.603 |
| 1.5 | sequential_ui raw → std | 0.924 → 0.817 | 0.908 → 0.908 | **0.000 → 0.840** | **0.000 → 0.885** |

Calibration σ̂ medians: p99_latency 0.43, ttft 0.49, **cost_req 6.7×10⁻⁶, downstream_err
6.0×10⁻⁵**. The mechanism, cited to code:
`../deploysignal-engine/detectors/universal-inference-e-value.ts:103` `VAR_FLOOR = 1e-9` is
applied to the fitted innovation variance, and `cost_req`'s σ̂² ≈ 4.5×10⁻¹¹ sits three orders
below it; `../deploysignal-engine/detectors/sequential-ui.ts:142` seeds the predictable fit with
one unit-variance pseudo-innovation (`sx2 = 1, sInnov2 = 1`) and floors `s2` at 1e-9 on the
next line, so on a series whose innovations are 10⁻⁵ the numerator's density is flat and log E
cannot grow. safe-t is exactly scale-invariant and unaffected.

*Inference.* Standardized, the sequential UI would clear the K1 floor (0.86 mean at 1.5σ across
signals, 1.000 at 3σ); the fixed-split UI would not exceed ≈0.80 at 3σ, which is the split's
half-data cost plus the 30 healthy ticks in its train half. Neither number is a verdict; a
standardized-input arm would need its own registration.

**Null-cell terminal e-values (instrument check):** safe-t n = 524, mean 0.0522, median 0.0279,
p99 0.328, max 1.705; universal inference mean 0.3898, median 0.2137, p99 1.301, max 2.269.
Both means sit under 1 with margin, consistent with `E[e|H0] ≤ 1` on a uniform-noise
substrate; a sample mean under 1 is not itself evidence of validity
(`knowledge/stats/terminal-mean-is-not-measurable`) — it is evidence the instrument is alive.

## 6. What (a), (b), (c) can now do — per the registered ship rule

- **(a) routes safe-t at known φ**: E1 PASS, E4 PASS. What it routes is a *terminal* e-value —
  one α-participating decision per signal at the end of the canary, not a per-tick wealth
  process. The health gate's per-tick `rollback` on Family A is not replaceable by anything in
  the valid set as shipped: the only valid sequential arm is inert on small-scale signals until
  its regularizer is made scale-free (a construction change with its own registration).
- **(b)**: (a) routes, so the Family A plug-ins may be demoted to advisory with the
  `epsilon_growing` law on the evidence surface. The tax of doing so on this canary is 0 at
  ≥ 1.5σ and one grid step below it (0.30 at 0.75σ, 0.16 at 1.0σ), plus the per-tick
  sequencing the plug-ins supply (E5) and the valid terminal arm does not.
- **(c)**: the relabel option, regardless (§4 of the pre-registration). E3 adds the measurement:
  the shipped bootstrap threshold costs the betting arm 0.29 at 1.5σ and 0.80 at 1.0σ against
  1/α on this canary.

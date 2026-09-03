# Pre-registration — Valid-Path Power (C64 d)

- **Study id:** 2026-09-valid-path-power
- **Register item:** `knowledge/WORKLIST.md` C64 (d): the registered power study that must run
  before any of (a) routing, (b) demotion, (c) relabelling ships.
- **Frozen:** 2026-09-03, before any harness exists and before any run. Endpoints, grid, arms and
  the ship floor below do not move after this commit. Interpretation decisions the text leaves
  open are made once, in code, and listed in the report. Post-hoc analyses are labelled and carry
  no verdict.
- **Engine:** `@johnpatrickwarren-oss/deploysignal-engine` at the `package.json` pin at run time
  (`v0.6.9-pre` at freeze; the manifest records the installed version and refuses a mismatch).
- **Predecessors:** `studies/effect-size-sweep/` (C9) and `studies/drift-regime-sweep/` (C35).
  Same corpus, same noise model, same calibration convention, same seed discipline, same
  canary shape (T = 100, injection at t = 30). This study puts the envelope-valid constructions
  on those harnesses for the first time.
- **Template:** `studies/drift-regime-sweep/PREREGISTRATION.md`; provenance rules transfer
  verbatim.

## 1. The question

DeploySignal's four-valued verdict has the form of Ramdas–Wang 2025's e-value decision rule
(Theorem 4.9), but its α-participating inputs are not e-values in the shipped configuration:
the Family A plug-ins are (ε_T, 0)-approximate with ε_T unbounded under an estimated baseline,
and the shipped threshold is a bootstrap quantile, not 1/α
(`knowledge/stats/ramdas-wang-2025` §3, §8; `knowledge/stats/validity-premise-chain`;
`knowledge/stats/ville-guarantee-is-empirical`). C64 proposes the inversion: route only the
three envelope-valid constructions — safe-t at known φ, the universal-inference e-value, the
sequential UI e-process (`validUnderEstimatedBaseline: true`,
`../deploysignal-engine/detectors/validity-envelope.ts`) — into the α-participating decision.

The objection is on the record: the valid constructions are the inert ones
(`knowledge/stats/power-per-cell-2026-08-05`; universal inference 0.0275 at φ = 0.9). The
K-matrix (`knowledge/methodology/fault-class-coverage-matrix`) measured them at T = 300 with the
fault covering the whole 200-tick test window; no study has measured them on the canary shape
the health gate actually runs — 100 ticks, a fault starting at tick 30, one α per signal.

**H1: on the canary substrate, the envelope-valid path is powered (≥ 0.50) at the K1 canonical
severity, and its power cost against the shipped plug-in path at the same α is bounded.**

If H1 fails, the inversion does not ship and falsifier 1 of
`knowledge/methodology/threshold-free-observability` is engaged for the level class on this
substrate.

## 2. Design

**Substrate.** `runs/adversarial-scenarios.json` (131 scenarios; SHA-256 must equal the C9/C35
manifest value `dd15a08e246c3e2152fc122fca6fb0eb0e6ed2f7f8b556dcfe95a0ae828f7474`, else
NOT-EXECUTABLE). Corpus jitter model, four signals (`p99_latency` 0.008, `ttft` 0.008,
`cost_req` 0.006, `downstream_err` 0.03), `healthy() = base · (1 + c · u)`, `u ~ U[0,1)` from
`mulberry32(fnv1a(scenario|signal|class|severity))`. Calibration window 500 samples, then a
100-tick canary; μ̂, σ̂ are the calibration sample mean and standard deviation. One trajectory per
(scenario, signal, class, severity), shared by every arm — a paired comparison.

The noise is iid with φ = 0 exactly, and m = 500 ≫ n = 100. This is the friendliest substrate
the plug-ins can be given: the betting increment's ε_T = e^{0.8445·100/500} − 1 ≈ 0.18
(`../deploysignal-engine/guarantees.ts`, Family A betting row). **The study measures what the
valid constructions cost in power; it does not measure the plug-ins' invalidity, which C23 and
C58 already did elsewhere.** A PASS here is necessary for the inversion, not sufficient for the
thesis.

**Injections** — the six K-matrix classes, formulas ported from
`../deploysignal-engine/validation/coverage/lib/inject.mjs` with σ = σ̂ and onset `at` = 30
(canary index), applied to the raw series:

| class | injection (t ≥ 30 unless stated) | grid | canonical |
|---|---|---|---|
| K1 step | `v + δ·σ̂` | δ ∈ {0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0} | **1.5** |
| K2 unison | `v + ε·σ̂` on all four corpus signals of one scenario | ε ∈ {0.25, 0.5, 0.75} | **0.5** (K = 4; see below) |
| K3 oscillation | `v + A·σ̂·sin(2π f (t − 30))` | (A, f) ∈ {0.5, 0.75} × {0.02, 0.05, 0.1} | **(0.75, 0.05)** |
| K4 point | `v + M·σ̂` at t = 30 only | M ∈ {3, 5, 8} | **5** |
| K5 drift | `v + s·(t − 30)·σ̂` | s ∈ {2.5e-3, 5e-3, 1e-2, 2e-2} σ/tick | **1e-2** |
| K6 shape | `μ̂ + σ̂·z`, z the matched-moment two-point Gaussian mixture of `injectShapeMix` | d ∈ {1.0, 1.5, 2.0} | **1.5** |
| null | none | — | — |

K1's grid is C9's, a superset of the K-matrix's {0.75, 1.5, 3}. K5's grid is the K-matrix's
four re-registered cells (Amendment v2.K5R); the three retired sub-0.01σ-terminal cells are not
run. On a 70-tick post-onset span the canonical K5 slope integrates to 0.69σ̂ terminal
(the K-matrix's 200-tick span reached 1.99σ̂); the study reports the terminal displacement with
the rate. K6 in the engine library replaces a zero-mean standardized series; here the
replacement is re-centred on μ̂ so the mean and variance match the calibration estimates and only
the shape changes (uniform → two-point mixture).

**K2 canonical is NOT-EXECUTABLE on this substrate.** The K-matrix canonical is K = 10 metrics
at ε = 0.5σ; the corpus has four signals with a noise model (fallback-not-invent:
`knowledge/methodology/test-substrates`). The K2 rows are registered at **K = 4** and labelled
as a substitute; the class carries no "canonical" verdict, and E2 names it as K = 4.

**Arms.** Every arm is evaluated at the same per-signal α on the same trajectory.

| arm | construction | source | decision |
|---|---|---|---|
| `safe_t` | safe two-sample t e-value, **known φ = 0** supplied via `ar1Phi: 0` | `detectors/safe-t-e-value.ts` | **terminal**: one look at T = 100, cal = [0, 500), test = [500, 600); fire iff e ≥ 1/α |
| `universal_inference` | split-LRT UI e-value | `detectors/universal-inference-e-value.ts` | terminal, same windows |
| `sequential_ui` | predictable-plug-in UI e-process on cal ++ canary, `changeFrom` = 500 (deploy start; the alternative does not know the onset) | `detectors/sequential-ui.ts` | sequential: fire at the first canary tick with log E ≥ log(1/α) |
| `mixture` | Family A Gaussian mixture supermartingale, plug-in μ̂/σ̂², `ar1_phi: 0` | `detectors/family-a-mixture-supermartingale.ts` | sequential at the analytical 1/α (C9's arm, verbatim) |
| `betting` | Family A aGRAPA/ONS betting e-process, plug-in μ̂/σ̂², `ar1_phi: 0` | `detectors/betting-e-process.ts` | sequential at the analytical 1/α (C9's arm, verbatim) |
| `betting_shipped` | the same betting e-process with `derivation.betting_sliding_buffer_threshold = 2.41×10⁴ / α` | same | sequential at the shipped median bootstrap ratio (`knowledge/stats/ville-guarantee-is-empirical`: median 2.41×10⁴ over 82,888 compiled cells) |

The two terminal arms are fixed-time e-values: peeking at them every tick is not anytime-valid,
so they are read once, at the end of the canary, and their time-to-detect is undefined. The
test window contains 30 healthy ticks, so the window-mean shift is 0.7δ; the K-matrix's
whole-window numbers are not expected to reproduce and the difference is the canary's, not the
detector's.

**Valid path and plug-in path.** `D_valid(cell) = max` over the three valid arms;
`D_plugin(cell) = max` over `mixture` and `betting`. The arm supplying each max is named in the
report. No union across arms is taken (a union would spend 3α).

**α.** Primary: the shipped per-signal allocation after the 50/50 Family A split,
`α = (4×10⁻⁴ / 6) · 0.5 = 3.333×10⁻⁵`, as C9 and C35. Secondary, same trajectories:
`α = 0.05`, the K-matrix's level, for comparability only — every verdict below is at the primary
α except E4.

**N.** Every (scenario, signal) pair with a positive baseline for that signal; 524 per
single-signal cell at C9's count, 131 per K2 cell. The counts are reported; the study has no
stopping rule other than "the grid".

## 3. Endpoints (frozen)

Let `D(arm, class, severity)` be the detection rate at the primary α and `TTD` the median
canary ticks from onset to first crossing among detections (sequential arms only).

### E1 — the ship floor *(primary)*

`D_valid(K1, 1.5σ) ≥ 0.50`.

**PASS** → the inversion (C64 a) may proceed to its own PR. **FAIL** → the inversion does not
ship, and the report says which valid arm came closest and at what severity it first reaches
0.50 (`δ*_valid`). The 0.50 is the K-matrix's `COVERAGE_FLOOR`, reused rather than invented.

### E2 — the power tax at canonical, per class

`tax(K) = D_plugin(K, canonical) − D_valid(K, canonical)`, reported for K1, K2 (K = 4), K3, K4,
K5, K6.

**PASS iff** `tax(K1) ≤ 0.25` **and** `tax(K5) ≤ 0.25` **and** `tax(K2, K = 4) ≤ 0.25`. K3, K4
and K6 are characterisation rows: every arm here is a level detector and the K-matrix records
those classes as covered by other constructions (spectral bet, point-tail bet) or by none; a
non-zero rate there is reported as a finding, not scored.

### E3 — against what actually ships

At K1: `D_valid(K1, 1.5σ) ≥ D(betting_shipped, K1, 1.5σ) − 0.10` **and**
`D_valid(K1, 0.5σ) ≥ D(betting_shipped, K1, 0.5σ) − 0.10`.

This is the (c) question in its measurable form: whether routing the valid constructions costs
power relative to the deployed configuration, whose threshold sits 2.4×10⁴ above 1/α. The
0.5σ cell is where the bootstrap overshoot was measured to cost most (0.949 → 0.459).

### E4 — validity on this substrate *(at α = 0.05, null cell)*

For each valid arm, the crossing rate on the null cell `≤ 0.05 + 2·√(0.05·0.95/n)`.
**PASS/FAIL per arm.** A FAIL on a valid arm is a finding about well-specification (the corpus
noise is uniform, not Gaussian) and is reported, not repaired; the arm is then excluded from
the ship rule below. The plug-in arms' null rates are reported against
`0.05 · (1 + ε_T)` with ε_T = 0.184 (betting) — a characterisation, no verdict, since their
validity is not this study's subject.

### E5 — speed of the sequential valid arm *(characterisation, no verdict)*

`TTD(sequential_ui, K1, δ)` against `TTD(mixture, K1, δ)` and `TTD(betting, K1, δ)` for every
δ with ≥ 20 detections in each arm. Reported for the design of (a); decides nothing.

## 4. The ship rule, registered

(a) **routes** only if E1 PASS and the routed arm(s) PASS E4. (b) **demotes** the Family A
plug-ins to advisory only if (a) routes; otherwise (b) is reduced to carrying the
`epsilon_growing` law on the evidence surface with the plug-ins left α-participating, and says
so. (c) is executed as the **relabel** option regardless of verdicts: the bootstrap-threshold
paths are crossing-rate instruments (`threshold_kind: 'bootstrap'` already on the ADR 0027
surface), and the "restore 1/α where φ is supplied by the caller" option is **not decided by
this study** — no shipping caller supplies a known φ, and the φ ≠ 0 oracle regime was measured
seed-unstable (`ville-guarantee-is-empirical`, 2026-08-03 retraction). Lowering a threshold on
this study's φ = 0 evidence would be the risky direction on the wrong substrate.

## 5. Falsifiers accepted in advance

- **E1 FAIL.** The valid path cannot carry the level class at the canary's canonical severity
  on the friendliest substrate. The inversion is withdrawn as a shipping change; the thesis
  page records falsifier 1 as engaged for K1 on synthetic telemetry, and the next instrument is
  a construction question (a powered valid sequential detector), not a routing question.
- **E2 FAIL with E1 PASS.** The valid path is powered but pays more than 0.25 at canonical.
  (a) still routes (E1 is the floor); the report carries the tax, and (b)'s demotion is
  weighed against it on the decision page rather than here.
- **E3 FAIL.** Routing the valid constructions would detect less than the deployed
  configuration at 1.5σ or at 0.5σ. Reported; (a) still keys on E1, because E3 compares against
  a threshold that carries no e-value property at all.
- **E4 FAIL on every valid arm.** No valid construction is valid on this substrate at α = 0.05.
  The study is reported; (a) does not route; the finding is a substrate misspecification and
  goes to `knowledge/methodology/test-substrates`.

## 6. NOT-EXECUTABLE conditions

The instrument is void, and endpoints are not scored, when: any arm throws on ≥ 1 trajectory
(the harness counts every caught exception per arm-cell and prints the counts; a non-zero
count voids that arm-cell and every endpoint that reads it); trial counts differ across arms
within a cell; the scenario-file hash differs from the value in §2; the installed engine
version differs from the `package.json` pin; the smoke test (one obvious fire and one clean
no-fire per arm, non-empty outputs) does not pass before the sweep.

## 7. Mechanics

- Harness: `studies/valid-path-power/analysis/run_sweep.mjs`. Seeded throughout (no
  `Math.random`, no wall clock in any tracked artifact except the run-directory name).
  Append-only `results/run-<UTC>/` that refuses an existing directory; `manifest.json` with
  the deploysignal SHA, engine pin and installed version, scenario hash, seed scheme, grid,
  α values, node version, command.
- `cells.json`: per (arm, class, severity, α): trials, detections, false alarms (a crossing
  before t = 30 on a sequential arm), median TTD, exception count.
- `endpoints.json`: E1–E5 as computed. `analysis/check_report.mjs` pins every number in
  `REPORT.md` to those files and exits 1 on drift.
- Reruns only for a code defect, fixed test-first, the prior run preserved and the superseding
  manifest naming the defect.
- Post-hoc analyses (e.g. a Bonferroni union of the valid arms, an onset-aligned terminal
  window) go in a labelled section and carry no verdict.

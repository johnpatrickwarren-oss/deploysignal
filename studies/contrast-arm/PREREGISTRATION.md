# Pre-registration — the control arm: DeploySignal's contrast gate on the corpus (`2026-09-contrast-arm`, C81 Part 2)

- **Study id:** `2026-09-contrast-arm`
- **Register item:** `knowledge/WORKLIST.md` C81 (Part 2); brief in `knowledge/PROMPTS.md` §C81.
- **Frozen:** 2026-09-05, before any gate code, any harness, and any run. Endpoints, substrate,
  arms and bars below do not move after this commit. Interpretation decisions the text leaves
  open are made once, in code, and listed in the report. Post-hoc analyses are labelled and carry
  no verdict.
- **Engine:** `@johnpatrickwarren-oss/deploysignal-engine` at the `package.json` pin at run time
  (`v0.6.12-pre`, the tag that carries `per-shard/contrast.ts`, ADR 0032; the manifest records
  the installed version and refuses a mismatch).
- **Part 1's verdict governs this part.** Engine study `2026-09-contrast-null`
  (`validation/contrast-null`, run `run-20260905T061348Z`) REFUSED the contrast null an admitting
  envelope: the shared component cancels exactly, but the contrast's estimated OFFSET is the
  plug-in n ≫ m price (mixture false alerts 0.34 / 0.18 / 0.03 per 1,000 ticks at fit 60 / 300 /
  2000 on iid pairs, contract 0.025), and `fleet/e-bh-guarded.ts` admits `contrast_null_mixture`
  only under the caller's assertion `mMuchGreaterThanN` or `trueBaseline`. So the arm this study
  measures **ships ADVISORY** (the C25/C65 pattern: recorded on the fused verdict, no rollback
  authority, no α spent), with its selection reported through the guarded e-BH under the
  `mMuchGreaterThanN` assertion only where the declared fit window is at least
  `CONTRAST_FIT_RATIO_FLOOR = 10` canary lengths (Part 1's law: the mixture wealth's excess is
  about n/m nats over the horizon, so ratio 10 is ε ≈ 0.1 on the FDR level, stated at the call
  site), and refused below it. The temporal path keeps its authority everywhere.
- **Predecessors and template:** `studies/valid-path-power/PREREGISTRATION.md` (C64 d): same
  corpus, same jitter model, same calibration convention, same seed discipline, same canary
  shape (T = 100, injection at t = 30). Provenance rules transfer verbatim.

## 1. The question

A canary deploy has a concurrent twin. Does a gate that scores the pair contrast instead of the
canary's fitted history (a) stay quiet when the canary is healthy, (b) stay quiet when BOTH units
move together (a shared outage, which is not the deploy's fault, C73), (c) see a canary-only
fault as fast as the temporal path, and (d) revoke itself when its control cohort is
contaminated? On this substrate the answer to (b) is algebra and (a) is Part 1's price at the
declared fit length; the study measures all four through the SHIPPED module's own scoring
functions so the numbers describe the gate DeploySignal runs, not a re-implementation.

## 2. Design

**Substrate.** `runs/adversarial-scenarios.json` (131 scenarios; SHA-256 must equal
`dd15a08e246c3e2152fc122fca6fb0eb0e6ed2f7f8b556dcfe95a0ae828f7474`, else NOT-EXECUTABLE).
Corpus jitter model, four signals (`p99_latency` 0.008, `ttft` 0.008, `cost_req` 0.006,
`downstream_err` 0.03), `healthy() = base · (1 + c · u)`, `u ~ U[0,1)` from
`mulberry32(fnv1a(scenario|signal|unit|variant))`; the canary and each control unit are
INDEPENDENT healthy draws of the same law (the corpus has no shared-component model, and none is
invented: fallback-not-invent, `knowledge/methodology/pages/test-substrates.md`; Part 1 measured the
shared component's cancellation on the battery). **Fit window `m = 500` per pair** (the C9/C35
calibration length, the baseline the caller supplies), **canary `T = 100` ticks**, injection at
`t = 30`. Units per (scenario, signal): the canary `S@canary`, the paired control `S@control-a`,
and a second control `S@control-b` for the cohort pair (`control-a`, `control-b`).

**Fit ratio.** `m/T = 5`, BELOW the floor of 10, so on this substrate the shipped gate REFUSES
the `mMuchGreaterThanN` assertion and reports `gate: 'refused_fit_ratio'`; the study therefore
reads the arm's selection through the module's `selectContrastArm` with the assertion FORCED
(`assertFitRatio: true`, a study-only flag the harness passes and the report names) so the
would-be decision is measurable, and ALSO reports the gate's shipped reading (refused) on every
cell. Both numbers are the deliverable; neither moves the other.

**Injections** (canary index; σ̂ = the pair's contrast fit scale is NOT used here — the step is in
the unit's own calibration σ̂ as in C64 d, so the two paths see the same physical fault):

| variant | canary | control-a | control-b | serves |
|---|---|---|---|---|
| `null` | healthy | healthy | healthy | E1 |
| `canary` | `+1.5σ̂` from t = 30 (K1 canonical) | healthy | healthy | E2 |
| `shared` | `+1.5σ̂` from t = 30 | `+1.5σ̂` from t = 30 | `+1.5σ̂` from t = 30 | E3 (a shared outage) |
| `contaminated` | healthy | healthy | `+1.5σ̂` from t = 30 | E4 (a contaminated cohort) |
| `canary-3` | `+3σ̂` from t = 30 | healthy | healthy | E2 (the C64 smoke severity, reported) |

One draw per (scenario, signal, unit); the variants add the step to the same draw (paired).

**Arms.**

| arm | construction | decision |
|---|---|---|
| `contrast` | the shipped module: `fitContrast` on the baseline pair contrast (500 ticks), the residual per tick, the Family A mixture card at `(0, 1, 0)` and the arm's α, `selectContrastArm` across the scenario's four (pair, signal) at `q = CONTRAST_ARM_Q = 0.05` under `assertFitRatio: true`; the cohort pair's residual into the 'gaussian' calibration monitor at α_cal 0.01 as the Mode gate | a scenario "would roll back" at the first canary tick with a non-empty selected set among pairs whose monitor is passing; time-to-decision = that tick − 30 |
| `temporal` | the C64 (d) `mixture` arm verbatim: the Family A mixture at plug-in `μ̂/σ̂²` from the canary's 500-tick calibration, `ar1_phi: 0`, at the same α, on the canary series alone; a scenario rolls back at the first tick any of its four signals crosses `1/α` | same reading |

α for the mixture card in both arms: the shipped per-signal allocation
`α = (4×10⁻⁴ / 6) · 0.5 = 3.333×10⁻⁵` (primary) and `0.05` (secondary, comparability). The
contrast arm's e-BH runs on the mixture's running wealth at the PRIMARY α card (the card's α only
sets its own fire threshold; e-BH reads the wealth) with `q = 0.05`; the report states this.

**N.** Every scenario with a positive baseline for all four signals (131 or fewer; the count is
reported). One decision per (scenario, variant, arm, α): 131 per cell.

## 3. Endpoints (frozen)

Let `R(arm, variant)` be the fraction of scenarios that would roll back and `TTD` the median
time-to-decision (canary ticks after 30) among those that do.

- **E1 — false would-be rollback under the null at the shipped budget.** `R(contrast, null)` at
  q = 0.05 with the mixture card at the primary α. **Bar: `R ≤ 0.05 + 2·sqrt(0.05·0.95/N)`**
  (the E4 form of C64 d). Reported beside it: `R(temporal, null)` at both α (no bar: the plug-in's
  null rate on this substrate is C64 d's E4, already measured at 0.0000 at α = 0.05 with m = 500,
  T = 100 — the friendliest regime).
- **E2 — detection and time-to-decision on the canary-only fault.** `R(contrast, canary)` and
  `R(temporal, canary)` at the primary α, with `TTD`. **Bar: `R(contrast, canary) ≥ 0.50`** (the
  coverage floor) at 1.5σ̂; the temporal path's 1.5σ̂ number is C64 d's (mixture 0.9866 at the
  primary α). Reported: the paired difference in `TTD` and the 3σ̂ row.
- **E3 — a shared outage is not the deploy's fault.** `R(contrast, shared)` at the primary α.
  **Bar: `R(contrast, shared) ≤ R(contrast, null) + 2·sqrt(0.05·0.95/N)`** (no more than the
  null rate). Reported: `R(temporal, shared)`, which is the false rollback the arm exists to
  prevent (expected ≈ its canary detection, since the temporal path cannot see the control).
- **E4 — the monitor revokes a contaminated cohort.** On `contaminated`, per (scenario, signal):
  the fraction whose cohort monitor has revoked by the canary's end, and among those the median
  revocation tick; and `R(contrast, contaminated)` (the pairs themselves are null, so the bar is
  E1's). **Bar: revocation fraction ≥ 0.50 by t = 100** on `p99_latency` and `ttft` (a 1.5σ̂
  step in one cohort member is a 1.06σ residual shift over 70 ticks: `S = 74` against `sd = 8.4`,
  which the Gaussian-LR monitor at α_cal 0.01 sees). `cost_req` and `downstream_err` are
  reported (their noise is not Gaussian-shaped; C64 d found the UI arms scale-dependent there).
- **E5 — the shipped gate's reading.** On every cell the shipped `gate` field is
  `refused_fit_ratio` (m/T = 5 < 10) and `authority` is `advisory`; the report states the count.
  No bar: this is the module describing itself.

**Ship rule.** The arm ships advisory regardless (Part 1 decided that). E1 and E3 HELD → the
`assertFitRatio` pathway stays available to a caller with `m/T ≥ 10`; E1 or E3 FAILED → the
module's selection is reported-only even under the assertion, and the wiki page says so. E2, E4
and E5 are reported.

## 4. Predictions (no authority)

E1: `R(contrast, null) ≈ 0.02–0.05` at q = 0.05 with T = 100 and m = 500 (Part 1's n/m ≈ 0.2
regime: an offset error of `1.25·√2/√500 ≈ 0.08` in d-units is 0.056σ on the residual, over
100 ticks `S ≈ 5.6` against `sd = 10`: mostly quiet). `R(temporal, null) = 0` at the primary α.
E2: `R(contrast, canary) ≈ 0.90–0.98` at 1.5σ̂ with `TTD ≈ 40–55` (the residual shift is
1.06σ; Part 1 measured median delay 80 at α = 0.05 on 1,500 post-onset ticks with a 2,000-tick
head; here the wealth must reach `1/3.3e-5 ≈ 10.3 nats`), against the temporal path's 0.99 and
`TTD ≈ 30–40`. The 3σ̂ row: both ≈ 1.00. E3: `R(contrast, shared) = R(contrast, null)` exactly
(the residual is identical tick for tick), `R(temporal, shared) = R(temporal, canary)` exactly.
E4: revocation ≥ 0.9 on `p99_latency` / `ttft` with median tick ≈ 55–70; `cost_req` similar;
`downstream_err` lower (its 3% jitter is uniform, not Gaussian). E5: 131 of 131 refused.

## 5. Harness rules

`studies/contrast-arm/analysis/run_sweep.mjs`: deterministic (mulberry32 + fnv1a; no `Math.random`,
no wall clock in a tracked artifact except the run-directory name); append-only
`results/run-<UTC>/` that refuses an existing directory; the manifest records the repo sha, the
engine pin and installed version, the scenario sha, N, the arms and α, and `exceptions` counted
per cell (a cell with an exception is voided and listed; the harness has no bare catch that
swallows into a number); a smoke check before the sweep — one obvious fire (the 3σ̂ canary step
on one scenario) and one clean no-fire on the null, on BOTH arms — else NOT-EXECUTABLE;
`analysis/check_report.mjs` pins every number in `REPORT.md` to `endpoints.json` (exit 1 on drift)
and takes `--expect` in the wiki's form. The harness calls the shipped module
(`dist/engine/gates/_health-contrast.js`) for the contrast arm and the engine's mixture card for
the temporal arm; nothing statistical is re-implemented in the harness.

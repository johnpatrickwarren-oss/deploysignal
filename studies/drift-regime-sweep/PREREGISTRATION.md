# Pre-registration — Drift-Regime Sweep

- **Study id:** 2026-08-drift-regime-sweep
- **Frozen:** 2026-08-04, before any run. Endpoints, grid, and arms below do not move after this
  commit; interpretation decisions the text leaves open are made once, in code, and listed in the
  report. Amendments after the first run are labelled post-hoc and carry no verdicts.
- **Engine:** `@johnpatrickwarren-oss/deploysignal-engine` at the pin in `package.json` at run time,
  resolved in the report (`v0.6.6-pre` at freeze). The slowbleed arm is deploysignal's own shipped
  rule (`engine/gates/_health-defs.ts`, id `slowbleed`), compiled `_health-defs.js`, driven through
  the engine package's `TrendBuffer` and `trendStrength`.
- **Predecessor:** `studies/effect-size-sweep/` (C9, run 2026-08-04). Same corpus, same noise model,
  same calibration convention, same seeds discipline. This study measures the cell C9 left open:
  correlated sub-threshold **drift**, the regime `slowbleed` exists for.

## 1. The question

The effect-size sweep refuted the anytime-valid-tax thesis for *step* injections: the Ville-bounded
mixture dominated the retired classical arm everywhere. What survived
(`knowledge/stats/cost-of-anytime-validity`) is one hypothesis: **the heuristic layer (slowbleed) is
correctly placed where anytime-valid detectors are weakest** — correlated, sub-threshold drift.
That hypothesis has never been measured. Two scale systems are in play and are not commensurate a
priori: slowbleed thresholds are in fraction-of-mean units (slopeNorm band [0.001, 0.010) per tick,
ratio gate ±2%), the Ville arms' in noise units (σ). On this corpus σ/mean ranges ≈ 0.0023–0.0087,
so the same drift is "small" in one system and "large" in the other. Whether a complementarity
window exists is exactly what the units dispute cannot settle without a run.

## 2. Design

**Scenario shape.** Synchronized upward drift on the four corpus-modeled signals (`p99_latency`,
`ttft`, `cost_req`, `downstream_err`) — precisely the four members of slowbleed's nine-key checklist
that have a corpus noise model, so four drifting signals is both the maximum injectable under the
fallback-not-invent rule and slowbleed's minimum qualifying count. Per (scenario, slope): healthy
per-signal streams from the corpus jitter model with C9's seeding
(`mulberry32(fnv1a(scenario|signal|slope))`), calibration window 500, then for t ≥ 30 the injected
value is `v_t · (1 + s·(t − 30))` — a multiplicative ramp at slope `s` fraction-of-mean per tick,
common to all four signals. T = 100 ticks, injection at t = 30, as in C9 and the suite convention.

**Slope grid (fraction-of-mean per tick):**
`s ∈ {0.0002, 0.0005, 0.001, 0.002, 0.005, 0.010, 0.020}` — two cells below slowbleed's band, four
inside it (0.001, 0.002, 0.005 — and 0.010 sits exactly on the exclusive ceiling), one above. The
above-ceiling cell is deliberate: `slopeNorm < 0.010` is an exclusive bound in the shipped rule, so
steep drift is a *designed* slowbleed blind spot and the grid must show it rather than hide it.

**Arms**, all evaluated per tick on identical trajectories (paired):

1. **mixture-4** — Family A Gaussian-mixture supermartingale per signal (C9's adapter, φ = 0), one
   per drifting signal at C9's per-signal α = 3.333×10⁻⁵; the arm fires when any of the four fires.
2. **betting-4** — Family A aGRAPA betting e-process per signal, same α, same union rule.
3. **slowbleed** — the shipped rule verbatim: fresh engine `TrendBuffer` per trial, all nine keys
   pushed per tick (the five without noise models pinned at their baseline constants — flat series,
   which cannot satisfy the rule's drift test), baseline = calibration means, fire when the rule
   returns true.

**Detection** = first fire at t ∈ [30, 99]; a fire before 30 is a false alarm, reported separately;
D = detections/trials. 131 scenarios × 7 slopes × 3 arms.

## 3. Endpoints

- **E1 — the complementarity window (the surviving hypothesis).** PASS iff there exists a grid
  slope where `D(slowbleed) ≥ 0.5` and `D(mixture-4) ≤ 0.5`. That is the literal content of "the
  heuristic covers a cell the anytime-valid layer does not." FAIL means the surviving hypothesis
  from C9 is refuted as-measured too: no measured regime on this corpus needs the heuristic.
- **E2 — drift tax inside the Ville class.** At each slope, the matched-displacement step
  comparison: total injected displacement at end-of-window is `Δ(s) = s·69` (fraction of mean).
  Convert to σ per signal and compare `D(mixture-4, drift s)` against C9's single-signal mixture
  detection at the nearest step δ (union-adjusted: `1−(1−D_step)⁴` under the paired-independence
  reading, reported alongside raw). PASS iff drift detection at matched displacement is within
  0.10 of the step benchmark at every slope where both are defined; FAIL localises the drift tax.
  *Confound, stated now:* the union adjustment assumes cross-signal independence of detection
  events that pairing does not guarantee; E2's verdict is recorded as computed but the report must
  carry this caveat regardless of outcome.
- **E3 — slowbleed's absorption boundaries.** The smallest and largest grid slopes with
  `D(slowbleed) ≥ 0.5`, stated in both unit systems (fraction-of-mean per tick; σ per tick per
  signal). No pass bar — this is the first measurement of the shipped rule's operating window on
  its own corpus, and both edges (floor and the designed ceiling blindness) are the deliverable.

## 4. Falsifiers accepted in advance

- E1 FAIL kills the "heuristic is correctly placed" hypothesis on this corpus — the last surviving
  limb of the original anytime-valid-tax thesis — and the honest conclusion becomes: the Ville
  portfolio needs no heuristic complement in any measured regime here.
- E1 PASS with the window sitting *inside* slowbleed's band while mixture-4 detects everything
  below it would still refute the folk version ("Ville arms are weak on slow drift") and relocate
  slowbleed's value to the percent-scale regime only.
- E2 verdicts bind only the drift-vs-step contrast at matched displacement; they say nothing about
  baseline-estimation validity (axis 2), which stays out of scope exactly as in C9.

## 5. Mechanics

Append-only results (`results/run-<UTC>/`), refuse-existing-dir, manifest with SHAs, seeds, pins,
node version; report verdicts as computed with a machine-checked consistency script
(`analysis/check_report.mjs` pattern from C9). Smoke tests for all three arms — including a
verified slowbleed fire on an in-band synthetic drift and a verified non-fire on clean data —
run and recorded *before* the sweep, per the H₀-battery precedent of silently-wrong runs.

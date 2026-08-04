# Report — Drift-Regime Sweep

- **Study id:** 2026-08-drift-regime-sweep
- **Run:** `results/run-2026-08-04T16071Z/` — deploysignal SHA in the manifest, engine pin
  `#v0.6.6-pre` (installed 0.6.6-pre), scenario-file SHA-256 in the manifest.
- **Endpoints and grid** were frozen in `PREREGISTRATION.md` (committed 2026-08-04, before any
  run). Verdicts below are recorded **as computed**; no threshold was moved.
- Runtime: 0.23 s for 2,751 arm-trials (7 slopes × 3 arms × 131 scenarios, four correlated
  drifting signals per trial). **False alarms: 0 of 2,751.**

## 0. The headline

**The last surviving limb of the anytime-valid-tax thesis is refuted as-measured.** The hypothesis
was that the heuristic layer (slowbleed) is correctly placed where anytime-valid detectors are
weakest — correlated sub-threshold drift. Measured: there is **no slope at which slowbleed detects
and the mixture portfolio does not**. The mixture-4 union detects 100% at every pre-registered
slope, including 0.0002/tick where slowbleed is fully blind; slowbleed's own floor (0.001/tick) sits
**20–50× above** the mixture's, located post-hoc between 2×10⁻⁵ and 5×10⁻⁵ per tick (§4). Inside
slowbleed's band the mixture is also faster: at 0.001/tick, median time-to-detect 10 ticks against
slowbleed's 34. On this corpus the Ville-bounded portfolio needs no heuristic complement in any
measured drift regime.

## 1. Detection rates (α = 3.333×10⁻⁵ per signal; slopes in fraction-of-mean per tick)

| slope | mixture-4 | betting-4 | slowbleed | median TTD (mix / bet / sb) |
|---|---|---|---|---|
| 0.0002 | 1.000 | 1.000 | 0.000 | 25 / 33 / — |
| 0.0005 | 1.000 | 1.000 | 0.000 | 15 / 24 / — |
| 0.001  | 1.000 | 1.000 | 0.824 | 10 / 21 / 34 |
| 0.002  | 1.000 | 1.000 | 1.000 | 7 / 20 / 12 |
| 0.005  | 1.000 | 1.000 | 1.000 | 5 / 20 / 5 |
| 0.010  | 1.000 | 1.000 | 1.000 | 3 / 19 / 3 |
| 0.020  | 1.000 | 1.000 | 1.000 | 2 / 19 / 2 |

## 2. Endpoint verdicts (as computed)

### E1 — Complementarity window → **FAIL**

No grid slope satisfies `D(slowbleed) ≥ 0.5 ∧ D(mixture-4) ≤ 0.5`; the window is empty.

```
E1: window=[] verdict=FAIL
```

Slowbleed's blind region (below 0.001/tick) is fully covered by the mixture; slowbleed's sighted
region is fully covered too, at equal-or-better speed everywhere except the two steepest cells,
where the arms tie at 2–3 ticks.

### E2 — Drift vs matched-displacement step, inside the Ville class → **PASS** *(saturated)*

Max |gap| between drift detection and the C9 step-union benchmark is **0.0000** — every cell of
both sides sits at 1.0. The verdict stands as computed, and it is **uninformative**: the frozen
grid's smallest slope already accumulates ≥ 1.6σ per low-CV signal by window end, past both
constructions' saturation. The pre-registered independence caveat on the union adjustment never
binds (nothing to adjust at ceiling). The sub-saturation drift-vs-step contrast is measured
post-hoc instead (§4): the mixture's drift floor (~5×10⁻⁵/tick ≈ 1.5σ total displacement) is
consistent with its C9 step behaviour (δ* = 0.75σ at 50%, ~100% by 1.5σ) — no measurable extra
tax for evidence arriving as a ramp rather than a step at this window length.

```
E2: max_abs_gap=0.0000 verdict=PASS
```

### E3 — Slowbleed's operating window (no pass bar)

Floor **0.001/tick** — exactly the shipped `slopeNorm` band edge — where it detects 82.4% at
median TTD 34; full detection from 0.002. In σ-per-tick units the floor is 0.43σ (p99/ttft),
0.58σ (cost_req), 0.12σ (downstream_err) per tick. **The designed ceiling blindness never
manifests:** `slopeNorm < 0.010` is exclusive, but a ramp's measured slope passes *through* the
band during onset, so the 0.020/tick cell fires at 2 ticks rather than going blind. The ceiling
is reachable only by drift that arrives already steep — a step-onset ramp, which is C9's regime.

```
E3: floor=0.001 ceiling=0.02 verdict=(measurement, no bar)
```

## 3. Interpretation decisions (where the pre-registration left a reading open)

1. **Multiplicative ramp on the healthy draw** — `v_t·(1 + s·(t−30))` — so noise scales with the
   drifted level, matching the corpus's multiplicative noise model.
2. **Union arms instantiate four fresh per-signal detectors per trial**; the union fires on the
   first per-signal fire. No cross-signal state is shared.
3. **Slowbleed's five non-modeled keys** are pinned flat at scenario baseline constants; flat
   series cannot satisfy the rule's drift test, so slowbleed sees exactly its four qualifying
   drifting signals — its minimum count, which is the reading *most favourable* to slowbleed.
4. **Slowbleed's baseline** = the same 500-tick calibration means the Ville arms use (matched μ̂).
5. **E2's displacement** uses 69 drift ticks and cv = c/√12 per signal (uniform-jitter exact,
   mean-shift term ≈ c/2 neglected).

## 4. Post-hoc observations (not pre-registered — no verdicts attach)

- **The floor hunt** (`analysis/posthoc_floor.mjs`, same seeds scheme, below-grid slopes): mixture
  and betting both at 0.000 for s ≤ 1×10⁻⁵, 0.031 at 2×10⁻⁵, then mixture 1.000 (betting 0.901)
  at 5×10⁻⁵. The Ville floor is 20–50× below slowbleed's, and the *entire band between them* —
  where the surviving hypothesis predicted slowbleed would earn its place — is a region where the
  heuristic is blind and the mixture detects everything.
- **What slowbleed retains.** Zero α cost, and parity of speed at slopes ≥ 0.005/tick. Its value
  proposition on this corpus is redundancy, not coverage. Whether its percent-scale thresholds
  earn coverage on a *different* noise regime (real telemetry with cv ≫ 0.9%) is not measurable
  here — the corpus noise model is the corpus noise model. Stated as the standing scope limit.
- **Betting's warm-up.** The aGRAPA arm's median TTD floors at ≈ 19–20 ticks regardless of slope —
  wealth must compound from 1 — where the mixture reaches 2–3 ticks. Same trade E2-of-C9 priced at
  0.5–1σ steps, now visible in time rather than rate.
- **What this closes.** With C9 (steps) and this study (drift), both injection shapes the corpus
  defines are measured, and neither shows a regime where the anytime-valid portfolio pays a power
  price against its co-shipped alternatives. The unmeasured remainder is now *baseline-estimation*
  validity (axis 2), not detection power.

## 5. Reproduction

```sh
node studies/drift-regime-sweep/analysis/run_sweep.mjs      # refuses an existing run dir
node studies/drift-regime-sweep/analysis/posthoc_floor.mjs
node studies/drift-regime-sweep/analysis/check_report.mjs   # report ↔ endpoints.json consistency
```

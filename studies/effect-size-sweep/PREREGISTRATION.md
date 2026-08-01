# Pre-registration — Effect-Size Sweep

- **Study id:** 2026-07-effect-size-sweep
- **Layer under test:** Family A detector dispatch (`../deploysignal-engine/tools/_nab-validation-dispatch.ts`)
  against injected regressions of controlled magnitude.
- **Pre-registered:** 2026-07-31
- **Template:** `../ballast/studies/2026-07-trace-validation/PREREGISTRATION.md`; provenance rules
  transfer verbatim.

This file is committed **before any sweep runs**. Endpoints and thresholds are frozen as of this
commit. A failed endpoint is a publishable result; thresholds do **not** move afterwards. Post-hoc
analysis is permitted only in a clearly labelled post-hoc section of the report.

---

## 0. The hypothesis, and why it needs testing

`~/concord/knowledge/stats/cost-of-anytime-validity` records four literature measurements of what
anytime-validity costs — Howard 2021 (<2× CS width), Wasserman 2020 (≈2× UI radius), Ramdas 2020
(≈√log τ, ~3.4× at τ=10⁵), and engine ADR 0025 (parity at 2.5σ, absorption below). All four
concentrate the cost at **small effect sizes**.

**H1: the anytime-valid tax on Family A widens monotonically as injected effect size shrinks.**

The wiki's previous evidence for a related claim was **retracted** on 2026-07-31. NAB scores of
35.50 (classical Page-CUSUM) against 23.45 (Ville mixture supermartingale) collapsed for two reasons:
a **silence floor** of `100 × 6/35 = 17.14` (above the floor the gap is 18.36 against 6.31), and a
**three-way confound** — Ville bound, reset-vs-no-reset, and squared-per-tick-vs-signed-cumulative
all changed together.

This study exists to test H1 without either defect: on a canary-shaped corpus with a controllable
effect size, and with the confound structure stated up front.

## 1. Engine — resolved 2026-07-31

**The study runs against `deploysignal-engine@v0.6.6-pre`.** Operator decision, and the ambiguity
that motivated this section has since been removed by a migration in this repo.

**The local `engine/detectors/` tree no longer exists.** A migration landed on `main` on 2026-07-31
(`e6e18f4`…`aeb7cc5`) moving every detector into the engine package, including the Family A
Page-CUSUM group (`300fd6a`) that supplies two of this study's three arms. `git ls-files
engine/detectors/` now returns zero files; what remains under `engine/` is the orchestration, audit,
gate and type layer. So there is no longer a second copy of the detectors, and **the arms under test
come unambiguously from the pinned package.**

`package.json` was reconciled to `#v0.6.6-pre` in the same migration (`df3ae2c`), matching what
`node_modules` already carried.

**What `v0.6.6-pre` contains**, enumerated from `git log 314537e..HEAD` because the release shipped
without a CHANGELOG entry (`8b611aa`): a Family C registry fix registering
`sequential_mmd_betting_e_process` (`2a36ff2`), a de-branding scrub that also tagged the conformal
singular branches (`01b1aae`), an AR(1) short-baseline guard test (`0f0baee`), and a docs pointer
(`2becdb6`).

**None of those touch the three Family A arms.** The only detector file changed between v0.6.5-pre
and v0.6.6-pre is `conformal.ts`, which is Family E, and `tools/_nab-validation-dispatch.ts` is
unchanged. So the arms are identical to v0.6.5-pre while ADR 0026's log-domain wealth — the change
that motivated this decision — is fully included.

The run manifest records the resolved SHA regardless.

## 2. Data and construct (frozen)

**Corpus:** `runs/adversarial-scenarios.json` — 131 canary-shaped scenarios.

**Injection:** `tools/inject-regression.ts` with `delta_kind: relative_to_baseline_sigma`, i.e.
`v' = v + delta × σ_baseline`. **`delta` in units of σ is the sweep parameter.**

**Sweep grid (frozen):** `delta ∈ {0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0}`. Chosen to span the
regime engine ADR 0025 measured (parity at 2.5σ, absorption at 1.5σ) with resolution below it.

**Arms (frozen), all three dispatched from `_nab-validation-dispatch.ts`:**

| Arm | Function | Validity class |
|---|---|---|
| `classical` | `evaluateFamilyAShadow` (~line 129) | classical epoch-α |
| `betting` | `evaluateFamilyABettingShadow` (~line 155) | Ville |
| `mixture` | `evaluatePageCusumMixtureSupermartingale` (~line 211) | Ville |

**Signals:** the six Family A SLIs — `p99_latency`, `ttft`, `eval_score`, `tool_success_rate`,
`downstream_err`, `cost_req`.

**Fallback rule.** If an arm cannot be driven at a fixed `delta` with identical calibration inputs,
the study is reported **not-executable** for that arm. Endpoints are **not** redefined and the grid
is **not** moved to fit whichever arms cooperate.

## 3. The confound, declared before the run

The retracted NAB comparison varied three things at once. This study **cannot fully eliminate** the
same confound, because `classical` and `mixture` differ by construction in more than the bound:

| Axis | `classical` | `mixture` |
|---|---|---|
| Bound | epoch-α | Ville |
| Reset | reset-at-zero (Page 1954) | no reset |
| Increment | squared-per-tick | signed-cumulative |

**Declared position:** the primary comparison is `betting` vs `mixture` — **both Ville-bounded**, so
a difference between them is *not* a validity-class effect. `classical` is reported as a third arm
and its comparison against either is labelled **confounded** in every table where it appears.

Any conclusion drawn from a `classical` comparison must name all three axes. A report that attributes
a `classical`-vs-`mixture` gap to the Ville bound alone is invalid under this pre-registration.

## 4. Endpoints (thresholds frozen)

Let `D(arm, delta)` = detection rate and `T(arm, delta)` = median ticks-to-detect among detections.

### E1 — Monotone widening of the tax *(primary)*

Define the tax at each grid point as `gap(delta) = D(classical, delta) − D(mixture, delta)`.

**PASS iff** `gap(delta)` is **monotonically non-increasing** as `delta` increases across the eight
grid points, **and** `gap(0.25) − gap(3.0) ≥ 0.10`.

Confounded by §3 — reported with that label. E1 is the literature's prediction stated as a testable
shape, not a validity-class claim.

### E2 — Ville-internal comparison *(the unconfounded one)*

**PASS iff** `|D(betting, delta) − D(mixture, delta)| ≤ 0.10` at every grid point.

Both arms are Ville-bounded. A **failure** localises a difference to construction rather than to the
guarantee, which is the more useful result.

### E3 — Absorption threshold

Define `delta*` = the smallest grid `delta` at which `D(mixture, delta) ≥ 0.50`.

**PASS iff** `delta* ≤ 2.5`, matching engine ADR 0025's measured parity point. Reported as computed;
this is a characterisation endpoint and a FAIL is informative rather than a defect.

## 5. Provenance rules (verbatim from the ballast/runway template)

1. This file is committed **before any run**.
2. Every run writes an append-only `results/run-<UTC>/manifest.json`: engine SHA and pin, DeploySignal
   SHA, scenario-file hash, seeds, command, versions. No result is ever overwritten.
3. A rerun is permitted **only** for a code defect, fixed test-first, with the superseding run's
   manifest naming the defect; the prior run remains.
4. The report states every endpoint's number and PASS/FAIL verdict. A not-executable outcome is
   itself reported.
5. Report numbers are **machine-checked against the run JSON**, per
   `../runway/studies/2026-07-public-data/tests/test_report_consistency.py`. One report path only.

## 6. Scope

**Out of scope**, and deliberately not endpoints:

- Families C, D and E. This is a Family A study.
- NAB. The corpus here is canary-shaped by design; NAB is what this study exists to avoid.
- Any change to detector code. This measures what ships.

## 7. Disposition of the result

Per the engine/consumer charter (engine ADR 0004), the corpus and harness stay in this repo, but a
per-family power-versus-effect-size characterisation **is validity accounting** and belongs in the
engine. If E1–E3 produce a stable characterisation, propose promoting it alongside the validity
envelopes in `detectors/validity-envelope.ts`, where Families C, D and E currently publish none.

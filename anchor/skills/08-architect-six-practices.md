# Skill: Architect Six Practices

**Trigger:** Architect (or whoever owns spec-emit role) drafting a non-trivial spec.
**Application moment:** At spec-emit time (T0). Each practice applied to the draft before declaring ready for routing.
**Owner:** Architect.

## What it is

Six practices the architect applies to every non-trivial spec before declaring it ready. Each practice was born from a specific failure mode where a spec passed casual review but produced expensive downstream rework.

The practices are deliberately mechanical-and-checklist-style rather than judgment-based. The failures they prevent come from missing-something-while-thinking-about-something-else, not from inability-to-do-the-work. Mechanical verification beats human attention budget.

## The six practices

| # | Practice | Closes failure mode |
|---|---|---|
| **P1** | Inline derivations for every numerical threshold | "Where did 0.7 come from?" — arbitrary magic numbers in specs |
| **P2** | Exhaustive option-space enumeration | "Why X and not Y?" — unjustified choice without alternatives considered |
| **P3** | Representative-baseline spot-check against concrete shipped state (10 axes) | "The spec contradicts what's actually deployed" |
| **P4** | Per-component claim verification + semantic comparability | "Are these two things actually equivalent like the spec says?" |
| **P5** | Pseudo-code vs test-case round-trip + anchor consistency | "The implementer can't tell what this spec actually means to do" |
| **P6** | Empirical profile verification for performance claims | "Should be fast" — performance claims without measurement |

## P1 — Inline derivations for every numerical threshold

Every numerical value in a spec has a derivation inline. No magic numbers.

**Bad:**
> Set `effective_sample_size_threshold = 0.7`.

**Good:**
> Set `effective_sample_size_threshold = 0.7` because: (a) at ESS < 0.7 the variance estimate becomes unreliable per [reference]; (b) the existing legacy threshold is 0.5 which has produced two false-positives; (c) 0.7 maintains the conservative side without sacrificing sensitivity per [test sweep].

The derivation can be one sentence or a paragraph. It must answer: "why this number specifically, why not the obvious alternative, what's the failure mode of the alternative."

**Origin:** Failure mode where ESS threshold was bumped from 0.7 to 0.9 in a spec without inline derivation. Implementer adopted the new value; downstream regression because 0.9 was chosen by intuition rather than data.

## P2 — Exhaustive option-space enumeration

For every non-obvious decision in a spec, enumerate the considered alternatives explicitly.

**Bad:**
> Use Hotelling T² for the joint-distribution drift detector.

**Good:**
> For the joint-distribution drift detector, considered:
> - **Hotelling T² (chosen).** Pros: classical, well-understood, fast; cons: assumes elliptical baseline distribution.
> - **Kernel MMD.** Pros: nonparametric, captures higher-moment drift; cons: O(n²) cost, kernel bandwidth selection adds tuning surface.
> - **PSI (Population Stability Index).** Pros: simplest; cons: per-feature, doesn't capture joint drift at all.
>
> Choosing Hotelling T² because the baseline distribution is approximately Gaussian (verified empirically) and runtime cost matters at our scale.

The enumeration prevents "we picked X without considering alternatives" criticism. It also surfaces the implicit trade-offs that future maintainers need to understand.

**Origin:** Failure mode where multivariate-suppression strategy was specified without enumerating the obvious alternatives; reviewer flagged that the chosen strategy was the wrong fit for the actual distribution shape.

## P3 — Representative-baseline spot-check against concrete shipped state (10 axes)

P3 is the most heavily-elaborated practice in this pack — it has 10 sub-axes, each born from a specific failure. See METHODOLOGY.md for the full list. The spirit:

**The architect must verify that the spec's claims about existing code/configs/artifacts actually match the live state at the moment of spec drafting**, not the architect's memory of last week's state.

Concretely:
- Open the file with the live constants (don't cite from memory)
- Grep all coordination artifacts that might carry contradicting claims
- Open the compiled artifact (not just source) for behavior-on-artifact claims
- Verify input pipeline alignment before hypothesizing detector-layer bugs
- ... [and 6 more axes]

**Origin:** Multiple failure modes where specs cited values that had drifted since the architect's last read. Each axis closes one specific drift class.

## P4 — Per-component claim verification + semantic comparability

When a spec claims two things are equivalent, verify they actually are at the level of detail the spec depends on.

**Bad:**
> The new sliding-buffer Hotelling and the existing per-cell Hotelling produce equivalent verdicts under healthy traffic.

**Good:**
> The new sliding-buffer Hotelling and the existing per-cell Hotelling produce equivalent verdicts under healthy traffic, verified by:
> - Per-cell μ/Σ derived identically from the same sample (verified by reading both calibrators)
> - Threshold derivation identical (Wilson-Hilferty χ²(1-α, p) in both)
> - Suppression rules identical (covariance_singular returns suppressed in both)
> - Empirically: 120/120 healthy scenarios produce identical verdicts (verified by running both)

Equivalence claims are notorious for being "almost true" — the unstated differences are where bugs live. P4 forces the spec to enumerate the dimensions of equivalence, which forces them to be true rather than implied.

**Origin:** Failure mode where two detector implementations were claimed equivalent in the spec; under category mismatch (a specific scenario class), they produced different verdicts. Reviewer caught it; spec had been wrong since drafting.

## P5 — Pseudo-code vs test-case round-trip + anchor consistency

Every algorithmic claim in a spec must round-trip with at least one test case:

1. Spec contains pseudo-code for the algorithm
2. Spec contains a worked test case showing input → output for the pseudo-code
3. Implementer can execute the pseudo-code by hand on the test case input and produce the test case output

If the round-trip fails (pseudo-code doesn't produce the documented output), the spec is wrong.

**Anchor consistency:** when multiple specs touch the same algorithmic surface, the pseudo-code in each must be consistent. P5 also requires checking that this spec's pseudo-code agrees with prior specs' pseudo-code for the same surface.

**Origin:** Multiple failure modes where pseudo-code in a spec didn't actually compute what the prose described, or where two specs' pseudo-code for the same algorithm disagreed.

## P6 — Empirical profile verification for performance claims

Performance claims must be measured, not estimated.

**Bad:**
> The detector adds negligible per-tick overhead.

**Good:**
> The detector adds 2.8μs per-tick overhead (measured: `tools/benchmark-detector.ts` over 100K iterations on Node 22, darwin-arm64; runs/benchmarks/detector-overhead-2026-04-15.json). At the production 5s tick rate, this is 0.00006% of tick budget.

The empirical profile must include: measurement tool, environment, sample size, output artifact (committed). "Quick benchmark in console" doesn't count.

**Origin:** Failure mode where pilot-event-2 performance claim was based on a single hand-measured run that didn't reflect production conditions. Measured overhead under production conditions was ~10× what the spec claimed.

## How the six practices interact with the four anchors

The six practices are the **discipline content** for the T0 anchor (architect spec-emit). T1/T2/T3 anchors have their own discipline sets (TPM grilling, defensive patterns, spec-vs-impl audit respectively). The four-anchor framework is the structural skeleton; the six practices are what makes T0 specifically rigorous.

In practice, applying all six practices to a spec adds 30-60 minutes of architect time per spec. The recovered downstream cost (rework prevented) is typically 4-8× that on a single non-trivial spec.

## Worked example — applying all six to a small spec

Spec: add a new threshold for `tool_success_rate` rollback.

**P1:** Threshold value derived inline. "0.92 because: baseline mean is 0.965 across 120 healthy scenarios; lower 99% CI is 0.93; 0.92 is conservative without sacrificing sensitivity."

**P2:** Alternatives enumerated. "Considered 0.95 (too aggressive, would have fired on 3/120 healthy), 0.90 (too conservative, would have missed 2 of the 4 known regressions), 0.92 (chosen)."

**P3:** Concrete-values check. Opened `engine/gates/health.ts`; verified existing thresholds for adjacent signals; confirmed the spec's cited `ROLLBACK_DEFS` shape matches the file.

**P4:** Comparability claim. Spec claims new threshold is consistent with existing pattern. Verified by listing the 7 existing per-signal rollback thresholds; new threshold uses the same suppression rules, the same trend-discount logic, the same per-cell lookup. Claim verified.

**P5:** Round-trip. Spec includes worked test case: "live = 0.91, baseline mean = 0.965, threshold ratio = 0.91 / 0.965 = 0.943; this is < 0.95 trend-discount-adjusted threshold; rollback fires." Implementer can execute by hand and verify output.

**P6:** Performance. New threshold adds one comparison per tick; benchmarked at +0.04μs per tick (negligible vs 2.8μs existing detector). Performance claim quantified.

Total time to apply all six: ~25 minutes for this small spec. Caught at P2 that 0.95 alternative would have fired on healthy traffic; without P2 enumeration, that risk was invisible.

## Common pitfalls

- **Skipping P3 because "I just looked at the file last week."** No. P3 requires verifying at the moment of spec drafting. Memory is the failure surface.
- **Pro forma derivations in P1.** "Because 0.7 is reasonable" is not a derivation. It must answer what fails at 0.6 and what fails at 0.8.
- **P2 enumeration with one option.** If only one option appears, you haven't enumerated the option space. Explicitly include "vs status quo" as an option if no alternatives are considered.
- **P5 round-trip in head, not on paper.** The test case must be written down. Mental round-trips don't catch the failure cases.
- **P6 measurement on dev laptop.** Production conditions may differ substantially. Measure in environment that matches production at least in order-of-magnitude.

## Cost

30-60 minutes per spec. Recovers 4-8× cost in prevented downstream rework on non-trivial specs. For trivial specs (no thresholds, no alternatives, no equivalence claims), most practices degenerate to no-ops.

## Compatibility

These practices are framework-agnostic. They work for any spec format and any agent orchestration framework. They also work for human-written specs in non-agent contexts.

In agent orchestration frameworks: each practice can be encoded as a pre-emit validator. P1 can be enforced by "every numerical literal in the spec must be near a derivation paragraph" linting. P5 can be enforced by "every pseudo-code block must be near a worked-example block" linting. Automation complements but does not replace human discipline.

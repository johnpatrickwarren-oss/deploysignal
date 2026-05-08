# Skill: V/Q Framework

**Trigger:** Investigating an unexpected outcome (test failure, production incident, validation discrepancy).
**Application moment:** At investigation kickoff, before drafting any specific hypothesis.
**Owner:** Architect (or whoever owns the investigation).

## What it is

A two-stage discipline for bounding investigation cycles:

- **V (Variants):** enumerate hypothesis variants at the architectural-layer level FIRST. Don't go deep on one hypothesis until alternatives are enumerated.
- **Q (Questions):** for the chosen hypothesis, draft the empirical question that would falsify it. The question is the unit of investigation, not the hypothesis itself.

The discipline prevents "rabbit hole" investigations where one hypothesis gets deep-investigated for days before alternatives are even considered.

## Why it works

Investigation under uncertainty is expensive. Each hypothesis investigated takes time. The cost of investigating the wrong hypothesis first is the time spent before realizing it was wrong, plus the opportunity cost of NOT investigating the right hypothesis sooner.

V/Q reduces cost by:

1. **V before Q forces option enumeration before commitment.** You can't "fall in love" with a hypothesis that you haven't even compared to alternatives.
2. **Q-as-unit-of-investigation forces empirical falsifiability.** A hypothesis you can't falsify with a specific empirical test is not yet investigation-ready; convert to a question first.
3. **Multiple Vs sharing one Q is cheap.** A single empirical test can rule out multiple hypotheses simultaneously. Bisection is the canonical example.

## How to apply

### Step 1 — Enumerate Variants (V)

When an unexpected outcome surfaces, before drafting any hypothesis, enumerate at the architectural-layer level:

- **V1:** which architectural layer might be wrong? (Compile-time? Runtime? Wrapper? Algorithm? Calibration source?)
- **V2:** within that layer, what specific mechanism?
- **V3:** what about the layer above? Below?
- **V4:** what if the input data is wrong, not the system?

Write each V down. Even rough enumerations (V1 = "calibration source", V2 = "wrapper bug", V3 = "algorithm regime") are valuable — they prevent the "I assumed it was X" failure.

Memorial D prior weighting (see [`02-memorial-accretion.md`](./02-memorial-accretion.md)) applies here:

```
actual_prior = analytical-model-correctness
             × regime-coverage
             × attribution-verification
             × architectural-layer-coverage
```

The "architectural-layer-coverage" factor IS the V enumeration. Skipping it means the prior is over-confident.

### Step 2 — Draft the Question (Q)

For the highest-prior V, draft the specific empirical question that would falsify it.

The question must be:
- **Specific:** "Does X behave like Y under conditions Z?" not "Is X working correctly?"
- **Empirical:** answerable by running code or reading data, not by analytical reasoning
- **Bounded in time:** answerable in <1 hour of work, not <1 day

If a Q would take >1 hour, decompose: Q1, Q2, Q3 sub-questions.

### Step 3 — Run the Q

Execute the empirical test. Three outcomes:

- **CONFIRM:** the V is correct. Move to fix-forward.
- **FALSIFY:** the V is incorrect. Mark as ruled-out; move to next V; do NOT re-investigate this V on a different Q without new evidence.
- **AMBIGUOUS:** the Q didn't decisively answer. Refine the Q; re-run.

### Step 4 — Track ruled-out Vs

Maintain a list of ruled-out Vs with the Q that ruled them out. Prevents re-investigation of the same V via a different angle (a common cycle-burning pattern).

### Step 5 — When stuck, escalate

If 3+ Vs have been falsified and you don't have a remaining V with reasonable prior, the issue is likely OUTSIDE your enumerated layer set. This is the trigger to escalate the V enumeration itself — what layer did you not consider?

In DeploySignal Topic 52 (the canonical worked example), 3+ algorithm-layer Vs were falsified before the team realized the issue was in the SAMPLE STREAM (a layer the original V enumeration hadn't covered). The escalation triggered re-enumeration; the new V (sample-stream attribution) was the right one.

## Worked example

[From DeploySignal coordination/INVESTIGATION-CHAIN-POSTMORTEM-TOPIC-52.md, 2026-04-26]

Topic 52 investigation. Unexpected outcome: Family A betting e-process appeared to fire on healthy-window samples in FPR sweep.

Initial V enumeration (architect):
- V1: wealth-state leakage between cells (algorithm-layer hypothesis)
- V2: implementation bug in update step (algorithm-layer hypothesis)
- V3: calibration mismatch under iid bootstrap (calibration-layer hypothesis)

Q for V1: "Does wealth state correctly reset at cell boundary?" Empirical test via unit test at synthetic Gaussian H₀.

Q1 result: FALSIFY (V1). State resets correctly.

Q2 for V2: "Does the wrapper modify state outside the algorithm path?" Empirical test via wrapper-bypass log diff (Path A vs Path B).

Q2 result: FALSIFY (V2). Wrapper byte-identical to direct path.

Q3 for V3: "Does parametric Gaussian H₀ produce 0/N fires (as it should under formal H₀)?"

Q3 result: FALSIFY (V3). 79/131 fires under parametric. **This was the empirical surprise that triggered re-enumeration.**

Re-enumeration introduced V4: sample stream attribution itself was wrong. Q4 (firing-ID capture by detector) confirmed V4: actual attribution was Family C/D/E, not Family A.

The expensive part of the investigation (~2-3 days) was the time spent on V1/V2 before V/Q discipline triggered the re-enumeration. The memorial that came out of this (P3 axis 10: firing-attribution-discipline) prevents the failure mode upstream — verify attribution at source BEFORE drafting V trees.

## Common pitfalls

- **Going deep on V1 before enumerating V2/V3.** The most common failure. Enforces by always writing the V list down before drafting the first Q.
- **Q not empirical.** "Is the math correct?" is not a Q; it's a research project. Decompose into "Does this specific computation match this specific reference value?"
- **Q not bounded.** "Run a full sweep" is not a 1-hour Q. Decompose.
- **Re-investigating ruled-out Vs.** Track ruled-out Vs explicitly to prevent this.
- **Failure to escalate after 3+ ruled-out Vs.** When the right answer isn't in your enumerated set, the meta-failure is the enumeration itself.

## Cost

V enumeration: ~10-15 minutes per investigation kickoff.
Q drafting: ~5-10 minutes per V.
Q execution: 30-60 minutes per Q (target).

Total: substantially CHEAPER than rabbit-hole investigation. The discipline pays for itself on the first prevented rabbit hole.

## Compatibility

The V/Q framework is methodology, not framework-specific. Works inside any agent orchestration system, any team structure, solo or multi-agent.

Particularly powerful when paired with [`02-memorial-accretion.md`](./02-memorial-accretion.md): each ruled-out V class becomes a memorial candidate, raising future enumeration completeness.

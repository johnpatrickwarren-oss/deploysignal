# Skill: Memorial Accretion

**Trigger:** Any time a discipline failure produces wasted effort that could have been prevented by an explicit rule.
**Application moment:** At post-mortem time, immediately after the failure is understood.
**Owner:** The role whose discipline gap allowed the failure (typically Architect or TPM).

## What it is

The single most differentiated discipline in this methodology pack. **The methodology learns from its own failures by accumulating explicit, named, file-backed disciplines that prior failures revealed.**

Each violation of a discipline is memorialized as a record. Each subsequent application is memorialized as a confirmation. The ratio of violations to confirmations drives prioritization: high-violation disciplines need stronger enforcement; high-confirmation disciplines have stabilized.

This is methodologically distinct from generic post-mortems. Post-mortems describe what went wrong; memorial accretion converts each post-mortem into a forward-looking discipline that prevents the class of failure from recurring.

## Why it works

Software engineering disciplines accumulate scar tissue. Senior engineers internalize "always check X" rules from past failures. Junior engineers don't. Most agent orchestration systems treat each project as starting from zero discipline.

Memorial accretion makes the scar tissue **explicit**, **named**, **file-backed**, and **applicable across projects**. The discipline catalog grows from each failure and applies to all future work.

The key empirical claim: **a methodology pack that accumulates disciplines from failure outperforms a methodology pack with a fixed initial discipline set**, because the failure modes of agent-orchestrated work are not all known in advance.

## How to apply

### When to memorialize

Memorialize a new discipline when:
1. A failure produced material wasted effort (~half-day or more)
2. The failure could have been prevented by a specific, namable rule
3. The rule is general enough to apply to future work, not just to the specific failure

Do NOT memorialize for:
- One-off mistakes with no pattern
- Domain-specific knowledge that lives in code comments
- Aesthetic preferences masquerading as discipline

### Memorial structure

Each memorial gets its own file at `.memorials/<short-name>.md` (or equivalent location). Required sections:

```markdown
# Memorial — <short discipline name>

**Discipline:** <one-line statement of the rule>

**Trigger:** <when does this rule apply?>

**Application moment:** <when in the workflow do you apply it?>

**Why it exists:**
<reference to the originating failure: which artifact, what date, what wasted effort>

**How to apply:**
<concrete steps; checklist where appropriate>

**Violations vs confirmations:**
- V1: <date, artifact, what was missed, what cost>
- V2: ...
- C1: <date, artifact, what was caught>
- C2: ...

**Status:** <active, retired, in-trial>
```

### Tracking ratios

Maintain violations vs confirmations on each memorial. The ratio is diagnostic:

- **High V / low C** (e.g., 9V / 1C): discipline is real but not yet enforced. Strengthen the trigger or add it to a checklist.
- **Balanced V / C** (e.g., 5V / 5C): discipline is being learned. Continue monitoring.
- **Low V / high C** (e.g., 1V / 15C): discipline has stabilized. Can be moved to passive maintenance.
- **Zero V over long period after stabilization:** consider retiring.

In DeploySignal, Memorial D ran 1V/9V → 2V/11V → 3V/14V → 5V/20V over the project lifetime. The ratio improved (more confirmations relative to violations) as the discipline got internalized — which is the desired pattern.

### When to retire

A memorial gets retired when:
- The discipline has stabilized (consistent confirmations, no new violations over multiple cycles)
- The underlying failure mode has been structurally eliminated (e.g., a tool now prevents it)
- Application is universally automatic and no longer needs explicit invocation

Retired memorials stay in the file system as historical record. Don't delete; mark `Status: retired (date, reason)`.

## Worked example

[From DeploySignal coordination/INVESTIGATION-CHAIN-POSTMORTEM-TOPIC-52.md, 2026-04-26]

Topic 52 produced a 7-architect-artifact phantom investigation chain. Misattribution at one commit conflated TPR-sweep firing-IDs with FPR-sweep firing-IDs. Architect built hypothesis trees on the wrong premise. ~2-3 days of wall-clock cost.

After the chain was caught and resolved, memorialized as **P3 axis 10: firing-attribution-discipline**:

> "Before drafting any hypothesis tree on a SPECIFIC detector's misbehavior, verify firing-ID attribution at the source data (validation report card / FPR sweep output / TPR sweep output) BEFORE constructing the hypothesis tree. Attribution conflations between sweeps (FPR vs TPR; healthy-window vs injection; per-cell vs aggregate; per-signal vs cross-signal) propagate into hypothesis trees that chase phantom mechanisms."

Application moment: at hypothesis-tree drafting time, BEFORE drafting any V/Q variants.

In the months after this memorial landed, similar phantom chains were prevented at multiple investigation entry points. The memorial paid for its 2-3 day origin cost within the first prevented recurrence.

## Common pitfalls

- **Memorializing too eagerly.** Every minor mistake doesn't deserve a memorial. Apply the "would have prevented half-day or more" filter.
- **Memorializing too vaguely.** "Be careful with covariance matrices" is not a memorial. "Verify Σ_C cell-source agrees with Σ_A cell-source at compile time before running validation" is a memorial.
- **Failure to track ratios.** Without ratios, you can't tell which disciplines are working. The bookkeeping is part of the discipline.
- **Memorial bankruptcy.** If you accumulate 50 memorials and none are being actively applied, the catalog has become noise. Consolidate, retire, simplify.

## Cost

Approximately 30-60 minutes per memorial creation. Approximately 5-10 minutes per discipline application. Maintenance overhead is small if ratios are tracked at memorial-modify time.

## Compatibility

- Works alongside [Superpowers](https://github.com/obra/superpowers) skill files. Each Memorial can be packaged as a Superpowers skill.
- Works with CrewAI / LangGraph / Mastra by encoding the discipline check as an evaluator step.
- Works for solo human work (no agent involvement).

## Differentiation

This discipline is, as far as we can tell, novel in the agent orchestration methodology space as of May 2026. Superpowers, BMAD, Spec Kit, and similar opinionated frameworks have curator-driven skill addition (the framework author adds skills); none have failure-driven discipline accretion as a first-class operational pattern with violation/confirmation tracking.

If your team adopts this and finds it useful, please open an issue in this repo describing the discipline you memorialized — the most useful contribution to the pack is more memorialized disciplines from real failures.

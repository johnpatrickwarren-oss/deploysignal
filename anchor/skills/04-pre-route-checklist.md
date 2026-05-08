# Skill: Pre-Route Checklist

**Trigger:** TPM (or coordinator role) about to forward a routing artifact to the implementer.
**Application moment:** After routing draft is complete, before forwarding.
**Owner:** TPM.

## What it is

A short, mechanical, file-backed checklist that prevents the most common routing-side coordination errors. Each item corresponds to a documented historical failure mode.

The checklist is deliberately mechanical rather than judgment-based — the failures it prevents come from cognitive load (you THOUGHT the file was named X) rather than from skill gap. Mechanical verification beats memory.

## The checklist

Before forwarding ANY routing artifact, verify:

```
[ ] All filenames cited are LIVE
    (verified by `ls` or by opening the file, not by memory)

[ ] All version labels cited are CURRENT
    (verified against canonical version doc, not by memory)

[ ] All line numbers cited are CURRENT
    (verified by opening the file at the cited line, not by memory)

[ ] All test counts cited are CURRENT
    (verified by `wc -l test/*.test.*` or equivalent, not by memory)

[ ] All claims about another role's prior output are GREP-VERIFIED
    in their actual artifact, not summarized from memory

[ ] All architect decisions cited are LINKED to the architect artifact
    (not just paraphrased)

[ ] Anti-scope clauses from upstream are PRESERVED in routing
    (not silently dropped)
```

Time cost: ~5-10 minutes per routing artifact. The discipline is to actually do it, not to skip when it "looks fine."

## Why it works

The routing layer is uniquely vulnerable to "things you remembered wrong." Architect specs get re-read carefully because they're load-bearing. Implementation code gets reviewed because tests fail when it's wrong. Routing artifacts often pass through with one human read because they look like simple coordination.

But routing errors propagate the most. A wrong filename in routing = implementer reads the wrong file = wrong work shipped. A stale config version in routing = wrong canonical referenced = downstream confusion.

Memory is the failure surface. Mechanical verification removes the memory dependency.

## Worked example

[From DeploySignal coordination/TPM-DISPOSITION-REVIEWER-09.md, 2026-04-29]

TPM had directed reviewer to verify per-cell stamping on `v5-sequential-e-process.json`. That config was the pre-Phase-2 baseline. Post-Phase-2 canonical was already `v5.7-q2b63.json`. Reviewer correctly escalated.

Root cause: TPM cited the config name from memory of prior routing pasteables, not from the live canonical-versions block. Memory was 2 versions stale.

Fix: this discipline (pre-route checklist) was memorialized as `feedback_tpm_routing_canonical_version_drift.md`. Future routing pasteables verify canonical-version labels live before emitting.

Forward catch: in the months following, multiple routing artifacts had stale-version drift caught at T1 (TPM grilling) before forwarding. Each catch prevented a downstream rework cycle.

## How to make it cheap

The checklist looks like overhead. To make it sustainable:

1. **Build a verification script.** A 10-line shell script that takes a routing artifact draft and outputs:
   - Filenames mentioned that DON'T exist
   - Version labels mentioned that don't match canonical
   - Line numbers cited that don't exist (or point to wrong content)

   Even a partial automation reduces the manual checklist to "review the script's flags."

2. **Verify-as-you-write.** Apply the checklist incrementally as you draft routing, not as a final pass. Each citation is verified at write-time. Removes the "review pass" overhead.

3. **Build a canonical-versions doc** at a known location, kept current by every commit that changes versions. The checklist becomes "open this doc, verify cited versions match." Removes the memory dependency entirely.

## Memorial-accretion connection

When the pre-route checklist catches an issue class repeatedly (e.g., test counts cited but stale), elevate the specific class to a Memorial F sub-rule and add a verification-script check for it. The checklist itself evolves through Memorial accretion.

## What this skill is NOT

This is not a substitute for adversarial pre-emit grilling ([`01-pre-emit-grilling.md`](./01-pre-emit-grilling.md)). The pre-route checklist catches mechanical errors (wrong filename, stale version). Pre-emit grilling catches structural errors (gap in spec interpretation, contradictory routing decision). Both are needed; they catch different classes of failure.

## Cost

5-10 minutes per routing artifact emit. Recovers cost on the first prevented stale-reference issue (which would otherwise cost the implementer 30-60 minutes to debug + rework).

## Compatibility

This skill is most relevant when there's an explicit routing layer (TPM role). For agent orchestration frameworks without an explicit routing role, the checklist applies to the coordinator agent's outputs (CrewAI's manager agent, LangGraph's supervisor node, etc.).

For solo work, the checklist applies to the boundary between "I designed this" and "I'm now going to implement this" — verify the design's references before starting implementation.

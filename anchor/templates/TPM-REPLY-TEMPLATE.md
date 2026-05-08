# TPM-REPLY-NN — [Routing Topic]

_From: TPM. To: Implementer (specify session if parallel) OR Architect / Reviewer / PM (per cycle)._
_Date: [YYYY-MM-DD]._
_Foundation: [Architect spec / Reviewer report / PM PRD this routes from] + [prior cycle artifacts]._
_Type: [routing pasteable | disposition | grilling output | reviewer-disposition | scope sweep]._

---

## Summary

[1-3 sentences. What is this routing artifact for? What downstream action does it enable?]

---

## Pre-route discipline check

Per [`skills/04-pre-route-checklist.md`](../skills/04-pre-route-checklist.md). Mechanical verification before forwarding.

- [x] All filenames cited are LIVE (verified via `ls` or by opening the file).
- [x] All version labels cited are CURRENT (verified against canonical version doc).
- [x] All line numbers cited are CURRENT (verified by opening the file at the cited line).
- [x] All test counts cited are CURRENT (verified by `wc -l` or equivalent).
- [x] All claims about another role's prior output are GREP-VERIFIED in the actual artifact.
- [x] All upstream architect / PM / reviewer decisions cited are LINKED to the source artifact.
- [x] Anti-scope clauses from upstream are PRESERVED in this routing.

If any item is not checked, do not emit. Fix first.

---

## TPM grilling pass output

Per [`skills/01-pre-emit-grilling.md`](../skills/01-pre-emit-grilling.md) three-bucket classification of this routing artifact.

### CRITICAL: [N]

[Items requiring upstream amendment BEFORE forwarding. Examples: spec contains undefined term; routing references stale version; architecture decision contradicted by another committed decision.]

- **C1:** [Description; what needs to change upstream; route back to which role.]

### LIKELY-SURFACES: [N]

[Items Implementer (or downstream consumer) will likely surface at consumption time. Pre-flag here so they're not surprised.]

- **L1:** [Description; pre-flag note in routing.]

### PRE-EMPTABLE: [N]

[Items folded into this routing as anti-scope / open-question / TPM correction.]

- **P1:** [Description; folded as: anti-scope / open-Q / correction.]

---

## Routing scope (the actual pasteable for downstream)

[The block downstream role will execute against. Quote-bordered for clarity if forwarded as-is.]

```
[Role: e.g., Implementer | Architect | Reviewer | PM]

Scope:
  [Specific scope description; ties to upstream artifact §section]

Foundation:
  [Source artifacts; what to read first]

Verify:
  [Specific verification steps the downstream role must execute]

Halt conditions:
  [When the downstream role should stop and route back]

Anti-scope (preserved from upstream):
  - [Anti-scope item 1]
  - [Anti-scope item 2]

Acceptance:
  [What "done" looks like for this routing]

Effort target:
  [Time estimate]

Cross-cutting verification:
  [Project-wide invariants that must remain true]

Deliverable:
  [Specific output expected; file path / format / handback path]
```

---

## Sequencing / track context

[Where this routing fits in the project's coordination cycle. Cross-track dependencies that affect timing.]

- **Upstream (must complete first):** [list]
- **Downstream (depend on this):** [list]
- **Parallel tracks operating concurrently:** [list]

If running parallel Implementer sessions, specify worktree isolation per [`skills/07-round-numbering-convention.md`](../skills/07-round-numbering-convention.md).

---

## Memorial state at this routing

[If project uses Memorial-accretion discipline per [`skills/02-memorial-accretion.md`](../skills/02-memorial-accretion.md). Snapshot of relevant Memorials at routing-emit time.]

- [Memorial 1]: [violations/confirmations count] at [last update event].
- [Memorial 2]: [...].

---

## Open coordination items

[Items requiring John's / human's attention OR cross-chat coordination beyond this routing's scope.]

- **For Architect:** [item, if any]
- **For Reviewer:** [item, if any]
- **For PM:** [item, if any]
- **For human operator:** [item, if any]

---

_Routing artifact per [`skills/03-four-anchor-defense.md`](../skills/03-four-anchor-defense.md) (T1 anchor) + [`skills/04-pre-route-checklist.md`](../skills/04-pre-route-checklist.md) + [`skills/01-pre-emit-grilling.md`](../skills/01-pre-emit-grilling.md). Replace placeholders with cycle-specific content._

# Skill: Anti-Scope Ledger

**Trigger:** Drafting any spec or routing artifact with non-trivial scope.
**Application moment:** At spec-emit time (T0) and reaffirmed at routing-emit time (T1).
**Owner:** Architect (drafter); TPM (preserver in routing); Implementer (halt-trigger).

## What it is

Each spec carries an explicit, named, structurally-separated section listing what is **not** in scope for the current work. Items in the anti-scope are not vague aspirations — they are specific, often tempting-looking adjacent work that would seem natural to include but has been deliberately excluded.

When implementation work drifts toward an anti-scope item, the implementer halts and routes back rather than absorbing the drift silently.

The pattern's defensive value is at the boundary, not at the center. Most implementers will not deliberately scope-creep on Day 1 of a spec. They will absorb scope in small increments while solving adjacent problems. Anti-scope clauses make the boundary explicit so the absorption gets noticed.

## Why it works

Scope creep is the largest hidden cost in agent-driven implementation work. Three mechanisms produce it:

1. **Adjacent-problem visibility.** While building feature X, the implementer notices feature Y nearby and "fixes it while I'm here." This is well-intentioned but compounds.
2. **Spec ambiguity-resolution-by-expansion.** When a spec is unclear, agents tend to resolve ambiguity by doing more rather than less ("better safe than sorry"). Without anti-scope, the natural ambiguity resolution is inflation.
3. **Compound-cycle drift.** Each cycle absorbs a little extra scope; cumulative drift across N cycles can double the actual delivered surface vs the planned surface.

Anti-scope clauses interrupt all three mechanisms. (1) is interrupted because adjacent problems get explicitly named as out-of-scope. (2) is interrupted because the default ambiguity resolution becomes "halt and clarify" instead of "expand." (3) is interrupted because compound drift requires repeated silent absorption; if each cycle's anti-scope is preserved, compounds get visible.

## How to apply

### Anti-scope clause structure

Each spec gets an `## Anti-Scope` (or equivalent named) section with explicit clauses. Each clause:

```markdown
- **A1:** [Specific item that would seem natural to include]. Rationale:
  [why excluded — often "different work cycle" or "depends on
  upstream commitment N"].

- **A2:** [Specific item, often a refactor or improvement adjacent to
  the work]. Rationale: [why excluded].

- **A3:** [Specific item]. Rationale: [...].
```

The anti-scope is NOT exhaustive — you can't enumerate everything you're not doing. It's targeted at the most likely absorption candidates: adjacent improvements, "while I'm here" refactors, scope drift from prior cycles.

### Halt-and-route-back protocol

When the implementer encounters work that touches an anti-scope item:

1. **Halt implementation** at a clean boundary (commit current state if useful).
2. **Document the encounter** in a short routing artifact: "Spec Q-NN anti-scope A2 says X; encountered Y in implementation; need disposition."
3. **Route back to architect or TPM** for disposition. Three possible outcomes:
   - **Confirm anti-scope** — implementer continues without absorbing the work; the encountered item is logged for future cycle.
   - **Amend spec** — architect adds the work to the current cycle scope (with corresponding effort estimate update).
   - **Defer with explicit ticket** — architect creates a follow-up spec; current cycle proceeds.

The protocol is deliberately mechanical. The implementer's job is to detect the encounter, not to decide the disposition. Disposition is the architect's job.

### Preservation across roles

Anti-scope clauses must propagate through the role pipeline. Architect's anti-scope in the spec → TPM's routing pasteable preserves the anti-scope verbatim → Implementer reads anti-scope before starting work → Reviewer audits that no anti-scope items shipped.

If TPM's routing drops an anti-scope clause, the discipline collapses — the implementer wasn't told. Pre-route checklist (see [`04-pre-route-checklist.md`](./04-pre-route-checklist.md)) includes "anti-scope clauses preserved" as a verification item.

## Worked example

[From DeploySignal coordination/Q57-DEMO-BASELINE-REFRESH-SPEC.md, 2026-04-29]

Q57 spec scope: refresh the demo baseline configs after Phase-2 calibration changes. Architect explicitly added anti-scope:

```
## Anti-Scope

- A1: α-bookkeeping changes. The demo baseline refresh does not modify
  α attribution or per-cell α-attribution stamping. Topic 57 is anti-
  scope on α-bookkeeping. Reason: per-detector iid_bootstrap pool
  (other Phase-3 commitment) DOES touch resampler-side α-attribution;
  if both shipped same cycle, blast radius of any α-bookkeeping
  regression doubles.

- A2: Family C/E quality-signal extension. Demo baseline refresh
  uses currently-shipped Family C/E signal vector. Quality-signal
  extension to (eval_score, refusal_rate, tool_success_rate) is
  documented Phase-3 commitment, separate cycle.

- A3: Memorial F sub-rule additions. If new sub-rules surface during
  Q57 implementation, log and route to architect; do not add to
  Memorial F file inside Q57 scope.
```

During Q57 implementation, the implementer encountered a per-cell α-attribution issue (would have absorbed into Q57 work without anti-scope). Halted; routed back to architect. Architect confirmed anti-scope (A1); the issue was deferred to Q60 (per-detector iid_bootstrap pool) where α-bookkeeping is in-scope. Q57 shipped clean.

Without the anti-scope clause, the implementer would have absorbed the α-attribution fix into Q57. Both Q57 and Q60 would have touched α-bookkeeping in the same window. Any regression would have been ambiguously attributed; rollback would have been more expensive.

## Common pitfalls

- **Anti-scope as boilerplate.** Generic anti-scope clauses ("we're not refactoring everything") provide no defensive value. Each clause must name a specific tempting absorption candidate.
- **Anti-scope dropped in routing.** TPM forwards spec to implementer but omits the anti-scope section "to keep the pasteable focused." This breaks the discipline. The pasteable is exactly where the anti-scope is most needed.
- **Implementer absorbing without halt.** The implementer must trust that halting is correct behavior, not "blocking on the architect." Cultural reinforcement matters: halt-and-route-back is praised, silent absorption is corrected.
- **Architect treating route-back as failure.** Route-backs are evidence the discipline is working. If architect responses signal frustration with route-backs, the discipline collapses within 2-3 cycles.

## What this skill is NOT

This is not "scope discipline" generically. Many specs include "scope" sections that describe what IS in scope. Anti-scope is the COMPLEMENTARY discipline — explicit naming of what is NOT in scope, with halt-trigger semantics for when adjacent work appears.

Both in-scope and anti-scope serve different purposes; both are useful; this skill is specifically about the latter.

## Cost

10-15 minutes per spec to draft the anti-scope clauses well. ~5 minutes per implementer-encountered anti-scope event (halt + route-back). The discipline pays for itself on the first prevented compound-cycle drift.

## Compatibility

Works with any spec format — Markdown specs, JSON ADRs, RFC docs, etc. The anti-scope section just needs to be structurally separable so it can be preserved in routing artifacts.

In agent orchestration frameworks: anti-scope clauses can be encoded as evaluator predicates (does the diff touch any anti-scope file/function?). Automated detection complements human discipline.

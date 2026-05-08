# Reviewer Role Brief

_Document-shaped role description. Added 2026-04-17. Edited in place as the role evolves._
_Decision authority: the operator. Operationalization: TPM. Architect informed via `coordination/TPM-REPLY-05.md`._

## Why this role exists

DeploySignal runs a three-role split — architect, TPM, Claude Code (implementer). Mac Claude Code writes both implementation code AND tests. That creates a self-testing bias: if Claude Code's mental model of the spec has a gap, both the implementation and the tests it writes can carry the same gap.

The Reviewer is a lightweight independent check against that bias. Not a full QA engineer; not architecturally load-bearing; not involved in daily execution. A once-per-week spec-vs-implementation audit that catches the 80% of self-testing-bias risk at 10% of the coordination cost of a full QA role.

## What the Reviewer owns

**Weekly spec-vs-implementation audit.** Reads the completed week's PR on `ns-runway` plus the week's handoff brief plus relevant architect spec sections. Produces a short written review:

- **Spec drift:** places where the implementation diverges from what the handoff brief or architect spec actually says.
- **Test coverage gaps:** cases the implementation handles but no test covers; cases the tests cover but the spec doesn't require.
- **Self-testing blind spots:** places where the test was clearly derived from the implementation (rather than the spec), so any drift is invisible to the test.
- **Edge cases:** boundary conditions, rare inputs, failure modes the tests don't exercise.
- **Architectural inconsistency:** places where the code is correct in isolation but interacts badly with a contract surface elsewhere (flagged for TPM to route to architect if needed).

**Output:** `coordination/REVIEWER-REPORT-WK##.md` at end of each week. Round-shaped — timestamped, never edited post-ship. One file per week.

## What the Reviewer does NOT own

- Writing or modifying any engine code.
- Writing or modifying any tests.
- `STATUS.md`, `PLAN.md`, the project schedule (deleted) maintenance.
- Weekly handoff briefs to Claude Code.
- Architecture decisions or changes to contract surfaces.
- Sprint-level scope calls (expand/contract a week's goal).
- Pushing to origin or merging to main.

If Reviewer thinks something should change in any of those, they flag it in their report and route it to TPM. TPM triages: route architecture issues to architect, sprint issues to Claude Code via next week's brief, STATUS updates to TPM-owned docs.

## Cadence

Once per week, end-of-week:

1. **Claude Code finishes the week's PR** on `ns-runway` (target: end-of-day Thursday under compression).
2. **TPM pings Reviewer** late Thursday or Friday morning with: PR link, week's handoff brief path, spec sections to focus on, any specific concerns from Claude Code's own handoff-back summary.
3. **Reviewer produces `REVIEWER-REPORT-WK##.md`** within ~24 hours (target: Friday end-of-day).
4. **TPM triages findings** into next week's brief (if actionable) or routes to architect (if architectural) before the next week's kickoff.

Next week's Claude Code kickoff happens **whether or not** Reviewer has landed the report — Reviewer is advisory, not gating. Non-urgent findings absorb into next-plus-one week's brief instead of blocking.

## Interface with other roles

- **← TPM:** Reviewer receives the weekly PR ping + context. TPM is the single routing layer.
- **→ TPM:** Reviewer's report goes to TPM. TPM is the integration layer.
- **Does not talk directly to Architect or Claude Code.** All findings route via TPM.
- **If Reviewer needs clarification on architect spec:** flag in the report; TPM routes to architect if architect's spec is genuinely unclear rather than Reviewer-misreading.

## What Reviewer needs each week

When TPM pings, Reviewer gets:

- PR link on `ns-runway` (commits + diff).
- Path to the week's handoff brief (`coordination/handoffs/WEEK##-HANDOFF.md`).
- Relevant architect spec: specific sections of `NORTH-STAR-ARCHITECTURE.md`, the project roadmap (deleted), and any standing docs like `audit/SCHEMA.md`.
- Claude Code's self-reported subtask-completion summary (from PR description).
- TPM's current understanding of any open questions or known risks.

## What the Reviewer report should contain

Suggested structure:

```
# Reviewer Report — Week N

## Summary
One-paragraph overall take: was the week's work spec-compliant and adequately tested?

## Spec-vs-implementation findings
Per subtask or per deliverable: flag drift, missing behaviors, behaviors not in spec.

## Test coverage findings
Gaps, blind spots, edge cases not exercised. Distinguish "tests are derivative of the code" from "tests validate the spec."

## Architectural cross-surface issues
Places where correct-in-isolation may be wrong-in-integration.

## Severity triage
Critical (next-week blocker), substantial (should land in next brief), minor (can queue), nitpick (optional).

## Recommendations
What should TPM do with these findings. Short list.
```

Keep reports under 1500 words. Reviewer is a triage layer, not an audit firm.

## Standing guardrails

- **Read-only role.** Reviewer never commits code, tests, or documentation changes to the repo. All output is the weekly report.
- **Non-blocking.** Next week's execution starts before the report lands if Reviewer is slow. Reviewer is advisory, not a gate.
- **Scope discipline.** If a finding is out-of-scope for the project (for follow-on territory, architect-deferred items), note it and move on. Don't rescope the project from the review seat.
- **Report signing.** Each `REVIEWER-REPORT-WK##.md` has a dated signature line at the top: "_Reviewer — YYYY-MM-DD_". Treats reports as round-shaped correspondence.

## Role-split quick reference (four roles as of 2026-04-17)

| Role | Session | Owns | Does not own |
|---|---|---|---|
| Architect | Separate Cowork chat | `NORTH-STAR-ARCHITECTURE.md`, the project roadmap (deleted), the pitch draft (deleted), `DETECTOR-MATH-RESEARCH.md`, design decisions, contract surfaces | STATUS / PLAN / handoffs, engine code, tests, reviewer reports |
| TPM | Laptop Cowork chat | `STATUS.md`, `PLAN.md`, the project schedule (deleted), `COORDINATION-INDEX.md`, weekly handoffs, reconciliation, conflict surfacing, reviewer routing | Engine code, tests, architecture decisions, reviewer reports |
| Implementer (Claude Code) | Mac CLI | All engine code, tests, build artifacts on `ns-runway` | Docs at repo root, architecture decisions, reviewer reports |
| Reviewer | Separate Cowork chat (NEW 2026-04-17) | `coordination/REVIEWER-REPORT-WK##.md` | Any code/test/doc modification; all routing via TPM |

## First instance

Week 2 ends EOD Thu 2026-04-23 (compressed from original Wed 2026-04-29). First Reviewer report target: `coordination/REVIEWER-REPORT-WK02.md` delivered Fri 2026-04-24.

Week 1 is retroactively skipped — the review would be academic at this point (landed 120/120 keystone, under budget, no meaningful feedback window remains).

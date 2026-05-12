# PRD-NN: [Feature or Project Name]

_Owner: [Product Manager — agent or human identifier]._
_Drafted: [YYYY-MM-DD]. Last updated: [YYYY-MM-DD]._
_Status: [draft | active | shipped | retired]._

---

## Goal

[One paragraph. What user need does this address? Who is the user? What does success look like from the user's perspective? Avoid technical detail; this section is in the user's frame, not the implementer's.]

**Bad:** "Build a Kafka-backed event pipeline that processes user actions in real time."
**Good:** "Power users currently lose track of what happened in their account because activity is scattered across multiple screens. They need a single timeline showing what they did, when, and what changed — refreshing in near real time so they can respond to issues before they compound."

---

## Target user / personas

[Who is this for? List the personas with enough specificity that the Architect and Reviewer can answer "is this design good for THIS user?" Specifically NOT "all users" — that always means "the user the author imagined."]

- **[Persona 1]:** [Description; what they care about; what they currently do without this feature]
- **[Persona 2]:** [Description]

---

## User stories

[Concrete user stories in standard form. Each story should be specific enough that someone could imagine the screen / API call / interaction.]

- **US-1:** As a [persona], I want [capability], so that [benefit].
- **US-2:** As a [persona], I want [capability], so that [benefit].
- **US-3:** As a [persona], I want [capability], so that [benefit].

---

## Functional requirements

[What the system must DO. Specific, testable, traceable from user stories.]

- **FR-1:** [Requirement statement, traces to US-N]
- **FR-2:** [Requirement statement, traces to US-N]
- **FR-3:** [Requirement statement, traces to US-N]

---

## Non-functional requirements

[Constraints on HOW the system behaves: performance, security, accessibility, compliance, scale. These often surface in the Architect's spec but should originate in the PRD.]

- **NFR-1 (performance):** [e.g., "P95 response time under 200ms for the timeline endpoint at 10K concurrent users"]
- **NFR-2 (security):** [e.g., "Activity log entries are never visible to users outside the originating account"]
- **NFR-3 (accessibility):** [e.g., "Timeline UI passes WCAG 2.1 AA; screen-reader-navigable"]

---

## Acceptance criteria

[The testable list a Reviewer can check against. Each criterion is binary (met / not met). Vague criteria become future arguments.]

- [ ] **AC-1:** [Specific, testable statement, traces to FR-N or NFR-N]
- [ ] **AC-2:** [Specific, testable statement]
- [ ] **AC-3:** [Specific, testable statement]
- [ ] **AC-4:** [Specific, testable statement]

**Bad:** "The system should be fast and reliable."
**Good:** "The timeline endpoint returns within 200ms (P95) for the test workload defined in `runs/load-test-baseline.json`. Reliability target: <0.1% 5xx error rate over a rolling 24-hour window measured at the load balancer."

---

## Out-of-scope

[Explicit anti-scope. Specifically NOT covered by this PRD; reasoning for each. Prevents scope absorption during implementation. See `skills/06-anti-scope-ledger.md` for application detail.]

- **AS-1: [Tempting absorption candidate].** Reason: [why excluded — often "different PRD" or "depends on upstream commitment"].
- **AS-2: [Specific item].** Reason: [...].
- **AS-3: [Specific item].** Reason: [...].

---

## Priority

[Relative to other PRDs in the project. MoSCoW classification or equivalent. The PM's job is to ADJUDICATE priority, not just declare everything must-have.]

- **Must-have:** [Items without which the feature doesn't ship]
- **Should-have:** [Items that meaningfully improve the feature but are not gating]
- **Could-have:** [Items that are nice to have if time permits]
- **Won't-have (this cycle):** [Items explicitly deferred to a future PRD]

---

## Success metrics

[How we know the feature succeeded post-ship. Specific, measurable, time-bounded. NOT engineering metrics (test pass rate, lines of code) — user-outcome metrics.]

- **SM-1:** [e.g., "60% of weekly active users open the timeline at least once within 14 days of feature launch"]
- **SM-2:** [e.g., "Account-related support tickets decline by 25% within 30 days post-launch"]
- **SM-3:** [e.g., "Median time-to-resolve for activity-related questions drops from 8 minutes to under 2 minutes"]

---

## Dependencies

[Other work this PRD depends on or interacts with. Surface so the TPM can sequence correctly.]

- **Upstream (must land before this):** [list]
- **Downstream (depend on this):** [list]
- **Parallel (touch related surface; coordination needed):** [list]

---

## Open questions

[Known unknowns at PRD-draft time. Tracked here so they're visible until resolved; resolved questions move to the relevant section above.]

- **OQ-1:** [Question; who owns answering; when resolution is needed]
- **OQ-2:** [Question]

---

## Update history

- **[YYYY-MM-DD]:** Initial draft.
- **[YYYY-MM-DD]:** [Material change — added FR-N / removed AS-N / shifted priority on AC-N — with reason]

---

## Notes for the PM

- **Trace every acceptance criterion to a functional or non-functional requirement.** Every AC should have a clear FR-N or NFR-N reference. Untraceable ACs are signs of scope creep or unclear requirements.
- **Trace every functional requirement to a user story.** Every FR should answer a user need. Untraceable FRs are signs the PRD is solving an engineering problem rather than a user problem.
- **The Out-of-Scope section is load-bearing.** Specific named items prevent absorption during implementation. Generic anti-scope ("we're not building everything") provides no defensive value.
- **Priority is the most-edited section over the PRD's lifetime.** Update it explicitly when adjudicating; record rationale in update history. Drift here is a signal worth investigating.
- **Success metrics belong in the PRD, not the spec or the launch checklist.** A feature that doesn't have measurable user-outcome success metrics in the PRD is unlikely to be evaluated against real success criteria post-ship.
- **Grep-verify every codebase reference before launching a round.** Any specific schema field, function name, file path, or environment variable named in scope blocks (e.g., "the `project.completedAt` field," "extend `lookupQuoteLink`") must be confirmed present in the current codebase via `grep` or equivalent before the round starts. A reference assumed from memory or from a prior version of the schema forces a downstream halt that the role-pipeline catches but the operator could have prevented in 30 seconds. The same static-analysis rule applied to the Implementer's "apply to all" prescriptions applies upstream to the PM's "the system has X" claims.

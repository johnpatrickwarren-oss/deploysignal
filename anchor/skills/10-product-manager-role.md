# Skill: Product Manager Role

**Trigger:** Project has non-trivial scope where "what to build and why" is not yet decisively answered.
**Application moment:** At project kickoff, before any architectural specs are drafted. Re-applied at scope revisions.
**Owner:** Product Manager (PM) — can be a dedicated agent or the human operator.

## What it is

The Product Manager role owns **what gets built and why**, separately from how it gets built (Architect), how the build is coordinated (TPM), or whether the build matches spec (Reviewer). PM is the role that converts vision and user need into prioritized, traceable requirements that downstream roles can act on.

PM is the upstream-most role in the framework. Other roles depend on PM outputs as their input contract: the Architect drafts specs against requirements; the TPM sequences work against priorities; the Reviewer audits implementation against acceptance criteria.

## Why include it as a separate role

In a single-agent or human-only project, the "what to build" question is implicit. The same person who imagines the feature also designs and builds it, so requirements never need to be written down — they live in the head of the builder.

In a multi-role project, this collapses. If Architect drafts specs without explicit requirements, the specs are designed against the architect's interpretation of vague vision. If TPM routes work without priorities, the routing is informed by the TPM's guess at what matters. If Reviewer audits implementation without acceptance criteria, the audit becomes "does it work" rather than "does it satisfy the user need."

The PM role makes the "what to build" content explicit, named, and durable. Every downstream role has a clear contract to work against.

## When this role is mandatory vs optional

**Mandatory:**
- Non-technical operator with vision but no specification skill (the "I have an idea but don't know how to build it" persona)
- Multi-stakeholder projects where requirements come from multiple sources and need consolidation
- Projects with formal acceptance criteria, regulatory or compliance requirements, or contractual deliverables
- Projects expecting handoff between teams or future maintainers who weren't in the original conversations

**Optional:**
- Solo technical founders building for themselves (vision lives in their head; explicit PM artifacts are overhead)
- Projects with stable, well-known specifications where requirements rarely change
- Quick prototypes and throwaway code

**Optional-but-recommended:**
- Multi-role projects where the human prefers to delegate "what to build" to focus on strategy, business, or other high-level concerns
- Projects with accumulating scope drift (PM artifacts surface drift early)

## How to apply

### Step 1 — Establish the PRD as the contract artifact

Each project (or each major feature) gets a Product Requirements Document at a known location (e.g., `coordination/PRD-NN.md`). Required sections:

- **Goal** — one paragraph in the user's frame: what user need does this address?
- **Target user / personas** — concrete personas, not "all users"
- **User stories** — concrete stories in standard "As a [persona], I want [capability], so that [benefit]" form
- **Functional requirements** — what the system must DO, traced from user stories
- **Non-functional requirements** — performance, security, accessibility, compliance, scale
- **Acceptance criteria** — testable, binary (met / not met) statements traced from requirements
- **Out-of-scope** — explicit anti-scope with reasoning per item
- **Priority** — MoSCoW classification (must-have / should-have / could-have / won't-have)
- **Success metrics** — measurable user-outcome metrics, NOT engineering metrics
- **Dependencies** — upstream / downstream / parallel work
- **Open questions** — known unknowns
- **Update history**

A fillable PRD scaffold with section guidance, examples (good vs bad acceptance criteria, etc.), and tracing notes is at [`templates/PRD-TEMPLATE.md`](../templates/PRD-TEMPLATE.md). Copy and fill rather than redrafting from scratch.

The PRD is the input contract for the Architect. The Architect's spec must trace each acceptance criterion to a design decision; gaps mean the spec is incomplete or the PRD is unclear.

### Step 2 — Translate vague vision into concrete requirements

When the human operator says *"I want an app that helps me track expenses"*, that is a vision, not requirements. The PM's job is to convert it into:

- Specific user stories (single-user vs multi-user? mobile vs web? offline-capable?)
- Acceptance criteria (must categorize automatically? must support receipts? must integrate with which banks?)
- Out-of-scope (NOT a budgeting tool, NOT a tax filing tool, NOT a financial planning tool — flag drift candidates)
- Priorities (categorization first, receipts second, bank integration third)
- Success metrics (user adds 30 transactions in first week? user retention at 30 days?)

A PM agent can run a structured intake conversation with the human operator to extract this content. A human PM does the same thing in their head. Either way, the result is a PRD.

### Step 3 — Maintain priority discipline as scope evolves

PRDs are not write-once. As implementation progresses, new requirements surface, edge cases emerge, and original priorities need adjustment. The PM owns:

- Adding new requirements with explicit priority ranking
- Demoting or removing requirements that are no longer load-bearing
- Adjudicating when an Architect or Implementer surfaces a "should we do X?" question that isn't in the current PRD

The PM's discipline analog of the Anti-Scope Ledger ([`06-anti-scope-ledger.md`](./06-anti-scope-ledger.md)) is **priority drift detection**. When the actual ranking of work-being-done diverges from the PRD's documented priority, that's a signal worth investigating.

### Step 4 — Provide acceptance criteria to the Reviewer

The Reviewer's audit is most powerful when it has explicit acceptance criteria from the PM. Without them, "does this implementation satisfy the requirements" is a judgment call. With them, it's a checklist.

PM's outputs feed Reviewer's inputs directly. The handoff is bilateral: when Reviewer finds something the PRD didn't cover, that's signal to PM that the PRD needs an amendment.

### Step 5 — When the human is PM, make it explicit anyway

If the project's configuration is "human plays PM, no PM agent," that's a valid configuration — but the PRD discipline still applies. The human writes the PRD (or has an agent help write it from a structured intake). The PRD lives in the same `coordination/PRD-NN.md` location. Other roles still consume it as their input contract.

The discipline is the artifact, not the agent. A human PM is fully supported; an agent PM is fully supported; the framework is identical.

## Worked example

[From DeploySignal's actual configuration]

In the DeploySignal project, the human operator played PM. Vision was set by the human ("a deployment safety system for AI inference workloads, demonstrable on a laptop, designed against specific AI-inference-specific failure modes"). Priorities flowed from the human's strategic judgment about what would be most credible to readers of the artifact.

External PM critique was solicited mid-project (`PM-CRITIQUE-RESPONSE.md` in the coordination folder), which functioned as a one-time PM-quality audit by an outside perspective. The 19 questions raised by that critique drove substantial scope adjustments across W2-W6.

The PRD analog in DeploySignal was distributed across `NORTH-STAR-ARCHITECTURE.md` (vision + technical north star) and `ROADMAP-6-WEEK.md` (sprint-level priority). These are not strictly PRDs by the template above — they conflate PM and Architect concerns. A cleaner separation would have factored out a single `PRD-DEPLOYSIGNAL.md` with user stories, acceptance criteria, and priorities, leaving NORTH-STAR purely architectural.

This is the kind of structural critique that emerges only after a project ships: the lack of a separated PM role made the "is this what the user actually needed?" question harder to answer cleanly. For projects where the human is not playing PM, separating the concern from the start prevents this failure mode.

## Common pitfalls

- **Architect absorbing PM work.** Architect drafts specs that include implicit requirements ("the system should be fast" without saying how fast for whom). This is the most common failure when PM role isn't separated. Catch it by requiring every spec to cite a specific PRD acceptance criterion.
- **PM as scope-creep amplifier.** PM agents that add new requirements without removing old ones produce ever-growing PRDs that the implementer can't satisfy. Pair PM with Anti-Scope Ledger discipline; treat priority demotion as first-class as priority addition.
- **PM substituted for user research.** PM defines requirements based on what the user said they want, not always what they actually need. For projects with real users, PM should be informed by user research; PM is not a substitute for talking to users.
- **PM role assigned to architect agent.** A common shortcut is to give the architect agent both PM and architect responsibilities. This collapses the role separation and reintroduces the failure mode this skill exists to prevent. Resist.
- **PRD as marketing copy.** PRDs that describe features in promotional language ("a delightful experience for power users") rather than testable acceptance criteria ("the user can complete a transaction in under 3 clicks from any screen") fail their downstream consumers. Use specific, measurable language.

## Cost

PRD drafting: ~30-60 minutes per non-trivial feature, or longer for complex multi-stakeholder requirements.

PRD maintenance: ~10-15 minutes per scope-evolution event.

Recovers cost on the first prevented "we built the wrong thing" rework, which is typically 2-10× the PRD's drafting cost.

## Compatibility

This role works with any agent orchestration framework. PM-as-agent fits naturally into CrewAI's role-based teams, LangGraph's directed graph nodes (PM as the entry point), Superpowers's multi-agent workflow (PM upstream of architect), or as a Cowork chat in a Claude-Cowork project.

PM-as-human is fully supported. The framework imposes no requirement that PM be an agent; the PRD artifact is what matters.

## Memorial-accretion connection

When a project ships and discovers it built the wrong thing (or partially-wrong thing), conduct a PM-side post-mortem. The findings often surface as new acceptance-criterion patterns ("always include a target latency, not just 'should be fast'") or new priority-translation patterns. Memorialize as PM-discipline updates; the role gets sharper across projects.

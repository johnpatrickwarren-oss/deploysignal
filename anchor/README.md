# anchor

**A multi-role agent orchestration discipline for high-stakes software builds, distilled from running a 14-week production-grade reference implementation as a 4-role multi-agent project.**

The name comes from the **four-anchor pre-merge defense** — the structural backbone of this methodology. Each anchor is a discipline checkpoint; together they catch what single-pass review misses.

This is a methodology pack, not a framework. It is a set of explicit disciplines you (and your agents) apply at specific moments in a project — not a runtime, not a library, not a platform. It can be applied alongside [Superpowers](https://github.com/obra/superpowers), [CrewAI](https://github.com/crewaiinc/crewai), [LangGraph](https://github.com/langchain-ai/langgraph), [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), or any other agent runtime. It can also be applied with a single agent or no agents at all.

## What problem this solves

Single-agent code generation systems hallucinate, drift, and produce work that "passes the tests the same agent wrote" but fails in production. Multi-agent systems often add coordination overhead without proportional quality lift. Existing methodology frameworks (Superpowers, BMAD, Spec Kit) enforce phase gates and skill compliance but treat each project as starting from zero discipline.

This pack adds four disciplines those frameworks do not:

1. **Memorial accretion** — failure-driven discipline accumulation. Each violation of a discipline produces a memorialized record; each application produces a confirmation. Ratios drive prioritization. The pack itself gets smarter as it gets used.
2. **Pre-emit grilling** — adversarial review of artifacts BEFORE they are forwarded to the next role, separate from post-merge review. Catches structural issues at the source rather than at the audit.
3. **Audit-trail file discipline** — coordination as durable artifacts (one file per round, one file per disposition, one file per investigation) rather than ephemeral chat. The trail is the source of truth.
4. **Role anchoring across multiple chat instances** — canonical session-ID-to-role mapping, anti-drift rule prohibiting "THIS session = X" self-claims in shared documents, per-chat project instructions as absolute role-identity source. Prevents the most common failure mode of multi-chat AI coordination: chats confusing or overlapping their roles. Includes a fillable template for projects to drop into their coordination folder.

## Origin

Distilled from running [DeploySignal](https://github.com/johnpatrickwarren-oss/deploysignal) — a statistically-rigorous deployment safety system for AI inference workloads — as a 4-role multi-agent project. 250+ coordination files. ~94% autonomous agent execution. Multiple production-grade bugs caught that single-agent baselines plausibly miss at 60-90% per finding (independent post-build audit confirmed). The pack codifies the disciplines that did the work.

## Layout

```
anchor/
├── README.md                    # This file
├── METHODOLOGY.md               # Consolidated reference (start here for the full picture)
├── skills/                      # Individual disciplines, one per file
│   ├── 01-pre-emit-grilling.md
│   ├── 02-memorial-accretion.md
│   ├── 03-four-anchor-defense.md
│   ├── 04-pre-route-checklist.md
│   ├── 05-v-q-framework.md
│   ├── 06-anti-scope-ledger.md
│   ├── 07-round-numbering-convention.md
│   ├── 08-architect-six-practices.md
│   ├── 09-role-anchoring.md
│   └── 10-product-manager-role.md
├── templates/
│   ├── PROJECT-ROLES-TEMPLATE.md     # Canonical role-mapping (any project)
│   ├── PRD-TEMPLATE.md               # Product Requirements Document (PM)
│   ├── Q-NN-SPEC-TEMPLATE.md         # Spec drafting (Architect)
│   ├── TPM-REPLY-TEMPLATE.md         # Routing pasteable (TPM)
│   └── REVIEWER-REPORT-TEMPLATE.md   # Audit report (Reviewer)
└── case-studies/
    └── deploysignal-coordination-trail.md   # Real-world application + outcomes
```

The five roles: **Product Manager** (what to build), **Architect** (how to build it), **TPM** (when/how to coordinate), **Implementer** (one or many parallel instances; build it), **Reviewer** (audit it). PM and Implementer are the most variable — PM can be human or agent; Implementer can be one or many parallel sessions on isolated worktrees.

The four coordination-heavy roles (PM, Architect, TPM, Reviewer) each have a fillable scaffold under `templates/`. Each scaffold encodes the relevant disciplines (pre-emit grilling, anti-scope, P3 axes, severity triage, etc.) so the role's output is structured by construction rather than by remembering. Drop in, fill out, ship.

## How to use it

**For solo work with a single agent:** read `METHODOLOGY.md`, then apply the four-anchor pre-merge defense (skills/03) inside your existing workflow. Add memorial accretion (skills/02) when you notice a pattern of similar mistakes — that's the trigger to memorialize the discipline that would have prevented them.

**For multi-agent work with Claude Code, CrewAI, LangGraph, etc.:** read `METHODOLOGY.md`, structure your roles per the four-role framework, apply pre-emit grilling (skills/01) at every role-handoff boundary, use the V/Q framework (skills/05) to bound investigations.

**For multi-chat coordination (multiple Cowork chats / Claude Code sessions / CrewAI agent groups working on the same project):** drop the [`templates/PROJECT-ROLES-TEMPLATE.md`](./templates/PROJECT-ROLES-TEMPLATE.md) scaffold into your project's coordination folder, fill in the chat-to-role mapping, and apply the anti-drift discipline ([`skills/09-role-anchoring.md`](./skills/09-role-anchoring.md)) from project setup. This single discipline prevents the most expensive multi-chat failure mode (role drift) and is worth setting up at chat #2.

**For agent runtime authors (e.g., adding to Superpowers / similar):** the skills/ files are written in a format compatible with skill-pack frameworks. Each declares its trigger condition, its discipline content, and its application moment.

## Compatibility with Superpowers

This pack is positioned as **complementary** to Jesse Vincent's [Superpowers](https://github.com/obra/superpowers), not competitive. Superpowers provides excellent enforcement primitives (Cialdini-principle skill compliance) and a 7-stage workflow. This pack adds disciplines Superpowers does not currently emphasize: failure-driven memorial accretion, pre-emit grilling as a discipline separate from review, audit-trail file discipline, and a TPM-as-coordinator role.

A future release will package this pack as a Claude Code plugin that can be installed alongside Superpowers via the plugin marketplace.

## License

License intentionally not specified at this stage. Contact me (john.patrick.warren@gmail.com) for commercial or deployment use.

## Contact

John Warren · john.patrick.warren@gmail.com

Issues, contributions, and feedback are welcome via the GitHub repo. If you adopt this methodology in a different domain or platform, the most valuable contribution is a case study or postmortem from your context — case studies from outside the AI-inference-reliability domain that produced this pack are what tell us whether the disciplines generalize.

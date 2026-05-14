# anchor

**A multi-role agent orchestration discipline for high-stakes software builds, distilled from running a production-grade reference implementation as a 5-role multi-agent project.**

The name comes from the **four-anchor pre-merge defense** — the structural backbone of this methodology. Each anchor is a discipline checkpoint; together they catch what single-pass review misses.

This is a methodology pack, not a framework. It is a set of explicit disciplines you (and your agents) apply at specific moments in a project — not a runtime, not a library, not a platform. It can be applied alongside [Superpowers](https://github.com/obra/superpowers), [CrewAI](https://github.com/crewaiinc/crewai), [LangGraph](https://github.com/langchain-ai/langgraph), [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), or any other agent runtime. It can also be applied with a single agent or no agents at all.

## Quick start

Two minutes of setup, then write a PRD and run a round. Full setup details
in the [integration README](integrations/superpowers-claude-code/README.md).

**Prerequisites:**
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) — `npm install -g @anthropic-ai/claude-code` then `claude login`
- [Superpowers](https://github.com/obra/superpowers) — `claude mcp add superpowers` (Anchor inlines Superpowers' phase disciplines, so this is recommended but not strictly required for the headless pipeline)
- [GitHub CLI](https://cli.github.com/) — optional, for `new-project.sh` to auto-create a private repo

```bash
# 1. Clone anchor and put the pipeline scripts on your PATH (via symlinks
#    so that `git pull` in ~/anchor auto-updates the scripts you run).
git clone https://github.com/johnpatrickwarren-oss/anchor.git ~/anchor
mkdir -p ~/anchor-pipeline
ln -sf ~/anchor/integrations/superpowers-claude-code/{CLAUDE.md.template,new-project.sh,run-pipeline.sh,finalize-round.sh,anchor-update-project.sh} ~/anchor-pipeline/
echo 'export PATH="$HOME/anchor-pipeline:$PATH"' >> ~/.zshrc && source ~/.zshrc

# 2. Scaffold a new project (creates directory structure + optional private GitHub repo)
new-project.sh my-project-name
cd my-project-name

# 3. Write your PRD — the only artifact you author by hand
$EDITOR coordination/PRD.md

# 4. Run the first round
./run-pipeline.sh --round R01
```

The pipeline runs four roles (Architect → Implementer → Reviewer → Memorial-Updater)
against your PRD and pauses only on genuine decisions. For smaller rounds you can
skip layers with the tier dial:

```bash
./run-pipeline.sh --round R02 --tier audit   # skip Architect — Implementer self-specs
./run-pipeline.sh --round R03 --tier solo    # solo Implementer for mechanical work
```

See the tier-selection rubric (decision tree + worked examples) in
[`skills/11-round-scaling.md`](skills/11-round-scaling.md)
for when each tier fits. **When in doubt, pick `full` (the default).**

## What problem this solves

Single-agent code generation systems hallucinate, drift, and produce work that "passes the tests the same agent wrote" but fails in production. Multi-agent systems often add coordination overhead without proportional quality lift. Existing methodology frameworks (Superpowers, BMAD, Spec Kit) enforce phase gates and skill compliance but treat each project as starting from zero discipline.

This pack adds four disciplines those frameworks do not:

1. **Memorial accretion** — failure-driven discipline accumulation. Each violation of a discipline produces a memorialized record; each application produces a confirmation. Ratios drive prioritization. The pack itself gets smarter as it gets used.
2. **Pre-emit grilling** — adversarial review of artifacts BEFORE they are forwarded to the next role, separate from post-merge review. Catches structural issues at the source rather than at the audit.
3. **Audit-trail file discipline** — coordination as durable artifacts (one file per round, one file per disposition, one file per investigation) rather than ephemeral chat. The trail is the source of truth.
4. **Role anchoring across multiple chat instances** — canonical session-ID-to-role mapping, anti-drift rule prohibiting "THIS session = X" self-claims in shared documents, per-chat project instructions as absolute role-identity source. Prevents the most common failure mode of multi-chat AI coordination: chats confusing or overlapping their roles. Includes a fillable template for projects to drop into their coordination folder.

## Anchor + Superpowers — how they compose

Anchor was developed independently from the worked example in
[`case-studies/deploysignal/`](case-studies/) before its author encountered
[Superpowers](https://github.com/obra/superpowers). The decision to compose
the two — rather than reinvent the phase-level disciplines Superpowers
already covers — is what produced the integration that ships in this repo.
The methodology has been refined across the integration's reference
implementation since.

Anchor and Superpowers operate at two different layers and are designed to
compose, not compete.

| Layer | What it provides | Owned by |
|---|---|---|
| **Role-level** | Which role runs when (Architect / Implementer / Reviewer / Memorial-Updater), routing between roles via `NEXT-ROLE.md`, cross-project accumulated reinforcements in `MEMORIAL.md` and `~/.claude/CROSS-PROJECT-MEMORIAL.md`, tier dial (`solo` / `audit` / `full`) to scale role count to round complexity (see [`skills/11-round-scaling.md`](skills/11-round-scaling.md)) | **Anchor** |
| **Phase-level** | What each role does inside its session — brainstorm (3 approaches with tradeoffs), design (component sketch), execute (TDD red-green-refactor), review (re-read as next role, mark assumptions) | **Superpowers** |

In Mode 2 (the automated pipeline), each role's prompt embeds the
Superpowers phase disciplines as inlined prose, so they fire reliably even
in headless `claude -p` sessions where the Superpowers MCP plugin may not
load. Interactive sessions get both the MCP slash commands (`/brainstorm`,
`/execute-plan`, etc.) AND the inlined prose — they compose without conflict.

**Mental model:** Superpowers tells the agent *how to think within a role*.
Anchor decides *which roles run* and *what gets remembered between rounds*.

Two of Anchor's load-bearing contributions are not in Superpowers:

- **The compounding-learning loop.** Superpowers is stateless per session;
  Anchor's `MEMORIAL.md` and `CROSS-PROJECT-MEMORIAL.md` accumulate
  failure-driven reinforcements across rounds and projects. Each violation
  becomes a `REINFORCED` line that future role-sessions read at start-time.
- **The cold-eye Reviewer.** Superpowers has a self-review phase, but
  Anchor's Reviewer is a separate cold-context session that audits the
  Implementer's output adversarially. In practice this has caught real
  CRITICALs that the Implementer's own self-review missed.

For the Mode 2 integration that wires these together — pipeline orchestrator,
role prompts, helper scripts — see
[`integrations/superpowers-claude-code/`](integrations/superpowers-claude-code/).

---

## Usage modes

Anchor is a methodology, not a runtime. It can be applied in two distinct modes depending on your context, team size, and how much pipeline visibility you want.

### Mode 1 — Manual coordination (original pattern)

The pattern Anchor was developed from. One chat instance per role, a human TPM in the middle routing between them via copy-paste or routing pasteables. The human reads every coordination artifact, notices when work is churning, and intervenes before cycles are wasted.

**When to use this:**
- You're learning the methodology and want full visibility into every handoff
- You're onboarding a new team to Anchor disciplines
- The project is high enough stakes that you want a human reading every artifact before it routes
- You want to stay in the loop on exactly what each role produces

**How it works:** Each role runs in a separate chat window with per-chat project instructions setting role identity. The human TPM reads Architect output, verifies it against the pre-route checklist, and pastes the routing artifact into the Implementer chat. The same human reads Reviewer output and decides what routes back for rework. The `templates/` directory provides fillable scaffolds for each role's primary artifact.

**Reference:** [`case-studies/deploysignal/`](case-studies/) — the full worked example that produced this methodology, run entirely in this mode.

---

### Mode 2 — Automated pipeline (solo operator pattern)

The evolved pattern for operators who have validated the methodology and want throughput without continuous supervision. An orchestration script opens and closes Claude Code sessions in sequence, passing role identity and context via files. The human operator writes the PRD once, runs the pipeline, and intervenes only at explicit escalation points.

**When to use this:**
- You're building solo or with a small team and are the only human in the loop
- You've already run several projects in Mode 1 and understand what each role should produce
- You want the pipeline to run for hours unattended and surface decisions when genuinely needed
- Speed and throughput matter as much as visibility

**How it works:** A shell script (`run-pipeline.sh`) opens headless Claude Code sessions in sequence — Architect → Implementer → Reviewer → Memorial Updater. Each session reads only the artifacts appropriate to its role (context isolation). Roles write routing state to `NEXT-ROLE.md` rather than waiting for a human to route them. The pipeline stops and surfaces a bounded question when a role hits a condition it cannot resolve autonomously. The cross-project memorial (`~/.claude/CROSS-PROJECT-MEMORIAL.md`) accumulates discipline violations and confirmations across projects, injecting reinforcement rules into every new project's CLAUDE.md automatically.

**Reference:** [`integrations/superpowers-claude-code/`](integrations/superpowers-claude-code/) — a complete, tested implementation of this pattern using Claude Code and Superpowers.

---

### Choosing a mode

The modes are not mutually exclusive. A common pattern is to start a project in Mode 1 to understand the problem space, then switch to Mode 2 for execution rounds once the Architect spec is solid. The coordination file structure (`coordination/specs/`, `coordination/reviews/`, `NEXT-ROLE.md`, `MEMORIAL.md`) is identical in both modes — switching between them mid-project requires no migration.

| | Manual (Mode 1) | Automated (Mode 2) |
|---|---|---|
| Human involvement | Every handoff | Escalations only |
| Context visibility | Full — human reads everything | Log files + final artifacts |
| Throughput | Limited by human availability | Runs unattended for hours |
| Best for | Learning, high-stakes oversight | Production velocity |
| Gate on churning | Human notices in real time | Halt discipline + escalation |
| Setup | Per-chat project instructions | `run-pipeline.sh` + `CLAUDE.md` |

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

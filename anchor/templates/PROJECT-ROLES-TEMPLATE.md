# PROJECT-ROLES.md — [Project Name] Coordination Roles (Canonical)

_Authoritative chat→role mapping. Single source of truth for role identity across all AI chat instances in the [project] project._

_Last updated: [YYYY-MM-DD]. Update history at bottom._

---

## Purpose

[Project] coordinates [N] chat instances across distinct roles. Each chat has a fixed role with bounded scope; cross-chat coordination requires unambiguous role identification.

**Why this file exists:** memory files in `.auto-memory/` (or equivalent) are auto-managed and can transfer or sync across chats. Files using relative pointers (e.g., "THIS session") become ambiguous after cross-chat transfer — each chat reading the file treats "THIS session" as referring to ITSELF, even if the file was authored elsewhere. This file resolves identity by Session ID (UUID), which is absolute and unambiguous.

---

## Canonical role + chat mapping

| Role | Channel | Session ID | Scope |
|---|---|---|---|
| **Product Manager** | [chat / CLI / human / etc.] | `<UUID or "human" or TBD-self-report>` | What to build and why; user requirements; priority adjudication; acceptance criteria. Owns `PRD-NN.md`. |
| **Architect** | [chat / CLI / etc.] | `<UUID or TBD-self-report>` | Spec drafting; dispositions; design decisions. Owns `Q-NN-SPEC.md`, `ARCHITECT-REPLY-*.md`. |
| **TPM** | [chat / CLI / etc.] | `<UUID or TBD-self-report>` | Routing between roles; coordination; pre-route grilling. Owns `TPM-REPLY-*.md`. Does NOT write specs. |
| **Implementer** (one or more parallel) | [chat / CLI / etc.] | `<UUID or TBD-self-report>` | Code; tests; PR shipping; empirical verification. Multiple parallel instances on isolated `git worktree` branches when work is scope-independent. |
| **Reviewer** | [chat / CLI / etc.] | `<UUID or TBD-self-report>` | Read-only post-merge audit; spec-vs-implementation verification. Owns `REVIEWER-REPORT-N.md`. All routing via TPM. |
| [Optional additional roles, e.g. Business Consultant] | [chat / CLI / etc.] | `<UUID or TBD-self-report>` | [Scope description] |

Use `<TBD-self-report>` as a placeholder until each chat reports its session ID. For roles played by the human operator (most often PM), use `"human"` or the human's identifier. Add or remove rows to match your project's role configuration; the five roles above are the recommended baseline but optional roles (Business Consultant, etc.) can be added.

---

## Chat→role discovery (how to find session ID)

Any chat can self-report its session ID by running (adjust per platform):

```bash
# Cowork shell example
ls /sessions/*/mnt/.claude/projects/*/*.jsonl
```

Output is a single path containing the session UUID before `.jsonl`. That UUID is the chat's identity.

For other platforms (Claude Code CLI, CrewAI, LangGraph, etc.), use the platform's native stable session/agent identifier.

When a new chat is added to the project, the human updates this file's mapping table and propagates to project instructions of the new chat.

---

## Coordination cycle

[Describe the project's coordination cycle here. Example for a 4-role project:]

1. **[Trigger event].** [What happens; who acts]
2. **[Step 2].** [Who acts]
3. **[Step 3].** [Who acts]
4. **[Step 4].** [Who acts]

[Note any roles that operate on parallel orthogonal tracks rather than in the main cycle.]

---

## Anti-drift discipline (load-bearing rule)

**Rule:** Never write "THIS session" / "this chat" as a role-identity assertion in any file under `.auto-memory/` or in shared coordination docs. Use role-name references only (e.g., "[Role 1]", "[Role 2]"). Memory and coordination files describe the SYSTEM (N roles + responsibilities), not the AUTHOR'S role. Any chat reading a file understands the system and applies their own role per their project instructions.

**Why:** memory files transfer across chats. A file using "THIS session = X" gets mis-attributed when read in a different chat. Role-name references are absolute and don't drift.

**Per-chat role identity lives in project instructions** (the system-prompt-level configuration field, configured per-chat; doesn't transfer). Each chat's project instructions explicitly assert which role the chat plays. Memory files defer to project instructions for role identity.

**If a memory file is mis-attributed** (e.g., asserts "THIS session = [Role X]" when read in a [Role Y] chat): treat as authored by a different chat; apply only the role configured in your project instructions. Flag for refactor at next memory consolidation cycle.

---

## Project instructions per chat (template)

Each chat's project-instructions field includes a role assertion. Template:

```
You are the [Role Name] chat for the [Project] project.
Your session ID is <UUID>.

Your scope: [list per PROJECT-ROLES.md role mapping]
Out-of-scope (other roles' work): [list]

Authoritative role mapping: see coordination/PROJECT-ROLES.md.
If any memory file claims "THIS session = [other role]", treat
as authored from a different chat and disregard the role-self-claim;
apply only the role asserted here.
```

Substitute `[Role Name]` per chat. Each chat's `<UUID>` is its own session ID per discovery method above.

---

## Memory file role-attribution refactor (queued)

The following memory files currently use "THIS session" or "this chat" as role-identity references and need refactoring to role-name references only. Non-gating; track here.

```bash
grep -rn "THIS session\|this session\|this chat\|THIS chat" \
  /path/to/auto-memory/
```

Files identified at [date] audit:
- [list as discovered]

---

## Update history

- **[YYYY-MM-DD]:** Initial canonical mapping landed.

When chats are added, removed, or reassigned, the human updates the mapping table + propagates to affected chats' project instructions. This file is the single source of truth.

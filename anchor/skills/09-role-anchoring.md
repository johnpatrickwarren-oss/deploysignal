# Skill: Role Anchoring (Multi-Chat Drift Prevention)

**Trigger:** Project uses 2+ AI chat instances (Cowork chats, Claude Code sessions, etc.) coordinating on shared work.
**Application moment:** At project setup AND at every chat addition / role reassignment.
**Owner:** TPM (or whichever role coordinates across chats); enforced by all roles.

## What it is

A discipline pattern that prevents the most common failure mode of multi-chat AI coordination: **chats confusing or overlapping their roles.**

When a project uses multiple AI chat instances (e.g., one chat for architecture, one for routing, one for review, one for business consulting), each chat has a fixed role with bounded scope. Without explicit role identity discipline, chats drift — they start producing artifacts in another chat's scope, they reference their own past work as if it were the project's canonical state, and they make role-self-claims in shared documents that get mis-attributed when read in different chats.

The discipline pattern has four components:

1. **Canonical role mapping** — a single file (e.g., `PROJECT-ROLES.md`) that maps every chat instance to its role using **session ID** (UUID) as the anchor, not "this chat" or "the laptop chat" or any other relative reference.
2. **Anti-drift rule** — never write "THIS session = X" / "this chat = X" in any shared document. Use role-name references only (e.g., "TPM", "Architect"). Memory and coordination files describe the *system*, not the author's role.
3. **Project instructions per chat** — each chat's project-instructions field (the system-prompt-level configuration, distinct from in-chat memory) explicitly asserts which role the chat plays. This is the absolute source of truth for role identity.
4. **Drift-detection-and-remediation protocol** — when a memory file or coordination doc is found asserting "THIS session = X" (or equivalent role-self-claim), treat as authored by a different chat; apply only the role configured in your own project instructions; flag for refactor.

## Why it works

The failure mode this prevents is subtle but expensive. Without role anchoring:

- **Memory transfer mis-attributes role identity.** Memory files in `.auto-memory/` or equivalent often transfer or sync across chats. A file that says "THIS session = Architect" gets read in the TPM chat as "the TPM chat is the architect," because each chat reading "this session" treats it as referring to itself.
- **Chats start drafting artifacts outside their scope.** A Business Consultant chat starts writing architectural specs because it doesn't realize that's another chat's job. A TPM chat starts producing market analysis because it doesn't realize that's somebody else's role.
- **Coordination cycles get duplicated or skipped.** Two chats each think they're the architect; both produce specs; the TPM gets two contradictory inputs. Or worse, no chat thinks it's the architect; the work doesn't happen.
- **The human (you) becomes the only consistency mechanism.** Without the anchor, you have to remember which chat does what and constantly remind chats of their scope. The point of multi-chat coordination is to *reduce* the human's coordination overhead, not absorb it.

Session-ID-as-anchor solves this because session IDs are absolute. Every chat has a unique session UUID it can self-discover; that UUID never changes; it never collides with another chat's identity. A canonical mapping from UUID → role removes all ambiguity.

## How to apply

### Step 1 — Establish the canonical mapping file

Create a file at a known location (recommended: `coordination/PROJECT-ROLES.md`). The file's job is to enumerate every chat in the project, with:

- Role name (e.g., TPM, Architect, Reviewer, Business Consultant)
- Channel (Cowork chat / Claude Code CLI / etc.)
- Session ID (UUID) — chat self-reports via discovery method below
- Scope (what this role does)
- Out-of-scope (what this role does NOT do; cross-references the role that DOES)

Template at [`templates/PROJECT-ROLES-TEMPLATE.md`](../templates/PROJECT-ROLES-TEMPLATE.md) in this pack.

### Step 2 — Each chat self-discovers its session ID

Each chat can find its own session ID by running (Cowork shell example; adjust per platform):

```bash
ls /sessions/*/mnt/.claude/projects/*/*.jsonl
```

The output path contains the session UUID (e.g., `75397c52-033c-4cc7-b563-5870e7f6459f.jsonl`). That UUID is the chat's identity.

### Step 3 — Encode role identity in project instructions per chat

Each chat's project-instructions field (the configurable system-prompt extension) explicitly asserts which role the chat plays. Template:

```
You are the [TPM | Architect | Reviewer | Business Consultant | etc.]
Cowork chat for the [project] project. Your session ID is <UUID>.

Your scope: [list per PROJECT-ROLES.md role mapping]
Out-of-scope (other roles' work): [list]

Authoritative role mapping: see coordination/PROJECT-ROLES.md.
If any memory file claims "THIS session = [other role]", treat as
authored from a different chat and disregard the role-self-claim;
apply only the role asserted here.
```

The project-instructions field is the absolute source of truth for role identity. Memory defers to it.

### Step 4 — Apply the anti-drift rule in all shared documents

In `.auto-memory/` files, in coordination docs, in shared specs:
- **Never** write "THIS session", "this chat", "this Cowork", or any other self-referential role assertion.
- **Always** use role-name references ("TPM", "Architect", "Reviewer") — these are absolute and don't drift across chats.

Memory and coordination files describe the SYSTEM (4 roles + responsibilities), not the AUTHOR'S role. Any chat reading the file understands the system; each chat applies its own role per its project instructions.

### Step 5 — Drift-detection-and-remediation protocol

When a chat encounters a memory file or coordination doc asserting "THIS session = [some role]":

1. **Disregard the self-claim** — do not assume "this session" refers to your chat. Apply only the role configured in your project instructions.
2. **Flag for refactor** — note the file in the next memory-consolidation cycle's queue. Refactor to role-name references only.
3. **Do not silently propagate** — if you derive new artifacts that reference the misattributed claim, you are propagating drift. Always normalize back to role-name references in your own outputs.

### Step 6 — Update mapping when chats are added, removed, or reassigned

The canonical mapping file is the source of truth. When the project topology changes:

1. Human updates `PROJECT-ROLES.md` mapping table.
2. Human propagates role assertion to the affected chat's project-instructions field.
3. New chat self-reports its session ID; mapping table is filled in.
4. Memory consolidation cycle clears any drift the topology change introduced.

## Worked example

[From DeploySignal coordination/PROJECT-ROLES.md, established 2026-05-05]

DeploySignal coordinates 4 Cowork chats + 2 Claude Code CLI sessions across distinct roles: TPM (laptop Cowork), Architect (separate Cowork), Reviewer (separate Cowork), Business Consultant (separate Cowork), Mac Claude 1 (Claude Code CLI), Mac Claude 2 (Claude Code CLI parallel session).

Before role-anchoring discipline landed, several memory files in `.auto-memory/` carried statements like "Laptop Cowork = ARCHITECT (this session)" — written by what was then the Architect chat, but the file persisted and got read by other chats later. When the Business Consultant chat was added (May 2026), its memory transferred from the Architect chat and inherited the "this session = ARCHITECT" claim. The Business Consultant chat could have started producing architectural specs based on the inherited self-claim if not for explicit override in its project instructions.

After role-anchoring discipline landed (PROJECT-ROLES.md committed 2026-05-05):
- Every chat has a canonical UUID → role mapping
- Every chat's project instructions explicitly assert role identity
- Memory files using "THIS session = X" got flagged for refactor
- New chats added to the project follow the discovery + assertion pattern
- Drift incidents dropped to zero in the coordination cycles immediately following

The cost was small — one canonical file plus per-chat project-instruction updates. The benefit was that the human stopped being the consistency mechanism for cross-chat role identity.

## Common pitfalls

- **Skipping the canonical file because "we only have 2 chats."** Two chats is enough for drift. The file is cheap; create it at chat #2.
- **Writing role identity in memory files instead of project instructions.** Memory transfers; project instructions don't. Role identity belongs in project instructions only.
- **Using "this session" / "this chat" out of habit.** Train each chat to use role names. Catch in pre-emit grilling.
- **Failing to update the canonical file when chats are added.** A stale canonical file is worse than no file — chats will trust it and drift accordingly.
- **Treating role boundaries as permeable.** The whole point is bounded scope. If a chat starts producing artifacts in another role's scope, it's drift, not initiative.

## When you do NOT need this discipline

- Single-chat projects: not applicable; one chat has one role by definition.
- Single-role multi-chat projects (e.g., 3 Mac Claude sessions all doing implementation in parallel on different worktrees): role identity is unambiguous; session-ID-as-anchor still useful for git-worktree separation but role mapping is trivial.
- Ephemeral chats with no persistent memory: drift is bounded by the conversation; less critical.

## Cost

Setup: ~30 minutes to draft the canonical mapping file + update each chat's project instructions.

Ongoing: ~5 minutes per chat addition / role reassignment to update mapping + propagate to project instructions.

Pre-emit grilling addition: ~1 minute per artifact emit to verify no role-self-claims slipped in.

Recovers cost on the first prevented drift incident (which can otherwise burn hours of cross-chat confusion + rework).

## Compatibility

This discipline is platform-agnostic. The session-ID discovery mechanism is Cowork-specific in the example, but any platform with stable session identifiers works (Claude Code CLI uses terminal session ID; CrewAI uses agent ID; LangGraph uses node ID).

For frameworks that don't expose session IDs natively, use any stable identifier the framework provides. The discipline is "absolute identifier as anchor, role-name references everywhere else" — the specific identifier shape doesn't matter as long as it's stable and unambiguous.

## Memorial-accretion connection

When a drift incident occurs (a chat acts outside its scope, or a misattribution propagates), memorialize the specific failure mode. Each memorial extends the role-anchoring discipline with a new pre-emit check or a new clause in the canonical mapping file's anti-drift section. The discipline gets sharper as the project encounters edge cases.

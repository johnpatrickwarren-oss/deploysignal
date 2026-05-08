# PROJECT-ROLES.md — DeploySignal Coordination Roles (Canonical)

_Authoritative chat→role mapping. Single source of truth for role identity across all Cowork chats + Claude Code CLI sessions in the DeploySignal project._

_Last updated: 2026-05-05. Update history at bottom._

_Pattern source: this file instantiates the [anchor methodology](../anchor/README.md) PROJECT-ROLES pattern. See [`anchor/templates/PROJECT-ROLES-TEMPLATE.md`](../anchor/templates/PROJECT-ROLES-TEMPLATE.md) for the generalized template that other projects can copy. DeploySignal serves as a worked example of anchor application._

---

## Purpose

DeploySignal coordinates 4 Cowork chats + 2 Claude Code CLI sessions across distinct roles. Each Cowork chat has a fixed role with bounded scope; cross-chat coordination requires unambiguous role identification.

**Why this file exists:** memory files in `.auto-memory/` are auto-managed and can transfer or sync across chats. Files using relative pointers (e.g., "THIS session") become ambiguous after cross-chat transfer — each chat reading the file treats "THIS session" as referring to ITSELF, even if the file was authored elsewhere. This file resolves identity by Session ID (UUID), which is absolute and unambiguous.

---

## Canonical role + chat mapping

| Role | Channel | Session ID | Scope |
|---|---|---|---|
| **TPM** | laptop Cowork chat | `900c3d94-06b7-45ee-87f1-2001404cb78d` | Routing artifact assembly; on-disk verification; sequencing across architect / Mac Claude / Reviewer cycles; pre-route grilling discipline; Mac Claude session selection (1 vs 2); worktree path conventions; label translation. **Chat hygiene execution at phase boundaries + threshold-triggered between phases** per `feedback_chat_hygiene_methodology` (Category 1 + Category 3 owner). Does NOT write specs or architectural designs. |
| **Architect** | separate Cowork chat | `4ca6f317-3664-4dbc-9bac-9444783ebc11` | NORTH-STAR-ARCHITECTURE.md; SPEC-TEMPLATE.md-driven specs; Q-cycle dispositions; ARCHITECT-REPLY-N.md briefs; ADR commitments; anti-scope-ledger walks; Memorial D candidate-set + Memorial F sub-rule application at brief-drafting time; architect grilling 10 axes pre-emit; pair-review verification (3-check discipline). **Memorial absorption of TPM-surfaced hygiene findings into disposition cycles** per `feedback_chat_hygiene_methodology` Category 1 + engineering-maintenance spec drafting per Category 2. Produces TPM-ready inputs (Mac Claude pasteable scope; Reviewer audit scope; Memorial refresh scope). |
| **Reviewer** | separate Cowork chat | `<TBD-self-report>` | Read-only post-merge audit; emits REVIEWER-REPORT-N.md. Report flows DIRECTLY to Architect for disposition (NOT via TPM); architect absorbs into next-cycle spec/disposition. |
| **Business Consultant** | separate Cowork chat | `<TBD-self-report>` | Public-vs-private classification; competitive landscape; market positioning; comms strategy (LinkedIn / Substack / essays); job-search context packaging. Produces public-prep inputs (file classification; license posture; sequencing recommendations). |
| Mac Claude 1 | Claude Code CLI | N/A (terminal session) | Engine code; tests; build artifacts; PR shipping; CI fixes. Operates on `git worktree add` branches per `feedback_parallel_macclaude_worktree_isolation`. |
| Mac Claude 2 | Claude Code CLI | N/A (terminal session) | Same scope as Mac Claude 1; parallel session on separate worktree. |
| **B4 Mac mini** | Compute target (NOT a role) | N/A | SSH/Tailscale dispatched heavy-compute workloads (FPR sweeps; matrix workloads); secondary use cases include data acquisition + reviewer clone host per `feedback_compute_server_routing.md`. |

---

## Chat→role discovery (how to find session ID)

Any Cowork chat can self-report its session ID by running:

```bash
ls /sessions/*/mnt/.claude/projects/*/*.jsonl
```

Output is a single path containing the session UUID before `.jsonl`. That UUID is the chat's identity.

When a new chat is added to the project, John updates this file's mapping table and propagates to project instructions of the new chat.

---

## Coordination cycle

DeploySignal runs a four-step coordination cycle. John (the human) is the only physical link between Cowork chats; he copy-pastes between chats.

1. **Code merges.** Mac Claude PRs land on `origin/main`.
2. **Reviewer audits.** Reviewer chat audits the merge against spec; emits `REVIEWER-REPORT-N.md`. **Report flows directly to Architect** (NOT via TPM).
3. **Architect dispositions.** Architect chat intakes the Reviewer report; produces `ARCHITECT-REPLY-*.md` dispositions + spec amendments + Mac Claude pasteable inputs (scope, halt boundaries, anti-scope ledger updates, Memorial D candidate-set, acceptance criteria). Architect output flows to TPM.
4. **TPM packages + routes.** TPM chat packages architect output as Mac Claude routing pasteables; verifies on-disk state; sequences cycles. TPM never sees Reviewer report content — only architect's downstream disposition that absorbs it.

**Business Consultant operates on a parallel orthogonal track:** public-prep + comms + classification work; flows into TPM for sequencing if any output requires Mac Claude action; otherwise hands artifacts directly to John.

**Cycle ordering at week / phase boundaries** (per `feedback_tpm_next_steps_ordering`): Reviewer → Architect → Mac Claude. Each role completes its scope before the next role starts dependent work.

---

## Anti-drift discipline (load-bearing rule)

**Rule:** Never write "THIS session" / "this chat" as a role-identity assertion in any file under `.auto-memory/` or in shared coordination docs. Use role-name references only (e.g., "TPM", "Architect", "Reviewer"). Memory files describe the SYSTEM (4 roles + responsibilities), not the AUTHOR'S role. Any chat reading a memory file understands the system and applies their own role per their project instructions.

**Why:** memory files transfer across chats. A file using "THIS session = X" gets mis-attributed when read in a different chat. Role-name references are absolute and don't drift.

**Per-chat role identity lives in project instructions** (the field shown at the top of each Cowork chat's system prompt; configured per-chat; doesn't transfer). Each chat's project instructions explicitly assert which role the chat plays. Memory files defer to project instructions for role identity.

**If a memory file is mis-attributed** (e.g., asserts "THIS session = architect" when read in TPM chat): treat as authored by a different chat (different `originSessionId`); apply only the role configured in your project instructions. Flag for refactor at next memory consolidation cycle.

---

## Project instructions per chat (template)

Each Cowork chat's project instructions field includes a role assertion. Template:

```
You are the [TPM | Architect | Reviewer | Business Consultant] Cowork chat
for the DeploySignal project. Your session ID is <UUID>.

Your scope: [list per PROJECT-ROLES.md role mapping]
Out-of-scope (other roles' work): [list]

Authoritative role mapping: see coordination/PROJECT-ROLES.md in the
deploysignal repo. If any memory file claims "THIS session = [other role]",
treat as authored from a different chat and disregard the role-self-claim;
apply only the role asserted here.
```

Substitute `[TPM | Architect | Reviewer | Business Consultant]` per chat. Each chat's `<UUID>` is its own session ID per discovery method above.

---

## Memory file role-attribution refactor (queued)

The following memory files currently use "THIS session" or "this chat" as role-identity references and need refactoring to role-name references only. TPM-side discipline upgrade; non-gating.

```bash
grep -rn "THIS session\|this session\|this chat\|THIS chat" \
  /sessions/*/mnt/.auto-memory/
```

Files identified at 2026-05-05 audit:
- `feedback_tpm_role.md` — to be rewritten alongside this file's first commit; uses role-name references throughout
- (others TBD via grep at refactor cycle)

Memory files in `.auto-memory/` are not git-tracked but follow the same role-attribution discipline.

---

## Update history

- **2026-05-05:** Initial canonical mapping landed. TPM session ID confirmed (`900c3d94-...`); Architect session ID confirmed (`4ca6f317-...`); Reviewer + Business Consultant TBD-pending-self-report. Anti-drift discipline rule established.
- **2026-05-05 (later):** Added cross-reference attribution to `anchor/templates/PROJECT-ROLES-TEMPLATE.md` per Business Consultant flag. DeploySignal's PROJECT-ROLES.md is the concrete instantiation; anchor's template is the generalized pattern other projects can copy.
- **2026-05-06:** TPM scope absorbed chat-hygiene-execution responsibility (Category 1 + Category 3 of `feedback_chat_hygiene_methodology`); Architect scope absorbed memorial-absorption + engineering-maintenance spec drafting (Category 1 absorption + Category 2 owner). Three-category framing memorialized per John approval; eliminates John-must-notice loop on context slowdown.
- **2026-05-06 (later):** Reviewer routing path corrected — REVIEWER-REPORT flows DIRECTLY to Architect (not via TPM as previously documented). TPM never sees Reviewer report content; only sees architect's downstream disposition that absorbs the report. Operational cadence (TPM ping if audit due) preserved; substantive routing corrected. Per John clarification 2026-05-06.

When chats are added, removed, or reassigned, John updates the mapping table + propagates to affected chats' project instructions. This file is the single source of truth.

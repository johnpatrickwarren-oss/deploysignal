# Skill: Round Numbering Convention

**Trigger:** Any new topic of work that will involve more than one round of cross-role exchange.
**Application moment:** At topic kickoff, before the first artifact is drafted.
**Owner:** Whichever role identifies the new topic first (typically TPM or Architect).

## What it is

Each topic gets a single round number shared across all roles. Sub-rounds use letter suffixes (52a, 52b, ..., 52gk). Cross-role artifacts cite the topic number; any role can reference any other role's artifact by `<role>-<artifact-type>-<topic-number>`.

This sounds like a trivial bookkeeping convention. It is not. It is the discipline that makes 250-file coordination trails navigable instead of incomprehensible.

## Why it works

In a multi-role project with ~100+ coordination artifacts, the central problem is **referential disambiguation**. When the architect's reply 52gd references "the calibration-source incoherence we discussed," which discussion? The TPM's reply 41 mentions a similar issue; the reviewer's report 11 also touches it; the diagnostic memo from 04-26 names it explicitly.

Without numbering, each cross-reference requires the reader to reconstruct the conversation timeline. With numbering, every reference is `topic 52gk` — exact, unambiguous, locatable in the file system by `ls *52gk*`.

The numbering also enables:
- **File-system-as-database.** `ls *52*` shows all topic 52 artifacts. No tool required.
- **Round-shaped progress tracking.** "Topic 52 ran from a to gl" tells you the depth of the investigation.
- **Memorial referencing.** Memorial D citations like "1V at REPLY-52gd" are unambiguous and grep-able.
- **Audit-trail navigation.** Reviewer auditing topic 52 can read all artifacts in deterministic order.

## How to apply

### Numbering scheme

```
<topic-number>[<sub-round-letter(s)>]

Topic 52         — initial topic
Topic 52a        — first sub-round (V framework opened, hypothesis trees)
Topic 52b        — second sub-round
...
Topic 52z        — twenty-sixth sub-round
Topic 52aa       — twenty-seventh (continues with double letters)
Topic 52gk       — much later sub-round
Topic 52gl       — later still
```

Topic numbers are assigned in order of topic creation across the project. Sub-rounds within a topic are assigned in order of artifact emission (any role can advance the sub-round by emitting the next artifact).

### Artifact naming

Each artifact gets a name that includes the topic number:

```
ARCHITECT-REPLY-52.md
ARCHITECT-REPLY-52a.md
ARCHITECT-REPLY-52b.md
TPM-REPLY-52.md
TPM-DISPOSITION-REVIEWER-09.md      (reviewer 09's topic; cross-references)
REVIEWER-REPORT-WK06.md             (week-numbered; cross-references via topic numbers in body)
DIAGNOSTIC-V1-H1-2026-04-26.md      (V/Q framework artifact; topic-implicit via context)
INVESTIGATION-CHAIN-POSTMORTEM-TOPIC-52.md
```

Naming is loose at the boundaries (some artifacts are date-stamped, some are week-numbered) but the topic number is always traceable in the body.

### Cross-referencing in artifact bodies

Inside artifact prose, cite by topic + role + artifact:

```markdown
Per ARCHITECT-REPLY-52gk §TPM-ask-2 — calibration-source coherence is a
Phase-2 commitment. TPM-REPLY-52gj had asked the question; ARCHITECT-REPLY-52gk
provided the disposition.
```

This is the substrate for every cross-role memory. The reader can locate every cited artifact in the file system within seconds.

### Topic creation discipline

A new topic gets a new number when:
- The work is independent enough that it can be tracked separately
- The work involves multiple rounds (single-round work just gets a one-off artifact, not a topic)
- The work crosses role boundaries (architect + implementer + reviewer)

Avoid:
- Sub-topics that should have been their own topic (use new numbers liberally; reusing a topic number for distantly-related work creates referential confusion)
- Topics with no sub-rounds (if it's one artifact, just name it without a topic number)

### Sub-round letter exhaustion

When you exceed `52z`, continue with `52aa`, `52ab`, ... `52az`, `52ba`, etc. Three-letter suffixes (`52aaa`) are a smell — the topic has probably exceeded its useful coordination scope; consider closing it and opening a new topic.

In DeploySignal, the longest topic ran to `52gl` (39 sub-rounds across `a-z`, `aa-gl`). Past `gh` or so, the topic was effectively three sub-investigations sharing a number; they should arguably have been split. Treat that as the empirical upper bound.

## Worked example

[From DeploySignal coordination/, Topic 52 lifecycle]

**Topic 52** opened with REPLY-52 (architect's initial post-Phase-2 disposition). 

Sub-rounds emerged as the topic deepened:
- **52a:** TPM-side process feedback
- **52b-c:** F1 + M1 hypotheses opened and falsified
- **52d:** Scenario-harness misalignment (P3 axis 6 born)
- **52e:** Family B iid-bootstrap methodology artifact
- **52f:** v4 pre-#20 compilation state
- **52g:** Page-CUSUM literature-fidelity slip; U2+U4 scope-split
- **52gb-gh:** Phantom Family A betting Ville violation chain (REVOKED post-misattribution-correction)
- **52gi:** Misattribution caught (P3 axis 10 born); Cholesky resampler shipped
- **52gj:** TPM ask on calibration-source coherence
- **52gk:** Architect disposition on TPM ask; Q2.B.4 commitment + diagonal-cov fix
- **52gl:** Final wrap; topic close

Across these 39 sub-rounds, every cross-role reference was unambiguously locatable. The post-mortem at `INVESTIGATION-CHAIN-POSTMORTEM-TOPIC-52.md` walks the entire arc; each citation in the post-mortem points to a specific file. Reviewer audit of the topic post-close was straightforward because the file-system-as-database made navigation deterministic.

Without the numbering convention, this volume of cross-role coordination would have been incomprehensible by week 4. With it, the topic lifecycle is auditable, learnable, and partially-replayable.

## Common pitfalls

- **Reusing topic numbers for distantly related work.** Avoid. Use new numbers; cheap to allocate.
- **Inconsistent sub-round letter assignment.** Pick a discipline (next available; date-ordered; etc.) and stick with it. Drift confuses readers.
- **Topic numbers in artifact filenames missing.** Every multi-round artifact needs its topic number visible in the filename. "TPM-REPLY-on-calibration.md" is searchable by content but not by topic.
- **Letting sub-rounds run past 30+.** Indicates the topic should have been split. Open a new topic for the new sub-investigation; reference back to the original topic number.

## What this skill is NOT

This is not a project management methodology. It does not replace milestones, sprints, deadlines, or release planning. It is solely a referential convention for cross-role artifact navigation.

It also is not a substitute for memorialization (see [`02-memorial-accretion.md`](./02-memorial-accretion.md)). Topic numbering helps you find the artifacts; memorialization is what extracts learning from them.

## Cost

Approximately zero ongoing cost once the convention is established. Topic creation requires picking a number (1-2 seconds). Sub-round assignment is automatic. Artifact naming requires consistency, not effort.

The cost is upfront — establishing the convention, training each role to use it, building the muscle memory. After 5-10 topics, it becomes invisible discipline.

## Compatibility

Works with any file-based artifact storage (Git repo, shared folder, doc system with stable URLs). Does not work as well in pure-chat contexts where artifacts don't have stable identifiers — in which case, paste the artifact content into a stable doc with a topic-numbered filename and reference from there.

In agent orchestration frameworks: topic number can be a metadata field on artifact-emit; the framework can enforce inclusion at write-time. CrewAI / LangGraph / Mastra all support arbitrary metadata; encoding the convention as a write-side validator is straightforward.

# Reviewer Report NN — [Audit Scope]

_Reviewer — [YYYY-MM-DD]._
_Scope: [PR / branch / commit-range audited] against [spec / PRD / contract]. Read-only audit. All findings route to TPM._

---

## Summary

[1-3 sentences. What was audited; high-level outcome (PASS / FAIL / GAP-noted); whether downstream work is gated or can proceed.]

---

## Audit method

- **Spec / PRD audited against:** [list of source-of-truth artifacts]
- **Implementation audited:** [PR # / branch / commit range / files]
- **Verification approach:** [programmatic re-run / static read / spec-vs-impl trace]
- **Tools used:** [test suite / specific tools / grep / etc.]

---

## Per-acceptance-criterion verification

Spec/PRD acceptance criteria mapped to implementation evidence. Every AC must have a row.

| AC | Spec/PRD reference | Implementation evidence | Verdict |
|---|---|---|---|
| AC-1 | [§ ref] | [file:line / test name / output snippet] | PASS / FAIL / GAP |
| AC-2 | [§ ref] | [...] | PASS / FAIL / GAP |
| AC-3 | [§ ref] | [...] | PASS / FAIL / GAP |

GAPs that don't block (e.g., out-of-scope by design) are explicit in the verdict reasoning.

---

## Findings

Each finding gets a severity tier and routing recommendation. Severity definitions:

- **PASS:** AC met; no follow-up needed.
- **FAIL:** Core invariant broken; downstream work gated until resolved.
- **GAP:** Spec/PRD didn't cover an emergent issue; needs upstream amendment.
- **FILE:** Minor; document for future reference; non-gating.
- **OPTIONAL:** Improvement opportunity; not required.

### F1 — [Finding title] (FAIL / GAP / FILE / OPTIONAL)

**Observation:** [What was observed; specific file/line/output reference.]

**Spec/PRD expectation:** [What the spec or PRD said should be true.]

**Divergence:** [How implementation differs from expectation.]

**Recommendation:** [What action resolves the finding; route via TPM to which role.]

[Repeat per finding. Number them F1, F2, F3...]

---

## Cross-cutting verification

Project-wide invariants that must remain true regardless of the specific change being audited.

### No-skip policy on critical tests

Per [`skills/02-memorial-accretion.md`](../skills/02-memorial-accretion.md) (or project-specific equivalent). Grep test directory for `skip` / `xit` / `it.skip` / `describe.skip`:

- **Result:** [N skips found / 0 skips found]
- **If non-zero:** [list each skip; classify as principled-and-documented vs new-and-unauthorized]

### Audit-state currency

Verify project documentation references (status doc, README, cheatsheets) are current vs the merged change:

- **Test counts:** [reported X; actual Y; FILE if drift]
- **Version labels:** [canonical version cited matches latest]
- **Cited filenames:** [all referenced files exist at cited paths]

### Anti-scope preservation

Per [`skills/06-anti-scope-ledger.md`](../skills/06-anti-scope-ledger.md). Verify implementation didn't absorb work from anti-scope:

- **AS-1 [from spec]:** [verified absent / present in implementation]
- **AS-2 [from spec]:** [verified absent / present in implementation]

### Right-reasons verification (where applicable)

For implementations claiming specific behavioral properties, verify the implementation does what it claims, not just what passes tests:

- **Claim 1:** [implementation behavior verified via specific evidence]
- **Claim 2:** [...]

---

## Severity triage table

| Severity | Count | Items | Routing |
|---|---|---|---|
| FAIL | [N] | [F1, F4] | Block downstream until resolved; route to Architect via TPM |
| GAP | [N] | [F2] | Upstream amendment needed; route to PM/Architect via TPM |
| FILE | [N] | [F3, F5] | Document; non-gating |
| OPTIONAL | [N] | [F6] | Defer to future cycle if relevant |

---

## Disposition routing recommendations

Per [`skills/03-four-anchor-defense.md`](../skills/03-four-anchor-defense.md) T3 anchor: findings route to the upstream anchor that should have caught the issue.

- **F1 (FAIL):** Routes to T0 (Architect) — spec didn't enumerate this case.
- **F2 (GAP):** Routes to PM — PRD didn't cover this requirement.
- **F3 (FILE):** Documentation drift — TPM updates STATUS.md / equivalent.
- **F4 (FAIL):** Routes to T2 (Implementer) — implementation diverges from spec; clear fix-forward.
- **F5 (FILE):** [...]
- **F6 (OPTIONAL):** [...]

---

## Open items / deferred audits

[Items audit could not complete in this cycle; queued for future review.]

- **D1:** [Item; reason deferred; target cycle]
- **D2:** [...]

---

## Audit-process discipline self-check

Per Reviewer-side discipline. Did this audit itself follow the methodology?

- **Independent fresh-context read:** [Yes — audited from spec without consulting prior implementation discussions / No — note context contamination]
- **Programmatic verification used where available:** [Yes / No — specify gaps]
- **Severity tiers applied per project standard:** [Yes / No]
- **All findings routed via TPM (not direct to other roles):** [Yes / No]

---

_Reviewer report per [`skills/03-four-anchor-defense.md`](../skills/03-four-anchor-defense.md) (T3 anchor). Audit scope is read-only; all routing flows through TPM. Replace placeholders with audit-cycle-specific content._

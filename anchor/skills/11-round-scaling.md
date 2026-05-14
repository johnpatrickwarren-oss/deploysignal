# Skill: Round Scaling — Scaling Role Count to Round Complexity

**Trigger:** Operator (or Architect-advising-operator) is about to launch
a round and must decide how many roles will run.
**Application moment:** Before round start, recorded in the round's PRD
scope block alongside the FR list.
**Owner:** Operator. The Architect may advise via NEXT-ROLE.md routing
notes after a prior round, but the tier choice is the operator's commit.

## Naming disambiguation (read this first)

Anchor's four-anchor pre-merge defense uses **T0 / T1 / T2 / T3** to name
the temporally-ordered discipline checkpoints (Architect spec-emit, TPM
routing-emit, Implementer execute-emit, Reviewer post-merge). See
`METHODOLOGY.md` "Four-anchor pre-merge defense" for those.

This skill is about a different concept: **how many roles to run for a
given round.** To avoid collision with the four-anchor T0-T3 naming, the
round-scaling tiers use verbal names: **solo / audit / full.**

## What it is

Anchor's full coordination cycle runs four roles (Architect / Implementer /
Reviewer / Memorial-Updater). Not every round needs the full cycle —
small rounds pay coordination overhead that exceeds the bug-catching
return. Round Scaling is the operator's decision on how many roles run
for a given round, made deliberately at PRD-scope-block time and
recorded in the audit trail.

Three tiers:

| Tier | Roles | Cost vs single-Superpowers baseline |
|---|---|---|
| **solo** | Implementer only — spec, execute, memorial inline | ~1-2x |
| **audit** | Implementer + Reviewer + Memorial (no separate Architect) | ~3x |
| **full** | Architect + Implementer + Reviewer + Memorial | ~4x |

Each tier-down is a real safety trade. `audit` drops the Architect's
cold-eye spec discipline; `solo` also drops the Reviewer's cold-eye
audit. The cost savings come at the cost of pre-merge bug-catching
surface.

## Why include it as a separate skill

Without explicit tier guidance, operators default to the full cycle on
every round — which is correct for novel/high-risk work but wasteful for
mechanical or follow-on work. Anchor's audit-trail discipline already
exists; round-scaling adds the right-sized application of that
discipline per round.

The skill compounds with Anchor's other disciplines:

- **Pre-emit grilling** still fires in all tiers
- **Halt-discipline / ESCALATE** still fires in all tiers
- **Memorial accretion** still fires in all tiers (collapsed inline in `solo`)
- **Cold-eye Reviewer** only fires in `audit` and `full`
- **Architect cold-eye spec** only fires in `full`

## How to pick a tier (60-second decision tree)

Walk top-down. Stop at the first match. Whoever picks the tier (operator
or Architect-advising-operator) records the verdict and the matched
criterion in the round's PRD scope block.

```
1. Does ANY of A1–A7 fire?
     YES → full (need the Architect's cold-eye spec discipline)
     NO  → continue

2. Is the entire diff pure-mechanical, matching ONE Z criterion (Z1–Z5)?
     YES → solo (visual diff inspection replaces cold-eye review)
     NO  → continue

3. Does ANY of S1–S5 fire?
     YES → audit (Implementer self-specs; Reviewer audits cold)
     NO  → full (default — the rubric did not justify a downshift)
```

Three forcing functions: **A factors push UP to `full`** (architect
needed); **Z factors push DOWN to `solo`** (mechanical work); **S
factors enable the middle** (`audit`); **absence of justification stays
at `full` default.**

## Worked examples

| Round description | Tier | Matched criterion |
|---|---|---|
| Add a new entity + migration + admin UI | full | A4 (novel data model) |
| Switch middleware runtime (Edge → Node) | full | A2 (new pattern), A6 (blast radius) |
| Add a new external integration (Stripe, Sentry, etc.) | full | A1 (new dependency) |
| Resolve an open question from the PRD this round | full | A3 |
| Add a new admin page extending an existing list-view pattern | audit | S1, S2 |
| Add a sortable column to an existing table | audit | S1, S3 |
| Add an e2e test for a recently-shipped screen | audit | S4 (tactical follow-up) |
| Fix 3 leftover MINORs from a prior round's Reviewer report | audit | S4 |
| Add a feature-flag check (even one line of new behavior) | audit | new behavior — fails Z; S3 applies |
| Add 5 new unit tests against an existing pure function (no prod change) | solo | Z3 |
| Add 5 new integration tests closing a prior-round MINOR coverage gap | audit | Z3 disqualified (gap-closure + integration-tier); S4 applies |
| Bump Playwright timeout from 5s to 10s | solo | Z4 |
| Rename an internal helper function (no external callers) | solo | Z1 |
| Update `templates/PRD-TEMPLATE.md` docs | solo | Z2 |
| Fix typo in a user-facing button label | solo | Z5 |
| Bump a npm dev-dependency patch version | solo | Z1 |

When in doubt between two tiers, pick the higher one. The cost of an
unneeded extra role is one model call; the cost of a missed
architectural decision or a missed adversarial finding is a 2–4-cycle
fix recovery.

## Criteria — A factors (any one → full)

  A1. New external dependency (npm lib, external service, new API)
  A2. New architectural pattern with no precedent in the codebase
  A3. Unresolved open question that this round must resolve
  A4. Novel data model (new entities or relationship patterns)
  A5. Critical NFR ties that materially constrain design choices
  A6. Large blast radius (touches ≥ 4 prior rounds' production code
      paths OR risks breaking backward compatibility for many existing
      tests)
  A7. First-time territory — the project has never done X before

## Criteria — S factors (all-A-false AND any-S → audit candidate)

  S1. Direct extension of a recent round's already-shipped pattern
  S2. Prior round artifacts (spec or Reviewer report) functionally
      describe the work
  S3. Single bounded item (one bug fix, one AC, one config change)
  S4. Tactical follow-up to a recent round (fixing leftover MINORs)
  S5. Tech-debt with empirical investigation where the investigation
      IS the design work

## Criteria — Z factors (audit candidate AND pure-mechanical → solo candidate)

  Z1. Single-file mechanical rename, version bump, or format change
      (no behavior change)
  Z2. Documentation-only change (no code or test behavior change)
  Z3. Test-only addition — adding new tests against existing production
      code (NOT modifying existing test assertions). Z3 applies cleanly
      to: unit tests against pure functions or well-bounded units; ≤3
      simple additions; tests that don't close a prior-round MINOR/MAJOR
      gap. Z3 does NOT apply (use audit instead) when:
        (a) the tests are integration-tier or e2e-tier with non-trivial
            fixtures, multiple production-call paths, or DB/external
            state — cold-eye Reviewer is warranted for fixture-
            distinctiveness, action-signature-drift, and self-confirming-
            test risk that are harder for the Implementer to self-catch.
        (b) the round closes a prior-round MINOR/MAJOR coverage gap —
            the gap exists because someone already missed it once; the
            fix needs adversarial review, not self-review.
        (c) the fixtures or assertion shapes are non-obvious (e.g.,
            require careful distinctiveness analysis or snapshot-key
            cross-checks).
  Z4. Configuration value tweak (env var, port, timeout) where the
      value is the only change
  Z5. Cosmetic UI tweak (label text, color, padding) where visual
      review can substitute for code review

`solo` is explicitly NOT for:
  - Any new behavior, even small ("adds one feature flag check")
  - Any spec gap requiring a decision
  - Any modification of existing test assertions
  - Anything that touches schema, middleware, auth, or shared infrastructure
  - Anything where verifying correctness requires more than visual
    diff inspection

## Promotion mid-round (solo → audit, audit → full)

A `solo` round whose actual diff exceeds Z criteria → Implementer HALTs
with a DIAGNOSTIC and recommends operator re-run as `audit` (so the
cold-eye Reviewer audits the result). Silent expansion is a discipline
failure.

An `audit` round where the Implementer's self-spec hits architectural
ambiguity → HALT with a bounded DIAGNOSTIC, operator picks Option
A/B/C. If the chosen resolution is materially novel, operator can
re-run as `full` for the fix cycle.

A `full` round where the Architect finds the spec is trivial (no
design decisions to make) → Architect notes in `NEXT-ROLE.md` that a
future similar round could safely use `audit`. Current round still
completes as `full`.

## Recording the decision

For `audit` and `solo` rounds, write the rubric verdict in the round's
PRD scope block before launching: which Ai factors are all false, which
Si justify dropping the Architect, which Zi justify also skipping the
Reviewer. This is the audit trail. If an `audit` round produces halts
an Architect would have caught, or a `solo` round merges a bug a
Reviewer would have caught, compare to the recorded verdict — the
rubric needs sharpening.

`full` is the default; no record required for `full` rounds.

## When in doubt

Pick `full` over `audit`, and `audit` over `solo`. The cost of an
unneeded extra role is one model call. The cost of a missed
architectural decision or missed adversarial finding is the trajectory
observed when halts cluster — fix cycles can run 2–4 passes and burn
far more than the upfront cold-eye cost. `solo` has the highest
downside risk because there is no cold-eye safety net at all: only use
it when the diff is so mechanical that visual inspection catches
everything.

## Runtime binding

The `solo / audit / full` tier names are realized in Anchor's automated
pipeline mode via the `--tier` flag of
[`integrations/superpowers-claude-code/run-pipeline.sh`](../integrations/superpowers-claude-code/run-pipeline.sh).
The CLI accepts both the new names and the older `T0` / `T1` / `T3`
aliases for backward compatibility (the older names emit a deprecation
warning).

In Mode 1 (manual coordination), the operator applies this skill by
choosing how many roles to wake up for the round — `solo` means routing
straight to the Implementer chat without an Architect or Reviewer pass;
`audit` adds the Reviewer; `full` is the canonical four-role cycle.

## Memorial-accretion connection

When a round's outcome diverges from the recorded tier verdict —
either an `audit` round needs Architect intervention via fix-cycle, or a
`solo` round ships a bug a Reviewer would have caught — the Memorial
Updater records the divergence as a discipline-application miss. If the
same divergence pattern recurs across rounds (3+ instances), the rubric
itself needs sharpening. Update the criteria here; ship a canonical PR
to propagate.

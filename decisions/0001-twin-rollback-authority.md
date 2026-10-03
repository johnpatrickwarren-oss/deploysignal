# ADR 0001 — Rollback authority for the randomized twin, scoped to what was measured

- **Date:** 2026-10-02
- **Status:** ACCEPTED 2026-10-03 (John, 2026-10-02: "let's accept all 5 after the fault study
  report"; the report is `studies/twin-fault-shapes/REPORT.md`, §5 below is filled from it). Decision
  only: `TWIN_ARM_AUTHORITY` stays `'advisory'` (`engine/guarantees.ts`) until the implementation PR
  (§6) is merged with its own authorization, after the onebox study (§2, last row) closes.
- **Author and conflict of interest:** written by the same session that designed, ran and
  analysed every study it cites, for the project's owner. No one outside that loop has reviewed
  the registrations, the runs or this text.
- **Register:** knowledge `WORKLIST.md` C84 (the twin; "an authority ADR" is its open item), C87
  (the temporal path's authority); `DORMANCY.md` "Plan B — randomized twin"; engine ADRs 0036, 0037.
- **Open at acceptance:** study `2026-10-twin-aa-onebox` (registered, pinned, not run): one task
  per arm, same-AZ and cross-AZ strata. It sets D1's arm-size and placement clauses (§3, D1 item 6)
  before implementation.

## 1. The question

DORMANCY.md says the twin verdict's authority is dormant until "a separate authority ADR after a
registered real-service A/A run". Two such runs now exist. Should a twin `rollback` verdict be
allowed to fail a rollout, and under which conditions?

## 2. Evidence

Every row is a pre-registered study with bars fixed before the run. T1 is synthetic, T2 two local
processes, T3 a real ALB service on AWS (one synthetic service, one region, one seeded load
generator, Fargate).

| Study | Tier | What it measured | Result |
|---|---|---|---|
| engine `2026-09-twin-null` | T1 | per-metric false rollback, premise boundaries | 0.025–0.027; ship rule met; persistent arm state breaks `sign` (0.165) |
| engine `2026-09-twin-gate` | T1 | the gate: Bonferroni, guard, missingness | ship rule met; power collapses between 5% and 10% missing ticks |
| `2026-09-twin-aa-local` run 2 | T2 | A/A and two faults | 0/100; 40/40 per fault |
| `2026-10-twin-aa-real` AA | T3 | A/A, 1 ms service, 2 tasks per arm, no margin | **E1 FAIL 12/44**, every rollback the `sign` kind on p99; `rate` kind 0/44 |
| `2026-10-twin-aa-real` AB-5xx | T3 | ×2 target-5xx fault | E4 PASS 20/20; `rate` first in 16 at ticks 25–26; unmargined `sign` pre-empted 4 |
| engine `2026-10-twin-sign-margin` | T1 + replay | the margin (ADR 0037) | ship rule met; false rollback 0.000–0.037 under offsets up to 0.9 of the margin |
| `2026-10-twin-aa-real-2` AA | T3 | A/A, 76 ms service, 4 tasks per arm, 10% margin | **E1 PASS 0/100** (upper bound 0.030); E2, E3 PASS |
| `2026-10-twin-fault-shapes` | T3 | latency +30%, 5xx ×1.5, resets without and with a `no_response` metric | F1 20/20 (tick 11); F2 20/20 (median tick 40); resets 0/20 unseen; with `no_response` 20/20 (tick 12) |
| `2026-10-twin-aa-onebox` | T3 | A/A at one task per arm, same-AZ and cross-AZ strata, 100 runs each | registered, not run |

Pooled over both T3 A/A cells the `rate` kind on target 5xx has 0 false rollbacks in 144 runs
(one-sided 95% upper bound 0.021; two configurations pooled). The sample-ratio guard has 0 halts in
the 164 runs of the three cells.

Two things the evidence says that cut against a simple reading:

- **The first A/A failed, and the second study's own replay says the margin is not what fixed
  it.** Replayed without the margin, the second study's 100 runs give 1 rollback
  (`studies/twin-aa-real-2/REPORT.md` §3). The arms became exchangeable in p99 because the service
  was 70× slower and each arm had four tasks, not because of the margin. The margin is insurance
  against offsets the first study proved can exist; how large an offset a real fleet carries is
  unmeasured.
- **No bar here separates a false-rollback rate of 0.05 from 0.10.** "0 of 100" bounds the rate
  at 0.030 for one service; it does not establish α.

## 3. Decision (proposed)

**D1. A twin `rollback` verdict may fail a rollout only for a session that is eligible and that
asks for it.** `TWIN_ARM_AUTHORITY` becomes `'rollback_when_eligible'`. A session is created with
`twin_arm.authority: "rollback"` (default remains advisory, so no existing caller changes) and
the gate grants it only if every condition holds, checked at session create and stated in the
response; otherwise the session is refused, not silently downgraded:

1. `canary_weight` 0.5 and the sample-ratio guard on (`alpha_srm` > 0).
2. Every metric is a `rate` metric, or a `sign` metric **with a declared `margin`** (ADR 0037). An
   unmargined `sign` metric is ineligible: measured 12/44 on a real service.
3. Tick 60 s, at most 60 scored ticks, and a warm-up of at least 15 ticks excluded by the caller,
   which are the conditions both T3 studies ran at. Longer bakes are ineligible until measured
   (persistent arm state accumulates with the horizon: engine T1, 0.165 over 2,000 ticks).
4. `alpha_rollback` ≤ 0.05.
5. The service is **qualified** (D2).
6. **The metric set counts unanswered requests.** Target 5xx and p99 alone passed twenty runs of a
   canary dropping 0.5% of its connections (§5, `AB-reset`): a dropped request produces no target
   response, the load balancer's own 502 is published per load balancer only, and the request is
   still counted as routed. An eligible session declares a `rate` metric whose events are requests
   the target never answered — on ALB CloudWatch, `RequestCount` minus the target 2xx/3xx/4xx/5xx
   sums per target group (the `no_response` construction, 20 of 20 at tick 12) — or an equivalent
   client-side or mesh failure rate. That metric needs an A/A with it declared before a service's
   qualification counts it (none has run; §5).
7. **Arm size and placement:** to be set from `2026-10-twin-aa-onebox` before the implementation PR.
   Measured so far: two tasks per arm failed on a 1 ms service without a margin; four passed on a
   76 ms service with one. One task per arm, in the same AZ and across AZs, is the open row.

For an eligible session: the record is `mode: 'enforce'`, `GET /v1/verdict` serves the rollback
code, the tick response carries `"authority": "rollback"`, and the verdict enters the audit record
as a rollback with its `detector_id`. Nothing else about the twin path changes.

**D2. Authority is per service, after that service's own A/A.** The T3 evidence is one synthetic
service. The first study showed the premise can fail for a reason invisible in advance (a fast
service, two tasks per arm), so a pass elsewhere does not transfer. Before a service's sessions
may carry rollback authority, the operator runs **30 A/A sessions** on that service, at the metric
set, margin, split and bake they will use, and the gate records at most **1** rollback. This
screens for gross failure and nothing finer: it rejects the first study's 0.27 with probability
0.999 and a true rate of 0.20 with 0.99; it passes a true rate of 0.01 with probability 0.96 and
0.03 with 0.77. The qualification record (run ids, verdicts, configuration hash, date) is stored
by the gate and expires when the metric set, margin, split or task count changes. Alternatives
considered: no qualification (rejected: it would extend one synthetic service's result to all);
100 sessions at the studies' bar (a week of bake time per service; the operator may choose it).

**D3. The proceed side stays advisory.** Every real run used `alpha_proceed` 1e-12 and ended
`hold`; no real-service study has tested a proceed verdict. An eligible session can veto a
rollout; it cannot approve one. Approval remains the operator's bake policy.

**D4. Policy gates run on twin sessions.** Today a profile or session that declares `twin_arm`
runs only the twin path and no rule table, policy gates included (`engine/gates/health.ts:89`).
With rollback authority that would let a rollout failing provenance or the artifact policy bake
under the twin. The security, artifact, provenance, contract and toolchain gates
(`POLICY_GATE_IDS`) run for twin sessions with their existing effect; they read no telemetry and
need no statistical validation. Families A–E and the structural rules still do not run beside the
twin.

**D5. Surfaces.** Authority applies to the gate service's HTTP contract, which the T3 runner
exercised in 164 real-service runs, two gate sessions each. The Argo `AnalysisTemplate` keeps its metric in
`dryRun` and the CodeDeploy hook stays advisory until each has been exercised end to end in a
registered run; neither has.

## 4. What this ADR does not claim

- That the false-rollback rate is at or below α. The claim is "not grossly above α at one service,
  and screened per service by D2".
- Detection of faults other than the four shapes in §5, or of a fault that arrives at random: the
  study's faults are evenly spaced per process, so the measured tick spreads (11, 38–42, 11–12)
  understate what a random-arrival fault of the same rate would show. Sized synthetically on
  2026-10-03 (engine study `2026-10-twin-rate-random-arrivals`, T1, at the real cells' traffic):
  random arrivals at ×1.5 leave 6.6% of 60-tick bakes undecided (median tick 43 against 40), none
  at ×2, and detect 5.6% at ×1.2. The planner's figure is a median under either arrival model; it
  gives no spread. A real random-arrival cell has not run.
- Anything for failures the declared metrics do not count: client-side errors, timeouts as against
  resets, or an ALB-generated error the `no_response` subtraction does not capture.
- A rule for choosing the margin. It is the operator's minimum effect of interest per latency
  metric; D2's qualification is run at the chosen margin.
- Any authority for the temporal path. A session or profile with `twin_arm` never runs it; for
  every other profile Families A, C and D still hold rollback authority on evidence that failed
  on real telemetry (GWDG 0.91–0.95, BurstGPT 0.15). C87 is the companion decision and should be
  taken with this one, so the product does not carry two rollback authorities with opposite
  evidence.

## 5. Power (from `2026-10-twin-fault-shapes`, `studies/twin-fault-shapes/REPORT.md`)

| Cell | Registered bar | Result | Consequence for D1 |
|---|---|---|---|
| ×2 target 5xx (first study) | ≥ 16 of 20 | 20 of 20, `rate` first in 16, median tick 25 | `rate` eligible; planner verified at ×2 |
| `AB-lat30` (p99 +30%, 10% margin) | ≥ 16 of 20 | 20 of 20, every rollback at tick 11, `sign` detector in all | margined `sign` detects a 30% p99 regression in 11 ticks; smaller regressions unmeasured |
| `AB-5xx-1.5` (target 5xx ×1.5) | ≥ 10 of 20 in 60 ticks | 20 of 20, median tick 40 (38–42), `rate` detector in all; planner 44 | at about 6 baseline errors per arm per tick a one-hour bake detects ×1.5 and larger; the planner may size bakes at this traffic; see §4 on regularity |
| `AB-reset` (0.5% connections dropped) | none | 0 of 20 roll back; ELB 5xx 6.09 per tick on the lane; target 5xx and p99 unchanged; guard at 1 | target 5xx + p99 alone are not an eligible metric set (D1 item 6) |
| `AB-reset-nr` (the same, plus `no_response`) | ≥ 16 of 20 | 20 of 20, median tick 12, `no_response` detector in all; 6.08 unanswered per tick canary, 0 control | the subtraction metric sees what the ALB target metrics miss; its A/A is still owed |

Sample-ratio halts: 0 in 81 attempts.

## 6. Implementation, after acceptance (separate PR, separate authorization)

`TWIN_ARM_AUTHORITY` and an eligibility predicate in `engine/guarantees.ts`; session create and
record mode in `service/gate-http/_gate-twin.ts`; the qualification store and its expiry; policy
gates on the twin path (`engine/gates/health.ts`, `_health-twin.ts`); `test/twin-authority.test.ts`
and `test/twin-dormancy.test.ts` rewritten to state the new contract; `DORMANCY.md` Plan B from
`dormant` to `conditional-active` with this ADR as the mechanism; the HTTP README. The Argo
template and CodeDeploy hook are untouched (D5).

## 7. Reversal

- A registered real-service A/A at an eligible configuration failing its E1, on any service:
  authority returns to advisory for that configuration class until explained.
- `AB-lat30` failing with rollbacks on the wrong detector, or a qualified service later showing
  rollbacks on identical arms above D2's screen: that service's qualification is revoked.
- An arm-level effect larger than a declared margin found on a real fleet: the margin premise is
  restated or the `sign` kind leaves D1's eligible set; latency as a `rate` over an SLO threshold
  (ADR 0037's fallback) is the replacement design.

## 8. Options at drafting (decided: option 1, with D1 item 6 added from the fault study)

1. **Accept D1–D5 after the fault-shape study reports** (recommended). It grants only what was
   measured, makes generality the operator's 30-session screen instead of an assumption, and keeps
   approval out of scope.
2. **Accept for the `rate` kind only.** Drops condition 2's `sign` clause until `AB-lat30` and a
   non-synthetic service exist. Smaller claim, simpler eligibility, no latency veto.
3. **Stay advisory** and collect a non-synthetic service's A/A first. No risk of a wrongful
   automated rollback; the gate remains a report nobody is obliged to act on.

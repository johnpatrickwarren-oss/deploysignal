# ADR 0002 — Self-calibration: the gate measures its own false-alarm rate on the service's undeployed history and shows it beside every advisory fire

- **Date:** 2026-10-03
- **Status:** ACCEPTED 2026-10-03 (`0002-self-calibration-ACCEPTANCE.md`: A1–A4 hold; A4 in the study's own
  configuration, with the shipped configuration's unreachable threshold recorded and served as
  `unreachable_signals`). No authority changes: a measurement and a field, not a verdict. Implemented by
  `tools/self-calibrate.ts`, `service/session/self-calibration.ts` and the `self_calibration` field on tick
  and verdict responses; attachment to individual advisory fires follows C87.
- **Author and conflict of interest:** written by the session that designed and ran every study it
  cites, for the project's owner; no outside review.
- **Register:** knowledge `WORKLIST.md` C87 (the temporal path's authority); DeploySignal ADR 0001;
  knowledge `stats/temporal-null-real-2026-10-03`, `stats/gwdg-gate-2026-09-29`,
  `stats/burstgpt-gate-2026-09-29`; the 2026-10-03 design note (John): two modes, a comparator mode
  with authority and a before-and-after mode that gives a picture with its error rate measured.

## 1. The question

The temporal path (Families A, B, C, D, E: a service compared with its own calibrated history) has a
measured real-telemetry false-rollback rate of 0.909 on GPU node telemetry, 0.149 on an LLM request
stream and 0.000 on a steady HTTP service. The rate is a property of the service, not of the
detector. An operator reading one of its fires has no way to know which of those three worlds
they are in. Should the gate measure that rate itself, on the service it is pointed at, and show it?

## 2. Decision

Yes. **Self-calibration** is a procedure the gate runs on a service before, and periodically while,
the temporal path advises on it:

1. Take the service's recent metric history from its configured source (the CloudWatch or
   Prometheus `MetricSource`), at the gate's tick width, for a declared span (default 7 days,
   minimum 2).
2. Remove every window that contains a change: deploys and configuration changes from the
   lifecycle store's session records and, where a CloudTrail or equivalent write log is
   configured, from it; each exclusion is listed. Remaining contiguous spans are the **undeployed
   history**.
3. Calibrate exactly as production would (`tools/calibrate`, the shipped families and α budget),
   from the first part of the undeployed history (default the first half, minimum 24 h), and replay
   the shipped `orchestrate` over non-overlapping sessions of the gate's configured length on the
   rest, as `studies/temporal-null-real/harness/run.mjs` does.
4. Record, per family and in total: sessions replayed, sessions with a rollback-class fire, the
   exact 95% upper bound on the per-session rate, the ids that fired and the ticks, the holds, and
   the span and exclusions used. Store it in the lifecycle store as `self_calibration` with its
   timestamp, the engine version and the compiled config's hash.
5. Serve it. Every advisory fire the gate reports (`advisory_fires` on tick and verdict responses,
   C87) carries `self_calibration: { sessions, fires, upper95, measured_at, stale }` for the family
   that fired, and the verdict record carries the whole object. `stale` is true when the measurement
   is older than the declared span or the compiled config has changed since. A service with no
   self-calibration reports `self_calibration: null`, and its advisory fires say so.

Nothing in this ADR turns an advisory fire into a rollback or a rollback into an advisory. It makes
the number that decides whether a fire is worth reading visible at the fire.

## 3. Rejected

- *Gating authority on the measured rate* ("authority if the rate is under α"). Rejected: 100
  sessions bound the rate at about 3%, far above any family's α share, and a rate measured on last
  week's history is a model of next week. Authority stays with designed nulls (ADR 0001).
- *A single pooled rate across families.* Rejected: the families differ by orders of magnitude on
  the same substrate (GWDG: A alone 0.909, with C 0.955), and an operator reads one fire at a time.
- *Running it only at onboarding.* Rejected: the GWDG result was on four days of history from the
  same node; the rate drifts with the service. Periodic, with `stale` when overdue.

## 4. What it does not do

It does not measure power (no regression is injected). It does not attribute a change in a
before-and-after picture to the deploy. It does not make the undeployed history a null in the
theorem's sense; it measures how far from one it is. It cannot see changes that leave no record.

## 5. Consequences

- A new tool entry point, `tools/self-calibrate`, and a lifecycle-store record; the gate HTTP
  responses gain the field; the Argo and CodeDeploy integrations pass it through unchanged.
- `studies/temporal-null-real` becomes the procedure's first run, by hand; the feature reproduces
  its result as its acceptance test (§6).
- Cost: one calibration and one replay per service per span; on the prod-old series the whole
  procedure took under a minute.

## 6. Acceptance study (`2026-10-self-calibration`, registered here, before any code)

- **A1 (reproduction).** Pointed at the four `prod-old` series with the deploy windows the study
  excluded, the feature reproduces `2026-10-temporal-null-real`: 100 sessions, 0 rollback-class
  fires, upper bound 0.030, Family B `low_traffic` holds in 81 sessions, Family A signals
  `p99_latency` and `downstream_err`, Family D not evaluated.
- **A2 (exclusion).** On the same series with two synthetic deploy records inserted at known
  times, the two windows containing them are excluded and listed, and the session count falls by
  exactly the sessions those windows covered.
- **A3 (the field).** A gate session on a service with a stored self-calibration serves it on
  every advisory fire; on a service without one serves `null` and the fire says so; a measurement
  older than its span or on a changed config serves `stale: true`.
- **A4 (a failing substrate).** Pointed at the GWDG unit the gate study rolled back on its null
  window, the feature reports a rate consistent with that study's per-unit result for the same
  windows; the point of the feature is that this number is shown, so the test is that it is.

Acceptance rule: A1–A4 hold. Then ACCEPTED and the implementation merges with its own
authorization; otherwise the failing item is reported and the ADR stays PROPOSED.

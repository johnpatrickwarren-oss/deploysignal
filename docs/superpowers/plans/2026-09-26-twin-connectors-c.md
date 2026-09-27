# Plan C — twin-gate metric sources and the CodeDeploy hook

Date: 2026-09-26. Branch `wt/twin-connectors-c`. Engine premise: deploysignal-engine v0.12.0-pre
(ADR 0036, randomized twin). Plan B (gate service, `/v1/sessions` twin mode) is built in parallel;
this plan consumes only the shared HTTP contract and touches none of B's files (`engine/gates/*`,
`service/gate-http/*`, `profiles/*`, `engine/guarantees.ts`, `DORMANCY.md`, the Argo template).

## Tasks (each: failing test first, then code, then full suite, then a pathspec commit)

1. **Contract types and the source interface.** `service/sources/twin-contract.ts` carries the
   snake_case wire types: `TwinTickBody`, `TwinRateObservationBody`, `TwinSignObservationBody`,
   `TwinSessionRequest`, `TwinTickResponse`, plus `assertTwinTickBody` (integer, non-negative counts;
   finite sign values). `service/sources/metric-source.ts` declares
   `MetricSource.fetchTick(windowStartMs, windowEndMs): Promise<TwinTickBody>`.
2. **CloudWatch source.** `service/sources/cloudwatch.ts`, injected client with a `send` method
   (the `@aws-sdk/client-cloudwatch` `CloudWatchClient` satisfies it). One `GetMetricDataCommand` per
   window, `Period` = window length (a multiple of 60 s), paginated on `NextToken`. Per target group:
   `RequestCount` Sum -> arm totals and `canary_requests`/`control_requests`;
   `HTTPCode_Target_5XX_Count` Sum -> rate events; `TargetResponseTime` p99 -> sign. Sums are
   rounded to integers. A sign metric at a declared canary weight other than 0.5 is refused at
   construction. Tests use a fake client; no live AWS call exists anywhere.
3. **Prometheus source.** `service/sources/prometheus.ts`, injected `fetch` against
   `/api/v1/query` with `time` = window end and `$window` substituted by the window in seconds.
   Counters -> rate (`increase`), histogram exceedance `count - bucket{le=L}` -> rate (usable at
   any weight), gauges -> sign. Tests use a fake fetch. An opt-in integration test
   (`DS_PROM_INTEGRATION=1`) starts `prom/prometheus` in Docker; skipped by default.
4. **CodeDeploy AfterAllowTraffic hook.** `integrations/codedeploy/after-allow-traffic.ts` plus a
   small contract client `integrations/codedeploy/twin-gate-client.ts` (injected fetch). Opens a
   twin session, ticks the source until a terminal verdict or `max_ticks`, then calls
   `PutLifecycleEventHookExecutionStatus` on an injected client. Advisory: status `Succeeded`
   for every verdict and for gate errors, with the verdict logged. `enforce` (default false) maps
   rollback/halt/hold to `Failed`, and only takes effect when the gate response's `authority` is
   not `advisory`, so no path fails a rollout while `TWIN_ARM_AUTHORITY` is advisory.
5. **Docs.** `ORCHESTRATION-ADAPTERS.md` gains a twin-gate section: the three-target-group topology
   (prod-old, baseline-old at the canary weight, canary-new), why a CodeDeploy canary against the
   warm production fleet violates the premise at start-up, and why sign needs equal weights.

Dependencies: `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-codedeploy` (runtime deps; the code
imports only command classes, clients are injected).

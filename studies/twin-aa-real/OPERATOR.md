# Operator checklist — `2026-10-twin-aa-real` (T3)

For the person running the study. The protocol is `PREREGISTRATION.md`; where this file and the
protocol differ, the protocol wins. Nothing here gives the twin gate authority: every verdict the
runner prints is advisory.

## 1. Provision (per lane; up to 4 lanes)

- [ ] An HTTP service meeting R1 to R8 (PREREGISTRATION.md §1): ALB in one region, the old
      version as one image digest, at least 1000 requests per arm per minute, an expected 5 or
      more target 5xx per arm per minute (or a disclosed fixed 503 fraction in both versions).
- [ ] One listener rule with a weighted forward action to three target groups: `prod-old`
      (weight 1 − 2w), `baseline-old` (w), `canary-new` (w), with w in [0.05, 0.25], equal on
      the two arms, fixed for the study.
- [ ] Target-group stickiness on the forward action off; cross-zone load balancing on; no other
      rule routing to either arm; identical target-group attributes on the two arms.
- [ ] Deploy automation that, per run, starts fresh `baseline-old` and `canary-new` targets together
      (same task definition revision, same count, same count per AZ, ≥ 2 per arm), and stops them
      after the run. In AA both run the old version.
- [ ] A host for the runner and the gate that stays awake for 80 minutes per run (an EC2 instance
      is simplest; a laptop needs AC power, the lid open and `caffeinate -dims`).
- [ ] Optional AB-5xx: the service carries a flag that adds target 503s on the canary only.
- [ ] Optional AB-lat: `enableFaultInjection` on both arms' task definition from AA run 0, and an
      AWS FIS experiment template for `aws:ecs:task-network-latency` targeting only the
      `canary-new` tasks.

## 2. IAM

The runner needs one read-only permission:

```json
{ "Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*" }
```

(`GetMetricData` supports no resource-level scoping.) Give the runner host nothing else.

Outside the runner, and only for the operator's own role:

- Deploying and stopping the arms: whatever the deploy automation uses (ECS or Auto Scaling
  write permissions). The runner never holds these.
- Evidence for void rules V6 and V7: `cloudtrail:LookupEvents`, `ecs:DescribeServices`,
  `elasticloadbalancing:DescribeRules`, `elasticloadbalancing:DescribeTargetGroupAttributes`
  (read-only).
- CodeDeploy, only if the arms are deployed through a CodeDeploy `AfterAllowTraffic` hook:
  `codedeploy:PutLifecycleEventHookExecutionStatus` for the hook's Lambda role. This study's
  runner does not use the hook; with the hook in place, it stays advisory and reports `Succeeded`
  for every verdict.
- Optional AB-lat: `fis:StartExperiment`, `fis:GetExperiment`, `fis:StopExperiment` and the FIS
  service role for the ECS action.

## 3. Record before run 0

Everything in PREREGISTRATION.md §8 "Before run 0", kept outside the repo if it holds account
identifiers. Then fill one config per lane from `config.example.json` (region, `LoadBalancer` and
`TargetGroup` dimension values, `tasks_per_arm`, gate URL). Keep filled configs out of git.

## 4. Start

```sh
npm ci && npm run build && npx tsc -p tsconfig.test.json
DS_GATE_SHARED_SECRET=<secret> node service/gate-http/server.js &     # binds 127.0.0.1:8790
node studies/twin-aa-real/harness/run-real.mjs --config lane0.json --check-config
```

Per run, in order:

1. Deploy fresh `baseline-old` and `canary-new` (both old version in AA). Wait until every target in
   both groups is healthy: that minute is arm-ready.
2. Start the runner (it picks the next minute boundary as window 0):
   `DS_GATE_SHARED_SECRET=<secret> node studies/twin-aa-real/harness/run-real.mjs --config lane0.json --cell AA --run <k>`
   Run indices are global across lanes, assigned in the order runs start. A voided run is replaced
   by the next index, never repeated.
3. Do not touch either arm, the listener rule or the weights for about 78 minutes. Record any event
   you did not cause (a scaling action, an alarm, an outside load test) at the time it happens,
   before you look at the run's verdict.
4. When the runner exits, note the per-run items of §8 (digests, task ARNs and AZs, event
   evidence), then stop both arms.

The runner writes `results/runs/<cell>-l<lane>-r<k>-<UTC>.json` and rewrites it after every window.
It prints mechanical void reasons (V1 to V5) at the end; V6 and V7 are yours to check against
CloudTrail and ECS events.

Stop the AA cell after 100 executable runs, or as soon as 11 executable runs have rolled back.

## 5. Abort

- **One run:** Ctrl-C the runner. It writes the partial record with `runner_error: "aborted by
  operator (SIGINT)"`; the run is void (V5) and the next run takes the next index. Its gate
  sessions expire after the gate's idle TTL (3600 s).
- **The study:** Ctrl-C the runner, set the `baseline-old` and `canary-new` weights to 0 (traffic
  returns to `prod-old`), stop both arms, stop the gate. The study is reported with every run so far
  and no endpoint verdict on an incomplete cell (PREREGISTRATION.md §7 "Abort").
- **Anything unexpected in production** (errors or latency outside the experiment's arms): abort
  the study first, investigate second. The twin gate is advisory; no verdict from it is a reason
  to keep the experiment running.

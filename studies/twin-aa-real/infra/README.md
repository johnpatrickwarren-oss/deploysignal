# Infrastructure for `2026-10-twin-aa-real` (the real-service A/A of the twin gate)

Everything here exists to meet the study's requirements R1 to R8 (`../PREREGISTRATION.md` §1) and
the operator checklist (`../OPERATOR.md`) with a synthetic service, so that the A/A can run without
borrowing a production system. Nothing here touches the runner or the gate: the runner stays
observe-only (§3.5) and reads `lane<N>.json`, which `scripts/lane-config.sh` writes from stack
outputs.

Stacks (CloudFormation, one region):

| Stack | File | Instances | What it makes |
|---|---|---|---|
| network | `cloudformation/network.yaml` | 1 | VPC, two public subnets (no NAT), security groups |
| ecr | `cloudformation/ecr.yaml` | 1 | the ECR repository for the service image |
| lane | `cloudformation/lane.yaml` | 1 per lane (up to 4) | an internal ALB, one listener with one weighted rule to `prod-old` (1 − 2w), `baseline-old` (w), `canary-new` (w); three identical target groups; an ECS cluster, one Fargate task definition, three services (`prod-old` steady, the two arms at desired count 0 between runs); a log group |
| host | `cloudformation/host.yaml` | 1 | an EC2 instance in the VPC that runs the gate, the runner and the load generator; instance profile = `cloudwatch:GetMetricData` only |

Requirement mapping:

- **R1** HTTP service behind an ALB on ECS Fargate, one region: `lane.yaml`.
- **R2** one image digest deployable as independent services: `ecr.yaml` + the digest recorded in
  the §8 record; every service in a lane references the same task-definition revision.
- **R3** ≥ 1,000 requests per arm per minute: `scripts/loadgen.mjs` at ≥ 35 requests/s per lane
  with w = 0.25 (each arm then sees ≥ 17.5/s ≈ 1,050 per minute). Seed and mix recorded.
- **R4** ≥ 5 target 5xx per arm per tick: the service returns 503 on a fixed fraction of requests
  from the same code path in both arms (`FAULT_503_FRACTION`, default 0.005 → ≥ 5 per 1,050).
  Disclosed as in the protocol; the rate cells then test routing and counting, not a failure
  mechanism. AB-5xx raises the fraction on the canary service only (a configuration difference).
- **R5** equal arms: both arm services use the same task definition, count, subnets and
  attributes; `scripts/rotate-arms.sh start` starts them together and waits for every target to be
  healthy before printing arm-ready.
- **R6** stickiness off, cross-zone on, one rule, identical attributes: `lane.yaml` (the ALB's
  cross-zone attribute is on; the rule's `TargetGroupStickinessConfig` is disabled; the three
  target groups share one attribute set).
- **R7** ALB CloudWatch metrics at 60 s: the ALB default; the runner reads them with
  `GetMetricData` from the host's instance profile.
- **R8** a host that stays up: `host.yaml` (an EC2 instance, no sleep).

## Order of work

0. Decisions recorded in the §8 study record (outside the repo): region, w (recommended 0.25),
   `FAULT_503_FRACTION` (recommended 0.005), tasks per arm (≥ 2), lanes (recommended 4), whether
   AB cells run.
1. `aws cloudformation deploy --stack-name twin-aa-network --template-file cloudformation/network.yaml`
2. `aws cloudformation deploy --stack-name twin-aa-ecr --template-file cloudformation/ecr.yaml`
3. Build and push the service image once (`service/`), record the digest:
   `docker build -t <repo>:old service && docker push …` → `aws ecr describe-images` for the digest.
4. Per lane N: `aws cloudformation deploy --stack-name twin-aa-lane<N> --template-file cloudformation/lane.yaml --parameter-overrides NetworkStack=twin-aa-network LaneId=<N> ImageUri=<repo>@<digest> WeightPercent=25 Fault503Fraction=0.005 ProdTasks=2 --capabilities CAPABILITY_NAMED_IAM`
5. `aws cloudformation deploy --stack-name twin-aa-host --template-file cloudformation/host.yaml --parameter-overrides NetworkStack=twin-aa-network KeyName=<key> OperatorCidr=<ip>/32 --capabilities CAPABILITY_NAMED_IAM`
6. On the host: clone the repo at the study commit, `npm ci && npm run build && npx tsc -p tsconfig.test.json`,
   `scripts/lane-config.sh twin-aa-lane<N> <N> > studies/twin-aa-real/lane<N>.json` for each lane,
   start the gate, `run-real.mjs --check-config`.
7. Start the load generator on the host against each lane's ALB DNS name (from the stack outputs),
   seed and rate recorded.
8. Register the dated amendment naming the CloudWatch queries (§3.1 requires it before run 0).
9. Per run: `scripts/rotate-arms.sh start …` → arm-ready → runner within 300 s → 78 min hands
   off → `scripts/rotate-arms.sh stop …`. The script prints one JSON line per weight change for the
   run record.

## What this does not do

It does not create IAM users, credentials, or the operator role: the operator's own profile runs
the rotation script and the stack deploys. It does not automate the §8 record. It does not run
anything: no stack in this directory has been deployed by the author.

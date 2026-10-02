#!/usr/bin/env bash
# studies/twin-aa-real/infra/scripts/rotate-arms.sh — the between-run weight procedure (OPERATOR.md §4,
# "Between-run weight procedure") for one lane, under the OPERATOR's profile (never the runner host's).
#
#   rotate-arms.sh start --stack twin-aa-lane0 --tasks 2 [--profile p] [--region r]
#       1. set the rule weights to prod 100 / baseline 0 / canary 0 (live traffic never reaches an
#          empty target group);
#       2. scale both arm services to --tasks with the same task-definition revision, together;
#       3. wait until every target in BOTH arm target groups is healthy;
#       4. set the weights to prod 100-2w / baseline w / canary w in ONE call;
#       5. print arm-ready (the time of step 4's completion, ISO-8601) — start the runner within 300 s.
#   rotate-arms.sh stop  --stack twin-aa-lane0 [--profile p] [--region r]
#       weights to prod 100 / 0 / 0, then both arms to desired count 0.
#
# Every weight change is printed as one JSON line for the run record (time, old, new). CloudTrail
# event ids are looked up afterwards (they lag by minutes): rotate-arms.sh events --stack ... --since <ISO>.
# Requires: aws cli v2, jq. Exits non-zero on any failure; never continues past a failed step.
set -euo pipefail
cmd="${1:-}"; shift || true
STACK=""; TASKS=""; PROFILE=""; REGION=""; SINCE=""; TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) STACK="$2"; shift 2;;
    --tasks) TASKS="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --since) SINCE="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$STACK" ] || { echo "--stack required" >&2; exit 2; }
AWS=(aws); [ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE"); [ -n "$REGION" ] && AWS+=(--region "$REGION")
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
out() { "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

LISTENER=$(out ListenerArn); PROD_TG=$(out ProdTargetGroupArn); BASE_TG=$(out BaselineTargetGroupArn); CAN_TG=$(out CanaryTargetGroupArn)
CLUSTER=$(out ClusterName); W=$(out WeightPercent); PROD_W=$((100 - 2 * W))

current_weights() {
  "${AWS[@]}" elbv2 describe-listeners --listener-arns "$LISTENER" \
    --query "Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[].{tg:TargetGroupArn,w:Weight}" --output json
}
set_weights() {  # prod base canary
  local old; old=$(current_weights)
  "${AWS[@]}" elbv2 modify-listener --listener-arn "$LISTENER" --default-actions "[{\"Type\":\"forward\",\"ForwardConfig\":{\"TargetGroupStickinessConfig\":{\"Enabled\":false},\"TargetGroups\":[{\"TargetGroupArn\":\"$PROD_TG\",\"Weight\":$1},{\"TargetGroupArn\":\"$BASE_TG\",\"Weight\":$2},{\"TargetGroupArn\":\"$CAN_TG\",\"Weight\":$3}]}}]" > /dev/null
  echo "{\"t\":\"$(now)\",\"event\":\"weights\",\"stack\":\"$STACK\",\"old\":$(echo "$old" | jq -c .),\"new\":{\"prod\":$1,\"baseline\":$2,\"canary\":$3}}"
}
healthy_count() { "${AWS[@]}" elbv2 describe-target-health --target-group-arn "$1" --query "length(TargetHealthDescriptions[?TargetHealth.State=='healthy'])" --output text; }
registered_count() { "${AWS[@]}" elbv2 describe-target-health --target-group-arn "$1" --query "length(TargetHealthDescriptions)" --output text; }
service_revision() { "${AWS[@]}" ecs describe-services --cluster "$CLUSTER" --services "$1" --query "services[0].taskDefinition" --output text; }

case "$cmd" in
  start)
    # R5 asks for >= 2 tasks per arm; 2026-10-twin-aa-onebox registers one (ALLOW_ONEBOX=1 states that on purpose)
    [ -n "$TASKS" ] && { [ "$TASKS" -ge 2 ] || { [ "$TASKS" -eq 1 ] && [ "${ALLOW_ONEBOX:-}" = "1" ]; }; } || { echo "--tasks N (>= 2, R5; 1 only with ALLOW_ONEBOX=1) required" >&2; exit 2; }
    rb=$(service_revision baseline-old); rc=$(service_revision canary-new)
    [ "$rb" = "$rc" ] || { echo "R5 violated before start: baseline-old $rb != canary-new $rc (AB-5xx cell only)" >&2; [ "${ALLOW_AB:-}" = "1" ] || exit 3; }
    set_weights 100 0 0
    t_scale=$(now)
    "${AWS[@]}" ecs update-service --cluster "$CLUSTER" --service baseline-old --desired-count "$TASKS" > /dev/null
    "${AWS[@]}" ecs update-service --cluster "$CLUSTER" --service canary-new  --desired-count "$TASKS" > /dev/null
    echo "{\"t\":\"$t_scale\",\"event\":\"scale\",\"stack\":\"$STACK\",\"tasks_per_arm\":$TASKS,\"revision\":\"$rb\"}"
    deadline=$(( $(date +%s) + TIMEOUT ))
    while :; do
      hb=$(healthy_count "$BASE_TG"); hc=$(healthy_count "$CAN_TG"); nb=$(registered_count "$BASE_TG"); nc=$(registered_count "$CAN_TG")
      if [ "$hb" -eq "$TASKS" ] && [ "$hc" -eq "$TASKS" ] && [ "$nb" -eq "$TASKS" ] && [ "$nc" -eq "$TASKS" ]; then break; fi
      [ "$(date +%s)" -lt "$deadline" ] || { echo "{\"t\":\"$(now)\",\"event\":\"deploy_failure\",\"baseline_healthy\":$hb,\"canary_healthy\":$hc}"; echo "arms not healthy within ${TIMEOUT}s: a deploy failure (counts as an attempt, not a run)" >&2; exit 4; }
      sleep 10
    done
    set_weights "$PROD_W" "$W" "$W"
    ARM_READY=$(now)
    echo "{\"t\":\"$ARM_READY\",\"event\":\"arm_ready\",\"stack\":\"$STACK\",\"baseline_healthy\":$TASKS,\"canary_healthy\":$TASKS}"
    echo "ARM_READY=$ARM_READY" >&2
    ;;
  stop)
    set_weights 100 0 0
    "${AWS[@]}" ecs update-service --cluster "$CLUSTER" --service baseline-old --desired-count 0 > /dev/null
    "${AWS[@]}" ecs update-service --cluster "$CLUSTER" --service canary-new  --desired-count 0 > /dev/null
    echo "{\"t\":\"$(now)\",\"event\":\"stop\",\"stack\":\"$STACK\"}"
    ;;
  tasks)   # the per-run record: task ARNs and AZs of both arms (section 8)
    for svc in baseline-old canary-new; do
      arns=$("${AWS[@]}" ecs list-tasks --cluster "$CLUSTER" --service-name "$svc" --query "taskArns" --output json)
      [ "$(echo "$arns" | jq length)" -gt 0 ] || { echo "{\"service\":\"$svc\",\"tasks\":[]}"; continue; }
      "${AWS[@]}" ecs describe-tasks --cluster "$CLUSTER" --tasks $(echo "$arns" | jq -r '.[]') \
        --query "{service:'$svc',tasks:tasks[].{arn:taskArn,az:availabilityZone,td:taskDefinitionArn,status:lastStatus,started:startedAt}}" --output json | jq -c .
    done
    ;;
  events)  # V6/V7 evidence: CloudTrail write events on ELB and ECS since --since (lags a few minutes)
    [ -n "$SINCE" ] || { echo "--since <ISO> required" >&2; exit 2; }
    "${AWS[@]}" cloudtrail lookup-events --start-time "$SINCE" --lookup-attributes AttributeKey=ReadOnly,AttributeValue=false \
      --query "Events[?contains(EventSource,'elasticloadbalancing') || contains(EventSource,'ecs')].{t:EventTime,name:EventName,id:EventId,src:EventSource}" --output json | jq -c .
    ;;
  *) echo "usage: rotate-arms.sh start|stop|tasks|events --stack <lane stack> [--tasks N] [--since ISO] [--profile p] [--region r]" >&2; exit 2;;
esac

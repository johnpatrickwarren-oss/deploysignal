#!/usr/bin/env bash
# studies/twin-aa-real/infra/scripts/lane-config.sh — write lane<N>.json for the runner from a lane
# stack's outputs (config.example.json's shape; OPERATOR.md §3). Prints to stdout.
#   lane-config.sh <lane stack> <lane id> [--tasks N] [--profile p] [--region r] [--gate http://127.0.0.1:8790]
set -euo pipefail
STACK="${1:?lane stack}"; LANE="${2:?lane id}"; shift 2
TASKS=2; PROFILE=""; REGION=""; GATE="http://127.0.0.1:8790"
while [ $# -gt 0 ]; do case "$1" in --tasks) TASKS="$2"; shift 2;; --profile) PROFILE="$2"; shift 2;; --region) REGION="$2"; shift 2;; --gate) GATE="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
AWS=(aws); [ -n "$PROFILE" ] && AWS+=(--profile "$PROFILE"); [ -n "$REGION" ] && AWS+=(--region "$REGION")
out() { "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
jq -n --arg lane "$LANE" --arg region "$(out Region)" --arg lb "$(out LoadBalancerDimension)" \
  --arg canary "$(out CanaryTargetGroupDimension)" --arg control "$(out BaselineTargetGroupDimension)" \
  --arg idle "$(out IdleTimeoutSeconds)" --arg tasks "$TASKS" --arg gate "$GATE" '{
  study_id: "2026-10-twin-aa-real", lane: ($lane|tonumber), region: $region, load_balancer: $lb,
  target_groups: { canary: $canary, control: $control },
  alb_idle_timeout_s: ($idle|tonumber), tasks_per_arm: ($tasks|tonumber),
  gate: { base_url: $gate, token_env: "DS_GATE_SHARED_SECRET" } }'

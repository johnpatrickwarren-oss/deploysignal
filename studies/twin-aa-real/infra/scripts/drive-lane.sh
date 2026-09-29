#!/usr/bin/env bash
# studies/twin-aa-real/infra/scripts/drive-lane.sh — one lane's run loop, from the OPERATOR's machine
# (the profile that may rotate arms), driving the runner on the runner host over ssh.
#
#   drive-lane.sh --lane 0 --stack twin-aa-lane0 --host ec2-user@<ip> --key ~/.ssh/twin-aa-host.pem \
#                 --record ~/twin-aa-real-record --runs 25 --first-run 0 [--cell AA] [--tasks 2] [--profile p] [--region r]
#
# Per run k (OPERATOR.md §4, in order): rotate-arms.sh start → arm-ready; within 300 s start the runner on
# the host (`run-real.mjs --cell AA --run k --arm-ready <ISO>`); wait for it to exit (~78 min); record
# both arms' tasks; rotate-arms.sh stop; look up CloudTrail write events since arm-ready (V6/V7 evidence);
# append everything to <record>/runs/<cell>-l<lane>-r<k>.ndjson. Nothing here reads a verdict: the runner
# writes them to its own files on the host and this script never opens them (record events first, per §4.3).
#
# Run indices are GLOBAL across lanes: give each lane a disjoint --first-run/--runs range (e.g. lane 0 runs
# 0–24, lane 1 25–49, ...), or use --index-file <path> so lanes share one counter (flock).
# A deploy failure (arms never healthy) is logged, counts as an attempt, and the loop continues with the
# next index. Ctrl-C stops after the current step; the operator then stops the arms by hand.
set -uo pipefail
LANE=""; STACK=""; HOST=""; KEY=""; RECORD=""; RUNS=""; FIRST=""; CELL="AA"; TASKS=2; PROFILE=""; REGION=""; INDEX_FILE=""
while [ $# -gt 0 ]; do case "$1" in
  --lane) LANE="$2"; shift 2;; --stack) STACK="$2"; shift 2;; --host) HOST="$2"; shift 2;; --key) KEY="$2"; shift 2;;
  --record) RECORD="$2"; shift 2;; --runs) RUNS="$2"; shift 2;; --first-run) FIRST="$2"; shift 2;; --cell) CELL="$2"; shift 2;;
  --tasks) TASKS="$2"; shift 2;; --profile) PROFILE="$2"; shift 2;; --region) REGION="$2"; shift 2;; --index-file) INDEX_FILE="$2"; shift 2;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
for v in LANE STACK HOST KEY RECORD RUNS; do [ -n "${!v}" ] || { echo "--$(echo $v | tr A-Z a-z) required" >&2; exit 2; }; done
[ -n "$FIRST" ] || [ -n "$INDEX_FILE" ] || { echo "--first-run or --index-file required" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
ROT=("$HERE/rotate-arms.sh"); [ -n "$PROFILE" ] && PROF=(--profile "$PROFILE") || PROF=(); [ -n "$REGION" ] && REG=(--region "$REGION") || REG=()
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$HOST")
mkdir -p "$RECORD/runs"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
next_index() {
  if [ -n "$INDEX_FILE" ]; then ( flock 9; k=$(cat "$INDEX_FILE" 2>/dev/null || echo 0); echo $((k + 1)) > "$INDEX_FILE"; echo "$k" ) 9>>"$INDEX_FILE.lock"
  else echo $((FIRST + done_runs)); fi
}
done_runs=0
while [ "$done_runs" -lt "$RUNS" ]; do
  k=$(next_index); LOG="$RECORD/runs/$CELL-l$LANE-r$k.ndjson"
  echo "{\"t\":\"$(now)\",\"event\":\"attempt\",\"cell\":\"$CELL\",\"lane\":$LANE,\"run\":$k}" | tee -a "$LOG"
  START_OUT=$("${ROT[@]}" start --stack "$STACK" --tasks "$TASKS" "${PROF[@]}" "${REG[@]}" 2>"$RECORD/runs/$CELL-l$LANE-r$k.rotate.err"); rc=$?
  echo "$START_OUT" >> "$LOG"
  if [ $rc -ne 0 ]; then echo "{\"t\":\"$(now)\",\"event\":\"deploy_failure\",\"run\":$k,\"rc\":$rc}" | tee -a "$LOG"; "${ROT[@]}" stop --stack "$STACK" "${PROF[@]}" "${REG[@]}" >> "$LOG" 2>&1; done_runs=$((done_runs + 1)); continue; fi
  ARM_READY=$(echo "$START_OUT" | jq -r 'select(.event=="arm_ready") | .t' | tail -1)
  [ -n "$ARM_READY" ] || { echo "{\"t\":\"$(now)\",\"event\":\"driver_error\",\"run\":$k,\"reason\":\"no arm_ready line\"}" | tee -a "$LOG"; "${ROT[@]}" stop --stack "$STACK" "${PROF[@]}" "${REG[@]}" >> "$LOG" 2>&1; exit 5; }
  # the runner, within 300 s of arm-ready, detached on the host (nohup + setsid) so a dropped ssh session
  # cannot kill it; this side polls a done marker every 60 s. Its own files hold the verdicts.
  echo "{\"t\":\"$(now)\",\"event\":\"runner_start\",\"run\":$k,\"arm_ready\":\"$ARM_READY\"}" | tee -a "$LOG"
  "${SSH[@]}" "cd ~/deploysignal && rm -f ~/runner-$CELL-l$LANE-r$k.done && (DS_GATE_SHARED_SECRET=\$(cat ~/.gate-secret) setsid nohup sh -c 'node studies/twin-aa-real/harness/run-real.mjs --config studies/twin-aa-real/lane$LANE.json --cell $CELL --run $k --arm-ready $ARM_READY > ~/runner-$CELL-l$LANE-r$k.out 2>&1; echo \$? > ~/runner-$CELL-l$LANE-r$k.done' > /dev/null 2>&1 &) ; sleep 2; pgrep -f 'run-real.mjs.*--run $k ' > /dev/null && echo RUNNER_PID_OK || echo RUNNER_NOT_RUNNING" > "$RECORD/runs/$CELL-l$LANE-r$k.runner.out" 2>&1
  grep -q RUNNER_PID_OK "$RECORD/runs/$CELL-l$LANE-r$k.runner.out" || echo "{\"t\":\"$(now)\",\"event\":\"runner_not_started\",\"run\":$k}" | tee -a "$LOG"
  RUNNER_EXIT=""; waited=0
  while [ -z "$RUNNER_EXIT" ] && [ $waited -lt 6600 ]; do
    sleep 60; waited=$((waited + 60))
    RUNNER_EXIT=$("${SSH[@]}" "cat ~/runner-$CELL-l$LANE-r$k.done 2>/dev/null" 2>/dev/null || true)
  done
  RUNNER_EXIT=${RUNNER_EXIT:-timeout_or_unreachable}
  echo "{\"t\":\"$(now)\",\"event\":\"runner_exit\",\"run\":$k,\"exit\":\"$RUNNER_EXIT\",\"waited_s\":$waited}" | tee -a "$LOG"
  "${ROT[@]}" tasks --stack "$STACK" "${PROF[@]}" "${REG[@]}" >> "$LOG" 2>&1
  "${ROT[@]}" stop --stack "$STACK" "${PROF[@]}" "${REG[@]}" >> "$LOG" 2>&1
  # CloudTrail lags: look up events for the run's interval after a settle, before anyone opens the verdict
  sleep 120; "${ROT[@]}" events --stack "$STACK" --since "$ARM_READY" "${PROF[@]}" "${REG[@]}" >> "$LOG" 2>&1
  echo "{\"t\":\"$(now)\",\"event\":\"run_closed\",\"run\":$k}" | tee -a "$LOG"
  done_runs=$((done_runs + 1))
done
echo "{\"t\":\"$(now)\",\"event\":\"lane_done\",\"lane\":$LANE,\"runs\":$done_runs}"

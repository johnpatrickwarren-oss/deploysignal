#!/bin/bash
# tools/diagnostic/q67-phase-3-sweep-dispatch.sh — Q67 Phase-3.d.B Mac mini
# sweep dispatch. Per Q67-PHASE-3-D-B-MMD-BETTING-E-PROCESS-SPEC.md § Q67.4
# acceptance verification: 5 substrates × 5 scenarios × 8 seeds × 3 resampler
# modes; verifies family_C_mmd betting-e-process FPR ≤ α × 1.2 across modes
# uniformly.
#
# Recompiles all 5 substrate configs with the Q67 calibrator first (so cells
# carry betting_e_process_params); pre-Q67 configs lack the field and the
# canonical detector self-gates → no Q67 v2 evaluation occurs without
# recompile. Originals backed up to runs/compiled-configs/pre-q67-backup/
# before overwrite.
#
# Long-running. Designed for nohup dispatch on Mac mini per
# feedback_parallel_macclaude_worktree_isolation. Logs to
# /tmp/q67-phase-3-sweep.log; status by tail.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
export PATH=/opt/homebrew/bin:$PATH

LOG=/tmp/q67-phase-3-sweep.log
exec > >(tee -a "$LOG") 2>&1

echo "[q67-sweep] === Q67 Phase-3.d.B Mac mini sweep dispatch ==="
echo "[q67-sweep] start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[q67-sweep] root:  $ROOT"
echo "[q67-sweep] node:  $(node --version)"
echo "[q67-sweep] cores: $(sysctl -n hw.ncpu)"

# ── Step 7.1 — backup pre-Q67 configs ───────────────────────────────
BACKUP_DIR="runs/compiled-configs/pre-q67-backup"
mkdir -p "$BACKUP_DIR"
for cfg in v5-sequential-e-process v8a-real-burstgpt-v1 \
           v8b-real-azure-llm-inference-v1 v8c-real-mooncake-v1 \
           v9a-real-huggingface-lmsys-arena-v1; do
  if [[ ! -f "$BACKUP_DIR/${cfg}.json" ]]; then
    cp "runs/compiled-configs/${cfg}.json" "$BACKUP_DIR/"
    echo "[q67-sweep] backed up $cfg"
  fi
done

# ── Step 7.2 — recompile all 5 configs with Q67 calibrator ──────────
echo "[q67-sweep] === recompiling 5 substrate configs with Q67 calibrator ==="
RECOMPILE_T0=$(date +%s)

declare -a SUBSTRATES=(
  "synthetic-v1:v5-sequential-e-process"
  "real-burstgpt-v1:v8a-real-burstgpt-v1"
  "real-azure-llm-inference-v1:v8b-real-azure-llm-inference-v1"
  "real-mooncake-v1:v8c-real-mooncake-v1"
  "real-huggingface-lmsys-arena-v1:v9a-real-huggingface-lmsys-arena-v1"
)

for spec in "${SUBSTRATES[@]}"; do
  baseline="${spec%%:*}"
  config="${spec##*:}"
  echo "[q67-sweep] [$(date +%H:%M:%S)] recompiling $config from $baseline"
  time node tools/calibrate.ts \
    --baseline "runs/baselines/$baseline" \
    --out "runs/compiled-configs/${config}.json" \
    --families A,B,C,D,E 2>&1 | tail -3
done

RECOMPILE_T1=$(date +%s)
echo "[q67-sweep] recompile elapsed: $((RECOMPILE_T1 - RECOMPILE_T0))s"

# ── Step 7.3 — verify Q67 v2 hyperparameters stamped on recompiled configs ─
echo "[q67-sweep] === verifying Q67 v2 betting_e_process_params stamping ==="
for spec in "${SUBSTRATES[@]}"; do
  config="${spec##*:}"
  count=$(node -e "
    const c = JSON.parse(require('fs').readFileSync('runs/compiled-configs/${config}.json', 'utf8'));
    let n = 0;
    for (const cell of c.baseline_cells?.cells ?? []) {
      if (cell.family_C?.betting_e_process_params) n++;
    }
    console.log(n);
  ")
  echo "[q67-sweep]   ${config}: ${count} cells with Q67 betting_e_process_params"
done

# ── Step 7.4 — Phase 3 sweep dispatch ───────────────────────────────
echo "[q67-sweep] === Phase 3 sweep: 5 substrates × 5 scenarios × 8 seeds × 3 modes ==="
SWEEP_OUT="runs/validation-reports/profile-report-cards/q67-phase-3-d-b"
mkdir -p "$SWEEP_OUT"
SWEEP_T0=$(date +%s)

time node tools/run-shadow-compare.ts \
  --substrates v5,v8a,v8b,v8c,v9a \
  --scenarios all-5 \
  --seeds 42,43,44,45,46,47,48,49 \
  --output-dir "$SWEEP_OUT" \
  --emit "$SWEEP_OUT/q67-summary.json"

SWEEP_T1=$(date +%s)
echo "[q67-sweep] sweep elapsed: $((SWEEP_T1 - SWEEP_T0))s"

# ── Step 7.5 — acceptance summary ───────────────────────────────────
echo "[q67-sweep] === Q67 Phase-3.d.B acceptance summary ==="
if [[ -f "$SWEEP_OUT/q67-summary.json" ]]; then
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$SWEEP_OUT/q67-summary.json', 'utf8'));
    console.log(JSON.stringify({
      acceptance_gates: s.acceptance_gates,
      per_substrate_detector_fpr: s.per_substrate_detector_fpr_means,
    }, null, 2));
  "
fi

echo "[q67-sweep] === DONE === $(date -u +%Y-%m-%dT%H:%M:%SZ)"

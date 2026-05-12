#!/bin/bash
# =============================================================================
# sync-from-anchor — pull anchor/ docs from the canonical anchor repo
#
# Deploysignal embeds a subset of the anchor methodology (METHODOLOGY.md,
# README, skills, templates, case-studies) under anchor/. The integration-
# specific implementation (run-pipeline.sh, CLAUDE.md.template) lives only
# in canonical and is NOT synced — those are anchor's internal tooling.
#
# Usage:
#   tools/sync-from-anchor.sh           # dry-run; shows what would change
#   tools/sync-from-anchor.sh --apply   # actually copy; leaves changes uncommitted
#   tools/sync-from-anchor.sh --help    # show this help
#
# Environment:
#   ANCHOR_SOURCE  Path to canonical anchor checkout. Default: $HOME/anchor.
#
# The script never commits, never pushes — it leaves changes for human review.
# Run it before a release; commit + open a PR if the diff is what you want.
# =============================================================================

set -euo pipefail

ANCHOR_SOURCE="${ANCHOR_SOURCE:-$HOME/anchor}"
APPLY=false

# Paths under canonical anchor that are mirrored into ./anchor/ here.
# Order matters only for stable diff output.
SYNC_PATHS=(
  "METHODOLOGY.md"
  "README.md"
  "skills"
  "templates"
  "case-studies"
)

show_help() {
  awk '/^# ====/ {n++; if (n==2) exit; next} n==1 {sub(/^# ?/, ""); print}' "$0"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --apply)   APPLY=true;  shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; echo "Run --help for usage." >&2; exit 1 ;;
  esac
done

# Resolve repo root (the directory containing tools/)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/anchor"

if [[ ! -d "$ANCHOR_SOURCE" ]]; then
  echo "ANCHOR_SOURCE not found: $ANCHOR_SOURCE" >&2
  echo "Set ANCHOR_SOURCE to a checkout of johnpatrickwarren-oss/anchor." >&2
  exit 1
fi

if [[ ! -d "$ANCHOR_SOURCE/.git" ]]; then
  echo "WARN: $ANCHOR_SOURCE is not a git repo; cannot verify it's on main." >&2
else
  src_branch="$(git -C "$ANCHOR_SOURCE" branch --show-current 2>/dev/null || echo "?")"
  if [[ "$src_branch" != "main" ]]; then
    echo "WARN: $ANCHOR_SOURCE is on branch '$src_branch', not 'main'." >&2
    echo "      Continuing — but verify this is intentional." >&2
  fi
  if [[ -n "$(git -C "$ANCHOR_SOURCE" status --porcelain 2>/dev/null)" ]]; then
    echo "WARN: $ANCHOR_SOURCE has uncommitted changes." >&2
    echo "      You will sync work-in-progress, not committed state." >&2
  fi
fi

mkdir -p "$DEST"

echo "Source:      $ANCHOR_SOURCE"
echo "Destination: $DEST"
echo "Mode:        $($APPLY && echo APPLY || echo "dry-run (pass --apply to write)")"
echo ""

CHANGED=0
for rel in "${SYNC_PATHS[@]}"; do
  src="$ANCHOR_SOURCE/$rel"
  dst="$DEST/$rel"

  if [[ ! -e "$src" ]]; then
    echo "  [skip] $rel  (not in source — nothing to sync)"
    continue
  fi

  # diff -rq returns 1 on differences, 0 on identical, 2 on errors
  if diff -rq "$dst" "$src" >/dev/null 2>&1; then
    echo "  [ok]   $rel  (already in sync)"
    continue
  fi

  CHANGED=$((CHANGED + 1))
  echo "  [diff] $rel"
  if ! $APPLY; then
    # Show summary diff (first 10 lines per changed file).
    # diff exits 1 when paths differ; suppress via subshell so pipefail
    # doesn't abort the loop on the first divergent path.
    { diff -rq "$dst" "$src" 2>/dev/null || true; } | sed 's/^/         /' | head -10
  else
    if [[ -d "$src" ]]; then
      # Replace directory atomically: rm + cp
      rm -rf "$dst"
      cp -R "$src" "$dst"
    else
      cp "$src" "$dst"
    fi
    echo "         → updated"
  fi
done

echo ""
if [[ $CHANGED -eq 0 ]]; then
  echo "Already in sync — no action needed."
elif ! $APPLY; then
  echo "$CHANGED path(s) would change. Re-run with --apply to write."
  exit 0
else
  echo "$CHANGED path(s) updated. Review with: git -C $REPO_ROOT status"
  echo "Commit when ready; open a PR to land the sync."
fi

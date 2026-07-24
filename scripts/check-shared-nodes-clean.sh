#!/usr/bin/env bash
#
# Report real uncommitted changes across every package in the shared
# custom_nodes/ tree. Meant to be run by anyone before starting a session
# (to see if someone else's work-in-progress is sitting there) and after
# (to confirm they didn't leave anything uncommitted).
#
# This is the check that would have caught two real incidents this project
# already hit: an uncommitted local-only XPU fix in ComfyUI-KJNodes and
# ComfyUI-GGUF that existed only on one node's disk and were nearly lost
# during cleanup, found only by chance. Ignores build-artifact noise
# (__pycache__ etc — see the .gitignore housekeeping in these repos) so a
# real change doesn't get lost in false positives.
#
# Usage:
#   scripts/check-shared-nodes-clean.sh [custom_nodes_root]
# Defaults to /nfs_share/custom_nodes.

set -euo pipefail

ROOT="${1:-/nfs_share/custom_nodes}"

if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: $ROOT does not exist." >&2
  exit 1
fi

DIRTY_COUNT=0
CHECKED_COUNT=0

for d in "$ROOT"/*/; do
  name="$(basename "$d")"
  [[ -d "${d}.git" ]] || continue
  CHECKED_COUNT=$((CHECKED_COUNT + 1))
  STATUS="$(cd "$d" && git status --porcelain 2>/dev/null)"
  if [[ -n "$STATUS" ]]; then
    DIRTY_COUNT=$((DIRTY_COUNT + 1))
    echo "DIRTY: ${name}"
    echo "$STATUS" | sed 's/^/    /'
  fi
done

echo
echo "Checked ${CHECKED_COUNT} packages under ${ROOT}."
if [[ "$DIRTY_COUNT" -eq 0 ]]; then
  echo "All clean."
  exit 0
else
  echo "${DIRTY_COUNT} package(s) have uncommitted changes — see above."
  echo "If this is your own in-progress work: commit it, or run publish-shared-node.sh once tested."
  echo "If it's not yours: DO NOT delete it blindly — check with whoever owns it first (see the"
  echo "KJNodes/GGUF near-miss in docs/xpu-bundle-provenance.md for why)."
  exit 1
fi

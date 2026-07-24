#!/usr/bin/env bash
#
# Bulk-symlink every shared custom_nodes/ package from the NFS canonical tree
# into a ComfyUI checkout's custom_nodes/ dir. Idempotent — safe to re-run
# (e.g. after a new package is added to the shared tree, or when onboarding a
# fresh node).
#
# Never overwrites a real (non-symlink) directory that already exists at the
# destination — the same drift-hazard discipline documented in
# docs/gpu-node-setup.md (a real directory may hold someone's uncommitted
# work; see the KJNodes near-miss). Warn and skip instead.
#
# Usage:
#   scripts/sync-custom-nodes-from-nfs.sh <comfyui_root> [nfs_custom_nodes_root]
# nfs_custom_nodes_root defaults to /nfs_share/custom_nodes.

set -euo pipefail

COMFYUI_ROOT="${1:?Usage: $0 <comfyui_root> [nfs_custom_nodes_root]}"
NFS_CUSTOM_NODES="${2:-/nfs_share/custom_nodes}"
DEST="${COMFYUI_ROOT}/custom_nodes"

if [[ ! -d "$NFS_CUSTOM_NODES" ]]; then
  echo "ERROR: ${NFS_CUSTOM_NODES} does not exist." >&2
  exit 1
fi

mkdir -p "$DEST"

LINKED=0
SKIPPED_OK=0
SKIPPED_WARN=0

for pkg_path in "$NFS_CUSTOM_NODES"/*/; do
  name="$(basename "$pkg_path")"
  target="${DEST}/${name}"
  shared="${NFS_CUSTOM_NODES}/${name}"

  if [[ -L "$target" ]]; then
    if [[ "$(readlink -f "$target")" == "$(readlink -f "$shared")" ]]; then
      SKIPPED_OK=$((SKIPPED_OK + 1))
    else
      echo "WARN: ${target} is a symlink but points elsewhere ($(readlink -f "$target")) — leaving it alone." >&2
      SKIPPED_WARN=$((SKIPPED_WARN + 1))
    fi
    continue
  fi

  if [[ -e "$target" ]]; then
    echo "WARN: ${target} already exists as a real (non-symlink) directory — NOT overwriting." >&2
    echo "      Check 'git status' inside it before replacing; it may hold uncommitted work." >&2
    SKIPPED_WARN=$((SKIPPED_WARN + 1))
    continue
  fi

  ln -s "$shared" "$target"
  echo "linked: ${name}"
  LINKED=$((LINKED + 1))
done

echo
echo "Done. Linked ${LINKED} new package(s); ${SKIPPED_OK} already correct; ${SKIPPED_WARN} skipped with a warning (see above)."
if [[ "$SKIPPED_WARN" -gt 0 ]]; then
  exit 1
fi

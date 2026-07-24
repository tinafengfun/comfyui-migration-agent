#!/usr/bin/env bash
#
# Start isolated local development on one package from the shared
# custom_nodes/ tree, without touching the shared copy (or affecting any
# other node/person) until you're ready to publish.
#
# What it does, on THIS node only:
#   1. Clones the shared package's current state to a local scratch dir
#   2. Repoints this node's custom_nodes/<name> symlink at that local clone
#
# Other nodes keep using the shared NFS copy unchanged. Test freely (manual
# container launch, Playwright, etc.) against your local clone; when done,
# run publish-shared-node.sh to merge your commits back and restore the
# shared symlink.
#
# Usage:
#   scripts/dev-checkout-shared-node.sh <package-name> [comfyui_root]
# comfyui_root defaults to $COMFYUI_ROOT.

set -euo pipefail

NAME="${1:?Usage: $0 <package-name> [comfyui_root]}"
COMFYUI_ROOT="${2:-${COMFYUI_ROOT:-}}"
NFS_CUSTOM_NODES="${NFS_CUSTOM_NODES_ROOT:-/nfs_share/custom_nodes}"
SCRATCH_ROOT="${DEV_SCRATCH_ROOT:-$HOME/dev/shared-nodes}"

if [[ -z "$COMFYUI_ROOT" ]]; then
  echo "ERROR: comfyui_root not given and \$COMFYUI_ROOT is unset." >&2
  exit 1
fi

SHARED_PATH="${NFS_CUSTOM_NODES}/${NAME}"
LOCAL_LINK="${COMFYUI_ROOT}/custom_nodes/${NAME}"
SCRATCH_PATH="${SCRATCH_ROOT}/${NAME}"

if [[ ! -d "$SHARED_PATH/.git" ]]; then
  echo "ERROR: ${SHARED_PATH} is not a git repo (or doesn't exist) — not a known shared package." >&2
  exit 1
fi

if [[ -e "$LOCAL_LINK" && ! -L "$LOCAL_LINK" ]]; then
  echo "ERROR: ${LOCAL_LINK} exists and is NOT a symlink — refusing to touch it." >&2
  echo "(Expected it to be a symlink into the shared NFS tree, per the standard convention.)" >&2
  exit 1
fi
if [[ -L "$LOCAL_LINK" ]]; then
  CURRENT_TARGET="$(readlink -f "$LOCAL_LINK")"
  if [[ "$CURRENT_TARGET" != "$(readlink -f "$SHARED_PATH")" ]]; then
    echo "ERROR: ${LOCAL_LINK} is already a symlink, but not to the shared NFS copy (points at ${CURRENT_TARGET})." >&2
    echo "Looks like dev-checkout is already in progress for this package on this node." >&2
    exit 1
  fi
fi

mkdir -p "$SCRATCH_ROOT"
if [[ -d "$SCRATCH_PATH" ]]; then
  echo "Scratch clone already exists at ${SCRATCH_PATH} — reusing it (run 'git pull' inside it yourself if you want the latest shared state first)."
else
  echo "== Cloning ${SHARED_PATH} -> ${SCRATCH_PATH} =="
  git clone "$SHARED_PATH" "$SCRATCH_PATH"
fi

echo "== Repointing ${LOCAL_LINK} -> ${SCRATCH_PATH} (this node only) =="
rm -f "$LOCAL_LINK"
ln -s "$SCRATCH_PATH" "$LOCAL_LINK"

cat <<EOF

Done. On THIS node, custom_nodes/${NAME} now points at your local scratch clone.
Other nodes/people are unaffected and still see the shared NFS copy.

Edit + test freely in: ${SCRATCH_PATH}
When ready to share your change:
  scripts/publish-shared-node.sh ${NAME} ${COMFYUI_ROOT}
EOF

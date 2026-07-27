#!/usr/bin/env bash
#
# Pull the latest canonical ComfyUI core (comfy/, comfy_extras/, main.py,
# server.py, etc.) from the shared /nfs_share/comfyui-core repo into this
# node's comfyui_root -- a real git merge, not a file copy, so history and
# any concurrent changes from other people are preserved.
#
# Only touches git-tracked core files. ComfyUI's own .gitignore already
# excludes custom_nodes/, models/, user/, output/, input/, temp/, venv*/,
# extra_model_paths.yaml -- so this never touches per-node runtime state or
# the separately-managed custom_nodes/ shared tree.
#
# Usage:
#   scripts/sync-comfyui-core-from-nfs.sh [comfyui_root]
# comfyui_root defaults to $COMFYUI_ROOT.

set -euo pipefail

COMFYUI_ROOT="${1:-${COMFYUI_ROOT:-}}"
NFS_COMFYUI_CORE="${NFS_COMFYUI_CORE_ROOT:-/nfs_share/comfyui-core}"
REMOTE_NAME="nfs-canonical"

if [[ -z "$COMFYUI_ROOT" ]]; then
  echo "ERROR: comfyui_root not given and \$COMFYUI_ROOT is unset." >&2
  exit 1
fi

if [[ ! -d "${NFS_COMFYUI_CORE}/.git" ]]; then
  echo "ERROR: ${NFS_COMFYUI_CORE} is not a git repo (or doesn't exist) -- no canonical core to sync from." >&2
  exit 1
fi

if [[ ! -d "${COMFYUI_ROOT}/.git" ]]; then
  echo "ERROR: ${COMFYUI_ROOT} is not a git repo." >&2
  exit 1
fi

STATUS="$(cd "$COMFYUI_ROOT" && git status --porcelain -- . ":(exclude)custom_nodes" 2>/dev/null | grep -v '^??' || true)"
if [[ -n "$STATUS" ]]; then
  cat >&2 <<EOF
ERROR: ${COMFYUI_ROOT} has uncommitted changes to tracked core files -- refusing to pull.
${STATUS}
Commit (or stash/discard) first, then re-run. If this is a real local core
patch you want to keep, run scripts/publish-comfyui-core-patch.sh instead
(or first) so it isn't silently overwritten/conflicted here.
EOF
  exit 1
fi

cd "$COMFYUI_ROOT"
if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote set-url "$REMOTE_NAME" "$NFS_COMFYUI_CORE"
else
  git remote add "$REMOTE_NAME" "$NFS_COMFYUI_CORE"
fi

echo "== Fetching ${NFS_COMFYUI_CORE} =="
git fetch "$REMOTE_NAME"

DEFAULT_BRANCH="$(git -C "$NFS_COMFYUI_CORE" rev-parse --abbrev-ref HEAD)"

echo "== Merging ${REMOTE_NAME}/${DEFAULT_BRANCH} into $(git rev-parse --abbrev-ref HEAD) =="
if ! git merge "${REMOTE_NAME}/${DEFAULT_BRANCH}" --no-edit; then
  cat >&2 <<EOF

ERROR: merge failed -- likely a real conflict between this node's own
history and the canonical repo. Resolve it directly in ${COMFYUI_ROOT}
(it's a normal git working tree), or run
scripts/publish-comfyui-core-patch.sh first if this node has an
uncommitted/unpublished local fix that should go the other way.
EOF
  exit 1
fi

NEW_HASH="$(git rev-parse --short HEAD)"
echo
echo "Done. ${COMFYUI_ROOT} is now at canonical commit ${NEW_HASH}."
echo "Restart ComfyUI on this node to pick up the change."

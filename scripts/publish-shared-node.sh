#!/usr/bin/env bash
#
# Publish a local dev-checkout (started via dev-checkout-shared-node.sh) back
# to the shared custom_nodes/ tree on NFS, and restore this node's symlink.
#
# This is a real `git pull` (merge/fast-forward) of the shared canonical repo
# from your local scratch clone — not a file overwrite — so history and any
# concurrent commits from other people are preserved. A genuine conflict
# (two people changed the same lines) surfaces as a normal git merge
# conflict here, which is the correct place for it to surface, not something
# this script tries to paper over.
#
# Usage:
#   scripts/publish-shared-node.sh <package-name> [comfyui_root]
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

if [[ ! -d "$SCRATCH_PATH/.git" ]]; then
  echo "ERROR: ${SCRATCH_PATH} is not a git repo — did you run dev-checkout-shared-node.sh ${NAME} first?" >&2
  exit 1
fi

STATUS="$(cd "$SCRATCH_PATH" && git status --porcelain)"
if [[ -n "$STATUS" ]]; then
  echo "ERROR: ${SCRATCH_PATH} has uncommitted changes — refusing to publish." >&2
  echo "$STATUS" | sed 's/^/    /' >&2
  echo "Commit (or stash/discard) first, then re-run." >&2
  exit 1
fi

if [[ ! -L "$LOCAL_LINK" || "$(readlink -f "$LOCAL_LINK")" != "$(readlink -f "$SCRATCH_PATH")" ]]; then
  echo "WARNING: ${LOCAL_LINK} does not currently point at ${SCRATCH_PATH}." >&2
  echo "Continuing anyway — will still merge your scratch clone's commits into the shared repo," >&2
  echo "but the symlink restore step below may not do what you expect." >&2
fi

BRANCH="$(cd "$SCRATCH_PATH" && git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then
  BRANCH="$(cd "$SCRATCH_PATH" && git rev-parse HEAD)"
  echo "NOTE: scratch clone is in detached-HEAD state; pulling by commit ${BRANCH} instead of a branch name."
fi

echo "== Merging ${SCRATCH_PATH} (${BRANCH}) into ${SHARED_PATH} =="
if ! git -C "$SHARED_PATH" pull "$SCRATCH_PATH" "$BRANCH"; then
  cat >&2 <<EOF

ERROR: merge failed — likely a real conflict with someone else's concurrent
change to ${NAME}. Resolve it directly inside ${SHARED_PATH}
(it's a normal git working tree), then re-run this script, or finish the
merge there manually and skip re-running.
EOF
  exit 1
fi

echo "== Restoring ${LOCAL_LINK} -> ${SHARED_PATH} =="
rm -rf "$LOCAL_LINK"
ln -s "$SHARED_PATH" "$LOCAL_LINK"

NEW_HASH="$(git -C "$SHARED_PATH" rev-parse --short HEAD)"

cat <<EOF

Done. ${NAME} published to the shared NFS copy at commit ${NEW_HASH}.
${LOCAL_LINK} now points back at the shared copy — other nodes see your change immediately.

Reminder: update docs/xpu-bundle-provenance.md's entry for ${NAME} with the new
commit hash (${NEW_HASH}) if that file tracks it.

Your scratch clone at ${SCRATCH_PATH} was left in place in case you want to keep
iterating — safe to delete once you're done, or reuse it for next time.
EOF

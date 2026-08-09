#!/usr/bin/env bash
#
# Publish a genuine local ComfyUI-core patch (e.g. an XPU compatibility fix
# to comfy/ops.py, comfy/model_management.py, etc.) from this node's
# comfyui_root back into the shared canonical repo at /nfs_share/comfyui-core.
#
# This is a real `git pull` (merge) of THIS node's commits into the shared
# canonical repo -- not a file overwrite -- so history and any concurrent
# commits from other people/nodes are preserved. A genuine conflict (two
# people patched the same lines) surfaces as a normal git merge conflict
# here, which is the correct place for it to surface.
#
# Real incident this protects against: a genuine XPU fix (FP8-on-XPU
# segfault workaround, comfy/ops.py) existed as a real but never-committed,
# `git add`-staged diff on one node -- one accidental `git checkout --` or
# disk issue away from being silently lost, with no history/attribution.
# Commit your local fix FIRST (a normal `git commit` in comfyui_root), then
# run this script to protect it in the shared canonical repo.
#
# Usage:
#   scripts/publish-comfyui-core-patch.sh [comfyui_root]
# comfyui_root defaults to $COMFYUI_ROOT.

set -euo pipefail

COMFYUI_ROOT="${1:-${COMFYUI_ROOT:-}}"
NFS_COMFYUI_CORE="${NFS_COMFYUI_CORE_ROOT:-/nfs_share/comfyui-core}"

# Serialize concurrent publishes into the shared canonical repo -- when several
# migrations finish at once, two `git pull` merges into the same NFS repo would
# race. Re-exec under an flock on a sibling lockfile (outside the git tree).
if [[ "${_CORE_PUBLISH_LOCKED:-}" != "1" && -z "${NO_PUBLISH_LOCK:-}" ]]; then
  exec env _CORE_PUBLISH_LOCKED=1 flock "${NFS_COMFYUI_CORE}.publish.lock" "$0" "$@"
fi

if [[ -z "$COMFYUI_ROOT" ]]; then
  echo "ERROR: comfyui_root not given and \$COMFYUI_ROOT is unset." >&2
  exit 1
fi

if [[ ! -d "${NFS_COMFYUI_CORE}/.git" ]]; then
  echo "ERROR: ${NFS_COMFYUI_CORE} is not a git repo (or doesn't exist) -- nothing to publish to." >&2
  exit 1
fi

if [[ ! -d "${COMFYUI_ROOT}/.git" ]]; then
  echo "ERROR: ${COMFYUI_ROOT} is not a git repo." >&2
  exit 1
fi

STATUS="$(cd "$COMFYUI_ROOT" && git status --porcelain -- . ":(exclude)custom_nodes" 2>/dev/null | grep -v '^??' || true)"
if [[ -n "$STATUS" ]]; then
  cat >&2 <<EOF
ERROR: ${COMFYUI_ROOT} has uncommitted changes to tracked core files -- refusing to publish.
${STATUS}
Commit your local core patch first (git commit, with a clear message
explaining WHY -- e.g. which XPU crash/bug it fixes), then re-run.
EOF
  exit 1
fi

BRANCH="$(cd "$COMFYUI_ROOT" && git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then
  BRANCH="$(cd "$COMFYUI_ROOT" && git rev-parse HEAD)"
  echo "NOTE: ${COMFYUI_ROOT} is in detached-HEAD state; pulling by commit ${BRANCH} instead of a branch name."
fi

echo "== Merging ${COMFYUI_ROOT} (${BRANCH}) into ${NFS_COMFYUI_CORE} =="
if ! git -C "$NFS_COMFYUI_CORE" pull "$COMFYUI_ROOT" "$BRANCH"; then
  cat >&2 <<EOF

ERROR: merge failed -- likely a real conflict with someone else's concurrent
change to comfyui-core. Resolve it directly inside ${NFS_COMFYUI_CORE}
(it's a normal git working tree), then re-run this script, or finish the
merge there manually and skip re-running.
EOF
  exit 1
fi

NEW_HASH="$(git -C "$NFS_COMFYUI_CORE" rev-parse --short HEAD)"

cat <<EOF

Done. Published to the shared canonical repo at commit ${NEW_HASH}.
Other nodes can pick this up via scripts/sync-comfyui-core-from-nfs.sh.

Reminder: update docs/xpu-bundle-provenance.md's core-patch list with the new
commit (${NEW_HASH}) if this is a patch worth tracking there long-term.
EOF

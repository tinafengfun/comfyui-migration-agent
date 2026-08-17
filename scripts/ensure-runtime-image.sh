#!/usr/bin/env bash
# ============================================================
# ensure-runtime-image.sh -- make sure this host's docker-runtime ComfyUI
# image (as pinned in gpu-nodes.json for the LOCAL node) is loaded into the
# local Docker daemon, pulling it from the shared NFS store
# (scripts/load-docker-image-from-nfs.sh) ONLY when it is missing.
#
# Idempotent by design: if the image is already present it does nothing --
# no 14 GB `docker load` on every deploy. This is the bash pre-flight
# counterpart of the backend's checkLocalDockerImage()/syncDockerImageFromNfs()
# (src/server/gpuNodes.ts); deploy-agent-demo.sh calls it so a fresh node gets
# its runtime container from NFS automatically as part of the deploy.
#
# Skips cleanly (exit 0) when:
#   - there is no local runtime=docker node in gpu-nodes.json, or
#   - the `docker` CLI is not installed on this host (bare-metal node).
#
# Fails (exit 1) only when the image is genuinely required but cannot be made
# present (NFS not mounted / tar missing / docker load failed) -- a
# docker-runtime node without its image cannot run a migration, so that is a
# real deploy blocker, not something to warn past.
#
# Usage:
#   scripts/ensure-runtime-image.sh [--node NAME]
# Env:
#   GPU_NODES_PATH            override gpu-nodes.json location (default: repo root)
#   NFS_DOCKER_IMAGES_ROOT    passed through to load-docker-image-from-nfs.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
GPU_NODES="${GPU_NODES_PATH:-$REPO/gpu-nodes.json}"
NODE_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE_NAME="$2"; shift 2 ;;
    *) echo "ensure-runtime-image: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$GPU_NODES" ]]; then
  echo "==> [runtime-image] no gpu-nodes.json at $GPU_NODES -- skipping image pre-flight."
  exit 0
fi

# Resolve the docker_image for the LOCAL docker-runtime node (named override,
# else default_node if it is a local docker node, else the first one). Prints
# an empty line when this host has no local docker-runtime node.
IMAGE="$(python3 - "$GPU_NODES" "$NODE_NAME" <<'PY'
import json, sys
path, want = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
d = json.load(open(path))
nodes = d.get("nodes", [])
def is_local_docker(n): return n.get("kind") == "local" and n.get("runtime") == "docker"
pick = None
if want:
    pick = next((n for n in nodes if n.get("name") == want), None)
else:
    dn = d.get("default_node")
    pick = next((n for n in nodes if n.get("name") == dn and is_local_docker(n)), None) \
        or next((n for n in nodes if is_local_docker(n)), None)
if pick and pick.get("runtime") == "docker":
    print(pick.get("docker_image", ""))
else:
    print("")
PY
)"
IMAGE="$(echo "$IMAGE" | tail -1 | tr -d '[:space:]')"

if [[ -z "$IMAGE" ]]; then
  echo "==> [runtime-image] no local runtime=docker node in gpu-nodes.json -- nothing to load."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> [runtime-image] docker CLI not installed on this host -- skipping (expected image: $IMAGE)."
  exit 0
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> [runtime-image] $IMAGE already present locally -- OK (no reload)."
  exit 0
fi

echo "==> [runtime-image] $IMAGE NOT present locally -- loading from NFS store..."
if ! bash "$SCRIPT_DIR/load-docker-image-from-nfs.sh"; then
  echo "!! [runtime-image] load-docker-image-from-nfs.sh failed. Is /nfs_share mounted and" >&2
  echo "!! is ${NFS_DOCKER_IMAGES_ROOT:-/nfs_share/docker-images}/current present?" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "!! [runtime-image] loaded from NFS but $IMAGE is still not present." >&2
  echo "!! The NFS tar may hold a different tag than gpu-nodes.json pins. Reconcile them." >&2
  exit 1
fi

echo "==> [runtime-image] $IMAGE loaded from NFS and verified present. ✓"

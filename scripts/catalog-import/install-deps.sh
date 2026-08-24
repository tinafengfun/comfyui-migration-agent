#!/usr/bin/env bash
# Stage 2 — best-effort install of each cloned bucket-A node's requirements.txt into
# the shared venv via the lock wrapper, skipping CUDA-only packages. Failures are
# tolerated + logged (a node that can't import will simply not register in Stage 3).
# Also applies the cuda->xpu patch to needs_patch nodes.
#
# Usage: install-deps.sh <nodes.json> [--nfs-root /nfs_share] [--patch-out-dir DIR]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODES_JSON="${1:?usage: install-deps.sh <nodes.json> [--nfs-root DIR] [--patch-out-dir DIR]}"
NFS_ROOT="/nfs_share"; PATCH_DIR="/tmp/catalog-import-patches"
shift || true
while [ $# -gt 0 ]; do case "$1" in
  --nfs-root) NFS_ROOT="$2"; shift 2;;
  --patch-out-dir) PATCH_DIR="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
mkdir -p "$PATCH_DIR"

VENV="$NFS_ROOT/venv-container-xpu/bin/python3"
LOCK="$NFS_ROOT/bin/with-shared-venv-lock.sh"
# CUDA-only packages a source audit says to skip on XPU (per Step 05 skill).
SKIP_RE='bitsandbytes|flash-attn|flash_attn|sageattention|onnxruntime-gpu|nvidia-|cupy-cuda|triton|xformers'

python3 - "$NODES_JSON" <<'PY' | while IFS=$'\t' read -r pkg bucket needs_patch; do
import json,sys
for r in json.load(open(sys.argv[1])):
    if r["bucket"]=="C": continue
    print(f"{r['package_name']}\t{r['bucket']}\t{int(r['needs_patch'])}")
PY
  dir="$NFS_ROOT/custom_nodes/$pkg"
  [ -d "$dir" ] || { echo "  MISS $pkg (not cloned)"; continue; }

  # 1) cuda->xpu patch for needs_patch nodes
  if [ "$needs_patch" = "1" ]; then
    python3 "$HERE/cuda-to-xpu-patch.py" "$dir" --diff-out "$PATCH_DIR/$pkg.cuda-to-xpu.diff" 2>&1 | sed "s/^/  [$pkg] /"
  fi

  # 2) requirements (bucket A only; bucket B deps handled in the SYCL image build)
  if [ "$bucket" = "A" ] && [ -f "$dir/requirements.txt" ]; then
    req="$dir/requirements.txt"
    # strip CUDA-only lines into a filtered req
    filt="$(mktemp)"
    grep -viE "$SKIP_RE" "$req" | grep -vE '^\s*#|^\s*$' > "$filt" || true
    skipped="$(grep -iE "$SKIP_RE" "$req" | tr '\n' ',' || true)"
    [ -n "$skipped" ] && echo "  [$pkg] skip cuda-only: $skipped"
    if [ -s "$filt" ]; then
      echo "  [$pkg] pip install -r (filtered)…"
      if [ -x "$LOCK" ]; then
        timeout 600 bash "$LOCK" "$VENV" install -r "$filt" >/tmp/pip-$pkg.log 2>&1 \
          && echo "  [$pkg] ok" || echo "  [$pkg] PIP FAILED (see /tmp/pip-$pkg.log): $(tail -1 /tmp/pip-$pkg.log)"
      else
        echo "  [$pkg] (no lock wrapper $LOCK — skipping install; node may miss deps)"
      fi
    fi
    rm -f "$filt"
  fi
done
echo "install-deps: done (patches -> $PATCH_DIR)"

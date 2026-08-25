#!/usr/bin/env bash
# Stage 4 — bucket B: compile the SYCL wheel IN-CONTAINER (the b7 image ships the oneAPI
# icx/icpx toolchain), bake the wheel + node into a NEW image, and export it to NFS.
# Also saves a reusable wheel to /nfs_share/wheels (record it as syclWheel.prebuiltWheelPath).
#
# Default target: ComfyUI-llama-cpp_vlm, per the user's compile command:
#   CMAKE_ARGS="-DGGML_SYCL=on -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx" pip install llama-cpp-python
#
# Usage: build-sycl-image.sh [--node ComfyUI-llama-cpp_vlm] [--pip-spec llama-cpp-python]
#          [--base intel/llm-scaler-omni:0.1.0-b7] [--tag intel/llm-scaler-omni:0.1.0-b7-sycl]
#          [--no-export]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
NODE="ComfyUI-llama-cpp_vlm"; PIP_SPEC="llama-cpp-python"
BASE="intel/llm-scaler-omni:0.1.0-b7"; TAG="intel/llm-scaler-omni:0.1.0-b7-sycl"
NFS="/nfs_share"; EXPORT=1
while [ $# -gt 0 ]; do case "$1" in
  --node) NODE="$2"; shift 2;; --pip-spec) PIP_SPEC="$2"; shift 2;;
  --base) BASE="$2"; shift 2;; --tag) TAG="$2"; shift 2;;
  --no-export) EXPORT=0; shift;; *) echo "unknown: $1" >&2; exit 2;;
esac; done

CN="catalog-sycl-build"
WHEEL_DIR="$NFS/wheels/$(echo "$PIP_SPEC" | tr -c 'a-zA-Z0-9._-' '-')-sycl"
CMAKE='CMAKE_ARGS="-DGGML_SYCL=on -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx"'
ONEAPI='source /opt/intel/oneapi/setvars.sh >/dev/null 2>&1 || true'

gid_flags=""
for g in $(stat -c '%g' /dev/dri/render* 2>/dev/null | sort -u); do gid_flags="$gid_flags --group-add $g"; done

echo "== SYCL build for $NODE ($PIP_SPEC) from $BASE -> $TAG =="
docker rm -f "$CN" >/dev/null 2>&1 || true
docker run -d --name "$CN" --device /dev/dri $gid_flags \
  -e ZE_AFFINITY_MASK=0 -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy -e NO_PROXY -e no_proxy \
  -v "$NFS:$NFS" --entrypoint sleep "$BASE" infinity

echo "-- 1) compile + install $PIP_SPEC (SYCL) into the image python --"
docker exec "$CN" bash -lc "$ONEAPI; $CMAKE pip install --no-cache-dir --force-reinstall '$PIP_SPEC'"

echo "-- 2) build reusable wheel -> $WHEEL_DIR --"
docker exec "$CN" bash -lc "$ONEAPI; mkdir -p '$WHEEL_DIR'; $CMAKE pip wheel --no-deps -w '$WHEEL_DIR' '$PIP_SPEC'"
docker exec "$CN" bash -lc "ls -la '$WHEEL_DIR'"

echo "-- 3) bake node source into the image --"
docker exec "$CN" bash -lc "mkdir -p /opt/comfyui-custom-nodes && cp -r '$NFS/custom_nodes/$NODE' /opt/comfyui-custom-nodes/ 2>/dev/null || echo '(node dir not on nfs yet; skipping copy)'"

echo "-- 4) verify SYCL/GPU-offload support --"
docker exec "$CN" bash -lc "python3 -c 'import llama_cpp; print(\"llama_cpp\", getattr(llama_cpp,\"__version__\",\"?\")); print(\"gpu_offload:\", llama_cpp.llama_supports_gpu_offload())'" || echo "  (verify step errored — inspect manually)"

echo "-- 5) commit -> $TAG --"
docker commit "$CN" "$TAG"
docker rm -f "$CN" >/dev/null 2>&1 || true

if [ "$EXPORT" = "1" ]; then
  echo "-- 6) export to $NFS/docker-images via save-docker-image-to-nfs.sh --"
  bash "$REPO/scripts/save-docker-image-to-nfs.sh" "$TAG" || echo "  (export failed — run save-docker-image-to-nfs.sh manually)"
fi
echo "== SYCL image done: $TAG (wheel: $WHEEL_DIR) =="
echo "   NOTE: to USE it at runtime, the shared venv must not shadow it — either point gpu-nodes.json"
echo "   docker_image at $TAG AND ensure the shared venv's CPU llama-cpp is replaced with this wheel,"
echo "   or install $WHEEL_DIR/*.whl into /nfs_share/venv-container-xpu (VRAM tradeoff: SYCL uses XPU)."

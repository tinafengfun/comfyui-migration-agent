#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# xpu-python.sh — run Python with the ComfyUI venv that has torch+xpu
#
# Usage:
#   bash scripts/xpu-python.sh script.py [args...]
#   bash scripts/xpu-python.sh -c "import torch; print(torch.xpu.is_available())"
#
# This wraps the venv at ComfyUI/.venv which has torch 2.11.0+xpu.
# Use this for any Python validation that needs Intel XPU support.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VENV_PY="/home/intel/tianfeng/comfy/ComfyUI/.venv/bin/python"

if [ ! -f "$VENV_PY" ]; then
  echo "ERROR: ComfyUI venv not found at $VENV_PY" >&2
  echo "Expected torch 2.11.0+xpu at ComfyUI/.venv" >&2
  exit 1
fi

exec "$VENV_PY" "$@"

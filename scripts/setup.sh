#!/usr/bin/env bash
# scripts/setup.sh — idempotent first-run setup for the ComfyUI Migration Agent.
#
# Run this once after `git clone`. It installs deps and scaffolds the two
# local-only config files (env, gpu-nodes.json) from their committed templates.
# It does NOT start services or touch secrets — you edit the two files, then
# run `bash scripts/restart.sh`.
#
# Usage:  bash scripts/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "==> ComfyUI Migration Agent — setup"
echo "    project: $PROJECT_DIR"
echo ""

# ── 1. Node version ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed. Install Node 20+ (e.g. NodeSource setup_22.x)." >&2
  echo "  See docs/deployment.md → Prerequisites." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node $(node -v) is too old; need Node 20+." >&2
  exit 1
fi
echo "✓ node $(node -v), npm $(npm -v)"

# ── 2. Dependencies ────────────────────────────────────────────────────────
echo ""
echo "==> Installing dependencies (npm ci)..."
npm ci

# ── 3. Local config files (from committed templates) ───────────────────────
echo ""
echo "==> Scaffolding local config..."
need_env=0
if [ ! -f "$PROJECT_DIR/env" ]; then
  cp "$PROJECT_DIR/env.example" "$PROJECT_DIR/env"
  echo "  ✓ created env from env.example"
  need_env=1
else
  echo "  • env already exists — leaving as-is"
fi

need_nodes=0
if [ ! -f "$PROJECT_DIR/gpu-nodes.json" ]; then
  cp "$PROJECT_DIR/gpu-nodes.example.json" "$PROJECT_DIR/gpu-nodes.json"
  echo "  ✓ created gpu-nodes.json from gpu-nodes.example.json"
  need_nodes=1
else
  echo "  • gpu-nodes.json already exists — leaving as-is"
fi

# ── 4. Typecheck ───────────────────────────────────────────────────────────
echo ""
echo "==> Typecheck..."
npm run typecheck

# ── 5. Next steps ──────────────────────────────────────────────────────────
echo ""
echo "✓ Setup complete."
echo ""
if [ "$need_env" -eq 1 ]; then
  echo "NEXT — edit $PROJECT_DIR/env:"
  echo "  • COPILOT_SDK_GH_TOKEN  (run 'gh auth token' on a host with copilot scope, or see docs)"
  echo "  • COMFYUI_ROOT          (absolute path to a ComfyUI checkout on this host)"
  echo "  • MODEL_ROOTS           (absolute model path, colon-separated)"
else
  echo "env already present — verify COPILOT_SDK_GH_TOKEN / COMFYUI_ROOT / MODEL_ROOTS are set for this host."
fi
if [ "$need_nodes" -eq 1 ]; then
  echo ""
  echo "NEXT — edit $PROJECT_DIR/gpu-nodes.json:"
  echo "  • local-xpu.comfyui_root / venv_python / model_roots  (replace the /path/to/ placeholders)"
fi
echo ""
echo "Then start services:"
echo "  bash scripts/restart.sh"
echo "  curl -s http://127.0.0.1:3001/api/health   # expect {\"ok\":true,...}"

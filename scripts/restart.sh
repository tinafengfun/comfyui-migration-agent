#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Find env file ──
# Priority: 1) AGENT_ENV var  2) ./env  3) ../env  4) ../../env
ENV_FILE="${AGENT_ENV:-}"
if [ -z "$ENV_FILE" ]; then
  if [ -f "$PROJECT_DIR/env" ]; then
    ENV_FILE="$PROJECT_DIR/env"
  elif [ -f "${PROJECT_DIR}/../env" ]; then
    ENV_FILE="$(cd "$PROJECT_DIR/.." && pwd)/env"
  elif [ -f "${PROJECT_DIR}/../../env" ]; then
    ENV_FILE="$(cd "$PROJECT_DIR/../.." && pwd)/env"
  fi
fi

# Clear ALL copilot vars first, then re-set from env file
unset COPILOT_PROVIDER_TYPE COPILOT_PROVIDER_BASE_URL COPILOT_PROVIDER_API_KEY \
      COPILOT_MODEL COPILOT_REASONING_EFFORT COPILOT_DISABLE_REASONING \
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS COPILOT_PROVIDER_MAX_OUTPUT_TOKENS \
      2>/dev/null || true

# Source environment
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
  echo "==> Loaded config: $ENV_FILE"
else
  echo "==> WARNING: No env file found. Copy env.example to env and edit it."
  echo "    cp $PROJECT_DIR/env.example $PROJECT_DIR/env"
fi

cd "$PROJECT_DIR"

# ── Print active config ──
echo "    Model:    ${COPILOT_MODEL:-not set}"
echo "    Provider: ${COPILOT_PROVIDER_TYPE:-GitHub Copilot (gh auth)}"

# ── Stop existing services ──
echo ""
echo "==> Stopping existing services..."

pkill -f "tsx src/server/index.ts" 2>/dev/null && echo "    backend stopped" || echo "    no backend running"
pkill -f "vite --host" 2>/dev/null && echo "    frontend stopped" || echo "    no frontend running"
pkill -f "tsx src/server/deepseekProxy.ts" 2>/dev/null && echo "    proxy stopped" || true

# Kill any leaked ComfyUI processes from prior migration runs.
# These are spawned by agents via bash and don't always get cleaned up when
# the agent or task finishes. They hold GPU VRAM and ports (8188, 8189, ...).
LEAKED_COMFY=$(pgrep -f "python3.*main\.py" 2>/dev/null || true)
if [ -n "$LEAKED_COMFY" ]; then
  echo "$LEAKED_COMFY" | xargs -r kill 2>/dev/null
  echo "    killed leaked ComfyUI processes: $(echo "$LEAKED_COMFY" | tr '\n' ' ')"
else
  echo "    no leaked ComfyUI processes"
fi

sleep 1

# ── Start services ──
echo ""
echo "==> Starting services..."

nohup npx tsx src/server/index.ts > /tmp/migration-backend.log 2>&1 &
BACKEND_PID=$!
echo "    backend started (pid=$BACKEND_PID, log=/tmp/migration-backend.log)"

nohup npx vite --host 0.0.0.0 > /tmp/migration-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "    frontend started (pid=$FRONTEND_PID, log=/tmp/migration-frontend.log)"

# ── Wait for health ──
echo ""
echo "==> Waiting for services to be ready..."
for i in $(seq 1 10); do
  if curl -sf http://127.0.0.1:3001/api/health > /dev/null 2>&1; then
    echo "    backend  http://127.0.0.1:3001  ✓"
    break
  fi
  sleep 1
done

for i in $(seq 1 10); do
  if curl -sf http://localhost:5173 > /dev/null 2>&1; then
    echo "    frontend http://localhost:5173   ✓"
    break
  fi
  sleep 1
done

echo ""
echo "==> Done. Logs:"
echo "    tail -f /tmp/migration-backend.log"
echo "    tail -f /tmp/migration-frontend.log"

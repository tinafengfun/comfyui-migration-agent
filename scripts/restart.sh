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

# Clear ALL copilot + proxy vars first, then re-set from env file
unset COPILOT_PROVIDER_TYPE COPILOT_PROVIDER_BASE_URL COPILOT_PROVIDER_API_KEY \
      COPILOT_PROVIDER_BEARER_TOKEN \
      COPILOT_MODEL COPILOT_REASONING_EFFORT COPILOT_DISABLE_REASONING \
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS COPILOT_PROVIDER_MAX_OUTPUT_TOKENS \
      https_proxy HTTPS_PROXY HTTP_PROXY \
      2>/dev/null || true

# Source environment
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
  echo "==> Loaded config: $ENV_FILE"
else
  echo "==> WARNING: No env file found. Copy env.example to env and edit it."
  echo "    cp $PROJECT_DIR/env.example $PROJECT_DIR/env"
fi

# Force proxy to correct value — shell hooks or profiles may override it
if [ -n "${https_proxy:-}" ] && [ "$https_proxy" != "http://proxy.ims.intel.com:911" ]; then
  echo "    WARNING: Overriding proxy from $https_proxy to proxy.ims.intel.com:911"
  export https_proxy=http://proxy.ims.intel.com:911
  export HTTPS_PROXY=http://proxy.ims.intel.com:911
fi

cd "$PROJECT_DIR"

# ── Print active config ──
echo "    Model:    ${COPILOT_MODEL:-not set}"
echo "    Provider: ${COPILOT_PROVIDER_TYPE:-GitHub Copilot (gh auth)}"
echo "    Proxy:    ${https_proxy:-${HTTPS_PROXY:-none}}"

# ── Proxy sanity check ──
# Fail fast if proxy is misconfigured (wrong proxy can cause silent TLS failures
# that surface as cryptic "Failed to list models" errors deep inside the SDK).
if [ -n "${https_proxy:-${HTTPS_PROXY:-}}" ]; then
  PROXY_URL="${https_proxy:-${HTTPS_PROXY}}"
  if ! curl -sf -o /dev/null --connect-timeout 3 -x "$PROXY_URL" \
        https://api.githubcopilot.com/models 2>/dev/null; then
    echo "    WARNING: Proxy $PROXY_URL cannot reach api.githubcopilot.com."
    echo "             Expected: proxy.ims.intel.com:911 (Fortinet OK)."
    echo "             Known bad: child-prc.intel.com:912 (TLS blocked)."
  fi
fi

# ── Stop existing services ──
echo ""
echo "==> Stopping existing services..."

# Kill stale ComfyUI processes from previous task runs (W1 fix)
# Use ps+grep+awk to avoid pgrep -f matching this script's own command line
COMFY_PIDS=$(ps aux | grep '[p]ython.*main\.py' | awk '{print $2}' || true)
if [ -n "$COMFY_PIDS" ]; then
  echo "$COMFY_PIDS" | xargs kill 2>/dev/null || true
  COMFY_COUNT=$(echo "$COMFY_PIDS" | wc -l)
  echo "    killed $COMFY_COUNT stale ComfyUI process(es)"
else
  echo "    no stale ComfyUI processes"
fi
rm -f /tmp/copilot-detached-*.log 2>/dev/null

pkill -f "tsx src/server/index.ts" 2>/dev/null && echo "    backend stopped" || echo "    no backend running"
pkill -f "vite --host" 2>/dev/null && echo "    frontend stopped" || echo "    no frontend running"
pkill -f "tsx src/server/deepseekProxy.ts" 2>/dev/null && echo "    proxy stopped" || true

sleep 1

# ── Start services ──
echo ""
echo "==> Starting services..."

# Build NODE_OPTIONS for global proxy (Node.js fetch/undici doesn't read https_proxy)
NODE_PROXY_OPTS=""
if [ -n "${https_proxy:-}${HTTPS_PROXY:-}" ]; then
  PROXY_URL="${https_proxy:-${HTTPS_PROXY}}"
  NODE_PROXY_OPTS="--experimental-fetch"
  export NODE_OPTIONS="${NODE_OPTIONS:-} ${NODE_PROXY_OPTS}"
  # Node 20.5+ undici global dispatcher respects https_proxy when using this flag
  echo "    proxy:    $PROXY_URL (via NODE_OPTIONS)"
fi

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

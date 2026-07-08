#!/usr/bin/env bash
# Start a throwaway TEST agent (backend + frontend) from this repo on dedicated
# ports, so Playwright can run against current code without touching any other
# agent instance you may have running.
#
# Usage:  bash scripts/start-test-agent.sh [BACKEND_PORT [FRONTEND_PORT]]
# Defaults: backend 3002, frontend 5174.
#
# Prereqs: npm ci has been run, and an `env` file exists (cp env.example env;
# fill COPILOT_PROVIDER_API_KEY + COMFYUI_ROOT + MODEL_ROOTS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

BACKEND_PORT="${1:-3002}"
FRONTEND_PORT="${2:-5174}"

if [ ! -f env ]; then
  echo "ERROR: no 'env' file in $PROJECT_DIR." >&2
  echo "  cp env.example env  # then set COPILOT_PROVIDER_API_KEY, COMFYUI_ROOT, MODEL_ROOTS" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "ERROR: node_modules missing — run 'npm ci' first." >&2
  exit 1
fi

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LOCAL_IP="${LOCAL_IP:-127.0.0.1}"

echo "==> backend  on :$BACKEND_PORT  (logs: /tmp/test-agent-backend.log)"
nohup bash -c "set -a; . ./env; PORT=$BACKEND_PORT exec npx tsx src/server/index.ts" \
  > /tmp/test-agent-backend.log 2>&1 &
echo "==> frontend on :$FRONTEND_PORT → proxy :$BACKEND_PORT  (logs: /tmp/test-agent-frontend.log)"
VITE_API_PROXY_TARGET="http://127.0.0.1:$BACKEND_PORT" \
  nohup ./node_modules/.bin/vite --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort \
  > /tmp/test-agent-frontend.log 2>&1 &

sleep 7
if curl -sf "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null; then echo "  ✓ backend up"; else echo "  ✗ backend NOT up — check /tmp/test-agent-backend.log"; fi
if curl -sf -o /dev/null "http://$LOCAL_IP:$FRONTEND_PORT/"; then echo "  ✓ frontend up"; else echo "  (frontend still starting — check /tmp/test-agent-frontend.log)"; fi

cat <<EOF

▶ Run the tests against this agent:
  PW_BASE_URL=http://$LOCAL_IP:$FRONTEND_PORT \\
  PW_API=http://127.0.0.1:$BACKEND_PORT \\
  npm run playwright:ui          # fast GUI regression (~10s)

  ... MIGRATION_DEPTH=launch npm run playwright:migration   # live 双采 migration (~30 min)

▶ Stop the test agent:
  pkill -f "PORT=$BACKEND_PORT" ; pkill -f "port $FRONTEND_PORT --strictPort"
EOF

#!/usr/bin/env bash
# ============================================================
# start-catalog-server.sh -- launch the XPU-support catalog-server.
#
# The catalog-server is the SINGLE writer/coordinator for the custom-node
# XPU-support catalog (src/catalog/). It owns the SQLite index + the git working
# clone, both resident under XPU_CATALOG_DATA_DIR (default on /nfs_share). Every
# agent on every node is an HTTP client. Run ONE instance, on the NFS home node
# (172.16.124.12).
#
# Idempotent-ish: kills any existing instance on the port, relaunches detached,
# waits for /healthz. Env overrides:
#   XPU_CATALOG_DATA_DIR  (default /nfs_share/migration-knowledge/xpu-catalog)
#   XPU_CATALOG_PORT      (default 3100)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${XPU_CATALOG_PORT:-3100}"
DATA_DIR="${XPU_CATALOG_DATA_DIR:-/nfs_share/migration-knowledge/xpu-catalog}"
LOG="/tmp/xpu-catalog-server-${PORT}.log"

echo "==> catalog-server: repo=$REPO data=$DATA_DIR port=$PORT"
mkdir -p "$DATA_DIR/nodes"

# Stop any previous instance bound to this port (best-effort).
pkill -f "tsx .*src/catalog/server.ts" 2>/dev/null || true
sleep 1

cd "$REPO"
XPU_CATALOG_DATA_DIR="$DATA_DIR" XPU_CATALOG_PORT="$PORT" \
  setsid npx tsx src/catalog/server.ts > "$LOG" 2>&1 < /dev/null &
disown || true

echo "==> waiting for /healthz on :$PORT ..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    healthy: $(curl -s "http://127.0.0.1:${PORT}/healthz")"
    exit 0
  fi
  sleep 1
done
echo "!! catalog-server did not become healthy within ~30s. See $LOG" >&2
tail -20 "$LOG" >&2 || true
exit 1

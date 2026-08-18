#!/usr/bin/env bash
# ============================================================
# start-catalog-server.sh -- launch (or no-op if already up) the XPU-support
# catalog-server. The single writer/coordinator for the custom-node XPU-support
# catalog (src/catalog/): owns the SQLite index + git working clone, both under
# XPU_CATALOG_DATA_DIR. Run ONE instance; every agent is an HTTP client.
#
# Idempotent: if /healthz already answers on the port, does nothing. Seeds an
# empty working clone from recipes/knownCustomNodes on first run. Launches
# detached (setsid) so it survives the shell -- run this from a REAL shell
# (tmux/systemd/login), NOT a sandboxed one that reaps detached processes.
#
# Env overrides:
#   XPU_CATALOG_DATA_DIR  (default /nfs_share/migration-knowledge/xpu-catalog)  git clone + nodes/*.json
#   XPU_CATALOG_DB        (default <repo>/.demo-state/xpu-catalog-index.sqlite) LOCAL index (avoid sqlite-over-NFS)
#   XPU_CATALOG_PORT      (default 3100)
#   XPU_CATALOG_REMOTE    (optional git URL) -- when set, the server pushes writes to it
#   XPU_CATALOG_BRANCH    (default main)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${XPU_CATALOG_PORT:-3100}"
DATA_DIR="${XPU_CATALOG_DATA_DIR:-/nfs_share/migration-knowledge/xpu-catalog}"
DB="${XPU_CATALOG_DB:-$REPO/.demo-state/xpu-catalog-index.sqlite}"
REMOTE="${XPU_CATALOG_REMOTE:-}"
BRANCH="${XPU_CATALOG_BRANCH:-main}"
HEALTH="http://127.0.0.1:${PORT}/healthz"
LOG="/tmp/xpu-catalog-server-${PORT}.log"

echo "==> catalog-server: repo=$REPO data=$DATA_DIR db=$DB port=$PORT remote=${REMOTE:-<local-only>}"

# Idempotent: already serving on this port?
if curl -sf "$HEALTH" >/dev/null 2>&1; then
  echo "    already healthy: $(curl -s "$HEALTH")"
  exit 0
fi

mkdir -p "$DATA_DIR/nodes" "$(dirname "$DB")"

# Seed an empty working clone from the agent's recipes + knownCustomNodes.
if [ -z "$(ls -A "$DATA_DIR/nodes" 2>/dev/null)" ]; then
  echo "    seeding empty catalog from recipes + knownCustomNodes ..."
  ( cd "$REPO" && XPU_CATALOG_SEED_NODES_DIR="$DATA_DIR/nodes" \
      npx tsx -e 'import {writeSeedRecords} from "./src/catalog/seedImport"; console.log("    seeded", writeSeedRecords(process.env.XPU_CATALOG_SEED_NODES_DIR).length, "records")' )
fi

cd "$REPO"
ENVARGS=(XPU_CATALOG_DATA_DIR="$DATA_DIR" XPU_CATALOG_DB="$DB" XPU_CATALOG_PORT="$PORT" XPU_CATALOG_BRANCH="$BRANCH")
[ -n "$REMOTE" ] && ENVARGS+=(XPU_CATALOG_REMOTE="$REMOTE")

echo "==> launching detached (log: $LOG) ..."
setsid env "${ENVARGS[@]}" nohup npx tsx src/catalog/server.ts > "$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true

echo "==> waiting for /healthz on :$PORT ..."
for _ in $(seq 1 30); do
  if curl -sf "$HEALTH" >/dev/null 2>&1; then
    echo "    healthy: $(curl -s "$HEALTH")"
    exit 0
  fi
  sleep 1
done
echo "!! catalog-server did not become healthy within ~30s. See $LOG" >&2
tail -20 "$LOG" >&2 || true
exit 1

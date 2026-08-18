#!/usr/bin/env bash
# ============================================================
# ensure-catalog-server.sh -- deploy-time ensure for the XPU-support catalog.
#
# Called by deploy-agent-demo.sh. Self-skips on hosts that don't use the catalog.
# Otherwise: (1) bootstrap/push the repo when XPU_CATALOG_REMOTE is set, then
# (2) ensure the catalog-server is up. Best-effort by design -- it prints
# warnings and returns 0 so a catalog hiccup never aborts a code deploy.
#
# "Uses the catalog" = XPU_CATALOG_ENABLED=1 in the environment, OR the working
# clone dir already exists (a host that previously ran it).
# ============================================================
set -uo pipefail  # NOT -e: this is best-effort and must not abort the deploy

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${XPU_CATALOG_DATA_DIR:-/nfs_share/migration-knowledge/xpu-catalog}"
PORT="${XPU_CATALOG_PORT:-3100}"

if [ "${XPU_CATALOG_ENABLED:-}" != "1" ] && [ ! -d "$DATA_DIR/nodes" ]; then
  echo "==> [catalog] not enabled on this host (XPU_CATALOG_ENABLED!=1, no working clone) -- skipping."
  exit 0
fi

# 1) Repo bootstrap/push (only does GitHub work when XPU_CATALOG_REMOTE is set).
if ! bash "$SCRIPT_DIR/bootstrap-catalog-repo.sh"; then
  echo "!! [catalog] repo bootstrap failed (non-fatal) -- server still runs local-only." >&2
fi

# 2) Ensure the server is up (idempotent; no-op if /healthz already answers).
if bash "$SCRIPT_DIR/start-catalog-server.sh"; then
  echo "==> [catalog] server healthy on :$PORT"
else
  echo "!! [catalog] server did not come up (non-fatal). If in a sandboxed shell that reaps" >&2
  echo "!! detached procs, start it from a real shell: scripts/start-catalog-server.sh (tmux/systemd)." >&2
fi
exit 0

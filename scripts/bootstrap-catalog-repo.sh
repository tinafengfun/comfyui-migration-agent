#!/usr/bin/env bash
# ============================================================
# bootstrap-catalog-repo.sh -- one-time (idempotent) bootstrap of the independent
# comfyui-xpu-catalog GitHub repo behind the working clone.
#
# Seeds the working clone (if empty), git-inits + commits it, and -- when a remote
# is configured -- creates the private GitHub repo via `gh` (or just pushes if it
# already exists). Safe to re-run: existing repo -> push only; empty commit -> skip.
#
# Env:
#   XPU_CATALOG_DATA_DIR       (default /nfs_share/migration-knowledge/xpu-catalog)
#   XPU_CATALOG_REMOTE         git URL of the catalog repo, e.g.
#                              https://github.com/tinafengfun/comfyui-xpu-catalog
#                              (no remote -> local-only bootstrap, GitHub step skipped)
#   XPU_CATALOG_REPO_VISIBILITY (default --private; use --public to override)
#   GIT_HTTPS_PROXY            (default http://proxy.ims.intel.com:911 -- 911 not 912;
#                              child-prc:912 blocks *.github.com TLS)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${XPU_CATALOG_DATA_DIR:-/nfs_share/migration-knowledge/xpu-catalog}"
REMOTE="${XPU_CATALOG_REMOTE:-}"
VISIBILITY="${XPU_CATALOG_REPO_VISIBILITY:---private}"
PROXY="${GIT_HTTPS_PROXY:-http://proxy.ims.intel.com:911}"
BRANCH="${XPU_CATALOG_BRANCH:-main}"

echo "==> bootstrap catalog repo: data=$DATA_DIR remote=${REMOTE:-<local-only>}"
mkdir -p "$DATA_DIR/nodes" "$DATA_DIR/schema"

# 1) Seed the working clone if empty.
if [ -z "$(ls -A "$DATA_DIR/nodes" 2>/dev/null)" ]; then
  echo "    seeding ..."
  ( cd "$REPO" && XPU_CATALOG_SEED_NODES_DIR="$DATA_DIR/nodes" \
      npx tsx -e 'import {writeSeedRecords} from "./src/catalog/seedImport"; console.log("    seeded", writeSeedRecords(process.env.XPU_CATALOG_SEED_NODES_DIR).length, "records")' )
fi
cp -f "$REPO/schemas/xpu-node.schema.json" "$DATA_DIR/schema/" 2>/dev/null || true
if [ ! -f "$DATA_DIR/README.md" ]; then
  cat > "$DATA_DIR/README.md" <<'RM'
# comfyui-xpu-catalog

Authoritative store for the ComfyUI->Intel-XPU migration agent's custom-node
XPU-support catalog. `nodes/<nodeKey>.json` = one record per package; written
ONLY by the single catalog-server. Seeded from the agent's recipes/nodes +
knownCustomNodes. Empty `repository` fields are lazily backfilled on first
migration write-back.
RM
fi

# 2) git init + commit (idempotent).
cd "$DATA_DIR"
if [ ! -d .git ]; then
  git init -q -b "$BRANCH"
fi
git config user.name "xpu-catalog-bot"
git config user.email "xpu-catalog-bot@intel.local"
git add -A
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -q -m "catalog: bootstrap/seed ($(ls nodes | wc -l | tr -d ' ') records)"
  echo "    committed $(git rev-parse --short HEAD)"
else
  echo "    nothing to commit (clean)"
fi

# 3) GitHub repo (only when a remote is configured).
if [ -z "$REMOTE" ]; then
  echo "    XPU_CATALOG_REMOTE unset -- local-only; skipping GitHub create/push."
  echo "    (set XPU_CATALOG_REMOTE=https://github.com/<owner>/<name> to publish)"
  exit 0
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "!! gh CLI not found; cannot create/push the GitHub repo. Install gh or push manually." >&2
  exit 1
fi

# owner/name from the remote URL (strip scheme/host and .git)
SLUG="$(echo "$REMOTE" | sed -E 's#^.*github.com[:/]##; s#\.git$##; s#/+$##')"
export https_proxy="$PROXY" http_proxy="$PROXY"

git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REMOTE"

if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "    repo $SLUG exists -> pushing $BRANCH"
  git push -u origin "$BRANCH"
else
  echo "    creating $SLUG ($VISIBILITY) + pushing"
  gh repo create "$SLUG" "$VISIBILITY" --source=. --remote=origin --push \
    --description "Custom-node XPU-support catalog for the ComfyUI->Intel-XPU migration agent"
fi
echo "==> catalog repo bootstrapped: $SLUG"

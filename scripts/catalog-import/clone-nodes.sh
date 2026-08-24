#!/usr/bin/env bash
# Stage 1 — clone bucket A/B nodes from nodes.json into /nfs_share/custom_nodes/<pkg>
# and record HEAD commit. Idempotent (skips already-present). Bucket C is never cloned.
#
# Usage: clone-nodes.sh <nodes.json> [--nfs-root /nfs_share] [--out clone-state.json]
set -euo pipefail

NODES_JSON="${1:?usage: clone-nodes.sh <nodes.json> [--nfs-root DIR] [--out FILE]}"
NFS_ROOT="/nfs_share"
OUT="/tmp/catalog-import-clone-state.json"
shift || true
while [ $# -gt 0 ]; do case "$1" in
  --nfs-root) NFS_ROOT="$2"; shift 2;;
  --out) OUT="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done

DEST_ROOT="$NFS_ROOT/custom_nodes"
mkdir -p "$DEST_ROOT"
echo "{}" > "$OUT.tmp"

# iterate rows: package_name, repository, bucket
python3 - "$NODES_JSON" <<'PY' | while IFS=$'\t' read -r pkg repo bucket; do
import json, sys
for r in json.load(open(sys.argv[1])):
    if r["bucket"] == "C":
        continue
    print(f"{r['package_name']}\t{r['repository']}\t{r['bucket']}")
PY
  dest="$DEST_ROOT/$pkg"
  if [ -d "$dest/.git" ]; then
    commit="$(git -C "$dest" rev-parse HEAD 2>/dev/null || echo '')"
    echo "  SKIP (present) $pkg @ ${commit:0:10}"
  else
    echo "  CLONE $pkg <- $repo"
    if git clone --filter=blob:none --quiet "$repo" "$dest" 2>/tmp/clone-$pkg.err; then
      commit="$(git -C "$dest" rev-parse HEAD 2>/dev/null || echo '')"
      echo "        ok @ ${commit:0:10}"
    else
      commit=""
      echo "        CLONE FAILED (see /tmp/clone-$pkg.err): $(tail -1 /tmp/clone-$pkg.err 2>/dev/null)"
    fi
  fi
  # record state (pkg -> {nfsPath, commit, cloned})
  python3 - "$OUT.tmp" "$pkg" "$dest" "$commit" "$bucket" <<'PY'
import json, sys
f, pkg, dest, commit, bucket = sys.argv[1:6]
d = json.load(open(f))
d[pkg] = {"nfsPath": dest, "commit": commit, "cloned": bool(commit), "bucket": bucket}
json.dump(d, open(f, "w"), indent=2)
PY
done

mv "$OUT.tmp" "$OUT"
python3 -c "import json; d=json.load(open('$OUT')); ok=sum(1 for v in d.values() if v['cloned']); print(f'clone-state: {ok}/{len(d)} present -> $OUT')"

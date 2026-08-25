#!/usr/bin/env bash
# Orchestrate the catalog-import pipeline. Idempotent/resumable end to end.
#   run-all.sh --pilot      # ~7-node representative subset (validate the chain)
#   run-all.sh --all        # full custom_node_list (~125 bind/sycl nodes)
# Env: XPU_CATALOG_ENABLED=1 XPU_CATALOG_SERVER_URL=http://127.0.0.1:3100
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="--all"; [ "${1:-}" = "--pilot" ] && MODE="--pilot"
W=/tmp/catalog-import; mkdir -p "$W"
export XPU_CATALOG_ENABLED="${XPU_CATALOG_ENABLED:-1}"
export XPU_CATALOG_SERVER_URL="${XPU_CATALOG_SERVER_URL:-http://127.0.0.1:3100}"

echo "== 0/ parse + classify (=$MODE) =="
python3 "$HERE/parse-xlsx.py" $MODE -o "$W/nodes.json"
echo "== 1/ clone bucket A/B -> /nfs_share/custom_nodes =="
bash "$HERE/clone-nodes.sh" "$W/nodes.json" --out "$W/clone-state.json"
echo "== 2/ install deps + cuda->xpu patch =="
bash "$HERE/install-deps.sh" "$W/nodes.json" --patch-out-dir "$W/patches"
echo "== 3/ /object_info XPU registration harvest =="
HTIMEOUT=300; [ "$MODE" = "--all" ] && HTIMEOUT=600   # ~125 nodes take longer to import
python3 "$HERE/harvest-objectinfo.py" "$W/nodes.json" --clone-state "$W/clone-state.json" --out "$W/harvest.json" --timeout "$HTIMEOUT"
echo "== 5/ build records -> catalog (candidate->trusted) + knownCustomNodes entries =="
npx tsx "$HERE/build-records.mts" --nodes "$W/nodes.json" --clone "$W/clone-state.json" \
  --harvest "$W/harvest.json" --patches-dir "$W/patches" --known-out "$W/known-entries.ts"
echo ""
echo "== done. catalog records: $(curl -s -m5 "$XPU_CATALOG_SERVER_URL/healthz" | jq -r .records) =="
echo "   knownCustomNodes entries to append -> $W/known-entries.ts"
echo "   (Stage 4 SYCL image build for bucket-B nodes is run separately: build-sycl-image.sh)"

#!/usr/bin/env bash
#
# One-time (but safely re-runnable) migration of the current NFS-shared model +
# custom-node tree to a new, flattened NFS share hosted on a different node.
#
# Background: local-xpu has historically been the NFS *server* for
# /home/intel/hf_models (models + a de-facto shared custom_nodes/venv tree
# under zimage_workflow/). This script moves everything to a fresh share
# (172.16.124.12:/nfs_share by default) with a flattened layout — the
# zimage_workflow/ nesting was incidental, not meaningful for a dedicated
# share — so both nodes can eventually mount ONE new, clean, node-agnostic
# path instead of local-xpu's ad hoc directory.
#
# Usage:
#   scripts/migrate-nfs-share.sh [--dry-run] [--parallel N]
#
# Safe by design:
#   - Never deletes the source. This only copies (rsync -a, no --delete).
#   - Re-running is cheap: rsync only transfers deltas on subsequent runs.
#   - --dry-run prints exactly what would run without touching the network.
#   - Each top-level source entry gets its own rsync job + own log file under
#     ./migrate-nfs-share-logs/, so a partial failure is easy to isolate and
#     re-run individually without redoing the whole transfer.
#
# What "flattened" means here: SRC/zimage_workflow/custom_nodes ends up at
# DEST/custom_nodes (not DEST/zimage_workflow/custom_nodes), and every other
# top-level entry in SRC (diffusion_models/, checkpoints/, loras/, ...) maps
# to the identically-named entry directly under DEST.

set -euo pipefail

SRC_DIR="${SRC_DIR:-/home/intel/hf_models}"
DEST_HOST="${DEST_HOST:-172.16.124.12}"
DEST_USER="${DEST_USER:-intel}"
DEST_PATH="${DEST_PATH:-/nfs_share}"
SSH_KEY="${SSH_KEY:-/root/.ssh/id_ed25519}"
PARALLEL="${PARALLEL:-4}"
DRY_RUN=0
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/migrate-nfs-share-logs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR"

RSYNC_OPTS=(-a --info=progress2 --stats -e "ssh -i ${SSH_KEY}")
[[ "$DRY_RUN" == "1" ]] && RSYNC_OPTS+=(--dry-run)

echo "== migrate-nfs-share =="
echo "source:      ${SRC_DIR}"
echo "destination: ${DEST_USER}@${DEST_HOST}:${DEST_PATH} (flattened)"
echo "parallelism: ${PARALLEL}"
echo "dry-run:     ${DRY_RUN}"
echo "logs:        ${LOG_DIR}/"
echo

# The zimage_workflow/ subtree flattens: its children land directly under
# DEST, not under DEST/zimage_workflow/. Everything else at SRC's top level
# maps 1:1 by name. Build the (source_path, dest_name) job list explicitly
# rather than guessing — this is the one place that encodes the flatten
# decision, so it's the one place to edit if the layout ever changes again.
#
# Name collisions: SRC's top level can have a same-named entry as something
# under zimage_workflow/ (confirmed: an empty top-level custom_nodes/ next to
# the real zimage_workflow/custom_nodes/) — flattening both to the same DEST
# name must not become two concurrent rsync jobs racing the same path. The
# zimage_workflow-sourced entry always wins; a colliding top-level entry is
# skipped with a warning rather than silently relying on one of them being
# empty.
declare -A SEEN=()
declare -a JOBS=()
for entry in "${SRC_DIR}"/zimage_workflow/*; do
  [[ -e "$entry" ]] || continue
  name="$(basename "$entry")"
  JOBS+=("${entry}|${name}")
  SEEN["$name"]=1
done
for entry in "${SRC_DIR}"/*; do
  [[ -e "$entry" ]] || continue
  name="$(basename "$entry")"
  [[ "$name" == "zimage_workflow" ]] && continue
  # Deliberately skipped, not a bash-glob accident: bash's `*` glob doesn't
  # match dotfiles by default, which would silently drop .bin/.cache/.tmp
  # (confirmed contents: a wget shim, HF download-cache metadata, a
  # proxy-test scratch dir — all tiny, transient, regenerable). If SRC ever
  # grows a dotfile worth keeping, add it explicitly here rather than
  # flipping on dotglob for everything.
  if [[ -n "${SEEN[$name]:-}" ]]; then
    echo "WARNING: SRC top-level '${name}' collides with a zimage_workflow/${name} entry — skipping the top-level one (zimage_workflow wins). Check it's actually empty/disposable: ${entry}" >&2
    continue
  fi
  JOBS+=("${entry}|${name}")
  SEEN["$name"]=1
done

echo "Planned ${#JOBS[@]} sync jobs:"
for job in "${JOBS[@]}"; do
  echo "  ${job%%|*}  ->  ${DEST_PATH}/${job##*|}"
done
echo

ssh -i "$SSH_KEY" "${DEST_USER}@${DEST_HOST}" "mkdir -p '${DEST_PATH}'"

run_one() {
  local src="$1" name="$2"
  local log="${LOG_DIR}/${name}.log"
  echo "[start] ${name}" | tee "$log"
  # Directory sources need trailing slashes (copy contents into DEST/name/);
  # plain-file sources must NOT get one, or rsync tries to change_dir into
  # the file and fails with "Not a directory" (confirmed live: this broke
  # every top-level standalone file — the 2 download_weights*.sh scripts and
  # 4 large standalone .safetensors/.gguf checkpoints).
  local dest_arg="${DEST_USER}@${DEST_HOST}:${DEST_PATH}/${name}"
  local src_arg="${src}"
  if [[ -d "$src" ]]; then
    src_arg="${src}/"
    dest_arg="${dest_arg}/"
  fi
  if rsync "${RSYNC_OPTS[@]}" "${src_arg}" "${dest_arg}" >>"$log" 2>&1; then
    echo "[ok]    ${name}"
  else
    echo "[FAILED] ${name} — see ${log}"
    return 1
  fi
}
export -f run_one
export RSYNC_OPTS DEST_USER DEST_HOST DEST_PATH LOG_DIR

FAILED=0
running=0
declare -a pids=()
for job in "${JOBS[@]}"; do
  src="${job%%|*}"; name="${job##*|}"
  run_one "$src" "$name" &
  pids+=($!)
  running=$((running + 1))
  if [[ "$running" -ge "$PARALLEL" ]]; then
    wait -n || FAILED=1
    running=$((running - 1))
  fi
done
wait || FAILED=1

echo
if [[ "$FAILED" == "1" ]]; then
  echo "One or more jobs failed — check ${LOG_DIR}/*.log, then re-run this script (rsync will only transfer what's missing)."
  exit 1
fi
echo "All jobs completed. Verify with: ssh -i ${SSH_KEY} ${DEST_USER}@${DEST_HOST} 'du -sh ${DEST_PATH}/*'"

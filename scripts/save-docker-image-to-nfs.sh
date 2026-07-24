#!/usr/bin/env bash
#
# Save a locally-loaded Docker image to the shared NFS store, versioned by its
# own tag plus a manifest recording the exact source digest.
#
# Why: every GPU node independently `docker pull`ing the same (large) image
# from Docker Hub is slow, requires internet/proxy access on every node, and
# — more importantly — Docker Hub tags aren't immutable. If the upstream
# publisher ever republishes different content under the same tag, different
# nodes could silently end up running different bits with nothing to notice.
# Saving one canonical, digest-pinned copy to NFS and having every node
# `load-docker-image-from-nfs.sh` from it removes both problems.
#
# Usage:
#   scripts/save-docker-image-to-nfs.sh <image:tag> [--refresh]
#
# --refresh: use when re-saving the SAME tag after the upstream publisher has
#   pushed new content under it (confirmed via a changed digest) — writes a
#   second, distinctly-named version instead of overwriting the first, and
#   requires you to explicitly repoint `current` afterward.

set -euo pipefail

IMAGE="${1:?Usage: $0 <image:tag> [--refresh]}"
REFRESH=0
[[ "${2:-}" == "--refresh" ]] && REFRESH=1

NFS_ROOT="${NFS_DOCKER_IMAGES_ROOT:-/nfs_share/docker-images}"
mkdir -p "$NFS_ROOT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $IMAGE is not present locally (docker images). Pull/load it first." >&2
  exit 1
fi

# Version string: sanitized tag, e.g. intel/llm-scaler-omni:0.1.0-b7 -> intel-llm-scaler-omni-0.1.0-b7
SAFE_NAME="$(echo "$IMAGE" | tr '/:' '--')"
DIGEST="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "unknown (locally built or never pulled from a registry)")"
# Content-addressed image config ID — unlike RepoDigests (a registry-pull-only
# concept, empty after docker load), this round-trips correctly through
# save/load and is what load-docker-image-from-nfs.sh verifies against.
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"

if [[ "$REFRESH" == "1" ]]; then
  SUFFIX="-refreshed$(date -u +%Y%m%d)"
else
  SUFFIX=""
fi

TAR_PATH="${NFS_ROOT}/${SAFE_NAME}${SUFFIX}.tar"
MANIFEST_PATH="${NFS_ROOT}/${SAFE_NAME}${SUFFIX}.manifest.json"

if [[ -f "$TAR_PATH" && "$REFRESH" != "1" ]]; then
  echo "ERROR: ${TAR_PATH} already exists. Pass --refresh if this is a deliberate re-save of updated upstream content." >&2
  exit 1
fi

echo "== Saving ${IMAGE} =="
echo "source digest: ${DIGEST}"
echo "destination:   ${TAR_PATH}"
echo "(this can take a while for a large image — streaming docker save directly to NFS)"

docker save "$IMAGE" -o "$TAR_PATH"

SIZE_BYTES="$(stat -c '%s' "$TAR_PATH")"
SIZE_HUMAN="$(du -h "$TAR_PATH" | cut -f1)"

cat > "$MANIFEST_PATH" <<EOF
{
  "image": "${IMAGE}",
  "source_digest": "${DIGEST}",
  "image_id": "${IMAGE_ID}",
  "tar_file": "$(basename "$TAR_PATH")",
  "size_bytes": ${SIZE_BYTES},
  "size_human": "${SIZE_HUMAN}",
  "saved_by": "$(whoami)@$(hostname)",
  "saved_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "== Manifest =="
cat "$MANIFEST_PATH"

CURRENT_LINK="${NFS_ROOT}/current"
if [[ "$REFRESH" != "1" ]]; then
  ln -sf "$(basename "$TAR_PATH")" "$CURRENT_LINK"
  echo "== 'current' -> $(basename "$TAR_PATH") =="
else
  echo
  echo "NOTE: --refresh used. 'current' was NOT repointed automatically."
  echo "Review ${MANIFEST_PATH} against the previous one, then if this should become"
  echo "the new default: ln -sf $(basename "$TAR_PATH") ${CURRENT_LINK}"
fi

CHANGELOG="${NFS_ROOT}/CHANGELOG.md"
{
  echo "- $(date -u +%Y-%m-%dT%H:%M:%SZ) — saved \`${IMAGE}\` (digest \`${DIGEST}\`) as \`$(basename "$TAR_PATH")\` (${SIZE_HUMAN}), by $(whoami)@$(hostname)"
} >> "$CHANGELOG"

echo
echo "Done. Other nodes can now run:"
echo "  scripts/load-docker-image-from-nfs.sh"

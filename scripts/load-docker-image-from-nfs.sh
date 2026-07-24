#!/usr/bin/env bash
#
# Load a Docker image from the shared NFS store (populated by
# save-docker-image-to-nfs.sh) into this GPU node's local Docker daemon.
#
# This is the standard way to onboard a *new* GPU node onto the shared
# environment, or to refresh an existing node — no Docker Hub pull needed.
# After this completes, gpu-nodes.json's existing `docker_image` field and
# Step 05's Docker-runtime flow work completely unchanged; this script only
# populates the local Docker daemon's image cache.
#
# Usage:
#   scripts/load-docker-image-from-nfs.sh [version-basename]
#
# With no argument, loads whatever `current` points at. Pass an explicit
# basename (e.g. `intel-llm-scaler-omni-0.1.0-b7-refreshed20260801`) to pin a
# specific version instead of whatever is currently the default.

set -euo pipefail

NFS_ROOT="${NFS_DOCKER_IMAGES_ROOT:-/nfs_share/docker-images}"
VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  if [[ ! -L "${NFS_ROOT}/current" ]]; then
    echo "ERROR: ${NFS_ROOT}/current does not exist and no version was given." >&2
    echo "Available versions:" >&2
    ls "${NFS_ROOT}"/*.tar 2>/dev/null | xargs -n1 basename >&2 || true
    exit 1
  fi
  TAR_PATH="${NFS_ROOT}/$(readlink "${NFS_ROOT}/current")"
else
  TAR_PATH="${NFS_ROOT}/${VERSION}.tar"
fi

MANIFEST_PATH="${TAR_PATH%.tar}.manifest.json"

if [[ ! -f "$TAR_PATH" ]]; then
  echo "ERROR: ${TAR_PATH} not found." >&2
  exit 1
fi

echo "== Loading $(basename "$TAR_PATH") =="
if [[ -f "$MANIFEST_PATH" ]]; then
  echo "-- manifest --"
  cat "$MANIFEST_PATH"
  echo
fi

LOAD_OUTPUT="$(docker load -i "$TAR_PATH")"
echo "$LOAD_OUTPUT"

LOADED_IMAGE="$(echo "$LOAD_OUTPUT" | sed -n 's/^Loaded image: //p' | tail -1)"

if [[ -n "$LOADED_IMAGE" && -f "$MANIFEST_PATH" ]]; then
  # NOTE: RepoDigests is a registry-pull-only concept and is always empty
  # after `docker load` — it is NOT a valid post-load integrity check.
  # The content-addressed image config ID (docker inspect .Id) is what
  # actually round-trips correctly through save/load, so that's what we
  # verify against here.
  EXPECTED_ID="$(sed -n 's/.*"image_id": *"\([^"]*\)".*/\1/p' "$MANIFEST_PATH")"
  ACTUAL_ID="$(docker image inspect "$LOADED_IMAGE" --format '{{.Id}}' 2>/dev/null || echo "unknown")"
  echo
  if [[ -z "$EXPECTED_ID" ]]; then
    echo "(manifest predates image_id tracking — no post-load integrity check available for this version)"
  else
    echo "manifest image_id: ${EXPECTED_ID}"
    echo "loaded image_id:   ${ACTUAL_ID}"
    if [[ "$ACTUAL_ID" != "unknown" && "$EXPECTED_ID" != "$ACTUAL_ID" ]]; then
      echo "WARNING: image_id mismatch between manifest and locally-loaded image — investigate before trusting this as reproducible." >&2
    else
      echo "image_id verified — content matches what was saved to NFS."
    fi
  fi
fi

echo
echo "Done. ${LOADED_IMAGE:-the image} is now available locally for gpu-nodes.json's docker_image field."

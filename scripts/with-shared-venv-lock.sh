#!/usr/bin/env bash
#
# Serializes pip installs against the shared NFS venv (/nfs_share/venv-container-xpu),
# which has no cross-invocation lock of its own and can have its site-packages
# corrupted by two concurrent installs. This is a real, routine risk: Step 05's
# enum-package/dependency installs and node-precheck.mts --prepare all install
# into this same venv whenever a workflow needs a package it doesn't have yet —
# two people testing different new workflows around the same time is a normal
# collision, not an edge case.
#
# Uses atomic `mkdir` for cross-host mutual exclusion, NOT flock/fcntl — confirmed
# live that flock does not provide real cross-host exclusion on this NFS mount:
# remote-124-12 is both the NFS server and accesses /nfs_share as a local path
# (not via its own NFS client mount), so its local flock() calls never route
# through the same lock coordination as local-xpu's NFS-client flock() calls.
# Two-way empirical test: a genuine 8s flock hold on one host was invisible to
# the other host's flock() attempt (acquired in ~7ms instead of blocking).
# `mkdir` (a core filesystem namespace operation, not the optional locking
# sideband) was verified to work correctly in both directions instead.
#
# Usage:
#   scripts/with-shared-venv-lock.sh <venv_python> <pip-args...>
# Example:
#   scripts/with-shared-venv-lock.sh /nfs_share/venv-container-xpu/bin/python3 \
#     install -r some-node/requirements.txt

set -euo pipefail

VENV_PYTHON="${1:?Usage: $0 <venv_python> <pip-args...>}"
shift

LOCK_DIR="${SHARED_VENV_LOCK_DIR:-/nfs_share/venv-container-xpu.lock}"
# Staleness is computed by comparing this host's `date +%s` against the
# holder's own `date +%s` recorded in holder.json — confirmed live that
# local-xpu and remote-124-12 have ~200s of clock skew (no NTP sync between
# them), so this threshold needs enough margin above that skew to avoid
# false-stale detection; 900s gives a comfortable ~700s margin.
STALE_SECONDS="${SHARED_VENV_LOCK_STALE_SECONDS:-900}"   # 15 min
WAIT_SECONDS="${SHARED_VENV_LOCK_WAIT_SECONDS:-1200}"     # 20 min
POLL_INTERVAL=2

holder_age_seconds() {
  local holder_file="$1/holder.json"
  [[ -f "$holder_file" ]] || { echo 999999999; return; }
  local acquired_at
  acquired_at="$(sed -n 's/.*"acquired_at": *\([0-9]*\).*/\1/p' "$holder_file" 2>/dev/null || true)"
  if [[ -z "$acquired_at" ]]; then
    echo 999999999
    return
  fi
  echo $(( $(date +%s) - acquired_at ))
}

holder_summary() {
  local holder_file="$1/holder.json"
  [[ -f "$holder_file" ]] && cat "$holder_file" || echo "(no holder.json)"
}

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    local age
    age="$(holder_age_seconds "$LOCK_DIR")"
    if [[ "$age" -gt "$STALE_SECONDS" ]]; then
      echo "WARN: shared-venv lock at ${LOCK_DIR} is stale (held ${age}s > ${STALE_SECONDS}s threshold) — breaking it. Previous holder: $(holder_summary "$LOCK_DIR")" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [[ "$waited" -ge "$WAIT_SECONDS" ]]; then
      echo "ERROR: could not acquire shared-venv lock at ${LOCK_DIR} within ${WAIT_SECONDS}s. Currently held by: $(holder_summary "$LOCK_DIR")" >&2
      exit 1
    fi
    if [[ $((waited % 20)) -eq 0 ]]; then
      echo "waiting for shared-venv lock (held ${age}s so far by $(holder_summary "$LOCK_DIR"))..." >&2
    fi
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done

  cat > "$LOCK_DIR/holder.json" <<EOF
{
  "hostname": "$(hostname)",
  "pid": $$,
  "acquired_at": $(date +%s),
  "purpose": "$(printf '%s' "$*" | sed 's/"/\\"/g')"
}
EOF
}

release_lock() {
  # rm -rf, not rmdir: holder.json lives inside the lock dir, so it's never
  # empty. Only the current holder calls this (via the EXIT trap), so there's
  # no atomicity requirement on release the way there is on acquire.
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

trap release_lock EXIT

acquire_lock "$@"
echo "shared-venv lock acquired ($(date +%s)) — running: ${VENV_PYTHON} -m pip $*"
"$VENV_PYTHON" -m pip "$@"

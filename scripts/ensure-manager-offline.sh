#!/usr/bin/env bash
# ensure-manager-offline.sh — force ComfyUI-Manager into offline network mode in a
# comfyui-core so it does NOT do blocking network calls on startup.
#
# WHY: ComfyUI-Manager defaults to network_mode=public and, on startup, makes
# synchronous network calls (CNR registry / version check). On a proxy-only host
# (Intel corp net: direct external egress is silently dropped), a container launched
# WITHOUT proxy env has those calls hang on slow TCP retries, which blocks ComfyUI's
# single asyncio event loop — the HTTP server accepts connections but never responds
# ("permanent block"). This bit the Step-12b delivery dry-run: its generated launch
# script carried no proxy env (the recorded launch_command had none), while the main
# migration container survived only because comfyuiLifecycle passes proxy passthrough.
#
# A migrated/reproduced runtime never needs Manager's network at runtime (nodes are
# git-cloned out-of-band; Manager's remote fetch is management-only), so offline mode
# is both safe and correct — and deterministic regardless of proxy. In manager_core.py
# the gate is `if get_config()['network_mode'] != 'public': dont_wait = True`, i.e. any
# non-public mode makes the startup CNR fetch non-blocking.
#
# Idempotent. Run at core provisioning (fresh /nfs_share/comfyui-core) and any time a
# core reverts to public. Uses sudo only if the config file isn't writable directly.
#
# Usage: scripts/ensure-manager-offline.sh [comfyui-core-path]   (default /nfs_share/comfyui-core)
set -euo pipefail

CORE="${1:-/nfs_share/comfyui-core}"
# ComfyUI-Manager keeps its runtime config under <core>/user/__manager/config.ini
# (older builds used custom_nodes/comfyui-manager/config.ini). Cover both.
CANDIDATES=("$CORE/user/__manager/config.ini" "$CORE/custom_nodes/comfyui-manager/config.ini")

write_offline() {
  local cfg="$1"
  # Preserve other keys; only flip network_mode. Create a minimal config if absent.
  # Writes directly when the file is writable, else via sudo (config is often root-owned
  # on the shared NFS core). SUDO_PW overrides the default sudo password.
  if [ -f "$cfg" ]; then
    if grep -qiE '^\s*network_mode\s*=' "$cfg"; then
      if [ -w "$cfg" ]; then sed -i 's/^[[:space:]]*network_mode[[:space:]]*=.*/network_mode = offline/I' "$cfg"
      else echo "${SUDO_PW:-intel.123}" | sudo -S -p "" sed -i 's/^[[:space:]]*network_mode[[:space:]]*=.*/network_mode = offline/I' "$cfg"; fi
    else
      if [ -w "$cfg" ]; then printf '\nnetwork_mode = offline\n' >> "$cfg"
      else echo "${SUDO_PW:-intel.123}" | sudo -S -p "" bash -c "printf '\nnetwork_mode = offline\n' >> '$cfg'"; fi
    fi
  else
    local dir; dir="$(dirname "$cfg")"
    mkdir -p "$dir" 2>/dev/null || echo "${SUDO_PW:-intel.123}" | sudo -S -p "" mkdir -p "$dir"
    local body=$'[default]\nsecurity_level = normal\nnetwork_mode = offline\n'
    if [ -w "$dir" ]; then printf '%s' "$body" > "$cfg"
    else echo "${SUDO_PW:-intel.123}" | sudo -S -p "" bash -c "printf '%s' '$body' > '$cfg'"; fi
  fi
}

done_any=0
for cfg in "${CANDIDATES[@]}"; do
  parent="$(dirname "$(dirname "$cfg")")"   # the user/ or custom_nodes/ dir
  # Only act where the surrounding structure exists (don't create a stray custom_nodes path).
  if [ -f "$cfg" ] || [ -d "$parent" ]; then
    write_offline "$cfg"
    echo "ensured offline: $cfg -> $(grep -iE '^\s*network_mode' "$cfg" 2>/dev/null | head -1 | tr -d ' ')"
    done_any=1
  fi
done

[ "$done_any" = 1 ] || { echo "no ComfyUI-Manager config location found under $CORE (Manager not installed?) — nothing to do"; }

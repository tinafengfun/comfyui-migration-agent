#!/usr/bin/env bash
# ============================================================
# Migration-agent daily check (§J)
# ------------------------------------------------------------
# Runs:
#   1. Workspace purity lint (§C) — catches agent pollution in ComfyUI root
#   2. Recipe schema validation (§F/§I) — catches drift in recipes/
#
# Output is appended to logs/daily-check.log AND echoed to stdout. Designed
# to run from cron (no TTY) and manually.
#
# Exit status: non-zero if ANY sub-check failed. Cron will mail the output.
#
# Manual run:
#   bash scripts/daily-check.sh
#   bash scripts/daily-check.sh --comfyui-root /custom/ComfyUI
#
# Cron entry (daily at 09:07 — off the hour to spread API load):
#   7 9 * * * /path/to/agent-demo/scripts/daily-check.sh >> /path/to/agent-demo/logs/cron.log 2>&1
# ============================================================
set -uo pipefail

# ── Locate the agent root (the dir containing this script's parent). ────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${AGENT_ROOT}"

mkdir -p logs logs/daily-check.log

# ── Args ────────────────────────────────────────────────────────────────────
COMFYUI_ROOT_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --comfyui-root)
      COMFYUI_ROOT_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Resolve ComfyUI root: CLI flag > env var > default sibling checkout.
if [[ -n "${COMFYUI_ROOT_OVERRIDE}" ]]; then
  COMFYUI_ROOT="${COMFYUI_ROOT_OVERRIDE}"
elif [[ -n "${COMFYUI_ROOT:-}" ]]; then
  : # use env as-is
else
  COMFYUI_ROOT="../ComfyUI"
fi
export COMFYUI_ROOT

# ── Preflight ───────────────────────────────────────────────────────────────
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found on PATH" >&2
  exit 3
fi

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

LOG_FILE="logs/daily-check.log"
HEADER="$(printf '############################################################\n# daily-check %s\n# agent_root:    %s\n# comfyui_root:  %s\n# log_file:      %s\n############################################################\n' \
  "$(ts)" "${AGENT_ROOT}" "${COMFYUI_ROOT}" "${LOG_FILE}")"

# Write header to both stdout and log file.
echo "${HEADER}" | tee -a "${LOG_FILE}"

# Capture each sub-check's output to a temp file, then append to the log
# after the check completes. This way exit codes survive the tee pipe.
PURITY_TMP="$(mktemp)"
RECIPE_TMP="$(mktemp)"
trap 'rm -f "${PURITY_TMP}" "${RECIPE_TMP}"' EXIT

echo "" | tee -a "${LOG_FILE}"
echo "=== workspace purity lint (§C) ($(ts)) ===" | tee -a "${LOG_FILE}"
npx tsx scripts/lint-workspace-purity.mts --comfyui-root "${COMFYUI_ROOT}" 2>&1 | tee "${PURITY_TMP}"
PURITY_RC=${PIPESTATUS[0]}
cat "${PURITY_TMP}" >> "${LOG_FILE}"
echo "=== purity exit: ${PURITY_RC} ===" | tee -a "${LOG_FILE}"

echo "" | tee -a "${LOG_FILE}"
echo "=== recipe schema validation (§F/§I) ($(ts)) ===" | tee -a "${LOG_FILE}"
npx tsx scripts/validate-recipes.mts 2>&1 | tee "${RECIPE_TMP}"
RECIPE_RC=${PIPESTATUS[0]}
cat "${RECIPE_TMP}" >> "${LOG_FILE}"
echo "=== recipes exit: ${RECIPE_RC} ===" | tee -a "${LOG_FILE}"

SUMMARY="$(printf '\n############################################################\n# Summary\n#   purity:   %s  (0 clean / 1 pollution)\n#   recipes:  %s  (0 all valid / 1 some invalid)\n# Overall: %s\n############################################################\n' \
  "${PURITY_RC}" "${RECIPE_RC}" "$(( PURITY_RC + RECIPE_RC ))")"
echo "${SUMMARY}" | tee -a "${LOG_FILE}"

exit $(( PURITY_RC + RECIPE_RC ))

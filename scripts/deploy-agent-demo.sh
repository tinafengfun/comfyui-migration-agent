#!/usr/bin/env bash
# ============================================================
# deploy-agent-demo.sh -- sync the canonical repo (comfyui-migration-agent,
# checked out here) onto the deployed agent-demo copy, then restart it.
#
# Wraps the manual sequence used by hand throughout this project's
# development: diff-audit copy -> tsc --noEmit -> vitest run -> restart.sh ->
# confirm task state survived. This is stage (e)'s "deploy" half of the
# generate -> verify -> merge -> push -> deploy pipeline for Step 13 agent
# self-improvements -- it is NEVER invoked automatically by anything else in
# that pipeline. Run it deliberately, after a merge (and, usually, a push).
#
# Safety: never restart while a step is `running` or `waiting_for_human`.
# A backend restart while a step is `waiting_for_human` orphans its live SDK
# session -- if a human answers after the fact, the resume can silently
# discard that answer (see the resumeStep fast-path bug fixed earlier this
# project). This script checks the live task list first and refuses to
# proceed unless --yes is passed, so a human (or an agent acting on a human's
# explicit go-ahead) has to consciously override after reading the warning.
#
# Only additive: copies files forward, never deletes anything that exists
# only in the deployed copy (no rsync --delete) -- if a file was removed in
# the canonical repo, remove it from agent-demo by hand and note why.
#
# Usage:
#   bash scripts/deploy-agent-demo.sh --yes [--agent-demo /path/to/agent-demo] [--api http://127.0.0.1:3001]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMA_STAGING="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DEMO="/home/intel/tianfeng/comfy/ComfyUI/agent-demo"
API="http://127.0.0.1:3001"
CONFIRMED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) CONFIRMED=1; shift ;;
    --agent-demo) AGENT_DEMO="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

echo "==> Source (canonical repo): $CMA_STAGING"
echo "==> Target (deployed):       $AGENT_DEMO"

echo ""
echo "==> Checking live task state before syncing..."
ACTIVE_FOUND=0
if TASKS_JSON=$(curl -sf "$API/api/tasks" 2>/dev/null); then
  echo "$TASKS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
active = False
for t in d.get('tasks', []):
    print(f\"  task {t['id']}: {t['status']}\")
    for s in t.get('steps', []):
        if s['status'] in ('running', 'waiting_for_human'):
            print(f\"    step {s['id']}: {s['status']}  <-- ACTIVE\")
            active = True
sys.exit(1 if active else 0)
" || ACTIVE_FOUND=1
else
  echo "  (backend not reachable at $API -- skipping live check; proceed with caution)"
fi

if [ "$ACTIVE_FOUND" -eq 1 ]; then
  echo ""
  echo "  WARNING: a step is running or waiting_for_human right now."
  echo "  Restarting will orphan its live SDK session. If a human answers a pending"
  echo "  question after this restart, the resume may silently discard that answer."
fi

if [ "$CONFIRMED" -ne 1 ]; then
  echo ""
  echo "  Refusing to proceed without --yes (re-run with --yes once you've confirmed"
  echo "  the state above is safe to restart through)."
  exit 1
fi

echo ""
echo "==> Syncing src/, scripts/, prompts/, recipes/, schemas/ (additive only, no deletes)..."
for dir in src scripts prompts recipes schemas; do
  if [ -d "$CMA_STAGING/$dir" ]; then
    mkdir -p "$AGENT_DEMO/$dir"
    cp -r "$CMA_STAGING/$dir/." "$AGENT_DEMO/$dir/"
  fi
done

echo ""
echo "==> Verifying sync (diff -rq, ignoring Python bytecode caches -- those are expected"
echo "    to diverge locally in agent-demo from real tool runs, not sync artifacts)..."
for dir in src scripts prompts recipes schemas; do
  if [ -d "$CMA_STAGING/$dir" ]; then
    if diff -rq -x "__pycache__" -x "*.pyc" "$CMA_STAGING/$dir" "$AGENT_DEMO/$dir"; then
      echo "  OK: $dir"
    else
      echo "  MISMATCH: $dir -- sync did not produce an identical copy, investigate before restarting"
      exit 1
    fi
  fi
done

cd "$AGENT_DEMO"

echo ""
echo "==> npx tsc --noEmit -p ."
npx tsc --noEmit -p .

echo ""
echo "==> npx vitest run"
npx vitest run

echo ""
echo "==> Restarting agent-demo..."
bash "$AGENT_DEMO/scripts/restart.sh"

echo ""
echo "==> Confirming task state survived the restart..."
curl -s "$API/api/tasks" | python3 -m json.tool 2>/dev/null | head -20 || true
echo "==> Done."

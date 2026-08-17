#!/usr/bin/env bash
# ============================================================
# deploy-agent-demo.sh -- sync the canonical repo (comfyui-migration-agent,
# checked out here) onto the deployed agent-demo copy, then restart it.
#
# Wraps the manual sequence used by hand throughout this project's
# development: snapshot recipes/skills -> copy -> diff-audit -> report changed
# recipe/skill files -> tsc --noEmit -> vitest run -> skill/recipe loading audit -> restart.sh ->
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
# Runtime image: also ensures this host's docker-runtime ComfyUI image (pinned
# in gpu-nodes.json) is loaded from the shared /nfs_share store -- idempotent, a
# no-op when already present. Opt out with --skip-image / DEPLOY_SKIP_IMAGE=1.
#
# Usage:
#   bash scripts/deploy-agent-demo.sh --yes [--agent-demo /path/to/agent-demo] [--api http://127.0.0.1:3001] [--skip-image]
# ============================================================
set -euo pipefail

# Hardening: a tsc/vitest failure aborts BEFORE the restart, so the old backend
# keeps running the OLD code silently -- the exact trap that made a "deployed" fix
# never actually go live. Make any failure impossible to miss and state plainly
# that the running backend is stale.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo ""; echo "############################################################"; echo "## DEPLOY FAILED (exit $rc). The agent-demo backend was NOT"; echo "## restarted -- it is STILL RUNNING THE OLD CODE. Fix the"; echo "## error above (tsc/vitest/restart) and re-run.            "; echo "############################################################"; fi' EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMA_STAGING="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DEMO="/home/intel/tianfeng/comfy/ComfyUI/agent-demo"
# The step SKILLS/PROMPTS the agent runs hardcode tool paths under
# ComfyUI/docs/draft/migration-workflow-v2/tools/ (the agent's original tree, still
# referenced in 15 prompts). The SDK agent EXECUTES the tools from there (copying
# them into per-task nfs_share workspaces), so a tool fix synced ONLY to agent-demo
# never reaches a real run -- the agent keeps running the stale docs/draft copy
# (real incident 2026-08-15: the Step-07 ref_max_size cap never applied, the smoke
# ran full-size, OOM'd, and escalated to --novram). Mirror the migration-workflow-v2
# tree here too. Override with DRAFT_DOCS_ROOT= to skip/redirect.
DRAFT_DOCS_ROOT="${DRAFT_DOCS_ROOT:-/home/intel/tianfeng/comfy/ComfyUI/docs/draft}"
API="http://127.0.0.1:3001"
CONFIRMED=0
# Ensure the docker-runtime ComfyUI image is loaded from the NFS store as part
# of the deploy (idempotent -- a no-op when it's already present). Opt out with
# --skip-image or DEPLOY_SKIP_IMAGE=1 when you only want to push code.
SKIP_IMAGE="${DEPLOY_SKIP_IMAGE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) CONFIRMED=1; shift ;;
    --agent-demo) AGENT_DEMO="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --skip-image) SKIP_IMAGE=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

echo "==> Source (canonical repo): $CMA_STAGING"
echo "==> Target (deployed):       $AGENT_DEMO"

echo ""
echo "==> Checking live task state before syncing..."
ACTIVE_FOUND=0   # a step is waiting_for_human (a gate) -- --yes can override
RUNNING_FOUND=0  # a step is actively RUNNING (live SDK + GPU work) -- NOT overridable
CODE=0
if TASKS_JSON=$(curl -sf "$API/api/tasks" 2>/dev/null); then
  echo "$TASKS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
running = waiting = False
for t in d.get('tasks', []):
    print(f\"  task {t['id']}: {t['status']}\")
    for s in t.get('steps', []):
        if s['status'] == 'running':
            print(f\"    step {s['id']}: running  <-- LIVE GPU RUN\")
            running = True
        elif s['status'] == 'waiting_for_human':
            print(f\"    step {s['id']}: waiting_for_human  <-- GATE\")
            waiting = True
# 2 = a running step (hard block); 1 = only a gate (soft, --yes overrides); 0 = idle
sys.exit(2 if running else (1 if waiting else 0))
" || CODE=$?
  if [ "$CODE" -eq 2 ]; then RUNNING_FOUND=1; fi
  if [ "$CODE" -ge 1 ]; then ACTIVE_FOUND=1; fi
else
  echo "  (backend not reachable at $API -- skipping live check; proceed with caution)"
fi

# A live RUNNING step means an SDK session is driving a real GPU workload right now.
# Restarting orphans it AND leaves a zombie ComfyUI prompt pinning GPU VRAM until it
# OOMs (real incident 2026-08-15: a deploy through a running Step 07 pinned 32.6 GB).
# This is NOT safe to override -- refuse regardless of --yes.
if [ "$RUNNING_FOUND" -eq 1 ]; then
  echo ""
  echo "  BLOCKED: a step is actively RUNNING (live SDK session + GPU work)."
  echo "  Deploying now would orphan it and strand a zombie ComfyUI run holding GPU VRAM."
  echo "  Wait for the step to finish, or hard-stop the task first, then re-deploy."
  echo "  (This is intentionally NOT overridable with --yes.)"
  exit 1
fi

if [ "$ACTIVE_FOUND" -eq 1 ]; then
  echo ""
  echo "  WARNING: a step is waiting_for_human (a gate) right now."
  echo "  Restarting persists the gate but orphans its SDK session; a human answer"
  echo "  after the restart may be discarded. Confirm this is safe before proceeding."
fi

if [ "$CONFIRMED" -ne 1 ]; then
  echo ""
  echo "  Refusing to proceed without --yes (re-run with --yes once you've confirmed"
  echo "  the state above is safe to restart through)."
  exit 1
fi

# Snapshot the recipe + skill files BEFORE syncing so we can report exactly which
# knowledge files this deploy updates (the agent's hard recipes + soft skills).
SKILLS_SUBDIR="prompts/migration-workflow-v2/skills"
snapshot_recipes_skills() {
  { find "$AGENT_DEMO/recipes" -type f -name '*.json' 2>/dev/null
    find "$AGENT_DEMO/$SKILLS_SUBDIR" -type f \( -name '*.md' -o -name '*.json' \) 2>/dev/null
  } | sort | while read -r f; do
    printf '%s  %s\n' "$(md5sum "$f" 2>/dev/null | cut -d' ' -f1)" "${f#"$AGENT_DEMO"/}"
  done
}
RS_BEFORE="$(mktemp)"; snapshot_recipes_skills > "$RS_BEFORE"

echo ""
echo "==> Syncing src/, scripts/, prompts/, recipes/, schemas/, patches/ (additive only, no deletes)..."
for dir in src scripts prompts recipes schemas patches; do
  if [ -d "$CMA_STAGING/$dir" ]; then
    mkdir -p "$AGENT_DEMO/$dir"
    cp -r "$CMA_STAGING/$dir/." "$AGENT_DEMO/$dir/"
  fi
done

echo ""
echo "==> Verifying sync (diff -rq, ignoring Python bytecode caches -- those are expected"
echo "    to diverge locally in agent-demo from real tool runs, not sync artifacts)..."
for dir in src scripts prompts recipes schemas patches; do
  if [ -d "$CMA_STAGING/$dir" ]; then
    if diff -rq -x "__pycache__" -x "*.pyc" "$CMA_STAGING/$dir" "$AGENT_DEMO/$dir"; then
      echo "  OK: $dir"
    else
      echo "  MISMATCH: $dir -- sync did not produce an identical copy, investigate before restarting"
      exit 1
    fi
  fi
done

# Mirror the migration-workflow-v2 tree (tools + prompts + skills) into the
# docs/draft location the step prompts hardcode, so the agent EXECUTES the freshly
# deployed tools -- not a stale copy. Without this, tool fixes silently never run.
if [ -n "$DRAFT_DOCS_ROOT" ] && [ -d "$CMA_STAGING/prompts/migration-workflow-v2" ]; then
  echo ""
  echo "==> Mirroring prompts/migration-workflow-v2/ -> $DRAFT_DOCS_ROOT/migration-workflow-v2/ (the tool path the agent runs)..."
  mkdir -p "$DRAFT_DOCS_ROOT/migration-workflow-v2"
  cp -r "$CMA_STAGING/prompts/migration-workflow-v2/." "$DRAFT_DOCS_ROOT/migration-workflow-v2/"
  if diff -rq -x "__pycache__" -x "*.pyc" "$CMA_STAGING/prompts/migration-workflow-v2" "$DRAFT_DOCS_ROOT/migration-workflow-v2"; then
    echo "  OK: docs/draft tools/prompts/skills match the deployed tree"
  else
    echo "  MISMATCH: docs/draft mirror did not produce an identical copy -- investigate"
    exit 1
  fi
fi

echo ""
echo "==> Recipe + skill files updated by this deploy:"
RS_AFTER="$(mktemp)"; snapshot_recipes_skills > "$RS_AFTER"
CHANGED_RS="$(comm -13 <(sort "$RS_BEFORE") <(sort "$RS_AFTER") | awk '{print $2}')"
if [ -z "$CHANGED_RS" ]; then
  echo "  (no recipe/skill files changed)"
else
  echo "$CHANGED_RS" | sed 's#^#  ~ #'
fi
rm -f "$RS_BEFORE" "$RS_AFTER"

cd "$AGENT_DEMO"

echo ""
if [ "$SKIP_IMAGE" -eq 1 ]; then
  echo "==> Runtime docker image pre-flight SKIPPED (--skip-image/DEPLOY_SKIP_IMAGE=1)."
else
  echo "==> Ensuring runtime docker image is loaded from NFS (idempotent)..."
  # Run the freshly-synced helper against the LIVE agent-demo gpu-nodes.json
  # (gpu-nodes.json is local-only config, not synced by this script).
  GPU_NODES_PATH="$AGENT_DEMO/gpu-nodes.json" bash "$AGENT_DEMO/scripts/ensure-runtime-image.sh"
fi

echo ""
echo "==> npx tsc --noEmit -p ."
npx tsc --noEmit -p .

echo ""
echo "==> npx vitest run"
npx vitest run

echo ""
echo "==> Recipe + skill LOADING audit on the deployed copy (fails the deploy if the"
echo "    agent would not receive a step skill, an on-demand skill, a recipe, or a"
echo "    linked reference doc)..."
# Call the CLI directly (not `npm run audit:skills`): the deploy syncs scripts/ but
# NOT package.json, so agent-demo's package.json may lack the script alias.
npx tsx "$AGENT_DEMO/scripts/audit-skills-recipes.ts"

echo ""
echo "==> Restarting agent-demo..."
bash "$AGENT_DEMO/scripts/restart.sh"

echo ""
echo "==> Verifying the restarted backend is actually up (else the deploy is a no-op)..."
up=""
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "$API/api/tasks" 2>/dev/null; then up="yes"; break; fi
  sleep 2
done
if [ -z "$up" ]; then
  echo "!! Backend did NOT come back up at $API within ~40s after restart."
  echo "!! The deploy did not take effect. Check /tmp/migration-backend.log."
  exit 1
fi
echo "    backend healthy at $API ✓"

echo ""
echo "==> Confirming task state survived the restart..."
curl -s "$API/api/tasks" | python3 -m json.tool 2>/dev/null | head -20 || true
echo "==> Done (deploy verified live)."

#!/usr/bin/env bash
# ============================================================
# deploy-remote-node.sh -- deploy the V2 distributed-runtime agent to a REMOTE
# GPU node over ssh (git-based) and (re)start its backend/frontend in tmux.
#
# Why a new script (vs deploy-agent-demo.sh):
#   deploy-agent-demo.sh is LOCAL, rsync-based, and assumes the shared NFS venv
#   model. The V2 model makes each node SELF-SUFFICIENT via a worker-local venv
#   (--worker-local-venv sets gpu-nodes.json worker_local_venv=true), so multiple
#   nodes no longer contend on the one shared /nfs_share venv (the distributed
#   conflict). This script deploys that model to a remote node that is itself a
#   git checkout of the canonical repo.
#
# What it does (all on the remote, over ssh):
#   1. (optional) stop the legacy backend/frontend tmux sessions
#   2. git fetch + hard-checkout the target branch (gpu-nodes.json is gitignored,
#      so per-host config survives)
#   3. npm install (idempotent) + tsc --noEmit gate (never restart on a type error)
#   4. set worker_local_venv on the node config (V2 self-sufficiency)
#   5. restart backend + frontend in tmux, then health-check the backend
#
# Usage:
#   deploy-remote-node.sh --host 172.16.120.111 --user intel [--key ~/.ssh/id_ed25519]
#     [--dir /home/intel/comfyui_agent] [--branch v2-distributed-runtime]
#     [--backend-session agent-backend] [--frontend-session agent-frontend]
#     [--backend-port 3001] [--frontend-port 5173]
#     [--worker-local-venv] [--stop-legacy] [--no-restart] [--no-typecheck]
# ============================================================
set -euo pipefail

HOST=""; USER_NAME="intel"; KEY="$HOME/.ssh/id_ed25519"
DIR="/home/intel/comfyui_agent"; BRANCH="v2-distributed-runtime"
BE_SESSION="agent-backend"; FE_SESSION="agent-frontend"
BE_PORT="3001"; FE_PORT="5173"
WORKER_LOCAL_VENV=0; STOP_LEGACY=0; RESTART=1; TYPECHECK=1
SETUP_LOCAL_VENV=0
LOCAL_VENV_DIR="/home/intel/comfyui-runtime-venv"
SHARED_VENV_PY="/nfs_share/venv-container-xpu/bin/python3"

while [ $# -gt 0 ]; do case "$1" in
  --host) HOST="$2"; shift 2;;
  --user) USER_NAME="$2"; shift 2;;
  --key) KEY="$2"; shift 2;;
  --dir) DIR="$2"; shift 2;;
  --branch) BRANCH="$2"; shift 2;;
  --backend-session) BE_SESSION="$2"; shift 2;;
  --frontend-session) FE_SESSION="$2"; shift 2;;
  --backend-port) BE_PORT="$2"; shift 2;;
  --frontend-port) FE_PORT="$2"; shift 2;;
  --worker-local-venv) WORKER_LOCAL_VENV=1; shift;;               # flip the flag only
  --setup-local-venv) SETUP_LOCAL_VENV=1; shift;;                 # CREATE the node-local venv + repoint config
  --local-venv-dir) LOCAL_VENV_DIR="$2"; shift 2;;
  --shared-venv-python) SHARED_VENV_PY="$2"; shift 2;;
  --stop-legacy) STOP_LEGACY=1; shift;;
  --no-restart) RESTART=0; shift;;
  --no-typecheck) TYPECHECK=0; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done

[ -n "$HOST" ] || { echo "ERROR: --host is required" >&2; exit 2; }
SSH=(ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no -i "$KEY" "$USER_NAME@$HOST")

echo "==> V2 remote deploy → $USER_NAME@$HOST:$DIR (branch $BRANCH)"
"${SSH[@]}" "hostname && echo reachable" >/dev/null || { echo "ERROR: cannot ssh to $HOST" >&2; exit 3; }

# Node-local venv creation is a standalone helper (base64'd, run inside the image on
# the remote) so there's no fragile heredoc/-c nesting. It takes: $1=venv dir,
# $2=shared venv root (for the read-only .pth base). Computed locally, decoded remotely.
SHARED_ROOT_VAL="$(dirname "$(dirname "$SHARED_VENV_PY")")"
MK_VENV_SCRIPT='#!/usr/bin/env bash
set -e
VENVDIR="$1"; SHARED_ROOT="$2"
python3 -m venv --system-site-packages --without-pip "$VENVDIR"
SHARED_SITE=$(ls -d "$SHARED_ROOT"/lib/python*/site-packages 2>/dev/null | head -1)
LOCAL_SITE=$(ls -d "$VENVDIR"/lib/python*/site-packages 2>/dev/null | head -1)
[ -n "$SHARED_SITE" ] && echo "$SHARED_SITE" > "$LOCAL_SITE/zzz-shared-base.pth"
"$VENVDIR"/bin/python -c "import torch, omni_xpu_kernel; assert torch.xpu.is_available()"
echo "   node-local venv XPU-stack OK"'
MK_VENV_B64=$(printf '%s' "$MK_VENV_SCRIPT" | base64 -w0 2>/dev/null || printf '%s' "$MK_VENV_SCRIPT" | base64)

# The whole remote sequence is built here and run in one shell so a failure at
# any gate aborts BEFORE the restart (mirrors deploy-agent-demo.sh's guarantee
# that a broken build never silently replaces a healthy backend).
REMOTE_SCRIPT=$(cat <<REMOTE
set -euo pipefail
export PATH="/home/intel/.local/share/fnm/aliases/default/bin:\$PATH"
cd "$DIR"

if [ "$STOP_LEGACY" = "1" ]; then
  echo "-- stopping legacy services ($BE_SESSION, $FE_SESSION) --"
  tmux kill-session -t "$BE_SESSION" 2>/dev/null || true
  tmux kill-session -t "$FE_SESSION" 2>/dev/null || true
  # free the ports if anything lingers
  fuser -k ${BE_PORT}/tcp 2>/dev/null || true
  fuser -k ${FE_PORT}/tcp 2>/dev/null || true
  sleep 2
fi

echo "-- git fetch + checkout $BRANCH --"
git fetch origin "$BRANCH"
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
echo "   now at: \$(git log --oneline -1)"

echo "-- npm install (idempotent) --"
npm install --no-audit --no-fund --silent

if [ "$SETUP_LOCAL_VENV" = "1" ]; then
  echo "-- setting up node-local runtime venv at $LOCAL_VENV_DIR (shared base: $SHARED_ROOT_VAL) --"
  IMG=\$(node -e 'const c=JSON.parse(require("fs").readFileSync("gpu-nodes.json"));console.log((c.nodes.find(n=>n.runtime==="docker")||{}).docker_image||"")')
  [ -n "\$IMG" ] || { echo "ERROR: no docker node / docker_image in gpu-nodes.json"; exit 6; }
  mkdir -p "$LOCAL_VENV_DIR"
  # Create the venv INSIDE the image (ABI-compatible with its torch-xpu), on local
  # disk, --without-pip (image python has no ensurepip; --system-site-packages still
  # exposes the image pip which installs into this venv by sys.prefix). Layer the
  # shared venv's site-packages as a READ-ONLY base via a .pth so ComfyUI's runtime
  # deps (comfy_aimdo etc.) resolve without ever writing to the shared venv. Assert
  # the XPU stack so a broken venv fails LOUDLY at deploy, not mid-migration.
  HELPER=/nfs_share/.mk-venv-deploy.sh
  echo "$MK_VENV_B64" | base64 -d > "\$HELPER"
  docker run --rm --device /dev/dri -v "$LOCAL_VENV_DIR:$LOCAL_VENV_DIR" -v /nfs_share:/nfs_share \\
    -e ZE_AFFINITY_MASK=0 \\
    --entrypoint bash "\$IMG" "\$HELPER" "$LOCAL_VENV_DIR" "$SHARED_ROOT_VAL"
  rm -f "\$HELPER"
  echo "-- repointing gpu-nodes.json: venv_python -> node-local venv, model_roots += venv dir --"
  node -e '
    const fs=require("fs"); const p="gpu-nodes.json"; const c=JSON.parse(fs.readFileSync(p,"utf8"));
    const dir=process.argv[1]; const py=dir+"/bin/python3"; let n=0;
    for(const nd of (c.nodes||[])){ if((nd.runtime||"")==="docker"){
      nd.venv_python=py; nd.worker_local_venv=true;
      nd.model_roots=nd.model_roots||[]; if(!nd.model_roots.includes(dir)) nd.model_roots.push(dir);
      n++;
    }}
    fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    console.log("   repointed "+n+" docker node(s) → "+py);
  ' "$LOCAL_VENV_DIR"
elif [ "$WORKER_LOCAL_VENV" = "1" ]; then
  echo "-- enabling worker_local_venv flag only (no venv setup) on docker nodes --"
  node -e '
    const fs=require("fs"); const p="gpu-nodes.json"; const c=JSON.parse(fs.readFileSync(p,"utf8"));
    let n=0; for(const nd of (c.nodes||[])){ if((nd.runtime||"")==="docker"){ nd.worker_local_venv=true; n++; } }
    fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    console.log("   worker_local_venv=true on "+n+" docker node(s)");
  '
fi

if [ "$TYPECHECK" = "1" ]; then
  echo "-- tsc --noEmit gate --"
  npx tsc -p tsconfig.json --noEmit
  echo "   typecheck OK"
fi

if [ "$RESTART" = "1" ]; then
  echo "-- (re)starting services in tmux --"
  tmux kill-session -t "$BE_SESSION" 2>/dev/null || true
  tmux kill-session -t "$FE_SESSION" 2>/dev/null || true
  sleep 1
  [ -x ./run-backend.sh ] || { echo "ERROR: ./run-backend.sh missing on remote"; exit 4; }
  tmux new-session -d -s "$BE_SESSION" "cd $DIR && ./run-backend.sh 2>&1 | tee /tmp/agent-backend.log"
  if [ -x ./run-frontend.sh ]; then
    tmux new-session -d -s "$FE_SESSION" "cd $DIR && ./run-frontend.sh 2>&1 | tee /tmp/agent-frontend.log"
  else
    tmux new-session -d -s "$FE_SESSION" "cd $DIR && npx vite --host 0.0.0.0 --port $FE_PORT 2>&1 | tee /tmp/agent-frontend.log"
  fi

  echo "-- waiting for backend health on :$BE_PORT --"
  ok=0
  for i in \$(seq 1 30); do
    if curl -sf --max-time 3 "http://127.0.0.1:$BE_PORT/api/tasks" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "\$ok" = "1" ]; then echo "   backend healthy at http://$HOST:$BE_PORT"; else
    echo "ERROR: backend did not become healthy on :$BE_PORT — check /tmp/agent-backend.log"; tail -30 /tmp/agent-backend.log 2>/dev/null || true; exit 5;
  fi
fi
echo "== remote deploy done =="
REMOTE
)

B64=$(printf '%s' "$REMOTE_SCRIPT" | base64 -w0 2>/dev/null || printf '%s' "$REMOTE_SCRIPT" | base64)
"${SSH[@]}" "echo $B64 | base64 -d | bash"
echo "==> Done: $USER_NAME@$HOST ($BRANCH)"

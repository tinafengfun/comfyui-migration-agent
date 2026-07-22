# GPU node setup

How to register a new GPU node (local or remote) so the migration agent can run ComfyUI workflows against it. The agent picks one node per task at creation time; the choice is stored in `task-state.json` and read by Steps 05/07/08.

There are **two ways** to register a node:

1. **Recommended — CLI bootstrap script**: `scripts/bootstrap-gpu-node.mts` does everything end-to-end (SSH key, remote ComfyUI install, NFS export+mount) and writes the entry to `gpu-nodes.json`.
2. **Manual — web UI or file edit**: open the GPU Nodes Manager in the web UI (or hand-edit `gpu-nodes.json`) and fill in the fields yourself. Use this when the remote is already provisioned and you just need to point the agent at it.

---

## Option A: CLI bootstrap (recommended for fresh remotes)

```bash
npx tsx scripts/bootstrap-gpu-node.mts \
  --name remote-a770-48gb \
  --host 172.16.114.200 \
  --user intel \
  --comfyui-root /home/intel/ComfyUI \
  --vram-gb 48 \
  --allow-sudo
```

That single command will:

1. Verify SSH works to the remote (or prompt for a password once).
2. Generate `~/.ssh/id_ed25519` locally if missing and install it on the remote via `ssh-copy-id`.
3. `git clone ComfyUI` into `--comfyui-root` (if not present), create `.venv-xpu`, install `torch+xpu`, install ComfyUI `requirements.txt`.
4. Configure NFS so the remote sees `/home/intel/hf_models` at the same path (with `--allow-sudo`; otherwise prints the commands for you to run).
5. Append the node to `gpu-nodes.json`.

Useful flags:
- `--dry-run` — print every command, run nothing.
- `--no-setup-nfs` — skip NFS (e.g. if the model dir is already mounted another way).
- `--no-install-comfyui` — skip ComfyUI install (register only).
- `--no-setup-ssh-key` — skip SSH key setup.
- `--no-register` — do all provisioning but don't write `gpu-nodes.json`.
- `--force` — overwrite an existing node with the same name without prompting.
- `--local-ip 172.16.114.105` — override auto-detected local IP for NFS export.
- `--key-path /path/to/key` — use an existing SSH key instead of the default `~/.ssh/id_ed25519`.

The script is idempotent — re-running it skips steps that are already done.

---

## Option B: Web UI

1. Open the web UI. Next to the GPU node dropdown in the header, click **Manage**.
2. Click **+ Add new node**.
3. Fill in the form. Required fields: `name`, `kind`, `comfyui_root`, `venv_python`, `model_roots`. For `kind=ssh`, also `ssh.host` and `ssh.user`.
4. Click **Test (without saving)** to verify SSH/HTTP connectivity before committing.
5. Click **Save**. The node is appended atomically to `gpu-nodes.json`.

You can also **Edit** or **Delete** nodes from the same panel, and **Test** any node to refresh its status.

The GUI never runs long-running provisioning. If you need ComfyUI installed on the remote, NFS configured, or SSH keys generated, use Option A.

---

## Option C: Hand-edit `gpu-nodes.json`

At the project root. Loaded once per process; the app falls back to a synthesized single-node default if the file is missing.

```json
{
  "default_node": "local-xpu",
  "nodes": [
    {
      "name": "local-xpu",
      "kind": "local",
      "vram_gb": 22.7,
      "comfyui_root": "/home/intel/tianfeng/comfy/ComfyUI",
      "venv_python": "/home/intel/tianfeng/comfy/ComfyUI/.venv/bin/python3",
      "model_roots": ["/home/intel/hf_models"],
      "api_host": "127.0.0.1",
      "api_port": 8188,
      "launch_flags": ["--reserve-vram", "1"]
    },
    {
      "name": "remote-a770-48gb",
      "kind": "ssh",
      "vram_gb": 48,
      "ssh": {
        "host": "172.16.114.200",
        "user": "intel",
        "port": 22,
        "key_path": "/home/intel/.ssh/id_ed25519",
        "remote_workspace_root": "/home/intel/migration-workspaces"
      },
      "comfyui_root": "/home/intel/ComfyUI",
      "venv_python": "/home/intel/ComfyUI/.venv-xpu/bin/python3",
      "model_roots": ["/home/intel/hf_models"],
      "api_host": "172.16.114.200",
      "api_port": 8188,
      "launch_flags": ["--reserve-vram", "1"],
      "model_share": "nfs_same_path"
    }
  ]
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique identifier shown in the UI dropdown. |
| `kind` | yes | `local` (shell-launch + `pgrep` cleanup) or `ssh` (SSH-launch + remote `pkill`). |
| `vram_gb` | optional | Display only. Used by humans to pick the right node. |
| `comfyui_root` | yes | Path to ComfyUI checkout **as seen on the node**. For ssh nodes this is the remote path. |
| `venv_python` | yes | Absolute path to the venv's `python3` **on the node**. |
| `model_roots` | yes | Model search paths **on the node**. For NFS-same-path setups, identical on both sides. |
| `api_host` / `api_port` | yes | Where ComfyUI is reachable from the migration agent over HTTP. For ssh nodes this is the remote host's IP. |
| `launch_flags` | optional | Extra flags appended to `main.py` (e.g. `["--reserve-vram", "1"]`). |
| `ssh.host` / `ssh.user` | ssh only | SSH target. |
| `ssh.port` | optional | Default 22. |
| `ssh.key_path` | optional | Private key path. If absent, SSH uses agent/default keys. **Never returned by `/api/gpu-nodes`** — only `key_configured: true/false`. |
| `ssh.remote_workspace_root` | optional | Scratch dir on remote for logs. v1 does not sync the local workspace there. |
| `model_share` | optional | `nfs_same_path` means model_roots are valid on both local and remote (NFS mount at the same path). `none` or absent means no verification. |
| `runtime` | optional | `"bare"` (default) or `"docker"`. See [Docker runtime](#docker-runtime-intel-xpu-bundle) below. |
| `docker_image` | required if `runtime="docker"` | Image ComfyUI runs inside (e.g. `intel/llm-scaler-vllm:1.4`). Used only for its oneAPI/PyTorch-XPU stack — never that image's own ComfyUI/vLLM components. |

---

## Shared `custom_nodes/` convention (NFS)

Both `local-xpu` and `remote-124-12` mount the same NFS export. **`remote-124-12` is now the NFS server** for `/nfs_share` (see its `/etc/exports`); `local-xpu` mounts `172.16.124.12:/nfs_share` at the identical local path `/nfs_share`. (This is a role swap from an earlier layout where `local-xpu` served `/home/intel/hf_models` with a `zimage_workflow/` subtree for shared custom nodes/venv — that whole tree was migrated wholesale to this new, flattened, dedicated share via `scripts/migrate-nfs-share.sh`; the old data is left in place, unreferenced, as a rollback safety net.) `/nfs_share/custom_nodes/` holds the canonical source for custom-node packages that both nodes need identically — each node's own `<comfyui_root>/custom_nodes/<name>` is a **symlink** into that shared tree, not an independent clone. This was previously an undocumented, ad-hoc convention discovered by inspecting the actual filesystem state — it is now the standard way to add any custom node needed on more than one GPU node.

To add a new shared package:

```bash
cd /nfs_share/custom_nodes
git clone --depth 1 <repo_url> <name>
cd <name> && git fetch --depth 1 origin <pinned_sha> && git checkout <pinned_sha>
# apply any XPU patch here, then:
git config user.name "tinafengfun"; git config user.email "tinafengfun@users.noreply.github.com"
git apply /path/to/some.patch && git add -A && git commit -m "xpu: ..."
```

Then symlink it in from every node that needs it (never a real directory — that creates silent drift, see below):

```bash
ln -s /nfs_share/custom_nodes/<name> <comfyui_root>/custom_nodes/<name>
# on remote-124-12, same command over SSH
```

**Drift hazard, confirmed live:** at one point `ComfyUI-KJNodes`/`ComfyUI_LayerStyle`/`ComfyUI-Custom-Scripts`/`rgthree-comfy` existed as independent real directories on `local-xpu` *in addition to* identical-commit copies already on the shared tree (used via symlink from `remote-124-12`). One of them (`ComfyUI-KJNodes`) had a real, valuable, **uncommitted local fix** that would have been silently lost had the directory just been deleted — always `git status --porcelain` a real directory before replacing it with a symlink, and if dirty, commit + propagate the diff to the shared copy first (see `patches/kjnodes-xpu-fp16-guard.patch` for a worked example).

**Not every package should be re-pinned to Intel's exact commit.** For a package Intel ships *unpatched* (e.g. `ComfyUI-KJNodes` — Intel's own Dockerfile just clones it plain, no XPU fix), keep whatever newer commit is already installed and working rather than downgrading to match Intel's older pin for no XPU benefit — document the divergence instead of blindly syncing versions. Only match Intel's exact pin when there's an accompanying patch that's commit-specific.

The per-node Python venv still needs the package's own `pip install -r requirements.txt` even after the *source* is shared — see [Docker runtime](#docker-runtime-intel-xpu-bundle)'s shared venv, which covers this for `runtime=docker` nodes.

**Model-root path changes also require updating each node's `extra_model_paths.yaml`, independent of `gpu-nodes.json`.** ComfyUI auto-loads `<comfyui_root>/extra_model_paths.yaml` on every startup regardless of the `--extra-model-paths-yaml` CLI flag Step 05 passes — it's a static file per node, not derived from `gpu-nodes.json`'s `model_roots`. Confirmed live during the NFS share migration: updating `model_roots` to `/nfs_share` in `gpu-nodes.json` was not sufficient — both `local-xpu` and `remote-124-12` had their own `extra_model_paths.yaml` still hardcoding `base_path: /home/intel/hf_models` (remote's had 5 separate `base_path` entries, including one referencing a since-flattened `zimage_workflow/models/...` subpath). Not fatal on its own (ComfyUI silently skips a missing search path), but it means stale and current paths get merged rather than cleanly cut over — check and update this file by hand on every node whenever `model_roots` changes.

## Docker runtime (Intel XPU bundle)

For nodes with `runtime: "docker"`, ComfyUI does **not** run as a bare `venv_python main.py` subprocess. Instead, Step 05 launches an ephemeral, per-task container derived from `docker_image` (currently `intel/llm-scaler-vllm:1.4` on both `local-xpu` and `remote-124-12`), copies that task's `comfyui_root` in fresh via `docker cp` (not bind-mounted — see the Step 05 skill for the exact `tar --exclude=./...` + staging-directory recipe and the sharp edges it documents), and bind-mounts `model_roots` (large, shared, read-mostly) at identical paths.

**Why this image, and what it actually provides:** `intel/llm-scaler-vllm:1.4` is Intel's own validated build carrying the exact oneAPI 2025.3/PyTorch 2.10.0+xpu stack the `llm-scaler-omni` bundle expects — the goal is to avoid re-deriving that stack (and especially avoid compiling `omni_xpu_kernel`/`sgl-kernel-xpu` from source ourselves) on bare metal. Only the underlying dependency stack is used; the image's own ComfyUI/vLLM components are never invoked.

**The shared, persisted venv:** `venv_python` for `runtime=docker` nodes points at `/nfs_share/venv-container-xpu/bin/python3` — a `--system-site-packages` venv living on the same NFS share as the custom-node tree above, built once and usable from both nodes (confirmed live: same venv works correctly on both `local-xpu`'s Arc Pro B60 and `remote-124-12`'s `0xe223`, both Battlemage family). It inherits the image's own torch-xpu/oneAPI packages for free and has ComfyUI core's `requirements.txt` plus every custom node's `requirements.txt` layered on top. To add/update packages in it:

```bash
docker run --rm --entrypoint bash \
  -e https_proxy=http://proxy.ims.intel.com:911 -e http_proxy=http://proxy.ims.intel.com:911 -e no_proxy=localhost,127.0.0.1 \
  -v /nfs_share:/nfs_share \
  intel/llm-scaler-vllm:1.4 -c '
    pip --python /nfs_share/venv-container-xpu/bin/python3 install --no-cache-dir -r <package>/requirements.txt
  '
```

**Never run two `pip install`s against this venv concurrently** — pip has no cross-invocation lock, and concurrent installs into the same site-packages directory can corrupt it (confirmed as a real risk during setup; the fix is simply to serialize).

**Known gap — the `xDiT`/`xfuser` stack is not built.** Intel's own Dockerfile compiles `sgl-kernel-xpu` and a patched `xDiT`/`long-context-attention` (`xfuser`) from source for multi-GPU distributed diffusion, used by `ComfyUI_SGLDiffusion` and `raylight`. This was deliberately skipped here — it's a much heavier from-source kernel build than any other package in the bundle, in the same risk class as `omni_xpu_kernel` (which is also not compiled here; `ComfyUI-OmniXPU` runs on its safe PyTorch fallback). The plain PyPI `xfuser` got installed instead as an ordinary dependency of `raylight`'s `requirements.txt`, but it hard-fails at import time (`No Accelerators(AMD/NV/MTT GPU...) available` — its own accelerator probe doesn't recognize Intel XPU at all, confirmed live). `intel/llm-scaler-vllm:1.4` does **not** already contain a working `sgl-kernel-xpu`/`xfuser` either (checked directly — absent). If a real migration workflow ever needs `raylight`'s multi-Arc distributed nodes or `ComfyUI_SGLDiffusion`, that from-source build (Intel's own `omni/docker/Dockerfile`, the `xdit_for_multi_arc.patch`/`yunchang_for_multi_arc.patch`/`sglang_diffusion_for_multi_arc.patch` sections) needs to be revisited as its own task — don't assume `raylight` works just because it's installed.

**Native C++/CUDA extension builds are not attempted.** `ComfyUI-Hunyuan3d-2-1.disabled`'s Python (`pip`) requirements are installed, but its `custom_rasterizer`/`DifferentiableRenderer` `setup.py install` native extension builds (per Intel's Dockerfile) were not — same rationale as above, deferred as a gap rather than risked mid-batch.

---

## Manual remote prep (only if you can't use the bootstrap script)

### 1. Install ComfyUI + XPU venv on the remote

```bash
# On the remote:
git clone https://github.com/comfyanonymous/ComfyUI.git /home/intel/ComfyUI
cd /home/intel/ComfyUI
python3 -m venv .venv-xpu
.venv-xpu/bin/pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu
.venv-xpu/bin/pip install -r requirements.txt
.venv-xpu/bin/python -c "import torch; print(torch.xpu.is_available())"   # must print True
```

### 2. Share models via NFS (recommended) or pre-stage them

**NFS-same-path (recommended):** export the model directory from the host that has the models and mount it on the remote at the **same absolute path**. This way `model_roots` is identical on both sides and the agent doesn't need any path mapping.

On the model server (e.g. the host with `/home/intel/hf_models`):

```bash
# /etc/exports:
/home/intel/hf_models  172.16.114.0/24(ro,sync,no_subtree_check,no_root_squash)
sudo exportfs -ra
sudo systemctl enable --now nfs-server
```

On the remote GPU node:

```bash
sudo mkdir -p /home/intel/hf_models
sudo mount -t nfs 172.16.114.105:/home/intel/hf_models /home/intel/hf_models
# Verify
ls /home/intel/hf_models   # should show checkpoints/, clip/, ...
```

Add to `/etc/fstab` on the remote to auto-mount on reboot:

```
172.16.114.105:/home/intel/hf_models  /home/intel/hf_models  nfs  ro,hard,nosuid  0 0
```

**Alternative (no NFS):** rsync the specific models you need to the remote and set `model_roots` to the remote path. Slower, manual, but works if NFS is blocked.

### 3. Set up SSH key auth

The migration agent runs as your local user and SSHes to the remote non-interactively (`BatchMode=yes`). Set up a passphrase-less key:

```bash
# On the host running the migration agent:
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""   # skip if you already have one
ssh-copy-id -i ~/.ssh/id_ed25519.pub intel@172.16.114.200

# Verify:
ssh -i ~/.ssh/id_ed25519 intel@172.16.114.200 'echo OK'
```

Put the key path in `ssh.key_path`. The agent never reads the key contents into memory or exposes it via the API — it just passes the path to `ssh -i`.

### 4. Pre-install custom nodes on the remote

Custom nodes from the workflow's `01-custom-nodes.md` must exist at the same relative path under `<remote_comfyui_root>/custom_nodes/`. The migration agent does **not** sync them in v1. Clone each one at the recorded commit:

```bash
# On the remote:
cd /home/intel/ComfyUI/custom_nodes
git clone <repo_url> <node_dir>
cd <node_dir> && git checkout --detach <commit>
# Install the node's portable deps into the remote venv:
/home/intel/ComfyUI/.venv-xpu/bin/pip install -r requirements.txt
```

### 5. Register the node

Use Option A (`scripts/bootstrap-gpu-node.mts --no-setup-ssh-key --no-install-comfyui --no-setup-nfs --force` to register only) or Option B (web UI) or Option C (edit `gpu-nodes.json`).

---

## Verify end-to-end

1. `GET /api/gpu-nodes` lists your new node.
2. (Web UI) Manage → Test on the new node. Local → curl `/system_stats`. SSH → `echo OK; uname -n; test -f main.py`.
3. Upload a workflow, pick the remote node in the UI dropdown, run the pipeline.
4. Step 05 should SSH-launch ComfyUI on the remote with `--listen 0.0.0.0`, and `task-state.json` should record the remote `api_url`.
5. Steps 07/08 connect to that URL.
6. Hard-stop or rerun triggers SSH `pkill -f 'main.py.*--port 8188'` on the remote.

If something fails, check `/tmp/comfyui-<task_id>.log` on the remote.


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


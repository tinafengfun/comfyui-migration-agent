# GPU node setup

How to register a new GPU node (local or remote) so the migration agent can run ComfyUI workflows against it. The agent picks one node per task at creation time; the choice is stored in `task-state.json` and read by Steps 05/07/08.

There are **two ways** to register a node:

1. **Recommended — CLI bootstrap script**: `scripts/bootstrap-gpu-node.mts` does everything end-to-end (SSH key, remote ComfyUI install, NFS export+mount) and writes the entry to `gpu-nodes.json`. For `--runtime docker` nodes this also loads the pinned Docker image from the shared NFS store and symlinks `custom_nodes/` from it — see [Docker-runtime onboarding](#docker-runtime-onboarding-fully-integrated) below.
2. **Web UI**: open the GPU Nodes Manager to add/edit/delete/test a node, including `runtime`/`docker_image`/`nfs_share_root` for docker-runtime nodes, and a one-click "Sync Docker Image from NFS" refresh. Use this when the remote is already provisioned and you just need to point the agent at it (or tweak an existing node).
3. **Manual — hand-edit `gpu-nodes.json`**: for anything the UI/CLI don't cover.

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

### Docker-runtime onboarding (fully integrated)

```bash
npx tsx scripts/bootstrap-gpu-node.mts \
  --name remote-2 --host 172.16.124.20 --user intel \
  --comfyui-root /home/intel/ComfyUI \
  --runtime docker --docker-image intel/llm-scaler-omni:0.1.0-b7 \
  --venv-python /nfs_share/venv-container-xpu/bin/python3 \
  --model-roots /nfs_share \
  --allow-sudo
```

With `--runtime docker`, the same command additionally:

1. Skips the venv/torch install (the shared NFS venv at `venv_python` already has them).
2. Mounts `--nfs-share-root` (default `/nfs_share`) as a whole — not just `model_roots[0]` — since docker-runtime nodes depend on the entire shared tree (`custom_nodes/`, `docker-images/`, `venv-container-xpu/`).
3. Loads and digest-verifies `--docker-image` from the shared NFS store (`scripts/load-docker-image-from-nfs.sh`, transported+run over SSH) — no Docker Hub pull needed.
4. Bulk-symlinks every package under `/nfs_share/custom_nodes/` into `custom_nodes/` (`scripts/sync-custom-nodes-from-nfs.sh`) — warns and skips (never overwrites) if a real, non-symlink directory already exists there.
5. Registers the node with `runtime`, `docker_image`, and `nfs_share_root` set.

Additional flags for this path:
- `--runtime bare|docker` — default `bare` (today's behavior, unaffected).
- `--docker-image <image:tag>` — required when `--runtime docker`.
- `--nfs-share-root <path>` — default `/nfs_share`.

Re-running the command later (e.g. after a new image version is published to NFS) re-syncs both the image and any newly-added shared `custom_nodes/` packages — same idempotent, skip-what's-done design as the rest of the script. The Web UI's "Sync Docker Image from NFS" button (`POST /api/gpu-nodes/:name/sync-docker-image`) does the same image refresh without re-running the whole bootstrap.

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
| `docker_image` | required if `runtime="docker"` | Image ComfyUI runs inside (currently `intel/llm-scaler-omni:0.1.0-b7`). Used only for its compiled oneAPI/PyTorch-XPU/`omni_xpu_kernel`/`sgl-kernel-xpu` packages — never that image's own ComfyUI/custom_nodes/entrypoint. |
| `nfs_share_root` | optional | Root of the shared multi-person NFS tree (`custom_nodes/`, `docker-images/`, `venv-container-xpu/`, `workflows/`). Defaults to `/nfs_share` when `runtime="docker"` and unset. Used by "Test"'s NFS-health check and by the Docker-image/custom_nodes sync helpers. |

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

For nodes with `runtime: "docker"`, onboarding is fully integrated end-to-end (mount the shared NFS tree → load+verify the image → symlink `custom_nodes/` → register) via `scripts/bootstrap-gpu-node.mts --runtime docker` or the Web UI form — see [Docker-runtime onboarding](#docker-runtime-onboarding-fully-integrated). The rest of this section covers what happens at *task run time* once a node is registered.

For nodes with `runtime: "docker"`, ComfyUI does **not** run as a bare `venv_python main.py` subprocess. Instead, Step 05 launches an ephemeral, per-task container derived from `docker_image` (currently `intel/llm-scaler-omni:0.1.0-b7` on both `local-xpu` and `remote-124-12`), copies that task's `comfyui_root` in fresh via `docker cp` (not bind-mounted — see the Step 05 skill for the exact `tar --exclude=./...` + staging-directory recipe and the sharp edges it documents), and bind-mounts `model_roots` (large, shared, read-mostly) at identical paths.

**Why this image, and what it actually provides.** Originally used `intel/llm-scaler-vllm:1.4` (a vLLM-serving image) purely for its oneAPI/PyTorch-XPU system stack, since it had no ComfyUI-specific compiled kernels — `omni_xpu_kernel` ran on its slow PyTorch fallback, and `raylight`/`ComfyUI_SGLDiffusion` needed hand-derived Python-only patches because building `sgl-kernel-xpu` from source was explicitly out of scope. Switched to `intel/llm-scaler-omni:0.1.0-b7` (Intel's actual omni runtime image, 55.5GB) because it already contains the real, genuinely-compiled `omni_xpu_kernel` and `sgl-kernel-xpu` (confirmed live: both import cleanly from an arbitrary working directory, proving they're ordinary `dist-packages` entries, not tied to the image's own `/llm/ComfyUI` tree in any way) plus a working `xDiT`/`long-context-attention`. **We still never use this image's own ComfyUI, custom_nodes, or entrypoint** — `/llm/ComfyUI` (a real checkout, `v0.20.1`/`64b8457`, with 14 baked-in nodes) is left completely untouched; only the compiled Python packages are borrowed. The image's default `ENTRYPOINT` is `/lib/systemd/systemd` (it's built to run as a full-OS-like container) — a plain `--entrypoint <venv_python>` override bypasses that entirely (confirmed live, GPU access + `torch.xpu`/`omni_xpu_kernel`/`sgl_kernel` all work identically to the override pattern used for the previous image).

**The shared, persisted venv:** `venv_python` for `runtime=docker` nodes points at `/nfs_share/venv-container-xpu/bin/python3` — a `--system-site-packages` venv living on the same NFS share as the custom-node tree above, rebuilt against this image (confirmed live: correctly inherits `torch`, `omni_xpu_kernel`, and `sgl_kernel` from the new image's system `dist-packages`) and usable from both nodes (same venv works correctly on both `local-xpu`'s Arc Pro B60 and `remote-124-12`'s `0xe223`, both Battlemage family). **Rebuild it from scratch whenever `docker_image` changes** — a `--system-site-packages` venv resolves its "system" packages from whichever image's Python installation is present when it was created; switching base images silently stops it from seeing the new image's compiled packages unless recreated. It has ComfyUI core's `requirements.txt` plus every custom node's `requirements.txt` layered on top. To add/update packages in it:

```bash
docker run --rm --entrypoint bash \
  -e https_proxy=http://proxy.ims.intel.com:911 -e http_proxy=http://proxy.ims.intel.com:911 -e no_proxy=localhost,127.0.0.1 \
  -v /nfs_share:/nfs_share \
  intel/llm-scaler-omni:0.1.0-b7 -c '
    bash /nfs_share/bin/with-shared-venv-lock.sh /nfs_share/venv-container-xpu/bin/python3 install --no-cache-dir -r <package>/requirements.txt
  '
```

**Never run `pip install` against this venv directly — always go through `scripts/with-shared-venv-lock.sh`.** This venv has no cross-invocation lock of its own, and two concurrent installs into it can corrupt site-packages. This isn't a rare manual-double-edit risk: Step 05's dependency installs, `node-precheck.mts --prepare`, and this manual example all install into the same venv whenever a package isn't cached yet — two people testing different new workflows around the same time is a routine collision, not an edge case. `scripts/with-shared-venv-lock.sh` serializes these via an atomic `mkdir`-based lock at `/nfs_share/venv-container-xpu.lock`, deployed once to `/nfs_share/bin/with-shared-venv-lock.sh` (reachable from any node without per-node transport, since `/nfs_share` is already mounted everywhere). **Not `flock`/`fcntl`** — confirmed live that advisory locks do not provide real cross-host exclusion here: `remote-124-12` is both the NFS server and accesses `/nfs_share` as a local path (not via its own NFS client mount), so its local `flock()` calls never route through the same lock coordination as `local-xpu`'s NFS-client `flock()` calls — verified symmetrically broken in both directions, then verified `mkdir` (a core filesystem namespace operation, not the optional locking sideband) works correctly in both directions instead. A stale lock (crashed holder) is auto-broken after 15 minutes; a genuinely-contended lock gives up after 20 minutes with a clear "held by X since Y" error rather than hanging forever.

One known gap: ComfyUI's own auto-`pip install` for missing custom-node deps at import time (see the proxy-env note above) isn't covered by this lock — it fires inside the container's own Python process, not through any of our scripts, and would need a `sitecustomize.py`/pip-internals hook to intercept (rejected as too fragile for a residual risk that's already low-probability and self-healing — a given package only triggers this once, until it's cached).

**`xDiT`/`yunchang`/`nunchaku-torch` are still our own separate editable installs, not the image's baked-in copies.** `raylight` needed two pure-Python XPU patches (`xdit_for_multi_arc.patch`/`yunchang_for_multi_arc.patch` — confirmed no native compile involved) applied to our own `git clone` of `long-context-attention`/`xDiT` under `lib/`, installed editable into the shared venv, independent of the image's own `/llm/xDiT`/`/llm/sgl-kernel-xpu`. This was necessary before switching images (the old `llm-scaler-vllm:1.4` had no working `sgl-kernel-xpu`/`xfuser` at all) and is kept as-is after the switch to avoid conflating two changes — a future optimization could drop our own editable installs and point `PYTHONPATH` at the image's own (Intel-patched, real-`sgl-kernel-xpu`-backed) `/llm/xDiT` instead, but that's unverified and out of scope here.

**`raylight` also had a second, unrelated bug** in its own `_resolve_repo_root()` (broke under our symlinked shared-node convention, fixed via `patches/raylight-comfyui-root-via-folder-paths.patch`) — this fix is about raylight's own code, not about which image supplies the compiled libraries, so it still applies after the image switch.

**Native C++/CUDA extension builds are not attempted.** `ComfyUI-Hunyuan3d-2-1.disabled`'s Python (`pip`) requirements are installed, but its `custom_rasterizer`/`DifferentiableRenderer` `setup.py install` native extension builds (per Intel's Dockerfile) were not — same rationale as above, deferred as a gap rather than risked mid-batch.

---

## Multi-person shared environment

This project moved from "one person operating two GPU nodes" to a multi-person, distributed setup where several people test against the same shared NFS environment (`/nfs_share`). Two things needed a real protocol instead of tribal discipline: distributing the (large) Docker base image, and letting more than one person edit shared `custom_nodes/` packages without colliding.

### Onboarding a new GPU node: load the image from NFS, don't `docker pull`

`docker_image` (e.g. `intel/llm-scaler-omni:0.1.0-b7`, 40GB+ unpacked) is saved once to NFS instead of every node independently pulling it from Docker Hub. This is faster, doesn't need registry/proxy access from every node, and — importantly — pins to an exact content digest, since Docker Hub tags themselves aren't immutable.

```
/nfs_share/docker-images/
  intel-llm-scaler-omni-0.1.0-b7.tar             # docker save output
  intel-llm-scaler-omni-0.1.0-b7.manifest.json   # source digest, image_id, size, saved-by/-at
  current -> intel-llm-scaler-omni-0.1.0-b7.tar  # scripts/docs reference "current", not a hardcoded filename
  CHANGELOG.md
```

**New node onboarding** — after this, `gpu-nodes.json`'s `docker_image` field and Step 05's Docker-runtime flow work completely unchanged; this only populates the local Docker daemon's image cache:

```bash
scripts/load-docker-image-from-nfs.sh          # loads whatever `current` points at
scripts/load-docker-image-from-nfs.sh <version-basename>   # pin an explicit version instead
```

The script verifies the loaded image's content-addressed `image_id` (`docker image inspect --format '{{.Id}}'`) against the value recorded in the manifest at save time. **Note:** `RepoDigests` is a registry-pull-only concept and is always empty after `docker load` — it is *not* a valid post-load check (a manifest saved before this was understood may lack `image_id`; the script just skips the check in that case rather than false-warning).

This script is now wired into the app rather than being purely a manual step: `scripts/bootstrap-gpu-node.mts --runtime docker` runs it automatically as part of onboarding (see [Docker-runtime onboarding](#docker-runtime-onboarding-fully-integrated) above), the Web UI's GPU Nodes Manager has a "Sync Docker Image from NFS" button per docker-runtime node (`POST /api/gpu-nodes/:name/sync-docker-image`), and `verifyNode`'s "Test" now also checks `/nfs_share` mount health (not just the image) and points at this mechanism instead of `docker pull` when the image is missing. The script itself is unchanged and still works standalone for anyone SSHed directly into a node.

**Publishing a new/updated image version** (e.g. after Intel republishes under the same tag, or a new bundle version is adopted):

```bash
scripts/save-docker-image-to-nfs.sh <image:tag>              # first save of a new tag
scripts/save-docker-image-to-nfs.sh <image:tag> --refresh     # re-save the same tag after upstream content changed
```

`--refresh` writes a distinctly `-refreshedYYYYMMDD`-suffixed version rather than overwriting the existing one, and does **not** repoint `current` automatically — review the new manifest against the old one first, then `ln -sf` it deliberately if it should become the new default.

### Editing a shared `custom_nodes/` package: isolate, then publish

Default state for any package nobody is actively touching: unchanged, symlinked straight to `/nfs_share/custom_nodes/<name>` (see [Shared custom_nodes/ convention](#shared-custom_nodes-convention-nfs) above). That default doesn't scale once more than one person might be editing the same shared tree concurrently — the isolate-then-publish workflow below avoids collisions without needing any locking:

```bash
# 1. Start isolated local dev on this node only — clones the shared package to
#    ~/dev/shared-nodes/<name> and repoints THIS node's custom_nodes/<name>
#    symlink at the local clone. Other nodes/people are unaffected.
scripts/dev-checkout-shared-node.sh <name>

# 2. Edit + test freely against the local clone (manual container launch,
#    Playwright, whatever). Commit as you go, same as any git repo.

# 3. Publish: requires a clean `git status` in the local clone (refuses to
#    publish uncommitted work), does a real `git pull <local-clone> <branch>`
#    into the shared NFS canonical repo (a merge, not a file overwrite — a
#    genuine conflict with someone else's concurrent change surfaces as a
#    normal git merge conflict, resolved directly in the NFS repo), then
#    restores this node's symlink back to the shared copy.
scripts/publish-shared-node.sh <name>
```

After publishing, update `docs/xpu-bundle-provenance.md`'s commit hash for that package if it's tracked there (the script prints a reminder).

**Before starting a session** (and after finishing one), check for real uncommitted changes anyone left in the shared tree:

```bash
scripts/check-shared-nodes-clean.sh
```

Ignores build-artifact noise (`__pycache__`/`*.pyc`/`.pytest_cache`, gitignored across all shared packages) so a real uncommitted change doesn't get lost in false positives — this exact false-positive was confirmed live in two packages (`ComfyUI-QwenVL`, `ComfyUI-RMBG`) before the `.gitignore` housekeeping fix. **If a package shows dirty and it isn't yours: don't delete it blindly** — check with whoever owns it first (see the KJNodes/GGUF near-miss above for why this matters).

### Completed migrations: auto-archived to `/nfs_share/workflows/`

The third shared NFS convention (alongside `custom_nodes/` and `docker-images/`): once a task's Step 12 (GUI human acceptance) records `manual_result: "accepted"`, the orchestrator automatically copies that task's entire Step 11 delivery bundle (`<task.artifactPath>/11-delivery/` — the runnable workflow, `GUI-IMPORT-README.md`, asset ledgers, acceptance report, everything) to:

```
/nfs_share/workflows/<original_workflow_name>_intel_<timestamp>/
```

- `<original_workflow_name>` is the task's name (defaults to the originally-uploaded workflow's filename), sanitized to `[a-zA-Z0-9._-]`.
- `<timestamp>` is the UTC time of acceptance, `YYYYMMDDTHHMMSSZ` (sortable, filesystem-safe).
- If the same name+timestamp already exists (e.g. Step 12 rerun within the same second), a `-2`, `-3`, ... suffix is added rather than overwriting.
- This is **fully automatic and best-effort** — no script to run, nothing to configure per-task. A `rejected`/`blocked` acceptance result, or a task that never reaches Step 12, never writes anything. A failure to write to NFS (e.g. path unavailable) is logged as a non-fatal event and never affects Step 12's own completion or the task's status.
- Override the destination root via `WORKFLOW_ARCHIVE_ROOT` (default `/nfs_share/workflows`) — same env-var-with-default convention as `MODEL_ROOTS`.

This gives every person a durable, shared, browsable record of what's already been successfully migrated — independent of any single task's private workspace being cleaned up later.

### Shared venv: pip installs are serialized, not just documented

The fourth shared write path: `/nfs_share/venv-container-xpu` (the shared `runtime=docker` venv) gets `pip install`ed into whenever a workflow needs a package it doesn't have cached yet — routinely, via Step 05's dependency installs and `node-precheck.mts --prepare`, not just rare manual maintenance. Two people testing different new workflows around the same time is a normal collision on this venv, not an edge case, so this is enforced with a real lock (`scripts/with-shared-venv-lock.sh`, atomic `mkdir`-based — `flock` was tried and confirmed **not** to provide real cross-host exclusion on this NFS mount) rather than left as a "please coordinate manually" note. See [Docker runtime](#docker-runtime-intel-xpu-bundle)'s shared venv section for the full mechanism and the ComfyUI-auto-install gap it doesn't cover.

### Explicit non-goals

- The shared venv (`/nfs_share/venv-container-xpu`) is not baked into the saved image — still lives on NFS exactly as before; this only changes how the *base image* is distributed.
- No locking/mutex mechanism for two people editing the *same* package at the *same* time — a real conflict is meant to surface as a normal git merge conflict in `publish-shared-node.sh`, not be prevented upfront.
- `gpu-nodes.json`'s schema and Step 05's Docker-runtime code are unchanged — image loading is a one-time host-level setup step, invisible to the orchestrator.
- No dedup/GC policy for `/nfs_share/workflows/` yet — it only grows; revisit if NFS space becomes a concern.

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


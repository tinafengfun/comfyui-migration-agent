### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Environment deployment skill

## Use when

Use to create a reproducible Intel XPU ComfyUI baseline.

## Inputs

- ComfyUI checkout
- Python/venv path
- package requirements
- model roots
- custom-node ledger
- asset ledger and acquisition log
- source-audit report
- required patch-class table
- Step 04 `step05_context`
- Step 01 staged asset and custom-node source acquisition artifacts

## Algorithm

1. Freeze repo commits and Python environment.
2. Install ComfyUI dependencies, then prove the accelerator stack:
   - exact `torch`, `torchvision`, and `torchaudio` versions
   - whether the installed wheel is CPU, CUDA, or XPU
   - `torch.xpu.is_available()`
   - XPU device name and total VRAM from both PyTorch and system tools where possible
3. If a generic install pulled CUDA wheels on an XPU host, replace them with matching XPU wheels and re-run the proof. Do not continue with a CUDA build just because imports succeed.
4. Install or symlink custom nodes at recorded commits and record whether they are clean, patched, or dirty. This includes **implicit-package dependencies from `00-enum-dependencies.csv` / Step 01** (packages that inject enum values like `res_2s`/`bong_tangent` into core node dropdowns, e.g. RES4LYF): install them on the target too.

   **Use the deterministic tool `scripts/install-enum-package.mts`** — it does the proven install→reload→verify loop (idempotent, local + ssh). For each `state=source known` row in `00-enum-dependencies.csv`, take the `resolving_package` (the recipe's `packageRepo`) and run:
   ```bash
   npx tsx scripts/install-enum-package.mts \
     --node <gpu-node-name> \
     --repo <resolving_package repo url> \
     --host-node-type <node_type from the CSV row, e.g. KSampler> \
     --verify <slot>=<value>   # one --verify per enum value the package must restore
   ```
   It writes `05-enum-package-install.json` (before/after presence, commit, outcome) — attach it as Step 05 evidence. `outcome=installed_verified` or `already_satisfied` = success (value present identical-to-source). `outcome=install_failed`/`verify_failed`/`comfyui_unreachable` = do NOT silently substitute — surface a human gate stating the tradeoff (install=identical vs substitute=drifts); substitution requires explicit approval and downgrades the claim boundary (agent.md rule 3a).
5. Install dependencies using the source-audit report:
    - install portable import/runtime dependencies needed for target registration
    - include portable runtime dependencies for workflow-selected node classes, even if node registration succeeds without importing them
    - avoid CUDA-only optional accelerators unless explicitly approved
    - record skipped packages, such as `bitsandbytes`, `flash-attn`, `sageattention`, or `onnxruntime-gpu`, and the affected optional paths
    - **For `runtime: docker` nodes, install through the shared-venv lock wrapper, not pip directly** — see the `runtime=docker` subsection below for why and the exact command.
6. Configure model roots or symlink staged assets, and retain a source-to-destination mapping. Prefer a separate Step 05 extra-model-paths config over editing the canonical ComfyUI config when running an isolated validation.
7. Apply required registration patches or workflow runtime policies only with explicit approval, and keep them separate from runtime validation claims.
   - **`/nfs_share/comfyui-core` is the single master for ComfyUI CORE CODE + patches.** The orchestrator handles the sync automatically around each migration: **before** Step 05 it merges the master into this node's local `comfyui_root` (so you start from the newest core + all prior patches — no manual "sync from NFS" needed), and **after** the whole migration (Step 13) it auto-publishes any new core commits back to the master (serialized). Your job here: apply core patches to this node's **local** `comfyui_root` and **commit them** (a clean `git commit -m "..." -- <files>` in the comfyui_root, intended files only — do not sweep unrelated untracked junk) so the post-run publish can push them to the master. Do NOT run a live full ComfyUI from the NFS tree; local execution + git sync is the model.
   - **If Step 02 decided `fp8_te_path_chosen: "native_fp8_keep_on_move"` (PREFERRED for heavy fp8 diffusion on XPU)**: (a) ensure the shared venv has `comfy_kitchen >= 0.2.28` — `bash /nfs_share/bin/with-shared-venv-lock.sh "${VENV_PYTHON}" install -U 'comfy_kitchen>=0.2.28'` (never pip directly for `runtime: docker` nodes); (b) apply `patches/xpu-fp8-keep-quantized-on-move.patch` to `comfy/ops.py` (see the injected patch-adaptation protocol table) and verify with `git diff comfy/ops.py` that both XPU fp8 branches in `_quantized_apply` are now gated by `os.environ.get("OMNI_FP8_KEEP_ON_MOVE") != "1"` and that `import os` is present; (c) the launch must set `OMNI_FP8_KEEP_ON_MOVE=1` in the container/process env (the deterministic launcher `comfyuiLifecycle.ts` already passes `-e OMNI_FP8_KEEP_ON_MOVE=1`). This keeps fp8 models fp8 across device moves so the HIGH→LOW swap doesn't dequant-to-bf16 and OOM. Runtime placement (CLIP/UNet/VLM) is enforced by the Step-06 runtime-policy variant, not here.
   - **If Step 02 decided `fp8_te_path_chosen: "ops_py_patch"` (legacy dequant-before-move)**, apply the equivalent dequant-before-move change to `comfy/ops.py` and verify `_quantized_apply` contains the `_is_fp8_quantized_tensor` + `_probe_device` + `dequantize-before-move-to-xpu` block. Prefer `native_fp8_keep_on_move` above when comfy_kitchen ≥ 0.2.28 is available — the dequant path doubles TE memory.
   - **If Step 02 decided `fp8_te_path_chosen: "cpu_offload"` (last resort)**, no `ops.py` patch is needed; the CLIPLoader widget `device=cpu` override is delivered as a runtime-policy JSON patch instead. Only use when the keep-on-move patch cannot be applied.
   - **If Step 02 decided `fp8_te_checkpoint_stripped: true`**, ensure the stripped `<name>_text_only.safetensors` is the file referenced by the CLIPLoader widget, not the original.
8. Launch ComfyUI from the ComfyUI root, **not** from the task workspace. The SDK session's working directory is the workspace, so an unqualified `python3 main.py` inherits the wrong CWD and Python's `sys.path[0]` will not contain the ComfyUI root. **Branch on the `## GPU node` block injected at the top of this step's prompt:**

   ### kind=local (existing flow)

   ```bash
   cd "${COMFYUI_ROOT}" && \
   "${VENV_PYTHON}" main.py \
     --port "${COMFYUI_PORT:-8188}" \
     --listen 127.0.0.1 \
     --extra-model-paths-config "${WORKSPACE}/artifacts/05-extra-model-paths.yaml" \
     --output-directory "${WORKSPACE}/outputs" \
     <Intel XPU flags: --reserve-vram 1 (keep dynamic VRAM ENABLED — do NOT pass --disable-dynamic-vram — so the sequential fp8 offload/swap can free models between stages; do NOT pass --cpu-vae, VAE runs on XPU with auto-tiled fallback)>
   ```

   Run in the background (`nohup ... &` or detached shell) and poll `http://127.0.0.1:${COMFYUI_PORT}/system_stats` until it responds.

   ### kind=ssh (remote large-VRAM node)

   The remote node's `comfyui_root`, `venv_python`, `model_roots`, and SSH details are in the `## GPU node` block. Models and custom nodes must already exist on the remote — see `docs/gpu-node-setup.md`. NFS-same-path means the same `model_roots` strings are valid on both sides; do not sync models.

   ```bash
   ssh -p ${SSH_PORT} ${SSH_KEY_OPT} ${SSH_USER}@${SSH_HOST} \
     "cd '${REMOTE_COMFYUI_ROOT}' && \
       nohup '${REMOTE_VENV_PYTHON}' main.py \
         --port ${COMFYUI_PORT:-8188} \
         --listen 0.0.0.0 \
         > /tmp/comfyui-${TASK_ID}.log 2>&1 &"
   ```

   Then from the migration agent poll the **remote** API URL `${API_URL}/system_stats` until it responds (usually 10–60s). The local workspace path is not valid on the remote — skip `--extra-model-paths-config` and `--output-directory`. Outputs are fetched later via the `/view` and `/history` HTTP APIs from Steps 07/08.

   Use `--listen 0.0.0.0` on the remote so the migration agent can reach it across the network. Do NOT use `--listen 127.0.0.1` for an ssh node — the agent's HTTP calls will time out.

   ### runtime=docker (either kind — check the `## GPU node` block's `runtime`/`docker_image` fields)

   When `runtime: docker`, ComfyUI runs inside a container derived from `docker_image` (currently Intel's `intel/llm-scaler-omni:0.1.0-b7`) instead of a bare subprocess. That image supplies compiled oneAPI/PyTorch-XPU/`omni_xpu_kernel`/`sgl-kernel-xpu` packages only — **never use its own ComfyUI, custom_nodes, or entrypoint** (it has a real ComfyUI checkout at `/llm/ComfyUI` with 14 baked-in nodes; this is never touched or run). **Always launch with `--entrypoint <venv_python>`** (the `venv_python` from the `## GPU node` block), never the image's default entrypoint (`/lib/systemd/systemd` — this image is built to run as a full-OS-like container; a plain entrypoint override bypasses that entirely, confirmed live). `venv_python` is always a `--system-site-packages` venv (inherits the image's torch-xpu/oneAPI/compiled kernels) that is visible inside the container for free because its directory is one of the bind-mounted `model_roots` paths — never a path under `comfyui_root`. Read it from the node block; don't hardcode a venv path, and never `pip install` into it directly or rebuild it inside a migration (it is provisioned at deploy).

   Two node shapes exist, distinguished by `worker_local_venv` in the node block:
   - **`worker_local_venv: true` (V2 default — a NODE-LOCAL venv**, e.g. `/home/intel/comfyui-runtime-venv/bin/python3`): created once at deploy (`scripts/deploy-remote-node.sh --setup-local-venv`) with the shared venv's site-packages layered in as a **read-only `.pth` base** (so ComfyUI runtime deps like `comfy_aimdo` resolve without touching the shared tree). Because it is per-node, ComfyUI's import-time auto-`pip install` and any deliberate install land ONLY in this node's local venv — they can never corrupt a shared venv. This is what makes concurrent multi-node migrations conflict-free; there is no cross-node contention to lock against.
   - **shared NFS venv (legacy**, e.g. `/nfs_share/venv-container-xpu/bin/python3`): one venv shared by every node. Here a deliberate install MUST go through `bash /nfs_share/bin/with-shared-venv-lock.sh <venv_python> install ...` (from a throwaway container, never by touching the image): this venv has no cross-invocation lock of its own, and two concurrent installs corrupt site-packages — a routine risk when several people test workflows at once. Prefer migrating a node to `worker_local_venv` over relying on this lock.

   **Every container invocation needs the corporate proxy env vars, not just interactive installs.** ComfyUI itself auto-`pip install`s missing custom-node dependencies at import time (observed live: `diffusers==0.27.2` for `ComfyUI-WanVideoWrapper`) — without `https_proxy`/`http_proxy` set in the container's environment, that subprocess hangs indefinitely on an unreachable network rather than failing fast. Always include `-e https_proxy=http://proxy.ims.intel.com:911 -e http_proxy=http://proxy.ims.intel.com:911 -e no_proxy=localhost,127.0.0.1` on every `docker create`/`docker run` for this runtime, launch or otherwise.

   **Copy in, don't bind-mount, the thing under test.** Each task gets its own ephemeral container; this task's `comfyui_root` (ComfyUI core + `custom_nodes/`, already staged/patched by earlier steps) is `docker cp`'d in fresh, giving per-task isolation instead of sharing one mutable mount across concurrent tasks. `model_roots` stay bind-mounted (large, shared, read-mostly) at identical host paths so no model-path rewriting is needed.

   Container name is always `comfyui-${TASK_ID}` — this exact name is what the orchestrator's `killComfyUIForTask` uses for `docker rm -f` teardown, so do not deviate from it.

   GPU device/group flags differ per host — resolve them at launch time, never hardcode a GID:

   ```bash
   RENDER_GIDS=$(stat -c '%g' /dev/dri/render* | sort -u)
   GROUP_ADD_FLAGS=""
   for gid in $RENDER_GIDS; do GROUP_ADD_FLAGS="${GROUP_ADD_FLAGS} --group-add ${gid}"; done
   ```

   Three sharp edges to get right, all confirmed by direct testing:

   1. The image's default `ENTRYPOINT` is not a plain shell — Intel's images have used both `["bash", "-c", "vllm serve"]` and (the current `llm-scaler-omni` image) `/lib/systemd/systemd`, neither of which accepts appended args or launches ComfyUI on its own. Any command given after the image name is silently ignored unless you pass `--entrypoint "${VENV_PYTHON}"` explicitly.
   2. `docker cp` has no exclude flag, and `comfyui_root` can contain large, irrelevant-to-launch directories (a local `models/` cache, `output/`, `temp/`, `.venv`, or on the dev machine this very agent's own deployed copy under `agent-demo/`) — never copy those in. Build the copy-in as a `tar` stream with excludes.
   3. `docker cp` cannot create a destination directory when its source is a tar stream on stdin (only when the source is a real host path), and the container isn't started yet so its filesystem has nothing but the base image. Stage the filtered copy on the host first, then `docker cp` that staging directory in (this form *does* auto-create the destination), then remove the staging copy. Use a container path outside the image's own reserved dirs — `/comfyui` is safe; the current image's `/llm` is used by its own baked-in ComfyUI + compiled kernels (never touched — see the Docker-runtime section of `docs/gpu-node-setup.md`).

   ```bash
   docker create --name "comfyui-${TASK_ID}" --network host --device /dev/dri ${GROUP_ADD_FLAGS} \
     --entrypoint "${VENV_PYTHON}" \
     -e https_proxy=http://proxy.ims.intel.com:911 -e http_proxy=http://proxy.ims.intel.com:911 \
     -e no_proxy=localhost,127.0.0.1 \
     -e OMNI_FP8_KEEP_ON_MOVE=1 \
     $(for m in "${MODEL_ROOTS[@]}"; do echo -n "-v ${m}:${m} "; done) \
     "${DOCKER_IMAGE}" /comfyui/main.py \
       --port "${COMFYUI_PORT:-8188}" --listen 127.0.0.1 \
       --extra-model-paths-config /comfyui/05-extra-model-paths.yaml \
       --output-directory /comfyui/outputs \
       <Intel XPU flags: --reserve-vram 1 ; keep dynamic VRAM enabled (no --disable-dynamic-vram) ; no --cpu-vae>

   STAGING=$(mktemp -d)
   tar -C "${COMFYUI_ROOT}" \
     --exclude=./models --exclude=./output --exclude=./temp --exclude=./input \
     --exclude=./.venv --exclude=./.venv-xpu --exclude=./agent-demo \
     --exclude=./tests --exclude=./tests-unit --exclude=./docs \
     --exclude=__pycache__ \
     -cf - . | tar -xf - -C "${STAGING}"
   mkdir -p "${STAGING}/outputs" "${STAGING}/input"
   docker cp "${STAGING}/." "comfyui-${TASK_ID}:/comfyui"
   rm -rf "${STAGING}"
   docker start "comfyui-${TASK_ID}"
   ```

   **Pre-create `/comfyui/outputs` (and `/comfyui/input`) in the staging directory, not via `docker exec` after start.** At least one custom node (`ComfyUI-AdvancedLivePortrait`) does `os.mkdir()` (not `os.makedirs()`) against a subdirectory of the output dir at import time, assuming it already exists — confirmed live: a fresh copy-in container without a pre-existing `outputs/` directory fails that node's import with `FileNotFoundError`. A `docker exec ... mkdir` *after* `docker start` doesn't reliably fix this: the container's PID 1 *is* ComfyUI itself (no init system to exec into before it runs), so there's no window to exec into before node imports begin — it only appears to work by accidental import-order timing luck (confirmed: this genuinely raced and passed once, which is not a fix, just luck). Create the directories in the staging directory before `docker cp`, so they're present in the very first filesystem view the container sees.

   **The exclude patterns must be anchored with `./` (top-level only).** An unanchored `--exclude=models` matches *any* directory named `models` anywhere in the tree — including the genuinely-needed source directory `comfy/ldm/models/` — and silently breaks the copy (confirmed live: this produced `ModuleNotFoundError: No module named 'comfy.ldm.models'`). `__pycache__` is the one exception left unanchored, since excluding it at every depth is actually intended.

   (`--extra-model-paths-config`/`--output-directory` here are container-internal paths written into the copied tree, not the host workspace path — the host workspace isn't visible inside the container. `custom_nodes/` symlinks into the shared NFS tree resolve correctly inside the container because `model_roots` — which includes that same NFS mount — is bind-mounted at an identical path.)

   SSH (`kind=ssh`): wrap the same `docker create` / `docker cp` / `docker start` sequence over SSH, using the remote's `${REMOTE_COMFYUI_ROOT}` as the `docker cp` source and `--network host` so the existing remote `api_host:api_port` reachability assumption still holds. Use `--listen 0.0.0.0` inside the container command, same rationale as the bare-metal ssh flow above.

   Verify with `docker ps --filter "name=comfyui-${TASK_ID}"` in addition to the usual `/object_info` poll. On rerun/cleanup, `docker rm -f "comfyui-${TASK_ID}"` before creating a new one — containers are ephemeral, never reused across tasks.

   ### Common notes (both kinds)

   - ComfyUI 0.28 uses `--extra-model-paths-config`; older builds used `--extra-model-paths-yaml` — verify for your version.
   - `cd "${COMFYUI_ROOT}" &&` (local) or `cd '${REMOTE_COMFYUI_ROOT}' &&` (ssh) is load-bearing — without it, `from utils.install_util import ...` and other top-level imports can fail.
   - Record the exact launch command in `05-environment-summary.json` as `launch_command`, plus `api_url` (e.g. `http://172.16.114.200:8188`) and `node_kind` (`local` or `ssh`) so Steps 07/08 and the orchestrator's `killComfyUIForTask` know how to reach and tear down the server.
   - Subsequent steps (07, 08, 12) inherit this server; do not relaunch unless the process died.
   - Default flags: `--reserve-vram 1`, and keep **dynamic VRAM enabled** (do NOT pass `--disable-dynamic-vram`) — the sequential fp8 offload/swap depends on ComfyUI being able to offload a model to make room for the next stage. Do NOT pass `--cpu-vae`; the VAE runs on XPU and ComfyUI auto-falls-back to tiled decode if a full decode would OOM. Always pass `-e OMNI_FP8_KEEP_ON_MOVE=1` (docker) / `export OMNI_FP8_KEEP_ON_MOVE=1` (bare) so the keep-on-move patch is active.
   - Only if a workflow was explicitly downgraded to CPU-only placement (no XPU path at all) launch with `--cpu` — this is a last resort, not the fp8 path. For fp8 diffusion on XPU use `native_fp8_keep_on_move` (keep CLIP/UNet on XPU; the Step-06 runtime policy handles per-node placement).
   - The orchestrator's `killComfyUIForTask` routes on the node's `runtime` first, then `kind`: `runtime=docker` → `docker rm -f comfyui-${TASK_ID}` (local or via SSH); `runtime=bare` (default) → local `pgrep -f main.py.*${WORKSPACE}` or SSH `pkill -f 'main.py.*--port ${COMFYUI_PORT}'`. The agent does not need to tear down manually on rerun.
9. Verify startup and backend node registration through `/system_stats` and `/object_info`.
10. For frontend-only LiteGraph nodes, record source evidence from web extension registration code instead of requiring `/object_info`.
11. Preserve logs and API evidence before moving to prompt validation.
12. Emit a `completion_decision` with checked criteria, evidence artifacts, unresolved gaps, human-gate prompt if any, and `next_step_allowed`.

## Reusable readiness collector

Use the Step 05 collector when available. For `kind=ssh`, the `--api-url` must point at the remote node, and `--comfy-root` / `--venv` are local paths used only for evidence-reading (the tool does not SSH on its own — gather remote evidence via `ssh ... python3 -c "..."` or by reading `/system_stats` over HTTP):

```bash
python3 $DRAFT_DOC_ROOT/migration-workflow-v2/tools/step05_environment_readiness.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --venv <ComfyUI root>/.venv-xpu \
  --link-staged-custom-nodes \
  --api-url <http://API_HOST:API_PORT from the GPU node block>
```

The tool creates safe custom-node symlinks (local only — for ssh nodes, custom nodes are pre-installed on the remote per `docs/gpu-node-setup.md`), writes `05-extra-model-paths.yaml`, collects XPU/venv/API evidence, writes registration/model/dependency ledgers, and generates `05-environment-summary.json` plus `05-output-manifest.json`. It must not overwrite custom-node collisions, install packages, edit source workflow JSON, or apply source patches.

## Environment baseline table

Record actual versions from the target machine. Do not invent versions.

| Component | Required value |
| --- | --- |
| OS / kernel | actual target value |
| GPU model and VRAM | actual target value from system tools |
| GPU driver | actual target value |
| Level Zero / oneAPI runtime | actual target value if installed |
| Python | venv Python version |
| PyTorch | exact package version and XPU build status |
| torchvision / torchaudio | exact package versions and whether they match the PyTorch accelerator build |
| intel-extension-for-pytorch | exact package version if installed |
| ComfyUI | commit SHA |
| Custom nodes | repo URL and commit SHA |
| Launch flags | exact command |
| Node registration | `/object_info` evidence for backend node types; source evidence for frontend-only node types |
| Model wiring | model root config or symlink map |
| Patch artifacts | files changed, patch path, and claim boundary |

If a version is unknown, write `unknown` and mark it as an environment gap until verified. Do not replace unknowns with guessed "known good" versions.

## Common failure signatures

- package imports fail before registration
- node installed after server start but not registered
- wrong model root hides available assets
- startup success misreported as workflow success
- PyPI or requirements install selects `torch+cu*` on an Intel XPU host
- `torch.xpu` exists but `torch.xpu.is_available()` is false
- ComfyUI starts but reports CPU or CUDA instead of `xpu:0`
- custom-node requirements include CUDA-only optional accelerators that break XPU import or install
- target node registers successfully but later fails during branch smoke because a declared portable runtime dependency was not installed
- optional node import failures obscure whether target workflow nodes registered
- local registration patch is mistaken for full native-XPU runtime support
- a frontend-only node is incorrectly treated as a missing backend `/object_info` node
- a portable custom-node runtime dependency is missing even though the XPU torch stack itself is valid

## Evidence standard

Retain install log, launch command, startup log, `/system_stats`, `/object_info`, node-registration evidence, model-path mapping, patch artifacts, and environment summary.

Registration evidence must name the workflow-critical node types, not just the package folder. A custom-node package can import while a specific node family remains absent.

Dependency evidence must also name workflow-critical node classes. If a package requirements file includes both portable runtime libraries and CUDA-only optional accelerators, record the decision per dependency: installed, skipped as CUDA-only, or intentionally deferred. A node that imports/registers can still fail later if its runtime function imports an undeclared-or-uninstalled helper library. If a portable dependency is installed as a repair, prefer the smallest targeted install that cannot replace the XPU torch stack, and keep the pip log as an artifact.

Frontend-only evidence must cite the source file that registers the LiteGraph node type, such as a web extension `registerNodeType(...)` or package-specific helper that constructs the node type. Do not mark these nodes as bypassed; classify them as `frontend_only_source_verified`.

For local patches applied during environment deployment, record:

1. why the patch was required
2. exact files changed
3. whether the patch is registration-only, runtime-policy, or functional runtime support
4. what still needs branch smoke before promotion

## Hard stops

Stop if ComfyUI cannot start or required backend nodes cannot register.

Stop if the target is Intel XPU but the environment uses a CUDA/CPU PyTorch build, if required backend target nodes are absent from `/object_info`, or if a frontend-only node cannot be source-verified.

### Partial deployment rule

Step 05 must deploy the environment (Python, XPU stack, custom-node registration, model-path config) even when Step 01 documents missing source-identical model assets. The environment itself — runtime stack, node registration, API endpoints — is independent of model file completeness. Missing models should be documented as `unresolved_model_gaps` in the environment artifact, not treated as a deployment blocker.

Only block Step 05 deployment when:
- the XPU PyTorch stack itself is broken or absent
- ComfyUI cannot start at all
- a custom-node package directory is empty/missing AND the node is on the critical path (install it first per the custom-node install rule below)

### Custom-node install rule

If Step 01 or Step 04 reports a custom-node package as "environment gap" (directory exists but is empty or missing Python files), Step 05 must attempt to install it:

1. **Check `/nfs_share/custom_nodes/<name>` first** (or whatever `nfs_share_root` the node config declares). If the target node has a shared NFS tree (both currently-configured nodes do, since `runtime: docker` implies it — see `docs/gpu-node-setup.md`'s "Shared custom_nodes/ convention"), clone the package there instead of directly into the node's own `custom_nodes/`, then symlink `<comfyui_root>/custom_nodes/<name>` to it. This is what `scripts/install-enum-package.mts` now does automatically — reuse it, or replicate the same clone-into-shared-tree-then-symlink pattern for any other custom-node install. Cloning straight into `<comfyui_root>/custom_nodes/<name>` as an independent directory silently un-does the shared convention for every other node/person using this environment.
2. If the node has no shared NFS tree, clone the public GitHub repository directly into the custom-node directory (today's plain behavior).
3. Install declared pip dependencies (portable only, skip CUDA-only)
4. Verify registration via `/object_info` after server restart
5. If clone or install fails, document it as a gap — do not hard-stop unless the node is on the critical execution path AND no workaround exists

**Known custom-node pip overrides (do NOT install their CUDA `requirements.txt`).** Some packages pin CUDA/Metal wheels that are wrong for this XPU/CPU box; the known-custom-node registry (`src/server/knownCustomNodes.ts`) records the correct backend. For **`ComfyUI-llama-cpp_vlm`** (`llama_cpp_*` VLM nodes): do **not** `pip install -r` its `requirements.txt` (it pins `+cu128` CUDA / Metal `llama-cpp-python`). Instead install the **CPU-built** `llama-cpp-python` into the shared venv via the lock wrapper, from the staged wheel:
```
bash /nfs_share/bin/with-shared-venv-lock.sh <venv_python> install \
  /nfs_share/wheels/llama-cpp-python/llama_cpp_python-0.3.40-cp312-cp312-linux_x86_64.whl
```
(the canonical CPU wheel is staged under `/nfs_share/wheels/llama-cpp-python/`; if absent, build once from the JamePeng fork with no GPU backend and stage it there — never install the CUDA wheel). The VLM then runs on **CPU** (host RAM, not XPU VRAM), which is intended: it leaves the XPU free for fp8 diffusion. Ensure this node's model `.gguf` **and** its `mmproj` `.gguf` resolve under **`models/LLM/`** (Step 01 routing places them there); if a prior run left them in `text_encoders/`, symlink/move them into `models/LLM/`.

### Catalog-driven custom-node migration (only when `XPU_CATALOG_ENABLED`)

Migrate each custom node **catalog-first**. A trusted record for a node's `class_type` (if any) is
injected into your prompt as "Matched catalog records (trusted XPU-support DB)". This is the deterministic
per-node state machine — the backend owns validation + the catalog write; you own the read + migrate:

1. **Route by the injected record vs what you deploy (node commit + model dtype):**
   - **trusted + commit-match + dtype-match** → apply the recipe as-is (clone @ its commit; apply its
     patches / pip backend / config). **No re-exploration** — it is proven.
   - **trusted + commit-drift (dtype ok)** → **adapt** the recorded patch via the injected
     patch-adaptation protocol (three layers: text → structural → semantic). Never blind-apply a stale patch.
   - **dtype-drift / candidate / miss** → migrate. A **candidate** record is a hint you apply but must
     still validate; **dtype-drift / miss** is a fresh exploration.
2. **Clone-lease (pessimistic) around the shared-tree clone.** Before cloning into
   `${NFS_SHARE}/custom_nodes/<name>`: `npx tsx scripts/catalog-lease.mts --node-key <k> --action acquire
   --holder "${TASK_ID}"`. exit 3 (held by another agent) → **wait + reuse** their result; do not clone in
   parallel (would corrupt the shared git tree). `--action heartbeat --lease-id <id>` during a long clone;
   `--action release --lease-id <id>` immediately after. Keep this short — the lease covers only the clone.
3. **Bounded autonomous repair (≤ 3 rounds → human gate), route-scoped and objective-gated.**
   The `migration_route` from Step 04 (and the catalog `migrationRoute`) is your AUTONOMY BUDGET allocator:
   - **Spend attempts only on `auto_*` routes** (`auto_deps`, `auto_device_redirect`, `auto_fp8`,
     `auto_attention_fallback`, `auto_enum`) — apply the matching meta-pattern (`cuda→xpu` via the
     device-redirect patch, fp8 keep-on-move, cpu/openvino attention fallback, enum install, in-container
     dep install) as your playbook. Only ISOLATED + REVERSIBLE actions: patch the node's own cloned source,
     install deps in the container, set `device=cpu`. NEVER autonomously touch shared/irreversible state
     (a shared-venv install that could pull the CUDA torch stack, core `comfy/ops.py`, `docker commit`) —
     those follow the deterministic recipe or a human gate.
   - **Spend ZERO attempts on `human_*` / `unsupported_*` routes** — do not try to XPU-migrate a compiled
     CUDA kernel or resolve a version conflict; fail fast and open the gate with the reason (wasting a GPU
     run here helps nobody).
   - **The arbiter of each attempt is the OBJECTIVE check, never your own opinion:** the node must appear
     in `/object_info` (registered on XPU) and, once Step 07 runs, execute FRESH on a SUCCESSFUL smoke
     branch. "I think it's fixed" is not a pass.
   Before each attempt: `npx tsx scripts/catalog-explore.mts --workspace <artifacts> --node-key <k>
   --action record`. exit 4 = EXHAUSTED → open an `ask_user` gate with your ≤3 attempts + evidence + a
   concrete suggested fix and co-decide with the human (apply their fix and re-validate, or mark
   `unsupported` + gap and CONTINUE the other nodes — never wedge the pipeline). Use the injected catalog
   candidate/boundary HINTS (Phase-1 injection: candidate = verify-first, unsupported = boundary/do-not-apply)
   as prior evidence — re-verify against the current source before relying on them.
4. **Emit the deploy ledger (capture-on-success flywheel).** Write `<artifacts>/05-catalog-deploy-ledger.json` =
   `{ "nodes": [ { "nodeType", "nodeKey", "repository", "commit", "dtype", "xpuSupport", "execution",
   "migrationRoute", "patches": [{file,target}], "pip": {backend} }, … ] }` for every custom node you
   deployed — INCLUDE the `migrationRoute` you used (the auto_* route that worked) so a successful autonomous
   fix is captured back into the catalog as reusable determinism. After Step 07 the backend confirms each
   node via the branch-smoke results — a node is written to the catalog ONLY if it executed FRESH on a
   SUCCESSFUL XPU output branch (cached/skipped/failed → not recorded) — and folds the result in
   (candidate → trusted after repeat validation). This is how autonomy manufactures new determinism: the
   `auto_*` long tail shrinks into trusted recipes over time. So: make sure the custom nodes are actually
   exercised by the output branches Step 07 runs. **You never open the catalog SQLite or commit its git —
   you POST via the lease/explore CLIs and emit the ledger; the single catalog-server owns every write.**

### Hidden runtime asset pre-stage check (do this BEFORE downloading anything Step 02 flagged)

If Step 02 identified a hidden runtime asset (a custom node's model suite loaded dynamically from its own code — e.g. IndexTTS2's ~14GB model suite) and got human sign-off to defer acquisition, the backend may have already started downloading it in the background as soon as Step 02 finished, specifically so Step 05 doesn't have to fetch a multi-GB model suite live inside its own session. Before you acquire any such asset yourself:

1. Check whether `<artifact_folder>/02-hidden-runtime-assets.json` exists — it lists exactly what was flagged (`repo`/`files`/`targetRelativePath`).
2. Check `<artifact_folder>/hidden-asset-downloads/*.status.json` for each listed item/file — each record has `status: "downloading" | "complete" | "failed"` and a `targetPath`. Also check whether `targetPath` already exists and is non-empty on disk (the real ground truth — a status file can be stale after a backend restart).
3. If a file is already present at its `targetPath`: it's done, don't re-download it — just reference it in your `model_paths`/readiness reporting.
4. If a file's status is `"downloading"`: wait for it (poll every ~30s, this is a background OS process, not something you started) rather than starting a redundant second download of the same multi-GB file.
5. If a file's status is `"failed"`, or no `02-hidden-runtime-assets.json`/status file exists at all: fall back to acquiring it yourself exactly as before (this pre-stage mechanism is best-effort; its absence or failure must never block Step 05).

## Output schema

`repo_commit`, `venv`, `python`, `torch`, `torchvision`, `torchaudio`, `xpu_available`, `ipex`, `driver`, `level_zero`, `launch_command`, `model_paths`, `custom_nodes`, `registration_status`, `api_evidence`, `patches`, `installed_runtime_dependencies`, `skipped_dependencies`, `deferred_dependencies`, `frontend_only_nodes`, `gaps`, `completion_decision`, `step06_context`.

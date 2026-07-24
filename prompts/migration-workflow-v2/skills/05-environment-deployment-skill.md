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
   - **If Step 02 decided `fp8_te_path_chosen: "ops_py_patch"`**, apply `xpu-bug-investigation/0001-xpu-fp8-fallback-dequantize-before-move-to-xpu.patch` to `comfy/ops.py` here (or carry the equivalent change from the upstream ComfyUI fork). Verify with `git diff comfy/ops.py` that `_quantized_apply` now contains the `_is_fp8_quantized_tensor` + `_probe_device` + `dequantize-before-move-to-xpu` block. The patch is the prerequisite for keeping FP8 TEs on XPU without segfault.
   - **If Step 02 decided `fp8_te_path_chosen: "cpu_offload"`**, no `ops.py` patch is needed; the CLIPLoader widget `device=cpu` override is delivered as a runtime-policy JSON patch in Step 08 instead.
   - **If Step 02 decided `fp8_te_checkpoint_stripped: true`**, ensure the stripped `<name>_text_only.safetensors` is the file referenced by the CLIPLoader widget, not the original.
8. Launch ComfyUI from the ComfyUI root, **not** from the task workspace. The SDK session's working directory is the workspace, so an unqualified `python3 main.py` inherits the wrong CWD and Python's `sys.path[0]` will not contain the ComfyUI root. **Branch on the `## GPU node` block injected at the top of this step's prompt:**

   ### kind=local (existing flow)

   ```bash
   cd "${COMFYUI_ROOT}" && \
   "${VENV_PYTHON}" main.py \
     --port "${COMFYUI_PORT:-8188}" \
     --listen 127.0.0.1 \
     --extra-model-paths-yaml "${WORKSPACE}/artifacts/05-extra-model-paths.yaml" \
     --output-directory "${WORKSPACE}/outputs" \
     <conservative Intel XPU flags, e.g. --reserve-vram 1 --disable-dynamic-vram>
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

   Then from the migration agent poll the **remote** API URL `${API_URL}/system_stats` until it responds (usually 10–60s). The local workspace path is not valid on the remote — skip `--extra-model-paths-yaml` and `--output-directory`. Outputs are fetched later via the `/view` and `/history` HTTP APIs from Steps 07/08.

   Use `--listen 0.0.0.0` on the remote so the migration agent can reach it across the network. Do NOT use `--listen 127.0.0.1` for an ssh node — the agent's HTTP calls will time out.

   ### runtime=docker (either kind — check the `## GPU node` block's `runtime`/`docker_image` fields)

   When `runtime: docker`, ComfyUI runs inside a container derived from `docker_image` (currently Intel's `intel/llm-scaler-omni:0.1.0-b7`) instead of a bare subprocess. That image supplies compiled oneAPI/PyTorch-XPU/`omni_xpu_kernel`/`sgl-kernel-xpu` packages only — **never use its own ComfyUI, custom_nodes, or entrypoint** (it has a real ComfyUI checkout at `/llm/ComfyUI` with 14 baked-in nodes; this is never touched or run). For these nodes `venv_python` points at a *persisted, `--system-site-packages` venv living on the shared NFS mount* (e.g. `/nfs_share/venv-container-xpu/bin/python3` — visible inside the container for free since it's under the bind-mounted `model_roots` path), not a path under `comfyui_root`. It inherits the image's own torch-xpu/oneAPI/compiled-kernel packages and has ComfyUI's `requirements.txt` (plus custom-node requirements) layered on top — never `pip install` into it directly. **Always go through `bash /nfs_share/bin/with-shared-venv-lock.sh <venv_python> install ...` instead** (from a throwaway container, never by touching the image itself): this venv has no cross-invocation lock of its own, and two concurrent installs into it can corrupt site-packages — confirmed to be a routine risk, not an edge case, since multiple people testing different new workflows around the same time is normal operation, not a rare coincidence. Pass it to `--entrypoint`, not the image's default entrypoint (`/lib/systemd/systemd` — this image is built to run as a full-OS-like container; a plain entrypoint override bypasses that entirely, confirmed live).

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
     $(for m in "${MODEL_ROOTS[@]}"; do echo -n "-v ${m}:${m} "; done) \
     "${DOCKER_IMAGE}" /comfyui/main.py \
       --port "${COMFYUI_PORT:-8188}" --listen 127.0.0.1 \
       --extra-model-paths-yaml /comfyui/05-extra-model-paths.yaml \
       --output-directory /comfyui/outputs \
       <conservative Intel XPU flags>

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

   (`--extra-model-paths-yaml`/`--output-directory` here are container-internal paths written into the copied tree, not the host workspace path — the host workspace isn't visible inside the container. `custom_nodes/` symlinks into the shared NFS tree resolve correctly inside the container because `model_roots` — which includes that same NFS mount — is bind-mounted at an identical path.)

   SSH (`kind=ssh`): wrap the same `docker create` / `docker cp` / `docker start` sequence over SSH, using the remote's `${REMOTE_COMFYUI_ROOT}` as the `docker cp` source and `--network host` so the existing remote `api_host:api_port` reachability assumption still holds. Use `--listen 0.0.0.0` inside the container command, same rationale as the bare-metal ssh flow above.

   Verify with `docker ps --filter "name=comfyui-${TASK_ID}"` in addition to the usual `/object_info` poll. On rerun/cleanup, `docker rm -f "comfyui-${TASK_ID}"` before creating a new one — containers are ephemeral, never reused across tasks.

   ### Common notes (both kinds)

   - `cd "${COMFYUI_ROOT}" &&` (local) or `cd '${REMOTE_COMFYUI_ROOT}' &&` (ssh) is load-bearing — without it, `from utils.install_util import ...` and other top-level imports can fail.
   - Record the exact launch command in `05-environment-summary.json` as `launch_command`, plus `api_url` (e.g. `http://172.16.114.200:8188`) and `node_kind` (`local` or `ssh`) so Steps 07/08 and the orchestrator's `killComfyUIForTask` know how to reach and tear down the server.
   - Subsequent steps (07, 08, 12) inherit this server; do not relaunch unless the process died.
   - Conservative default flags: prefer `--reserve-vram 1` and `--disable-dynamic-vram` for smoke; widen only when Step 08 capacity evidence permits.
   - If the workflow selected CPU-only placement (e.g. FP8 TE CPU-offload path), launch with `--cpu` and pin CLIPLoader `device=cpu` via runtime-policy JSON in Step 08 rather than relaunching.
   - The orchestrator's `killComfyUIForTask` routes on the node's `runtime` first, then `kind`: `runtime=docker` → `docker rm -f comfyui-${TASK_ID}` (local or via SSH); `runtime=bare` (default) → local `pgrep -f main.py.*${WORKSPACE}` or SSH `pkill -f 'main.py.*--port ${COMFYUI_PORT}'`. The agent does not need to tear down manually on rerun.
9. Verify startup and backend node registration through `/system_stats` and `/object_info`.
10. For frontend-only LiteGraph nodes, record source evidence from web extension registration code instead of requiring `/object_info`.
11. Preserve logs and API evidence before moving to prompt validation.
12. Emit a `completion_decision` with checked criteria, evidence artifacts, unresolved gaps, human-gate prompt if any, and `next_step_allowed`.

## Reusable readiness collector

Use the Step 05 collector when available. For `kind=ssh`, the `--api-url` must point at the remote node, and `--comfy-root` / `--venv` are local paths used only for evidence-reading (the tool does not SSH on its own — gather remote evidence via `ssh ... python3 -c "..."` or by reading `/system_stats` over HTTP):

```bash
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step05_environment_readiness.py \
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

1. Clone the public GitHub repository into the custom-node directory
2. Install declared pip dependencies (portable only, skip CUDA-only)
3. Verify registration via `/object_info` after server restart
4. If clone or install fails, document it as a gap — do not hard-stop unless the node is on the critical execution path AND no workaround exists

## Output schema

`repo_commit`, `venv`, `python`, `torch`, `torchvision`, `torchaudio`, `xpu_available`, `ipex`, `driver`, `level_zero`, `launch_command`, `model_paths`, `custom_nodes`, `registration_status`, `api_evidence`, `patches`, `installed_runtime_dependencies`, `skipped_dependencies`, `deferred_dependencies`, `frontend_only_nodes`, `gaps`, `completion_decision`, `step06_context`.

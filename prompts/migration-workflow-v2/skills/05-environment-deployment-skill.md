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
4. Install or symlink custom nodes at recorded commits and record whether they are clean, patched, or dirty.
5. Install dependencies using the source-audit report:
    - install portable import/runtime dependencies needed for target registration
    - include portable runtime dependencies for workflow-selected node classes, even if node registration succeeds without importing them
    - avoid CUDA-only optional accelerators unless explicitly approved
    - record skipped packages, such as `bitsandbytes`, `flash-attn`, `sageattention`, or `onnxruntime-gpu`, and the affected optional paths
6. Configure model roots or symlink staged assets, and retain a source-to-destination mapping. Prefer a separate Step 05 extra-model-paths config over editing the canonical ComfyUI config when running an isolated validation.
7. Apply required registration patches or workflow runtime policies only with explicit approval, and keep them separate from runtime validation claims.
   - **If Step 02 decided `fp8_te_path_chosen: "ops_py_patch"`**, apply `xpu-bug-investigation/0001-xpu-fp8-fallback-dequantize-before-move-to-xpu.patch` to `comfy/ops.py` here (or carry the equivalent change from the upstream ComfyUI fork). Verify with `git diff comfy/ops.py` that `_quantized_apply` now contains the `_is_fp8_quantized_tensor` + `_probe_device` + `dequantize-before-move-to-xpu` block. The patch is the prerequisite for keeping FP8 TEs on XPU without segfault.
   - **If Step 02 decided `fp8_te_path_chosen: "cpu_offload"`**, no `ops.py` patch is needed; the CLIPLoader widget `device=cpu` override is delivered as a runtime-policy JSON patch in Step 08 instead.
   - **If Step 02 decided `fp8_te_checkpoint_stripped: true`**, ensure the stripped `<name>_text_only.safetensors` is the file referenced by the CLIPLoader widget, not the original.
8. Launch with conservative Intel XPU flags.
9. Verify startup and backend node registration through `/system_stats` and `/object_info`.
10. For frontend-only LiteGraph nodes, record source evidence from web extension registration code instead of requiring `/object_info`.
11. Preserve logs and API evidence before moving to prompt validation.
12. Emit a `completion_decision` with checked criteria, evidence artifacts, unresolved gaps, human-gate prompt if any, and `next_step_allowed`.

## Reusable readiness collector

Use the Step 05 collector when available:

```bash
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step05_environment_readiness.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --venv <ComfyUI root>/.venv-xpu \
  --link-staged-custom-nodes \
  --api-url http://127.0.0.1:<port>
```

The tool creates safe custom-node symlinks, writes `05-extra-model-paths.yaml`, collects XPU/venv/API evidence, writes registration/model/dependency ledgers, and generates `05-environment-summary.json` plus `05-output-manifest.json`. It must not overwrite custom-node collisions, install packages, edit source workflow JSON, or apply source patches.

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

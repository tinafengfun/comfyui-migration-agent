# XPU bundle provenance

Single manifest for every custom-node package touched while adopting Intel's `llm-scaler-omni` XPU bundle (source: `omni/docker/Dockerfile` + `Dockerfile-extension` in Intel's `llm-scaler` repo). Purpose: answer "is this old or new, whose patch is this, why does it exist" in one place, rather than reconstructing it from git log across ~23 repos.

All packages below live at `/nfs_share/custom_nodes/<name>` (canonical source, NFS-shared) and are symlinked into `custom_nodes/` on both `local-xpu` and `remote-124-12`. See `docs/gpu-node-setup.md` for the sharing convention and the `runtime=docker` execution model.

ComfyUI core itself is **unpatched upstream** (`comfyanonymous/ComfyUI`) on both this environment and Intel's own bundle — there is no parallel/duplicate core to reconcile, only the custom-node layer below.

## Already patched here before this pass (reconciled against Intel's bundle)

| Package | Our commit | Intel's pin | Patch relationship |
|---|---|---|---|
| `comfyui_controlnet_aux` | `14fa2a9` (base `e8b689a`, matches Intel exactly) | `e8b689a513c3e6b63edc44066560ca5919c0576e` | Our fix is a strict superset of Intel's `comfyui_controlnet_aux_depth_anything_v2_xpu.patch` — same root-cause fix (`DEVICE = next(self.parameters()).device`), plus one extra defensive line at the `infer_image()` call site. No action needed. |
| `ComfyUI-SeedVR2_VideoUpscaler` | `dacc179` (fork `tinafengfun/comfyui_seedvr2`, base `numz@4490bd1`, matches Intel's base exactly) | same base + Intel's own `comfyui_seedvr2_xpu.patch` | Intel's own patch has a real bug: it inserts a second `get_device()` definition in `distributed/basic.py`, which Python silently shadows with the original CUDA-only one — the XPU fix is dead code. We re-derived a correct single-function fix instead. Deliberately **not** using Intel's patch verbatim. |
| `ComfyUI-WanVideoWrapper` | `2a4ccae` (base `df8f3e4`, dated 2026-02-22) | `e091c4a77425d6a4a7f90ab30c513d24f8cb91cf` (dated 2026-02-02 — **older** than ours) | Our fork postdates Intel's pin by ~3 weeks and has newer features (lynx/wananimate/s2v-audio/dual-controlnet) absent from Intel's snapshot. Content-diffed Intel's `extention_comfyui_wanvideowrapper.patch` against ours: same class of device-mismatch fixes (LoRA diff, RMSNorm/FusedRMSNorm/LayerNorm, `get_mod`) already covered. Deliberately **excluded** Intel's block-swap-to-CPU-offload-disable change — trades away a real VRAM-saving feature for an unconfirmed correctness concern against our since-diverged block-swap implementation. Kept newer base, not rebased to Intel's older pin. |
| `ComfyUI-GGUF-XPU` | `4b8a633` | Same repo (`analytics-zoo/ComfyUI-GGUF-XPU`), Intel doesn't pin an exact commit for this one (`git clone --depth 1`, takes HEAD) | Native match, no patch on either side — this is a standalone add-on package (not a patch to base `ComfyUI-GGUF`) providing Triton dequant kernels. |

## Pre-existing, unpatched, consolidated onto the shared tree this pass

These already existed as independent real directories on `local-xpu` at the exact same commit as an already-present shared-NFS copy (used via symlink from `remote-124-12`) — consolidated to symlinks to remove the duplication/drift risk, no content changes beyond the KJNodes fix below.

| Package | Commit | Note |
|---|---|---|
| `ComfyUI-KJNodes` | `38cccdee` → `43df8e6` | Intel's pin (`a41e0d8`) is unpatched and we deliberately did not downgrade to it (see rule in `docs/gpu-node-setup.md`). Recovered a real uncommitted local fix (`nodes/model_optimization_nodes.py`: guard `torch.backends.cuda` access on non-CUDA backends) that existed only on `local-xpu`'s disk, never committed — now committed and propagated to the shared copy. Patch saved at `patches/kjnodes-xpu-fp16-guard.patch`. |
| `ComfyUI_LayerStyle` | `d94bef1` | Exact match to Intel's Dockerfile-extension pin. No patch either side. |
| `ComfyUI-Custom-Scripts` | `609f3afa` | Not referenced by Intel's bundle at all — pre-existing local dependency, left as-is. |
| `rgthree-comfy` | `683836c4` | Not referenced by Intel's bundle at all — pre-existing local dependency, left as-is. |

## New this pass — active set (Intel base Dockerfile)

| Package | Pin | Patch | Notes |
|---|---|---|---|
| `ComfyUI-OmniXPU` | n/a (no upstream repo — Intel ships it as source only) | n/a — it *is* the patch (monkey-patches attention/RoPE/norm/FP8/INT8/interpolate/median at import time) | Copied directly from `llm-scaler/omni/ComfyUI-OmniXPU`, `git init`+commit for provenance, matching Intel's own Dockerfile convention. Runs on its safe PyTorch fallback — `omni_xpu_kernel` (compiled SYCL/CUTLASS) was not built, per explicit decision not to compile kernels ourselves. |
| `comfyui-manager` (ltdrdata/ComfyUI-Manager) | HEAD | none | |
| `raylight` | `c91ef47` | `raylight_for_multi_arc.patch` | **Fixed, functional.** Initially non-functional: depends on `xfuser` (PyPI package name for the xDiT project) + `yunchang` (long-context-attention), whose stock accelerator-detection code recognizes only AMD/NVIDIA/MooreThreads GPUs. Initially conflated with the much heavier `sgl-kernel-xpu` native-kernel build and skipped — **wrong call, corrected**: `xdit_for_multi_arc.patch`/`yunchang_for_multi_arc.patch` are pure Python (no `.cu`/`.cpp`/`setup.py` native-extension changes at all — verified by inspecting both patches directly), so they need the same clone+patch+`pip install -e .` treatment as every other package here, not a from-source kernel compile. Installed `long-context-attention@fc5d55e` (provides `yunchang`) + `xDiT@fb8fb0e` (provides `xfuser`) as editable installs in `lib/`, uninstalling the stock PyPI `xfuser`/`yunchang` first. This closed the accelerator-detection crash, but surfaced a second, unrelated bug: `raylight`'s own `_resolve_repo_root()` locates ComfyUI's root by `Path(__file__).resolve()` + walking up parent directories looking for `main.py`+`execution.py` — `.resolve()` follows symlinks, and since `raylight` is installed as a symlink into `custom_nodes/` (this project's standard shared-node convention), the resolved path never has ComfyUI's root in its ancestry. Fixed with `patches/raylight-comfyui-root-via-folder-paths.patch`: use `folder_paths.base_path` (ComfyUI's own already-computed root) instead, falling back to the original parent-walk for non-symlinked installs. Confirmed live: `raylight` no longer appears in `IMPORT FAILED` after both fixes. |
| `ComfyUI-CacheDiT` (Jasonzzt) | HEAD | none | |
| `nunchaku-torch` (runtime lib, not a ComfyUI node — lives at `lib/nunchaku-torch` on the shared share) | `e09fae78` | none (already XPU-native) | SVDQuant W4A4/W4A16 backend for the node package below. **Installed editable (`pip install -e`)** — this hardcodes the absolute source path into the venv at install time. Confirmed live: migrating the shared share to a new path (`/home/intel/hf_models/zimage_workflow/lib/...` → `/nfs_share/lib/...`) broke it with `ModuleNotFoundError: No module named 'nunchaku_torch'` even though the venv itself moved correctly — fixed by re-running the editable install against the new path. Any future path migration must remember to redo this step; a non-editable install wouldn't have this problem but would need a manual reinstall on every source change instead. |
| `long-context-attention` (runtime lib, provides the `yunchang` package — lives at `lib/long-context-attention`) | `fc5d55e` | `yunchang_for_multi_arc.patch` | Pure-Python patch: replaces the CUDA-only ATen flash-attention op with the backend-agnostic `torch.nn.functional.scaled_dot_product_attention`. Installed editable, `--no-deps`, after uninstalling the stock PyPI `yunchang`. Exists to unblock `raylight` (below) — see that entry for the full story. |
| `xDiT` (runtime lib, provides the `xfuser` package — lives at `lib/xDiT`) | `fb8fb0e` | `xdit_for_multi_arc.patch` | Pure-Python patch: adds an `_is_xpu()` check to `xfuser/envs.py`'s accelerator detection (previously AMD/NVIDIA/MooreThreads-only) and forces the `xccl` distributed backend. Installed editable, `--no-deps`, after uninstalling the stock PyPI `xfuser`. Exists to unblock `raylight` (below). |
| `ComfyUI-nunchaku-XPU` | `55b6497e` | none | Depends on `nunchaku-torch` + `kernels==0.14.0` (pinned exactly, newer `kernels` versions get pulled in transitively by other packages — reinstalled to the pin after the bulk pass). |
| `ComfyUI-VideoHelperSuite`, `ComfyUI-Easy-Use` | already present pre-pass | — | Already installed independently before this work; left untouched, Intel's Dockerfile just clones these plain too (no version drift check performed). |

**Explicitly skipped this pass:** `ComfyUI_SGLDiffusion` + its `sglang` dependency. Originally also true of `sgl-kernel-xpu`/`xfuser`/`long-context-attention` when the Docker base was `intel/llm-scaler-vllm:1.4` (confirmed absent there) — but the base image is now `intel/llm-scaler-omni:0.1.0-b7`, which genuinely ships working `sgl-kernel-xpu` and a real `/llm/sglang` (see `docs/gpu-node-setup.md`'s Docker-runtime section). `ComfyUI_SGLDiffusion` itself still isn't installed as one of our copied-in packages — revisit adding it as a 24th package now that the underlying compiled stack is confirmed present, rather than treating it as blocked on a from-source kernel build.

## New this pass — disabled-by-default set

ComfyUI itself skips any `custom_nodes/` directory whose name ends in `.disabled` (confirmed in `nodes.py`) — this is a real mechanism, not just a naming convention. Matching Intel's own choice of what's off by default.

| Package | Pin | Patch | Notes |
|---|---|---|---|
| `comfyui-voxcpm.disabled` | `7875a8a` | `comfyui_voxcpm_for_xpu.patch` | |
| `ComfyUI_IndexTTS.disabled` | HEAD (Intel doesn't pin a commit) | `comfyui_indextts.patch` | Needs `torchcodec==0.9.0`. |
| `ComfyUI-Hunyuan3d-2-1.disabled` | `9d7ef325` | `comfyui_hunyuan3d_for_xpu.patch` | Python deps installed; native `custom_rasterizer`/`DifferentiableRenderer` extension builds (`setup.py install`) **not attempted** — deferred, same rationale as the SGLDiffusion skip. |
| `ComfyUI-HY-Motion1.disabled` | `47b1d0d9` | `comfyui_hy_motion1.patch` | |
| `ComfyUI-FlashVSR_Ultra_Fast.disabled` | `4820b3f0` | `comfyui_flashvsr_ultra_fast_xpu.patch` | |

`ComfyUI-SeedVR2_VideoUpscaler` is **not** duplicated here — we already have our own actively-patched fork (see above table); Intel's Dockerfile installs a separate `.disabled`-suffixed copy of the same base commit with their own (buggy) patch, which we don't need.

## New this pass — Dockerfile-extension set

| Package | Pin | Patch | Notes |
|---|---|---|---|
| `ComfyUI_LayerStyle_Advance` | `7b678b40` | `comfyui-layerstyle_advance-add-intel-xpu-support-for-joy-caption-beta1.patch` | |
| `comfyui-mixlab-nodes` | already present as `.disabled` pre-pass | — | Intel's Dockerfile installs this **active** (no `.disabled` suffix, no patch). This environment already had it disabled locally for an unknown reason predating this work — left as-is rather than silently re-enabling; flag for follow-up if mixlab nodes are ever needed. |
| `comfyui-art-venture` | `210dc072` | `art-venture-resize-mask-to-match-image-spatial-size.patch` | Previously ruled out in an earlier session pass as "not relevant" before this bundle survey — reconsidered and installed since Intel's own bundle includes it. |
| `comfyui-florence2` (kijai/ComfyUI-Florence2) | `9ece3de9` | `extention_comfyui_florence2.patch` | |
| `comfyui-segment-anything-2` (kijai) | `0c35fff5` | `extension_comfyui_segment_anything_2.patch` | |
| `comfyui-reactor` (Gourieff/ComfyUI-ReActor) | `6ad6b35a` | `extension_comfyui_reactor.patch` | Patch correctly specifies `onnxruntime-openvino`, not GPU/CUDA. |
| `ComfyUI-RMBG` | `d7402513` | `extension_comfyui_rmbg.patch` | **Real bug found and fixed**: this package's own `requirements.txt` (Intel-patched) lists both `onnxruntime>=1.15.0` and `onnxruntime-gpu>=1.15.0`. Both distributions install into the same `onnxruntime` import namespace; the CUDA-only GPU build ends up winning and breaks with `libcudart.so.13: cannot open shared object file` on this CUDA-less XPU host — this also silently broke `comfyui-reactor`'s correctly-specified `onnxruntime-openvino`, since they share one venv. Fixed by uninstalling both `onnxruntime`/`onnxruntime-gpu` and reinstalling `onnxruntime-openvino` last. If re-running the bulk install from scratch, install `ComfyUI-RMBG`'s requirements *before* anything needing a clean `onnxruntime`, or scrub its `onnxruntime-gpu` line first. |
| `ComfyUI_SenseNova_U1` | `6ad02b24` | `extension_SenseNova-U1.patch` | |
| `comfyui-advancedliveportrait` | `64bc23a0` | `extension_comfyui-advancedliveportrait.patch` | Has an unrelated pre-existing bug in the *upstream* package itself (not Intel's patch, not ours): `nodes.py` does `os.mkdir(exp_data_dir)` assuming `outputs/` already exists, which fails on a fresh container copy-in. Not patched (third-party code); mitigated operationally — see `docs/gpu-node-setup.md`'s Docker-runtime section (pre-create `outputs/`/`input/` before the real `docker start`). |

## Pre-existing issues unrelated to this pass (do not chase)

Observed during container smoke-testing but not caused by, or in scope for, this bundle adoption:
- `comfyui-vrgamedevgirl`: import fails because its symlink target lives under a per-task workspace cache directory (`agent-demo/workspaces/.../cache/custom_nodes/...`) that's correctly excluded from the container copy-in — this is a stale, task-scoped artifact, not a real installed package.
- `ComfyUI_Qwen3-VL-Instruct`: missing `qwen_vl_utils` — pre-existing gap, unrelated to XPU/this bundle.
- The base `ComfyUI-GGUF` package's `AILab_QwenVL_GGUF_PromptEnhancer` node: missing `llama_cpp` — pre-existing gap.

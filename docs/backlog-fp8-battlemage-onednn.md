# Backlog: fp8 GEMM broken on Battlemage (oneDNN 3.7.1) → blank Flux renders

Status: **OPEN** — diagnosed 2026-09-04, fix not yet applied.
Owner: (unassigned)
Severity: HIGH for fp8 diffusion on Battlemage nodes; **does NOT affect node localization** (validated) or bf16 rendering.

## Symptom

On **remote-124-12** (`intel@172.16.124.12`), rendering fp8 diffusion models (Flux.2 Klein 9B fp8)
produces **blank / muddy uniform-color panels**. The sampler completes all steps, but the ComfyUI
log spews (~1380× per 4-panel render):

```
onednn_verbose,v1,primitive,error,gpu,jit::gemm,Insufficient registers in requested bundle,
  src/gpu/intel/jit/gemm/gen_gemm_kernel.cpp:1005
```

The fp8 GEMMs return garbage → near-zero latents → blank after VAE decode. VLM text (llama.cpp SYCL)
is unaffected (correct). First observed during the Step-03b node-localization live validation
(Story generation v2), which otherwise passed 00→12 offline. See memory `fp8_gemm_onednn_register_fail`.

## Root cause (evidence-pinned)

| Component | Version on node | Verdict |
|---|---|---|
| GPU | Intel `[8086:e223]` — **Battlemage (Xe2)** discrete | 2025 arch |
| compute-runtime (NEO) | 25.48.36300.8 | recent — OK |
| IGC | 2.24.8 | recent — OK |
| level-zero | 1.26.2 / driver 20.2.0 | recent — OK |
| torch | **2.10.0+xpu** (both py3.12 and py3.13 resolve this) | bundles the problem |
| **oneDNN (MKL-DNN)** | **v3.7.1** (git 8d263e6) | ⚠️ early/incomplete Xe2 fp8 matmul |

Driver stack is current and supports the GPU (device enumerates, VLMs run, bf16 works). The failure
is inside **oneDNN 3.7.1's nGEN GEMM kernel generator** for fp8 `e4m3fn` on Xe2 GRF. All fp8 paths
inherit it: OmniXPU `onednn_w8a16_fp8` (oneDNN W8A16), comfy_kitchen `eager` (emulates fp8 via oneDNN).
comfy_kitchen's `triton` backend has no fp8 linear, so enabling it doesn't help.

## Tried & FAILED

- `IGC_ForceGRFMode=2` + `NEOReadDebugKeys=1` (force 256-GRF large mode) — register errors persisted
  (1380 again). Reason: oneDNN GEMM uses its **own nGEN ISA emitter, not IGC**, so IGC/SYCL GRF env
  can't reach it. (2026-09-04, 2nd ComfyUI on :8199.)

## Fix options

1. **Durable — image rebuild** (`intel/llm-scaler-omni:0.1.0-b7` → new tag):
   - Upgrade **torch-xpu** to a build bundling **oneDNN ≥3.8** (Xe2 fp8 matmul hardened). oneDNN is
     statically bundled in the torch-xpu wheel — can't swap independently.
   - Needs the proxy (`proxy.ims.intel.com:911`) to fetch the wheel; node is offline and **no newer
     torch-xpu is staged** (the `torch-2.13.0.dist-info` in venv-container-xpu is stale — actual
     import is 2.10.0+xpu).
   - **ABI break:** OmniXPU native `_C.cpython-312` is built against torch 2.10 → must **recompile
     `omni_xpu_kernel`** (and any other compiled custom-node ext) against the new torch; re-verify
     comfy_kitchen 0.2.28 + custom nodes.
2. **Stopgap — bf16:** disable `OMNI_FP8_KEEP_ON_MOVE` so fp8 dequantizes → routes through working
   bf16 GEMM. Correct output, higher VRAM (may need `--lowvram`). Contrast w/ memory `xpu_fp8_oom_fix`
   (keep-on-move to SAVE memory) which assumes fp8 GEMM works — it doesn't on this GPU.

## Next cheap step (in progress 2026-09-04)

Before committing to the image rebuild, **prove the hypothesis cheaply**: scratch venv w/ torch
2.12+/2.13 `+xpu` (oneDNN ≥3.8) via proxy, run a single fp8 `e4m3fn` GEMM at Flux shapes
(`M=K=4096, N=16384`) on this GPU via `torch._scaled_mm`. If the register error disappears → image
rebuild is worth it. If not → fp8 on Battlemage needs a deeper oneDNN fix / different approach.

## Also parked (node-localization Phase 1, separate)

Deferred per PRD `docs/prd/api-node-local-substitution.md`: catalog-backed API classifier + Step-00
detection; modality matrix (LLM/TTS); real audio→ASR; `api_no_local_equivalent` boundary report.

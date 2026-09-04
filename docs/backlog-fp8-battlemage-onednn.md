# Backlog: Flux.2-Klein blank render — SOLVED (bad fp8 mirror model)

Status: **SOLVED 2026-09-04.** Root cause = **the fp8 mirror UNet
`flux-2-klein-base-9b-fp8.safetensors` (wissxi mirror) is bad** — it produces a constant latent →
uniform brown, on ANY hardware/image. **Fix: use the full-precision `flux-2-klein-9b.safetensors`
(18 GB, already on `/nfs_share/models/diffusion_models`) + `flux2-vae.safetensors`.** Verified: renders
a correct photorealistic image on the Battlemage XPU (llm-scaler-omni 0.2.0-b1, but image-independent).

The whole "fp8 GEMM / oneDNN / XPU / comfy_kitchen forward" investigation below was chasing a red
herring — none of those were the cause. The fork renders Flux.2 Klein fine (prior good outputs exist,
and the full model renders perfectly). Trace-back: Step-02 decision **D4** accepted the mirror-staged
UNet because the official BFL repo was gated; that mirror model is defective. **Lesson for the agent:
a mirror/quantized model that loads with healthy-looking weights can still be functionally dead —
validate that a render is non-degenerate, or prefer the full/official checkpoint when both are staged.**

### Original (now-superseded) framing:
Status: OPEN — diagnosed 2026-09-04, fix not yet applied.
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

## CORRECTION (2026-09-04, after verbose capture) — register error is a RED HERRING

`ONEDNN_VERBOSE=1` capture during Flux sampling shows the `Insufficient registers in requested
bundle` errors are **non-fatal**: each is immediately followed by a successful `exec` of that same
GEMM (oneDNN tries one kernel strategy, it overflows GRF, logs the error, **falls back to a working
kernel and executes** with a real timing). The GEMMs complete correctly.

Moreover the failing GEMMs are **bf16 text-stream** projections at **M=1106** (the tokenized text
conditioning length), NOT fp8:
```
1106x4096:4096x24576   (bf16)   1106x12288:12288x4096 (bf16)   1x1106x4096:1x4096x4096 (bf16 attn)
```
The **fp8 GEMMs run clean** (`4096x4096:4096x4096`, `4096x12288:12288x2048`, wei:f8_e4m3). So:
- fp8 on this Battlemage GPU is actually FINE (the earlier "oneDNN 3.7.1 too old" and "N>4096
  refusal" theories do NOT explain the blank panels).
- The N-tiling patch to `patch_fp8_gemm.py` was correct behavior but **did not fix the blank render**
  (reg errors only 1380→1080, and those remaining are the non-fatal bf16 ones). Patch was REVERTED
  on the node.

**Real open question — why blank:** M=1106 means the local Qwen VLM emits **verbose multi-paragraph
story scripts** (~1106 tokens) as the Flux prompt, vs GeminiNode's concise per-panel prompts.
Leading hypotheses (unconfirmed): (a) over-long/rambling conditioning → degenerate denoising;
(b) OmniXPU fp8 weight-scale handling; (c) the distilled `full_encoder_small_decoder` VAE.
**Decisive next test:** render one panel with a SHORT hardcoded prompt (bypass VLM). Clean image →
it's VLM verbosity (fix = tune the substitution recipe `system_prompt` to force concise prompts, or
cap tokens). Still blank → fp8-scale or VAE.

## RESOLVED DIRECTION (2026-09-04) — blank render is a Flux.2-Klein model/ComfyUI issue, NOT fp8/XPU

Systematic bisection (all on remote-124-12, short concise prompt to remove VLM verbosity):

| Suspect | Test | Result |
|---|---|---|
| VLM verbose prompt | hardcoded "red apple…" prompt | ❌ still blank |
| fp8 / oneDNN / XPU precision | **CPU (`--cpu`) render** | ❌ **still blank** → hardware-independent |
| "Insufficient registers" errors | ONEDNN_VERBOSE capture | ❌ **non-fatal** — each GEMM re-execs on a fallback kernel; failing ones are **bf16 text-stream** (M=1106), not fp8; fp8 GEMMs run clean |
| VAE decoder | encode→decode a real colorful image | ✅ **round-trips perfectly** — VAE fine |
| checkpoint key mismatch | model-load diagnostics | ✅ all UNet keys load (only text-enc `lm_head` missing, expected) |
| guidance/CFG config | cfg=5 → cfg=1 render | ❌ still blank |

**Conclusion:** the UNet yields a **constant latent** (→ uniform mid-brown after VAE) on **CPU and XPU
alike**, with every model loading and the VAE working. So fp8/XPU/oneDNN is fully exonerated (the whole
"upgrade oneDNN 3.7.1 / rebuild image" thread is MOOT — fp8 GEMM is fine here). The fault is a
**hardware-independent Flux.2-Klein render problem** in this ComfyUI/comfy_kitchen build.

**Leading hypothesis:** the models are **custom-fp8-quantized** (`_quantization_metadata format_version
1.0`, per-layer float8_e4m3fn) — both `flux-2-klein-base-9b-fp8` and `qwen_3_8b_fp8mixed`. This
ComfyUI/comfy_kitchen build likely **mishandles that quant format** → the text encoder emits ~zero
embeddings and/or the UNet emits ~constant output → unconditional mean image (constant regardless of
prompt/seed/cfg is consistent with dead conditioning).

**Next steps if pursued (all orthogonal to the migration + to node localization, which is VALIDATED):**
1. Confirm dead conditioning: encode two very different prompts, diff the CLIP embeddings (non-zero? prompt-dependent?).
2. Test the model in a reference upstream ComfyUI with official Flux.2 support, or with a **non-quantized (bf16)** Flux.2 Klein checkpoint.
3. Check comfy_kitchen's handling of the `_quantization_metadata` custom fp8 format vs what this checkpoint carries.

## EXHAUSTIVE BISECTION (2026-09-04, round 2) — isolated to the ComfyUI-fork/comfy_kitchen Flux.2 forward

Direct component probes (via `docker exec` python, CPU, real model files) — every input to the forward
is HEALTHY, yet the forward output is degenerate:

| Component | Direct probe | Result |
|---|---|---|
| Text conditioning | encode 2 very different prompts, diff embeddings | ✅ alive: shape (1,512,12288), non-zero, 62% rel-diff between prompts |
| VAE | encode→decode a colorful image | ✅ round-trips faithfully |
| UNet weights | load model, inspect dequantized weights | ✅ float32, healthy magnitudes (absmean 0.008–0.02, norms ~0.95) |
| Model config | inspect detected params | ✅ **`model_config: Flux2`**, 4-axis RoPE [32,32,32,32], theta 2000, 8 double + 24 single blocks, guidance_embed=False — correct Flux.2 |
| OmniXPU patches (rope/attn/fp8) | **disable custom node, re-render** | ❌ still blank → not OmniXPU |
| CFG/guidance | cfg 5→1 | ❌ still blank |

**Definitive conclusion:** the blank/constant render is a **hardware-independent forward-computation bug
in this ComfyUI fork** (Intel `llm-scaler-omni:0.1.0-b7`, comfy_kitchen 0.2.28) for **Flux.2 Klein**.
Every input is provably correct; the UNet forward still yields a constant latent, on CPU and XPU, with
OmniXPU on OR off. The only remaining layer is comfy_kitchen's core ops / the fork's Flux.2 model code.
This is NOT: node localization, fp8, the XPU, oneDNN, the VAE, the conditioning, the weights, or the config.

**Resolution paths (all heavy / owned outside this repo):**
1. **Reference render** — run this exact model+workflow in a **vanilla upstream ComfyUI** with official
   Flux.2 support (separate venv, same `/nfs_share` models). Correct there ⇒ confirms the Intel-fork bug.
2. **Report to Intel** (llm-scaler-omni) — the b7 image's ComfyUI/comfy_kitchen renders Flux.2 Klein as a
   constant image; needs a fork fix.
3. **Use a different ComfyUI core** for Flux.2 workflows (the agent supports multiple cores) once one is
   confirmed to render Flux.2 correctly.

Node localization (Phase 0) is DELIVERED + VALIDATED regardless — see [[node_localization_step03b]] /
`docs/prd/api-node-local-substitution.md`.

## (superseded) earlier cheap step

Before committing to the image rebuild, **prove the hypothesis cheaply**: scratch venv w/ torch
2.12+/2.13 `+xpu` (oneDNN ≥3.8) via proxy, run a single fp8 `e4m3fn` GEMM at Flux shapes
(`M=K=4096, N=16384`) on this GPU via `torch._scaled_mm`. If the register error disappears → image
rebuild is worth it. If not → fp8 on Battlemage needs a deeper oneDNN fix / different approach.

## Also parked (node-localization Phase 1, separate)

Deferred per PRD `docs/prd/api-node-local-substitution.md`: catalog-backed API classifier + Step-00
detection; modality matrix (LLM/TTS); real audio→ASR; `api_no_local_equivalent` boundary report.

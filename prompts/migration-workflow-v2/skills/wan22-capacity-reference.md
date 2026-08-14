# WAN2.2 (T2V/I2V) capacity reference

Field-tested VRAM/capacity knowledge for WAN2.2-class video workflows on a single 32 GB Intel XPU (task 075f6823, a `Video_Edit_Multimodal_Generator` with a Qwen VLM front-end). Read this alongside [capacity-vram-mitigation-ladder](capacity-vram-mitigation-ladder.md) and [xpu-attention-fallback](xpu-attention-fallback.md).

## Model & VRAM budget (why offload is mandatory, not optional)

A WAN2.2 A14B T2V graph loads, on a 32 GB card:

| Model | dtype | Size | Device | Resident when |
|---|---|---|---|---|
| WAN2.2 diffusion **HIGH** (e.g. `Bernini_HIGH`) | fp8_e4m3fn | **~15 GB** | XPU | high-noise steps |
| WAN2.2 diffusion **LOW** (e.g. `Bernini_LOW`) | fp8_e4m3fn | **~15 GB** | XPU | low-noise steps |
| Text encoder **UMT5-XXL** | fp8 | **~6.3 GB** | XPU | text-encode only |
| VAE (`wan_2.1_vae`) | fp16 | ~0.24 GB | XPU | decode only |
| lightx2v 4-step LoRA ×2 | — | ~1.2 GB ea | XPU | patches diffusion |
| **VLM (Qwen* via `llama_cpp*`)** | GGUF Q4/Q8 | ~16 GB | **CPU / host RAM** | image→text (never XPU) |

Two 15 GB diffusion models + a 6.3 GB TE ≈ **39 GB of weights alone > 32 GB**. So **offload is mandatory** for WAN2.2 — plain `--reserve-vram 1` (keep-resident) OOMs instantly. WAN2.2 uses HIGH then LOW *sequentially*, so with offload only one 15 GB model is resident at a time. The VLM is CPU-only (an inherent multi-minute cost, unrelated to XPU VRAM).

## Two INDEPENDENT OOM drivers — you must address both

1. **Weights (~30 GB dual diffusion models)** → fixed by **offload** (`--lowvram` sequential swap, or `--novram` maximal, or WanVideoWrapper `block_swap`).
2. **Activations (attention)** → driven by the attention token count `seq`, NOT by the model. Fixed by **reducing `seq`** (resolution and/or frames) or memory-efficient/tiled attention.

Neither alone is enough: offload without seq-reduction still peaks near the ceiling; seq-reduction without offload still can't fit 30 GB of weights.

## Frames drive `seq` more than resolution (the key, non-obvious finding)

`seq ≈ temporal_tokens × spatial_tokens`. In practice the **frame count dominates** and resolution can saturate:

- `ref_max_size=640, length=40` → **seq ≈ 73 K** → fits `--lowvram` (~29 GB peak).
- `ref_max_size=1280, length=81` → **seq ≈ 155 K** → OOM on `--lowvram`; needs `--novram`.
- Holding `length=40`, sweeping `ref_max_size` 640→1024 barely moved the peak (~29 GB) — resolution was nearly free in that band.

So when reducing: **cut frames first** (`length` / `frame_load_cap` / `num_frames`), then resolution. The real spatial driver in ref-resize pipelines is **`ref_max_size` / `max_size`**, not `width`/`height` (reducing width/height alone left `seq` unchanged).

**Hard model limit: WAN2.2 only generates clips of ≤ ~5 seconds.** So every frame-count input in the reduced config must map to ≤ 5 s of video (at the base 16 fps that's ~80 frames; the workflow's `length=81` is exactly the 5 s ceiling). `compute_reduced_changes` halves frame inputs for VRAM **and** clamps them to the 5 s frame budget (`round(5 × fps)`, fps discovered from `fps`/`frame_rate`/`force_rate` inputs, default 16) — a reduced config longer than 5 s is not a valid WAN2.2 config and just inflates the token count.

## Offload does NOT fix the activation overflow

`--lowvram`/`--novram`/`block_swap` relocate **weights only** — never in-flight activations. At large `seq` the OmniXPU ESIMD attention kernel hits **FP16 overflow → falls back to SDPA** (`[OmniXPU] FP16 overflow in ESIMD, falling back to SDPA`); the run survives but slower. Offload helps *indirectly* (freeing weight VRAM leaves room for a bigger activation peak) but cannot fix the numeric overflow. The overflow itself is only removed by: reducing `seq`, forcing SDPA/flash or fp32 attention accumulation, or tiled attention/VAE. See [xpu-attention-fallback](xpu-attention-fallback.md).

## Best-known config (BKC)

- **Balanced (recommended): reduced frames (`length≈40`) + `--reserve-vram 1 --lowvram`.** Fits ~29 GB, faster than `--novram`. Resolution can stay high (`ref_max_size` up to ~1024) nearly for free.
- **Full frames / full res → `--reserve-vram 1 --novram`** (maximal offload). Fits (~29.5 GB) but slow and near-ceiling with FP16 fallback — fragile on a degraded driver.
- Keep the **4-step lightx2v LoRA** (only ~4 sampler steps — big speed win) and **fp8 keep-on-move** (`OMNI_FP8_KEEP_ON_MOVE=1`).

## Official WAN2.2 resolutions

WAN2.2 A14B is trained for **480P** (`832×480` / `480×832`) and **720P** (`1280×720` / `720×1280`). Dimensions must be **divisible by 16** (Wan2.1 VAE 8× + patch 2×). Off-bucket sizes run but may degrade quality; a non-÷16 dimension (e.g. 860) is auto-rounded.

## Step 07/08/12 workflow implications

- **Step 07/08** classify full-size capacity from a probe. When the tier is `tight`/`reduced`/`insufficient`, a **reduced-validation probe RUNS the reduced config once** to confirm it clears OOM before Step 12 commits to it (`reduced_validation.validated`). Frame reduction is the highest-leverage change.
- The proven flags + validated reduced setting are hardened into `effective-run-config.json` (`vram_flags`, `recommended_reduced_setting`) and **Step 12 relaunches at exactly those** — the previous step's BKC must not drift (e.g. lowvram→novram) between steps.
- A degraded `xe` driver (`VM worker error -12`, engine resets) causes intermittent `DEVICE_LOST` (error 20 ≠ OOM error 39) even on a config that fit minutes earlier — reset with `xpu-smi config -d 0 --reset` (stop the container first), not a config change.

# Capacity / VRAM mitigation ladder

When a step hits an XPU capacity OOM (`out_of_device_memory` / `device_lost` / `out_of_resources` / `could not create a primitive` / `xe VM worker error -12`), mitigations are applied in a **fixed order**: lossless first (automatic, system-driven), then the lossy reduced tier (operator decision). This exists so the system exhausts every quality-preserving option before ever downgrading the delivered output.

## Lossless rungs (identical output, only slower) — applied AUTOMATICALLY by the orchestrator

These change model *placement/scheduling*, never the computation, so the generated result is byte-for-byte the same tier — just slower. The orchestrator's capacity-retry ladder (`orchestrator.ts` + `comfyuiLifecycle.VRAM_ESCALATION_LADDER`) relaunches ComfyUI and re-runs Step 07/08 through these on a capacity OOM, **before** any human gate:

1. **fp8 keep-on-move** (`OMNI_FP8_KEEP_ON_MOVE=1`, always on) — fp8 tensors move XPU↔CPU without a bf16 upcast.
2. **`--lowvram`** (ladder level 1) — sequential model load + offload-after-use; frees resident weights so the active forward fits.
3. **`--novram`** (ladder level 2) — maximal offload; every model streamed on demand. Slowest, most headroom.

Also lossless, applied at the prompt/launch layer (not part of the auto-ladder, but valid):
- **VAE tiling** — ComfyUI auto-tiles the decode if a full decode would OOM (do NOT pass `--cpu-vae`; CPU VAE is slow and rarely the peak).
- **Pin CLIP / VLM text-encoder to CPU** — frees a few GB during the diffusion forward (the VLM `llama_cpp*` is already `force_offload=True`).
- **`--reserve-vram N`** — headroom against allocator fragmentation.

## Then the LOSSY decision (operator gate) — reduced tier

If the lossless ladder is **exhausted** and it still OOMs, full size does not fit on this GPU. Step 08 presents the operator the capacity decision panel (`pauseIfStep08CapacityGate`): **reduced tier** (halve spatial dims and/or frames, e.g. 720×1280×81 → 480×832×49) / **hardware escalation** (larger / multi-GPU node) / **hard stop**. Reducing resolution/frames changes the output, so it is never applied automatically — it is the operator's call.

## Not a rung

- **Block-swapping the primary model's bulk weights** is a **hard-stop signal**, not a mitigation — even if the run completes (it is impractically slow; the LongCat-Avatar-15 lesson). Small targeted offload (VAE / text-encoder / a few edge blocks) is fine.
- **Reducing sampler steps** does NOT reduce peak VRAM (peak is per-forward, step-count-independent) — it only saves time, not memory.

## Relationship to the "don't loop lowvram" rule

Older guidance said "do not retry generic lowvram knobs indefinitely." That still holds for **hand-improvised, open-ended** retries. The system now applies a **bounded ladder of distinct rungs, each tried exactly once** (level 1 → level 2 → gate). The SDK agent must NOT hand-toggle lowvram/reserve-vram itself — the orchestrator owns the ladder deterministically; the agent just writes its step summary and lets the system escalate or gate.

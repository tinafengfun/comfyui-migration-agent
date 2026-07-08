---
skillId: fp8-feasibility-checklist
version: 1.0.0
tier: on-demand
trigger:
  stepId: "02"
  condition:
    anyOf:
      - modelPattern: "*fp8*.safetensors"
      - modelPattern: "*fp8*.gguf"
      - modelPattern: "*_scaled.safetensors"
provenance:
  taskOrigin: "7f5cf9e4-1d1d-4429-8017-12c33b273f08"
  evidenceArtifact: "02-feasibility.md"
  createdAt: "2026-06-25"
  approvedBy: "tinafengfun"
retireCondition:
  envGte:
    comfy_kitchen: "0.3.0"
  reason: "QTensor.clone() segfault fixed upstream; FP8 loads cleanly on XPU."
---

## FP8 feasibility checklist

When the source workflow contains FP8-quantized models on Intel XPU, verify all of the following before routing to migration:

1. **Segfault risk**: `comfy_kitchen QTensor.clone()` segfaults on `.to('xpu')` for FP8 text encoders. The recipe `CLIPLoader-qwen-fp8` has the dequant-before-move patch. Confirm the patch is applicable before claiming feasibility.
2. **VRAM headroom**: FP8→bf16 dequant roughly doubles activation memory. Estimate: `model_size_bytes * 2` for the dequantized text encoder. If the target XPU has <2x the FP8 model size in free VRAM, route to CPU offload instead.
3. **Multi-node interaction**: If the FP8 model feeds into attention/processor nodes, check whether the processor accepts bf16 input downstream. Some processors hardcode dtype assumptions.
4. **Prompt-level gate**: In the feasibility report, add an explicit `fp8_risk: blocker | degrade | clear` field. `blocker` = no viable XPU path without patch + insufficient VRAM for dequant. `degrade` = patch needed but VRAM is sufficient. `clear` = patch already applied upstream.
5. **Recipe coverage**: The recipe library handles `CLIPLoader + qwen_*_vl_*_fp8*.safetensors`. If the FP8 model is on a different loader (e.g. `CheckpointLoaderSimple`), there may not be a recipe yet — flag as `data_gap` in the feasibility report.

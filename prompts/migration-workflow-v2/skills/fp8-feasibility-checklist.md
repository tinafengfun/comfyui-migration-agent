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

0. **PREFER native fp8 keep-on-move (Path C)**: If the target can run `comfy_kitchen ≥ 0.2.28`, the winning path is native fp8 kept on device moves — upgrade comfy_kitchen, apply `patches/xpu-fp8-keep-quantized-on-move.patch`, launch with `OMNI_FP8_KEEP_ON_MOVE=1`, and run heavy aux models sequentially on XPU (VLM `force_offload=True`, CLIP `device=default`, VAE on XPU). This does **not** double memory, so the VRAM math in point 2 does not apply — recipe `CLIPLoader-qwen-fp8` (v2) carries this. Only fall back to the dequant-patch / CPU-offload paths when comfy_kitchen ≥ 0.2.28 is unavailable.
1. **Segfault risk (only if Path C unavailable)**: `comfy_kitchen QTensor.clone()` segfaults on `.to('xpu')` for FP8 weights on comfy_kitchen ≤ 0.2.8. If stuck below 0.2.28, use the legacy dequant-before-move patch. Confirm applicability before claiming feasibility.
2. **VRAM headroom (legacy paths only)**: FP8→bf16 dequant roughly doubles weight memory. Under Path C there is no dequant — compute capacity with the native fp8 footprint and a *single* resident heavy model (aux offloaded), not `size * 2`.
3. **Multi-node interaction**: If the FP8 model feeds into attention/processor nodes, check whether the processor accepts the model dtype downstream. Some processors hardcode dtype assumptions.
4. **Prompt-level gate**: In the feasibility report, add an explicit `fp8_risk: blocker | degrade | clear` field. With Path C available, a workflow that would be `blocker` under the bf16-doubling math is typically `clear` or `degrade` — do not mark `blocker` for capacity until Path C has been evaluated.
5. **Recipe coverage**: The recipe library handles `CLIPLoader + *fp8*.safetensors` (recipe `CLIPLoader-qwen-fp8` v2, keep-on-move). The runtime placement (CLIP device=default, UNet weight_dtype=default, VLM force_offload) is enforced deterministically by the Step-06 runtime-policy variant. If the FP8 model is on a loader with no recipe, flag as `data_gap`.

---
skillId: xpu-attention-fallback
version: 1.0.0
tier: on-demand
trigger:
  stepId: "04"
  condition:
    anyOf:
      - nodeType: "AIO_Preprocessor"
      - nodeType: "Depth_Anything_Preprocessor"
      - nodeType: "Depth_Anything_V2_Preprocessor"
      - nodeType: "Zoe_Depth_Anything_Preprocessor"
      - nodeType: "PatchSageAttentionKJ"
provenance:
  taskOrigin: "manual"
  createdAt: "2026-06-25"
  approvedBy: "tinafengfun"
---

## XPU attention/preprocessor fallback

When the source workflow contains attention-based preprocessors (`AIO_Preprocessor`, `Depth_Anything_Preprocessor`, `Depth_Anything_V2_Preprocessor`, `Zoe_Depth_Anything_Preprocessor`), these nodes may fail on Intel XPU due to missing attention operator implementations.

Note: `Depth_Anything_V2_Preprocessor` (comfyui_controlnet_aux) also had a separate, simpler bug — its internal device detection hardcoded `cuda`/`mps`/`cpu` with no XPU branch, defaulting to CPU regardless of this attention concern. See the `comfyui_controlnet_aux-depth-anything-v2-xpu-device` recipe for that fix; it's independent of the attention-operator fallback below.

1. **Operator check**: These processors often use `scaled_dot_product_attention` or flash attention, which may not be dispatched to the XPU backend on current `torch_xpu` builds. Check `torch.xpu.is_available()` and whether the attention kernel is registered.
2. **Fallback policy**: If the operator is missing, route these nodes to CPU via `device=cpu` runtime policy. The quality impact is zero for deterministic preprocessors (depth, canny); only latency increases.
3. **Provider hint**: Some processors accept a `provider` argument. Try `provider=openvino` as an alternative dispatch path if available — OpenVINO has better attention coverage for Intel hardware.
4. **Source-audit annotation**: In `04-source-audit.md`, mark each affected node with `xpu_attention_risk: yes` and the fallback strategy chosen. This carries forward to step 05 deployment and step 07 smoke validation.
5. **PatchSageAttentionKJ special case**: If the source workflow contains a `PatchSageAttentionKJ` node, the `auto` mode uses `q.is_cuda` internally and will `assert`-crash on XPU. Flag it as `CUDA-only auto mode: requires disabled on XPU` in the source-audit annotation, so Step 06 knows to emit `sage_attention='disabled'` in the runtime-policy variant and Step 07 skips the auto-mode assertion.

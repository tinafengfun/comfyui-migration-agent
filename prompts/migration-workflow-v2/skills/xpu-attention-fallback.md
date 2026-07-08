---
skillId: xpu-attention-fallback
version: 1.0.0
tier: on-demand
trigger:
  stepId: "04"
  condition:
    anyOf:
      - nodeType: "AIO_Preprocessor"
      - nodeType: "DepthAnythingPreprocessor"
provenance:
  taskOrigin: "manual"
  createdAt: "2026-06-25"
  approvedBy: "tinafengfun"
---

## XPU attention/preprocessor fallback

When the source workflow contains attention-based preprocessors (`AIO_Preprocessor`, `DepthAnythingPreprocessor`), these nodes may fail on Intel XPU due to missing attention operator implementations.

1. **Operator check**: These processors often use `scaled_dot_product_attention` or flash attention, which may not be dispatched to the XPU backend on current `torch_xpu` builds. Check `torch.xpu.is_available()` and whether the attention kernel is registered.
2. **Fallback policy**: If the operator is missing, route these nodes to CPU via `device=cpu` runtime policy. The quality impact is zero for deterministic preprocessors (depth, canny); only latency increases.
3. **Provider hint**: Some processors accept a `provider` argument. Try `provider=openvino` as an alternative dispatch path if available — OpenVINO has better attention coverage for Intel hardware.
4. **Source-audit annotation**: In `04-source-audit.md`, mark each affected node with `xpu_attention_risk: yes` and the fallback strategy chosen. This carries forward to step 05 deployment and step 07 smoke validation.

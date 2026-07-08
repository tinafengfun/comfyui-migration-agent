---
skillId: seedvr2-loader-workaround
version: 1.0.0
tier: on-demand
trigger:
  stepId: "04"
  condition:
    nodeType: "SeedVR2*"
provenance:
  taskOrigin: "Zimage"
  evidenceArtifact: "04-source-audit.md"
  createdAt: "2026-06-25"
---

## SeedVR2 XPU feature-development gap

When the source workflow uses any `SeedVR2*` node (`SeedVR2LoadDiTModel`, `SeedVR2LoadVAEModel`, `SeedVR2VideoUpscaler`):

**A formal recipe `SeedVR2-xpu-registration` is also injected on steps 02/04/05.** This skill provides the step-04-specific audit checklist.

### Source-audit checklist

1. **Device enumeration**: Check `memory_manager.py` — does `get_device_list()` enumerate XPU? If not, the SeedVR2 package cannot see Intel GPUs at all. This is a **hard stop** until patched.

2. **Output tensor conversion**: Check `video_upscaler.py` — does the output conversion check `is_xpu`? If it only checks `is_cuda`/`is_mps`, XPU tensors won't be moved to CPU for ComfyUI output (silent data loss).

3. **Workflow widgets**: Check if `SeedVR2LoadDiTModel` / `SeedVR2LoadVAEModel` widgets hardcode `cuda:0`. Record as a runtime-policy change item — do not silently edit the workflow.

4. **Attention mode**: Verify the workflow uses `sdpa` attention. Flash/Sage paths are NVIDIA-only and will crash on import on XPU.

5. **VRAM capacity**: SeedVR2 target resolution can be 3840×7680. Intermediate DiT tensors are 4-8× input resolution. Mark `seedvr2_xpu_risk: registration | memory | both` in `04-source-audit.md`.

6. **Annotation format**: Mark in the source-audit table:
   ```
   seedvr2_xpu_risk: registration | memory | both
   seedvr2_patch_applied: yes | no | pending
   seedvr2_device_policy: xpu:0 | cpu | cuda:0 (unchanged)
   ```

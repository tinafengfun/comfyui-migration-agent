# Source audit skill

### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write follow-up questions as plain text instead of calling `ask_user`, the step will end prematurely. Call `ask_user` for each round of the discussion.

This includes:
- Presenting audit findings and human gate items
- Asking for approval on classifications (CPU fallback, feature-development gap, etc.)
- Confirming whether to proceed to Step 05 environment readiness probe
- Any follow-up questions about audit results

**Maximum 5 `ask_user` rounds.** After round 5, apply your best judgment for any remaining open items and proceed.

## Use when

Use before patching custom nodes or declaring XPU support.

## Inputs

- custom-node source paths
- workflow critical-path list
- workflow JSON or extracted widget-value table
- asset ledger and custom-node ledger
- environment details

## Algorithm

1. Search source for `.cuda()`, `torch.cuda.*`, hard-coded `cuda`, native CUDA extensions, provider assumptions, and eager imports.
2. Extract workflow-side runtime choices for the node families under audit:
   - explicit device strings such as `cuda:0`, `cpu`, `mps`, `xpu`, or `auto`
   - attention backend choices such as FlashAttention, SageAttention, SDPA, or `auto`
   - quantization and dtype choices such as Q4/Q8, FP8, FP16, BF16, or FP32
   - offload device, output device, target resolution, frame count, and model filenames
3. Check Intel XPU-specific risk:
   - whether the code has an equivalent `torch.xpu` path or uses generic `torch.device`
   - whether `ipex.optimize()` is assumed, required, harmful, or irrelevant for the model path
   - whether attention uses Flash Attention, SageAttention, SDP settings, or custom kernels that must be disabled or replaced on XPU
   - whether dtype choices are safe for the target XPU class; do not assume `fp16` and `bf16` behave the same on every Intel GPU
   - whether ONNX Runtime providers are hard-coded to CUDA-only providers instead of OpenVINO, DML, CPU, or another validated provider
   - whether the installed PyTorch, IPEX, Level Zero, and driver versions are compatible with the expected `torch.xpu` behavior
4. Link each risk to workflow criticality. Package-level CUDA hits in optional or disconnected code are retained as package risk, but they are not critical blockers unless the workflow branch uses them.
5. Classify the patch type.
6. Decide whether to patch, keep CPU fallback, mark integration gap, or mark feature-development gap.
7. Separate support claims from validation routes:
   - **native XPU candidate**: source uses ComfyUI device abstractions or explicit `torch.xpu`/generic-device handling; still requires runtime proof
   - **CPU fallback**: acceptable only when explicitly recorded, not an Intel-XPU migrated claim
   - **workflow/runtime policy blocker**: source might support a safer mode, but the workflow widget chooses an unsafe CUDA-only device/backend
   - **feature-development gap**: source architecture needs new XPU support before native validation can proceed
8. Emit an all-node source-audit table. Core and dependency-free nodes can be classified as no source change expected, but they must still appear.
9. Redact token-like values from workflow widget evidence before writing artifacts.
10. Include a `completion_decision` block and Toolization block.

## Common failure signatures

- CUDA cleanup API called on non-CUDA runtime
- GPU-only ONNX/provider assumption
- eager import breaks ComfyUI startup
- custom kernel unavailable on XPU
- attention optimization node assumes NVIDIA-only backend
- dtype path works on CPU/CUDA but fails or regresses on XPU
- package imports successfully but one node family still uses CUDA-only runtime
- workflow widget hard-codes `cuda:0` even though the migration target is XPU-only
- device picker lists CUDA/MPS/CPU but no XPU or ComfyUI-managed device option
- source offers SDPA or CPU fallback but the workflow selects a CUDA-only placement
- tensor output is moved to CPU only for `is_cuda` or `is_mps`, leaving XPU tensors unsupported

## Evidence standard

Retain file/line references, tracebacks, import logs, and patch-class table.

For every high-risk item, include:

- exact source path and line or function
- relevant workflow node id and widget values
- critical-path status
- observed or expected failure signature
- target route: XPU patch, runtime policy override, CPU fallback, environment gap, or feature-development gap
- validation needed before promotion

Do not store concrete credentials or auth query values in audit artifacts. Redact URL query keys such as token/auth/authorization/API key and JWT-looking values before writing widget evidence.

## Compatibility evidence table

Record actual compatibility evidence. Do not fill this table with guessed support.

| Area | What to record | Allowed value when unknown |
| --- | --- | --- |
| PyTorch XPU | exact `torch` version and whether `torch.xpu.is_available()` was observed | `unknown; verify in environment step` |
| IPEX | exact `intel_extension_for_pytorch` version and whether it is used by this code path | `not installed` or `unknown` |
| Attention backend | actual backend used by the node or workflow policy | `unknown; source audit required` |
| ONNX provider | provider requested by source and provider available in runtime | `unknown; provider validation required` |
| Dtype | dtype requested by source and dtype validated on target hardware | `unknown; runtime validation required` |
| Driver/runtime | driver, Level Zero, and oneAPI runtime observed on target | `unknown; environment gap` |

## Claim boundary

Never collapse these into one status:

| Status | Meaning | Allowed claim |
| --- | --- | --- |
| Native XPU candidate | Source appears portable through ComfyUI device management, generic `torch.device`, or explicit `torch.xpu`; runtime proof is still required. | "candidate pending validation" |
| CPU fallback | Branch can run with meaningful compute on CPU. | "CPU fallback", not "Intel-XPU migrated" |
| Workflow/runtime policy blocker | Source may have a safe path, but the workflow widget or launch policy selects an unsafe CUDA-only path. | "blocked until policy/workflow decision" |
| Feature-development gap | Source lacks an XPU-capable architecture or depends on unsupported kernels. | "requires source work before native XPU validation" |

## Hard stops

Stop normal migration if the critical path requires unsupported CUDA-only architecture.

Stop native-XPU claims if the workflow hard-codes CUDA device widgets on critical nodes, if the only verified route is CPU fallback, or if the source has no XPU-capable path and no framework abstraction that can cover placement.

## Completion decision

Every Step 04 artifact must include:

```text
completion_decision:
  status:
  success_criteria_checked:
  evidence_artifacts:
  unresolved_gaps:
  human_gate_prompt:
  next_step_allowed:
```

`complete` requires all-node audit coverage, scanned or gated workflow-selected custom-node roots, redacted workflow widget evidence, critical-path status joined to every risk, no patches applied, and Step 05 context present.

## Output schema

`node_family`, `source_path`, `workflow_node_ids`, `widget_evidence`, `risk`, `xpu_specific_risk`, `critical_path`, `patch_class`, `recommended_route`, `evidence`, `validation_needed`.

Recommended reusable scaffold:

```text
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step04_source_audit_scaffold.py --workspace <workspace>
```

The scaffold is safe only for static Step 04 audit work. It may scan source roots, record line-level findings, join risks to Step 03 node criticality, redact widget evidence, and write Step 04 artifacts. It must not install dependencies, import ComfyUI, patch source, edit workflows, or claim runtime compatibility.

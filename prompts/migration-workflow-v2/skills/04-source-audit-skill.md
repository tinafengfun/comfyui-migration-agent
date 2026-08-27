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

## Source authority (agent-local mirror vs runtime checkout)

The runtime docker node's custom-node checkout is the authoritative source for source-audit and behavior claims. The agent-local mirror is a convenience only; if commit hashes differ, the runtime checkout governs. Record both hashes when they differ (and note which one each finding was read against), so Step 05 can reconcile without re-auditing. This does not weaken the no-bypass / no-edit-source rules (Contract items 1-2): it only specifies which copy of the read-only source is canonical for claims. When the agent and runtime mirrors match (same commit hash), Step 04 proceeds with no extra reconciliation.

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
   - **whether any text-encoder / CLIP checkpoint is FP8-quantized** (filename patterns: `_fp8`, `fp8_e4m3fn`, `fp8_scaled`, `qwen_*_vl_*_fp8*`). If yes, flag for the Step 02 FP8-on-XPU decision gate (see `02-feasibility-analysis-skill.md § FP8 quantized weights on XPU`). The default XPU path segfaults during `Module.to("xpu")` and requires either the `ops.py` dequant patch or `CLIPLoader device=cpu` offload — Step 02 picks which based on the VRAM gate.
4. Link each risk to workflow criticality. Package-level CUDA hits in optional or disconnected code are retained as package risk, but they are not critical blockers unless the workflow branch uses them.
5. Classify the patch type.
6. Decide whether to patch, keep CPU fallback, mark integration gap, or mark feature-development gap.
7. Separate support claims from validation routes:
   - **native XPU candidate**: source uses ComfyUI device abstractions or explicit `torch.xpu`/generic-device handling; still requires runtime proof
   - **CPU fallback**: acceptable only when explicitly recorded, not an Intel-XPU migrated claim
   - **workflow/runtime policy blocker**: source might support a safer mode, but the workflow widget chooses an unsafe CUDA-only device/backend
   - **feature-development gap**: source architecture needs new XPU support before native validation can proceed
8. Emit an all-node source-audit table. Core and dependency-free nodes can be classified as no source change expected, but they must still appear.
   - **Precheck must verify every node type in the source workflow appears in `03-node-inventory.csv`.** A node type not in the inventory is a gap to investigate before proceeding.
9. Redact token-like values from workflow widget evidence before writing artifacts.
10. Include a `completion_decision` block and Toolization block.
11. **CUDA-ism scan (mandatory checklist item).** For every custom-node source root under audit, grep both the `__init__`/class-init code AND the runtime forward loop (the `forward()` method and any helper it calls during sampling) for the following CUDA-isms:
    - `torch.cuda.is_available()`
    - `torch.cuda.stream` / `torch.cuda.Stream` / `torch.cuda.Event`
    - `.cuda()` tensor or module moves
    - `device='cuda'`, `device="cuda"`, `cuda:0`, or any hard-coded `cuda` device string
    
    Classify every hit into exactly one of:
    - (a) **import-time crash** — the CUDA-ism runs at import/init and will raise or segfault before the node registers on XPU
    - (b) **silent feature disable** — the CUDA-ism gates an optimization/capacity mechanism (block-swap, async streams, prefetch) that silently no-ops on XPU, leaving the node registered but the feature off; this is the most insidious class because it produces a non-obvious device-mismatch or full-residency OOM at runtime instead of an import error
    - (c) **device-mismatch-at-runtime** — the CUDA-ism moves a tensor to CUDA during forward while surrounding tensors live on XPU, producing a cross-device error during sampling
    
    **The auditor MUST check the runtime forward loop, not just the init method.** A device-agnostic init method does NOT prove the runtime path is safe — the init may offload blocks to CPU correctly while the forward loop's `torch.cuda.is_available()` gate silently disables the cycling that moves them back. Record the init finding and the forward-loop finding separately.
    
    **Worked example (silent feature disable, class b):** `ComfyUI-WanVideoWrapper/wanvideo/modules/model.py` — the `block_swap()` init method (lines 2040-2065) is device-agnostic and moves blocks to `offload_device` on XPU correctly, BUT the `forward()` method (lines 3202-3209) gates block cycling behind `if torch.cuda.is_available():`, setting `swap_start_idx = len(self.blocks)` in the `else` branch so that on XPU the on-cycle/off-cycle conditions (`b >= swap_start_idx and self.blocks_to_swap > 0`) are never true. Blocks offloaded to CPU at init are never moved back to `main_device` for compute, producing a device-mismatch error or full-residency OOM during sampling. The init audit alone would have missed this; only the forward-loop scan catches it.

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
- init method is device-agnostic but the runtime forward loop gates block-swap / streams behind `torch.cuda.is_available()`, silently disabling a capacity mechanism on XPU (see CUDA-ism scan, class b)

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

## Migration capability matrix (route + actor)

Map every audited finding to exactly one `migration_route` — the shared triage vocabulary used
identically here, in Step 02 `hard_stop` reasoning, and in the catalog `migrationRoute` field.
The route names WHO acts and WHICH existing capability applies. `auto_*` = the agent may attempt it
autonomously (bounded + objective-gated, see Step 05 § bounded autonomous repair); `human_*` /
`unsupported_*` / `not_applicable` = no autonomous attempts (escalate / stop).

| Finding (CUDA-ism class × claim boundary) | `migration_route` | Actor | Capability that applies |
| --- | --- | --- | --- |
| Missing pure-python pip deps only (registers once installed) | `auto_deps` | agent | in-container install via `with-shared-venv-lock.sh` (ComfyUI auto-installs at import) |
| Device strings only — `.to("cuda")`/`torch.device("cuda")`/`.cuda()`/`torch.cuda.*` (class a import-crash or class c device-mismatch, NO compiled kernel) | `auto_device_redirect` | agent | `cuda-to-xpu-patch.py`, `patch_class: functional_runtime_support` |
| FP8 / quantized weights needing dequant / keep-on-move | `auto_fp8` | agent | fp8 keep-on-move patch + `CLIPLoader-qwen-fp8` ladder + `OMNI_FP8_KEEP_ON_MOVE` (Step 02 gate) |
| Attention op missing on XPU (flash/sage), class b silent-disable of an attention path | `auto_attention_fallback` | agent | `xpu-attention-fallback` skill (CPU/openvino) |
| Enum widget value from a missing package | `auto_enum` | agent | `install-enum-package.mts` |
| Import/code bug, or feature-development gap (no XPU-capable path) | `human_source_work` | human | — |
| Dep/version conflict vs the pinned image (e.g. `transformers==5.0`) | `human_env_conflict` | human | — |
| Source repo dead/moved/unresolved | `human_source_unknown` | human | — |
| Compiled CUDA kernel / native CUDA extension, no XPU path | `unsupported_cuda_kernel` | none | Step 02 `hard_stop` |
| Use built-in / unmaintained (translations, Manager) | `not_applicable` | none | — |

Emit `migration_route` on every node in the output table, and mirror the per-node routes into a
machine-readable `04-triage.json` (`{ "nodes": [ { "node_family", "migration_route", "actor",
"tool", "critical_path", "reason" } ] }`) alongside the human `04-source-audit.md`. `migration_route`
IS the formalized `recommended_route` — do not invent a second vocabulary.

## Hard stops

Stop normal migration if the critical path requires unsupported CUDA-only architecture
(`migration_route: unsupported_cuda_kernel` → Step 02 `hard_stop`).

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

`node_family`, `source_path`, `workflow_node_ids`, `widget_evidence`, `risk`, `xpu_specific_risk`, `critical_path`, `patch_class`, `migration_route` (the formalized `recommended_route` — one of the capability-matrix enum values), `evidence`, `validation_needed`. Also emit the machine mirror `04-triage.json` (see the capability matrix).

Recommended reusable scaffold:

```text
python3 $DRAFT_DOC_ROOT/migration-workflow-v2/tools/step04_source_audit_scaffold.py --workspace <workspace>
```

The scaffold is safe only for static Step 04 audit work. It may scan source roots, record line-level findings, join risks to Step 03 node criticality, redact widget evidence, and write Step 04 artifacts. It must not install dependencies, import ComfyUI, patch source, edit workflows, or claim runtime compatibility.

# Source audit prompt

## Task

Audit risky workflow and custom-node source paths for Intel XPU compatibility before patching.

## Required context

- workflow inventory
- custom-node ledger
- asset ledger and acquisition log, if already created
- workflow JSON or extracted node widget values
- local source paths
- target Python/PyTorch/IPEX runtime

## Constraints

1. Verify from source code, not guesses.
2. Do not patch unrelated code.
3. Classify each issue before fixing it.
4. Keep CPU fallback and blocked classifications visible.
5. Do not claim native XPU support from a CPU fallback, generic import success, or source clone.
6. Do not edit workflow widget values during this audit. If a widget hard-codes `cuda:0`, record it as a workflow/runtime policy blocker.
7. Account for every source workflow node in the Step 04 audit, even when the node is core, dependency-free, disconnected/reference, or not on a critical path.
8. Redact token-like query parameters and auth headers from workflow widget evidence before writing artifacts. Recording env var names is allowed; concrete token values are not.
9. Do not apply source patches in Step 04. Patch candidates are findings for later approved repair steps.

## Steps

1. Search risky packages for `.cuda()`, `torch.cuda.*`, hard-coded `"cuda"`, CUDA-only extensions, unsupported providers, eager imports, and cleanup APIs.
2. Extract relevant workflow widget values for audited node families, especially device selectors, attention backends, dtype/quantization, offload device, output device, resolution, frame count, and model filenames.
3. Check Intel XPU-specific portability:
   - generic `torch.device` vs CUDA-only placement
   - `torch.xpu` equivalent path where relevant
   - IPEX optimization assumptions
   - Flash Attention, SageAttention, SDP, or custom attention backends
   - dtype assumptions such as `fp16` vs `bf16`
   - ONNX provider assumptions
   - PyTorch / IPEX / driver compatibility assumptions
4. Identify whether each risky node is on a critical path by using the workflow inventory, not by package-level search hits alone.
5. Distinguish native-XPU support from fallback routes:
   - native XPU: code or ComfyUI abstraction can place meaningful compute on `xpu` and validation is still required
   - CPU fallback: usable but must not be reported as Intel-XPU migrated
   - environment/integration gap: install, registration, provider, or model-path wiring is still missing
   - feature-development gap: CUDA-shaped architecture, missing `torch.xpu` path, unsupported custom kernel, or hard-coded device model requires real source work
6. Classify required change: workflow/runtime policy, ComfyUI core patch, custom-node patch, environment/dependency fix, CPU fallback, or blocked feature work.
7. Record exact source locations, workflow widget evidence, expected failure signatures, and validation needed.

## Output

Create a source-audit report with:

- package/node family
- risk evidence
- XPU-specific risk
- critical-path status
- patch class
- recommended route
- hard-stop or human-decision item
- workflow widget/device evidence when relevant
- validation needed before promotion
- all-node source-audit accounting table or CSV
- package scan status, including missing roots and skipped files
- Toolization section
- `completion_decision`

`completion_decision` must include:

```text
status:
success_criteria_checked:
evidence_artifacts:
unresolved_gaps:
human_gate_prompt:
next_step_allowed:
```

Step 04 is `complete` only if all source nodes are represented, every workflow-selected custom-node source root is scanned or explicitly human-gated, widget/device evidence is redacted and recorded, no patches were applied, and Step 05 context is present.

## Hard stops

Stop normal migration if a critical node requires CUDA-only kernels, `.cuda()` architecture, unsupported providers, or major upstream feature development.

Also stop native-XPU claims when:

1. the only available route is CPU fallback
2. the workflow itself hard-codes a CUDA device on a critical node
3. source has no XPU-capable path and no ComfyUI device abstraction covers the node family
4. a full-resolution branch has obvious capacity risk that has not yet been measured

## Prior-migration lessons

Some Dasiwa custom nodes needed code patches, some only needed Intel-safe runtime overrides, and some only needed installation. Mixlab showed that import-time side effects and family-level risk must be classified separately.

Zimage showed that source audit must combine source code and workflow widget evidence. A package may have SDPA or CPU fallback in source while the workflow still hard-codes `cuda:0`, and a prompt-enhancement/display-looking branch may be critical if its text output feeds generation. Zimage also showed that "no `torch.xpu` implementation found" is not automatically a failure for ComfyUI core nodes that use ComfyUI device abstractions, but it is a hard boundary against claiming native XPU support for independent custom nodes until patched or validated.

## Automation hook

If available, use a source scanner to collect candidate hits, but do not let scanner output replace source reading. The report must still explain whether each hit is critical, optional, fallback-safe, or blocked.

Current reusable scanner:

```text
ComfyUI/docs/draft/migration-workflow-v2/tools/step04_source_audit_scaffold.py
```

It may scan source roots, join findings to Step 03 criticality, extract redacted workflow widget evidence, and write Step 04 artifacts. It must not install packages, import ComfyUI, patch source, edit workflows, or validate runtime support.

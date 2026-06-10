# Environment deployment prompt

**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of the interactive review, not just the first one.

## Task

Prepare a reproducible fresh ComfyUI Intel XPU environment for migration validation.

## Required context

- target machine
- ComfyUI repo/commit
- Python version and venv path
- model roots
- custom-node ledger
- asset ledger and acquisition log, if staged assets exist
- source-audit report and required patch classes
- Step 04 `step05_context`, including `package_roots`, `object_info_must_verify_nodes`, source patch policy, runtime-policy blockers, and non-source-identical node IDs
- Step 01 staged asset paths and custom-node source acquisition evidence
- required patches

## Constraints

1. Use conservative launch settings before aggressive optimization.
2. Record exact runtime, flags, environment variables, and model paths.
3. Do not treat startup as workflow validation.
4. Verify custom-node registration before prompt validation.
5. Verify that PyTorch is an Intel XPU-capable build. A default PyPI `torch` install may select a CUDA wheel and must not be accepted as an XPU environment.
6. Do not blindly install every custom-node requirement when a source audit identified CUDA-only packages such as `bitsandbytes`, `flash-attn`, `sageattention`, or `onnxruntime-gpu`. Install the minimum portable dependencies needed for startup and target-node registration, and record skipped CUDA-only dependencies.
7. Do not silently change workflow JSON or widget values to make registration easier. Runtime-policy changes must remain explicit.
8. Do not edit the canonical source workflow. Generated model-path config, symlink maps, launch logs, and runtime-policy variants must be separate artifacts with provenance.
9. Distinguish backend nodes from frontend-only LiteGraph nodes. Backend nodes must be present in `/object_info`; frontend-only nodes may be source-verified from web extension registration evidence and must not be silently dropped.
10. If Step 05 installs a dependency, record the exact package, reason, command/log, and whether it was a portable minimal install or a skipped CUDA-only dependency.

## Steps

1. Create or verify Python venv.
2. Install ComfyUI dependencies, then verify `torch.__version__`, `torch.xpu.is_available()`, XPU device name, and XPU VRAM. If the installed wheel is CUDA-only, replace it with the correct XPU wheel before proceeding.
3. Install or symlink custom nodes at recorded commits, preserving source provenance and local patch status.
4. Install custom-node dependencies in a source-audit-aware way:
    - prefer portable dependencies required for import and registration
    - include portable runtime dependencies declared by custom nodes used on target branches, not only dependencies needed for `/object_info` registration
    - avoid CUDA-only optional acceleration packages unless explicitly approved
    - record skipped optional dependencies and their impact
5. Configure model roots or symlink staged assets into active ComfyUI model paths. Record source and destination for each model/input path.
6. Apply required registration patches or workflow runtime policies, and record them as patches, not as runtime success.
7. Launch with Intel-XPU-safe flags and capture startup logs.
8. Verify node registration through a machine-readable source such as `/object_info`; do not rely only on "server started".
9. Source-verify frontend-only workflow nodes that are intentionally absent from `/object_info`.
10. Record actual software and driver versions; use `unknown` rather than guessed versions when a value cannot be verified.
11. End with a `completion_decision` block containing `status`, checked success criteria, evidence artifacts, unresolved gaps, any human-gate prompt, and `next_step_allowed`.

## Reusable tool

When the repository contains `tools/step05_environment_readiness.py`, use it to prepare and collect the Step 05 evidence:

```bash
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step05_environment_readiness.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --venv <ComfyUI root>/.venv-xpu \
  --link-staged-custom-nodes \
  --api-url http://127.0.0.1:<port>
```

The tool may create safe custom-node symlinks and a separate `05-extra-model-paths.yaml`; it must not overwrite collisions, edit source workflow JSON, apply source patches, or install dependencies. Dependency installs remain explicit Step 05 repair actions with logs.

## Output

Create an environment report with:

- repo/commit
- venv path
- Python, PyTorch, IPEX, driver, Level Zero, and GPU details
- package install notes
- launch command and flags
- model path config
- startup/registration result
- API evidence, such as `/system_stats` and `/object_info` excerpts or saved JSON
- node-registration table that marks backend registered, frontend-only source-verified, missing, or not checked
- model wiring table for every staged Step 01 asset
- local patches applied during environment setup
- CUDA-only dependencies skipped or downgraded to portable alternatives
- target-node runtime dependencies installed or intentionally deferred
- known environment gaps
- `completion_decision`

## Hard stops

Stop if the environment cannot install, import, launch, or register required nodes.

Also stop before prompt validation if:

1. `torch.xpu.is_available()` is false on an XPU target
2. ComfyUI starts on CPU or CUDA instead of the intended XPU device
3. required backend target nodes are missing from `/object_info`
4. model paths are not visible from the active ComfyUI instance
5. a registration patch is required but not recorded as a patch artifact
6. a frontend-only source node cannot be verified from its web extension source
7. dependency repair would require CUDA-only packages, source patches, semantic workflow edits, or reduced-fidelity claims without human approval

## Prior-migration lessons

Wan package work showed bootstrap and registration are separate evidence levels. Dasiwa GUI delivery showed that a dedicated validation instance and fresh deployment checklist are needed for end-user verification.

Zimage showed that default dependency installation can silently install CUDA PyTorch wheels even on an Intel XPU host. Always prove `torch 2.x+xpu` or the intended XPU build and `torch.xpu.is_available() == True` before treating the environment as ready. Zimage also showed that custom-node registration can require a small source patch, but that patch only proves registration readiness; it does not prove full workflow execution or native-XPU support for the node family.

Zimage FLUX2/Klein smoke also showed that registration readiness can miss runtime-only Python dependencies. `ComfyUI-KJNodes` registered, but `ColorMatch` later failed until the declared portable dependency `color-matcher` was installed. During Step 5, inspect requirements against the selected target node classes and record which runtime dependencies were installed, skipped, or deferred to branch smoke.

Zimage v2 Step 05 showed two additional environment-contract gaps. First, SeedVR2 registration failed until the portable dependency `rotary_embedding_torch` was installed with `--no-deps` to avoid changing the XPU torch stack. Second, frontend-only nodes such as `Note Plus (mtb)` and `Fast Groups Bypasser (rgthree)` are not backend `/object_info` classes; Step 05 must source-verify them from web extension registration evidence instead of treating them as missing backend nodes.

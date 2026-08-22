### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Prompt conversion validation skill

## Use when

Use before any runtime result is interpreted.

## Inputs

- workflow JSON
- asset ledger
- running ComfyUI endpoint
- Step 05 `object_info`, model-path config, and registration evidence
- Step 03 branch map
- converter script or manual conversion process

## Algorithm

1. Convert graph to API prompt while preserving real inputs.
2. Keep literal/widget-only nodes and package-specific controls.
   - **`widgets_values` mapping is node-schema-specific — never assume a fixed positional layout.** For `BerniniConditioning` the positional list maps index `0=width`, `1=height`, `2=length`, `3=batch_size`, `4=ref_max_size`; mapping these to the wrong input names produces wrong video dimensions and failed smokes. Conversely, some nodes (e.g. `VHS_*`) serialize `widgets_values` as a DICT (`{"video": ..., "frame_load_cap": ...}`) rather than a positional list — the converter must detect a dict and map by key name, not by position.
3. Sanitize rgthree Image Comparer nodes: detect Image Comparer by class name, clear `widgets_values` for disconnected inputs (image_a, image_b when no link exists). Set to `[None]` instead of leaving empty arrays.
3. Normalize selector-backed names to basenames.
4. Initialize custom nodes through the same startup path as ComfyUI when validating offline; route-dependent custom nodes may require `PromptServer.instance`.
5. Validate without queueing execution when the task is validation-only. Use internal `execution.validate_prompt()` or an equivalent no-queue path; use `/prompt` only when execution is intentionally allowed.
6. Inspect `node_errors`, output set, and pruned nodes.
6a. **Scan `widgets_values` for cuda device references.** For every source-workflow node, inspect its `widgets_values` array for string entries that contain `cuda:0`, `cuda:1`, or the standalone token `cuda` (not part of a longer path). Record each hit with the node ID, widget index, and matched string. These are candidate runtime-policy changes — feed them into step 8's variant generation for explicit documentation and automated patching in the `06b-runtime-policy-changes.json` change-note artifact. Do not rewrite them in-place in the source workflow.
6b. **Import-availability pre-check for CUDA-only attention packages (optional but recommended).** `execution.validate_prompt()` only checks schema/structure — a widget value can pass validation yet crash at runtime because the backing package is not installed. This is most common with attention backends that are CUDA-only. After validation succeeds, scan the converted prompt for widget values that select one of the known CUDA-only attention packages and attempt an import of the corresponding Python module on the target environment:
    - `sageattn` / `sageattention` → `import sageattention`
    - `flash_attn` / `flash_attention` → `import flash_attn`
    - `xformers` → `import xformers`
    For each widget value whose import fails (e.g. `ModuleNotFoundError`), record a warning entry in the validation report (node ID, class type, input name, the value, the module that failed to import, and the target device class). Flag it as `unavailable-on-<device>` (e.g. `unavailable-on-xpu`). Do **not** fail Step 06 on this warning alone — it is advisory and does not replace runtime validation in Step 07/08 — but feed each flagged entry into step 8's runtime-policy variant generation so the risk is documented in `06b-runtime-policy-changes.json` and the variant substitutes an XPU-safe value (per step 8a for `PatchSageAttentionKJ`, or the closest source-supported default otherwise). The intent is to surface the gap *before* a runtime crash in Step 07/08, not to alter the source-preserving prompt.
7. Separate exporter fixes from workflow semantic changes. Correct widget-order or selector serialization bugs, but do not silently rewrite runtime policy values such as `cuda:0`, presets, seeds, dtype, or resolution.
7a. **Enum value not in target list (sampler_name/scheduler/upscale_method/…) — fidelity priority.** When `execution.validate_prompt()` rejects a widget value because it is not in the node's enum list (e.g. `'res_2s' not in (44 samplers)`, `'bong_tangent' not in [...]`), this is almost always an **implicit package dependency**: a custom package (e.g. RES4LYF) injected that value into a core node's dropdown in the source environment, and it is missing on the target. Resolve in this precedence — **substitution is the last resort, not the default**:
   - **(1) Install the providing package (apple-to-apple, preferred).** Identify the package from `00-enum-dependencies.csv` / the source `object_info` / a matching recipe (`providesEnumValues`), then loop back to Step 05 to install it on the target and re-fetch `/object_info`. Once the enum value is present natively, the value is kept **identical to source** — no change.
   - **(2) Substitute to the closest core value — LAST RESORT, human-approved only.** Only if the package genuinely cannot be installed (repo unreachable / XPU-incompatible). Raise a human gate that states the tradeoff explicitly: *"install package (output identical) vs substitute (output drifts)"*. Record the substitution as fidelity-degrading in the change-note. Never auto-substitute an enum value silently.
8. If the prompt now fails only on target runtime-policy or current-schema values, create an explicit validation variant as a Step 6 sub-pass:
   - derive it from the converted prompt, not from an edited source workflow
   - use a stable suffix such as `06b-runtime-policy-*`
   - change only the inputs required by `object_info` or the documented target runtime policy
   - write a change-note artifact with node ID, class, input name, old value, new value, and reason
   - rerun no-queue validation and compare intended outputs
8a. **PatchSageAttentionKJ XPU guard**: If the workflow inventory contains a `PatchSageAttentionKJ` node and the target device is XPU, the runtime-policy variant *must* set `sage_attention='disabled'` on that node. The `auto` mode internally asserts `q.is_cuda`, which crashes on XPU. This is a mandatory variant change, not optional — do not proceed to Step 07 with `sage_attention='auto'` on XPU.
8b. **Human-in-the-loop nodes (e.g. `Prompt_Edit`) hang headless runs — do not diagnose as an XPU/model-loading bug.** Some custom nodes pause execution waiting for a browser client to confirm via a custom websocket/HTTP route (e.g. `Comfyui_Prompt_Edit` polls a `confirmed` flag for up to an hour). With no browser attached during headless Step 06-09 API validation, these nodes hang indefinitely — this can look exactly like a stuck model load (VRAM flat, queue shows "running", no error) and was previously misdiagnosed that way. Before concluding a hang is XPU/capacity-related, get a live stack trace (`py-spy dump --pid <comfyui_pid> --locals`) — if the worker thread is parked inside a custom node's own polling loop rather than torch/XPU code, it is this class of issue, not a model-loading deadlock. Fix: `bypass_human_in_the_loop_nodes()` in `step06_prompt_validation.py` runs as its own pass in `main()` **before** `apply_runtime_policy_variant()`, on a private copy of the prompt used only to build `06b-runtime-policy-prompt.json` (the variant Steps 07/08/09 queue). It rewires any consumer of the node's output directly to its upstream input and drops the node, recording its own change list to `06b-headless-test-bypasses.json` — **kept in a completely separate file from `06b-runtime-policy-changes.json`** (the widget-value device/schema fixes), because Step 12's `prepare_gui_workflow()` replays every entry in `06b-runtime-policy-changes.json` onto the delivered GUI workflow as a widget edit; a structural bypass entry in that list would be nonsensical there. Never merge the two lists. The source-preserving prompt and the GUI workflow delivered to the customer (Steps 11/12) are never touched by the bypass, so a real human GUI run still gets the interactive edit step as designed.
8c. **Native-fp8 XPU offload policy (heavy fp8 pipelines)**: When the workflow uses fp8 checkpoints on XPU AND the environment has the keep-on-move patch (`OMNI_FP8_KEEP_ON_MOVE=1`, comfy_kitchen ≥ 0.2.28 — Step 02 chose `fp8_te_path_chosen: "native_fp8_keep_on_move"`), the runtime-policy variant *must* enforce the offload policy so the fp8 diffusion model has the VRAM: **CLIPLoader `device=default`** (XPU, never `cpu` — the pre-patch cpu-pin is slower and unnecessary once keep-on-move is active), **UNETLoader `weight_dtype=default`** (keep native fp8 from the checkpoint so the `omni_xpu_kernel` fp8 GEMM path fires — never force a bf16 cast), and **`llama_cpp*` VLM nodes `force_offload=True`** (free the ~14 GB VLM from XPU after it produces conditioning). Leave VAE on XPU (do NOT pin `device=cpu`; the launch flags omit `--cpu-vae` and ComfyUI auto-tiles the decode if a full decode would OOM). These are emitted automatically by `apply_runtime_policy_variant()` (all pure widget-value change-notes) when an fp8 pipeline is detected; verify they appear in `06b-runtime-policy-changes.json`. Rationale: with keep-on-move, offloading is cheap, so XPU-resident + sequential-offload beats CPU-pinning on both memory *and* speed — proven live (task a35d64a4: full 720×1280 × 81-frame WAN2.2 completed on one 30 GB XPU, no OOM).
9. Account for every source node in a prompt map: in API prompt, reroute relinked, frontend-only/note source node, or review-required.
10. For terminal branch nodes that are not `OUTPUT_NODE` classes, create generated Step 07 wrapper prompt artifacts rather than editing the source workflow.
11. Fix conversion before execution.

## Reusable validation tool

Use the Step 06 tool when available:

```bash
<ComfyUI root>/.venv-xpu/bin/python \
  ComfyUI/docs/draft/migration-workflow-v2/tools/step06_prompt_validation.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root>
```

It converts the source workflow, runs offline `execution.validate_prompt()` without queueing execution, creates a runtime-policy variant when required, writes a node prompt map, emits branch prompts for Step 07, and generates `06-prompt-validation-summary.json` plus `06-output-manifest.json`.

**Required filenames (deterministic backend code checks for these exact names, not just their content):**
- `06-prompt-validation-summary.json` — the validation results (the fields listed under "Output schema" below). **Not** `06-prompt-validation.json` — a real run once dropped the `-summary` suffix; the content was correct but the step still failed its own completion check over the filename alone.
- `06-source-preserving-prompt.json` — the converted API-format prompt itself (source-preserving, i.e. before any runtime-policy variant).

## Common failure signatures

- Image Comparer (rgthree) temp session image references in `widgets_values` produce empty arrays instead of omitted inputs
- `Int`, prompt editor, lineup, or loader widget value dropped
- selector value not in list
- `execution_success` returned while intended output never runs
- output node pruned by upstream validation error
- `/prompt` queues execution after successful validation
- direct custom-node initialization fails because `PromptServer.instance` is absent
- widget-order drift maps a historical widget into the wrong current input
- current custom-node schema rejects old workflow widget values such as preset labels or seed ranges
- runtime exposes only `xpu:0` while the preserved workflow prompt still requests `cuda:0`
- source-preserving prompt fails validation, but an explicit runtime-policy variant validates with the same nodes and intended outputs
- frontend-only nodes appear in the source workflow but do not belong in the API prompt
- selector subfolders are incorrectly stripped to basenames
- UI-only control widgets shift later widget values into wrong inputs
- a terminal branch node is not an `OUTPUT_NODE` and needs a generated preview/output wrapper for Step 07
- a widget value selecting a CUDA-only attention backend (e.g. `sageattn`, `flash_attn`, `xformers`) passes `execution.validate_prompt()` but crashes at runtime because the package is not installed on the target device

## Evidence standard

Retain converted prompt, raw validation response, validation method, queue/execution status, `node_errors`, and output-node comparison.

For a runtime-policy validation variant, also retain the variant prompt, change-note artifact, proof that the source workflow was not modified, and a diff/summary proving only expected inputs changed.

Retain `06-node-prompt-map.csv` for all-source-node accounting and `06-branch-prompts.csv` for Step 07. Branch prompt rows must identify any generated wrapper node and its provenance.

## Hard stops

Stop if critical validation errors remain, intended outputs are missing, or the only available fix would silently alter workflow semantics.

Do not continue to branch smoke from a silent or undocumented policy rewrite. Continue only from either the source-preserving prompt or a clearly labeled runtime-policy variant with empty `node_errors`.

## Output schema

`prompt_path`, `validation_method`, `queued_execution`, `validation_response`, `node_errors`, `validated_outputs`, `missing_inputs`, `pruned_outputs`, `fixes`, `semantic_change_required`, `variant_path`, `variant_changes`, `source_workflow_modified`, `nodes_bypassed`, `node_prompt_map`, `branch_prompts`, `terminal_non_output_branches`, `import_availability_warnings`, `completion_decision`, `step07_context`.

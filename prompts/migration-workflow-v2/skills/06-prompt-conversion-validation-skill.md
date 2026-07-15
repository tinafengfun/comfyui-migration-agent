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
3. Sanitize rgthree Image Comparer nodes: detect Image Comparer by class name, clear `widgets_values` for disconnected inputs (image_a, image_b when no link exists). Set to `[None]` instead of leaving empty arrays.
3. Normalize selector-backed names to basenames.
4. Initialize custom nodes through the same startup path as ComfyUI when validating offline; route-dependent custom nodes may require `PromptServer.instance`.
5. Validate without queueing execution when the task is validation-only. Use internal `execution.validate_prompt()` or an equivalent no-queue path; use `/prompt` only when execution is intentionally allowed.
6. Inspect `node_errors`, output set, and pruned nodes.
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

## Evidence standard

Retain converted prompt, raw validation response, validation method, queue/execution status, `node_errors`, and output-node comparison.

For a runtime-policy validation variant, also retain the variant prompt, change-note artifact, proof that the source workflow was not modified, and a diff/summary proving only expected inputs changed.

Retain `06-node-prompt-map.csv` for all-source-node accounting and `06-branch-prompts.csv` for Step 07. Branch prompt rows must identify any generated wrapper node and its provenance.

## Hard stops

Stop if critical validation errors remain, intended outputs are missing, or the only available fix would silently alter workflow semantics.

Do not continue to branch smoke from a silent or undocumented policy rewrite. Continue only from either the source-preserving prompt or a clearly labeled runtime-policy variant with empty `node_errors`.

## Output schema

`prompt_path`, `validation_method`, `queued_execution`, `validation_response`, `node_errors`, `validated_outputs`, `missing_inputs`, `pruned_outputs`, `fixes`, `semantic_change_required`, `variant_path`, `variant_changes`, `source_workflow_modified`, `nodes_bypassed`, `node_prompt_map`, `branch_prompts`, `terminal_non_output_branches`, `completion_decision`, `step07_context`.

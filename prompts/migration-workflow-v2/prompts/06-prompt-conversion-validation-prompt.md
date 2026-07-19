**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Prompt conversion validation prompt

## Task

Convert the workflow JSON into an API prompt and prove the prompt validates correctly before runtime interpretation.

## Required context

- workflow JSON
- workflow inventory
- asset ledger
- running ComfyUI endpoint
- Step 05 object_info, extra model path config, and node-registration evidence
- Step 03 branch/output map
- converter tool, if available

## Constraints

1. Preserve widget-only nodes and required literal values.
2. Normalize selector-backed asset names to submit-safe basenames.
3. Capture the raw validation response. Use `/prompt` only when execution is intentionally allowed; a successful `/prompt` POST queues the prompt for execution.
4. Prefer validation-only mechanisms such as internal `execution.validate_prompt()` when the step must not run the workflow.
5. Do not trust `execution_success` without `node_errors` and output-node checks.
6. Record exporter/schema fixes separately from workflow semantic changes.
7. Treat an explicit runtime-policy validation variant as a Step 6 sub-pass, not as a source workflow edit or a new migration phase.
8. Account for every Step 00 source node in a prompt map. Reroutes and frontend-only/note nodes may be omitted from the API prompt only with an explicit classification.
9. Do not collapse selector subdirectories to basenames unless the target `object_info` selector list requires it. Prefer the value that validates against the active runtime list.
10. Old workflows may contain UI-only control widgets such as `control_after_generate`; do not shift later widget values into the wrong input.
11. Terminal branch nodes that are not `OUTPUT_NODE` classes must be explicitly classified and, if Step 07 needs execution, wrapped in a generated preview/output node artifact rather than editing the source workflow.

## Steps

1. Convert workflow JSON to API prompt.
2. Preserve widget-heavy nodes such as literal inputs, prompt editors, lineup nodes, LoRA loaders, and package-specific controls.
3. Sanitize rgthree Image Comparer nodes: detect Image Comparer nodes by class name, clear `widgets_values` entries for disconnected inputs (`image_a`, `image_b` when no link exists in the workflow). Set affected entries to `[None]` instead of leaving empty arrays. This prevents converter bugs where temp session image references produce `[]` inputs for disconnected ports.
3. Normalize model and asset selectors.
4. Initialize custom nodes the same way the server does before offline validation; some custom nodes require `PromptServer.instance` even when no HTTP request is sent.
5. Validate without queueing execution when possible. If `/prompt` is used, state that execution is intentionally allowed and retain the raw response.
6. Inspect `node_errors`, validated output nodes, and pruned branches.
6a. **Scan `widgets_values` for cuda device references.** Before fixing exporter issues or creating runtime-policy variants, scan every source-workflow node's `widgets_values` array for string values containing `cuda:0`, `cuda:1`, or the bare token `cuda` that is not part of a longer path (e.g. `cuda` as a standalone widget value). Record each match with the node ID, widget index, and the matched value. These are candidate runtime-policy changes: the source workflow hardcodes a CUDA device that will be unavailable on a target runtime exposing only `xpu:0` or a different GPU index. Do not silently rewrite them — feed the match list into Step 8's runtime-policy variant generation so each is explicitly documented and patched in the variant only.
7. Fix exporter or input issues before runtime, but do not silently normalize workflow policy values such as `cuda:0` or schema-incompatible prompts.
8. If validation fails only because the preserved workflow contains runtime-policy or current-schema values that cannot validate in the target environment, create a clearly named validation variant instead of overwriting the source prompt:
   - write a variant prompt such as `06b-runtime-policy-prompt.json`
   - document each changed input, old value, new value, and reason
   - keep the original workflow JSON unchanged
   - preserve every node and connection; do not bypass nodes
   - run no-queue validation again
9. Proceed to branch smoke only after the original validation failure and the explicit variant validation result are both documented.
10. Generate branch prompt artifacts for Step 07. If a branch terminal node is not an `OUTPUT_NODE`, create a clearly labeled generated wrapper prompt that connects the terminal output to a preview/output node.

## Reusable tool

When the repository contains `tools/step06_prompt_validation.py`, use it for conversion, no-queue validation, runtime-policy variant generation, node accounting, and Step 07 branch-prompt handoff:

```bash
<ComfyUI root>/.venv-xpu/bin/python \
  ComfyUI/docs/draft/migration-workflow-v2/tools/step06_prompt_validation.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root>
```

The tool must use offline `execution.validate_prompt()` or an equivalent no-queue path. It must not call `/prompt` for a validation-only pass.

## Output

Create a prompt-validation package with:

- converted prompt JSON
- raw validation response
- validation method and whether execution was queued
- all-source-node prompt map
- node_errors summary
- intended output-node status
- fixes applied or remaining blockers
- runtime-policy variant prompt and change notes, only if Step 6 needs an explicit policy/schema compatibility variant
- branch prompt manifest for Step 07, including generated wrapper prompts for terminal non-output branches
- `completion_decision`

## Hard stops

Stop if intended output nodes are pruned, required inputs are missing, validation errors remain on the critical path, or a fix would change workflow semantics without explicit approval.

If a runtime-policy variant is needed, stop before Step 7 until the variant validates with all intended output nodes present.

Do not hard-stop only because a terminal branch node is not an `OUTPUT_NODE`; instead classify it and generate a wrapper branch prompt for Step 07, then require the wrapped branch prompt to be smoke-tested.

## Prior-migration lessons

Dasiwa showed that `execution_success` can be misleading when the intended output node never ran. Widget-only/literal nodes and selector-backed names were recurring prompt-export hazards.

Zimage showed that `/prompt` is not a validation-only endpoint: when a prompt validates, it is queued for execution. Zimage also showed that generic exporter widget-order drift can create false validation errors, while preserved workflow values such as `cuda:0`, an old QwenVL preset string, or an oversized seed are real workflow/runtime-policy blockers that must not be silently rewritten.

Zimage Step 6b showed the right boundary for this situation: a runtime-policy validation variant is not an original workflow step and not branch smoke. It is an explicit Step 6 sub-pass used to prove that documented schema/device policy changes make the API prompt structurally valid before any runtime execution.

Zimage v2 Step 06 showed converter-specific hardening requirements: `Note Plus (mtb)` and rgthree frontend-only control nodes must be classified out of the API prompt; seed widgets may include an extra UI-only control value; selector values with workflow subfolders such as `z-image/...` and `flux2/...` must be preserved when the runtime selector list exposes subpaths; and `SeedVR2VideoUpscaler` is a terminal non-output branch that needs a generated Step 07 preview wrapper rather than being counted as a failed validation output.

## Example output shape

```text
Prompt validation: failed
node_errors: node 54 value_not_in_list for lora_name
Intended output node: 208
Output status: pruned because upstream validation failed
Validation method: execution.validate_prompt, no queued execution
Decision: fix selector basename normalization before runtime testing
Forbidden next step: do not run full validation from this prompt
```

Runtime-policy variant example:

```text
Prompt validation: passed after explicit runtime-policy variant
Variant prompt: 06b-runtime-policy-prompt.json
Changed inputs: node 30 device cuda:0 -> xpu:0; node 93 seed normalized to current schema range
Source workflow modified: no
Nodes bypassed: no
Queued execution: no
Allowed next step: Step 7 branch smoke, still not full validation
```

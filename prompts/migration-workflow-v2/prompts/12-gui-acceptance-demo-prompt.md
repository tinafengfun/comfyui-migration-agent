**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# GUI acceptance and demo prompt

## Task

Prepare a clean ComfyUI GUI environment for manual end-to-end acceptance and demo.

## Required context

- Step 11 delivery bundle
- deployment guide and patch inventory
- runtime-policy API prompt and change notes
- source workflow JSON
- custom-node and asset ledgers
- known gaps and support matrix
- customer/manual test plan

## Constraints

1. Do not modify the source workflow in place.
2. Do not bypass, disable, remove, collapse, or replace nodes to make the GUI run pass.
3. The GUI workflow must make runtime-policy changes explicit; do not present it as source-identical.
4. The clean environment must have patches applied before GUI validation.
5. Model locations must be configured explicitly, either through `extra_model_paths.yaml`, symlinks/copies, or both.
6. Manual acceptance must record operator, environment, prompt/workflow version, output files, and pass/fail notes.
7. GUI acceptance is not complete until a human runs the workflow end to end and signs off on generated outputs.
8. If the tester needs remote browser access, bind ComfyUI to the requested interface/IP and verify that exact URL, not only localhost.
9. Before asking for human GUI execution, provide a clear workflow-difference/compromise summary comparing the current tested workflow JSON with the original/source workflow JSON.

## Steps

1. Create or update a clean-environment GUI acceptance guide.
2. Prepare a script/checklist that stages custom nodes, applies patches, writes model-path configuration, and launches ComfyUI for GUI use.
3. Generate a full GUI workflow JSON for manual validation/demo:
   - preserve the original graph and intended outputs
   - apply approved runtime-policy/schema changes
   - use full/high-fidelity settings unless a reduced demo mode is explicitly requested
   - set output prefixes so demo artifacts are easy to identify
4. Include a model-path configuration file such as `extra_model_paths.yaml`.
5. Include an operator acceptance checklist and run record template.
6. Generate a human-facing workflow diff summary that lists graph topology preservation, every workflow JSON widget/metadata change, and every non-JSON compromise such as asset substitutions or reduced/cache-assisted validation.
7. Update delivery artifact index and support boundaries.
8. Verify the generated workflow is valid JSON and that required deployment inputs exist.
9. Start or restart the GUI service on the agreed bind address and port, avoiding conflicts with existing ComfyUI instances.
10. Verify `/system_stats`, workflow import readiness, required node registration, and key model selector options from the same address that the tester will use.
11. Record PID, URL, server log, launch flags, and any non-blocking startup warnings.
12. If no human operator run is performed in the current session, end as `human_gate_reached`, not `complete`. Include the exact human gate prompt, safe reply template, and continuation edge for accepted/rejected/blocked outcomes.

## Output

Create GUI acceptance artifacts with:

- `gui_workflow_json`
- `model_path_config`
- `environment_prepare_script`
- `launch_command`
- `manual_acceptance_checklist`
- `run_record_template`
- `known_boundaries`
- `workflow_diff_summary`
- `demo_output_expectations`
- `service_url`
- `pid_and_log`
- `manual_result`
- `completion_decision`
- `human_gate_prompt` when signoff is pending

## Hard stops

Stop GUI acceptance preparation if:

1. the generated GUI workflow cannot preserve the full intended graph
2. a required patch cannot be applied reproducibly
3. model paths cannot be resolved in a clean environment
4. the workflow would require bypassing or disabling nodes
5. the package would claim customer acceptance before a human run exists
6. the requested bind address is not present on a local interface or the service cannot be reached through the tester URL
7. the tester cannot see exactly how the tested workflow differs from the original/source workflow and what compromises bound the result

## Prior-migration lessons

Dasiwa and Zimage showed that API delivery is not the same as GUI/customer acceptance. A final demo package needs a runnable GUI workflow, patched clean environment, explicit model-path wiring, generated outputs, and a human acceptance record. Zimage Step 12 also showed that demo readiness must include practical service details: avoiding port conflicts, rebinding to the tester-visible IP, checking `/system_stats` through that IP, and recording PID/log/URL for handoff.

Zimage v2 Step 12 showed that preparation/readiness can be automated, but final GUI/manual acceptance remains a human gate. The tool may generate a runtime-policy GUI workflow, launch/checklist artifacts, service readiness evidence, and manual run templates; it must not mark GUI/manual acceptance complete without operator output evidence and signoff.

Zimage v2 also showed that Step 12 must be explicit about the tested workflow versus the original workflow. The handoff must state graph topology changes, runtime-policy widget changes, output-prefix/metadata changes, model substitutions, reduced/full-size boundary, cache boundary, and whether GUI/customer acceptance has actually happened.

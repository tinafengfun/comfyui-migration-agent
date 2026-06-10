### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 15 `ask_user` rounds per step; after round 15, apply your best judgment and proceed.

# GUI acceptance and demo skill

## Use when

Use after Step 11 delivery packaging when the next goal is a clean-environment GUI/manual end-to-end validation or customer demo.

## Inputs

- Step 11 delivery bundle
- source GUI workflow JSON
- runtime-policy API prompt and notes
- patch bundle
- asset/custom-node ledgers
- validation evidence and known gaps

## Algorithm

1. Establish the GUI acceptance boundary:
   - runtime-policy GUI workflow, source-identical workflow, or both
   - full fidelity or explicitly reduced demo mode
   - manual operator and target environment requirements
2. Prepare a clean ComfyUI environment recipe:
   - install or point to all required custom nodes
   - apply local compatibility patches
   - install curated portable dependencies
   - write model-path configuration
   - verify `torch.xpu.is_available()`
   - choose a GUI bind address/port that the tester can reach
   - avoid port conflicts with already-running ComfyUI instances
3. Convert the validated runtime-policy API settings back into a GUI workflow copy:
   - keep source workflow unchanged
   - preserve nodes and links
   - update only approved device/schema/tuning/output-prefix widget values
   - record every changed widget in notes
4. Create manual acceptance artifacts:
    - GUI workflow JSON
    - workflow diff/compromise summary
    - model-path config
   - prepare/launch script or checklist
   - operator run record template
   - output expectations and pass/fail criteria
5. Verify static correctness:
   - generated workflow is valid JSON
   - source workflow copy still matches original
   - no node count/link count loss unless explicitly explained
   - required model/custom-node roots exist or are documented as handoff requirements
   - required runtime node classes appear in `/object_info`
   - model selector options contain the expected staged assets
   - frontend-only or disconnected structural nodes are classified before treating missing `/object_info` keys as blockers
6. Keep claims scoped:
   - before a human run, status is `prepared for GUI acceptance`
   - after a human run, status can become `GUI/manual accepted` only with run evidence
7. Start the service and record runtime handoff details:
   - service URL
   - PID
   - launch flags
   - server log path
   - `/system_stats` evidence from the tester-visible URL
   - non-blocking startup warnings and why they do not affect the delivered workflow
8. If human GUI execution has not happened, document the exact operator prompt and continuation edges factually. Do NOT write `human_gate_reached` or `orchestrator_status` in artifacts — the system controls gating via `gate-signal.json`. Do not mark Step 12 complete from preparation evidence alone.

## Common failure signatures

- GUI workflow silently edits or deletes nodes from the source graph
- API-only prompt is provided but no GUI workflow is importable
- patches are documented but not applied in the clean environment
- model files are copied but `extra_model_paths.yaml` or custom-node-specific paths are missing
- demo output prefixes overwrite prior validation artifacts
- final report says customer accepted when only a package was prepared
- human tester is not told how the tested workflow JSON differs from the original workflow JSON
- service works on localhost but is not bound to the tester-visible IP
- another ComfyUI instance already occupies the intended port
- `/object_info` schema changes cause a false missing-selector failure because options are nested differently
- GUI/frontend structural nodes such as reroutes, notes, or disconnected bypass utilities are mistaken for runtime blockers
- preparation/readiness status is incorrectly upgraded to GUI/manual acceptance

## Evidence standard

Retain:

- generated GUI workflow JSON
- runtime-policy GUI workflow notes
- workflow diff/compromise summary showing graph preservation, widget changes, metadata changes, asset substitutions, and validation boundaries
- model-path configuration
- prepare/launch script
- patch application log or reproducible patch command
- manual acceptance checklist
- completed run record after the human test
- generated GUI output files and screenshots when available
- service URL, PID, launch flags, and server log
- `/system_stats` from the tester-visible bind address
- object-info readiness summary for runtime nodes and model selectors
- completion decision with `human_gui_run_completed` and `customer_ready_claim`

## Hard stops

Stop if the clean environment cannot resolve custom nodes, cannot find required models, cannot apply required patches, cannot bind to the requested tester-visible address, or requires bypassing nodes.

If the environment is ready but the operator has not run the workflow, document the blocker factually. The system will handle gating via `gate-signal.json` — do NOT write gate keywords in your artifacts.

## Output schema

`gui_workflow_json`, `model_path_config`, `prepare_script`, `launch_command`, `service_url`, `pid_and_log`, `manual_checklist`, `run_record_template`, `expected_outputs`, `known_boundaries`, `human_signoff_state`, `manual_result`.

Required Step 12 preparation artifacts:

- `12-gui-acceptance/12-runtime-policy-gui-workflow.json`
- `12-gui-acceptance/12-runtime-policy-gui-notes.json`
- `12-gui-acceptance/12-workflow-diff-summary.json`
- `12-gui-acceptance/12-workflow-diff-summary.md`
- `12-gui-acceptance/12-launch-gui.sh`
- `12-gui-acceptance/12-manual-acceptance-checklist.md`
- `12-gui-acceptance/12-manual-run-record-template.md`
- `12-gui-acceptance-summary.json`
- `12-gui-acceptance.md`
- `12-output-manifest.json`

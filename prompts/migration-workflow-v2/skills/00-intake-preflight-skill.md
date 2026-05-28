# Intake and dependency-source preflight skill

## Use when

Use as Step 00 before asset acquisition, feasibility analysis, environment setup, or runtime validation.

This skill is deliberately static and bounded. It creates the first durable dependency/source map so Step 01 can do asset and custom-node resolution without relying on chat memory or repeated ad hoc searches.

## Inputs

- workflow JSON path
- artifact folder
- configured model roots such as `ComfyUI/models`, `/home/intel/hf_models`, `/tmp/hf_models`, shared disks, or workflow cache roots
- planned acquisition/staging root, if known
- input media roots such as task `input/`, `ComfyUI/input`, or user-provided media folders
- custom-node root such as `ComfyUI/custom_nodes`
- local source notes such as `model_repo`, workflow note nodes, embedded URLs, installed package metadata, node-manager maps, or operator notes
- source context file paths and provider policy supplied to the task
- expected target or fidelity, if already known

## Algorithm

1. Parse the workflow JSON without modifying it.
2. Record workflow SHA-256 and source-workflow copy path when available.
3. Count nodes and links, list output nodes, and extract node types.
4. Build an all-node scan coverage table from the source workflow. Include every node ID, node type, title/label, mode/status, group/subgraph context when present, inbound/outbound link counts, and whether widgets/properties/metadata were scanned.
5. Verify `source_node_count == scanned_node_count`. If not, stop and report the missing node IDs.
6. Extract model filenames, LoRA/VAE/CLIP/UNet/checkpoint selectors, input image/video filenames, and source hints from every node's widgets, inputs, properties, metadata, and notes.
7. Preserve node ID, node type, field path, raw value, normalized requested name, dependency kind, expected folder, exactness requirement, and Step 01 query keys for each extracted dependency.
8. Check only local filesystem roots that were explicitly provided. Use exact filename checks first; do not search provider APIs or probe remote URLs.
9. Check input/media roots for exact input filenames.
10. Check custom-node local evidence: installed package directories, local Git remotes/commits, local extension maps, `properties.cnr_id`, and local metadata already present on disk.
10a. For each custom-node directory found, verify it contains at least one `.py` file (non-empty installation). Mark directories that exist but are empty, contain only broken symlinks, or lack Python files as `environment gap` instead of `source known`. This distinction is critical: an `environment gap` custom node needs install/clone in Step 05, not just source search in Step 01.
11. Classify each dependency as `staged`, `source known`, `source hinted for Step 01`, `source unknown`, `access blocked`, or `smoke-only alias candidate`.
12. Build `step01_work_queue` entries for every source-hinted, source-unknown, access-blocked, source-known-but-unstaged, smoke-only alias, or custom-node-source item.
13. Record provider/download policy for Step 01: allowed provider names, download enabled/disabled, proxy/token environment variable names, and credential presence flags only.
14. Decide whether Step 01 can start automatically, whether human source context is required first, and whether Step 01 can be skipped.
15. Write only `00-intake-preflight.md`. For large workflows, also write `00-node-scan.csv`, but keep the scan count and missing-node summary in the Markdown report.

## Toolization boundary

Step 00 should be implemented as a deterministic read-only intake/scanner tool where possible. Useful tool functions:

- `workflow.parse`: read workflow JSON, count nodes/links, compute SHA-256.
- `workflow.scan-nodes`: emit all-node coverage with node IDs, types, modes, links, widgets/properties scanned.
- `workflow.extract-dependencies`: emit node-to-dependency rows and source-hint rows.
- `local.check-assets`: exact local file checks under configured model/input roots only.
- `local.check-custom-nodes`: local custom-node path, metadata, `cnr_id`, git remote, and commit discovery.
- `handoff.build-step01-queue`: create `step01_work_queue` with query keys, target paths, allowed providers, exactness, and human gates.

Do not use provider/network search, SSH search, clone, or download functions in Step 00. If the Step 01 asset acquisition package exposes shared helpers, Step 00 may reuse only pure parsing, target-path routing, redaction, and local-only checks. Search and download commands remain Step 01-owned.

## Evidence standard

The Step 00 report must preserve enough evidence for a new Step 01 session to continue without chat history:

- workflow path and artifact folder
- workflow SHA-256 and source-workflow copy path
- model roots and custom-node roots checked
- input/media roots checked
- planned staging/acquisition root when known
- source-note files, source context paths, or workflow note nodes parsed, with credentials redacted
- provider/download policy for Step 01 with token/proxy values omitted
- node/link/output counts
- source node count, scanned node count, missing node IDs, and all-node scan coverage
- exact requested dependency names, source node IDs, field paths, raw values, normalized names, expected folders, search keys, exactness requirement, and local/source state
- custom-node node IDs, type/package hints, local path, git remote/commit when locally available, and source state
- Step 01 work queue
- hard stops and human inputs needed
- explicit next step

Record source hints as hints. Do not convert a HuggingFace/Civitai/GitHub/SSH URL into "reachable" unless a later Step 01 search/acquisition actually verifies it.

## Hard stops

Stop Step 00 and ask for human context only when Step 01 cannot even start safely:

- the source workflow file is unreadable or malformed
- no artifact folder is available
- a critical private source is referenced but no approved credential/source channel is available
- continuing would require guessing model identity, replacing nodes, bypassing nodes, or changing workflow semantics
- the only available evidence contains secrets that cannot be safely redacted
- the workflow cannot be scanned node-for-node from the source JSON

## Completion criteria

Step 00 is complete when `00-intake-preflight.md` exists and:

1. source node count equals scanned node count;
2. every source node is represented in the all-node scan table or linked `00-node-scan.csv`;
3. every visible dependency is named, mapped to node ID(s), and classified;
4. every dependency has field path, raw value, normalized requested name, expected folder, query keys, and next action;
5. every custom-node type has node ID(s), package/source hint, local evidence, and Step 01 action;
6. every unknown, access-blocked, source-hinted, source-known-but-unstaged, or smoke-only item has a Step 01 work-queue item or human action;
7. provider/download policy is recorded without credential values;
8. the report says `can_start_step01` and `can_skip_step01_and_continue_to_feasibility`;
9. no remote/provider/SSH search, download, clone, install, runtime validation, workflow edit, or node bypass occurred;
10. no secrets are written to artifacts.

The step may complete with dependency gaps. Gaps become Step 01 work items; they are not a reason to run unbounded search inside Step 00. It may not complete with node-scan gaps.

## Output schema

`workflow`, `workflow_sha256`, `source_workflow_copy`, `artifact_folder`, `model_roots_checked`, `input_roots_checked`, `planned_staging_root`, `source_context_paths`, `provider_and_download_policy`, `model_source_notes`, `source_hint_table`, `custom_node_roots_checked`, `custom_node_source_notes`, `credentials_handling`, `node_count`, `link_count`, `output_nodes`, `source_node_count`, `scanned_node_count`, `missing_node_ids`, `node_scan_coverage`, `required_models`, `required_input_media`, `required_custom_nodes`, `asset_extraction_table`, `custom_node_package_table`, `dependency_states`, `step01_work_queue`, `hard_stops`, `human_inputs_needed`, `can_start_step01`, `can_skip_step01_and_continue_to_feasibility`, `next_step`.

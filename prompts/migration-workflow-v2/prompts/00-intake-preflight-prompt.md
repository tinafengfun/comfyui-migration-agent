# Intake and dependency-source preflight prompt

Use this prompt before asset acquisition and feasibility analysis. Its purpose is to perform a fast local/static intake so the workflow can be routed honestly to Step 01 for deep source search and acquisition.

This step does **not** search the public web, probe URLs, call provider APIs, SSH to remotes, download assets, install models, install custom nodes, modify workflow JSON, patch source code, or run ComfyUI.

Step 00 can complete with dependency gaps. A missing model, input file, or custom-node source is not a Step 00 failure if the report names the exact gap, records any local/source hints, and routes it to Step 01. Step 00 fails only when the intake artifact is incomplete, credentials leak, workflow semantics are changed, or the step performs work that belongs to Step 01+.

## Task

Analyze the target ComfyUI workflow and produce an intake/dependency-source preflight report.

The report must answer:

1. Which model files, input media, and custom node types does the workflow require?
2. Which dependencies are already staged in configured local roots?
3. Which source hints are declared in workflow notes, metadata, or local custom-node evidence?
4. Which dependencies need Step 01 source search/acquisition?
5. Whether Step 01 can continue automatically or should ask for source context first.
6. Which exact node IDs and widget/property paths produced each dependency or source hint.
7. Which bounded Step 01 work items should be attempted first, with query keys, expected target paths, and human-decision gates.

## Required context

- workflow JSON path
- planned artifact folder
- model roots to check, such as `ComfyUI/models`, `/home/intel/hf_models`, `/tmp/hf_models`, or shared model disks
- planned model/acquisition staging root, if known
- input media roots to check, such as task `input/`, `ComfyUI/input`, or user-provided media folders
- source notes such as `model_repo`, workflow notes, model-link notes embedded in the workflow, or private handoff notes; parse these as hints only, do not verify remote reachability in Step 00
- custom-node roots to check, usually `ComfyUI/custom_nodes`
- custom-node source notes, such as installed package list, Git remotes already present locally, node-manager extension map, workflow author notes, or package hints
- source context file paths passed to the run, such as `model_repo`, `huggingface_mode.md`, custom-node source maps, or operator handoff notes
- network/acquisition policy for Step 01, including allowed providers, whether downloads are allowed, and which proxy/token environment variable names are available; never record token values
- expected migration target, if already known

## Constraints

1. Do not install models.
2. Do not install custom nodes.
3. Do not modify the workflow.
4. Do not bypass, delete, collapse, or replace nodes.
5. Do not run expensive validation jobs.
6. Do not write credentials, tokens, passwords, or private connection strings into artifacts.
7. Do not treat a similarly named model as source-identical unless the source, filename, size, and intended folder match or a human approves a smoke-only alias.
8. Do not run URL, repository, SSH, HuggingFace, ModelScope, Civitai, GitHub, or other provider searches in Step 00.
9. Do not download or clone anything in Step 00.
10. Do not continue silently when a critical custom-node source is unknown; mark it for Step 01 acquisition or human context.
11. Scan **every node in the source workflow**, including disconnected nodes, muted/bypassed nodes, notes, reroutes, groups, and non-output branches. Do not limit Step 00 to output nodes, critical paths, or nodes that look executable.
12. If the source node count and scanned node count differ, stop Step 00 as incomplete and report the missing node IDs instead of continuing.
13. Do not invoke the provider search/download tool in network, SSH, clone, or download mode. Step 00 may call only read-only/local intake tooling.

## Tool boundary

Step 00 is a good candidate for a dedicated read-only `workflow-intake` tool. That tool should:

1. parse workflow JSON and compute SHA-256;
2. produce all-node scan coverage;
3. extract node-to-dependency mappings with field paths, raw values, normalized names, expected folders, and exactness requirements;
4. check only configured local model/input/custom-node roots;
5. parse source hints and source context files with credentials redacted;
6. generate `step01_work_queue` and `provider_and_download_policy`.

Step 00 should **not** call the Step 01 provider search/download tool except, if implementation reuse is unavoidable, in an explicitly read-only/local-only mode that disables provider search, SSH, clone, and download. The preferred design is a separate Step 00 intake scanner and the Step 01 asset acquisition tool.

## Execution steps

1. Parse the workflow JSON.
   - Record the workflow path, source-workflow copy path if available, and workflow SHA-256.
   - Count nodes and links.
   - Build an all-node scan table with node ID, node type, title/label if present, mode/status if present, group/subgraph context if present, inbound/outbound link counts, and whether widgets/inputs/properties were scanned.
   - Extract every node type from the all-node table.
   - Extract model filenames, input media filenames, URLs, and repository notes from widgets, inputs, properties, metadata, and note nodes.
   - For each extracted dependency, preserve node ID, node type, widget/input/property path, raw value, normalized requested name, dependency kind, expected folder, and source-identical requirement.
   - Treat URLs/repository strings as source hints only; do not probe them.
   - Separate real source hints from ordinary prompt text. Long positive/negative prompts are not model-source notes unless they contain a path, URL, repo, provider hint, or explicit asset name.
   - Identify output nodes and obvious critical-path node types.

2. Check model and input dependency sources.
   - Check each declared model root for exact filenames.
   - Check each declared input/media root for exact input filenames.
   - Parse source notes such as `model_repo` for local, shared, remote, or public source hints, but do not verify remote/shared reachability.
   - Record whether each file is staged, source-hinted for Step 01, source-unknown, or access-blocked by missing local context.
   - Generate Step 01 query keys for each unresolved/staged-check item: original workflow value, basename, normalized POSIX path, parent folder hint, model family hint when obvious, and provider/source hints.

3. Check custom-node dependency sources.
   - Check whether each custom node type is registered or present in the current custom-node tree.
   - Check extension maps available locally, package metadata already present locally, `properties.cnr_id`, source notes, local Git remotes, or workflow notes for missing node types.
   - Record node IDs for each custom-node type, package/repo hints, local path if present, git remote and commit if available, and whether the source package is locally staged, source-hinted for Step 01, unknown, or access-blocked.

4. Identify Step 01 routing gates before feasibility.
   - required source-identical model source is unknown
   - required input media is missing and has no known source
   - critical custom-node source is unknown
   - private repository or credentials appear required but are not provided through an approved channel
   - workflow dependency source changes the task from migration into asset acquisition or feature discovery

5. Produce `00-intake-preflight.md` in the planned artifact folder.

## Required output shape

```text
workflow:
workflow_sha256:
source_workflow_copy:
artifact_folder:
model_roots_checked:
input_roots_checked:
planned_staging_root:
model_source_notes:
source_context_paths:
source_hint_table:
custom_node_roots_checked:
custom_node_source_notes:
provider_and_download_policy:
remote_or_shared_source_hints:
credentials_handling:
node_count:
link_count:
output_nodes:
source_node_count:
scanned_node_count:
missing_node_ids:
required_models:
required_input_media:
required_custom_nodes:
node_scan_coverage:
all_nodes_scanned:
asset_extraction_table:
custom_node_package_table:
dependency_states:
step01_work_queue:
hard_stops:
human_inputs_needed:
can_start_step01:
can_skip_step01_and_continue_to_feasibility:
next_step:
```

Use these dependency states:

```text
staged
source known
source hinted for Step 01
source unknown
access blocked
smoke-only alias candidate
```

## Report tables

Include at least these tables.

### All-node scan coverage table

| Node ID | Node type | Title / label | Mode / status | Link role | Widgets/properties scanned? | Dependency references found | Step 01 action |
| --- | --- | --- | --- | --- | --- | --- | --- |

The table must account for every source workflow node. For large workflows, the report may link to `00-node-scan.csv`, but `00-intake-preflight.md` must still include source node count, scanned node count, and missing node IDs.

### Model and input source table

| Node ID(s) | Node type | Field path | Raw value | Requested asset | Asset kind | Expected folder | Local status | Source hint / source path | State | Step 01 query keys | Human action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Custom-node source table

| Node ID(s) | Node type | Critical path? | Local installed / registered evidence | `cnr_id` / package hint | Local path | Git remote / commit | Source package or repo | State | Step 01 action | Human action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Source hint table

| Hint ID | Node ID / file | Hint kind | Raw hint | Parsed provider/path/repo | Credential needed? | Step 01 use |
| --- | --- | --- | --- | --- | --- | --- |

### Step 01 work queue

| Work item ID | Kind | Source node ID(s) | Requested name / package | Search keys | Expected target path | Approved providers | Exactness required | Current state | Human gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Preflight decision

| Decision item | Result |
| --- | --- |
| Source node count | |
| Scanned node count | |
| Missing node IDs | none / list |
| Can start Step 01? | yes / no / human-input-required |
| Can skip Step 01 and continue to feasibility? | yes / no |
| Blocking model/input gaps | |
| Blocking custom-node gaps | |
| Credentials omitted from artifacts? | yes |
| Next artifact | `01-assets.csv` / `01-custom-nodes.md`; Step 01 owns search/download/acquisition |

## Completion criteria

Step 00 is complete when all of the following are true:

1. `00-intake-preflight.md` exists in the artifact folder.
2. The report lists workflow path, workflow SHA-256, node/link counts, output nodes, required model/input/custom-node dependencies, local/input/custom-node roots checked, source context paths, and source notes parsed.
3. Source node count equals scanned node count, and missing node IDs is `none`.
4. Every node has an entry in the all-node scan coverage table or linked `00-node-scan.csv`.
5. Every dependency row includes node ID(s), field path, raw value, normalized requested name, dependency kind, expected target folder, state, query keys, and next action.
6. Every custom-node row includes node ID(s), node type, package/repo hint, local evidence, source state, and Step 01 action.
7. Unknown or unstaged dependencies are routed into `step01_work_queue`, not treated as hidden success.
8. Provider/download policy is recorded as names and booleans only, with token/proxy values omitted.
9. The report explicitly states whether Step 01 can start, whether Step 01 can be skipped, and what human input is required.
10. The step did not perform URL/API/SSH/provider search, download, clone, install, workflow edit, node bypass, or ComfyUI execution.
11. No credential, token, private key, password, or private connection string appears in the artifact.

Step 00 is not complete if it only scans output/critical nodes, omits disconnected/muted/bypassed/non-output nodes, says "assets missing" without exact names and source hints, waits on long remote searches, produces a Step 01-style acquisition report, or claims feasibility/runtime success.

## Hard stops

Do not perform deep search in Step 00. Mark the following as Step 01 gates and ask for human direction only if there is no actionable source hint:

1. the model repository/source is unknown for a required source-identical model
2. the custom-node source is unknown for a critical output path
3. access to a private/shared dependency source appears required but no approved credential/source channel is provided
4. the workflow input image/video is missing and no source is known
5. continuing would require guessing model identity, replacing nodes, or changing workflow semantics

If source hints exist but are not verified, set `can_start_step01: yes`, `can_skip_step01_and_continue_to_feasibility: no`, and route to Step 01. Step 01 decides whether to search, download, clone, or pause for human intervention.

## Example command prompt

```text
根据 ComfyUI/docs/draft/migration-workflow-v2/prompts/00-intake-preflight-prompt.md，
对 <workflow.json> 做 dependency-source preflight。
模型源和 custom-node 源参考 <model_repo 或项目来源说明>。
输出只写到 <artifact_folder>/00-intake-preflight.md。
不要搜索 URL/仓库/API，不要 SSH，不要下载，不要安装模型，不要安装 custom node，不要改 workflow，不要写凭据。
如果模型源或关键 custom-node 源未知，明确列为 Step 01 gate；有线索但未验证时标记 deferred to Step 01。
```

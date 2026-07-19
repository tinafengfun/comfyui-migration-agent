**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Asset and custom-node resolution prompt

## Task

Resolve all workflow dependencies: models, LoRAs, input media, custom nodes, nested repositories, and optional services.

This is Step 01 in the v2 migration workflow. It is the first step that may perform broad source search and controlled acquisition. Consume Step 00 as an inventory/routing artifact; do not repeat Step 00's full preflight except to validate changed inputs or missing evidence.

## Required context

- workflow JSON
- model roots and `/tmp/hf_models` or shared cache paths
- planned staging/acquisition root and expected target paths
- input media roots and task input folder
- custom-node directory
- network/download policy
- Step 00 preflight artifacts, especially `00-intake-preflight.md`, `00-node-scan.csv`, `00-asset-extraction.csv`, `00-step01-work-queue.csv`, workflow path/copy, `workflow_sha256`, all-node scan coverage, `asset_extraction_table`, `custom_node_package_table`, `source_hint_table`, `provider_and_download_policy`, and `step01_work_queue`
- approved source context such as `model_repo`, `huggingface_mode.md`, SSH source hints, local source roots, provider tokens available only in runtime environment variables, and operator-provided notes

## Constraints

1. Treat workflow-side `LoadImage` or video assets as first-class dependencies.
2. Do not hide missing proprietary assets.
3. Mark compatibility aliases as smoke-only unless source identity is proven.
4. Keep source resolution, dependency acquisition, installation, and validation as separate states.
5. Downloading a model or cloning a custom-node repository into a workflow cache is not proof that ComfyUI can load it.
6. Do not write credentials, tokens, passwords, or private connection strings into artifacts.
7. Restart ComfyUI after installing or patching custom nodes before trusting validation.
8. Do not redo broad source searches in later steps unless a later validation error introduces a new concrete dependency.
9. Do not mark Step 01 complete while downloads, copies, clones, checksum checks, or source searches are still running.
10. Do not claim ComfyUI registration, XPU compatibility, prompt validation, branch smoke, or output quality from Step 01 evidence.
11. Scan dependency requirements for **every node reported by Step 00**, not only output nodes, critical paths, or nodes already known to need models.
12. If Step 00 has missing node-scan coverage, first attempt a bounded read-only handoff repair from the source workflow and existing artifacts. If node coverage still cannot be proven, block provider search/download only for the affected scope and record the issue in `improve.md`.
13. If Step 00 lacks node ID to dependency mappings, field paths, query keys, target folders, source context paths, or provider/download policy, classify the handoff gap. Repair locally/read-only when safe; otherwise block only affected work items and record the missing contract in `improve.md`.

## Process reflection from the Zimage v2 run

The clean Zimage v2 run exposed these Step 01 design issues and the required fixes:

1. Step 00 output is sufficient for Step 01 only when it includes full node coverage, node-to-dependency mapping, query keys, target paths, source context, provider policy, and a Step 01 work queue. Step 00 must not search providers or download, but it must provide enough structured handoff data for Step 01 to do so.
2. Workflow metadata model URLs are source hints, not required dependencies. Required assets come from active workflow selectors and wrapper-source hidden assets.
3. Local aliases or substitutes can be staged only with explicit human approval and a non-source-identical claim boundary.
4. Public custom-node sources should not be human-gated merely because they are not staged; Step 01 should automatically search GitHub/`comfy.icu`, clone to the isolated workspace, initialize submodules, and record commits when policy allows it.
5. Human gates must be executable communication prompts. A vague "missing assets" gate is invalid.
6. Step 01 must end by producing a machine-readable output manifest so Step 02 can run in a fresh session without relying on chat memory.

## Step 00 input completeness gate

Before provider search/download/clone, classify whether Step 00 produced enough input for Step 01:

```text
workflow_path:
workflow_sha256:
source_workflow_copy:
source_node_count:
step00_scanned_node_count:
step00_missing_node_ids:
node_scan_artifact:
asset_extraction_artifact:
step01_work_queue_artifact:
staging_root:
model_roots_checked:
input_roots_checked:
custom_node_roots_checked:
provider_and_download_policy:
credential_env_var_names_only:
source_context_paths:
input_completeness: complete / repairable_gap / item_human_gate / step_hard_stop
```

Step 00 is sufficient when:

- `source_node_count == step00_scanned_node_count`;
- `step00_missing_node_ids` is empty;
- every unresolved or source-known dependency has a Step 01 work item with source node ID(s), kind, requested name/package, query keys, expected target path or package destination, approved providers, exactness/alias policy, current state, and human-action note;
- local evidence and source hints are separated from required dependencies;
- provider/download policy names allowed sources and credential environment variable names without secret values.

If fields are missing, Step 01 may perform bounded read-only repair from the source workflow and existing Step 00 artifacts. Do not reconstruct from chat memory. If safe minimum inputs remain missing, block only affected work items and write the gap to `improve.md`.

## Full-scan constraint

Step 01 must produce dependency coverage for every source node Step 00 reported, including disconnected, muted/bypassed, note, reroute, group, non-output, non-critical-path, and reference nodes.

The final Step 01 artifacts must include:

- `source_node_count`;
- `dependency_scanned_node_count`;
- `missing_dependency_scan_node_ids`;
- `01-node-dependency-scan.csv` with one row per source node;
- rows that explicitly say `no asset dependency` when a node has no model/input/custom-node/service dependency.

Step 01 may not reach `resolved/staged` or `human gate` if any Step 00 node is missing from the dependency scan. Missing scan rows are a Step 01 hard stop until repaired or precisely human-gated.

## Steps

1. Read Step 00's all-node scan coverage table or `00-node-scan.csv`; verify source node count, scanned node count, and missing node IDs. If this evidence is incomplete but the source workflow is available, run a bounded read-only repair pass and record what was repaired.
2. Validate the Step 00 handoff: every Step 01 work item should include node ID(s), kind, requested name/package, query keys, expected target path, allowed providers, exactness requirement, current state, and human gate. For missing fields, classify whether Step 01 can repair them safely, must skip only that item, or needs human input.
3. For every source node, extract model, LoRA, VAE, CLIP, UNet, checkpoint, image, mask, video, repository, service, and custom-node package references. If a node has no asset dependency, record `no asset dependency`.
4. For every selected custom-node type, inspect the node wrapper source for hidden/default model assets, especially `from_pretrained()`, `hf_hub_download()`, `snapshot_download()`, `load_file()`, `torch.load()`, default `ckpt_name`, and package-specific cache directories. If source is unavailable, record `wrapper scan blocked` for the affected node/type.
5. Search local roots first, then approved source registries/remotes/providers in this order. When the reusable asset tool pool is available, use it to keep search/download/clone logs out of the agent context:
   - explicit local roots and staged workflow cache
   - exact SSH/shared-disk filename search
   - explicit HuggingFace file/repo URLs, then HuggingFace-compatible mirrors such as `hf-mirror.com` and `huggingface.co`
   - `www.civitai.com` and other approved model providers
   - GitHub repositories and `comfy.icu` for custom nodes
   - operator-provided source notes
6. Record whether each dependency is already staged, source-known but not staged, source-unknown, access-blocked, runtime-auto-download hidden asset, or a smoke-only alias candidate.
7. If hard stops are caused by `source reachable but not staged` dependencies, run a bounded acquisition/staging pass before asking for human input when policy allows it. Copy/download exact model files into an isolated workflow cache that mirrors ComfyUI's model layout and the custom node's own cache layout, or record why policy/access/exactness blocks the item.
8. If required custom-node sources are public and unambiguous, automatically search GitHub and `comfy.icu`, verify the selected repository, clone the source repositories into the isolated workflow cache, initialize declared submodules, and record upstream commits. Ask for human input only when provider policy, ambiguity, private access, clone failure, or hidden-asset staging blocks this.
9. Do not mark cloned custom-node repositories as installed/registered until environment deployment and prompt validation prove that.
10. Record unresolved sources and any aliases.
11. Write `01-output-manifest.json` that lists every Step 01 output artifact, completion signals, route constraints, and hashes so Step 02 can consume Step 01 without chat memory.

## Tool invocation

**The backend already ran structured provider search before this session started.** After deterministic prep (`01-assets.csv`/`01-custom-nodes.md`) finds a gap, the backend automatically runs the same provider search tool (HuggingFace/Civitai/ModelScope/GitHub) against multiple fuzzy query variants of each unresolved name (stripped parenthetical hints, stripped CJK descriptive words, stripped stale version suffixes) — read `01-acquisition-job.json` first; do not treat "not found locally" as license to skip straight to a human gate. If provider search still found only ambiguous candidates (not an exact filename match), an isolated LLM call already judged them and wrote `01-fuzzy-match-judgments.json` (confidence + reasoning per item, using its own `web_search`/`web_fetch` tool when the pre-fetched candidates weren't enough — this is how a mangled/relabeled filename like a workflow's own descriptive nickname for a LoRA gets traced back to its real upload). Review these before doing your own search: verify the judgment's reasoning against the workflow's actual needs (does the strength range/model family/purpose really match?) rather than re-running raw search from scratch. You may still use your own `web_search`/`web_fetch` tool for anything the automated pass didn't resolve or got wrong — never treat a fuzzy judgment as ground truth to auto-apply; a human still explicitly decides at the gate.

Step 01 owns the provider search/download tool. Use it from `step01_work_queue`, not from ad hoc chat context:

1. For each work item, run search using the Step 00 query keys, expected target path, allowed providers, and source context paths.
2. Start with local exact checks and source-known copies, then SSH/shared source search if approved, then provider APIs such as `hf-mirror.com`, `huggingface.co`, `www.civitai.com`, GitHub, and `comfy.icu`.
3. Run downloads or clones when the network/download policy allows it and credentials, if needed, are available through runtime environment variables. Public, unambiguous custom-node GitHub clones into the isolated workspace are Step 01 default behavior when policy allows clone.
4. Write provider attempts, redacted commands/URLs, target paths, bytes, checksums, repository commits, submodule commits, and failure reasons into Step 01 artifacts.

### Custom-node search/clone tool contract

For every `custom_node` work item:

1. call the provider tool with `kind: "custom_node"` and Step 00 query keys;
2. search GitHub repository API and `comfy.icu`;
3. prefer exact package/CNR/workflow hints over fuzzy search results;
4. verify the public GitHub repository is reachable and not archived;
5. clone into the expected workspace path under `cache/custom_nodes/`;
6. initialize `.gitmodules` submodules when declared;
7. scan the staged wrapper source for hidden runtime asset patterns;
8. write `01-custom-node-provider-search.json`, `01-custom-node-github-verify.txt`, `01-custom-node-source-acquisition.json`, and update `01-custom-nodes.md` plus `01-node-dependency-scan.csv`.

Do not human-gate a custom node solely because its public source is "reachable but not staged". Gate only for ambiguous candidates, private/archived/unreachable repositories, missing target path, non-empty target collision, clone/submodule failure after bounded retries, policy denial, credential needs, or hidden runtime assets that cannot be staged.

Step 01 should not ask Step 00 to download. If Step 01 discovers a new concrete dependency that Step 00 could not know without wrapper-source inspection, record it as Step 01 hidden-runtime-asset evidence and add it to the Step 01 ledger.

## Output

Create Step 01 artifacts with enough evidence for Step 02:

- `01-assets.csv`
- `01-custom-nodes.md`
- `01-node-dependency-scan.csv`
- provider/search/acquisition JSON or text artifacts when search/download/clone occurred, such as `01-provider-search-models.json`, `01-custom-node-provider-search.json`, `01-custom-node-github-verify.txt`, and `01-custom-node-source-acquisition.json`
- `01-acquisition-summary.json`
- `01-output-manifest.json`

The ledgers must include:

- requested name
- resolved path or missing status
- source URL/cache/source root
- staged path
- custom-node cache path or hidden runtime-download path, if applicable
- source-identical, compatibility alias, or unresolved
- custom-node repo, commit, install status, and notes
- acquisition log when downloads or clones occurred, including source path, target path, file size, repo commit, and remaining hard stops
- attempted source list and failure reasons when all providers fail, so the frontend can show a human-intervention gate with concrete next actions
- source node count, dependency-scanned node count, and missing dependency-scan node IDs
- node dependency scan coverage, with one row per source node: node ID, type, dependency references, hidden asset scan status, custom-node source status, resolved state, and gap/action. This may be a table in `01-custom-nodes.md` or a linked `01-node-dependency-scan.csv`.
- human decisions, approved substitutes/aliases, and downstream fidelity boundary
- `can_start_step02` and `step02_route_constraint`

## Completion criteria

Step 01 has exactly three valid terminal outcomes.

1. **Resolved/staged**: every required model/input/hidden runtime asset and every required custom-node source is resolved to an exact staged path, a human-approved substitute/alias with claim boundary, or a recorded cloned source commit. The ledger includes source, target path, size/checksum when available, cache path, commit evidence, and whether any alias/substitute is non-source-identical or smoke-only.
2. **Human gate**: after bounded local/SSH/provider attempts, unresolved items remain. The artifact lists exact missing assets, attempted providers, redacted commands/source URLs, failure reasons, and the human decision required.
3. **Hard stop**: Step 01 cannot safely continue under the current constraints, for example because source workflow/artifacts are unavailable, full node coverage cannot be proven, safe target paths cannot be established, required acquisition is policy-forbidden with no human decision path, or continuation would require modifying/bypassing workflow nodes.

`resolved/staged` and `human gate` require full node coverage: every source node from Step 00 must have a dependency scan row, even when the row says `no asset dependency`. `hard_stop` must name the exact condition that prevented reaching full coverage or bounded acquisition.

Step 01 is not complete if any Step 00 node is missing from the dependency scan, if provider candidates exist but files are not staged or explicitly human-gated, if a download/copy/clone/submodule job is still running, if hidden runtime assets were not inspected or explicitly blocked, if a smoke-only alias/substitute is undocumented or unapproved, if a custom-node clone is reported as installed/registered without later Step 05/06 evidence, if credentials appear in artifacts, or if `01-output-manifest.json` is missing.

## Step 02 handoff context

`01-output-manifest.json` and `01-acquisition-summary.json` must give Step 02 all context needed for a fresh session:

- workflow path, source copy, and `workflow_sha256`;
- artifact folder and list of Step 01 outputs with paths/hashes;
- source node count, dependency scanned count, and missing dependency scan IDs;
- asset totals, source-identical staged count, approved substitute/alias count, unresolved/access-blocked count;
- exact names, node IDs, source paths, staged target paths, sizes/checksums when available, and claim boundary for every approved substitute/alias;
- custom-node total, source-known/staged count, newly cloned repos, commit SHA, submodule SHA, and wrapper hidden-asset evidence;
- provider attempts and failure reasons for unresolved or substituted items;
- human decisions already made and remaining decisions, if any;
- `can_start_step02`;
- `step02_route_constraint`, especially non-source-identical, smoke-only, reduced-resource, unresolved dependency, or access-boundary notes.

## Human gate communication prompt

When Step 01 cannot resolve every required source-identical dependency after bounded attempts, emit a human-facing prompt with this structure. Do not ask a vague question such as "assets are missing"; name the exact problem, why the agent cannot decide safely, the exact action needed from a human, and the continuation edge after each possible decision.

This is a project-level communication constraint for Step 01: a human gate is invalid if a human cannot copy the prompt, make a decision, and know what the workflow will do next without reading chat history.

```text
Step 01 human gate: source-identical dependency decision required

Problem summary:
The workflow cannot proceed as a normal source-identical migration because the following dependencies are unresolved, access-blocked, or only available as smoke-only aliases. Step 01 has not modified the source workflow, has not bypassed nodes, and has not claimed runtime registration or XPU support.

Why the agent cannot decide:
- Source-identical assets require exact identity; similar filenames or partial downloads cannot be substituted automatically.
- Smoke-only aliases change the support claim and require human approval.
- Private/provider access, proxy, tokens, SSH sources, or non-public/ambiguous remote clones require human-approved runtime configuration.
- Custom-node source-known-but-not-staged is not install/registration evidence; public unambiguous sources should have been automatically staged by the Step 01 custom-node tool before this gate.

Unresolved items:
<table with item, kind, source node ID(s), expected target path, current state, attempts made, why the agent cannot decide, exact human action>

What the human must do:
1. Provide exact source-identical files or source locations for the unresolved items, including local path/source URL/repository and any required target folder mapping.
2. Or approve a bounded smoke-only continuation for named alias items, accepting that downstream reports must say source-identical fidelity is not proven.
3. Or provide runtime-only access configuration for approved providers, such as proxy/token environment variable names, without writing token values into artifacts.
4. Or resolve target-path/source ambiguity for a blocked work item.
5. Or stop the migration at the dependency gate.

Decision choices and continuation:
- A. Provide exact assets/sources: Step 01 reruns only affected work items, stages files into the isolated workflow cache, verifies size/checksum when available, updates `01-assets.csv` / `01-custom-nodes.md`, then reruns Step 02.
- B. Approve named smoke-only aliases: Step 01 records alias approval, Step 02 routes as bounded/non-source-identical, and Step 03 may continue inventory/source-audit with the claim boundary preserved.
- C. Provide runtime access/download/clone approval: Step 01 reruns only affected provider/search/download/clone work items using runtime environment variables and redacted logs, updates ledgers, then reruns Step 02.
- D. Stop: Step 01 records `human_gate` as final and no Step 02+ runtime work should proceed.

Reply format:
Decision: A / B / C / D
Exact assets/sources: <item -> local path/source URL/repo/target folder, if applicable>
Approved aliases: <item -> alias path and allowed claim boundary, if applicable>
Access configuration: <env var names or source channel only; no secret values>
Download/clone approval: <yes/no and affected item names>
Fidelity boundary: <source-identical / smoke-only / reduced-resource / stop>
Notes:
```

## Hard stops

Do not run provider search/download/clone for a work item that lacks safe minimum inputs: source node reference, requested name/package, expected target path or package destination, allowed providers, exactness requirement, and policy/credential handling. If Step 00 omitted these fields, Step 01 may repair them from the source workflow and artifacts using read-only logic; otherwise mark only the affected item as blocked/human-gated and add an entry to `improve.md`.

Stop before runtime if a critical source-identical model, input asset, or custom-node source is unavailable and the user has not approved a smoke-only alias or reduced-fidelity route.

If the source is known but not staged, stop normal migration work and run a bounded acquisition/staging pass before environment deployment. Public unambiguous custom-node sources should be searched and cloned automatically in Step 01 when policy allows it. Do not skip directly to runtime.

If all approved search/download candidates fail, surface a human gate from Step 01 with attempted providers, errors, and required missing assets. Do not push unresolved acquisition work into Step 02+ as repeated background searches.

Stop with `hard_stop` for Step 01 when full node coverage cannot be proven, required source workflow/artifacts are unavailable, a target path collision would overwrite non-workspace data, policy forbids acquisition and no human decision is available, or continuing would require modifying/bypassing workflow nodes.

## Prior-migration lessons

Dasiwa required explicit separation between public assets, compatibility aliases, and unresolved proprietary sources. Missing input images can block smoke runs even when model files exist.

Zimage showed that workflow-visible model selectors are not enough. `AIO_Preprocessor` selected `DepthAnythingV2Preprocessor`, whose checkpoint `depth_anything_v2_vitl.pth` came from a wrapper default and `hf_hub_download()` call rather than a visible workflow widget. Step 01 must inspect selected custom-node wrapper defaults and runtime auto-download code before saying assets are complete. If mirrors or tokens are used, record endpoint/source and downloaded file evidence, but never write credentials into artifacts.

Work-FIsh/Z-Image showed why Step 00 and Step 01 must stay separate. Step 00 should only identify local/static dependency state and defer URL/repository/provider work. Step 01 should own broad search, fallback download attempts, checksum/size verification, and human gates after all candidates fail.

## Example output shape

```text
Asset: example-model.safetensors
State: compatibility alias
Resolved path: models/checkpoints/example-model.safetensors
Source: local smoke asset, not original upstream source
Allowed claim: can validate graph reachability
Forbidden claim: source-identical output fidelity

Custom node: ComfyUI-example-node
Commit: <sha>
Install status: cloned to workflow cache, not installed in ComfyUI
Risk: source audit still required before XPU support claim

Hidden runtime asset:
Node: AIO_Preprocessor / DepthAnythingV2Preprocessor
Source evidence: node wrapper default ckpt_name and hf_hub_download call
Asset: depth_anything_v2_vitl.pth
Expected path: custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Large/
State: source reachable but not staged
Credential rule: mirror/token used only in environment, not written to artifact
```

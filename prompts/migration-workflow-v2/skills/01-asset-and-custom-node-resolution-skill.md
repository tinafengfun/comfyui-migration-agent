# Asset and custom-node resolution skill

## Use when

Use as Step 01 immediately after Step 00 intake/preflight to make dependencies explicit before feasibility analysis.

Use this as the owner of broad source search and acquisition. Step 00 only performs local/static intake and must defer URL, repository, SSH, provider, download, and clone work here.

## Inputs

- workflow JSON
- model roots and caches
- custom-node directory
- approved download sources
- dependency-source preflight with `00-intake-preflight.md`, `00-node-scan.csv`, `00-asset-extraction.csv`, `00-step01-work-queue.csv`, workflow path/copy, `workflow_sha256`, all-node scan coverage, asset extraction table, custom-node package table, source hint table, provider/download policy, and Step 01 work queue
- isolated workflow cache path, if acquisition is approved
- source context such as `model_repo`, `huggingface_mode.md`, SSH/shared-disk hints, local source roots, runtime-only provider tokens, and operator notes

## Step 00 handoff completeness

Step 00 is complete enough for Step 01 only when it provides:

| Field | Requirement |
| --- | --- |
| workflow identity | workflow path/copy and `workflow_sha256` |
| full node coverage | `source_node_count`, `scanned_node_count`, `missing_node_ids`, and `00-node-scan.csv` |
| dependency extraction | node ID(s), node type, field path, raw value, requested asset/package, dependency kind, and state |
| target routing | expected model folder, package destination, or custom-node cache path |
| work queue | one Step 01 work item for each unresolved/source-known dependency with query keys and exactness/alias policy |
| provider policy | allowed providers/source roots, download/clone policy, and credential env var names only |
| source context | local roots, source hint artifacts, and operator notes with secrets redacted |

Classify Step 00 input as `complete`, `repairable_gap`, `item_blocker`, or `step_hard_stop`. Repair only from the source workflow and durable artifacts. Do not fill gaps from chat memory. Do NOT write gate signals (`human_gate_reached`, `orchestrator_status`, etc.) in artifacts — the system controls gating via `gate-signal.json`.

## Algorithm

1. Read Step 00's all-node scan table or `00-node-scan.csv`. Verify source node count, scanned node count, and missing node IDs before acquisition.
2. Validate that Step 00 provided node ID to dependency mappings, field paths, raw values, query keys, expected target paths, source context paths, provider/download policy, and a Step 01 work queue. If not, classify the handoff gap, repair it with bounded read-only logic when safe, and record the contract gap in `improve.md`.
3. For every source node, extract model and workflow-side asset references. If a node has no asset dependency, record `no asset dependency`; do not omit the row.
4. For each selected custom-node class, inspect wrapper source for implicit assets and runtime downloads: `from_pretrained()`, `hf_hub_download()`, `snapshot_download()`, `load_file()`, `torch.load()`, default `ckpt_name`, model-name dictionaries, and package cache/config paths. If wrapper source cannot be found, record `wrapper scan blocked` for each affected node/type.
5. Search local roots before remote sources, then try approved candidates in priority order. Prefer the reusable migration asset tool pool when available so provider search/download/clone state is captured as compact JSON instead of long chat context:
   - existing workflow cache and configured model roots
   - exact SSH/shared-disk filename search
   - explicit HuggingFace file/repo URLs, `hf-mirror.com`, and `huggingface.co`
   - `www.civitai.com` and other approved model providers
   - GitHub repositories and `comfy.icu` for custom nodes
   - operator-provided exact source notes
6. Classify each dependency as `staged`, `source reachable but not staged`, `source unknown`, `access blocked`, `runtime-auto-download hidden asset`, or `smoke-only alias candidate`.
7. If the remaining hard stop is source-known but not staged, run a bounded acquisition pass before asking for human input: copy/download exact model files into an isolated workflow cache that mirrors both ComfyUI's model layout and the custom node's expected cache layout, or record why policy/access/exactness blocks the item.
8. For public, unambiguous custom-node sources, automatically search GitHub and `comfy.icu`, verify the selected repository, clone it into the isolated workflow cache, initialize declared submodules, and record commits. Do not require a human gate merely because a public custom-node source is known but not staged.
9. Do not label a cloned custom-node repository as installed or registered until environment deployment and prompt validation prove it.
10. Verify file size and SHA-256 when provider metadata or source-side hashes are available.
11. Label every asset as resolved, compatibility alias, or unresolved.
12. If all candidates fail, document attempted providers, commands/source URLs with credentials redacted, failure reasons, and exact assets still required. Do NOT write gate keywords in the artifact — the system will create `gate-signal.json` if human intervention is needed.

## Full-scan constraint

Step 01 must scan dependencies for every node reported by Step 00, including disconnected, muted/bypassed, note, reroute, group, non-output, non-critical-path, and reference nodes. The dependency scan must include rows for nodes with no dependency using `no asset dependency`.

### Custom-node directory verification rule

For each custom-node entry in the report, verify the local directory state:

1. If the directory exists and contains `.py` files → state `source known`
2. If the directory exists but is empty, contains only broken symlinks, or has no `.py` files → state `environment gap` with evidence explaining the problem (e.g., "broken symlink", "empty directory", "missing Python files")
3. If no matching directory exists → state `source known` (awaiting clone from provider)

Do NOT downgrade an `environment gap` determination back to `source known`. If the deterministic backend prep already identified a directory as `environment gap` in `01-custom-nodes.md`, preserve that determination and surface it to Step 05 for remediation.

Required completion fields:

```text
source_node_count:
dependency_scanned_node_count:
missing_dependency_scan_node_ids:
node_dependency_scan_artifact: 01-node-dependency-scan.csv
```

Both `resolved/staged` and `blocked_item` require `source_node_count == dependency_scanned_node_count` and `missing_dependency_scan_node_ids == none`. Missing dependency-scan rows are a Step 01 hard stop until repaired or precisely documented. Do NOT write gate keywords in artifacts.

## Bounded execution and session output

Step 01 may run longer than Step 00, but it must not become an unbounded background search. For each local/SSH/provider/download subjob, record:

- provider or source root
- exact query or filename
- target path
- start/end state
- bytes transferred and checksum when available
- redacted command or API URL
- failure reason or human action required

If a subjob exceeds the configured timeout, stalls below the minimum transfer rate, needs credentials, or returns ambiguous candidates, stop that subjob and document the blocker factually. The system will create `gate-signal.json` if human intervention is needed. Do not keep the SDK session alive just to wait for uncertain external downloads.

## Tool invocation

Step 01 is the owner of the reusable asset acquisition/search/download tool. The expected call pattern is:

1. consume `step01_work_queue` from Step 00;
2. for each work item, call the tool in search mode with `assetName` or package name, query keys, kind (`model` or `custom_node`), expected target path, source context paths, and provider policy;
3. review exact local/SSH/provider candidates and record them in `01-assets.csv` or `01-custom-nodes.md`;
4. call the tool in download/clone mode only when the work item is exact enough and `ASSET_ACQUISITION_ENABLE_DOWNLOAD=1` or equivalent policy approval is present;
5. verify size/checksum when available, update the ledger, and stop with a human gate if exactness or access is ambiguous.

Step 00 does not need the search/download tool. It needs a separate read-only intake scanner. Shared helper code is acceptable only for target-path routing, redaction, local exact file checks, and query-key normalization; provider search and download execution must stay in Step 01.

### Custom-node auto-acquisition rule

Custom-node source search and workspace clone are part of the Step 01 tool contract, not an optional manual workaround.

For each `custom_node` work item, Step 01 must:

1. search GitHub repository API and `comfy.icu` using Step 00 package hints, node type, CNR/package ID, and query keys;
2. prefer an explicit workflow/package hint over fuzzy search results;
3. verify that the selected public GitHub repository exists, is reachable, and is not archived;
4. clone the repository into the expected isolated workspace path under `cache/custom_nodes/`;
5. initialize declared submodules when present;
6. record repository URL, commit SHA, submodule SHAs, target path, provider attempts, and wrapper hidden-asset scan evidence;
7. mark the source as `source staged`, while still deferring `installed`, `registered`, and `XPU compatible` claims to Step 05/06.

The expected reusable implementation is:

- provider search: `searchAssetSourceProviders({ kind: "custom_node", query, targetPath, config })`
- discovery evidence: GitHub candidates plus `https://comfy.icu/search?q=<query>` fallback
- acquisition: bounded `git clone --depth 1 <repo> <workspace>/cache/custom_nodes/<package>` followed by `git submodule update --init --recursive` when `.gitmodules` exists
- evidence artifacts: `01-custom-node-provider-search.json`, `01-custom-node-github-verify.txt`, `01-custom-node-source-acquisition.json`, plus the rows in `01-custom-nodes.md` and `01-node-dependency-scan.csv`

Only human-gate custom-node acquisition when the provider policy disallows network/clone, the candidate set is ambiguous, the repository is private/archived/unreachable, credentials are required, the expected target path is missing, the target path has a non-empty collision, clone/submodule update fails after bounded retries, or wrapper-source inspection reveals hidden runtime assets that cannot be staged.

## Common failure signatures

- LoRA/checkpoint selector path fails `value_not_in_list`
- missing `LoadImage` input blocks smoke
- nested custom-node repo ignored by parent git repo
- alias silently described as original asset
- source-known dependencies left unstaged even though Step 01 policy allowed automatic acquisition, causing the same hard stop to reappear at deployment
- disconnected or muted source workflow nodes omitted from the Step 01 dependency scan
- cloned custom-node source incorrectly reported as registered without a ComfyUI restart and prompt validation
- hidden preprocessor/checkpoint default missed because it is not visible in the workflow JSON
- custom node tries `hf_hub_download()` or `snapshot_download()` during branch smoke
- model is staged in a generic ComfyUI folder but the custom node expects its own package cache path
- mirror or token is needed for download, but credentials are accidentally copied into artifacts
- URL/repository/provider searches are repeated in Step 00 or later validation steps instead of being centralized in Step 01

## Evidence standard

Retain asset ledger, source mapping, per-node dependency scan coverage, wrapper-source evidence for hidden runtime assets, acquisition log, custom-node commit list, install logs when installation actually happens, and remaining hard-stop list.

When using mirrors or credentials, retain only non-sensitive evidence: endpoint/mirror name, repo or source URL, target path, size, checksum, and whether a token was used. Do not retain the token value.

Retain provider attempt evidence for frontend progress: candidate provider, target path, total bytes when known, downloaded bytes, speed/ETA when executing, completion state, and redacted failure reason.

Write a final `01-output-manifest.json` that lists every Step 01 output artifact, path, size, hash, terminal status, completion signals, and Step 02 route constraint.

## Hard stops

Do not run provider search/download/clone for a work item missing safe minimum inputs: source node reference, requested name/package, expected target path or package destination, allowed providers, exactness requirement, and credential/policy handling.

If the Step 00 handoff is incomplete, Step 01 may perform a bounded read-only repair from the source workflow and existing artifacts. If the missing information still cannot be recovered safely, block only the affected item or node range, surface a human gate when needed, and write the gap to `improve.md`. Do not reconstruct missing evidence from chat memory.

Stop if a critical source-identical asset is missing and no approved alias/fallback exists.

Stop before deployment if critical dependencies are only `source reachable but not staged`; acquire or stage them first in an isolated workflow cache. For public unambiguous custom-node repositories, this acquisition should be automatic in Step 01 under the custom-node auto-acquisition rule.

Stop before branch smoke if a selected custom-node wrapper has a runtime auto-download path and the required file is not already staged in the exact path that wrapper checks.

Stop and document blockers after all approved search/download candidates fail. Do NOT write gate keywords in artifacts — the system handles gating via `gate-signal.json`. Do not silently defer unresolved source acquisition to feasibility, environment deployment, or smoke validation.

Hard-stop Step 01 when full node coverage cannot be proven, required source workflow/artifacts are unavailable, a target path collision would overwrite non-workspace data, policy forbids acquisition and no human decision is available, a transfer/clone/submodule job cannot be bounded, or continuing would require modifying/bypassing workflow nodes.

## Completion criteria

Step 01 is complete only when one of these terminal states is true:

1. **Resolved/staged**: required source-identical assets, human-approved substitutes/aliases, hidden runtime assets, input media, and custom-node source repositories are present in exact expected paths or isolated cache paths, with size/checksum/source/commit evidence, claim boundary, and no pending transfer.
2. **Blocked items**: unresolved items remain after bounded attempts, and the artifacts list the exact missing items, attempted providers, redacted commands/URLs, failures. The system will decide if human intervention is needed via `gate-signal.json`. Do NOT write gate keywords in artifacts.
3. **Hard stop**: Step 01 cannot safely continue under current constraints, and the artifact names the exact condition: unavailable workflow/artifacts, unprovable full-node coverage, unsafe target path collision, policy-forbidden acquisition with no decision path, unbounded transfer/clone/submodule job, or any requirement to modify/bypass workflow nodes.

`resolved/staged` and `blocked_items` require `source_node_count == dependency_scanned_node_count` and `missing_dependency_scan_node_ids == none`. `hard_stop` must name why those coverage/acquisition requirements cannot be satisfied safely.

Step 01 is not complete when any Step 00 source node lacks a dependency scan row, it only generated candidate URLs, only confirmed that a source might exist, left download/copy/clone/submodule jobs running, skipped hidden runtime asset inspection, used an undocumented or unapproved alias/substitute, leaked credentials, omitted `01-output-manifest.json`, or made runtime/registration/XPU claims that belong to later steps.

## Human intervention standards

Ask a human only when Step 01 cannot decide safely after bounded tool attempts:

- strict source-identical asset is missing and only aliases/substitutes are available;
- alias/substitute approval changes fidelity, smoke-only, or delivery claims;
- provider/private/source access requires credentials, proxy, SSH, or license acceptance;
- source candidates are ambiguous, archived, private, unreachable, or conflict with expected package identity;
- expected target path or package destination is ambiguous or collides with non-empty workspace data;
- full node/dependency coverage cannot be proven from Step 00 and read-only repair;
- hidden runtime asset exists but cannot be staged in the exact path the wrapper checks;
- continuation would otherwise overstate source identity, installation, registration, XPU support, or output quality.

Do not ask a human merely because a public unambiguous custom-node source is reachable but not staged; run the custom-node auto-acquisition tool first.

## Step 02 handoff context

Pass these fields through `01-acquisition-summary.json` and `01-output-manifest.json`:

- workflow path/copy and `workflow_sha256`;
- artifact folder and all Step 01 output paths/hashes;
- `source_node_count`, `dependency_scanned_node_count`, and `missing_dependency_scan_node_ids`;
- asset totals, source-identical staged count, approved substitute/alias count, unresolved/access-blocked count;
- exact substitute/alias names, source node IDs, source paths, staged paths, sizes/checksums when available, and fidelity boundary;
- custom-node totals, newly cloned repos, commit SHA, submodule SHA, source path, and wrapper hidden-asset evidence;
- provider attempts and failure reasons for unresolved or substituted items;
- human decisions already made and remaining decisions;
- `can_start_step02`;
- `step02_route_constraint`.

## Blocked item output standard

When Step 01 ends with unresolved items, the report and UI event must contain enough information for a non-agent operator to act without reading the whole conversation. Do NOT write `human_gate_reached` or `orchestrator_status` in artifacts — document blockers factually and the system will handle gating via `gate-signal.json`.

```text
problem_summary:
background_reason_scene:
terminology:
  - term:
    explanation:
unresolved_items:
  - item:
    kind:
    source_node_ids:
    expected_target_path:
    current_state:
    attempts_made:
    blocker:
allowed_decisions:
  - provide exact source-identical asset/source
  - approve named smoke-only alias and reduced claim boundary
  - provide runtime-only source access/proxy/token configuration
  - stop migration
consequences_and_follow_up:
  - choice:
    consequence:
    follow_up:
continuation_plan:
  exact_assets: rerun affected Step 01 work items -> update ledgers -> rerun Step 02
  smoke_only: mark aliases approved -> Step 02 human-gated/non-source-identical route -> Step 03 inventory may continue
  access_config: rerun provider/search/download subjobs with redacted logs -> update ledgers -> rerun Step 02
  stop: record final dependency gate and do not proceed to runtime
  hard_stop: record why Step 01 cannot safely continue
reply_template:
  Decision:
  Exact assets/sources:
  Approved aliases:
  Access configuration:
  Download/clone approval:
  Fidelity boundary:
  Notes:
```

Do not emit a human gate that only says "missing assets" or "provide direction". The gate must include exact filenames/package names, source node IDs, target paths, attempted providers, why the agent cannot decide safely, exact instructions for the human, professional term explanations, and the consequence plus next execution edge for each possible human answer.

Continuation edges must be explicit:

| Human answer | Step 01 action | Next edge |
| --- | --- | --- |
| exact files/sources provided | stage/copy/symlink exact assets or clone exact source into the isolated workflow cache, verify size/checksum/commit when available, update ledgers | rerun Step 02 |
| named aliases approved | record alias approval and claim boundary in Step 01 artifacts | Step 02 routes as bounded/non-source-identical, then Step 03 may continue if approved |
| runtime access/download/clone approved | rerun only affected provider/search/download/clone subjobs with runtime env vars and redacted logs | update ledgers, then rerun Step 02 |
| stop | record final dependency gate | do not proceed to Step 02+ runtime work |
| unsafe to continue | record `hard_stop` with exact cause | do not proceed |

## Output schema

`asset_name`, `requested_name`, `resolved_path`, `source`, `state`, `staged_path`, `custom_node_repo`, `custom_node_cache_path`, `wrapper_source_evidence`, `commit`, `install_status`, `acquisition_status`, `mirror_used`, `credential_recorded`, `size_bytes`, `checksum`, `source_node_count`, `dependency_scanned_node_count`, `missing_dependency_scan_node_ids`, `node_dependency_scan`, `provider_attempts`, `gap`.

Write the primary outputs as `01-assets.csv`, `01-custom-nodes.md`, `01-node-dependency-scan.csv`, `01-acquisition-summary.json`, and `01-output-manifest.json`. When provider search/download/clone occurs, also write compact evidence artifacts such as `01-provider-search-models.json`, `01-custom-node-provider-search.json`, `01-custom-node-github-verify.txt`, and `01-custom-node-source-acquisition.json`.

### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Branch smoke validation skill

## Use when

Use after prompt validation and before full-size execution.

## Inputs

- validated prompt
- branch map
- target output node
- reduced-resource settings
- Step 06 branch prompt manifest and generated wrapper provenance

## Algorithm

1. Choose the smallest faithful branch.
2. Keep graph structure intact while reducing size, steps, or frames only where allowed.
3. Run with fixed seed without breaking graph links. If a sampler seed input is linked to a seed node, modify that seed node value rather than replacing the input link with a literal.
4. Verify intended output files and media integrity.
5. Inspect the history for both executed and cached nodes.
6. If execution fails after upstream critical compute completed, classify the failure at the failing node instead of discarding upstream evidence. A missing declared Python package in a target custom node is an environment dependency gap, not a graph success and not a reason to bypass the node.
7. If a dependency fix is applied and the rerun passes mostly from cache, label the pass as cache-assisted and, when practical, run one safe cache-bust verification that preserves the graph and branch boundary.
8. Check boundary variants instead of assuming the "middle" case covers all cases.
9. Verify output file paths exist and are non-empty.
10. Record runtime, placement, dependency fixes, cache behavior, and gaps.
    - **Wrapper generation must validate that the target node's input type matches the source node's output type.** If a node outputs metadata (`FLOAT`/`INT`, e.g. `VHS_VideoInfo`) but the wrapper expects `IMAGE`, skip the branch or use a type-appropriate wrapper.
11. Preserve cold-start/cached-run differences. If `/free` or a server restart exposes OOM that did not appear in a cache-assisted run, keep both attempts and pass the boundary to Step 08/09.

## Reachability is checked automatically — never improvise a ComfyUI launch yourself

The backend (`orchestrator.ts`, see `comfyuiLifecycle.ts`'s `ensureComfyUiUp`) automatically checks and, if needed, correctly (re)launches ComfyUI **before Step 07's SDK session even starts.** By the time you're reading this, the endpoint is already confirmed reachable — you do not need to check, restart, or launch it yourself.

If it couldn't be brought up even via the correct launch pattern, the step never reached you at all: it was already hard-stopped by the backend with a clear "infrastructure hard stop" reason, and a human needs to fix the environment before this step can be retried. If you ever find yourself reasoning about *whether* to launch a container/process, stop — that decision has already been made deterministically upstream. Do not hand-write a `docker run`, do not fall back to a bare-metal `python main.py` for a `runtime: docker` node, and do not `pip install` into the shared NFS venv to "fix" an apparent missing module — see `scripts/remote-comfyui.mts`'s doc comment and Step 05's shared-venv-lock note for why each of those is a documented way to fail differently, not a fix (a real incident: an ad hoc `docker run` without `--entrypoint` ran the docker image's own outdated baked-in `comfy_aimdo` instead of the correctly configured shared venv; a bare-metal fallback then broke a second, different way, since that venv only inherits torch/oneAPI from the image's own system site-packages when run inside a matching container).

## Reusable branch smoke tool

Use the Step 07 harness when available:

```bash
<ComfyUI root>/.venv-xpu/bin/python \
  ComfyUI/docs/draft/migration-workflow-v2/tools/step07_branch_smoke.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --api-url http://127.0.0.1:<port> \
  --timeout-seconds 1200 \
  --smoke-seed <fixed integer>
```

It consumes `06-branch-prompts.csv`, applies bounded smoke settings, submits each branch, preserves request/response/history/summary/report artifacts, records executed and cached nodes, checks output files on disk, and writes `07-branch-smoke-summary.json` plus `07-output-manifest.json`.

## Common failure signatures

- branch succeeds only because a node was bypassed
- output file missing despite success event
- compatibility alias treated as fidelity proof
- smoke result generalized to all branches
- single-image branch used to claim double/triple-image support
- first/last-frame path used to claim all multi-reference variants
- frame count or resolution tail case silently untested — for video graphs the branch smoke must cap **BOTH** the frame-count driver **AND** the resolution/token driver down to small values for reachability (example smoke targets: frame count → ~16, resolution driver → ~512). Known driver input names include `frame_load_cap`/`length` (frames) and `ref_max_size`/`max_size` (resolution/tokens), but identify this workflow's actual drivers from its graph rather than assuming those names. Capping the frame count alone is NOT enough: the resolution/token driver governs the attention token count in ref-resize pipelines (e.g. `ref_max_size` on `BerniniConditioning`), so a smoke left at full resolution (observed: `ref_max_size=1280`) hit `OUT_OF_RESOURCES` even at `--novram` and hard-stopped Step 07 (2026-08-15). `apply_reduced_settings` caps the known drivers by input name. See [wan22-capacity-reference](wan22-capacity-reference.md).
- downstream custom-node fails on a declared runtime dependency that was not installed during environment deployment
- rerun after fixing a late blocker succeeds only because upstream outputs were cached, but the report omits cached-node evidence
- terminal non-output wrapper from Step 06 is ignored and the raw non-output node is submitted
- history reports success but output file path is missing or empty
- fixed-seed reduction replaces a linked seed node with a literal and silently removes the seed node from execution
- clearing cache before every branch makes a cache-assisted suite fail as a cold-start capacity test, but the report does not distinguish that from branch logic failure
- ComfyUI relaunch uses an ad hoc docker/bare-metal command instead of Step 05's recorded `launch_command`, silently running the image's own outdated baked-in packages (or a python-version-mismatched bare-metal venv) instead of the correctly configured environment
- a shared NFS venv gets an unlocked `pip install` mid-step, risking corruption for every other concurrent task/host sharing that mount

## Evidence standard

Retain branch prompt, history, logs, outputs, telemetry, and visual/media checks.

For each branch family, record:

- tested branch variant
- reduced settings and why they are faithful
- proof that reduced settings preserved linked seed/control nodes instead of replacing graph edges
- executed nodes and cached nodes
- output file evidence
- dependency gaps and fixes found during smoke
- cache-bust verification, if cache affected the final evidence
- untested variants
- whether the result is API-only, GUI-imported, or GUI-manually validated
- generated wrapper node, if Step 06 had to wrap a terminal non-output branch

Use a consistent artifact set per branch:

```text
07-{branch_slug}-smoke-prompt.json
07-{branch_slug}-smoke-notes.json
07-{branch_slug}-smoke-request.json
07-{branch_slug}-smoke-submit-response.json
07-{branch_slug}-smoke-history.json
07-{branch_slug}-smoke-summary.json
07-{branch_slug}-smoke-evidence.json
07-{branch_slug}-smoke-before.json
07-{branch_slug}-smoke-after.json
07-{branch_slug}-smoke.md
```

If there are failed attempts, preserve them with an attempt suffix instead of overwriting:

```text
07-{branch_slug}-smoke-attempt1-history.json
07-{branch_slug}-smoke-attempt1-failure-summary.json
```

## Hard stops

Stop full validation if a critical branch cannot smoke successfully.

(Infrastructure/reachability hard stops are handled automatically before this step starts — see the Reachability section above. You will not need to make that call yourself.)

## Output schema

`branch`, `output_node`, `submission_output_node`, `variant`, `settings`, `history`, `outputs`, `executed_nodes`, `cached_nodes`, `placement`, `validation_path`, `dependency_fixes`, `cache_bust_verification`, `status`, `untested_variants`, `gap`, `completion_decision`, `step08_context`.

## Completion rule

Step 7 is complete only when every critical output branch is either:

1. branch-smoke passed with output evidence
1. cache-assisted branch-smoke passed with executed/cached-node evidence and non-empty output files
2. explicitly blocked with failing node, error, and preserved artifacts
3. explicitly out of scope with human-approved rationale

Do not proceed to Step 8 from only one successful branch if the topology has other critical branches.

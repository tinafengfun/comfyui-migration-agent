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
11. Preserve cold-start/cached-run differences. If `/free` or a server restart exposes OOM that did not appear in a cache-assisted run, keep both attempts and pass the boundary to Step 08/09.

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
- frame count or resolution tail case silently untested
- downstream custom-node fails on a declared runtime dependency that was not installed during environment deployment
- rerun after fixing a late blocker succeeds only because upstream outputs were cached, but the report omits cached-node evidence
- terminal non-output wrapper from Step 06 is ignored and the raw non-output node is submitted
- history reports success but output file path is missing or empty
- fixed-seed reduction replaces a linked seed node with a literal and silently removes the seed node from execution
- clearing cache before every branch makes a cache-assisted suite fail as a cold-start capacity test, but the report does not distinguish that from branch logic failure

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

## Output schema

`branch`, `output_node`, `submission_output_node`, `variant`, `settings`, `history`, `outputs`, `executed_nodes`, `cached_nodes`, `placement`, `validation_path`, `dependency_fixes`, `cache_bust_verification`, `status`, `untested_variants`, `gap`, `completion_decision`, `step08_context`.

## Completion rule

Step 7 is complete only when every critical output branch is either:

1. branch-smoke passed with output evidence
1. cache-assisted branch-smoke passed with executed/cached-node evidence and non-empty output files
2. explicitly blocked with failing node, error, and preserved artifacts
3. explicitly out of scope with human-approved rationale

Do not proceed to Step 8 from only one successful branch if the topology has other critical branches.

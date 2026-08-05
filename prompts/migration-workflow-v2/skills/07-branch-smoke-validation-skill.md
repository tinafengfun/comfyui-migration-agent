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

## Reachability: never improvise a new ComfyUI launch

Before assuming the endpoint is down, check whether a server is already up and reuse it:

- `runtime: docker` — `docker ps --filter "name=comfyui-${TASK_ID}"`; if it's running, poll `/system_stats` on the recorded `api_url` before touching anything.
- `runtime: bare` — check the recorded PID and `/system_stats` before relaunching.

A currently-running, still-healthy server must never be torn down and recreated just because the first health check attempt was slow — confirm it's genuinely unresponsive first.

If the endpoint is genuinely down and must be (re)launched, **use the deterministic tool instead of hand-writing a docker command:**

```bash
npx tsx scripts/remote-comfyui.mts --node <gpu-node-name> --action restart \
  --container "comfyui-${TASK_ID}" --api-url <api_url> --wait 150
```

(use `--action start` instead of `restart` when no container/process exists yet for this task). This is the single source of truth for the correct launch on a `runtime: docker` node — `--entrypoint <venv_python>` (never the image's own default entrypoint), `comfyui_root` bind-mounted at `/comfyui`, the shared NFS root bind-mounted at an identical path, `--net=host`. Never construct a new `docker run`/`docker create` command by hand, and never fall back to a bare-metal `python main.py` invocation for a `runtime: docker` node. Also reuse `05-environment-summary.json`'s own recorded `launch_command` as a cross-check if present.

Confirmed live incident: before this tool supported `runtime: docker`, an SDK session hand-wrote its own `docker run` that skipped `--entrypoint "${VENV_PYTHON}"` and bind-mounted the workflow's own comfyui checkout over `/workspace/comfyui` (instead of `/comfyui` per Step 05's documented pattern) — that ran the *image's own baked-in, much older* `comfy_aimdo` (0.2.14, missing the `vram_buffer` submodule the current comfyui-core imports) instead of the correctly configured shared venv (which already had `comfy_aimdo` 0.4.5 with `vram_buffer` present, proven working by another container on the same node that had been running successfully for days using this exact `--entrypoint`-based launch). The environment was never broken — the ad hoc relaunch command was.

When that first ad hoc attempt failed, the same incident then fell back to running ComfyUI directly on the bare host against the shared NFS venv (`/nfs_share/venv-container-xpu/bin/python3 main.py ...`, no container at all) — a second, independent way to fail. That venv is `--system-site-packages`, meaning it only gets `torch`/oneAPI/compiled-kernel packages *by inheriting them from the docker image's own system site-packages* when run inside a matching container; invoked directly on the bare host (no container at all), those packages simply do not exist anywhere on the host's own OS, so `import torch` fails outright regardless of Python version. (A second host was separately found with its own `/usr/bin/python3` upgraded to a version that doesn't even match the venv's pinned 3.12, an unrelated but equally real way the same bare-metal shortcut can fail.) **A `runtime: docker` node's ComfyUI must run inside a container, full stop — a bare-metal fallback for a docker-runtime node is not a valid recovery path, it is a second, different way to break, for a second, different reason.**

Never `pip install` into a shared `--system-site-packages` venv (e.g. `/nfs_share/venv-container-xpu`) directly, even to "fix" an apparent missing module during Step 07 — that venv is shared across every task/host that mounts the same NFS tree, and an unlocked install can corrupt site-packages for everyone concurrently using it (see Step 05's shared-venv-lock note). If a package genuinely appears to be missing from the *correctly-invoked* environment, that is itself an environment hard-stop signal to report, not something to patch live mid-step.

If the recorded `launch_command`, run exactly as documented, still fails to bring up a healthy endpoint, that is an infrastructure hard stop requiring a human decision (see Hard stops below) — do not keep improvising alternate execution paths.

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

Stop and escalate to a human decision if `05-environment-summary.json`'s recorded `launch_command`, run exactly as documented (correct `--entrypoint`, correct mounts, no substitutions), still fails to bring up a reachable `/system_stats` endpoint. Do not attempt a bare-metal fallback for a `runtime: docker` node, do not fall back to the docker image's default entrypoint, and do not `pip install` into a shared venv to work around it — each of those is a documented way to fail differently, not a fix.

## Output schema

`branch`, `output_node`, `submission_output_node`, `variant`, `settings`, `history`, `outputs`, `executed_nodes`, `cached_nodes`, `placement`, `validation_path`, `dependency_fixes`, `cache_bust_verification`, `status`, `untested_variants`, `gap`, `completion_decision`, `step08_context`.

## Completion rule

Step 7 is complete only when every critical output branch is either:

1. branch-smoke passed with output evidence
1. cache-assisted branch-smoke passed with executed/cached-node evidence and non-empty output files
2. explicitly blocked with failing node, error, and preserved artifacts
3. explicitly out of scope with human-approved rationale

Do not proceed to Step 8 from only one successful branch if the topology has other critical branches.

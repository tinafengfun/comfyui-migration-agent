**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Final delivery prompt

## Task

Produce a self-contained, docker-based deployment guide that lets a human deploy a complete, verifiable ComfyUI service from scratch — with no access to this session, the running task workspace, or any prior context — and use it to validate the already-migrated workflow. Then prove the guide actually works by tearing down the current container and redeploying it from the guide's own literal commands, as a machine-checked dry run.

## Required context

- Step 00 intake summary
- `01-assets.csv`, `01-custom-nodes.md`
- `05-environment-summary.json` (comfy root, commit, recorded launch/docker command, pinned GPU node)
- `11-delivery/package-manifest.json`
- `12-gui-acceptance-summary.json`, `12-runtime-policy-gui-workflow.json`

## Constraints

1. Do not invent docker flags, ports, or paths. Read the actually-used launch command from `05-environment-summary.json`; if the node's `runtime` is `"docker"`, reuse the exact create/cp/start sequence documented in the Step 05 environment-deployment skill (container naming, GPU device flags, tar-based copy-in with excludes) rather than approximating it.
2. The dry run must genuinely destroy and recreate the container (`docker rm -f "comfyui-${TASK_ID}"` first) — reusing Step 12's still-running instance does not prove the guide works from scratch.
3. The migrated workflow file (`12-runtime-policy-gui-workflow.json`) must be copied into the guide's own bundle and referenced by a path inside it, not only by an absolute path into this task's private workspace.
4. Do not claim the deployment guide is verified until the dry run's own HTTP checks (not your prose) confirm it.
5. List every custom node with its actual clone/patch location, and every model with its actual resolved path — pull these from `01-custom-nodes.md` / `01-assets.csv`, never guess.

## Steps

1. Run `step12b_final_delivery.py --workspace <workspace>` (no `--dry-run-api-url` yet) to render `deployment-guide.md` and `12-docker-launch.sh` from the Step 00/01/05/11/12 artifacts.
2. Execute the generated `12-docker-launch.sh` verbatim via Bash — it starts with tearing down the existing container, then recreates and starts it fresh.
3. Poll the relaunched service's `/system_stats` and `/object_info` until ready, then resubmit the already-accepted Step 08/12 prompt and poll `/history` for completion.
4. Re-run `step12b_final_delivery.py --workspace <workspace> --dry-run-api-url <url>` — this performs its own HTTP checks and computes `completion_decision` from that evidence, not from your account of what happened.
5. If the dry run is clean, finalize `12b-final-delivery.md` and hand off. If not, treat it as a hard stop per below — do not paper over a failed dry run with prose claiming the guide is fine.

## Output

Create final-delivery artifacts with:

- `deployment_guide` (`deployment-guide.md`) — target environment, fresh-environment checklist (prepare host, stage assets, install custom nodes, launch via the literal docker command, submit validation prompt, verify outputs), expected results, rollback
- `docker_launch_script` (`12-docker-launch.sh`) — the exact executable script run in Step 2, so the doc and the script never drift
- `dry_run_verification` (`dry-run-verification.json` / `.md`) — the machine-graded evidence from the fresh redeploy
- `12b-final-delivery-summary.json`
- `12b-final-delivery.md`
- `12b-output-manifest.json`

## Hard stops

Stop and escalate if:

1. the fresh-redeploy dry run cannot reach `/system_stats` or `/object_info` on the recreated container
2. any node type used by the migrated workflow is missing from `/object_info` after the fresh redeploy
3. the recorded launch/docker command from Step 05 is missing or does not correspond to the pinned GPU node's actual runtime
4. a custom node or model referenced by the migrated workflow cannot be traced to a real, resolvable location

## Prior-migration lessons

A real, hand-authored example of this guide's target shape already exists on disk (`deployment-guide.md` for the Expressive Voice Generator migration) with literal `docker create`/`docker start` commands, custom-node clone/patch commands, model paths, and `/object_info`/prompt-submission verification curl commands — Step 11's own `deployment-guide.md` is prose/API-oriented only and has no literal docker command. This step's job is to make that richer, docker-oriented, dry-run-verified guide the deterministic, always-produced output instead of something assembled by hand once per migration.

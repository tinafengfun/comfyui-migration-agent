### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Final delivery skill

## Use when

Use after Step 12 GUI/manual acceptance to produce the final, docker-based deployment guide that lets a human redeploy and validate the migrated workflow with no access to this task's live session or workspace.

## Inputs

- Step 01 asset/custom-node ledgers
- Step 05 environment summary (comfy root, commit, pinned GPU node, recorded launch/docker command)
- Step 11 delivery package manifest
- Step 12 GUI acceptance summary and runtime-policy GUI workflow

## Algorithm

1. Assemble the deployment guide deterministically from existing artifacts — never invent a docker flag, model path, or custom-node location that isn't traceable to `01-assets.csv`, `01-custom-nodes.md`, or `05-environment-summary.json`.
2. Render `12-docker-launch.sh` as the single source of truth for the launch command; the prose guide must quote this same generated script, not a hand-typed paraphrase of it.
3. Actually execute the redeploy as a dry run: tear down the current container (`docker rm -f "comfyui-${TASK_ID}"`), recreate and start it fresh from the generated script, poll `/system_stats` + `/object_info`, resubmit the accepted prompt, poll `/history`.
4. Grade the dry run with the deterministic tool (`--dry-run-api-url`), not with your own account of what happened — the tool's own HTTP checks are authoritative evidence.
5. Diff `/object_info`'s registered node types against the migrated workflow's actual node `type` values; any gap is a hard stop, not a note.
6. Keep claims scoped: `completion_decision.status` is `"awaiting_dry_run"` before the dry run has evidence, `"complete"` only once the dry run is clean, `"hard_stop"` if it ran and failed.

## Docker lifecycle reference

Container create/cp/start/rm mechanics (naming convention, GPU device/group flags, tar-based copy-in with excludes, staging-directory workaround for `docker cp`'s no-create-destination limitation) are already fully documented in the Step 05 environment-deployment skill — reuse that exact sequence verbatim for the dry run and for the rendered `12-docker-launch.sh`. Do not re-derive or approximate these mechanics; deviating from the documented container name (`comfyui-${TASK_ID}`) breaks the orchestrator's own teardown tooling.

## Common failure signatures

- deployment guide lists a docker command that was never actually re-executed against a fresh container
- custom-node inventory omits a node the migrated workflow actually uses
- model paths point at task-local scratch paths instead of the durable NFS/model_roots location a fresh deployment would actually have
- the guide's command block and the executable launch script have silently drifted apart
- dry run reused the still-running Step 12 container instead of a genuine from-scratch redeploy
- completion claimed from agent prose instead of the tool's own HTTP-check evidence

## Evidence standard

Retain:

- rendered `deployment-guide.md` and `12-docker-launch.sh`
- dry-run verification evidence (`/system_stats`, `/object_info`, node-type diff, prompt resubmission + `/history` result)
- the migrated workflow's node-type list used for the diff
- `completion_decision` and, if not complete, the exact hard-stop reason

## Hard stops

Stop and classify as a hard stop if the fresh redeploy cannot reach `/system_stats`/`/object_info`, if any node type the migrated workflow uses is missing from the recreated container's `/object_info`, or if the Step 05 recorded launch/docker command is missing or does not match the pinned GPU node's actual runtime.

Do not mark this step complete from documentation alone — the dry run is the completion gate, not the human's hypothetical ability to follow the doc.

## Output schema

`deployment_guide`, `docker_launch_script`, `dry_run_verification`, `missing_node_types`, `completion_decision`.

Required Step 12b artifacts:

- `12b-final-delivery/deployment-guide.md`
- `12b-final-delivery/12-docker-launch.sh`
- `12b-final-delivery/dry-run-verification.json`
- `12b-final-delivery-summary.json`
- `12b-final-delivery.md`
- `12b-output-manifest.json`

Additively copy the same `12b-final-delivery/` bundle into `11-delivery/final-delivery/` (never overwrite Step 11's own `deployment-guide.md`/`README.md`) so the NFS-archived delivery bundle includes this step's content.

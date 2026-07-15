# Migration-agent tools index

Durable tools for recurring operations. **Before hand-writing a shell/node one-off
for any operation below, use the matching tool here** (see agent.md contract rule).
All are `npx tsx scripts/<tool>` from the repo root unless noted. Tools that target
a GPU node read `gpu-nodes.json` (override path with `GPU_NODES_PATH=`).

## Driving a migration

| When | Tool | Command |
|---|---|---|
| Run a workflow through the pipeline via the API (create→gate→drive) | `drive-migration.mts` | `npx tsx scripts/drive-migration.mts --workflow <path.json> --node <gpu-node> [--answers answers.json] [--auto] [--until 13] [--budget-min 180]` |
| Check a task's step statuses / list tasks | `task-status.mts` | `npx tsx scripts/task-status.mts <taskId>` · `--list` · `--json` |

`--answers` is a JSON map `{ "<stepId>": "answer text" }` (freeform). `--auto` picks a
proceed/continue/approve choice. Neither → prints the gate + stops for manual handling.
Answers only the latest question per step (avoids reconcileStaleActiveTasks).

## ComfyUI on a node

| When | Tool | Command |
|---|---|---|
| Start/stop/restart/status ComfyUI on a node (local or ssh) | `remote-comfyui.mts` | `npx tsx scripts/remote-comfyui.mts --node <name> --action start\|stop\|restart\|status [--wait 150]` |

Uses the reliable detached-launch pattern (launcher script on target + `setsid` +
`ssh -n` + redirected fds). Do NOT hand-write an inline `ssh "... &"` — it hangs.

## Environment readiness / dependencies

| When | Tool | Command |
|---|---|---|
| Scan a node's readiness (ssh/xpu/object_info/custom_nodes/models/sampler pkgs); prepare gaps | `node-precheck.mts` | `npx tsx scripts/node-precheck.mts --node <name> [--prepare] [--json]` |
| Install a custom package that injects an enum value (sampler/scheduler) + verify via /object_info | `install-enum-package.mts` | `npx tsx scripts/install-enum-package.mts --node <name> --repo <git-url> --host-node-type KSampler --verify sampler_name=res_2s` |
| Normalize a GUI-exported workflow (cut dependency cycles → DAG) | `normalize-workflow.mts` | `npx tsx scripts/normalize-workflow.mts <workflow.json> [out.json]` |

`node-precheck --prepare` installs the missing custom-node baseline
(`data/node-baseline.json`, grows over time) + known sampler packages, so a new
node is prepared once instead of tripping the same gaps every migration.

## Node provisioning / test harness

| When | Tool | Command |
|---|---|---|
| Provision + register a new GPU node (ssh key, ComfyUI, NFS, precheck) | `bootstrap-gpu-node.mts` | `npx tsx scripts/bootstrap-gpu-node.mts --name … --host … --user … [flags]` |
| Start a throwaway test agent (backend+frontend) on dedicated ports | `start-test-agent.sh` | `bash scripts/start-test-agent.sh [BACKEND_PORT [FRONTEND_PORT]]` |
| First-run setup of a fresh clone (deps, env/gpu-nodes scaffolds) | `setup.sh` | `bash scripts/setup.sh` |
| Restart the local backend+frontend | `restart.sh` | `bash scripts/restart.sh` |

## Validation / analytics (existing)

| When | Tool |
|---|---|
| Playwright frontend regression | `npm run playwright:ui` / `:migration` (skill: frontend-regression) |
| E2E migration / smoke drivers | `e2e-migration.mts`, `e2e-smoke.mts`, `e2e-real-workflow.mts` |
| Validate/verify recipes | `validate-recipes.mts`, `verify-patch-recipes.mts` |
| Sync analytics DB | `sync-analytics.mts` |
| XPU python wrapper | `xpu-python.sh` |

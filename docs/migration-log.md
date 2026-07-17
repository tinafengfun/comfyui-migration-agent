# Migration log

Tracks which source ComfyUI workflows have been migrated/tested through the agent, so
progress isn't re-derived from scratch each session. Append one row per workflow when
its migration test is confirmed complete. No automated task-status ledger exists yet
(see `scripts/task-status.mts` for live in-flight task state) — this file is the
durable, human-curated record across sessions.

| Workflow | Source path | Status | Notes |
|---|---|---|---|
| zimage-shuangcai | `tests/fixtures/zimage-shuangcai.json` | ✅ Completed | Confirmed complete by user 2026-07-15. |
| Zimage lora workflow | `workspaces-zimage-clean/98c66114-.../source/Zimage______________lora_____.json` | ✅ Completed | Confirmed complete by user 2026-07-15. Earliest workspace artifact only reached Step 02 (feasibility) under an older `demo/` path layout — likely superseded by a later run whose workspace was since cleaned up. |
| Dasiwa-图生视频流 | `cartoon/Dasiwa-图生视频流.json` | ✅ Completed | Task `fd5a985c-3d9a-4e10-96f4-549cdb6a3e43`, all 13 steps (00-13) completed 2026-07-17. Ran through the per-step flow; surfaced and led to fixing the `task-state.json` corruption bug (backend now owns writing it) and adding the Step 13 human-gated improvement apply pipeline. |

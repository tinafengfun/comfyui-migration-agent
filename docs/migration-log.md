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
| 瑶光+动漫+MJ风格工作流 | `cartoon/瑶光+动漫+MJ风格工作流（带模型和lora下载链接）.json` | ✅ Completed | Task `c6b86cfa-9e1c-4a2b-84a7-43592355fc3d`, all 13 steps (00-13) completed 2026-07-19. Surfaced two real Step 01 asset-matching bugs (mangled filenames not resolved by exact-match search) — fixed via multi-strategy query variants + LLM-judged fuzzy candidates. Also produced 12 Step 13 self-improvements: 9 approved and merged to `main` (1 had a real widget-index bug found in review, fixed before merge), 3 rejected (one permanently, as an unsafe pattern). |

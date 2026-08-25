# Backlog: XPU-catalog batch-import follow-ups

Batch-import of the `custom_node_list` (129 nodes) from `comfyui_migration_tasks.xlsx`
is **DONE 2026-08-25** (commits 745ada6→8b957f2; pipeline in `scripts/catalog-import/`;
results + gotchas in memory `catalog_batch_import.md`): catalog 15→137 records
(104 trusted / 33 documented-unsupported), 96 `knownCustomNodes.ts` entries, reusable
SYCL wheel + `intel/llm-scaler-omni:0.1.0-b7-sycl` image on NFS. What remains below.

## A. Action items

1. **End-to-end real migration proof (highest priority).** Everything is validated only
   at the `/object_info` registration layer — no imported node has been run through a full
   migration to confirm `resolveNodeType → auto-clone → recipe injection` actually fires
   and produces output. Run 1–2 real workflows using imported nodes (e.g. a KJNodes +
   rgthree graph) through the Step pipeline. Overlaps with `backlog-xpu-catalog-step-integration.md`
   "Remaining #2 (Playwright @migration live run)".

2. **Re-clone the 2 nodes that 403'd.** `comfyui-reactor-node` and `ComfyUI_CatVTON_Wrapper`
   failed `git clone` (GitHub rate-limit) → their records are unsupported with no `nfsPath`.
   Retry clone via `proxy.ims.intel.com:911` then re-run harvest+build-records, OR confirm
   they're not wanted and leave documented.

3. **Dep-recover the pure-Python subset of the 33 unsupported.** Crystools, Inspire-Pack,
   FizzNodes, Image-Saver, TeaCache, AutomaticCFG, Dev-Utils, wanBlockswap, MieNodes likely
   only failed because bulk pip was gated off (to protect the shared venv). Run
   `install-deps.sh --with-pip --only <pkg>` per node → re-harvest → many should flip to
   trusted. (Heavy/compiled ones — 3D-Pack, IndexTTS, segment-anything-2, LivePortraitKJ,
   PuLID_Flux — are a separate, larger porting effort, not this item.)

## B. Decisions to make

4. **Turn on `XPU_CATALOG_ENABLED` in production?** Currently unset in the running env →
   the 104 trusted catalog records do NOT drive auto-clone / recipe injection; only the 96
   `knownCustomNodes.ts` entries take effect (those are unconditional). Now that the DB holds
   137 evidence-backed records, decide whether to flip this dark flag on. This is the lever
   that determines whether the catalog half of this work actually lands.

5. **How/whether to use the SYCL image at runtime.** `b7-sycl` image + wheel exist, but the
   shared venv's CPU llama-cpp shadows the image's SYCL build. To run llama on XPU: point a
   gpu-node's `gpu-nodes.json docker_image` at the `-sycl` tag AND swap the shared-venv
   llama-cpp for the SYCL wheel. Default keeps CPU llama-cpp (XPU VRAM reserved for diffusion,
   see memory `llama_cpp_vlm_node`). Left as an explicit opt-in per plan.

6. **Multi-machine reachability.** `knownCustomNodes.ts` ships with the agent to all nodes.
   The catalog-server is single-point on 124.12:3100 — other GPU nodes (e.g. 120.111) need
   `XPU_CATALOG_SERVER_URL` pointed at it and network reachability to consume the 104 trusted
   records. Confirm each node's config + reachability.

## Context
Memory: `catalog_batch_import.md`, `xpu_support_catalog.md`, `llama_cpp_vlm_node.md`.
Related backlog: `backlog-xpu-catalog-step-integration.md` (P4 step-wiring, separate workstream).

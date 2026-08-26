# Backlog: XPU-catalog batch-import follow-ups

Batch-import of the `custom_node_list` (129 nodes) from `comfyui_migration_tasks.xlsx`
is **DONE 2026-08-25** (commits 745ada6→8b957f2; pipeline in `scripts/catalog-import/`;
results + gotchas in memory `catalog_batch_import.md`): catalog 15→137 records
(104 trusted / 33 documented-unsupported), 96 `knownCustomNodes.ts` entries, reusable
SYCL wheel + `intel/llm-scaler-omni:0.1.0-b7-sycl` image on NFS.

**Landed since (2026-08-26):** `XPU_CATALOG_ENABLED` verified on/durable/effective on 124.12
and the 96 `knownCustomNodes` entries **deployed live** to `ComfyUI/agent-demo` (commit
521f8a8). The deploy surfaced + fixed a real bug (see P1 below) and two pre-existing
non-hermetic tests.

## Execution plan (ordered — work one at a time)

- [x] **P0 — enable catalog flag + deploy knownCustomNodes** (done 2026-08-26; see items 4 & Landed above)
- [x] **P1 — tighten prefix matching (over-match guard)** (done 2026-08-26, commit 5977877;
      exact-match bare class_types + `_`-family startsWith; eliminated 100 cross-package
      collisions; catalog-server restarted + agent redeployed on the fix)
- [x] **P2 — end-to-end migration proof** on the live agent — PROVEN end-to-end on XPU
      (2026-08-26, task 303ec304, minimal LoadImage→ImageResizeKJv2→SaveImage): Step 00 detected
      `ImageResizeKJv2`; Step 01 resolved it to `kijai/ComfyUI-KJNodes` via the feature (repo URL
      NOT in the source workflow) + symlinked; Step 05 deployed to the XPU container +
      `object_info/ImageResizeKJv2` REGISTERED=True; **Step 07 branch-smoke executed all 3 nodes
      success on XPU**; rendered a valid 512×512 PNG (11-delivery/outputs); Step 12 GUI acceptance
      marked Pass. Also fixed the default-gpu-node bug (`default_node → local-xpu`; the old
      `remote-124-12` pointed at a minimal `/home/intel/ComfyUI` lacking KJNodes/models). NOTE:
      the agent expects GUI-format workflows (nodes[]+properties.cnr_id+links), not API/prompt JSON.
- [ ] **P3 — dep-recover the pure-Python unsupported subset**  ← NEXT
- [ ] **P4 — re-clone the 2 nodes that 403'd**
- [ ] **P5 — decisions: SYCL-image runtime use; multi-node reachability**
- [ ] (separate workstream) B-backlog: Option-B per-node validation redesign, threshold
      calibration, ssh-node support — see `backlog-xpu-catalog-step-integration.md`
- [ ] (separate workstream) C-backlog: wire `ensure-manager-offline.sh` into deploy;
      dry-run proxy passthrough — see `backlog-manager-offline-dryrun.md`

---

### P1 — tighten prefix matching (over-match guard)  ← NEXT
Surfaced by the deploy: `knownCustomNodeForType` mis-attributed `SeedVR2LoadDiTModel` to
was-node-suite because WAS registers a bare one-word class_type `Seed`, and a naive
first-match/`startsWith` let `Seed` win. Fixed with longest-prefix-wins (commit 9975b25),
which disambiguates **between known packages**. RESIDUAL RISK: a bare short prefix (WAS
`Seed`, `Image Save`, KJNodes exact names, …) can still wrongly claim an **unknown** node
type (one NOT in the catalog) that merely starts with that word — longest-match can't help
when only one package matches. With 96 packages / thousands of prefixes now loaded this is a
real latent correctness risk (wrong "source known" verdict + wrong auto-clone repo).
Plan: (a) audit the 96 entries for over-broad bare prefixes (no delimiter, short, generic);
(b) tighten matching to a word/delimiter boundary (match `prefix` only when the next char is
end-of-string or a separator like `_`/space/`:`) — or require exact match for bare-word
prefixes — so `Seed` no longer prefixes `SeedVR2…`; (c) add regression tests; (d) verify the
catalog's `resolveByNodeType` (LIKE `prefix%`) has the same guard or is acceptably bounded.

### P2 — end-to-end migration proof
Everything is validated only at the `/object_info` registration layer — no imported node has
been run through a full migration to confirm `resolveNodeType → auto-clone → recipe injection`
fires and produces output. The catalog path is now LIVE on the agent, so run 1–2 real
workflows using imported nodes (e.g. a KJNodes + rgthree graph) through the Step pipeline.
Doubles as `backlog-xpu-catalog-step-integration.md` "Remaining #2 (Playwright @migration)".

### P3 — dep-recover the pure-Python subset of the 33 unsupported
Crystools, Inspire-Pack, FizzNodes, Image-Saver, TeaCache, AutomaticCFG, Dev-Utils,
wanBlockswap, MieNodes likely failed only because bulk pip was gated off (to protect the
shared venv). Run `install-deps.sh --with-pip --only <pkg>` per node → re-harvest → many
should flip to trusted. (Heavy/compiled ones — 3D-Pack, IndexTTS, segment-anything-2,
LivePortraitKJ, PuLID_Flux — are a separate, larger porting effort, not this item.)

### P4 — re-clone the 2 nodes that 403'd
`comfyui-reactor-node` and `ComfyUI_CatVTON_Wrapper` failed `git clone` (GitHub rate-limit) →
their records are unsupported with no `nfsPath`. Retry clone via `proxy.ims.intel.com:911`
then re-run harvest+build-records, OR confirm they're not wanted and leave documented.

### P5 — decisions
- **SYCL image runtime use.** `b7-sycl` image + wheel exist, but the shared venv's CPU
  llama-cpp shadows the image's SYCL build. To run llama on XPU: point a gpu-node's
  `gpu-nodes.json docker_image` at the `-sycl` tag AND swap the shared-venv llama-cpp for the
  SYCL wheel. Default keeps CPU llama-cpp (XPU VRAM reserved for diffusion, see memory
  `llama_cpp_vlm_node`). Explicit opt-in.
- **Multi-machine reachability.** `knownCustomNodes.ts` ships with the agent to all nodes; the
  catalog-server is single-point on 124.12:3100 — other GPU nodes (e.g. 120.111) need
  `XPU_CATALOG_SERVER_URL` pointed at it + network reachability to consume the trusted records.

## Reference (done)
4. **`XPU_CATALOG_ENABLED` — DONE on 124.12 (2026-08-26).** Deployed backend runs the flag =1,
   durably sourced from `/home/intel/tianfeng/comfy/env` (loaded by `restart.sh`), verified
   effective via the real `resolveNodeType` path; documented in `env.example`. Other-node
   enablement tracked under P5.

## Context
Memory: `catalog_batch_import.md`, `xpu_support_catalog.md`, `llama_cpp_vlm_node.md`.
Related: `backlog-xpu-catalog-step-integration.md` (P4 step-wiring), `backlog-manager-offline-dryrun.md`.

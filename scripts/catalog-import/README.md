# catalog-import — bulk-import XPU-verified custom nodes into the catalog

Imports the `custom_node_list` tab of `comfyui_migration_tasks.xlsx` (~130 nodes verified
working on Intel XPU) into the XPU-support catalog so future migrations reuse them (auto-clone
+ trusted-recipe injection), and into `src/server/knownCustomNodes.ts`.

## Pipeline (see `run-all.sh`)
0. **parse-xlsx.py** — sheet → normalized `nodes.json`; buckets **A** (bind), **B** (needs a
   compiled SYCL wheel), **C** (full-CUDA / unsupported); `needs_patch` / `in_omni_b7` flags.
1. **clone-nodes.sh** — blobless `git clone` of A/B nodes → `/nfs_share/custom_nodes/<pkg>` + commit.
2. **install-deps.sh** — deps into the shared venv (`with-shared-venv-lock.sh`, skip CUDA-only) +
   **cuda-to-xpu-patch.py** device rewrite for `needs_patch` nodes (diff artifact recorded).
3. **harvest-objectinfo.py** — ONE `intel/llm-scaler-omni:0.1.0-b7` XPU container (nested-mount an
   isolated `custom_nodes`); `GET /object_info`; `python_module` attributes class_types → package
   (derives `nodeTypePrefixes` AND proves XPU registration in one pass = the "simple XPU check").
4. **build-sycl-image.sh** — bucket B only: compile the SYCL wheel IN-CONTAINER, install, copy the
   node in, `docker commit` → new image, `save-docker-image-to-nfs.sh`; save wheel to `/nfs_share/wheels`.
5. **build-records.mts** — build `XpuNodeRecord`s, upsert as `candidate` → `appendValidation`
   (object_info-registered) → **promote to `trusted` only if it registered** on XPU; emit
   `knownCustomNodes.ts` entries for validated nodes. Records live via the catalog-server (indexed
   immediately). Non-registering / bucket-C → `unsupported` + knownIssue (not faked).

## Run
```
export XPU_CATALOG_ENABLED=1 XPU_CATALOG_SERVER_URL=http://127.0.0.1:3100
bash scripts/catalog-import/run-all.sh --pilot   # validate the chain first
bash scripts/catalog-import/run-all.sh --all      # full ~125
```
Then append `/tmp/catalog-import/known-entries.ts` into `src/server/knownCustomNodes.ts`.

## Verify
- `curl :3100/healthz | jq .records` grew; `resolve?nodeType=<class_type>` returns a trusted record.
- A real migration of a workflow using an imported node auto-clones from the catalog.

## Decisions (baked in)
Test image = existing `intel/llm-scaler-omni:0.1.0-b7`; SYCL nodes compiled in-container (no
prebuilt wheels) and baked into a new image, others use bind; `needs_patch` = auto cuda→xpu device
conversion; **test-then-trust**; validated → catalog **and** knownCustomNodes.

# Implicit package dependencies (enum widget values) — detect, install, verify

## The problem

A ComfyUI workflow node can carry **enum widget values** — a `sampler_name`, `scheduler`, `upscale_method`, etc. Custom packages frequently **extend a core node's enum dropdown**: e.g. [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) adds `res_2s` to `KSampler.sampler_name` and `bong_tangent` to `KSampler.scheduler`. `KSampler` itself is **comfy-core** (`cnr_id: comfy-core`), so scanning node *types* sees it as "satisfied" and the dependency on RES4LYF is invisible — until the target (which lacks the package) rejects the prompt: `'res_2s' not in (44 samplers)`.

The old fallback was **substitution** (`res_2s`→`res_multistep`, `bong_tangent`→`normal`). That runs, but changes the denoising algorithm + sigma schedule → the image drifts from the original. Not apple-to-apple.

## The fix: install, don't substitute

Fidelity precedence (agent.md rule 3a): **device redirect > install missing dependency >> semantic substitution (human-approved only)**. For an enum-value dependency the correct resolution is to **install the providing package on the target** so the original value works unchanged.

## How it works

1. **Detect (Step 00 intake, `src/server/enumDependencies.ts`).** For each enum widget value that is not a model/media filename: if a source-side environment lists it (source `object_info` diff) or a recipe maps it (`providesEnumValues`), and the target core baseline lacks it → it's an implicit package dependency. Written to `00-enum-dependencies.csv` (node, slot, value, resolving_package, state). `source known` (package identified) → resolvable by install; `source unknown` → hard stop for human identification. **Recipe mapping is the primary detector** — the source environment is often unreachable, so recipes like `sampler-package-RES4LYF.json` carry the `value → repo` knowledge. Source `object_info` diff is an enhancement (finds packages no recipe knows yet + gives exact per-slot mapping).

2. **Resolve (Step 01/05).** Step 01 treats a `source known` enum-dep as a custom-node acquisition item. Step 05 installs the package on the target with the deterministic tool below.

3. **Tool: `scripts/install-enum-package.mts`** (core: `src/server/enumPackageInstall.ts`). Idempotent 4-phase loop, works local + ssh:
   - **baseline** — GET target `/object_info`; if the value is already present → `already_satisfied`, no-op.
   - **install** — clone the repo into `custom_nodes/` + `pip install -r requirements.txt` (skip if already cloned).
   - **reload** — restart ComfyUI, poll `/object_info` until back.
   - **verify** — GET `/object_info` again, assert the value now appears in the host node's slot.
   ```bash
   npx tsx scripts/install-enum-package.mts \
     --node remote-124-12 \
     --repo https://github.com/ClownsharkBatwing/RES4LYF \
     --host-node-type KSampler \
     --verify sampler_name=res_2s --verify scheduler=bong_tangent
   ```
   Writes `05-enum-package-install.json` (before/after presence, commit, outcome). Exit 0 = `installed_verified` / `already_satisfied`. Non-zero (`install_failed`/`verify_failed`/`comfyui_unreachable`) → the agent surfaces a human gate; substitution is a human-approved last resort only.

## Validated (target 172.16.124.12)

| | before | after |
|---|---|---|
| KSampler samplers | 44 (no `res_2s`) | 63 (`res_2s` ✅) |
| KSampler schedulers | 9 (no `bong_tangent`) | 11 (`bong_tangent` ✅) |
| nodes total | 1660 | 1953 |

Tool E2E: `outcome=installed_verified`, `res_2s`/`bong_tangent` `before=false → after=true`; idempotent re-run = `already_satisfied`.

## Files
- `src/server/enumDependencies.ts` (+test) — detection
- `src/server/sourceObjectInfo.ts` (+test) — source object_info loader + recipe resolver
- `src/server/enumPackageInstall.ts` (+test) — install/verify core
- `scripts/install-enum-package.mts` — CLI tool
- `recipes/nodes/sampler-package-RES4LYF.json` — RES4LYF value→repo mapping
- Step 01/05/06 skills + agent.md rule 3a — install-first, substitute = last resort

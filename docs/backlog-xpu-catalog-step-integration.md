# Backlog: wire the XPU-support catalog into the agent STEP instructions (P4 last mile)

Status: **WIRED 2026-08-20** (commits 455b0ba→…; 686 green) — the loop is now closed in code:
Step 05 prompt+skill route each node via the catalog, take the pessimistic clone-lease
(`scripts/catalog-lease.mts`), bound exploration ≤3 → `ask_user` gate (`scripts/catalog-explore.mts`),
and emit `05-catalog-deploy-ledger.json`; the orchestrator (`catalogValidateAndWriteBack`, Step 07)
drives the isolated harness per node and folds results back (plan B). All flag-gated on
`XPU_CATALOG_ENABLED`. Deterministic core: `classifyCatalogMatch` (commit/dtype routing),
`nodeValidationRunner`, `composeEntriesFromLedger`, `exploreBudget`, lease client + CLIs — each unit-tested.

**Live-test findings (2026-08-20, on 172.16.120.111 —档2):**
- FIXED 3 real harness bugs the mocked unit tests couldn't catch (commit follows): (1) `validate_one_node`
  read `status_str`/`completed` at the top level but `summarize_history` nests them under `status` → every
  node was judged `failed_runtime`; (2) success gated on output *files* → intermediate/loader nodes
  (VAELoader) false-failed — now success = node executed + status success; (3) polled `/history` on a
  self-generated non-UUID `prompt_id` that ComfyUI ignores → now polls the id ComfyUI *returns*.
- OPEN harness limitation: per-node validation submits the FULL workflow prompt + `partial_execution_targets`,
  but ComfyUI validates EVERY node on `/prompt`, so one missing sibling node (live: `BerniniPromptEnhancer`
  not installed on 120.111) rejects the whole submission (`missing_node_type`) and you can't validate even a
  present node. FIX: PRUNE the prompt to the target node's subgraph (target + required upstream) before
  submitting. Until then, live calibration needs a prompt whose node types are all installed on the box.

**Live-test round 2 (2026-08-21): fixed prune + cache-guard; found the no-output blocker.**
- DONE #1 prune-to-subgraph (`prune_to_subgraph`): submit only target + upstream, so an unrelated
  missing/broken SIBLING node no longer rejects the whole prompt. Improves OUTPUT-node branch validation
  (robust vs Step 07 submitting the full prompt).
- DONE #2 force-fresh + cache-guard (`bust_cache` uniquifies seeds; `judge_verdict` marks
  `cachedNotFresh`; write-back SKIPS cached verdicts): a node that only hit ComfyUI's cache is NOT
  recorded as XPU evidence (closes the cache-masking hole).
- OPEN #6 (found live): ComfyUI **rejects any prompt with no output node** (`prompt_no_outputs`), and
  `partial_execution_targets` does NOT bypass it. Prune keeps target + UPSTREAM, so validating a bare
  INTERMEDIATE node (VAELoader/CLIPLoader/conditioning) yields a no-output graph → rejected. FIX: append
  a universal output SINK on the target's output (e.g. `PreviewAny`) so ComfyUI executes it — but the
  sink choice is non-trivial (output type varies: VAE/CONDITIONING/MODEL/IMAGE; sink node availability
  varies). Alternative design: validate the OUTPUT node whose branch USES the custom node (Step-07-style)
  and attribute to the node on that path. Needs fresh design. Until then, per-node validation only works
  for OUTPUT-reaching targets; loaders/intermediate nodes can't be validated in isolation.
- Also: loader/fast nodes don't sustain XPU util → the util threshold must be calibrated on a
  COMPUTE node (sampler/decode), which on the WAN2.2 prompt needs `BerniniPromptEnhancer` installed on
  the box (not present on 120.111) or a fully-installed workflow.

**Design decision (2026-08-21): per-node validation = OUTPUT-branch harvest (option B), with a strict
DB-entry gate.** Instead of running a bare intermediate node (blocked by prompt_no_outputs, #6), validate
the OUTPUT branch(es) that USE the custom node and attribute success to the nodes on the executed path:
- For each deployed custom node, find an output node whose subgraph includes it; prune to that OUTPUT's
  subgraph (has an output → submittable), bust cache (fresh), run on XPU.
- **DB-entry gate (hard):** a node is confirmed "migration complete → written to the catalog" ONLY if it
  was **executed FRESH** (in `executed_nodes`, not merely cached/skipped) on a branch whose run status is
  **success** on XPU. Cached / skipped / not-on-any-successful-branch → NOT recorded (no false "complete").
  One successful branch run can confirm multiple custom nodes on its path at once.
- Trade-off (accepted): per-node XPU-util attribution is branch-level (Step 08 telemetry), not isolated;
  the strong signal is "node executed fresh on a successful XPU branch". Implementation = redesign
  `nodeValidationRunner`/`catalogValidateAndWriteBack` to run/harvest output branches + gate write-back on
  fresh-execution + success. (Supersedes the isolated-per-node harness for intermediate nodes.)

**Env fix (2026-08-21): `BerniniPromptEnhancer` missing on 120.111** — the package `comfyui-rh-bernini`
was on `/nfs_share/custom_nodes` but not symlinked into `comfyui-core/custom_nodes`; fixed by
`ln -s /nfs_share/custom_nodes/comfyui-rh-bernini …/comfyui-core/custom_nodes/` + `docker restart
comfyui-local-xpu` → now registered (820 nodes). This is the exact deployment gap the catalog/Step-05
flow auto-resolves.

**Remaining (live proof, opt-in — not CI gates):**
1. **Threshold calibration** — run the real isolated harness on a node forced-XPU vs forced-CPU
   (172.16.120.111 / remote-124-12), record `xpuUtilizationPct` for both, and set the CPU-fallback
   threshold (currently 15%) from real data. NOTE: for docker-runtime nodes `xpu-smi` lives inside the
   container, so the orchestrator harness on the host may see util=None (gate toothless) — either run
   the harness inside the container or ensure host `xpu-smi`. (Tracked here as the MVP limitation in
   `orchestrator.runCatalogNodeValidation`, which currently handles the local node only.)
2. **Playwright `@migration`** with `XPU_CATALOG_ENABLED=1` — a full live run that creates/updates a real
   catalog record: the ultimate end-to-end proof the loop turns on hardware.
3. **ssh-node + container-xpu-smi** support in `runCatalogNodeValidation` (MVP is local node only).

---
Original gap (now closed) below for history.

## What IS integrated (deterministic TS, fires automatically)
- `assetAcquisition.ts` resolve short-circuit — Step 01 uses a catalog record's repo as a clone hint.
- `recipeInjector.ts` bridge — TRUSTED records injected into steps 02/04/05 prompts as recipe data.
- `orchestrator.ts:365` write-back hook — folds `<artifacts>/catalog-writeback.json` into the catalog
  at Step 05/07 completion.

## The gap (`grep -r catalog|validate_node_xpu|lease prompts/ skills/` == EMPTY)
No step prompt/skill tells the SDK agent to:
1. **Run `validate_node_xpu.py --writeback`** per custom node after install/patch → so
   `catalog-writeback.json` is **never produced** → the write-back hook has nothing to fold → the
   catalog is never populated from real runs → **candidate→trusted never happens** → the
   "auto-migrate → validate → write back → reuse next time" loop is **dead in practice**.
2. **Acquire the per-nodeKey migration lease** before migrating a shared node (and release after) →
   the "multiple agents migrating the same node" protection is **never engaged** in a real run.
3. **Follow a TRUSTED catalog record** when present (the data is injected, but no instruction says
   "if a trusted record exists, deploy per its patches/pip/config").

Root cause: P4b "Step 05 emission" was implemented as the harness's `--writeback` *capability*, but
the Step 05 prompt/skill were never edited to actually call it.

## To close
- Edit `prompts/migration-workflow-v2/prompts/05-environment-deployment-prompt.md` +
  `skills/05-environment-deployment-skill.md`: after install/patch, for each custom node run
  `validate_node_xpu.py --api-url ... --prompt ... --node-type ... --writeback <artifacts>/catalog-writeback.json
  --repository <url> --node-key <key> --package-name ... [--xpu-support ... --package-execution ...]`;
  and "if a trusted catalog record is present, deploy per it".
- (Optional) Step 01 (`01-asset-and-custom-node-resolution`): acquire the catalog lease before cloning
  an unknown shared node; wait+reuse if held; release when done. Client methods exist
  (`xpuCatalogClient.acquireLease/releaseLease`).
- Consider a MORE deterministic alternative: have the orchestrator drive the harness run after Step 05
  (not rely on the SDK agent), matching the "backend owns knowledge writes" doctrine — bigger change,
  needs ComfyUI-up + prompt + per-node source metadata in the orchestrator's hands.
- Tests: extend the skill/recipe audit (or add a check) asserting the Step 05 prompt references the
  harness + writeback; a fixture run that produces `catalog-writeback.json` end-to-end.
- All agent-facing wiring stays behind `XPU_CATALOG_ENABLED` (dark by default).

## Context
See memory `xpu_support_catalog.md`; commits a8a6b89→b26a878; catalog-server on this host :3100.

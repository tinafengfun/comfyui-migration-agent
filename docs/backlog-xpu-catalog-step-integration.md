# Backlog: wire the XPU-support catalog into the agent STEP instructions (P4 last mile)

Status: **open** — logged 2026-08-18. The catalog backend (P0–P4b) is built, tested (649 green),
committed + pushed, and LIVE/enabled on the dev host. But the agent-facing **step prompts/skills do
not yet invoke it**, so the learning loop does not actually turn in a real migration.

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

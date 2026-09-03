# PRD: API-node → local-model-inference substitution

**Status:** draft · **Owner:** migration-agent · **Date:** 2026-09-03

## 1. Problem

Some ComfyUI workflows contain **cloud-API nodes** — nodes whose compute runs on an
external paid service over the network (an API key + HTTP call), not on the local
model runtime. The Intel-XPU target is **offline / on-prem**: it has no cloud API
access, so these nodes cannot run there and the workflow cannot be delivered.

Concrete trigger: the batch triage of `comfy_flow/workflows` (via
`scripts/triage-workflows.mts`) surfaced **`GeminiNode`** in *Story generation v2* —
a Google `gemini-2.5-flash` VLM node (`images + audio + video + prompt → STRING`,
4 instances, system prompt "continuity director for a four-panel comic page"). It is
the migration blocker for that workflow, and the same class of blocker (OpenAI /
Kling / Runway / ElevenLabs / … nodes) will recur across a workflow fleet.

Today the agent has no path for this: such a node is flagged unknown / `human_source_work`
and the migration stops. There is no mechanism to **replace a cloud-API node with a
local model node that does the equivalent inference on the XPU**.

## 2. Goal / non-goals

- **Goal:** detect cloud-API nodes and, where a local model can do the equivalent
  work, substitute them with a local-inference node — graph-rewired, human-approved —
  so the workflow runs fully offline on the XPU.
- **Non-goals:**
  - Reproducing cloud quality bit-for-bit (a 7B local VLM ≠ gemini-2.5-flash; drift is
    expected and disclosed, not eliminated).
  - Substituting cloud abilities with **no** local equivalent (e.g. a proprietary
    cloud video generator) — those are marked "cannot localize → human", not forced.
  - Running any cloud API on the target (the whole point is to remove the cloud call).
  - Training / fine-tuning local models.

## 3. Users & scenarios

Runs inside a normal migration (batch or single), for whoever migrates a workflow.

1. **VLM (the trigger):** *Story generation v2* — `GeminiNode` (image+prompt→text) →
   local `ComfyUI-llama-cpp_vlm` (Qwen2-VL GGUF on XPU). Story pipeline runs offline.
2. **LLM:** a text-only cloud LLM node (prompt→text) → local llama_cpp text model.
3. **No-equivalent:** a cloud-only video/image-gen API node → flagged "cannot localize",
   surfaced to the human (not substituted).

## 4. Requirements

Functional:
- **FR1** Detect cloud-API nodes deterministically at intake — by node class + package
  signature (extend `scripts/triage-workflows.mts`'s API heuristic into a catalog-backed
  classifier), not just a name regex.
- **FR2** A **capability matrix**: `(api node class, modality signature) → local node
  recipe`. Modality = input/output types (e.g. `IMAGE+STRING→STRING` = VLM). Config/recipe
  driven, extensible without code changes for a new mapping.
- **FR3** A **dedicated, OPTIONAL migration step** ("node localization", after Step 03,
  before Step 05) owns the propose→approve→rewrite flow and writes the substituted
  workflow + a provenance artifact. **Fast-pass:** when no handler has anything to do
  (e.g. no API nodes in the graph), the step completes immediately as a no-op (status
  "skipped / nothing to localize") — it must not add a gate or latency to the common case.
- **FR3a** The step is **extensible**: a small registry of "node handlers", each of which
  (a) matches nodes it cares about and (b) proposes a graph transform. API-node→local
  substitution is **handler #1**; future handlers (other special-node transforms) plug in
  without touching the step's orchestration. The step just: run each handler's matcher →
  if any proposals, gate + apply → else fast-pass.
- **FR4** Graph rewrite: replace the API node with the mapped local node(s) and remap
  its links — inputs (`images→image`, `prompt→prompt`), **audio → a local ASR sub-node
  whose text is joined into the prompt**, video/files dropped (recorded); output
  (`STRING→text`). Must produce a valid graph (no dangling required inputs) downstream
  nodes accept.
- **FR5** Human approval gate: substitution changes behavior → present the proposed
  mapping (from-node, to-node(s), dropped inputs, model) and require explicit approval
  (`ask_user`) before rewriting. On reject → mark the node human-blocked.
- **FR6** No-equivalent handling: an API node whose modality has no matching local
  recipe → a typed boundary ("cannot localize"), surfaced, never silently dropped.
- **FR7** Delivery provenance: the migrated workflow + report record every substitution
  ("GeminiNode → llama_cpp VLM (Qwen2-VL) + local ASR for audio; dropped video/files;
  result may differ from gemini-2.5-flash") so the boundary is explicit.

Non-functional:
- Deterministic + recipe-driven (matches the two-layer injection model); no LLM guess in
  the load-bearing rewrite path.
- Flag-gated, default-off initially; the old "flag as human" behavior is the fallback.
- Local inference runs on XPU (or CPU for the VLM, per current llama_cpp placement).
- Backward-compatible: workflows with no API node are unaffected.

## 5. Design (reuse first)

New vocabulary + a substitution recipe, executed by the existing normalizer:

- **Detection — extend triage into the catalog.** Add an `api_local_substitute`
  (and `api_no_local_equivalent`) value to `MigrationRoute` (`src/catalog/schema.ts:38`).
  Classify API nodes by class + package in the catalog (single source of truth), seeded
  from `scripts/triage-workflows.mts`'s API set. Step-00 `detectCatalogBoundaries`
  (`intakePreflight.ts`) already turns catalog routes into typed intake signals — reuse it
  to raise "API node found: proposed local substitute X".
- **Capability matrix = substitution recipes.** A new recipe family under `recipes/`
  (mirrors `recipes/nodes/*.json`) keyed by the API node class + modality signature,
  pointing at the local node recipe (e.g. reuse `recipes/nodes/llama_cpp_model_loader.json`,
  recipeId `llama-cpp-vlm-cpu-native`). Loaded by the recipe injector.
- **A dedicated, OPTIONAL step — "node localization" (e.g. Step 03b), after inventory
  (03), before deploy (05).** Own step for clean separation + isolated testing, built
  around a **handler registry** so it stays flexible for future node-processing needs:
  ```
  interface NodeHandler {
    id: string;
    match(graph): NodeMatch[];              // nodes this handler wants to transform
    plan(matches, graph): SubstitutionPlan; // proposed graph transform + provenance
  }
  const handlers = [apiSubstitutionHandler /* #1 */ /*, future handlers */];
  ```
  The step: run every handler's `match` → if **no** matches across all handlers,
  **fast-pass** (complete as no-op "nothing to localize", no gate, no latency) → else
  build the combined plan, propose via `ask_user`, on approval apply the rewrite, write
  the localized workflow + provenance. Registered like the other steps in
  `orchestrator.ts`. Adding a future capability = add a handler, not a new step.
- **Graph rewrite — the normalizer.** The rewrite itself is a pure pass in
  `src/server/workflowNormalize.ts` (the existing graph-surgery seam that already cuts/
  re-points links): `substituteApiNodes(graph, plan)` — for each approved mapping insert
  the local node(s), rewire links per the recipe's input/output map, remove the API node.
  Unit-testable in isolation; the new step just orchestrates gate→apply.
- **Audio → local ASR (multi-node substitution).** When the API node has a connected
  `audio` input, the plan inserts a **local ASR node** (speech→text) whose text output is
  concatenated into the VLM `prompt` (reuse a `StringConcatenate`-style join). So
  `GeminiNode(image+audio+prompt→text)` becomes `[ASR(audio→text)] + [VLM(image+prompt'→text)]`
  where `prompt' = prompt + ASR text`. Video/files inputs are dropped in v1 (recorded in
  provenance). The recipe declares this composite mapping.
- **Local models.** VLM: `ComfyUI-llama-cpp_vlm` (already XPU/SYCL, `gpu_offload=True`,
  models→`models/LLM`). ASR: a local speech-to-text node (e.g. a whisper.cpp / faster-whisper
  ComfyUI node) — added to the catalog/recipes as its local node is confirmed on-prem.

Interaction with the migration steps: detection at 00, then the dedicated localization
step (03b) does propose→approve→rewrite; the rest of the pipeline (05 deploy, 08 capacity,
12 render) runs on the already-local graph unchanged.

## 6. Phased plan

- **Phase 0 — the step + GeminiNode→VLM(+ASR), end-to-end (MVP / de-risk):** the
  dedicated optional localization step with the **handler registry** (one handler:
  `apiSubstitutionHandler`) + the `substituteApiNodes` normalizer pass + the `ask_user`
  approval gate. Mapping: `GeminiNode` → local VLM, and an ASR sub-node when audio is
  connected. `api_local_substitute` route added. **Fast-pass proven** (a workflow with no
  API node skips the step instantly). Prove *Story generation v2* migrates + renders
  offline on a GPU node (zero API nodes in the deployed graph). Everything flag-gated.
- **Phase 1 — capability matrix:** lift the mapping into recipe-driven
  `(class,modality)→local recipe`; add the catalog `api_*` routes + the triage classifier;
  add LLM (text→text). A third-party API node → matrix lookup, no code change.
- **Phase 2 — coverage + no-equivalent:** TTS→local, image-caption→VLM, video/files
  sub-nodes; the `api_no_local_equivalent` boundary path + provenance report; batch-triage
  integrates the classifier.

## 7. Risks & mitigations

1. **Behavior drift (highest):** local VLM ≠ gemini-2.5-flash → different story text.
   Mitigate: mandatory human approval + explicit delivery provenance ("substituted, may
   differ"); never auto-substitute silently.
2. **Signature mismatch:** the API node takes inputs the local node can't (audio/video/
   files) → a rewrite that dangles or breaks downstream. Mitigate: the recipe declares the
   exact input/output map + which inputs are dropped; the normalizer validates the
   resulting graph (no dangling required inputs) before accepting; reject → human.
3. **Wrong "no-equivalent" call:** marking something un-localizable that actually has a
   local path (or vice-versa). Mitigate: catalog-backed classification, human review of
   the proposal, matrix is data so it's correctable without a release.
4. **Local model capacity:** the added VLM competes for XPU/VRAM with the workflow's own
   models. Mitigate: the VLM already runs CPU/offloaded (llama_cpp placement); Step-08
   capacity probe covers the combined graph.

## 8. Acceptance & verification

- **Unit:** `substituteApiNodes` graph transform (GeminiNode replaced, links remapped,
  audio→ASR sub-node joined, video/files dropped, no dangling required inputs); the step's
  **fast-pass** (a graph with no matches completes as no-op, no gate); handler-registry
  dispatch; catalog route round-trip; capability-matrix lookup; triage classifier flags
  GeminiNode as `api_local_substitute`.
- **Live:** *Story generation v2* migrates 00→12 on a GPU node with the GeminiNode
  substituted by the local VLM — no cloud call (verify no network to Google), produces a
  valid image output, quality-assessed by the existing `tests/helpers/quality.ts` gate.
- **Behavior/regression:** the migrated graph contains zero API nodes (assert), the
  provenance report lists the substitution, and the render passes the output-quality gate.

## 9. Decisions (resolved 2026-09-03)

- **v1 scope:** **VLM only** (GeminiNode → local VLM). LLM/TTS deferred to later phases.
- **Local model:** **use the local VLM already on-prem** — `ComfyUI-llama-cpp_vlm`
  (Qwen2-VL GGUF on XPU/SYCL). No cloud, no new model class in v1.
- **Step placement:** a **dedicated new migration step** for API-node localization (not
  folded into Step-02) — cleaner separation, easier to maintain/test in isolation.
- **Dropped modalities:** when the API node has a connected **audio** input, insert a
  **local ASR sub-node** (speech→text) and feed the transcript into the VLM prompt (a
  multi-node substitution), rather than dropping audio. Video/files: dropped in v1 (noted
  in provenance) unless a connected modality has a local sub-node.

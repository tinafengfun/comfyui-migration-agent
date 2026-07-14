# GUI→API graph normalization — design

## Problem
Workflows exported from the ComfyUI **GUI** can contain constructs the **API/DAG execution engine** rejects or misreads:
- **Dependency cycles** from a non-persisted GUI toggle (rgthree *Fast Groups Bypasser* / group-mute, Comfyroll switches) — the toggle state isn't written into the links, so the API sees a real cycle and ComfyUI returns `dependency_cycle`.
- **Wiring-error loops** (a transform fed by the node it feeds).
- Native `mode: 4` (bypass) / `mode: 2` (mute) — the API *does* honor these, but only if set.

Concretely (Work-FIsh-Z-Image 瑶光版): `SeedVR2VideoUpscaler(41)` ↔ `ImageScaleToTotalPixels(35)` formed a cycle because the "1SeedVR放大" group's rgthree bypass widget (node 44) wasn't persisted → the exported graph had both nodes active in a loop → Step 07 smoke couldn't run the upscale branch.

## First principles
- **P1 coverage parity** — every node the GUI runs must still execute in the API test. Re-wire, never delete/skip.
- **P2 break dead loops** — a cycle can't run in ComfyUI's DAG; cut the erroneous back-edge.
- **P3 order/count → VRAM** — a cycle = ∞ invocations (catastrophic). Breaking it makes each node run once, source→sink, offload-friendly.

## Solution (two-layer, matching the agent's knowledge architecture)

### Layer 1 — deterministic stage `Step 03½: graph normalization`
A new deterministic step (or a sub-phase of Step 03 inventory), right after the workflow is loaded and before any execution:

1. `src/server/workflowNormalize.ts` — `normalizeWorkflowForApi(wf) → { normalized, report }` (logic ported from `scripts/normalize-workflow.mjs`).
2. Honor ComfyUI native `mode`: mute(2) nodes leave the execution graph; bypass(4) pass through.
3. **Tarjan SCC** cycle detection on the execution graph.
4. For each cyclic SCC, identify the **transform node** (upscaler/sampler/scale, or the node with external model/param inputs), cut its **IMAGE back-edge**, rewire it to the workflow's **primary VAEDecode output** (the original decoded image). Minimal cut — one edge per cycle; the downstream node keeps its edge from the transform (e.g. a preview-scaler still sees the upscaled output).
5. Validate: result is a DAG (Kahn) + full active-node coverage (P1).
6. Emit `03-graph-normalization.json`: every change (link cut/reconnected, why), the topological execution order, and heavy-node/offload notes (P3). Auditable + reproducible.
7. The normalized graph is what Step 05/07/08 execute. Step 06's runtime-policy notes the normalization.
8. **Unresolvable** (no VAEDecode source, >2-node SCC the heuristic can't disambiguate) → human gate carrying the full analysis (which cycle, proposed surgery), not a blunt smoke-time gate.

### Layer 2 — recipe `graph-cycle-resolution` (soft fallback)
When the deterministic stage detects a cycle it flags-but-doesn't-auto-resolve, inject this recipe into the Step 06/07 prompt so the SDK agent applies the principled surgery: *cut the transform's IMAGE back-edge, rewire to the decoded image; preserve all nodes; record the change*. Handles edge cases the deterministic code can't.

## Generality
Resolves the whole class: any GUI export with a non-persisted toggle, a wiring-error loop, or a muted group is normalized automatically — no per-workflow manual fix. Extensible to other GUI-only constructs (view-node handling, subgraph reroutes) by extending `workflowNormalize.ts`.

## Status
- `scripts/normalize-workflow.mjs` — standalone tool, validated on WF2 (cut link 53, rewired 41←VAEDecode(17); Step 07 passed, SeedVR2 ran on XPU). Commit `0baa989`.
- **Next**: port to `src/server/workflowNormalize.ts`, wire into the orchestrator as Step 03½, add the recipe, extend Step 03 skill to reference the normalization artifact.

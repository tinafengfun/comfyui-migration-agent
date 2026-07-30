# Workflow inventory skill

## Use when

Use as Step 03 after asset/custom-node resolution and feasibility routing, before source audit or runtime work.

## Inputs

- workflow JSON
- node registry if available
- target output modes
- latest dependency and feasibility artifacts: `00-intake-preflight.md`, `01-assets.csv`, `01-custom-nodes.md`, Step 01 acquisition/cache evidence, and `02-feasibility.md`

## Algorithm

1. Count nodes and links from the actual graph, not `last_link_id`.
2. Identify all output nodes by type and by graph role.
3. Trace each output node upstream to determine branch ownership and critical paths.
4. Trace output/display nodes downstream before classifying them. If they feed another executable node, keep them in the executable path.
5. **Dead-end node detection.** Take the output nodes validated by `execution.validate_prompt` (the nodes whose class is registered `OUTPUT_NODE = True` — the nodes ComfyUI actually treats as output roots) and, for each, trace its full upstream dependency tree within the API prompt. Compute the union of all those trees. Any API-prompt node that is *not* in that union is a **dead-end** node: ComfyUI prunes it (it never executes), so it has no effect on rendered output. Classify and list every dead-end node explicitly in `03-inventory.md` with the pruned/unconsumed-output reason and, where a sibling node supersedes it on the active output path, which active node/path replaces it (e.g. `WanVideoBlockSwap->WanVideoSetBlockSwap` pairs where a parallel `WanVideoBlockSwap` feeds the real model loader). Do this in the **first pass** — do not defer dead-end classification to Step 10 coverage review.
6. Split structural/UI nodes from executable nodes.
7. List disconnected notes, examples, bypass utilities, and dead-end nodes separately from runtime blockers. The dead-end list from step 5 must appear here verbatim.
8. Mark custom-node packages and widget-heavy nodes.
9. If asset/custom-node/acquisition artifacts already exist, refresh dependency states from them so the inventory does not repeat stale hard stops.
10. Produce a branch map, critical-path inventory, node inventory table, and recommended validation order.
11. Emit all-node inventory: every source node must appear exactly once with role, branch membership, package/origin, dependency state, migration risk, and **dead-end flag** (live / dead-end).
12. Emit a `completion_decision` block and a Toolization block before closing Step 03.

## Dead-end node detection (API prompt graph trace)

ComfyUI's `execution.validate_prompt` resolves which nodes are true output roots for a given API prompt: a node is an output root if its class is registered with `OUTPUT_NODE = True` in the backend node registry (read from `object_info` / registration evidence). Only these output roots, and their upstream dependency trees, are executed by ComfyUI and affect rendered output. Any other API-prompt node is a **dead-end**: present in the prompt but pruned by ComfyUI (never executed), because no registered output node depends on it.

Step 03 must perform this trace itself, in the first pass:

1. Determine output roots the same way `execution.validate_prompt` does: a node is an output root iff its class is registered with `OUTPUT_NODE = True` in the backend node registry (read from `object_info` / registration evidence; e.g. `VHS_VideoCombine`, `easy showAnything`, `Evaluate Floats`, `SaveImage`, `PreviewImage`). Note this is **not** the same as "no outgoing links" — a registered output node whose output is also fed onward is still an output root, and a non-output leaf (e.g. `WanVideoSetBlockSwap`) is **not** an output root and is pruned by ComfyUI entirely. (When the GUI export and the normalized API prompt differ, run this on the API prompt that Steps 05/07/08 will actually execute.)
2. For each output root, walk upstream over `inputs` links (an input value of the form `[<upstream_node_id>, <output_index>]` is a link; scalar values are widgets and have no upstream node) until no further upstream node exists. Collect the visited set.
3. The union of all upstream trees is the **live set**. Every API-prompt node not in the live set is a **dead-end** node (ComfyUI prunes it and never executes it).
4. For each dead-end node, record: node id, type, what its output feeds (if anything), and the active live node/path that supersedes it (so downstream steps know which competing widget value — e.g. `blocks_to_swap` — is actually in effect).
5. Emit the dead-end list in `03-inventory.md` and flag each node `dead-end` in the all-node inventory table. Downstream steps (06 prompt conversion, 10 coverage review) must consume this classification rather than re-deriving it.

This catches cases like two `WanVideoBlockSwap` nodes where only one's `block_swap_args` reaches the active `WanVideoModelLoader` (via `WanVideoSetBlockSwap`); the other `WanVideoBlockSwap->WanVideoSetBlockSwap` pair is dead-end (its `WanVideoSetBlockSwap` is not an `OUTPUT_NODE`, so ComfyUI prunes the whole pair) and its `blocks_to_swap` widget value is inert. Surfacing this in Step 03 prevents downstream confusion about which value is active.

## Graph normalization (GUI→API cycle resolution)

The backend runs a deterministic normalizer during Step 03 and writes `03-graph-normalization.json` (report). This fixes dependency cycles that ComfyUI's DAG API rejects — the common case is a transform (upscaler/sampler) whose IMAGE input is wired to a node it also feeds, a leftover from a non-persisted GUI group-bypass/switch widget (rgthree *Fast Groups Bypasser*, Comfyroll switches) or a wiring error.

- When the normalizer changes the graph, it **replaces the source workflow file with the normalized (acyclic) DAG** and backs up the GUI original to `<name>.gui-original.json`. So Steps 05/07/08 already execute the normalized graph — **do not re-fix the cycle yourself** (do not delete the bidirectional links; that leaves the transform with no image input). Just note in the inventory + Step 06 runtime-policy that the API-executed graph differs from the GUI export (which back-edge was cut and rewired — see `03-graph-normalization.json`).
- If `03-graph-normalization.json` lists `unresolved` cycles (the deterministic code couldn't pick a back-edge — e.g. no VAEDecode/image-producer source, or a complex >2-node SCC), analyze the cycle yourself and propose the principled surgery: **cut the transform node's IMAGE back-edge and rewire it to the workflow's primary image producer (VAEDecode output)**; keep all nodes executing (never skip/delete); record the change. Surface it as a human gate with the proposed rewire.

## Common failure signatures

- `last_link_id` treated as real link count
- display-only nodes counted as runtime blockers
- display-looking output nodes marked display-only even though their outputs feed later runtime nodes
- disconnected notes, example preprocessors, or bypass utilities treated as output blockers
- dead-end nodes (output consumed by no output node) missed in Step 03 and only discovered later in Step 10 coverage review, causing confusion about which competing widget value is active
- stale Step 00 dependency gaps repeated after Step 01 already staged a replacement asset or dependency cache
- artifact name mismatch between `03-inventory.md` and project-specific split outputs
- branch not represented in API prompt
- one output branch mistaken for whole workflow

## Evidence standard

Retain workflow JSON, branch map, node/type table, output-node list, disconnected/dead-end node list, the dead-end detection trace (output roots, live set, dead-end set), and the latest dependency-state artifacts used as inputs.

Do not claim completion unless node count, link count, output branches, disconnected/dead-end/structural nodes are classified, the dead-end detection trace is present, latest dependency states are reflected, source workflow immutability is confirmed, and `step04_context` is present.

## Hard stops

Stop if output branches or executable-node ownership cannot be determined. Stop or explicitly defer if the artifact naming requested by the project conflicts with the standard contract and cannot be mapped to the required fields.

## Completion decision

Every Step 03 artifact must include:

```text
completion_decision:
  status:
  success_criteria_checked:
  evidence_artifacts:
  unresolved_gaps:
  human_gate_prompt:
  next_step_allowed:
```

`complete` is allowed only when Step 02 context was consumed, every source node is inventoried, output branches are mapped, disconnected/dead-end/structural nodes are classified (with the dead-end detection trace recorded), latest dependency states are reflected, source workflow immutability is confirmed, and `step04_context` is present.

## Output schema

`node_count`, `link_count`, `outputs`, `branches`, `executable_nodes`, `structural_nodes`, `disconnected_nodes`, `dead_end_nodes` (with output roots, live set, and dead-end set from the API-prompt graph trace), `custom_node_packages`, `export_risks`, `node_inventory`.

Default artifact:

```text
03-inventory.md
```

Allowed split artifact form for complex workflows:

```text
03-workflow-topology.md
03-node-inventory.csv
```

Recommended reusable scaffold:

```text
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step03_inventory_scaffold.py --workspace <workspace>
```

The scaffold is safe only for read-only Step 03 work. It may parse workflow links, map upstream output branches, inventory every node, refresh dependency state from Step 01/02 artifacts, and write Step 03 artifacts. It must not run ComfyUI, install packages, convert prompts, edit workflows, or make source-runtime compatibility claims.

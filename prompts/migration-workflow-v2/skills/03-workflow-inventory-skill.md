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
5. Split structural/UI nodes from executable nodes.
6. List disconnected notes, examples, bypass utilities, and dead-end nodes separately from runtime blockers.
7. Mark custom-node packages and widget-heavy nodes.
8. If asset/custom-node/acquisition artifacts already exist, refresh dependency states from them so the inventory does not repeat stale hard stops.
9. Produce a branch map, critical-path inventory, node inventory table, and recommended validation order.
10. Emit all-node inventory: every source node must appear exactly once with role, branch membership, package/origin, dependency state, and migration risk.
11. Emit a `completion_decision` block and a Toolization block before closing Step 03.

## Graph normalization (GUI→API cycle resolution)

The backend runs a deterministic normalizer during Step 03 and writes `03-graph-normalization.json` (report). This fixes dependency cycles that ComfyUI's DAG API rejects — the common case is a transform (upscaler/sampler) whose IMAGE input is wired to a node it also feeds, a leftover from a non-persisted GUI group-bypass/switch widget (rgthree *Fast Groups Bypasser*, Comfyroll switches) or a wiring error.

- When the normalizer changes the graph, it **replaces the source workflow file with the normalized (acyclic) DAG** and backs up the GUI original to `<name>.gui-original.json`. So Steps 05/07/08 already execute the normalized graph — **do not re-fix the cycle yourself** (do not delete the bidirectional links; that leaves the transform with no image input). Just note in the inventory + Step 06 runtime-policy that the API-executed graph differs from the GUI export (which back-edge was cut and rewired — see `03-graph-normalization.json`).
- If `03-graph-normalization.json` lists `unresolved` cycles (the deterministic code couldn't pick a back-edge — e.g. no VAEDecode/image-producer source, or a complex >2-node SCC), analyze the cycle yourself and propose the principled surgery: **cut the transform node's IMAGE back-edge and rewire it to the workflow's primary image producer (VAEDecode output)**; keep all nodes executing (never skip/delete); record the change. Surface it as a human gate with the proposed rewire.

## Common failure signatures

- `last_link_id` treated as real link count
- display-only nodes counted as runtime blockers
- display-looking output nodes marked display-only even though their outputs feed later runtime nodes
- disconnected notes, example preprocessors, or bypass utilities treated as output blockers
- stale Step 00 dependency gaps repeated after Step 01 already staged a replacement asset or dependency cache
- artifact name mismatch between `03-inventory.md` and project-specific split outputs
- branch not represented in API prompt
- one output branch mistaken for whole workflow

## Evidence standard

Retain workflow JSON, branch map, node/type table, output-node list, disconnected/dead-end node list, and the latest dependency-state artifacts used as inputs.

Do not claim completion unless node count, link count, output branches, disconnected/reference nodes, and dependency states are backed by durable artifacts. Source workflow immutability must be explicitly stated.

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

`complete` is allowed only when Step 02 context was consumed, every source node is inventoried, output branches are mapped, disconnected/dead-end/structural nodes are classified, latest dependency states are reflected, source workflow immutability is confirmed, and `step04_context` is present.

## Output schema

`node_count`, `link_count`, `outputs`, `branches`, `executable_nodes`, `structural_nodes`, `disconnected_nodes`, `custom_node_packages`, `export_risks`, `node_inventory`.

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

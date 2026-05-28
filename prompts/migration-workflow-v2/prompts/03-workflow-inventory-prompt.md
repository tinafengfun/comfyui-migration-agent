# Workflow inventory prompt

## Task

Inventory the workflow graph before runtime migration.

This is Step 03 in the v2 migration workflow.

## Required context

- workflow JSON
- node definitions if available
- known ComfyUI/custom-node checkout
- latest dependency and feasibility artifacts, especially `00-intake-preflight.md`, `01-assets.csv`, `01-custom-nodes.md`, Step 01 acquisition/cache evidence, and `02-feasibility.md`

## Constraints

1. Do not bypass or remove nodes.
2. Separate structural UI nodes from executable runtime nodes.
3. Do not claim node coverage until branches and outputs are mapped.
4. Do not run ComfyUI, install dependencies, or modify the workflow.
5. Do not reuse stale dependency states if newer ledgers or acquisition logs exist.
6. Do not assume a Save/Preview/ShowText/Comparer node is display-only until its downstream links are checked.
7. Account for every source workflow node in the Step 03 inventory. Disconnected notes, dead-end sinks, frontend-only controls, bypass utilities, and non-output references can be classified separately, but cannot be omitted.
8. Preserve source workflow immutability. If a prompt/export variant is needed later, Step 03 only records the risk and passes it to Step 04/06; it does not edit the workflow.

## Steps

1. Count nodes, links, output nodes, and node types. Count links from the actual `links` array, not `last_link_id`.
2. Build a branch map from inputs to outputs.
3. For every output node, trace upstream critical-path nodes and record upstream node count.
4. Trace downstream links from output/display nodes; if an output node feeds another node, mark it as executable-path relevant.
5. Mark critical path nodes for each output branch.
6. Identify widget-only or half-widget nodes likely to break API export.
7. Identify custom-node packages by node type.
8. List disconnected notes, bypass utilities, example nodes, and dead-end nodes separately from runtime blockers.
9. Refresh dependency-state notes from newer asset/custom-node/acquisition artifacts if they exist.

## Output

Create a workflow inventory report. The default file is `03-inventory.md`; for complex workflows, it may be split into `03-workflow-topology.md` plus `03-node-inventory.csv`.

The report must include:

- node/type counts
- output branch table
- executable-node list
- structural-node list
- disconnected/dead-end node list
- custom-node package map
- prompt-export risk list
- recommended branch validation order

The optional node inventory CSV should include at least:

```text
node_id,type,order,mode,link_role,role,branches,inputs_from,outputs_to,package_or_origin,dependency_state,migration_risk
```

Every Step 03 report must include a `completion_decision` block:

```text
status:
success_criteria_checked:
evidence_artifacts:
unresolved_gaps:
human_gate_prompt:
next_step_allowed:
```

It must also include a Toolization section stating whether the inventory/topology extraction was automated, where the script/tool lives, command used, inputs, outputs, and limitations.

## Success criteria

Step 03 is `complete` only when:

- the Step 02 context was consumed directly;
- node count and link count reconcile with Step 02 and the source workflow;
- every source node appears in `03-node-inventory.csv` or equivalent durable inventory;
- every output/display node has a mapped upstream branch and branch artifact;
- disconnected/reference/dead-end/structural nodes are classified rather than dropped;
- latest Step 01/02 dependency and boundary states are reflected;
- source workflow immutability is confirmed;
- `step04_context` is present.

## Hard stops

Stop if branch ownership, output nodes, or critical paths cannot be determined from the workflow.

## Toolization

Use or create a deterministic, read-only topology extractor when possible. The current reusable implementation is:

```text
ComfyUI/docs/draft/migration-workflow-v2/tools/step03_inventory_scaffold.py
```

The tool may parse the workflow graph, map output branches, refresh dependency state from prior artifacts, and write inventory/topology artifacts. It must not run ComfyUI, install packages, convert prompts, edit workflows, or decide runtime compatibility.

## Prior-migration lessons

Dasiwa was a multi-branch workflow; one successful branch did not prove the full graph. Review must later compare workflow JSON, converted prompt, full-run evidence, and branch-smoke evidence.

Zimage added three Step 03 lessons:

1. Artifact naming must be explicit. `03-inventory.md` is the canonical single-file output, but `03-workflow-topology.md` plus `03-node-inventory.csv` is acceptable when the workflow is easier to review as topology plus table.
2. Display-looking nodes may still be runtime dependencies. A text output that feeds `CLIPTextEncode`, for example, is not display-only.
3. If dependency acquisition or replacement-input staging already happened, inventory must refresh hard-stop wording from the latest ledgers instead of repeating stale preflight state.

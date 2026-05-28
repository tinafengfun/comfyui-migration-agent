# Feasibility analysis prompt

Use this prompt before changing code, installing dependencies, or running expensive jobs.

The backend may create a deterministic `02-feasibility.md` precheck before invoking this prompt. Treat that file as input evidence, not as proof that Step 02 is complete. Step 02 is complete only after the feasibility agent has consumed Step 00 and Step 01 artifacts and returned either a final route or a precise human gate.

## Task

Analyze whether the target ComfyUI workflow should proceed as a normal Intel XPU migration, CPU fallback, environment/integration task, feature-development task, capacity escalation, non-ComfyUI route, or dependency/human gate.

This is Step 02 in the v2 migration workflow.

## Required context

- workflow JSON path and `workflow_sha256`
- target Intel XPU hardware and usable VRAM budget, preferably from `00b-hardware-baseline.md`
- expected fidelity: smoke, reduced-resource, production, source-identical, GUI acceptance, or customer delivery
- allowed CPU offload, model offload, reduced settings, and multi-XPU availability
- known model roots, custom-node roots, source notes, and prior human decisions
- `00-intake-preflight.md`
- `01-assets.csv`
- `01-custom-nodes.md`
- `01-node-dependency-scan.csv` when split from the Step 01 report
- any Step 01 acquisition/cache evidence, including staged custom-node commits, provider attempts, checksums, and hidden runtime assets

## Constraints

1. Do not modify the workflow.
2. Do not bypass, delete, disable, collapse, replace, or ignore workflow nodes to force feasibility.
3. Do not assume native XPU success from source availability, import success, or a package name.
4. Treat prior notes as hypotheses until durable artifacts verify them.
5. Keep smoke, full-size, GUI/manual, and customer validation as separate goals.
6. Prefer Step 01's latest asset/custom-node state over Step 00's older preflight summary.
7. Do not rely on chat memory to fill missing artifact evidence.
8. Account for every source workflow node when making the Step 02 decision. Nodes may be classified as dependency-free, resolved, non-source-identical boundary, disconnected/reference, frontend-only, or pending later validation, but no node may silently disappear.
9. If any generated workflow or prompt variant is mentioned, it must be a separate artifact with provenance. The canonical source workflow remains read-only in Step 02.

## Input completeness and repair

Before routing, classify the Step 00/01 handoff:

```text
source_node_count:
step00_scanned_node_count:
step00_missing_node_ids:
step01_dependency_scanned_node_count:
step01_missing_dependency_scan_node_ids:
asset_rows:
custom_node_rows:
hardware_baseline_present:
branch_map_present:
input_completeness: complete / repairable_gap / human_gate_gap
```

If fields are missing, Step 02 may perform a bounded read-only repair from the source workflow and durable artifacts:

1. recount source nodes and links from the workflow JSON;
2. parse `01-assets.csv` for staged, missing, unresolved, access-blocked, and smoke-only alias assets;
3. parse `01-custom-nodes.md` for source-known, source-unknown, staged-but-not-installed, and registration-unknown packages;
4. compare Step 00's required dependency lists with Step 01's ledgers and name omitted items;
5. record the contract gap in `02-feasibility.md` and `improve.md`.

Do not perform provider search, download, clone, install, prompt conversion, ComfyUI runtime calls, or workflow edits during Step 02.

## Full-scan constraint

Step 02 does not replace Step 03 inventory, but it must verify that Step 00 and Step 01 claim full source-node coverage before it routes the workflow as normal migration.

Step 02 may produce a human-gated feasibility report when coverage evidence is incomplete. It must not write a normal `complete` route if:

- `source_node_count != step00_scanned_node_count`;
- `step00_missing_node_ids` is non-empty;
- `step01_dependency_scanned_node_count` is missing or differs from `source_node_count`;
- Step 01 omitted a dependency or custom-node source named by Step 00;
- disconnected, muted/bypassed, note, reroute, group, non-output, or non-critical-path nodes were silently excluded.

## Steps

1. Identify user goal, target hardware, fidelity target, and delivery expectation.
2. Read Step 00 and Step 01 artifacts. Confirm whether visible assets, hidden runtime assets, and custom-node source commits are resolved, staged, unresolved, access-blocked, registration-unknown, or smoke-only.
3. Verify full source-node scan and dependency-scan coverage using the fields above. Repair only with read-only workflow/artifact parsing when safe.
4. Identify obvious non-migration cases: API serving requirement, high concurrency requirement, unsupported runtime, or non-ComfyUI target.
5. Estimate whether the largest active path may exceed target VRAM using the matching feasibility skill's estimate template. If hardware evidence is absent, state that capacity routing is preliminary.
6. Identify critical custom nodes that may be CUDA-only, unregistered, version-mismatched, staged-but-not-installed, or only present in an artifact cache.
7. Classify the initial route and terminal state.

## Output

Write the final report as `02-feasibility.md` with:

```text
orchestrator_status: complete / human_gate_reached / hard_stop
workflow:
workflow_sha256:
input_evidence:
scan_coverage:
dependency_coverage:
target hardware:
fidelity target:
asset_custom_node_readiness:
hidden_runtime_asset_status:
custom_node_registration_assumption:
expected branches and outputs:
estimated_peak_vram:
initial_class:
risks:
hard_stops:
human_intervention_needed:
assumptions_to_verify:
step03_context:
toolization:
completion_decision:
next_step:
```

`completion_decision` is mandatory and must include:

```text
status:
success_criteria_checked:
evidence_artifacts:
unresolved_gaps:
human_gate_prompt:
next_step_allowed:
```

When Step 02 touches node scope, also write `02-node-feasibility-accounting.csv` or an equivalent all-node table that has one row per source node.

`step03_context` must include enough information for a fresh Step 03 session:

- workflow path and hash;
- source node/link counts and coverage status;
- output-node hints known so far;
- unresolved or smoke-only asset names exactly as requested;
- custom-node source/install/registration assumptions;
- target hardware and fidelity assumptions;
- preliminary route;
- human decisions already made or still required.

## Success criteria

Step 02 is successful only when one of these terminal states is reached:

1. `complete`: the report consumed Step 00 and Step 01 evidence, verified scan/dependency coverage, stated target budget/fidelity, classified the route, and provided `step03_context`.
2. `human_gate_reached`: the report names every unresolved dependency, scan-coverage gap, asset alias, private-access issue, capacity/fidelity ambiguity, or missing hardware decision that blocks a normal route, and states what a human must decide.
3. `hard_stop`: the report names the condition that makes safe continuation impossible without changing the requirement.

Do not mark Step 02 complete only because a deterministic precheck has no source-identical asset blockers. Conversely, if Step 01 is still waiting for human input, Step 02 may still produce a blocked feasibility report, but it must not route as normal migration.

For `complete`, the minimum checked criteria are:

- Step 00 and latest Step 01 artifacts were consumed directly.
- `source_node_count`, Step 00 scanned count, and Step 01 dependency-scanned count reconcile.
- Every source node appears in the Step 02 node accounting output or an explicitly referenced prior all-node table.
- Source workflow immutability is confirmed.
- Asset/custom-node readiness is current and preserves non-source-identical boundaries.
- Hardware budget is measured or the missing budget is named as a human gate.
- `step03_context` is sufficient for a fresh Step 03 session.

## Human intervention standards

Ask for human direction when:

- source-identical assets, input media, hidden runtime assets, or custom-node sources are unresolved or access-blocked;
- a compatibility alias or smoke-only substitute would affect fidelity claims;
- full node/dependency scan coverage cannot be proven from artifacts;
- target hardware, usable VRAM, fidelity tier, CPU offload, reduced-resource policy, or multi-XPU availability is unknown;
- the preliminary estimate is near or above budget;
- a critical custom node appears CUDA-only or registration/runtime support is unknown;
- the result would otherwise overstate what is proven.

## Hard stops

Stop and write `orchestrator_status: hard_stop` when:

- the requirement is not a ComfyUI workflow migration and cannot be reframed safely;
- the user requires strict source-identical delivery but critical source-identical assets are unavailable or inaccessible;
- the requested full-fidelity target exceeds measured hardware capacity and the user rejects reduced fidelity, CPU fallback, model offload, or hardware escalation;
- a critical custom-node family is CUDA-only with no fallback or approved feature-development path;
- continuation would require bypassing, deleting, replacing, or semantically changing nodes without approval.

## Toolization

If the same parsing/reporting work is repeatable, Step 02 should use or create a read-only scaffold tool. The current reusable implementation is:

```text
ComfyUI/docs/draft/migration-workflow-v2/tools/step02_feasibility_scaffold.py
```

The tool may read Step 00/01 artifacts, recount the source workflow, create all-node accounting, optionally probe hardware with read-only `xpu-smi`/`sycl-ls`, and write Step 02 artifacts. It must not provider-search, download, clone, install, call ComfyUI, convert prompts, or edit the workflow.

## Prior-migration lessons

Dasiwa showed that capacity and branch structure must be considered before full-run attempts. Mixlab showed that package-level scope can hide many unsupported families behind one successful import. Zimage showed that a Step 02 precheck can pause correctly while still losing Step 01's actual gap list if it only reads Step 00 markers; the final Step 02 report must parse Step 01 ledgers directly.

## Example output shape

```text
orchestrator_status: human_gate_reached
Initial class: dependency/integration gate first; capacity risk deferred
Reason: Step 01 still has source-identical asset gaps and smoke-only aliases. Step 00/01 coverage fields are incomplete, so normal migration cannot be routed honestly.
Next step: human provides exact assets, approves bounded smoke-only continuation, or stops at dependency gate. If bounded continuation is approved, pass Step 03 the unresolved asset list and coverage-gap status.
```

# Migration workflow v2 improvement backlog

Use this file during and after workflow execution to record playbook/tool gaps discovered by later steps. It is not a runtime artifact for a single migration; it is the cross-run improvement backlog for the migration workflow itself.

## Rule: Step 01 handoff gaps from Step 00

Step 01 should not hard-stop the whole asset-resolution step just because Step 00 omitted a field. Use this escalation order:

1. **Classify the missing handoff field**: node coverage, node-to-dependency mapping, field path, raw value, query key, expected target path, source context path, provider/download policy, or human gate.
2. **Repair locally when safe**: Step 01 may run a bounded read-only repair pass against the source workflow and existing artifacts. It may not use chat memory as evidence and may not start provider search/download to compensate for missing Step 00 data.
3. **Block only affected work items**: if safe minimum inputs are still missing, block only the affected asset/custom-node work item or node range. Other complete work items may continue.
4. **Human gate only when needed**: ask for human input when exactness, source identity, private access, or target path cannot be determined safely.
5. **Record the improvement**: add an entry below so Step 00's prompt/skill/tool contract can be improved in the next iteration.

Safe minimum inputs before Step 01 provider search/download:

- source node ID or explicit artifact source
- requested asset/package name
- dependency kind (`model`, `input_media`, `custom_node`, `hidden_runtime_asset`, or `service`)
- expected target path or package destination
- allowed providers/source roots
- exactness requirement and alias policy
- credential/proxy policy names without secret values

## Rule: Step 02 handoff gaps from Step 00/01

Step 02 should not route a workflow as normal migration just because a deterministic precheck created `02-feasibility.md`. Use this escalation order:

1. **Prefer latest ledgers**: parse `01-assets.csv`, `01-custom-nodes.md`, and any `01-node-dependency-scan.csv` directly. Step 00 summaries are preflight evidence, not the current dependency truth after Step 01 runs.
2. **Verify scan coverage**: compare source workflow node count, Step 00 scanned node count, and Step 01 dependency-scanned node count. Missing v2 fields are contract gaps, not silent success.
3. **Repair read-only when safe**: Step 02 may recount nodes/links and compare dependency names from workflow/Step 00/Step 01 artifacts. It may not provider-search, download, clone, install, call ComfyUI, edit the workflow, or reconstruct evidence from chat history.
4. **Gate precisely**: if source-identical assets, alias approvals, hardware/fidelity policy, or scan/dependency coverage are still unresolved, write `orchestrator_status: human_gate_reached` and name every affected item.
5. **Pass Step 03 context**: every Step 02 outcome must include workflow path/hash, node/link counts, output-node hints, unresolved dependency list, target hardware/fidelity assumptions, and the feasibility route so Step 03 can run without chat memory.

### 2026-05-18 Zimage Step 02 precheck consumed Step 00 only

- Workflow/task: clean Zimage task `98c66114-0f72-4ba0-8f46-5a4c137b8ac0`
- Step that found the gap: Step 02 feasibility replay
- Missing Step 00/01 field(s): v2 `source_node_count`, `scanned_node_count`, `missing_node_ids`, `dependency_scanned_node_count`, `missing_dependency_scan_node_ids`, complete Step 01 dependency scan, hardware baseline, and Step 03-ready context
- Impact on Step 02: backend paused at a human gate but the first `02-feasibility.md` scaffold listed no critical gaps because it inspected Step 00 markers instead of Step 01's actual `01-assets.csv`
- Local repair attempted: parsed source workflow count, `00-intake-preflight.md`, `01-assets.csv`, and `01-custom-nodes.md` read-only
- Items allowed to continue: only a bounded Step 03 inventory/source-audit path if a human explicitly approves smoke-only continuation with documented gaps
- Items blocked/human-gated: five Step 01 asset gaps and unresolved all-node/dependency-scan coverage proof
- Proposed Step 00/01/02 contract/tool change: Step 02 must parse Step 01 ledgers directly, report `input_completeness`, and write `step03_context`; backend deterministic feasibility should not rely on Step 00 heading extraction alone
- Severity: high
- Status: addressed in v2 prompt/skill docs; backend/tool implementation remains an automation candidate

### 2026-05-18 Step 00/01 backend is behind v2 contract

- Workflow/task: clean Zimage task `98c66114-0f72-4ba0-8f46-5a4c137b8ac0`
- Step that found the gap: Step 01/02 implementation review
- Missing Step 00/01 field(s): backend Step 00 does not emit v2 `workflow_sha256`, `source_node_count`, `scanned_node_count`, `missing_node_ids`, `asset_extraction_table`, `custom_node_package_table`, `source_hint_table`, `provider_and_download_policy`, or `step01_work_queue`; backend Step 01 does not emit all-node `dependency_scanned_node_count`, `missing_dependency_scan_node_ids`, `01-node-dependency-scan.csv`, provider attempts, acquisition subjob records, or human-gate prompt details
- Impact on Step 01: the v2 docs would fix the repeated asset-gap problem, but the current demo backend still only performs local exact matching and ledger generation, then pauses on `gapCount > 0`
- Local repair attempted: documented Step 01 handoff repair, provider-tool ownership, all-node dependency scan, and human-gate communication template in v2 prompt/skill docs
- Items allowed to continue: none as normal source-identical migration until backend or the executing agent follows the v2 Step 01 contract
- Items blocked/human-gated: source-identical asset acquisition, alias approval, provider access, and scan-coverage proof
- Proposed Step 00 contract/tool change: implement a read-only intake scanner that emits v2 fields and `step01_work_queue`
- Proposed Step 01 contract/tool change: wire the reusable asset acquisition tool pool into Step 01, run bounded provider/local/SSH/custom-node source attempts, produce all-node dependency-scan coverage, and emit the structured human-gate prompt when unresolved items remain
- Severity: high
- Status: open for backend automation; addressed for the human-driven v2 playbook docs

### 2026-05-18 Step 01 human gate prompt was not actionable enough

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 01 human-gate review
- Missing Step 00/01 field(s): not a data-field gap; the communication prompt lacked a sufficiently explicit problem statement, why-agent-cannot-decide explanation, exact human instructions, and continuation plan per decision
- Impact on Step 01: human reviewers could see a list of gaps but not clearly understand what action to take or how the workflow would continue after a decision
- Local repair attempted: strengthened Step 01 prompt/skill, v2 README, QUICKSTART, and the current `01-custom-nodes.md` artifact with a project-level human-gate communication rule
- Items allowed to continue: only after the human responds using the structured decision template, or after Step 01 reruns affected work items
- Items blocked/human-gated: unresolved source-identical models, alias approvals, custom-node clone/stage approvals, provider/download access approval
- Proposed Step 01 contract/tool change: every Step 01 human gate must be an executable communication prompt with exact items, target paths, attempts, why-agent-cannot-decide, safe reply format, and DAG continuation edges
- Severity: high
- Status: addressed in v2 docs and current Step 01 artifact

### 2026-05-18 Step 01 custom-node source acquisition was too manual

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 01 custom-node gate resolution
- Missing Step 00/01 field(s): Step 01 skill treated public custom-node sources that were reachable-but-not-staged as human-gated instead of automatically invoking the GitHub/Comfy.ICU search and workspace clone tool
- Impact on Step 01: `Note Plus (mtb)`, `TTResolutionSelector`, and `UltimateSDUpscale` unnecessarily reached a human gate even though their public repositories could be verified and cloned into the isolated workspace
- Local repair attempted: used the Step 01 provider search implementation with `kind: custom_node`, verified the GitHub repositories, cloned them into `cache/custom_nodes/`, initialized submodules, recorded commits and wrapper-source evidence, and updated Step 01 to `resolved/staged`
- Items allowed to continue: Step 02 can start after Step 01 artifacts show custom-node source commits and no remaining dependency gaps
- Items blocked/human-gated: only custom-node candidates that are ambiguous, private, archived, unreachable, policy-denied, missing target paths, collide with non-empty targets, fail clone/submodule update, or reveal unstaged hidden runtime assets
- Proposed Step 01 contract/tool change: make public unambiguous custom-node GitHub/Comfy.ICU search and clone a default Step 01 tool action; emit `01-custom-node-provider-search.json`, `01-custom-node-github-verify.txt`, and `01-custom-node-source-acquisition.json`
- Severity: high
- Status: addressed in v2 prompt/skill docs; first-class backend/CLI wiring remains an automation task if the current route cannot call the provider tool directly

### 2026-05-18 Step 01 completion and Step 02 handoff needed a stricter contract

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 01 finalization review
- Missing Step 00 field(s): Step 00 was sufficient for Step 01 only because it included full node coverage, asset extraction, custom-node source hints, provider/download policy, expected target paths, and `00-step01-work-queue.csv`; this sufficiency needed to be stated as an explicit Step 01 input-completeness gate
- Impact on Step 01: without a strict completion contract, Step 01 could stop after partial ledgers, omit disconnected/non-output nodes, leave provider candidates unstaged, miss custom-node source acquisition evidence, or fail to pass enough context to Step 02
- Local repair attempted: finalized Step 01 with `01-output-manifest.json`, 62/62 dependency scan coverage, 11/11 model assets staged, 18/18 custom-node sources known/staged, and explicit non-source-identical boundary for approved substitutes
- Items allowed to continue: Step 02 may start only when `01-acquisition-summary.json` and `01-output-manifest.json` say `can_start_step02: true`
- Items blocked/human-gated: missing scan rows, missing safe work-item inputs, unresolved source-identical assets without approved substitute, ambiguous/private provider access, unsafe target collisions, unbounded transfers/clones, and hidden runtime assets that cannot be staged
- Proposed Step 01 contract/tool change: Step 01 must enforce Step 00 input completeness, full-node dependency scan coverage, two terminal states plus hard-stop causes, explicit human-intervention standards, and Step 02 handoff fields including route constraints and artifact hashes
- Severity: high
- Status: addressed in v2 Step 01 prompt/skill docs; backend implementation still needs to emit the same manifest and completion signals

### 2026-05-18 Step 02 needed all-node accounting and a completion decision

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 02 feasibility execution
- Missing Step 00/01 field(s): no Step 02-owned all-node feasibility accounting file, no mandatory `completion_decision`, and no reusable Step 02 parser/scaffold tool
- Impact on Step 02: a feasibility report could say "complete" while only summarizing asset readiness, without proving every source node remained accounted for or stating the exact criteria checked before allowing Step 03
- Local repair attempted: implemented `tools/step02_feasibility_scaffold.py`, generated `02-node-feasibility-accounting.csv`, `02-feasibility-summary.json`, `02-output-manifest.json`, and added the `completion_decision` block to `02-feasibility.md`
- Items allowed to continue: Step 03 inventory may start because Step 02 now proves 62/62 source-node and dependency coverage, preserves the non-source-identical boundary for nodes 63/160/14, and emits Step 03 context
- Items blocked/human-gated: none before Step 03; later gates remain for source-identical asset demands, source/runtime patches, reduced fidelity/offload, or customer-facing claim wording
- Proposed Step 02 contract/tool change: require all-node accounting, source-workflow immutability confirmation, toolization evidence, and a machine-readable `completion_decision`; use the scaffold tool for repeatable Step 02 parsing
- Severity: high
- Status: addressed in v2 Step 02 prompt/skill docs and current Zimage Step 02 artifacts; backend integration remains optional automation work

### 2026-05-18 Step 03 needed a durable all-node inventory/tool contract

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 03 workflow inventory execution
- Missing Step 02 field(s): Step 02 gave enough start context, but Step 03 prompt/skill did not require a Step 03-owned all-node inventory file, branch-map CSV, machine-readable `completion_decision`, or reusable graph extractor
- Impact on Step 03: branch/output coverage could be described in prose while disconnected/reference/dead-end/frontend nodes or updated dependency states were omitted from durable evidence
- Local repair attempted: implemented `tools/step03_inventory_scaffold.py`, generated `03-node-inventory.csv`, `03-branch-map.csv`, `03-inventory-summary.json`, `03-workflow-topology.md`, `03-output-manifest.json`, and updated Step 03 prompt/skill with all-node and completion-decision standards
- Items allowed to continue: Step 04 source audit may start with `step04_context` focused on source-staged custom nodes, widget/export risks, hidden runtime assets, CUDA/device assumptions, and non-source-identical nodes 63/160/14
- Items blocked/human-gated: none before Step 04; source patches or semantic workflow changes remain later human gates
- Proposed Step 03 contract/tool change: Step 03 must emit all-node inventory, branch map, topology summary, prompt/export risk list, source-workflow immutability statement, Toolization note, and `completion_decision`
- Severity: high
- Status: addressed in v2 Step 03 prompt/skill docs and current Zimage Step 03 artifacts; backend integration remains optional automation work

### 2026-05-18 Step 04 needed all-node source audit, scanner output, and redaction

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 04 source audit execution
- Missing Step 03 field(s): Step 03 context was sufficient, but Step 04 prompt/skill did not require all-node source-audit rows, package scan status, token redaction for workflow widget evidence, machine-readable `completion_decision`, or a reusable static scanner
- Impact on Step 04: source-risk findings could remain package-level only, omit core/disconnected nodes, or leak auth-like widget URL query values into audit artifacts
- Local repair attempted: implemented `tools/step04_source_audit_scaffold.py`, generated `04-node-source-audit.csv`, `04-source-findings.csv`, `04-source-package-scan.json`, `04-source-audit-summary.json`, and regenerated artifacts after adding token-like redaction
- Items allowed to continue: Step 05 environment deployment may start; it must install/register packages and verify object_info/imports before Step 06
- Items blocked/human-gated: no active gate before Step 05; source patches, semantic workflow/widget changes, CPU fallback, or reduced-fidelity claims require later human approval
- Proposed Step 04 contract/tool change: require all-node audit rows, package source-root scan/gate status, redacted widget evidence, source patch policy, Toolization note, and `completion_decision`
- Severity: high
- Status: addressed in v2 Step 04 prompt/skill docs and current Zimage Step 04 artifacts; backend integration remains optional automation work

### 2026-05-18 Step 05 needed environment readiness tooling and frontend-only registration rules

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 05 environment deployment
- Missing Step 04 field(s): Step 04 supplied enough package/source context to start, but the Step 05 prompt/skill did not require a reusable readiness collector, safe custom-node symlink ledger, isolated model-path config, frontend-only node classification, machine-readable dependency decisions, launch evidence, or a `completion_decision`
- Impact on Step 05: SeedVR2 initially failed backend registration because the portable dependency `rotary_embedding_torch` was missing; `Note Plus (mtb)` and `Fast Groups Bypasser (rgthree)` were initially at risk of being misclassified as missing backend `/object_info` nodes even though they are frontend-only LiteGraph nodes
- Local repair attempted: implemented `tools/step05_environment_readiness.py`, linked staged custom nodes into the target ComfyUI via symlinks, wrote `05-extra-model-paths.yaml`, installed `rotary_embedding_torch>=0.5.3` with `--no-deps`, launched an XPU validation server on port 8191, collected `/system_stats` and `/object_info`, and generated `05-node-registration.csv`, `05-dependency-decisions.csv`, `05-model-wiring.csv`, `05-environment-summary.json`, and `05-output-manifest.json`
- Items allowed to continue: Step 06 may start because XPU torch is proven, the server is live, all required backend nodes are registered, frontend-only nodes are source-verified, staged model paths are visible through Step 05 config, and runtime-policy blockers for SeedVR2 `cuda:0` widgets are carried forward
- Items blocked/human-gated: source patches, CUDA-only dependency installs such as `onnxruntime-gpu`, semantic workflow edits, CPU/CUDA fallback, and any claim beyond the non-source-identical substitute boundary for nodes 63/160/14
- Proposed Step 05 contract/tool change: Step 05 must run a readiness collector, record install/link/model/API evidence, distinguish backend `/object_info` nodes from frontend-only web nodes, record minimal portable dependency repairs, preserve detached service evidence, and emit `completion_decision` plus `step06_context`
- Severity: high
- Status: addressed in v2 Step 05 prompt/skill docs and current Zimage Step 05 artifacts; backend integration remains optional automation work

### 2026-05-18 Step 06 needed no-queue validation tooling and stronger converter contracts

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 06 prompt conversion validation
- Missing Step 05 field(s): Step 05 provided enough runtime evidence, but Step 06 prompt/skill did not require all-source-node prompt accounting, frontend-only API-prompt exclusions, selector subpath preservation, UI-only seed control-widget handling, terminal non-output branch wrappers, no-queue validation tooling, or a machine-readable Step 07 branch-prompt handoff
- Impact on Step 06: the initial prompt conversion preserved `Note Plus (mtb)` as a backend node, stripped `z-image/...` and `flux2/...` selector subpaths to basenames, shifted old `control_after_generate` widget values into KSampler/SeedVR2/UltimateSDUpscale inputs, and treated terminal node 81 `SeedVR2VideoUpscaler` as a missing validation output even though it is not an `OUTPUT_NODE`
- Local repair attempted: updated `script_examples/workflow_to_prompt.py` and its unit tests, implemented `tools/step06_prompt_validation.py`, generated source-preserving and runtime-policy prompts, validated both with offline `execution.validate_prompt()` without queueing `/prompt`, wrote `06-node-prompt-map.csv`, `06b-runtime-policy-changes.json`, `06-branch-prompts.csv`, branch prompt artifacts, `06-prompt-validation-summary.json`, and `06-output-manifest.json`
- Items allowed to continue: Step 07 may start from `06b-runtime-policy-prompt.json` and the generated branch prompts because all backend validation outputs pass, node errors are empty on the runtime-policy variant, source workflow remains unchanged, and the terminal SeedVR2VideoUpscaler branch has a generated preview wrapper for smoke testing
- Items blocked/human-gated: silent source workflow edits, unrecorded runtime-policy rewrites, semantic/fidelity changes beyond `cuda:0 -> xpu:0` and current-schema `cache_model` normalization, and any branch execution that drops node 81 instead of using its wrapper
- Proposed Step 06 contract/tool change: require no-queue validation, all-node prompt map, converter/schema fixes separated from runtime-policy variant changes, source workflow immutability proof, terminal non-output branch wrappers, branch prompt handoff, Toolization note, and `completion_decision`
- Severity: high
- Status: addressed in v2 Step 06 prompt/skill docs, converter tests, and current Zimage Step 06 artifacts; backend integration remains optional automation work

### 2026-05-18 Step 07 needed branch harness, output-file checks, and cache-assisted semantics

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 07 branch smoke validation
- Missing Step 06 field(s): Step 06 provided branch prompts, but Step 07 prompt/skill did not require a reusable branch harness, submission output node IDs for generated wrappers, disk-level output verification, or explicit `cache_assisted_pass` semantics for sequential branch suites
- Impact on Step 07: the terminal node 81 wrapper had to be submitted through its generated preview output node; later branch smokes reused upstream cache even when branch-specific nodes executed, so a binary pass/fail label would overclaim cold execution; output evidence also needed file existence/size checks beyond history JSON
- Local repair attempted: implemented `tools/step07_branch_smoke.py`, ran all 12 Step 06 branch prompts with reduced settings and fixed seed, verified non-empty output files, recorded request/response/history/summary/report artifacts for every branch, captured executed and cached node IDs, and classified all 12 branches as `cache_assisted_pass`
- Items allowed to continue: Step 08 may start with a cache-assisted branch boundary: all advertised branches produced non-empty outputs under reduced settings, but Step 08 must still prove full-path/full-size capacity and cannot treat Step 07 as quality or capacity validation
- Items blocked/human-gated: claiming full-size success, claiming source-identical fidelity for substitute nodes 63/160/14, dropping the node 81 wrapper branch, or ignoring cache boundaries in customer-facing evidence
- Proposed Step 07 contract/tool change: Step 07 must consume `06-branch-prompts.csv`, submit the `submission_output_node_id`, preserve per-branch artifacts, verify output files, record reduced settings, executed/cached nodes, wrapper provenance, cache-assisted status, Toolization note, `completion_decision`, and Step 08 context
- Severity: high
- Status: addressed in v2 Step 07 prompt/skill docs and current Zimage Step 07 artifacts; backend integration remains optional automation work

### 2026-05-19 Step 07 reduced-seed repair exposed no-bypass and cache-boundary rules

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 08 full-path validation while repairing Step 07 evidence
- Missing Step 06/07 field(s): Step 07 harness did not distinguish "fix seed by editing linked seed node" from "replace sampler seed input with a literal", and did not preserve cold-start/cache-assisted capacity boundaries when `/free` or restart changed behavior
- Impact on Step 07: replacing `KSamplerAdvanced.noise_seed` links with literals removed source node 188 from execution, violating the no-bypass rule; clearing cache before branch 203 exposed cold XPU OOM that was not equivalent to a branch graph failure
- Local repair attempted: updated `tools/step07_branch_smoke.py` to edit linked `Seed (rgthree)` nodes instead of replacing seed links, added optional `/free` and merge-existing support for targeted reruns, preserved failed attempts, restarted ComfyUI by numeric PID after allocator OOM, and reran all 12 branches to `cache_assisted_pass`
- Items allowed to continue: Step 08 may consume Step 07 as cache-assisted reduced-branch evidence only; cold-start capacity and full-size capacity remain Step 08/09 concerns
- Items blocked/human-gated: claiming cold branch success from cache-assisted evidence, deleting failed OOM attempts, or changing seed links/graph edges to make branches pass
- Proposed Step 07 contract/tool change: fixed-seed reductions must preserve linked seed/control nodes; branch reports must state cold/warm/cache status, failed cold attempts, cache-bust limits, and whether memory cleanup changes the validation class
- Severity: high
- Status: addressed in Step 07 prompt/skill docs and harness; backend integration remains optional automation work

### 2026-05-19 Step 08 needed full-path harness, telemetry, and report/accounting recovery

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 08 full validation and capacity
- Missing Step 07/08 field(s): no reusable full-path harness with XPU telemetry, output copying, previous-attempt preservation, no-bypass reduced seed handling, all-node accounting, structural primitive classification, or report/accounting recovery distinction
- Impact on Step 08: the first reduced full-path run completed with outputs and telemetry but was correctly rejected because the seed-link reduction bypassed source node 188; a later successful cold run was temporarily misclassified because structural `PrimitiveFloat` node 198 was not runtime-scheduled; final accepted run is cache-assisted and must not be reported as full-size or source-identical success
- Local repair attempted: implemented `tools/step08_full_validation.py`, added linked seed-node preservation, XPU telemetry polling, output-file copying, previous-attempt archiving, source-node accounting, structural primitive classification, and completion-decision generation; produced `08-full-validation-summary.json`, `08-full-validation.md`, `08-output-manifest.json`, request/response/history/telemetry/output artifacts, and 12 retained output files
- Items allowed to continue: Step 09 may start from `restricted_reduced_full_path_runtime_policy_success_cache_assisted` with peak/budget ratio 0.9817, while preserving the non-source-identical substitute boundary for nodes 63/160/14 and the runtime-policy prompt boundary
- Items blocked/human-gated: claiming full-size/original-resolution capacity, source-identical fidelity, cold-start success without the archived evidence review, or customer-ready quality from reduced full-path API evidence
- Proposed Step 08 contract/tool change: Step 08 must separate runtime failure from report/accounting recovery, preserve previous attempts, classify cold/warm/cache-assisted evidence, copy temporary output files, record telemetry peak/budget ratio, and emit enough Step 09 context for tuning without chat memory
- Severity: high
- Status: addressed in Step 08 prompt/skill docs and harness; backend integration remains optional automation work

### 2026-05-19 Step 09 needed no-change tuning as a first-class outcome

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 09 performance tuning
- Missing Step 08/09 field(s): Step 09 prompt/skill did not explicitly allow ranking existing Step 08 attempts, selecting `no_runtime_change_selected`, rejecting faster invalid candidates, or carrying cache-assisted/tight-memory boundaries into coverage
- Impact on Step 09: the fastest observed run was a rejected no-bypass attempt, the accepted run was cache-assisted and near the memory budget, and the safer cold run existed only as a report/accounting recovery artifact; a naive tuner could have picked the wrong winner
- Local repair attempted: implemented `tools/step09_performance_tuning.py`, parsed current and previous Step 08 attempts, compared duration/cache/memory/output evidence, rejected literal seed-link bypass and full-size escalation, selected no runtime change, and emitted `09-tuning-analysis.json`, `09-tuning.md`, and `09-output-manifest.json`
- Items allowed to continue: Step 10 may start with the explicit boundary that coverage can use reduced full-path/cache-assisted evidence, but must not claim full-size, source-identical, or customer-quality success
- Items blocked/human-gated: full-size/original-resolution tuning, cache-residency delivery claims, source-identical claims for substitute nodes 63/160/14, or promoting a faster invalid no-bypass candidate
- Proposed Step 09 contract/tool change: Step 09 should support evidence-normalization mode, require accepted/report-recovery-valid candidates before choosing a winner, record safe fallback and no-change decisions, and pass a coverage boundary to Step 10
- Severity: medium
- Status: addressed in Step 09 prompt/skill docs and analysis tool; backend integration remains optional automation work

### 2026-05-19 Step 10 needed deterministic coverage reconciliation and claim-boundary handoff

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 10 coverage review
- Missing Step 09/10 field(s): Step 10 prompt/skill did not require a reusable coverage reconciliation tool, machine-readable `completion_decision`, output manifest, or Step 11 claim-boundary handoff.
- Impact on Step 10: coverage could be written as prose while failing to preserve the distinction between full-run executed nodes, full-run cached nodes, branch-smoke cache-assisted evidence, disconnected/frontend exclusions, and delivery/customer approval boundaries.
- Local repair attempted: implemented `tools/step10_coverage_review.py`, consumed Step 03/06/07/08/09 artifacts, generated `10-node-coverage.csv`, `10-coverage-summary.json`, `10-coverage-review.md`, and `10-output-manifest.json`; reconciled 62/62 source nodes with 36 full-run executed, 19 full-run cached, 7 excluded disconnected/frontend nodes, and zero uncovered executable nodes.
- Items allowed to continue: Step 11 packaging may start with the support statement limited to reduced runtime-policy API engineering node coverage.
- Items blocked/human-gated: claiming full-size/original-resolution capacity, source-identical fidelity for substitute nodes 63/160/14, GUI/manual acceptance, or customer-quality approval from Step 10 coverage evidence.
- Proposed Step 10 contract/tool change: Step 10 must run deterministic coverage reconciliation, separate executed/cached/output-only evidence, require explicit exclusions, emit `completion_decision`, and pass exact Step 11 claim-boundary context.
- Severity: high
- Status: addressed in Step 10 prompt/skill docs and current coverage tool; backend integration remains optional automation work

### 2026-05-19 Step 11 needed deterministic bounded packaging

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 11 delivery packaging
- Missing Step 10/11 field(s): Step 11 prompt/skill did not require a reusable package builder, `package-manifest.json`, machine-readable `completion_decision`, exact accepted-output selection, or Step 12 GUI/manual handoff.
- Impact on Step 11: a manual package could copy stale previous-attempt outputs or imply customer-ready delivery before GUI/manual evidence exists.
- Local repair attempted: implemented `tools/step11_delivery_packaging.py`, generated `11-delivery/`, copied source/runtime-policy workflow artifacts, current accepted Step 08 outputs only, validation/ledger evidence, bounded delivery docs, `11-delivery-summary.json`, `11-delivery.md`, and `11-output-manifest.json`.
- Items allowed to continue: Step 12 GUI acceptance/demo may start from the delivery directory and manual test plan.
- Items blocked/human-gated: customer-ready wording, GUI/manual acceptance claims, full-size/original-resolution capacity claims, and source-identical fidelity claims for substitute nodes 63/160/14.
- Proposed Step 11 contract/tool change: Step 11 must build the package deterministically, hash/index generated artifacts, set `customer_ready=false` unless Step 12 evidence already exists, and emit Step 12 context.
- Severity: high
- Status: addressed in Step 11 prompt/skill docs and current packaging tool; backend integration remains optional automation work

### 2026-05-19 Step 12 needed preparation-vs-acceptance separation

- Workflow/task: clean Zimage v2 workspace `zimage-v2-step00-20260518T134746Z`
- Step that found the gap: Step 12 GUI acceptance/demo
- Missing Step 11/12 field(s): Step 12 prompt/skill did not explicitly require `human_gate_reached` when preparation succeeds but the operator run/signoff is still pending, nor did it require a reusable readiness/preparation tool with exact continuation edges.
- Impact on Step 12: a prepared GUI workflow and reachable service could be mistaken for customer acceptance even without manual output evidence.
- Local repair attempted: implemented `tools/step12_gui_acceptance.py`, generated a runtime-policy GUI workflow while preserving 62 nodes/74 links, applied approved widget changes, cleaned stale preview URLs, wrote output prefixes, verified `/system_stats`, `/object_info`, backend nodes, model selector entries, PID/log, and generated checklist/run-record artifacts.
- Follow-up repair: added `12-workflow-diff-summary.md/json` so human testers can see exactly how the tested workflow differs from the original/source workflow and what compromises bound the result.
- Items allowed to continue: a human operator can run the generated GUI workflow and reply using the recorded safe template.
- Items blocked/human-gated: marking GUI/manual accepted, customer-ready, full-size/original-resolution validated, or source-identical until human output evidence and signoff exist.
- Proposed Step 12 contract/tool change: Step 12 should automate preparation/readiness only; final acceptance must remain a human gate unless a completed run record with outputs/logs/signoff is present.
- Severity: high
- Status: addressed in Step 12 prompt/skill docs and current preparation tool; backend integration remains optional automation work

## Entry template

```text
### YYYY-MM-DD short title

- Workflow/task:
- Step that found the gap:
- Missing Step 00 field(s):
- Impact on Step 01:
- Local repair attempted:
- Items allowed to continue:
- Items blocked/human-gated:
- Proposed Step 00 contract/tool change:
- Severity: low / medium / high
- Status: open / addressed
```

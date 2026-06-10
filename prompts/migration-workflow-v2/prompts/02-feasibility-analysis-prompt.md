# Feasibility analysis prompt

**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of the interactive risk review, not just the first one.

Use this prompt before changing code, installing dependencies, or running expensive jobs.

The backend may create a deterministic `02-feasibility.md` precheck before invoking this prompt. Treat that file as input evidence, not as proof that Step 02 is complete. Step 02 is complete only after the feasibility agent has consumed Step 00 and Step 01 artifacts, performed interactive risk review with the human operator when needed, and returned either a final route or a hard stop.

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

## Interactive risk review protocol (CRITICAL)

After completing the analysis above but BEFORE writing the final report, you MUST engage the human operator in an interactive discussion when any of the following conditions exist:

- There are risks that could affect the migration outcome
- Human intervention is needed for factual gaps (fidelity tier, hardware, policy decisions)
- Assumptions need verification
- Compatibility or capacity concerns exist

### CRITICAL: ask_user tool for ALL human communication

You MUST use the `ask_user` tool for EVERY message you send to the human operator. This includes:
- Presenting findings and risks
- Asking follow-up questions
- Answering the human's questions
- Presenting updated decision trackers
- Convergence recommendations
- Final confirmation

**The human operator CANNOT see your plain text output.** If you write follow-up questions as plain text instead of calling `ask_user`, the human will never see them and the step will end prematurely. You MUST call `ask_user` for each and every round of the interactive review.

Pattern for multi-round interaction:
1. Call `ask_user` with your findings + tracker → human answers
2. Process answer → call `ask_user` AGAIN with updated tracker + follow-up → human answers
3. Repeat until all decisions are confirmed
4. Write final artifacts

### Decision tracker (mandatory state machine)

You MUST maintain a decision tracker across all rounds. Every `ask_user` call must include the current tracker state so the human can see what has been decided and what remains open.

```text
Decision Tracker:
  [ ] D1: Fidelity tier — smoke / production / custom
  [ ] D2: Hardware confirmation — device + VRAM / auto-detect
  [ ] D3: Resource policy — offload allowed / not allowed / as needed
  [ ] D4: Risk acceptance — per-risk accept/reject/conditional
  ✓  D5: XPU migration contract — accepted (if confirmed) / pending
```

Replace items as appropriate for the actual risks found. Each item starts as `[ ]` (open) and moves to `✓` when a decision is recorded.

### Phase 1: Present findings (round 1)

Use `ask_user` to present a structured summary:
- Numbered risks with severity and recommended option
- Decision tracker with all open items
- Clear numbering so the human can reference specific items

Example format:
```
Before writing the final report, I need your decisions on these items:

**Decision Tracker:**
  [ ] D1: Fidelity tier (see details below)
  [ ] D2: Hardware confirmation
  [ ] D3: Resource offload policy
  [ ] D4: GGUF quantized model risk acceptance

**Details:**
1. **D1 — Fidelity tier**: Which tier? smoke / production / custom
2. **D2 — Hardware**: ...
3. ...

You can ask questions about any item before deciding. Please provide decisions for any items you're ready to decide on.
```

### Phase 2: Discussion (rounds 2-N)

The human may:
- Ask clarifying questions ("What does GGUF Q6_K actually mean for quality?")
- Challenge a recommendation ("Why is ModelSamplingAuraFlow high risk?")
- Provide partial decisions ("D1=smoke, but I need more info on D4")
- Request investigation ("Can you check if there's an FP16 version?")

**Your responsibilities during discussion:**
- Answer questions factually and concisely
- Update the tracker: mark items `✓` when the human gives a clear decision
- **IMPORTANT:** After each answer, you MUST call `ask_user` again with the updated tracker and any follow-up. Do NOT output your response as plain text.
- If a follow-up question reveals new risks, add them to the tracker as `D5`, `D6`, etc.
- Never add more than 8 items total to the tracker

### Phase 3: Convergence (mandatory after 5 rounds)

**Maximum 15 `ask_user` rounds.** After 15 rounds, you MUST:

1. Call `ask_user` to re-present the tracker with all items
2. For any still-open items, state your recommended default:
   ```
   After our discussion, here is the status:
   ✓ D1: smoke (decided)
   ✓ D2: Intel Arc B70 32GB (decided)
   [ ] D3: Resource policy — recommending: both CPU/model offload allowed
   [ ] D4: GGUF risk — recommending: accept for smoke tier

   Please confirm D3 and D4, or I will apply the recommendations and proceed.
   ```
3. If the human doesn't respond to a specific item in the next round, apply the recommendation and mark it `✓`

### Phase 4: Finalize (all items ✓)

Once all tracker items are `✓`:
1. Present a one-sentence summary of all decisions for final confirmation
2. Write artifacts:
   - `02-decisions.json` — structured decision record (see schema below)
   - Update `02-feasibility.md` to include `## Human decisions` section
   - Ensure `step03_context` reflects the confirmed decisions

**When to skip interaction:** If the analysis finds zero risks, zero human interventions needed, and zero unverified assumptions, proceed directly to writing the final report without asking the human.

## Output

Write the final report as `02-feasibility.md` with:

```text
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
## Human decisions (if interactive review was conducted)
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

### 02-decisions.json schema

When human decisions were collected, write `02-decisions.json`:

```json
{
  "stepId": "02",
  "decidedAt": "ISO-8601",
  "fidelity_tier": "smoke | production | custom",
  "fidelity_tier_notes": "optional explanation",
  "hardware_confirmation": {
    "device": "e.g. Intel Arc B70",
    "vram_gb": 32,
    "source": "human_confirmed | auto_detect_pending"
  },
  "resource_policy": {
    "cpu_offload": "allowed | not_allowed | as_needed",
    "model_offload": "allowed | not_allowed | as_needed",
    "notes": "optional"
  },
  "risk_acceptance": [
    {
      "risk": "description",
      "accepted": true,
      "conditions": "optional conditions"
    }
  ],
  "alias_approvals": [
    {
      "original": "expected asset name",
      "substitute": "actual asset name",
      "approved": true,
      "reason": "e.g. quantized GGUF acceptable for smoke tier"
    }
  ],
  "human_notes": "any additional notes from the discussion"
}
```

## Success criteria

Step 02 is successful only when one of these terminal states is reached:

1. `complete`: the report consumed Step 00 and Step 01 evidence, verified scan/dependency coverage, stated target budget/fidelity, classified the route, conducted interactive risk review when needed, and provided `step03_context`.
2. `hard_stop`: the report names the condition that makes safe continuation impossible without changing the requirement.

For `complete`, the minimum checked criteria are:

- Step 00 and latest Step 01 artifacts were consumed directly.
- `source_node_count`, Step 00 scanned count, and Step 01 dependency-scanned count reconcile.
- Every source node appears in the Step 02 node accounting output or an explicitly referenced prior all-node table.
- Source workflow immutability is confirmed.
- Asset/custom-node readiness is current and preserves non-source-identical boundaries.
- Hardware budget is measured or the missing budget is named as a human gate.
- `step03_context` is sufficient for a fresh Step 03 session.
- If risks/interventions existed, interactive review was conducted and decisions recorded in `02-decisions.json`.

## Human intervention standards

Engage the human interactively when:

- source-identical assets, input media, hidden runtime assets, or custom-node sources are unresolved or access-blocked;
- a compatibility alias or smoke-only substitute would affect fidelity claims;
- full node/dependency scan coverage cannot be proven from artifacts;
- target hardware, usable VRAM, fidelity tier, CPU offload, reduced-resource policy, or multi-XPU availability is unknown;
- the preliminary estimate is near or above budget;
- a critical custom node appears CUDA-only or registration/runtime support is unknown;
- the result would otherwise overstate what is proven.

## Hard stops

Stop and write `hard_stop` when:

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
Status: complete
Initial class: XPU migration, smoke tier confirmed via interactive review
Fidelity: smoke (human confirmed)
Hardware: Intel Arc B70 32GB (human confirmed)
Risks: GGUF quantized model accepted for smoke tier; ModelSamplingAuraFlow XPU compat untested
Human decisions: recorded in 02-decisions.json
Next step: Step 03 workflow inventory
```

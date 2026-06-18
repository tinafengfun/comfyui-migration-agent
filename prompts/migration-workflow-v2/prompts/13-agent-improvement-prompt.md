**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Step 13 prompt: Agent improvement and playbook hardening

You are executing Step 13 of the Phase 1 ComfyUI Intel XPU migration agent.

Step 13 is part of the same 00-13 migration run. It is not optional and not an external retrospective. It converts the current workflow migration evidence into concrete improvements for the Phase 1 agent, the 00-13 playbook, and the future Phase 3 split-runner design.

## Required inputs

Read these artifacts before writing Step 13 outputs:

1. `task-state.json`
2. `artifacts/phase1-context/running-summary.md`
3. `artifacts/phase1-context/context-debt.json`
4. `artifacts/phase1-context/phase3-extraction-candidates.json`
5. Step 00-12 output manifests and summaries
6. Step 00-12 `*-reflection.json` and `*-reflection.md`
7. human decision records
8. workflow diff / claim-boundary artifacts, especially Step 11/12 outputs
9. failure, retry, hard-stop, and human-gate events

If any required input is missing, write the missing item into the Step 13 completion decision and stop at a human gate or hard stop when the missing evidence prevents safe improvement.

## Outputs

Write all of these:

```text
13-agent-improvement.md
13-agent-improvement.json
13-playbook-patch-plan.md
13-phase3-readiness.json
13-reflection.md
13-reflection.json
```

## Improvement categories

Classify every proposed improvement as exactly one category:

```text
apply_now_phase1_contract
apply_now_step_prompt_skill
deterministic_tool_candidate
phase2_supervisor_router
phase3_split_runner
workflow_specific_do_not_generalize
```

## Safety boundary

Use this self-evolution risk policy for every proposed change:

| Risk tier | Scope | Step 13 action | Approval and validation |
| --- | --- | --- | --- |
| `low_risk_doc_only` | Documentation wording, typo fixes, examples, or non-normative clarification that does not change agent behavior. | May generate a ready-to-apply patch section in `13-playbook-patch-plan.md`. Do not claim it has been applied unless the files were actually changed with recorded approval or an explicit low-risk auto-apply mechanism exists. | No human approval required to include the patch plan; applying it still needs an explicit recorded action in Phase 1 unless the backend provides a safe auto-apply path. |
| `medium_prompt_skill_contract` | `agent.md`, step prompt, or skill contract changes that affect model behavior, gates, completion criteria, or common constraints. | Generate a patch plan and stop at a human gate before applying shared files unless approval is already recorded. | Human approval required before applying. Include exact target files and expected behavior impact. |
| `high_backend_tool_behavior` | TypeScript backend, Python tools, download/runtime behavior, Web UI behavior, tests, or any security/credential-handling change. | Generate a patch plan only; do not apply during Step 13 without human approval and validation commands. | Human approval and relevant tests/builds are required before merge or reuse. |
| `workflow_specific_do_not_generalize` | Findings that only apply to the current workflow, model, or operator preference. | Record as workflow-specific evidence, not a shared patch. | No shared application. |

Do not directly modify shared prompt, skill, agent, or backend implementation files unless the action is allowed by the risk tier and the required approval/validation evidence is recorded. Generating the patch plan is safe; applying medium/high-risk changes is human-gated.

Every improvement item in `13-agent-improvement.json` must include:

```json
{
  "id": "",
  "risk_tier": "low_risk_doc_only | medium_prompt_skill_contract | high_backend_tool_behavior | workflow_specific_do_not_generalize",
  "category": "apply_now_phase1_contract | apply_now_step_prompt_skill | deterministic_tool_candidate | phase2_supervisor_router | phase3_split_runner | workflow_specific_do_not_generalize",
  "target_files": [],
  "root_cause": "",
  "proposed_change": "",
  "approval_required": true,
  "required_validation": [],
  "apply_status": "patch_plan_only | waiting_for_human_approval | approved_to_apply | applied | do_not_apply"
}
```

`13-playbook-patch-plan.md` must group changes by risk tier and include exact files, rationale, unified-diff-style snippets when safe, approval requirement, and validation commands for high-risk changes.

## Completion decision

`13-agent-improvement.json` must include:

```json
{
  "orchestrator_status": "complete",
  "step_id": "13",
  "inputs_reviewed": [],
  "missing_inputs": [],
  "improvements": [],
  "phase3_readiness": {},
  "human_gate_prompt": null,
  "next_step_recommendation": {
    "recommended_step_id": null,
    "edge_type": "complete",
    "reason": "Step 13 completed the Phase 1 migration improvement pass.",
    "required_context_for_next_step": [],
    "blocked_by": []
  }
}
```

If applying shared code/doc changes is recommended, set `orchestrator_status` to `human_gate_reached` unless explicit approval was already recorded.

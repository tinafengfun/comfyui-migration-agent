# Step 13 skill: Agent improvement and playbook hardening

Use this skill at the end of every Phase 1 00-13 migration run.

## Goal

Turn one completed or gated workflow migration into actionable agent/playbook improvements and Phase 3 split-runner evidence.

## Procedure

1. Load `task-state.json` and verify the run reached Step 13 legitimately.
2. Read Step 00-12 reflections and output manifests.
3. Read context debt and Phase 3 extraction candidates.
4. Review human questions/answers, failures, retries, hard stops, and claim-boundary changes.
5. Group issues by root cause:
   - missing upstream context;
   - weak completion schema;
   - brittle prompt/skill wording;
   - missing deterministic tool;
   - human gate wording gap;
   - Web UI visibility gap;
   - Phase 2 routing/back-edge gap;
   - Phase 3 runner split candidate.
6. Write the required Step 13 artifacts.
7. Document proposed shared prompt/skill/agent/backend changes factually. Do NOT write gate keywords in artifacts — the system controls gating via `gate-signal.json`.

## Self-evolution risk tiers

Classify every improvement with exactly one `risk_tier`:

| Risk tier | What belongs here | Allowed Step 13 behavior |
| --- | --- | --- |
| `low_risk_doc_only` | Non-normative documentation wording, typo fixes, examples, or clarifications that do not change runtime behavior, prompt obligations, gates, or completion criteria. | Generate a ready patch plan. Do not claim application unless a recorded approval or explicit safe auto-apply path exists. |
| `medium_prompt_skill_contract` | Changes to `agent.md`, step prompts, skills, shared migration contracts, human-gate wording, completion schemas, or model instructions. | Generate a patch plan and ask for human approval before applying shared files. |
| `high_backend_tool_behavior` | Backend TypeScript, Python tools, download/runtime behavior, Web UI, tests, security, credential handling, or behavior-affecting automation. | Generate a patch plan only unless human approval and validation commands are recorded. |
| `workflow_specific_do_not_generalize` | Current-workflow-only findings, model-specific preferences, or temporary operator choices. | Record as non-generalizable evidence; do not patch shared files. |

Each improvement in `13-agent-improvement.json` must include:

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

`13-playbook-patch-plan.md` must group items by risk tier. For low-risk items, include ready-to-apply diff snippets when safe. For medium-risk items, include the exact human approval question. For high-risk items, include required test/build commands and review notes.

## Required output files

```text
13-agent-improvement.md
13-agent-improvement.json
13-playbook-patch-plan.md
13-phase3-readiness.json
13-reflection.md
13-reflection.json
```

## Reflection requirement

`13-reflection.json` must include:

```json
{
  "step_id": "13",
  "upstream_context_sufficient": true,
  "missing_or_ambiguous_context": [],
  "problems_encountered": [],
  "resolutions_applied": [],
  "next_step_output_contract_changes": [],
  "prompt_skill_tool_improvements": [],
  "phase3_extraction": {
    "can_be_split_later": false,
    "future_runner_type": "report_synthesizer",
    "required_step_context_bundle_fields": [],
    "inputs_used_from_memory": [],
    "inputs_used_from_artifacts": [],
    "missing_context_debts": [],
    "tool_candidates": [],
    "unsafe_to_split_reasons": []
  }
}
```

## Hard stops

Hard stop Step 13 if:

1. required run artifacts are missing and cannot be reconstructed from durable files;
2. the agent would need to rely on unpersisted chat memory for improvement claims;
3. applying medium- or high-risk changes would alter shared behavior without human approval;
4. the improvement would require persisting secrets or private credentials.

## Shared file change review

When the patch plan is ready but shared prompt/skill/backend files should be modified, document the changes factually. Do NOT write gate keywords in artifacts — the system controls gating via `gate-signal.json`. Document:

1. exact files proposed for change;
2. reason for each change;
3. risk level;
4. whether the change applies to Phase 1, Phase 2, or Phase 3;
5. safe choices: approve patch application, keep patch plan only, or stop.

## Completion behavior

Step 13 must write `13-reflection.md` and `13-reflection.json` after producing the improvement artifacts. Its `next_step_recommendation` should use `edge_type: complete` when the full 00-13 run is complete, or `blocked` when shared file changes require explicit approval. Do NOT write `human_gate_reached` or `orchestrator_status` in artifacts.

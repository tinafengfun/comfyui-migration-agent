### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 15 `ask_user` rounds per step; after round 15, apply your best judgment and proceed.

# Delivery packaging skill

## Use when

Use after migration, validation, and review evidence are available.

## Inputs

- final support statement
- patch diff or patch bundle
- deployment baseline
- validation artifacts
- asset ledger
- known gaps

## Algorithm

1. Package patches and record upstream commits.
2. Write fresh deployment checklist.
3. Include workflow copies, prompts, histories, logs, telemetry, and outputs.
4. Add manual GUI/customer validation steps when relevant.
5. State acceptance criteria and known limitations.
6. Fill or adapt the migration result report template.
7. Link artifact bundle and canonical docs.
8. Generate a package manifest and completion decision with explicit Step 12 handoff.

## Common failure signatures

- delivery doc says full success but evidence is smoke-only
- generated media missing from artifact bundle
- patch application steps not reproducible
- customer GUI validation omitted
- result report lacks branch coverage or hard-stop evidence
- package copies stale or previous-attempt outputs instead of the accepted Step 08 output list
- Step 11 marks customer-ready before Step 12 GUI/manual evidence exists

## Evidence standard

Retain patch bundle, deployment guide, validation report, outputs, and artifact index.

The output bundle must include only evidence that supports the declared boundary. If Step 12 is pending, include a manual test plan and `customer_ready=false`.

## Hard stops

Stop delivery if reproduction steps or evidence do not support the support statement.

Stop or human-gate if final wording claims full-size capacity, source-identical fidelity, GUI/manual acceptance, or customer-ready quality without matching evidence.

## Output schema

`patches`, `deployment`, `validation`, `outputs`, `asset_state`, `support_matrix`, `known_gaps`, `acceptance_steps`.

Required Step 11 artifacts:

- `11-delivery/`
- `11-delivery/package-manifest.json`
- `11-delivery-summary.json`
- `11-delivery.md`
- `11-output-manifest.json`

`step12_context` must include the delivery directory, source workflow copy, runtime-policy prompt, model-path config, validation report, manual test plan, API URL, and claim-boundary warning.

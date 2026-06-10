**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 15 `ask_user` rounds per step; after round 15, apply your best judgment and proceed.

# Delivery packaging prompt

## Task

Package the migration result for engineering review and customer-facing validation.

## Required context

- final support statement
- patch files
- deployment steps
- validation prompts/histories/logs
- generated outputs
- asset ledger and gap reports

## Constraints

1. Claims must match evidence.
2. Do not hide CPU fallback, smoke-only aliases, or unresolved assets.
3. Customer delivery must include manual validation steps where GUI validation is required.
4. Keep artifact bundles as evidence, not duplicate generic docs.

## Steps

1. Package code patches and patch README.
2. Write deployment and fresh-environment checklist.
3. Include workflow copies, prompts, histories, logs, telemetry, and generated outputs.
4. Write acceptance criteria and manual GUI validation steps.
5. Summarize known gaps and escalation paths.
6. Fill or adapt `docs/draft/templates/migration-result-report-template.md`.
7. Link reusable docs and case evidence.
8. Emit `completion_decision`, `package-manifest.json`, `11-output-manifest.json`, and `step12_context`. Delivery packaging may be complete while `customer_ready=false`, but only if the package explicitly routes GUI/manual acceptance to Step 12 and does not overclaim the evidence boundary.

## Output

Create a delivery bundle with:

- patch inventory
- deployment guide
- asset/custom-node ledger
- validation report
- customer manual test plan
- known gaps and support matrix
- artifact index
- final migration result report
- package manifest, completion decision, and Step 12 GUI/manual acceptance context

## Hard stops

Stop delivery if the package cannot reproduce the claimed result or if customer-facing validation evidence is missing.

If customer-facing validation is intentionally deferred to Step 12, Step 11 must set `customer_ready=false`, include a manual test plan, and make Step 12 the next gate instead of claiming final delivery approval.

## Prior-migration lessons

Dasiwa delivery improved only after it became end-user oriented: workflow copies, GUI validation, generated outputs, manual steps, and fresh deployment checklist all mattered.

Zimage v2 Step 11 showed that a delivery package should be deterministic and bounded: copy only the current accepted output files, preserve source/runtime-policy workflow artifacts separately, and make the customer-ready claim false until Step 12 captures GUI/manual evidence.

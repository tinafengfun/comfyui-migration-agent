### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 15 `ask_user` rounds per step; after round 15, apply your best judgment and proceed.

# Coverage review skill

## Use when

Use before publication or after any major validation pass.

## Inputs

- workflow JSON
- authoritative API prompt
- full-run evidence
- branch-smoke evidence
- gap reports

## Algorithm

1. Enumerate workflow nodes.
2. Enumerate prompt nodes.
3. Extract executed nodes from full-run evidence.
4. Extract executed nodes from smoke evidence.
5. Normalize evidence shape before classification; history/summary artifacts may represent outputs as node-keyed maps or lists.
6. Separate executed evidence, cached evidence, and output-only evidence.
7. Exclude structural nodes from runtime-gap claims only after documenting why they are structural or disconnected.
8. Classify every executable node.
9. Produce a final support statement that names the validation boundary: runtime-policy API, source-identical, GUI/manual, or customer-facing.
10. Write `completion_decision` and `step11_context`; do not allow Step 11 unless uncovered executable nodes are empty and all excluded nodes have an explicit rationale.

## Common failure signatures

- prompt misses workflow nodes
- intended outputs pruned during validation
- one successful branch used as whole-workflow proof
- blocked node not represented in support statement
- source/prompt node-count mismatch treated as a blocker without classifying missing nodes
- cached-node evidence reported as executed coverage
- disconnected dead-end executable hidden instead of recorded as an explicit non-output gap
- coverage review wording upgraded into delivery/customer approval

## Evidence standard

Retain coverage table with evidence source per node.

The coverage table must include enough fields to audit the decision:

- whether the node exists in the source workflow
- whether the node exists in the authoritative API/runtime-policy prompt
- whether it executed in full-run evidence
- whether it executed in branch-smoke evidence
- whether evidence is cached or output-only
- whether the node is structural, disconnected/reference, or dead-end
- any explicit gap and its support-statement impact

## Hard stops

Stop release if executable nodes are uncovered and not explicitly classified.

Also stop if the coverage report upgrades cache-assisted or reduced runtime-policy evidence into full-size, source-identical, GUI/manual, or customer-quality approval.

## Output schema

`node_id`, `node_type`, `branch`, `role`, `source_present`, `prompt_present`, `full_run`, `smoke_run`, `cached_evidence`, `output_evidence`, `structural`, `status`, `evidence`, `gap`, `support_impact`.

Required Step 10 artifacts:

- `10-node-coverage.csv`
- `10-coverage-summary.json`
- `10-coverage-review.md`
- `10-output-manifest.json`

The summary must include coverage counts, uncovered executable node IDs, branch status rollup, claim boundary, `completion_decision`, and the minimum Step 11 packaging context.

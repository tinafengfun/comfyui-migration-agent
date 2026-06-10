**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 15 `ask_user` rounds per step; after round 15, apply your best judgment and proceed.

# Coverage review prompt

## Task

Audit whether the migration evidence covers every executable workflow node.

## Required context

- original workflow JSON
- authoritative converted full prompt
- full-run history/logs
- successful branch-smoke histories/logs
- generated outputs
- known gap reports

## Constraints

1. Count structural nodes but exclude them from runtime-gap claims.
2. Do not let a full run hide pruned branches.
3. Do not claim all nodes are covered unless every executable node has evidence or an explicit gap.
4. Keep smoke evidence separate from full-run evidence.
5. Do not treat a source-vs-prompt node-count mismatch as a failure until each missing node is classified. Reroute, Note, bypass utilities, and disconnected/reference nodes may be omitted or collapsed in an API prompt.
6. Do not count cached-node evidence as equivalent to executed-node evidence unless the report explicitly labels it as cache-assisted and there is independent full-run or smoke evidence.
7. Do not let coverage review become delivery approval. Coverage can clear engineering node coverage while GUI/manual validation and customer quality remain separate.

## Steps

1. Extract workflow JSON node set.
2. Extract converted prompt node set.
3. Extract executed nodes from full-run evidence.
4. Extract executed nodes from successful branch-smoke evidence.
5. Build coverage table by node.
6. Normalize history/output schemas before comparing evidence; ComfyUI summaries may store `outputs` as either node-keyed maps or lists of output records.
7. Classify each missing node as structural, pruned, disconnected/reference, dead-end explicit gap, untested, covered by smoke, CPU fallback, or blocked.
8. Produce a separate prompt-present review that explains source workflow nodes that are absent from the runtime-policy prompt.
9. Emit a machine-readable `completion_decision` and `step11_context`. Step 10 is complete only if every source node is represented in coverage, every executable node is covered or explicitly classified, branch-smoke/full-run/cache evidence boundaries are separated, and the support statement does not exceed the Step 08/09 evidence boundary.

## Output

Create a coverage-review report with:

- node coverage table
- uncovered executable nodes
- evidence source per covered node
- prompt-present / prompt-missing review
- explicit exclusions for structural, disconnected, dead-end, or reference nodes
- final support statement
- required follow-up tests or gap notes
- completion decision and Step 11 packaging context

## Hard stops

Stop publication if executable nodes are neither covered by evidence nor explicitly classified as gaps.

## Prior-migration lessons

Dasiwa showed that all-executable-node coverage may require full-run plus branch-smoke evidence. A single run does not necessarily cover every branch.

Zimage Step 10 showed that full-run coverage can be complete while the API prompt has fewer nodes than the GUI workflow, because structural GUI plumbing and disconnected reference nodes are not runtime-output nodes. It also showed that coverage scripts must handle multiple history/output schemas and must separate executed evidence from cached evidence.

Zimage v2 Step 10 showed that coverage reconciliation should be a reusable deterministic tool. The tool must consume Step 03, 06, 07, 08, and 09 artifacts; generate `10-node-coverage.csv`, `10-coverage-summary.json`, `10-coverage-review.md`, and `10-output-manifest.json`; and preserve the exact claim boundary for Step 11.

## Example output shape

```text
Node 54: covered by full-run failure evidence; status = capacity hard stop
Node 131: covered by branch-smoke history; status = smoke validated
Node Note/Reroute: structural; status = excluded from runtime gap
Node disconnected reference preprocessor: status = excluded from runtime support claim
Node dead-end executable: status = explicit gap; not on intended output path
Node X: prompt-present but no full-run or smoke evidence; status = uncovered, release blocked
```

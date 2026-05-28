# Full validation and capacity skill

## Use when

Use after branch smoke to test target fidelity or highest-fidelity reproducible path.

## Inputs

- validated full prompt
- smoke evidence
- memory estimates
- runtime instrumentation
- target budget

## Algorithm

1. Run the full or highest-fidelity prompt.
2. Capture exact failing node and model path if it fails.
3. Compare runtime free/required memory with hardware budget.
4. Compare active weights and activation estimate with runtime evidence.
5. Try only reasonable mitigations.
6. Classify result honestly.
7. If the prompt is a Step 6 runtime-policy variant, keep that boundary in the result class. Do not upgrade runtime-policy success to source-identical workflow success.
8. If the run succeeds near the memory limit, record it as tight success with peak/budget ratio and keep telemetry requirements for later GUI or delivery validation.
9. Preserve graph structure when applying reduced settings. Fixed seeds should update seed nodes, not replace linked sampler inputs with literals.
10. Reconcile every source node. Classify nodes as executed, cached, disconnected/reference, sink, or structural value nodes; do not let structural primitives become false uncovered-node failures.
11. Preserve and label previous attempts: cold-start OOM, cache-assisted success, report/accounting recovery, and final accepted run may all be different evidence classes.

## Capacity decision matrix

Use usable VRAM after reserves, not the marketing memory size.

| Runtime required memory vs usable budget | Decision |
| --- | --- |
| `< 80%` | Continue normal validation; capacity is not the first suspect. |
| `80-100%` | Continue with telemetry; try targeted reserve/offload/placement changes only if needed. |
| `100-120%` | Allow one bounded mitigation pass if source and graph evidence show a plausible fix; prepare hard-stop evidence in parallel. |
| `> 120%` | Stop generic tuning once static reasoning agrees; classify as capacity hard stop. |

Reasonable mitigations include targeted CPU placement for VAE/text/image preprocess stages, reserve adjustment, validated attention mode changes, reduced frame count/resolution for a restricted tier, or multi-XPU escalation. Repeating generic `lowvram` settings without a new hypothesis is not a mitigation.

Static model-file sums are an upper-bound warning, not a resident-memory measurement. A file-size sum that exceeds device memory should trigger telemetry and staged-execution reasoning, not an automatic hard stop. Conversely, a successful run above 80% budget is not comfortable capacity; keep the exact launch flags, offload behavior, and memory polling evidence with the result.

## Common failure signatures

- generic lowvram retries after capacity is proven
- CPU VAE expected to fix sampler activation peak
- wrong branch blamed before instrumentation
- full-size failure reported as unresolved generic issue

## File system checks

When checking model file sizes, always use `stat --format='%s' FILE` or `wc -c < FILE` to get the actual file size. Do NOT use `ls -l` to determine file size — symlinks show the symlink string length (typically <200 bytes), not the target file size. To check symlink targets, use `readlink -f FILE` first, then `stat` the resolved path.

Always read `01-assets.csv` for model resolution context before investigating model files — it records the resolved path, source, and any known issues (e.g., "Symlink to flux-2-klein-9b.safetensors (18 GB)").

## Evidence standard

Retain full prompt, history, logs, memory telemetry, failure traceback, output files, and theoretical memory notes.

For successful runs, evidence must still include:

- full/high-fidelity prompt used
- whether the source prompt was source-identical or a runtime-policy variant
- `partial_execution_targets`, if used
- executed and cached node counts
- output files, dimensions, and durable artifact paths
- temporary preview/comparer evidence copied or recorded before cleanup
- target usable VRAM and runtime peak/budget ratio
- static model/activation reasoning and why it did or did not match runtime
- next validation boundary: API, GUI/manual, customer quality, or delivery packaging
- all-node accounting and any structural value nodes not runtime-scheduled
- whether the accepted run was cold, warm, or cache-assisted

Capacity hard-stop evidence must include:

- full or highest-fidelity prompt used
- failing node and output branch
- runtime free/required memory or OOM traceback
- target usable VRAM
- static memory estimate and assumptions
- mitigations tried or ruled out
- recommended next route

## Hard stops

Stop and classify as capacity hard stop when runtime and theory both exceed budget.

Do not classify report/accounting defects as capacity hard stops. If history succeeded and outputs/telemetry exist, repair the report/accounting artifact without rerunning expensive GPU work unless the evidence is stale.

## Output schema

`run_target`, `status`, `source_boundary`, `partial_execution_targets`, `executed_nodes`, `cached_nodes`, `outputs`, `failing_node`, `memory_runtime`, `memory_theory`, `budget_ratio`, `mitigations`, `result_class`, `escalation`.

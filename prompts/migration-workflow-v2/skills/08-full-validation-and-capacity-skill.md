### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write findings, questions, or follow-ups as plain text instead of calling `ask_user`, the step will end prematurely. This includes presenting hard_stop items, gate decisions, validation failures, and any question requiring human judgment. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

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
2a. **If the prompt "hangs" (queue shows running, VRAM stays flat, no error) — do not assume a model-loading/XPU deadlock before checking for a human-in-the-loop node.** Some custom nodes (e.g. `Prompt_Edit`) pause execution waiting for a browser client to confirm, with a timeout up to an hour — indistinguishable from a stuck load using VRAM/queue state alone. Get a live stack trace first: `py-spy dump --pid <comfyui_pid> --locals` (install via `pip install py-spy` in the target venv if missing). If the worker thread is parked in a custom node's own wait loop rather than torch/XPU code, this is that class of issue, not a capacity/XPU problem — route back to Step 06's `bypass_human_in_the_loop_nodes()` fix (see Step 06 skill 8a) rather than spending capacity-analysis effort on it.
3. Compare runtime free/required memory with hardware budget.
4. Compare active weights and activation estimate with runtime evidence.
5. Try only reasonable mitigations.
6. Classify result honestly.
7. If the prompt is a Step 6 runtime-policy variant, keep that boundary in the result class. Do not upgrade runtime-policy success to source-identical workflow success.
8. If the run succeeds near the memory limit, record it as tight success with peak/budget ratio and keep telemetry requirements for later GUI or delivery validation.
9. Preserve graph structure when applying reduced settings. Fixed seeds should update seed nodes, not replace linked sampler inputs with literals.
10. Reconcile every source node. Classify nodes as executed, cached, disconnected/reference, sink, or structural value nodes; do not let structural primitives become false uncovered-node failures.
11. Preserve and label previous attempts: cold-start OOM, cache-assisted success, report/accounting recovery, and final accepted run may all be different evidence classes.

## Reachability is checked automatically — never improvise a ComfyUI launch yourself

The backend automatically checks and, if needed, correctly (re)launches ComfyUI before Step 08's SDK session even starts (`comfyuiLifecycle.ts`'s `ensureComfyUiUp`, same mechanism as Step 07). By the time you're reading this, the endpoint is already confirmed reachable. If it couldn't be brought up, the step never reached you: it was already hard-stopped upstream with a clear "infrastructure hard stop" reason. Do not hand-write a `docker run`, do not fall back to a bare-metal `python main.py` for a `runtime: docker` node, and do not `pip install` into the shared NFS venv — see Step 07's skill for the real incident this closes.

## Capacity decision matrix

Use usable VRAM after reserves, not the marketing memory size.

| Runtime required memory vs usable budget | Decision |
| --- | --- |
| `< 80%` | Continue normal validation; capacity is not the first suspect. |
| `80-100%` | Continue with telemetry; try targeted reserve/offload/placement changes only if needed. |
| `100-120%` | Allow one bounded mitigation pass if source and graph evidence show a plausible fix; prepare hard-stop evidence in parallel. |
| `> 120%` | Stop generic tuning once static reasoning agrees; classify as capacity hard stop. |

Reasonable mitigations include targeted CPU placement for VAE/text/image preprocess stages, reserve adjustment, validated attention mode changes, reduced frame count/resolution for a restricted tier, or multi-XPU escalation. Repeating generic `lowvram` settings without a new hypothesis is not a mitigation.

**Step 08 now measures full-size capacity itself — do not defer OOM discovery to the Step 12 human run.** `step08_full_validation.py`'s default run level is `capacity-probe`: it runs the graph at **full resolution and full frame count** but with **minimal sampler steps**. Peak VRAM is per-forward and essentially step-count-independent, so a 1-step full-resolution run reveals the same peak as the full run at a fraction of the wall-clock. The tool then classifies `capacity_tier` deterministically into `completion_decision` and `step12_context`:

| `capacity_tier` | Meaning (peak / usable-budget, or hard error) | Decision |
|---|---|---|
| `ok` | fits with headroom (`< 90%`) | `complete`; Step 12 may run full size |
| `tight` | fits but `>= 90%` of usable budget | `complete` + `reduced_tier_required=true`; Step 12 runs reduced tier |
| `reduced` | completed only over budget (`>= 100%`, survived via offload thrash) | `complete` + `reduced_tier_required=true` |
| `insufficient` | hit a hard XPU capacity error at full size (39/20/40 / `could not create a primitive`, or the server crashed/timed out) | `hard_stop`, classified capacity signal + recommended reduced setting |

Because the probe runs at full size, a capacity-marginal workflow now **hard-stops at Step 08** (classified, with a recommended reduced setting) instead of passing Step 08 and blowing up in the operator's Step 12 GUI run. The legacy `--run-level reduced-full-path` (also shrinks resolution) says nothing about full size → `capacity_tier: "unknown"`; only use it for a cheap integration smoke, never as the capacity gate. A `DEVICE_LOST` (20) still kills the XPU handle → the container is restarted by `ensureComfyUiUp` before the next step.

**At the capacity edge, XPU errors move across kernels — treat them as ONE capacity signal, not three separate bugs to toggle.** Confirmed live 2026-08-09 on full-size WAN2.2-14B video (720×1280 × 81 frames ≈ 79,376 tokens) on a 30 GB XPU: as each edge-failure was worked around, the next kernel failed — `UR_RESULT_ERROR_OUT_OF_DEVICE_MEMORY` (39, the fp8 linear), then `UR_RESULT_ERROR_DEVICE_LOST` (20, the OmniXPU ESIMD attention kernel faulting the device), then `UR_RESULT_ERROR_OUT_OF_RESOURCES` (40, the fp8 fallback GEMM once M > the native kernel's 8192 guard). All three are the same message: **full-size is marginal on this single GPU.** Do NOT chase them kernel-by-kernel. Two real levers: (1) **reduced-size tier** (below) — the reliable fix; (2) for the ESIMD-attention `DEVICE_LOST` specifically, set the node's `attn_backend: "torch"` (launch passes `OMNI_ATTN_BACKEND=torch`, stable PyTorch SDPA) — but note torch attention is memory-heavier and may then `OUT_OF_RESOURCES` at full size, so it's a stopgap, not a full-size fix. A `DEVICE_LOST` also means the XPU handle is dead: the container must be restarted to recover (the backend's `ensureComfyUiUp` relaunch handles this on the next step).

**The capacity decision is a system-controlled gate — do NOT resolve it yourself.** When `capacity_tier` is `reduced` or `insufficient`, write `08-full-validation-summary.json` (with `capacity_tier`, `recommended_reduced_setting`, `capacity_error_signature`) and **stop there**. The backend deterministically reads that summary and presents the operator a decision panel (Accept reduced tier / Hardware escalation / Hard stop) — see `orchestrator.pauseIfStep08CapacityGate`. You must **not** silently mark Step 08 successful, and you do **not** need your own `ask_user` round for the capacity choice (that would double-gate). Just make sure the summary's `completion_decision.capacity_tier` and `step12_context.recommended_reduced_setting` are populated.

**Reduced-size "acceptance tier" (handed to Step 12 automatically).** When the capacity-probe hits any of the above failures (or measures a tight/over-budget peak), `step08_full_validation.py` now writes `capacity_tier` + `recommended_reduced_setting` into `step12_context` and the completion decision for you — you don't hand-author it. The recommended setting halves spatial dims and/or frames until the token count drops well under the failing point (e.g. 480×832 × 49 was confirmed to run clean end-to-end where 720×1280 × 81 failed). This is the reliable GUI-acceptance path; the full-size "customer-ready" claim stays a capacity hard stop needing a larger/multi-GPU node. Step 12 runs its GUI acceptance at this reduced tier and downgrades the claim boundary accordingly.

**Block-swapping the primary generative model is not a mitigation -- it is a hard-stop signal, even when the run completes without OOM.** Confirmed live: LongCat-Avatar-15 (bf16, ~30 GB active transformer weights) on a 30.3 GB-class XPU node required `WanVideoBlockSwap` to hold half the transformer (~15 GB) on host and half on device, transferred synchronously (`Non-blocking memory transfer: False`) every step. The run eventually completed -- no OOM, no failed node -- but was impractically slow (the API server itself became unresponsive for extended stretches while blocked on transfer) and is not viable for production delivery. A "successful" run is not automatically tight success if it only succeeds by swapping the bulk of the primary model between host and device. Treat block-swap as an acceptable mitigation only for a small, targeted offload (e.g. VAE/text-encoder residency, a few edge blocks) -- not for the primary model's main weight mass. If the primary model's own active/on-device weight requirement alone leaves less than roughly 2 GB of true headroom in the target's usable VRAM budget (e.g. >28 GB active weights on a ~30 GB-class card) and the runtime evidence shows block-swap engaging to make it fit at all, classify as **capacity hard stop** regardless of whether the run completes -- do not classify it as tight success just because it finished.

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

Stop and classify as capacity hard stop when the primary model requires block-swapping the bulk of its own weights (not just VAE/text-encoder/edge-block offload) to fit the target's usable VRAM at all -- even if the run completes -- see the block-swap note above. A completed-but-impractically-slow run is not tight success.

Do not classify report/accounting defects as capacity hard stops. If history succeeded and outputs/telemetry exist, repair the report/accounting artifact without rerunning expensive GPU work unless the evidence is stale.

(Infrastructure/reachability hard stops are handled automatically before this step starts — see the Reachability section above.)

## Output schema

`run_target`, `status`, `source_boundary`, `partial_execution_targets`, `executed_nodes`, `cached_nodes`, `outputs`, `failing_node`, `memory_runtime`, `memory_theory`, `budget_ratio`, `mitigations`, `result_class`, `escalation`.

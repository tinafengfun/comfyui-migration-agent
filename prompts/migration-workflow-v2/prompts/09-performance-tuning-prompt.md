**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Performance tuning prompt

## Task

Tune an already validated workflow path on Intel XPU using controlled measurements.

## Required context

- working baseline prompt
- branch/full validation evidence
- target metric: latency, throughput, memory, stability, or quality
- benchmark harness and telemetry tools

## Constraints

1. Do not tune before baseline validation.
2. Change one variable at a time unless testing a named bundle.
3. More XPU placement is not automatically faster.
4. Preserve baseline and losing candidates.
5. Do not choose a winner from runtime alone when telemetry is missing or malformed.
6. Do not turn on cache/model residency optimizations for single-run delivery unless the target use case is repeated/batch execution and a separate memory-residency test passes.
7. If a candidate is faster but materially tighter on memory, keep the safer baseline as an explicit fallback.
8. Do not promote a faster candidate that is rejected for graph-policy or report-validity reasons. Keep it in the rejected matrix, but choose winners only from accepted or report-recovered-valid evidence.
9. If Step 08 already ran several attempts, Step 09 may normalize and rank those attempts instead of launching new high-risk jobs, as long as telemetry, outputs, cache policy, and rejection reasons are present.

## Steps

1. Freeze baseline prompt, seed, resolution, frame count, and output target.
2. Define candidate tuning knobs: device placement, VAE/encoder offload, reserve VRAM, attention mode, dtype, lowvram, CPU fallback.
3. Validate the benchmark harness before long runs: verify queue handling, history capture, output collection, and at least one telemetry sample with non-empty memory fields.
4. Run controlled trials. Use a cold restart or explicit cache policy when comparing launch-level settings.
5. Compare runtime, memory, output integrity, cached-node counts, telemetry quality, and failure signatures.
6. Pick winner or declare no safe improvement.
7. If telemetry is missing, fix the harness and rerun the affected candidates rather than reusing incomplete data.
8. If no safe lossless improvement is justified, select the delivered config the tool reports (`validated-reduced-lowvram` / `reduced-lowvram-marginal` / `full-size-delivery`) with an explicit "no lossless tuning headroom" reason — do not invent a launch-tweak winner.

## Config-aware: read the delivered config, do not re-derive it

The delivered runtime config is already hardened by the Step 07/08 capacity ladder in
`artifacts/effective-run-config.json` (`vram_flags`, `reduced_tier`, `reduced_prompt_path`,
`recommended_reduced_setting`). Step 09's job is to report THAT config truthfully and back it
with one clean **same-flags** telemetry sample — not to invent a per-workflow default.

- The VRAM offload flags (`--lowvram`/`--novram`) are **lossless** (placement only) and are
  owned by the system escalation ladder. Do **not** hand-toggle them as a "tuning knob"; the
  orchestrator relaunches ComfyUI with the persisted flags before each GPU step (and the ladder
  re-escalates on OOM). Dropping offload to "go faster" just re-introduces the capacity OOM.
- When the workflow is **capacity-locked** to a reduced tier + offload flags (e.g. WAN2.2 at
  `--lowvram`), "no lossless tuning headroom — a faster run needs a larger-VRAM node" is a
  VALID, expected outcome. Report it; do not fabricate a launch-tweak winner.

## Reusable Step 09 tool

Use the config-aware tuning tool. **Pass `--api-url`** so it captures a real reduced +
delivered-flags sample on the current server (by Step 09 the orchestrator has already reset the
XPU and reconciled the container to the persisted `--lowvram` flags, so the sample measures the
config ON THE DELIVERED FLAGS — not the off-flags value Step 08's inline probe may have recorded
before the reduced tier pinned `--lowvram`):

```bash
<ComfyUI root>/.venv-xpu/bin/python \
  $DRAFT_DOC_ROOT/migration-workflow-v2/tools/step09_performance_tuning.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --api-url http://127.0.0.1:<port> \
  --timeout-seconds 1200 \
  --smoke-seed <fixed integer>
```

It reads `effective-run-config.json`, runs the deferred reduced-validation once on the delivered
flags (or reuses a valid upstream verdict / defers to Step 12 when no server is given), and writes
`09-tuning-analysis.json`, `09-tuning.md`, and `09-output-manifest.json`. If `--api-url` is
omitted it still produces a truthful config-aware report, just without the fresh same-flags sample.

## Output

Create a tuning report with:

- baseline
- candidate matrix
- measurements
- selected configuration
- safer fallback configuration, if the selected configuration has less headroom
- rejected configurations and reasons
- telemetry validity notes
- remaining bottleneck or hard stop
- rejected candidates that were faster but invalid, with policy reason
- next-step coverage boundary

## Hard stops

Stop if tuning candidates are slower, less stable, corrupt output, or continue to exceed structural capacity.

Also stop and repair the benchmark harness if:

- XPU/CPU telemetry is empty or obviously malformed
- ComfyUI cache makes candidates incomparable
- output files or output history are missing for the target nodes
- server restarts remove temp outputs before they are copied or recorded

## Prior-migration lessons

Dasiwa showed that moving loaders back to default or GPU can be slower or unsupported. Tuning must be evidence-driven, not based on device-placement assumptions.

Zimage Step 9 showed that a speed winner can be a tighter memory configuration: `normalvram` plus less CPU offload improved full-run wall time only modestly while increasing peak VRAM. The report must preserve both the fastest config and the safer fallback. It also showed that telemetry tooling is part of the benchmark: a schema mismatch in `xpu-smi` parsing required rerunning candidates before choosing a winner.

Zimage v2 Step 9 showed a valid "no tuning selected" outcome. A reduced full-path run can be successful but cache-assisted and close to the memory budget, while a cold report-recovery attempt is slower but safer. In that case, preserve the candidate matrix, reject no-bypass violations even if fast, and carry the reduced/cache/source-boundary to Step 10 instead of inventing a new tuning winner.

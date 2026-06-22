# Feasibility analysis skill

## Use when

Use as Step 02 after Step 00 intake and Step 01 asset/custom-node resolution to route the task correctly before inventory, source audit, installation, or runtime execution.

## Inputs

- workflow JSON and `workflow_sha256`
- target hardware, usable VRAM, runtime budget, and `00b-hardware-baseline.md` when available
- expected fidelity and delivery target
- allowed CPU offload, model offload, reduced-resource validation, and multi-XPU policy
- known model/custom-node constraints
- `00-intake-preflight.md`
- `01-assets.csv`
- `01-custom-nodes.md`
- optional `01-node-dependency-scan.csv`
- Step 01 acquisition/cache evidence, including staged custom-node commits, file sizes/checksums, provider attempts, and hidden runtime assets
- recorded human decisions

## Algorithm

1. Identify whether the request is workflow migration, package migration, tuning, delivery, runtime/platform selection, or non-ComfyUI work.
2. Confirm hardware budget and fidelity. If hardware evidence is missing, continue only as preliminary routing and flag for interactive review.
3. Load the source workflow JSON read-only. Count source nodes, links, and obvious output/display nodes. Do not treat this as Step 03 inventory; it is a coverage sanity check.
4. Read `00-intake-preflight.md` and extract `source_node_count`, `scanned_node_count`, `missing_node_ids`, required assets, required custom nodes, source hints, and Step 01 work-queue status when available.
5. Read `01-assets.csv` and classify every row as `resolved/staged`, `source reachable but not staged`, `missing`, `unresolved source`, `access blocked`, `runtime-auto-download hidden asset`, or `smoke-only alias`.
6. Read `01-custom-nodes.md` and classify every custom-node package as `source known`, `source unknown`, `staged/cloned`, `installed/registered`, `registration unknown`, `XPU unknown`, or `hidden-runtime-assets unchecked`.
7. If `01-node-dependency-scan.csv` exists, verify that its scanned node count matches the source node count. If it does not exist, record a dependency-coverage gap.
8. Compare Step 00 dependency names with Step 01 ledgers. If Step 00 named an asset or custom-node gap that Step 01 omitted, list it as a handoff/coverage gap.
9. Estimate active model footprint and likely activation peak only after the relevant asset rows and hardware budget are known. If either side is missing, state that capacity routing is preliminary.
10. Identify obvious CUDA-only/provider-only risks, staged-but-not-installed custom-node commits, local installed commit mismatches, and hidden runtime assets that can change the route.
11. Classify the task into XPU migration, CPU fallback, environment/integration gap, feature-development gap, capacity risk, dependency/human gate, hard stop, or non-ComfyUI route.
12. Write all-node feasibility accounting with one row per source node whenever the route depends on node scope.
13. **Interactive risk review** — If risks, human interventions, or unverified assumptions exist, engage the human operator via `ask_user` for discussion and decision collection (see protocol below).
14. Write `02-feasibility.md` with a terminal state: `complete` or `hard_stop`.
15. If human decisions were collected, write `02-decisions.json`.
16. Include a `completion_decision` block and a Toolization block before closing Step 02.

## Interactive risk review protocol

When the analysis identifies risks, human interventions, or unverified assumptions:

### CRITICAL: ask_user for ALL human communication

You MUST use the `ask_user` tool for EVERY message to the human operator. The human CANNOT see your plain text output. If you write follow-up questions as plain text instead of calling `ask_user`, the step will end prematurely. Call `ask_user` for each round of the discussion.

### Decision tracker (mandatory)

Maintain a tracker across all discussion rounds. Present it with every `ask_user` call:

```text
Decision Tracker:
  [ ] D1: Fidelity tier — smoke / production / custom
  [ ] D2: Hardware — device + VRAM / auto-detect
  [ ] D3: Resource policy — offload settings
  [ ] D4: Risk acceptance — per-risk decisions
```

Items start as `[ ]` and move to `✓` when decided. Max 8 items total.

### Multi-round with convergence

1. **Round 1**: Call `ask_user` with findings + numbered items + tracker (all `[ ]`)
2. **Rounds 2-4**: Human asks questions → call `ask_user` again with answer + updated tracker
   - Mark `✓` for any item the human clearly decides
   - Add new items (D5, D6...) only if discussion reveals new risks
   - **IMPORTANT:** Every response to the human MUST go through `ask_user`, NOT plain text
3. **Round 5 (convergence)**: For any open items, state recommendations:
   ```
   [ ] D3: recommending "both offload allowed"
   [ ] D4: recommending "accept for smoke tier"
   Please confirm or I will apply these recommendations.
   ```
4. **Finalize**: All items `✓` → write `02-decisions.json` + update `02-feasibility.md`

**Maximum 5 `ask_user` rounds.** After round 5, apply recommendations for any remaining open items and proceed.

**Skip interaction only when:** zero risks, zero interventions needed, zero unverified assumptions.

## Coverage and handoff checks

Use this table in the report:

```text
source_node_count:
step00_scanned_node_count:
step00_missing_node_ids:
step01_dependency_scanned_node_count:
step01_missing_dependency_scan_node_ids:
dependency_ledger_omissions:
coverage_status: complete / repaired_from_workflow / incomplete_human_gate
```

Step 02 may repair missing counts by reading the source workflow and existing artifacts. It must not reconstruct evidence from chat memory, and it must not call provider search/download, SSH, clone, install, ComfyUI runtime, or prompt conversion.

If coverage remains incomplete, the result can still be a useful human-gated feasibility report, but it cannot be a normal migration route.

All-node accounting is required before `complete`. Step 02 can reference `00-node-scan.csv` and `01-node-dependency-scan.csv`, but the Step 02 output must explicitly state that all source nodes were accounted for and must emit `02-node-feasibility-accounting.csv` or equivalent durable evidence.

## Asset and custom-node readiness checks

Report at least:

```text
assets_total:
assets_resolved_or_staged:
assets_source_known_not_staged:
assets_unresolved_or_access_blocked:
assets_smoke_only_alias:
hidden_runtime_assets_unchecked:
custom_nodes_total:
custom_nodes_source_unknown:
custom_nodes_source_known_not_installed:
custom_nodes_registration_unknown:
custom_nodes_xpu_unknown:
```

Prefer Step 01's current ledger over Step 00's preflight summary. A deterministic precheck that reads only Step 00 is not enough; Zimage showed that it can pause at the correct gate while dropping the actual Step 01 gap list from the report.

## VRAM estimate template

Use a conservative estimate before running expensive validation:

```text
estimated_peak_vram =
  active_model_weights
  + active_lora_or_adapter_weights
  + activation_peak
  + runtime_workspace
  + safety_margin
```

Guidance:

1. `active_model_weights`: only count weights that must be resident for the active branch at the same time.
2. `activation_peak`: estimate from the heaviest sampler/denoise/video stage, not from VAE or preview nodes.
3. `runtime_workspace`: include attention workspace, decoder workspace, and custom-node temporary tensors when known.
4. `safety_margin`: use at least 10% of device VRAM for smoke and 15-20% for near-production runs.

Do not use this formula as a fake precision tool. Its purpose is routing:

| Estimate vs usable budget | Initial route |
| --- | --- |
| `< 80%` | Normal XPU migration path is plausible if dependencies and coverage are complete. |
| `80-100%` | Continue, but require telemetry early. |
| `100-120%` | Treat as high risk; only proceed if offload or lower-fidelity branch is acceptable. |
| `> 120%` | Prepare capacity-risk or reduced-fidelity plan before runtime work. |

For Dasiwa-style Wan video branches, expect activation peak to dominate once the full denoise path starts. CPU VAE or text-encoder placement may free headroom, but it does not necessarily fix sampler activation pressure.

Use `../templates/intel-xpu-hardware-reference.md` to fill the hardware side of the estimate. If the target is called "B70" or another local environment name, measure the actual GPU and usable VRAM instead of inferring it from the label.

## FP8 quantized weights on XPU — patch vs CPU offload gate

### Background

FP8 quantized text encoders (e.g. `qwen_2.5_vl_7b_fp8_scaled.safetensors`, Qwen3-VL FP8, HunyuanImage TE) hit a known segfault when ComfyUI moves them onto Intel XPU. Root cause: `comfy_kitchen`'s `QTensor.clone()` implementation segfaults during `Module.to("xpu")` while rewrapping FP8 weights. Verified on `comfy_kitchen` ≤ 0.2.8 on Intel Arc [0xe211] with torch 2.12.1+xpu.

### Two resolution paths

| Path | Mechanism | Cost |
| --- | --- | --- |
| **A. ops.py dequant patch** (preferred when VRAM allows) | Patch `comfy/ops.py::_quantized_apply` to dequantize FP8 → bf16 *before* moving to XPU. See `xpu-bug-investigation/0001-xpu-fp8-fallback-dequantize-before-move-to-xpu.patch` in the ComfyUI repo. | Doubles weight memory (FP8 → bf16). Precision verified: min cosine 0.99998 vs CPU native (see `clip_fp8_precision_report.md`). |
| **B. CPU offload** (fallback when VRAM tight) | Set CLIPLoader widget `device=cpu`. Bypasses the XPU segfault entirely; text encode runs on CPU. | Slow text encoding (CPU). No memory pressure on XPU. This is the prior `XPU-CLIP-01` workaround. |

### Decision gate (MANDATORY for any FP8 TE in scope)

Compute before recommending either path. The patch is **only** safe if the dequantized weight footprint fits inside the VRAM headroom already budgeted by the `estimated_peak_vram` template above.

```text
# 1. Measure FP8 size from the actual checkpoint (do not infer from filename)
fp8_bytes = sum(t.numel() * t.element_size() for t in sd.values()
                if t is FP8-quantized and used by the TE architecture)
# Rule out unused buckets before counting (see optimization below):
#   - visual.*            (ViT encoder — unused when TE is text-only)
#   - lm_head.*           (TE reads hidden state before lm_head)
#   - merger/connector/*  (VL bridge — unused for text-only)

# 2. Project bf16 size on XPU after patch dequantizes
bf16_bytes_on_xpu = fp8_bytes * 2        # FP8 (1 byte) → bf16 (2 bytes)
bf16_bytes_on_xpu += fp8_bytes * 0.05    # +5% for dequant scale/bias overhead

# 3. Compute headroom from the VRAM estimate template
free_xpu_vram_bytes = measured_total_xpu_vram - estimated_peak_vram - safety_margin

# 4. Decide
if bf16_bytes_on_xpu < free_xpu_vram_bytes:
    → recommend Path A (apply ops.py patch, keep TE on XPU)
else:
    → recommend Path B (CLIPLoader device=cpu, document as XPU-CLIP-XX patch)
    → OR run the strip-checkpoint optimization below and re-evaluate
```

Apply the gate per FP8 TE in the workflow. A workflow with one FP8 TE and a large GGUF/Q6_K diffusion model will usually fail this gate on 22 GB-class XPU; the same workflow on 48 GB will usually pass.

### Strip-checkpoint optimization (lowers both paths' cost)

Many TE checkpoints ship the full VL model even though ComfyUI's TE class (e.g. `Qwen25_7BVLI`) is text-only. The unused weights still get loaded into the state_dict and dequantized before `load_state_dict(strict=False)` filters them out. For `qwen_2.5_vl_7b_fp8_scaled.safetensors`:

| Bucket | Tensors | FP8 size | Status |
| --- | --- | --- | --- |
| `model.*` (LLM body) | 730 | 7.09 GB | USED |
| `visual.*` (ViT) | 714 | 0.63 GB | unused |
| `lm_head.weight` | 1 | 1.02 GB | unused (no tied embeddings) |
| **Total wasted** | | **1.65 GB (18.8%)** | |

Stripping the unused keys before deployment reduces the FP8 footprint and (under Path A) the on-XPU bf16 footprint by ~3.3 GB. Recommend producing a `<name>_text_only.safetensors` via a strip script during Step 01 acquisition when:

- The TE filename suggests a VL model (`vl`, `vision`, `image` in the name) **and**
- The TE class registered for the workflow's CLIPType is text-only (check `comfy/text_encoders/<arch>.py`)

Verify the stripped checkpoint produces bit-identical TE outputs to the original by running the precision test against both (they must match exactly — the discarded weights are not in the compute graph).

### Handoff

Whichever path is chosen, record in the `step03_context`:

- `fp8_te_present: true/false`
- `fp8_te_path_chosen: "ops_py_patch" | "cpu_offload" | "n/a"`
- `fp8_te_vram_gate_passed: true/false`
- `fp8_te_checkpoint_stripped: true/false`
- `fp8_te_patch_file: "<path-to-patch-or-none>"` (Step 05 will apply this)
- `fp8_te_precision_evidence: "<path-to-test-output-or-pending>"` (Step 08 will produce this)

## Evidence standard

Use workflow structure, model sizes, source hints, Step 01 acquisition evidence, and documented target requirements. Do not rely on optimism.

If the backend generated `02-feasibility.md` before the SDK agent starts, treat it as a precheck scaffold/evidence snapshot. It is not the final Step 02 decision until the agent has consumed Step 01 evidence and written the final routing summary or completed interactive risk review.

Minimum evidence:

- target XPU model and usable VRAM, or a stated hardware-evidence gap
- workflow output branches known so far and intended fidelity
- full-node scan/dependency coverage status
- list of large active model files and unresolved model/input files
- source/acquisition readiness from Step 01
- hidden runtime asset status
- custom-node source/install/registration/XPU status
- rough peak estimate with assumptions, or a reason it cannot be estimated yet
- early source-risk list for critical custom nodes
- `step03_context` for the next session

## Terminal states

| State | Meaning |
| --- | --- |
| `complete` | Evidence is sufficient, interactive risk review done (when needed), decisions recorded. Continue to Step 03. |
| `hard_stop` | Safe continuation is impossible under current requirements without changing the requirement, hardware, assets, or no-bypass boundary. |

## Completion decision

Every Step 02 artifact must include:

```text
completion_decision:
  status:
  success_criteria_checked:
  evidence_artifacts:
  unresolved_gaps:
  next_step_allowed:
```

`complete` is allowed only when all mandatory criteria have durable evidence: Step 00/01 consumed, all-node coverage reconciled, dependency coverage reconciled, source workflow unmodified, asset/custom-node readiness current, boundary changes preserved, hardware budget measured or gated, interactive risk review completed (when risks existed), and `step03_context` present.

## Hard stops

- non-ComfyUI target that cannot be safely reframed as workflow migration
- strict source-identical delivery with unavailable or inaccessible critical assets
- strict full-fidelity target that exceeds measured hardware while all fallback/reduction/escalation options are rejected
- critical CUDA-only runtime with no fallback, patch, or feature-development path
- continuation would require bypassing, deleting, replacing, or semantically changing nodes without approval

## Output schema

```text
target
budget
fidelity
input_evidence
scan_coverage
dependency_coverage
asset_custom_node_readiness
estimated_peak_vram
initial_class
risks
human_intervention_needed
assumptions_to_verify
## Human decisions (if interactive review was conducted)
step03_context
toolization
completion_decision
next_step
```

Write the final report as `02-feasibility.md`.

Recommended reusable scaffold:

```text
python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step02_feasibility_scaffold.py --workspace <workspace> --probe-hardware
```

The scaffold is safe only for read-only Step 02 work. It may parse Step 00/01 artifacts, recount workflow nodes, generate all-node accounting, create a hardware probe artifact, and write report/manifest outputs. It must not provider-search, download, clone, install, call ComfyUI, convert prompts, or modify the source workflow.

## Step 03 context contract

`step03_context` must include:

- workflow path and hash;
- source node/link counts and whether counts were repaired from the workflow;
- output-node hints from Step 00/02;
- exact unresolved asset names and custom-node gaps;
- dependency coverage status;
- target hardware/fidelity assumptions;
- preliminary route and terminal state;
- human decisions already made or still required.

## Example from prior work

Dasiwa full-size video generation on a 24 GB-class single XPU stayed in the flow for smoke validation, but the full-size branch later became a capacity hard stop after runtime memory evidence and static reasoning agreed. The feasibility output should therefore say "capacity risk, branch-smoke first" rather than "XPU migration guaranteed".

Zimage clean Step 02 showed a different failure: Step 01 had five source-identical asset gaps, but the deterministic Step 02 scaffold listed no gaps because it only inspected Step 00 markers. The fix is to parse Step 01 ledgers directly and write a blocked/human-gated feasibility report rather than a fake normal route.

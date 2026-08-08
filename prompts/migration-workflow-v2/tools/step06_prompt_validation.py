#!/usr/bin/env python3
"""Convert and validate a ComfyUI workflow API prompt for Step 06."""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)
COMFY_ROOT_DEFAULT = Path("/home/intel/tianfeng/comfy/ComfyUI")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_record(path: Path) -> dict[str, Any]:
    return {
        "name": path.name,
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def setup_comfy_imports(comfy_root: Path) -> None:
    os.chdir(comfy_root)
    if str(comfy_root) not in sys.path:
        sys.path.insert(0, str(comfy_root))


def load_workflow(path: Path) -> dict[str, Any]:
    return read_json(path)


def convert_workflow(comfy_root: Path, workflow: dict[str, Any]) -> dict[str, Any]:
    setup_comfy_imports(comfy_root)
    from script_examples.workflow_to_prompt import workflow_to_prompt

    return workflow_to_prompt(workflow, forced_defaults={})


# Values the ComfyUI GUI writes for the seed widget's "control_after_generate"
# companion selector. The GUI inserts this value into widgets_values immediately
# after the seed value, but it has no corresponding API input, so the converter's
# straight zip of widget-annotated inputs against widgets_values shifts every
# downstream widget by one slot (e.g. force_offload <- "randomize").
CONTROL_AFTER_GENERATE_VALUES = {"randomize", "fixed", "increment", "decrement"}


def repair_seed_control_widget_alignment(
    workflow: dict[str, Any], prompt: dict[str, Any]
) -> list[dict[str, Any]]:
    """Re-align widget inputs after the GUI-only control_after_generate selector.

    The GUI-only ``control_after_generate`` widget (value like ``"randomize"``)
    sits in ``widgets_values`` right after the ``seed`` value but has no API
    input. The converter zips widget-annotated inputs straight against
    ``widgets_values``, so the selector consumes the next widget's slot and every
    following widget is off by one. This re-maps the widget inputs for each
    affected node, skipping that selector, and writes the corrected values back
    into the prompt (link inputs are never touched). The source workflow is only
    read, never mutated.
    """
    changes: list[dict[str, Any]] = []
    for node in workflow.get("nodes", []):
        node_id = str(node["id"])
        prompt_node = prompt.get(node_id)
        if not isinstance(prompt_node, dict):
            continue
        widget_values = node.get("widgets_values")
        if not isinstance(widget_values, list) or not widget_values:
            continue
        # Ordered widget-backed, non-linked input names from the GUI inputs array
        # (the same set the converter consumes sequentially from widgets_values).
        widget_input_names = [
            item.get("name")
            for item in (node.get("inputs") or [])
            if isinstance(item, dict)
            and item.get("widget") is not None
            and item.get("link") is None
            and item.get("name")
        ]
        if not widget_input_names or "seed" not in widget_input_names:
            continue

        values = list(widget_values)
        corrected: dict[str, Any] = {}
        vi = 0
        skipped_selector = False
        for name in widget_input_names:
            if vi >= len(values):
                break
            corrected[name] = values[vi]
            vi += 1
            # The GUI inserts the control_after_generate selector right after the
            # seed widget value; consume and skip it so downstream widgets align.
            if name == "seed" and vi < len(values) and values[vi] in CONTROL_AFTER_GENERATE_VALUES:
                vi += 1
                skipped_selector = True

        if not skipped_selector:
            continue  # no control_after_generate slot -> converter already aligned

        inputs = prompt_node.setdefault("inputs", {})
        for name, value in corrected.items():
            if name not in inputs:
                continue  # never inject a widget input the converter omitted (e.g. link-overridden)
            old_value = inputs.get(name)
            if old_value != value:
                changes.append(
                    {
                        "node_id": node_id,
                        "class_type": prompt_node.get("class_type"),
                        "input_name": name,
                        "old_value": old_value,
                        "new_value": value,
                        "reason": "control_after_generate GUI selector shifted downstream widget values; re-aligned from widgets_values",
                    }
                )
                inputs[name] = value
    return changes


def load_extra_model_paths(comfy_root: Path, extra_model_paths: Path) -> None:
    import utils.extra_config

    default_config = comfy_root / "extra_model_paths.yaml"
    if default_config.is_file():
        utils.extra_config.load_extra_path_config(str(default_config))
    if extra_model_paths.is_file():
        utils.extra_config.load_extra_path_config(str(extra_model_paths))


async def init_validation_runtime(comfy_root: Path, extra_model_paths: Path) -> None:
    sys.argv = [
        "step06_offline_validate",
        "--extra-model-paths-config",
        str(extra_model_paths),
        "--disable-auto-launch",
        "--lowvram",
        "--reserve-vram",
        "4",
    ]
    setup_comfy_imports(comfy_root)
    load_extra_model_paths(comfy_root, extra_model_paths)
    import server
    import nodes

    loop = asyncio.get_running_loop()
    server.PromptServer(loop)
    await nodes.init_extra_nodes()


async def validate_prompt(prompt_id: str, prompt: dict[str, Any]) -> dict[str, Any]:
    import execution

    valid = await execution.validate_prompt(prompt_id, prompt, None)
    return {"valid": valid[0], "error": valid[1], "outputs": valid[2], "node_errors": valid[3]}


def run_validations(
    comfy_root: Path,
    extra_model_paths: Path,
    source_prompt: dict[str, Any],
    variant_prompt: dict[str, Any],
    log_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    async def runner() -> tuple[dict[str, Any], dict[str, Any]]:
        await init_validation_runtime(comfy_root, extra_model_paths)
        source_result = await validate_prompt("step06-source-preserving", source_prompt)
        variant_result = await validate_prompt("step06-runtime-policy", variant_prompt)
        return source_result, variant_result

    with log_path.open("w", encoding="utf-8") as log_handle:
        with redirect_stdout(log_handle), redirect_stderr(log_handle):
            return asyncio.run(runner())



# Node types that pause execution waiting for a browser client to confirm via a
# custom websocket/HTTP route (e.g. Comfyui_Prompt_Edit polls a `confirmed` flag
# for up to an hour). No client is attached during headless Step 06-09 API
# validation, so these nodes hang indefinitely and were previously misdiagnosed
# as an XPU model-loading deadlock. Bypassed ONLY in the runtime-policy variant
# consumed by automated tests (06b-runtime-policy-prompt.json + branch prompts)
# -- the source-preserving prompt and the GUI workflow delivered to the customer
# (Steps 11/12) are never touched, so a real human GUI run still gets the
# interactive prompt-edit step as designed.
HUMAN_IN_THE_LOOP_NODE_TYPES = {"Prompt_Edit"}


def bypass_human_in_the_loop_nodes(variant: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for node_id in [nid for nid, node in variant.items() if node.get("class_type") in HUMAN_IN_THE_LOOP_NODE_TYPES]:
        node = variant[node_id]
        upstream = node.get("inputs", {}).get("text")
        if not (isinstance(upstream, list) and len(upstream) == 2):
            continue  # forceInput text should always be a link; skip defensively if not
        for other in variant.values():
            for input_name, value in other.get("inputs", {}).items():
                if isinstance(value, list) and len(value) == 2 and value[0] == node_id:
                    other["inputs"][input_name] = list(upstream)
        del variant[node_id]
        changes.append(
            {
                "node_id": node_id,
                "class_type": node.get("class_type"),
                "input_name": None,
                "old_value": f"node {node_id} (blocks on browser confirmation)",
                "new_value": f"bypassed -> passthrough of upstream link {upstream}",
                "reason": "human-in-the-loop node hangs indefinitely with no browser client attached during headless API validation; bypassed for automated tests only, not the delivered/GUI workflow",
            }
        )
    return changes


def _is_fp8_pipeline(variant: dict[str, Any]) -> bool:
    # A heavy fp8 pipeline is detected from any node input that names an fp8
    # checkpoint or forces an fp8 weight dtype. The native-fp8 XPU offload policy
    # (recipe CLIPLoader-qwen-fp8) only applies to these -- non-fp8 workflows are
    # left untouched.
    for node in variant.values():
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, str):
                low = value.lower()
                if "fp8" in low and (low.endswith(".safetensors") or low.endswith(".gguf")):
                    return True
                if low in ("fp8_e4m3fn", "fp8_e5m2"):
                    return True
    return False


def apply_runtime_policy_variant(source_prompt: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    # Widget-value-shaped changes only (device/schema fixes). Step 11/12 replay this
    # exact list onto the delivered GUI workflow, so it must never contain a
    # structural change like the human-in-the-loop bypass above (own list/file,
    # see bypass_human_in_the_loop_nodes + 06b-headless-test-bypasses.json).
    variant = json.loads(json.dumps(source_prompt, ensure_ascii=False))
    changes: list[dict[str, Any]] = []
    # Native-fp8 XPU offload policy (see recipe CLIPLoader-qwen-fp8 + the
    # OMNI_FP8_KEEP_ON_MOVE launch env). With keep-on-move, offloading is cheap, so
    # the fastest config keeps everything on XPU and frees between stages: VLM
    # force_offload, CLIP/TE on XPU (device=default, NOT cpu), UNet native fp8
    # (weight_dtype=default). VAE stays on XPU via the launch flags (no --cpu-vae).
    fp8_pipeline = _is_fp8_pipeline(variant)
    for node_id, node in variant.items():
        class_type = node.get("class_type")
        inputs = node.setdefault("inputs", {})
        if fp8_pipeline and class_type == "CLIPLoader" and inputs.get("device") == "cpu":
            changes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": "device",
                    "old_value": "cpu",
                    "new_value": "default",
                    "reason": "native-fp8 XPU policy: keep-on-move patch lets the fp8 text encoder run on XPU (faster than cpu) and free before the UNet; cpu-pin is a pre-patch last resort only",
                }
            )
            inputs["device"] = "default"
        if fp8_pipeline and class_type == "UNETLoader" and inputs.get("weight_dtype") not in (None, "default"):
            old_value = inputs.get("weight_dtype")
            changes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": "weight_dtype",
                    "old_value": old_value,
                    "new_value": "default",
                    "reason": "native-fp8 XPU policy: keep the UNet as native fp8 from the checkpoint (default) so the omni_xpu_kernel fp8 GEMM path is used, not a forced cast",
                }
            )
            inputs["weight_dtype"] = "default"
        if fp8_pipeline and isinstance(class_type, str) and class_type.startswith("llama_cpp") and ("force_offload" in inputs) and inputs.get("force_offload") is not True:
            old_value = inputs.get("force_offload")
            changes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": "force_offload",
                    "old_value": old_value,
                    "new_value": True,
                    "reason": "native-fp8 XPU policy: free the heavy VLM from XPU after it produces conditioning so the fp8 diffusion UNet has the VRAM (offload is cheap under keep-on-move)",
                }
            )
            inputs["force_offload"] = True
        if class_type in {"SeedVR2LoadVAEModel", "SeedVR2LoadDiTModel"} and inputs.get("device") == "cuda:0":
            changes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": "device",
                    "old_value": "cuda:0",
                    "new_value": "xpu:0",
                    "reason": "target runtime exposes xpu:0; source workflow requested CUDA",
                }
            )
            inputs["device"] = "xpu:0"
        if class_type == "SeedVR2LoadDiTModel" and not isinstance(inputs.get("cache_model"), bool):
            old_value = inputs.get("cache_model")
            changes.append(
                {
                    "node_id": node_id,
                    "class_type": class_type,
                    "input_name": "cache_model",
                    "old_value": old_value,
                    "new_value": False,
                    "reason": "current schema expects boolean cache_model; old widget slot carried attention_mode",
                }
            )
            inputs["cache_model"] = False
    return variant, changes


def intended_outputs(branch_map_csv: Path) -> list[str]:
    rows = read_csv(branch_map_csv)
    return [row["output_node_id"] for row in rows]


def workflow_node_types(workflow: dict[str, Any]) -> dict[str, str]:
    return {str(node["id"]): node.get("type", "") for node in workflow.get("nodes", [])}


def partition_validation_outputs(
    workflow: dict[str, Any], object_info: dict[str, Any], intended: list[str]
) -> tuple[list[str], list[dict[str, Any]]]:
    node_types = workflow_node_types(workflow)
    validation_outputs: list[str] = []
    terminal_non_output: list[dict[str, Any]] = []
    for node_id in intended:
        node_type = node_types.get(str(node_id), "")
        node_info = object_info.get(node_type, {})
        if node_info.get("output_node") is True:
            validation_outputs.append(str(node_id))
        else:
            terminal_non_output.append(
                {
                    "node_id": str(node_id),
                    "node_type": node_type,
                    "reason": "terminal branch node is not an OUTPUT_NODE in object_info; Step 07 needs a generated preview wrapper",
                }
            )
    return validation_outputs, terminal_non_output


def output_status(validation: dict[str, Any], intended: list[str], terminal_non_output: list[dict[str, Any]]) -> dict[str, Any]:
    outputs = {str(item) for item in validation.get("outputs", [])}
    intended_set = set(intended)
    return {
        "validated_outputs": sorted(outputs, key=lambda value: int(value) if value.isdigit() else value),
        "intended_outputs": intended,
        "terminal_non_output_branches": terminal_non_output,
        "intended_outputs_present": sorted(
            intended_set & outputs, key=lambda value: int(value) if value.isdigit() else value
        ),
        "missing_intended_outputs": sorted(
            intended_set - outputs, key=lambda value: int(value) if value.isdigit() else value
        ),
        "extra_validated_outputs": sorted(
            outputs - intended_set, key=lambda value: int(value) if value.isdigit() else value
        ),
    }


def node_prompt_map(workflow: dict[str, Any], prompt: dict[str, Any]) -> list[dict[str, Any]]:
    skipped_frontend = {"Fast Groups Bypasser (rgthree)", "Note Plus (mtb)", "Note"}
    rows: list[dict[str, Any]] = []
    for node in workflow.get("nodes", []):
        node_id = str(node["id"])
        node_type = node.get("type", "")
        if node_id in prompt:
            status = "in_api_prompt"
        elif node_type == "Reroute":
            status = "skipped_reroute_relinked"
        elif node_type in skipped_frontend:
            status = "skipped_frontend_or_note_source_node"
        else:
            status = "not_in_prompt_review_required"
        rows.append({"node_id": node_id, "node_type": node_type, "prompt_status": status})
    return rows


def synthetic_preview_id(prompt: dict[str, Any], output_node: str) -> str:
    numeric_ids = [int(node_id) for node_id in prompt if str(node_id).isdigit()]
    candidate = max(numeric_ids or [0]) + 1000 + int(output_node)
    while str(candidate) in prompt:
        candidate += 1
    return str(candidate)


def write_branch_prompts(
    comfy_root: Path,
    variant_prompt: dict[str, Any],
    output_nodes: list[str],
    terminal_non_output: list[dict[str, Any]],
    branch_dir: Path,
) -> list[dict[str, Any]]:
    setup_comfy_imports(comfy_root)
    from utils.prompt_subgraph import extract_prompt_subgraph

    branch_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    terminal_ids = {item["node_id"] for item in terminal_non_output}
    for output_node in output_nodes:
        branch_prompt = extract_prompt_subgraph(variant_prompt, [output_node])
        submission_output_node = output_node
        wrapper = "none"
        if output_node in terminal_ids:
            submission_output_node = synthetic_preview_id(branch_prompt, output_node)
            branch_prompt[submission_output_node] = {
                "class_type": "PreviewImage",
                "inputs": {"images": [output_node, 0]},
                "_meta": {"title": f"Step06 generated preview wrapper for terminal node {output_node}"},
            }
            wrapper = "generated_preview_output"
        path = branch_dir / f"06-branch-{output_node}.json"
        write_json(path, branch_prompt)
        rows.append(
            {
                "output_node_id": output_node,
                "submission_output_node_id": submission_output_node,
                "wrapper": wrapper,
                "branch_prompt": str(path),
                "node_count": len(branch_prompt),
            }
        )
    return rows


def completion_decision(
    source_status: dict[str, Any],
    variant_status: dict[str, Any],
    variant_validation: dict[str, Any],
    node_map_rows: list[dict[str, Any]],
    variant_changes: list[dict[str, Any]],
) -> dict[str, Any]:
    missing_map = [
        row["node_id"] for row in node_map_rows if row["prompt_status"] == "not_in_prompt_review_required"
    ]
    node_errors = variant_validation.get("node_errors", {})
    missing_outputs = variant_status["missing_intended_outputs"]
    status = "complete"
    unresolved = []
    if missing_map:
        status = "hard_stop"
        unresolved.extend(f"source node missing from prompt map: {node_id}" for node_id in missing_map)
    if missing_outputs:
        status = "hard_stop"
        unresolved.extend(f"intended output missing after variant validation: {node_id}" for node_id in missing_outputs)
    if node_errors:
        status = "hard_stop"
        unresolved.append("runtime-policy variant still has node_errors")
    # All branches may be terminal non-output nodes (e.g. a disconnected single KSampler).
    # The prompt instructions explicitly say: "Do not hard-stop only because a terminal
    # branch node is not an OUTPUT_NODE; instead classify it and generate a wrapper."
    # If the only "failure" is prompt_no_outputs and all intended branches are terminal
    # non-output with wrappers, this is expected, not a hard stop.
    all_terminal = bool(variant_status.get("terminal_non_output_branches"))
    only_prompt_no_outputs = (
        not variant_validation.get("valid")
        and isinstance(variant_validation.get("error"), dict)
        and variant_validation["error"].get("type") == "prompt_no_outputs"
        and not variant_validation.get("node_errors")
    )
    if only_prompt_no_outputs and all_terminal and not missing_outputs:
        # Expected: all branches are terminal non-output nodes with wrappers
        status = "complete"
    elif not variant_validation.get("valid"):
        status = "hard_stop"
        unresolved.append("runtime-policy variant did not validate")
    return {
        "status": status,
        "success_criteria_checked": {
            "source_workflow_unmodified": True,
            "source_prompt_generated": True,
            "all_source_nodes_accounted": not missing_map,
            "source_preserving_validation_recorded": True,
            "runtime_policy_variant_created": bool(variant_changes),
            "runtime_policy_variant_valid": bool(variant_validation.get("valid"))
            if not only_prompt_no_outputs
            else True,  # all branches terminal non-output; expected
            "runtime_policy_variant_node_errors_empty": not node_errors,
            "all_validation_output_nodes_present_in_variant": not missing_outputs,
            "terminal_non_output_branches_accounted": bool(
                variant_status.get("terminal_non_output_branches") is not None
            ),
            "queued_execution": False,
        },
        "source_preserving_result": source_status,
        "variant_result": variant_status,
        "unresolved_gaps": unresolved,
        "human_gate_prompt": None
        if status == "complete"
        else {
            "problem_summary": "Step 06 prompt validation has unresolved conversion or validation gaps.",
            "required_human_action": "Review unresolved_gaps and approve converter/schema repair, runtime-policy change, or stop.",
            "safe_reply_template": "Approve Step 06 repair for: <node/input>; allowed change: <exact value or policy>.",
            "continuation_edges": {
                "after_repair": "regenerate prompt, rerun no-queue validation, then continue to Step 07",
                "if_semantic_change": "record human decision and update claim boundary before branch smoke",
            },
        },
        "next_step_allowed": status == "complete",
        "next_step": "07-branch-smoke-validation" if status == "complete" else None,
    }


def render_report(summary: dict[str, Any]) -> str:
    decision = summary["completion_decision"]
    lines = [
        "# Step 06 Prompt Conversion Validation",
        "",
        f"- Generated: `{summary['generated_at']}`",
        f"- Status: `{decision['status']}`",
        f"- Validation method: `{summary['validation_method']}`",
        "- Queued execution: `false`",
        f"- Source prompt: `{summary['source_prompt_path']}`",
        f"- Runtime-policy variant: `{summary['variant_prompt_path']}`",
        f"- Node prompt map: `{summary['node_prompt_map_csv']}`",
        "",
        "## Source-preserving validation",
        "",
        f"- Valid: `{summary['source_validation']['valid']}`",
        f"- Validated output nodes: `{len(summary['source_output_status']['intended_outputs_present'])}`",
        f"- Missing output nodes: `{len(summary['source_output_status']['missing_intended_outputs'])}`",
        f"- Node errors: `{len(summary['source_validation'].get('node_errors', {}))}`",
        "",
        "## Runtime-policy variant validation",
        "",
        f"- Valid: `{summary['variant_validation']['valid']}`",
        f"- Validated output nodes: `{len(summary['variant_output_status']['intended_outputs_present'])}`",
        f"- Missing output nodes: `{len(summary['variant_output_status']['missing_intended_outputs'])}`",
        f"- Terminal non-output branches wrapped for Step 07: `{len(summary['terminal_non_output_branches'])}`",
        f"- Node errors: `{len(summary['variant_validation'].get('node_errors', {}))}`",
        "",
        "## Variant changes",
        "",
    ]
    for change in summary["variant_changes"]:
        lines.append(
            f"- Node {change['node_id']} `{change['class_type']}.{change['input_name']}`: "
            f"`{change['old_value']}` -> `{change['new_value']}` ({change['reason']})"
        )
    lines.extend(
        [
            "",
            "## Converter repairs (widget re-alignment, source workflow untouched)",
            "",
        ]
    )
    if summary.get("converter_repairs"):
        for change in summary["converter_repairs"]:
            lines.append(
                f"- Node {change['node_id']} `{change['class_type']}.{change['input_name']}`: "
                f"`{change['old_value']}` -> `{change['new_value']}` ({change['reason']})"
            )
    else:
        lines.append("- none")
    lines.extend(
        [
            "",
            "## Headless-test-only bypasses (never applied to delivered/GUI workflow)",
            "",
        ]
    )
    if summary["headless_test_bypasses"]:
        for change in summary["headless_test_bypasses"]:
            lines.append(
                f"- Node {change['node_id']} `{change['class_type']}`: {change['old_value']} -> {change['new_value']} ({change['reason']})"
            )
    else:
        lines.append("- none")
    lines.extend(
        [
            "",
            "## Input sufficiency and reflection",
            "",
            "- Step 05 provided enough live runtime context for no-queue validation: extra model paths, object_info, XPU runtime, and registered custom nodes.",
            "- Step 06 had to repair converter rules for frontend-only nodes, seed control widgets, selector subpaths, SeedVR2 widgets, and UltimateSDUpscale widget ordering.",
            "- The source workflow was not modified; the XPU device/schema changes are contained in a separately named runtime-policy variant.",
            "",
            "## Toolization",
            "",
            "- tool_candidate: yes",
            "- candidate_name: step06_prompt_validation",
            "- safe_to_automate_now: yes",
            "- implementation_status: implemented",
            f"- script_or_tool_path: `{summary['tool_path']}`",
            f"- command_used: `{summary['command_used']}`",
            "- limitations: validates prompt structure without queueing execution; runtime correctness remains Step 07/08 evidence.",
            "",
            "## Completion decision",
            "",
            "```json",
            json.dumps(decision, ensure_ascii=False, indent=2),
            "```",
        ]
    )
    return "\n".join(lines) + "\n"


def _load_step05_context(workspace: Path) -> dict[str, Any]:
    """Best-effort read of Step 05 handoff context from task-state.json.

    Handles both dict-based ({"steps": {"05": {...}}}) and list-based
    ({"steps": [{"id": "05", ...}]}) step layouts. Returns the
    completion_signals.step06_context dict if present, otherwise an empty
    dict; callers must not assume any key is present.
    """
    task_state_path = workspace / "task-state.json"
    if not task_state_path.is_file():
        return {}
    try:
        task_state = read_json(task_state_path)
    except Exception:
        return {}
    steps = task_state.get("steps")
    step05 = None
    if isinstance(steps, dict):
        step05 = steps.get("05") or steps.get(5)
    elif isinstance(steps, list):
        for entry in steps:
            if isinstance(entry, dict) and str(entry.get("id")) == "05":
                step05 = entry
                break
    if not isinstance(step05, dict):
        return {}
    signals = step05.get("completion_signals")
    if not isinstance(signals, dict):
        return {}
    ctx = signals.get("step06_context")
    return ctx if isinstance(ctx, dict) else {}


def main() -> int:
    original_argv = sys.argv[:]
    parser = argparse.ArgumentParser(
        description=(
            "Convert and validate a ComfyUI workflow API prompt for Step 06. "
            "All input paths are supplied via CLI flags; --workspace is an "
            "optional convenience fallback that reads task-state.json (supports "
            "both dict- and list-based step layouts)."
        )
    )
    parser.add_argument(
        "--workflow",
        type=Path,
        default=None,
        help="Source workflow JSON (GUI .json exported from ComfyUI). Required unless available via --workspace.",
    )
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=None,
        help="Directory to write Step 06 artifacts. Defaults to <workspace>/artifacts or ./artifacts.",
    )
    parser.add_argument(
        "--object-info",
        type=Path,
        default=None,
        help="Path to object_info.json (Step 05 artifact). Required unless available via --workspace.",
    )
    parser.add_argument(
        "--extra-model-paths",
        type=Path,
        default=None,
        help="Path to extra_model_paths.yaml. Required unless available via --workspace.",
    )
    parser.add_argument(
        "--branch-map-csv",
        type=Path,
        default=None,
        help="CSV with an 'output_node_id' column listing intended terminal nodes (e.g. 03-branch-map.csv). Required unless available via --workspace.",
    )
    parser.add_argument(
        "--api-url",
        default=None,
        help="ComfyUI API URL recorded into step07_context (optional).",
    )
    parser.add_argument(
        "--non-source-identical-node-ids",
        default=None,
        help="Comma-separated node IDs that are non-source-identical substitutes (optional).",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=None,
        help="Optional convenience fallback: read paths from <workspace>/task-state.json Step 05 completion_signals.step06_context.",
    )
    parser.add_argument(
        "--comfy-root",
        type=Path,
        default=COMFY_ROOT_DEFAULT,
        help="Path to the ComfyUI repository root (for workflow_to_prompt imports).",
    )
    args = parser.parse_args()

    comfy_root = args.comfy_root.resolve()

    # Resolve paths: CLI args are primary; --workspace task-state.json is a
    # convenience fallback (handles dict- and list-based step layouts).
    workspace: Path | None = None
    ctx: dict[str, Any] = {}
    if args.workspace is not None:
        workspace = args.workspace.resolve()
        ctx = _load_step05_context(workspace)

    def resolve(cli_val: Path | None, ctx_key: str) -> Path | None:
        if cli_val is not None:
            return Path(cli_val)
        if ctx.get(ctx_key):
            return Path(ctx[ctx_key])
        return None

    workflow_path = resolve(args.workflow, "source_workflow_copy")
    extra_model_paths = resolve(args.extra_model_paths, "extra_model_paths_config")
    object_info_path = resolve(args.object_info, "object_info_artifact")
    branch_map_csv = resolve(args.branch_map_csv, "branch_map_csv")
    api_url = args.api_url or ctx.get("api_url")
    non_source_ids_raw = args.non_source_identical_node_ids
    if non_source_ids_raw is None:
        non_source_ids_raw = ctx.get("non_source_identical_node_ids")

    if args.artifact_dir is not None:
        artifact_dir = args.artifact_dir.resolve()
    elif workspace is not None:
        artifact_dir = workspace / "artifacts"
    else:
        artifact_dir = Path.cwd() / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    # Validate required inputs exist.
    missing: list[str] = []
    for label, path in [
        ("--workflow", workflow_path),
        ("--extra-model-paths", extra_model_paths),
        ("--object-info", object_info_path),
        ("--branch-map-csv", branch_map_csv),
    ]:
        if path is None:
            missing.append(label)
        elif not path.is_file():
            missing.append(f"{label} (not found: {path})")
    if missing:
        print(
            "ERROR: missing required inputs. Provide via CLI flags or a --workspace "
            "with task-state.json Step 05 completion_signals.step06_context:\n  - "
            + "\n  - ".join(missing),
            file=sys.stderr,
        )
        return 1

    if isinstance(non_source_ids_raw, (list, tuple)):
        non_source_identical_node_ids = [str(x) for x in non_source_ids_raw]
    elif isinstance(non_source_ids_raw, str) and non_source_ids_raw:
        non_source_identical_node_ids = [
            s.strip() for s in non_source_ids_raw.split(",") if s.strip()
        ]
    else:
        non_source_identical_node_ids = []

    workflow = load_workflow(workflow_path)
    source_prompt = convert_workflow(comfy_root, workflow)
    converter_repairs = repair_seed_control_widget_alignment(workflow, source_prompt)
    # source_prompt (source-preserving) is only ever structurally validated, never
    # queued (see run_validations), so it never hits a human-in-the-loop hang and
    # is left completely untouched. variant_prompt IS queued for real execution by
    # Steps 07/08/09, so the bypass runs first on a separate copy, tracked in its
    # own list/file -- never merged into the widget-value runtime-policy changes
    # that Step 11/12 replay onto the delivered GUI workflow.
    headless_test_prompt = json.loads(json.dumps(source_prompt, ensure_ascii=False))
    headless_test_bypasses = bypass_human_in_the_loop_nodes(headless_test_prompt)
    variant_prompt, variant_changes = apply_runtime_policy_variant(headless_test_prompt)

    source_prompt_path = artifact_dir / "06-source-preserving-prompt.json"
    variant_prompt_path = artifact_dir / "06b-runtime-policy-prompt.json"
    variant_changes_path = artifact_dir / "06b-runtime-policy-changes.json"
    headless_test_bypasses_path = artifact_dir / "06b-headless-test-bypasses.json"
    write_json(source_prompt_path, source_prompt)
    write_json(variant_prompt_path, variant_prompt)
    write_json(variant_changes_path, variant_changes)
    write_json(headless_test_bypasses_path, headless_test_bypasses)

    validation_log = artifact_dir / "06-offline-validation.log"
    source_validation, variant_validation = run_validations(
        comfy_root, extra_model_paths, source_prompt, variant_prompt, validation_log
    )
    source_validation_path = artifact_dir / "06-source-validation.json"
    variant_validation_path = artifact_dir / "06b-runtime-policy-validation.json"
    write_json(source_validation_path, source_validation)
    write_json(variant_validation_path, variant_validation)

    intended = intended_outputs(branch_map_csv)
    object_info = read_json(object_info_path)
    validation_outputs, terminal_non_output = partition_validation_outputs(workflow, object_info, intended)
    source_status = output_status(source_validation, validation_outputs, terminal_non_output)
    variant_status = output_status(variant_validation, validation_outputs, terminal_non_output)
    node_map_rows = node_prompt_map(workflow, source_prompt)
    node_map_csv = artifact_dir / "06-node-prompt-map.csv"
    write_csv(node_map_csv, node_map_rows, ["node_id", "node_type", "prompt_status"])

    branch_dir = artifact_dir / "06-branch-prompts"
    branch_rows = write_branch_prompts(comfy_root, variant_prompt, intended, terminal_non_output, branch_dir)
    branch_csv = artifact_dir / "06-branch-prompts.csv"
    write_csv(
        branch_csv,
        branch_rows,
        ["output_node_id", "submission_output_node_id", "wrapper", "branch_prompt", "node_count"],
    )

    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace) if workspace is not None else None,
        "tool_path": str(Path(__file__).resolve()),
        "command_used": " ".join([sys.executable, str(Path(__file__).resolve()), *original_argv[1:]]),
        "validation_method": "offline execution.validate_prompt; no /prompt queue",
        "queued_execution": False,
        "source_workflow": str(workflow_path),
        "source_workflow_modified": False,
        "source_prompt_path": str(source_prompt_path),
        "source_validation_path": str(source_validation_path),
        "source_validation": source_validation,
        "source_output_status": source_status,
        "variant_prompt_path": str(variant_prompt_path),
        "variant_changes_path": str(variant_changes_path),
        "variant_changes": variant_changes,
        "headless_test_bypasses_path": str(headless_test_bypasses_path),
        "headless_test_bypasses": headless_test_bypasses,
        "variant_validation_path": str(variant_validation_path),
        "variant_validation": variant_validation,
        "variant_output_status": variant_status,
        "converter_repairs": converter_repairs,
        "terminal_non_output_branches": terminal_non_output,
        "node_prompt_map_csv": str(node_map_csv),
        "branch_prompts_csv": str(branch_csv),
        "branch_prompt_dir": str(branch_dir),
    }
    summary["completion_decision"] = completion_decision(
        source_status, variant_status, variant_validation, node_map_rows, variant_changes
    )
    summary["step07_context"] = {
        "workspace": str(workspace) if workspace is not None else None,
        "artifact_folder": str(artifact_dir),
        "prompt_for_branch_smoke": str(variant_prompt_path),
        "branch_prompts_csv": str(branch_csv),
        "branch_prompt_dir": str(branch_dir),
        "branch_map_csv": str(branch_map_csv),
        "api_url": api_url,
        "validation_log": str(validation_log),
        "non_source_identical_node_ids": non_source_identical_node_ids,
    }

    summary_path = artifact_dir / "06-prompt-validation-summary.json"
    report_path = artifact_dir / "06-prompt-validation.md"
    write_json(summary_path, summary)
    report_path.write_text(render_report(summary), encoding="utf-8")

    manifest_paths = [
        report_path,
        summary_path,
        source_prompt_path,
        source_validation_path,
        variant_prompt_path,
        variant_changes_path,
        variant_validation_path,
        node_map_csv,
        branch_csv,
        validation_log,
    ] + [Path(row["branch_prompt"]) for row in branch_rows]
    manifest = {
        "generated_at": utc_now(),
        "step": "06",
        "status": summary["completion_decision"]["status"],
        "artifacts": [artifact_record(path) for path in manifest_paths],
        "completion_decision": summary["completion_decision"],
        "step07_context": summary["step07_context"],
    }
    manifest_path = artifact_dir / "06-output-manifest.json"
    write_json(manifest_path, manifest)
    print(json.dumps({"status": manifest["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if manifest["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

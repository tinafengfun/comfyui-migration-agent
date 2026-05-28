#!/usr/bin/env python3
"""Run Step 08 full-path validation with capacity telemetry."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step07_branch_smoke import (
    artifact_record,
    fetch_json,
    output_file_path,
    post_json,
    read_csv,
    read_json,
    sha256_file,
    summarize_history,
    wait_history,
    write_json,
)


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)
COMFY_ROOT_DEFAULT = Path("/home/intel/tianfeng/comfy/ComfyUI")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_input(
    prompt: dict[str, Any],
    changes: list[dict[str, Any]],
    node_id: str,
    input_name: str,
    new_value: Any,
    reason: str,
) -> None:
    node = prompt.get(node_id)
    if not node:
        return
    inputs = node.setdefault("inputs", {})
    if input_name not in inputs or inputs[input_name] == new_value:
        return
    old_value = inputs[input_name]
    inputs[input_name] = new_value
    changes.append(
        {
            "node_id": node_id,
            "class_type": node.get("class_type"),
            "input_name": input_name,
            "old_value": old_value,
            "new_value": new_value,
            "reason": reason,
        }
    )


def apply_reduced_full_path_settings(
    prompt: dict[str, Any], output_prefix: str, seed: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    prompt = json.loads(json.dumps(prompt, ensure_ascii=False))
    changes: list[dict[str, Any]] = []

    for node_id, node in prompt.items():
        class_type = node.get("class_type")
        inputs = node.setdefault("inputs", {})
        if class_type == "KSampler":
            set_input(prompt, changes, node_id, "steps", 1, "Step 08 reduced full-path limits sampler cost")
            set_input(prompt, changes, node_id, "seed", seed, "Step 08 reduced full-path uses fixed seed")
        elif class_type == "KSamplerAdvanced":
            if isinstance(inputs.get("noise_seed"), list):
                set_input(
                    prompt,
                    changes,
                    str(inputs["noise_seed"][0]),
                    "seed",
                    seed,
                    "Step 08 reduced full-path fixes linked seed node without bypassing it",
                )
            else:
                set_input(
                    prompt,
                    changes,
                    node_id,
                    "noise_seed",
                    seed,
                    "Step 08 reduced full-path uses fixed seed",
                )
            set_input(prompt, changes, node_id, "steps", 4, "Step 08 reduced full-path limits sampler cost")
            if inputs.get("add_noise") == "enable":
                set_input(
                    prompt,
                    changes,
                    node_id,
                    "end_at_step",
                    1,
                    "Step 08 reduced full-path preserves first-stage split with fewer steps",
                )
            if inputs.get("add_noise") == "disable":
                set_input(
                    prompt,
                    changes,
                    node_id,
                    "start_at_step",
                    1,
                    "Step 08 reduced full-path preserves second-stage split with fewer steps",
                )
        elif class_type == "UltimateSDUpscale":
            set_input(prompt, changes, node_id, "steps", 1, "Step 08 reduced full-path limits tile cost")
            set_input(prompt, changes, node_id, "batch_size", 1, "Step 08 reduced full-path keeps tile batch minimal")
        elif class_type == "TTResolutionSelector":
            set_input(
                prompt,
                changes,
                node_id,
                "use_custom_resolution",
                False,
                "Step 08 reduced full-path uses smaller preset resolution",
            )
            set_input(
                prompt,
                changes,
                node_id,
                "resolution",
                "512x512 (1:1) (方形)",
                "Step 08 reduced full-path reduces latent resolution",
            )
        elif class_type == "ImageScaleToTotalPixels":
            set_input(prompt, changes, node_id, "megapixels", 0.1, "Step 08 reduced full-path limits SeedVR2 input")
        elif class_type == "ImageScaleBy":
            set_input(prompt, changes, node_id, "scale_by", 1.0, "Step 08 reduced full-path avoids pre-upscale cost")
        elif class_type == "SeedVR2VideoUpscaler":
            set_input(prompt, changes, node_id, "seed", seed, "Step 08 reduced full-path uses fixed seed")
            set_input(prompt, changes, node_id, "resolution", 512, "Step 08 reduced full-path caps SeedVR2 output")
            set_input(prompt, changes, node_id, "max_resolution", 512, "Step 08 reduced full-path caps SeedVR2 output")
            set_input(prompt, changes, node_id, "batch_size", 1, "Step 08 reduced full-path keeps SeedVR2 batch minimal")
        elif class_type == "Seed (rgthree)":
            set_input(
                prompt,
                changes,
                node_id,
                "seed",
                seed,
                "Step 08 reduced full-path fixes seed node without bypassing it",
            )

    for node_id, node in prompt.items():
        if node.get("class_type") in {"SaveImage", "PreviewImage"}:
            set_input(
                prompt,
                changes,
                node_id,
                "filename_prefix",
                output_prefix,
                "Step 08 reduced full-path isolates generated outputs",
            )
    return prompt, changes


def metric_map(sample: dict[str, Any]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for item in sample.get("device_level", []):
        metric_type = item.get("metrics_type")
        value = item.get("value")
        if metric_type and isinstance(value, (int, float)):
            metrics[metric_type] = float(value)
    return metrics


def collect_xpu_sample() -> dict[str, Any]:
    timestamp = utc_now()
    try:
        proc = subprocess.run(
            ["xpu-smi", "stats", "-d", "0", "-j"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"timestamp": timestamp, "ok": False, "error": str(exc)}
    sample: dict[str, Any] = {
        "timestamp": timestamp,
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stderr": proc.stderr,
    }
    if proc.returncode != 0:
        sample["raw_stdout"] = proc.stdout
        return sample
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        sample["ok"] = False
        sample["error"] = f"json_decode_error: {exc}"
        sample["raw_stdout"] = proc.stdout[:2000]
        return sample
    sample["raw"] = parsed
    metrics = metric_map(parsed)
    sample["memory_used_mib"] = metrics.get("XPUM_STATS_MEMORY_USED")
    sample["memory_utilization_percent"] = metrics.get("XPUM_STATS_MEMORY_UTILIZATION")
    sample["gpu_utilization_percent"] = metrics.get("XPUM_STATS_GPU_UTILIZATION")
    sample["power_watts"] = metrics.get("XPUM_STATS_POWER")
    sample["temperature_c"] = metrics.get("XPUM_STATS_GPU_CORE_TEMPERATURE")
    return sample


class TelemetryPoller:
    def __init__(self, interval_seconds: float) -> None:
        self.interval_seconds = interval_seconds
        self.samples: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval_seconds + 10)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.samples.append(collect_xpu_sample())
            self._stop.wait(self.interval_seconds)


def telemetry_summary(samples: list[dict[str, Any]], usable_budget_bytes: int | None) -> dict[str, Any]:
    valid = [sample for sample in samples if sample.get("ok")]
    memory_values = [
        float(sample["memory_used_mib"])
        for sample in valid
        if isinstance(sample.get("memory_used_mib"), (int, float))
    ]
    peak_mib = max(memory_values) if memory_values else None
    peak_bytes = int(peak_mib * 1024 * 1024) if peak_mib is not None else None
    return {
        "samples_total": len(samples),
        "valid_samples": len(valid),
        "peak_memory_used_mib": peak_mib,
        "peak_memory_used_bytes": peak_bytes,
        "peak_memory_budget_ratio": round(peak_bytes / usable_budget_bytes, 4)
        if peak_bytes is not None and usable_budget_bytes
        else None,
        "peak_gpu_utilization_percent": max(
            [
                float(sample["gpu_utilization_percent"])
                for sample in valid
                if isinstance(sample.get("gpu_utilization_percent"), (int, float))
            ],
            default=None,
        ),
    }


def write_telemetry_csv(path: Path, samples: list[dict[str, Any]]) -> None:
    fieldnames = [
        "timestamp",
        "ok",
        "memory_used_mib",
        "memory_utilization_percent",
        "gpu_utilization_percent",
        "power_watts",
        "temperature_c",
        "error",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for sample in samples:
            writer.writerow({field: sample.get(field) for field in fieldnames})


def staged_asset_analysis(asset_csv: Path, usable_budget_bytes: int | None) -> dict[str, Any]:
    rows = read_csv(asset_csv)
    asset_rows = [row for row in rows if row.get("requested_name")]
    total = sum(int(row.get("size_bytes") or 0) for row in asset_rows)
    heaviest = sorted(asset_rows, key=lambda row: int(row.get("size_bytes") or 0), reverse=True)[:5]
    return {
        "assets_total": len(asset_rows),
        "total_staged_asset_size_bytes": total,
        "total_staged_asset_size_gib": round(total / (1024**3), 2),
        "file_sum_to_usable_budget_ratio": round(total / usable_budget_bytes, 4)
        if usable_budget_bytes
        else None,
        "heaviest_assets": [
            {
                "requested_name": row.get("requested_name"),
                "source_node_ids": row.get("node_dependency_scan"),
                "state": row.get("state"),
                "size_bytes": int(row.get("size_bytes") or 0),
                "size_gib": round(int(row.get("size_bytes") or 0) / (1024**3), 2),
            }
            for row in heaviest
        ],
        "interpretation": (
            "Staged model-file sum is a conservative warning only; Step 08 capacity uses runtime telemetry "
            "because ComfyUI lowvram/offload/purge behavior does not keep all files resident at once."
        ),
    }


def branch_ids(branch_csv: Path) -> list[str]:
    return [row["output_node_id"] for row in read_csv(branch_csv)]


def source_node_accounting(inventory_csv: Path, executed: list[str], cached: list[str]) -> dict[str, Any]:
    rows = read_csv(inventory_csv)
    executed_set = {str(item) for item in executed}
    cached_set = {str(item) for item in cached}
    structural_types = {
        "PrimitiveFloat",
        "PrimitiveInt",
        "PrimitiveString",
        "PrimitiveStringMultiline",
        "PrimitiveBoolean",
    }
    node_rows: list[dict[str, Any]] = []
    unaccounted: list[str] = []
    for row in rows:
        node_id = str(row["node_id"])
        role = row.get("role", "")
        node_type = row.get("type", "")
        if node_id in executed_set:
            status = "executed"
        elif node_id in cached_set:
            status = "cached"
        elif role == "disconnected/reference":
            status = "disconnected/reference"
        elif role == "dead_end_or_sink":
            status = "sink_not_required_by_full_prompt" if node_id not in executed_set | cached_set else "covered"
        elif role == "structural_or_unassigned" or node_type in structural_types:
            status = "structural_value_not_runtime_scheduled"
        else:
            status = "unaccounted"
            unaccounted.append(node_id)
        node_rows.append(
            {
                "node_id": node_id,
                "type": node_type,
                "role": role,
                "status": status,
                "migration_risk": row.get("migration_risk"),
            }
        )
    return {
        "source_node_count": len(rows),
        "executed_count": len(executed_set),
        "cached_count": len(cached_set),
        "disconnected_reference_count": sum(1 for row in node_rows if row["status"] == "disconnected/reference"),
        "structural_value_count": sum(
            1 for row in node_rows if row["status"] == "structural_value_not_runtime_scheduled"
        ),
        "unaccounted_node_ids": unaccounted,
        "all_source_nodes_accounted": not unaccounted,
        "nodes": node_rows,
    }


def copy_output_files(
    output_files: list[dict[str, Any]], output_dir: Path
) -> tuple[list[dict[str, Any]], list[Path]]:
    copied_paths: list[Path] = []
    output_dir.mkdir(parents=True, exist_ok=True)
    copied_records: list[dict[str, Any]] = []
    for index, record in enumerate(output_files, start=1):
        copied_record = dict(record)
        path_value = record.get("path")
        if path_value:
            source_path = Path(path_value)
            if source_path.is_file() and source_path.stat().st_size > 0:
                destination = output_dir / f"{index:02d}-node-{record.get('node_id')}-{source_path.name}"
                shutil.copy2(source_path, destination)
                copied_paths.append(destination)
                copied_record["artifact_copy_path"] = str(destination)
                copied_record["artifact_copy_size_bytes"] = destination.stat().st_size
                copied_record["artifact_copy_sha256"] = sha256_file(destination)
        copied_records.append(copied_record)
    return copied_records, copied_paths


def infer_usable_budget_bytes(system_stats: dict[str, Any], feasibility: dict[str, Any] | None) -> int | None:
    if feasibility:
        budget = feasibility.get("hardware", {}).get("usable_budget_bytes")
        if isinstance(budget, int):
            return budget
    devices = system_stats.get("devices", [])
    if devices and isinstance(devices[0].get("vram_total"), int):
        return int(devices[0]["vram_total"] * 0.85)
    return None


def preserve_previous_attempt(run_dir: Path, run_level: str) -> Path | None:
    previous_summary = run_dir / f"08-{run_level}-run-summary.json"
    if not previous_summary.is_file():
        return None
    try:
        summary = read_json(previous_summary)
        status = summary.get("completion_decision", {}).get("status", "unknown")
        result_class = summary.get("result_class", "unknown")
    except (OSError, json.JSONDecodeError):
        status = "unknown"
        result_class = "unknown"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_dir = run_dir / "previous-attempts" / f"{timestamp}-{status}-{result_class}"
    archive_dir.mkdir(parents=True, exist_ok=True)
    for path in run_dir.iterdir():
        if path.name == "previous-attempts":
            continue
        destination = archive_dir / path.name
        if path.is_file():
            shutil.copy2(path, destination)
        elif path.is_dir():
            shutil.copytree(path, destination, dirs_exist_ok=True)
    return archive_dir


def completion_decision(
    run_status: str,
    history_summary: dict[str, Any] | None,
    output_files: list[dict[str, Any]],
    node_accounting: dict[str, Any],
    run_level: str,
    telemetry: dict[str, Any],
) -> dict[str, Any]:
    status_obj = history_summary.get("status", {}) if history_summary else {}
    status_str = status_obj.get("status_str") if isinstance(status_obj, dict) else None
    completed = bool(status_obj.get("completed")) if isinstance(status_obj, dict) else False
    non_empty_output_files = [
        item for item in output_files if item.get("exists") and item.get("size_bytes", 0) > 0
    ]
    success = (
        run_status == "history_available"
        and completed
        and status_str == "success"
        and bool(non_empty_output_files)
        and node_accounting["all_source_nodes_accounted"]
    )
    return {
        "status": "complete" if success else "hard_stop",
        "success_criteria_checked": {
            "step07_summary_consumed": True,
            "runtime_policy_prompt_consumed": True,
            "source_workflow_unmodified": True,
            "run_level": run_level,
            "queued_execution": True,
            "history_available": run_status == "history_available",
            "history_completed_success": completed and status_str == "success",
            "non_empty_output_files": len(non_empty_output_files),
            "xpu_telemetry_samples": telemetry.get("samples_total", 0),
            "all_source_nodes_accounted": node_accounting["all_source_nodes_accounted"],
            "full_size_attempted": run_level == "full-size",
        },
        "unresolved_gaps": []
        if success
        else [
            "Step 08 run did not complete with success history, output evidence, telemetry, and all-node accounting."
        ],
        "human_gate_prompt": None
        if success
        else {
            "problem_summary": "Step 08 full-path validation failed or lacks required evidence.",
            "required_human_action": (
                "Review 08 request/response/history/log/telemetry artifacts and decide whether to repair runtime, "
                "rerun with a different approved boundary, route to Step 09 tuning, or stop."
            ),
            "safe_reply_template": (
                "Step 08 decision: <repair/rerun/tune/stop>; allowed changes: <runtime/settings/source patch none|details>; "
                "claim boundary: <unchanged/narrowed>."
            ),
            "continuation_edges": {
                "after_runtime_repair": "rerun Step 08 and regenerate 08-output-manifest.json",
                "if_capacity_issue": "route to Step 09 tuning with failing node and telemetry evidence",
            },
        },
        "next_step_allowed": success,
        "next_step": "09-performance-tuning" if success else None,
    }


def make_report(summary: dict[str, Any], report_path: Path) -> None:
    decision = summary["completion_decision"]
    lines = [
        "# Step 08 Full Validation and Capacity",
        "",
        f"- Status: `{decision['status']}`",
        f"- Result class: `{summary['result_class']}`",
        f"- Run level: `{summary['run_level']}`",
        f"- Prompt boundary: `{summary['source_boundary']}`",
        f"- Prompt ID: `{summary.get('prompt_id')}`",
        f"- Duration seconds: `{summary.get('duration_seconds')}`",
        f"- Output files retained: `{len(summary.get('output_files', []))}`",
        f"- Peak memory used MiB: `{summary['memory_runtime'].get('peak_memory_used_mib')}`",
        f"- Peak/budget ratio: `{summary['memory_runtime'].get('peak_memory_budget_ratio')}`",
        "",
        "## Human-approved run boundary",
        "",
        summary["human_approved_boundary"],
        "",
        "## Runtime evidence",
        "",
        f"- Request: `{summary['artifacts']['request']}`",
        f"- Response: `{summary['artifacts']['response']}`",
        f"- History: `{summary['artifacts'].get('history', 'not available')}`",
        f"- Telemetry JSON: `{summary['artifacts']['telemetry_json']}`",
        f"- Telemetry CSV: `{summary['artifacts']['telemetry_csv']}`",
        "",
        "## Capacity interpretation",
        "",
        "- Static file-size sums are treated as an upper-bound warning, not as resident memory.",
        "- Runtime telemetry is authoritative for this reduced full-path attempt.",
        f"- Staged asset file sum / usable budget ratio: `{summary['memory_theory'].get('file_sum_to_usable_budget_ratio')}`",
        f"- Runtime peak / usable budget ratio: `{summary['memory_runtime'].get('peak_memory_budget_ratio')}`",
        "",
        "## Step reflection",
        "",
        "- Inputs consumed: Step 07 branch summary, Step 06 runtime-policy prompt, Step 06 branch manifest, Step 03 inventory, Step 02 feasibility, Step 01 asset ledger, and live Step 05 server evidence.",
        "- Input sufficiency: sufficient for reduced full-path validation; full-size/original-resolution approval remains a separate human gate.",
        "- Issues encountered: linked seed reductions initially bypassed a `Seed (rgthree)` node, cold/cache behavior exposed capacity sensitivity, and accounting had to distinguish structural primitive value nodes from missing runtime nodes.",
        "- Resolution: preserve seed-node links, archive previous attempts, record cache-assisted status, copy output evidence, and classify structural primitives explicitly.",
        "- Next-step context: Step 09 must compare cache/cold behavior and decide whether full-size or further reserve/runtime tuning is worth a separate approved run.",
        "",
        "## Boundaries carried forward",
        "",
        "- Source workflow remained unchanged.",
        "- Step 06 runtime-policy variant was used, so this is not a source-identical prompt success.",
        "- Nodes 63, 160, and 14 still use human-approved non-source-identical local substitutes.",
        "- This run used reduced settings; it proves full-path integration under the approved reduced boundary, not full-size capacity.",
        "",
        "## Toolization",
        "",
        "- tool_candidate: yes",
        "- candidate_name: step08_full_validation",
        "- safe_to_automate_now: yes for approved reduced/full-path harnessing; no for choosing claim-boundary changes",
        "- implementation_status: implemented",
        f"- script_or_tool_path: `{summary['tool_path']}`",
        "- limitations: reduced full-path validation does not prove full-size quality, customer acceptance, or source-identical fidelity.",
        "",
        "## Completion decision",
        "",
        "```json",
        json.dumps(decision, ensure_ascii=False, indent=2),
        "```",
    ]
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--comfy-root", type=Path, default=COMFY_ROOT_DEFAULT)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--run-level", choices=["reduced-full-path", "full-size"], default="reduced-full-path")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--poll-interval-seconds", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=8)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    run_dir = artifact_dir / "08-full-validation"
    output_copy_dir = run_dir / "outputs"
    run_dir.mkdir(parents=True, exist_ok=True)
    previous_attempt_archive = preserve_previous_attempt(run_dir, args.run_level)

    step07_summary = read_json(artifact_dir / "07-branch-smoke-summary.json")
    step06_summary = read_json(artifact_dir / "06-prompt-validation-summary.json")
    source_prompt_path = Path(step06_summary["variant_prompt_path"])
    source_prompt = read_json(source_prompt_path)
    feasibility_path = artifact_dir / "02-feasibility-summary.json"
    feasibility = read_json(feasibility_path) if feasibility_path.is_file() else None

    prompt_id = str(uuid.uuid4())
    client_id = str(uuid.uuid4())
    output_prefix = "zimage_v2_step08/reduced_full" if args.run_level == "reduced-full-path" else "zimage_v2_step08/full_size"
    if args.run_level == "reduced-full-path":
        prompt, setting_changes = apply_reduced_full_path_settings(source_prompt, output_prefix, args.seed)
    else:
        prompt = json.loads(json.dumps(source_prompt, ensure_ascii=False))
        setting_changes = []

    prompt_path = run_dir / f"08-{args.run_level}-prompt.json"
    changes_path = run_dir / f"08-{args.run_level}-setting-changes.json"
    request_path = run_dir / f"08-{args.run_level}-request.json"
    response_path = run_dir / f"08-{args.run_level}-submit-response.json"
    history_path = run_dir / f"08-{args.run_level}-history.json"
    system_before_path = run_dir / "08-system-stats-before.json"
    system_after_path = run_dir / "08-system-stats-after.json"
    telemetry_json_path = run_dir / "08-xpu-telemetry.json"
    telemetry_csv_path = run_dir / "08-xpu-telemetry.csv"
    node_accounting_path = run_dir / "08-node-accounting.json"
    output_files_path = run_dir / "08-output-files.json"
    run_summary_path = run_dir / f"08-{args.run_level}-run-summary.json"
    summary_path = artifact_dir / "08-full-validation-summary.json"
    report_path = artifact_dir / "08-full-validation.md"
    manifest_path = artifact_dir / "08-output-manifest.json"

    request_payload = {
        "prompt": prompt,
        "prompt_id": prompt_id,
        "client_id": client_id,
    }
    write_json(prompt_path, prompt)
    write_json(changes_path, setting_changes)
    write_json(request_path, request_payload)

    api_url = args.api_url.rstrip("/")
    try:
        system_before = fetch_json(f"{api_url}/system_stats", timeout=15)
    except Exception as exc:  # noqa: BLE001 - surfaced in artifact, not swallowed
        system_before = {"ok": False, "error": str(exc)}
    write_json(system_before_path, system_before)
    usable_budget_bytes = infer_usable_budget_bytes(system_before, feasibility)

    poller = TelemetryPoller(args.poll_interval_seconds)
    started = time.time()
    poller.start()
    submit_response = post_json(f"{api_url}/prompt", request_payload)
    write_json(response_path, submit_response)
    history_summary: dict[str, Any] | None = None
    history_result: dict[str, Any] | None = None
    run_status = "submit_failed"
    if submit_response["ok"]:
        history_result = wait_history(api_url, prompt_id, args.timeout_seconds, args.poll_interval_seconds)
        if history_result["ok"]:
            run_status = "history_available"
            write_json(history_path, history_result["history"])
            history_summary = summarize_history(history_result["history"], args.comfy_root.resolve())
        else:
            run_status = "history_timeout"
    poller.stop()
    duration_seconds = round(time.time() - started, 3)

    try:
        system_after = fetch_json(f"{api_url}/system_stats", timeout=15)
    except Exception as exc:  # noqa: BLE001 - surfaced in artifact, not swallowed
        system_after = {"ok": False, "error": str(exc)}
    write_json(system_after_path, system_after)

    telemetry = telemetry_summary(poller.samples, usable_budget_bytes)
    write_json(telemetry_json_path, {"summary": telemetry, "samples": poller.samples})
    write_telemetry_csv(telemetry_csv_path, poller.samples)

    raw_output_files = history_summary["output_files"] if history_summary else []
    output_files, copied_paths = copy_output_files(raw_output_files, output_copy_dir)
    write_json(output_files_path, output_files)

    executed_nodes = history_summary["executed_nodes"] if history_summary else []
    cached_nodes = history_summary["cached_nodes"] if history_summary else []
    node_accounting = source_node_accounting(artifact_dir / "03-node-inventory.csv", executed_nodes, cached_nodes)
    write_json(node_accounting_path, node_accounting)

    memory_theory = staged_asset_analysis(artifact_dir / "01-assets.csv", usable_budget_bytes)
    decision = completion_decision(
        run_status,
        history_summary,
        output_files,
        node_accounting,
        args.run_level,
        telemetry,
    )
    cache_assisted = bool(cached_nodes)
    result_class = (
        "restricted_reduced_full_path_runtime_policy_success"
        if decision["status"] == "complete" and args.run_level == "reduced-full-path"
        else "full_size_runtime_policy_success"
        if decision["status"] == "complete"
        else "full_path_validation_failed"
    )
    if decision["status"] == "complete" and cache_assisted:
        result_class += "_cache_assisted"

    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": " ".join(
            [
                str(Path(__file__).resolve()),
                "--workspace",
                str(workspace),
                "--comfy-root",
                str(args.comfy_root.resolve()),
                "--api-url",
                api_url,
                "--run-level",
                args.run_level,
            ]
        ),
        "api_url": api_url,
        "prompt_id": prompt_id,
        "duration_seconds": duration_seconds,
        "run_level": args.run_level,
        "source_boundary": "runtime-policy variant from Step 06; source workflow unchanged",
        "human_approved_boundary": (
            "User approved Step 08 reduced full-path validation first; full-size/original-resolution capacity "
            "is not attempted in this run and remains a separate gate."
        ),
        "step07_context": {
            "summary": str(artifact_dir / "07-branch-smoke-summary.json"),
            "branches_total": step07_summary.get("branches_total"),
            "branches_run": step07_summary.get("branches_run"),
            "branch_statuses": {
                item["branch"]: item["status"] for item in step07_summary.get("branch_summaries", [])
            },
        },
        "prompt_inputs": {
            "source_prompt": str(source_prompt_path),
            "step08_prompt": str(prompt_path),
            "setting_changes": str(changes_path),
            "partial_execution_targets": None,
            "intended_branch_output_nodes": branch_ids(artifact_dir / "06-branch-prompts.csv"),
        },
        "submit_response": submit_response,
        "history_summary": history_summary,
        "run_status": run_status,
        "output_files": output_files,
        "copied_output_files": [str(path) for path in copied_paths],
        "executed_nodes": executed_nodes,
        "cached_nodes": cached_nodes,
        "node_accounting": {
            key: value for key, value in node_accounting.items() if key != "nodes"
        },
        "memory_runtime": telemetry,
        "memory_theory": memory_theory,
        "capacity_classification": {
            "capacity_status": "reduced_full_path_runtime_telemetry_collected"
            if decision["status"] == "complete"
            else "unclassified_failure",
            "full_size_capacity": "not_attempted_by_human_approved_boundary"
            if args.run_level == "reduced-full-path"
            else "attempted",
            "budget_ratio": telemetry.get("peak_memory_budget_ratio"),
        },
        "result_class": result_class,
        "non_source_identical_boundary": {
            "node_ids": ["63", "160", "14"],
            "description": (
                "Nodes 63, 160, and 14 use human-approved /home/intel/hf_models substitutes; "
                "source-identical fidelity remains unproven."
            ),
        },
        "artifacts": {
            "prompt": str(prompt_path),
            "setting_changes": str(changes_path),
            "request": str(request_path),
            "response": str(response_path),
            "history": str(history_path) if history_path.exists() else None,
            "system_stats_before": str(system_before_path),
            "system_stats_after": str(system_after_path),
            "telemetry_json": str(telemetry_json_path),
            "telemetry_csv": str(telemetry_csv_path),
            "output_files": str(output_files_path),
            "node_accounting": str(node_accounting_path),
            "run_summary": str(run_summary_path),
            "report": str(report_path),
        },
        "previous_attempt_archive": str(previous_attempt_archive) if previous_attempt_archive else None,
        "step09_context": {
            "workspace": str(workspace),
            "artifact_folder": str(artifact_dir),
            "step08_summary": str(summary_path),
            "run_level": args.run_level,
            "result_class": result_class,
            "telemetry_summary": telemetry,
            "tuning_candidates": [
                "compare reduced full-path cold/warm cache behavior",
                "evaluate whether full-size attempt is worth a separate human-approved window",
                "preserve lowvram/reserve-vram/SeedVR2 block-swap settings from Step 05/06",
            ],
            "claim_boundary": "runtime-policy, reduced full-path, non-source-identical substitute assets",
        },
        "completion_decision": decision,
    }
    write_json(run_summary_path, summary)
    write_json(summary_path, summary)
    make_report(summary, report_path)

    manifest_paths = [
        summary_path,
        report_path,
        prompt_path,
        changes_path,
        request_path,
        response_path,
        system_before_path,
        system_after_path,
        telemetry_json_path,
        telemetry_csv_path,
        node_accounting_path,
        output_files_path,
        run_summary_path,
    ]
    if history_path.exists():
        manifest_paths.append(history_path)
    manifest_paths.extend(copied_paths)
    manifest = {
        "generated_at": utc_now(),
        "step": "08",
        "status": decision["status"],
        "artifacts": [artifact_record(path) for path in manifest_paths if path.exists()],
        "completion_decision": decision,
        "step09_context": summary["step09_context"],
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Run Step 07 branch smoke prompts against a live ComfyUI server."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import time
import uuid
import urllib.error
import urllib.request
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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


def fetch_json(url: str, timeout: int = 30) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return {"ok": True, "status": response.status, "json": json.loads(response.read().decode("utf-8"))}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return {"ok": False, "status": exc.code, "json": parsed}


def post_json_allow_empty(url: str, payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body) if body else {}
            return {"ok": True, "status": response.status, "json": parsed}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return {"ok": False, "status": exc.code, "json": parsed}


def free_memory(api_url: str) -> dict[str, Any]:
    return post_json_allow_empty(
        f"{api_url}/free",
        {"unload_models": True, "free_memory": True},
        timeout=30,
    )


def wait_history(api_url: str, prompt_id: str, timeout_seconds: int, poll_interval: float) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        history = fetch_json(f"{api_url}/history/{prompt_id}", timeout=15)
        if prompt_id in history:
            return {"ok": True, "history": history[prompt_id]}
        time.sleep(poll_interval)
    return {"ok": False, "error": f"timeout_after_{timeout_seconds}s"}


def apply_reduced_settings(
    prompt: dict[str, Any], branch_id: str, smoke_seed: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    prompt = json.loads(json.dumps(prompt, ensure_ascii=False))
    changes: list[dict[str, Any]] = []

    def set_input(node_id: str, input_name: str, new_value: Any, reason: str) -> None:
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

    for node_id, node in prompt.items():
        class_type = node.get("class_type")
        inputs = node.setdefault("inputs", {})
        if class_type == "KSampler":
            set_input(node_id, "steps", 1, "Step 07 smoke reduces sampler steps")
            set_input(node_id, "seed", smoke_seed, "Step 07 smoke uses fixed seed")
        elif class_type == "PainterFluxImageEdit":
            set_input(node_id, "width", 768, "Step 07 smoke reduces canvas width from 1920")
            set_input(node_id, "height", 512, "Step 07 smoke reduces canvas height from 1072")
        elif class_type == "KSamplerAdvanced":
            if isinstance(inputs.get("noise_seed"), list):
                set_input(str(inputs["noise_seed"][0]), "seed", smoke_seed, "Step 07 smoke fixes linked seed node")
            else:
                set_input(node_id, "noise_seed", smoke_seed, "Step 07 smoke uses fixed seed")
            set_input(node_id, "steps", 4, "Step 07 smoke reduces two-stage sampler total steps")
            if inputs.get("add_noise") == "enable":
                set_input(node_id, "end_at_step", 1, "Step 07 smoke preserves first-stage split with fewer steps")
            if inputs.get("add_noise") == "disable":
                set_input(node_id, "start_at_step", 1, "Step 07 smoke preserves second-stage split with fewer steps")
        elif class_type == "UltimateSDUpscale":
            set_input(node_id, "steps", 1, "Step 07 smoke reduces UltimateSDUpscale tile steps")
            set_input(node_id, "batch_size", 1, "Step 07 smoke keeps tile batch minimal")
        elif class_type == "TTResolutionSelector":
            set_input(node_id, "use_custom_resolution", False, "Step 07 smoke uses smaller preset resolution")
            set_input(node_id, "resolution", "512x512 (1:1) (方形)", "Step 07 smoke reduces latent resolution")
        elif class_type == "ImageScaleToTotalPixels":
            set_input(node_id, "megapixels", 0.1, "Step 07 smoke reduces SeedVR2 input size")
        elif class_type == "ImageScaleBy":
            set_input(node_id, "scale_by", 1.0, "Step 07 smoke avoids extra pre-upscale cost")
        elif class_type == "SeedVR2VideoUpscaler":
            set_input(node_id, "seed", smoke_seed, "Step 07 smoke uses fixed seed")
            set_input(node_id, "resolution", 512, "Step 07 smoke reduces SeedVR2 output resolution")
            set_input(node_id, "max_resolution", 512, "Step 07 smoke caps SeedVR2 output resolution")
            set_input(node_id, "batch_size", 1, "Step 07 smoke keeps SeedVR2 batch minimal")
        elif class_type == "Seed (rgthree)":
            set_input(node_id, "seed", smoke_seed, "Step 07 smoke fixes seed node without bypassing it")
    for node_id, node in prompt.items():
        if node.get("class_type") in {"SaveImage", "PreviewImage"}:
            inputs = node.setdefault("inputs", {})
            if "filename_prefix" in inputs:
                set_input(
                    node_id,
                    "filename_prefix",
                    f"flux_klein_step07/{branch_id}",
                    "Step 07 smoke isolates generated outputs by branch",
                )
    return prompt, changes


def output_file_path(comfy_root: Path, file_record: dict[str, Any], output_dir_override: Path | None = None) -> Path | None:
    file_type = file_record.get("type")
    filename = file_record.get("filename")
    if not filename:
        return None
    if file_type == "output":
        root = output_dir_override or (comfy_root / "output")
    elif file_type == "temp":
        root = comfy_root / "temp"
    elif file_type == "input":
        root = comfy_root / "input"
    else:
        return None
    subfolder = file_record.get("subfolder") or ""
    return root / subfolder / filename


def summarize_history(history: dict[str, Any], comfy_root: Path, output_dir_override: Path | None = None) -> dict[str, Any]:
    outputs = history.get("outputs", {})
    status = history.get("status", {})
    messages = status.get("messages", []) if isinstance(status, dict) else []
    executed: set[str] = set()
    cached: set[str] = set()
    for item in messages:
        if not isinstance(item, list) or len(item) < 2:
            continue
        event, payload = item[0], item[1]
        if event == "execution_cached":
            for node_id in payload.get("nodes", []):
                cached.add(str(node_id))
        if event in {"executing", "node_execution_start"} and payload.get("node") is not None:
            executed.add(str(payload.get("node")))
    output_files: list[dict[str, Any]] = []
    for node_id, node_output in outputs.items():
        for key, values in node_output.items():
            if isinstance(values, list):
                for value in values:
                    if isinstance(value, dict) and "filename" in value:
                        record = {"node_id": node_id, "kind": key, **value}
                        path = output_file_path(comfy_root, record, output_dir_override)
                        if path is not None:
                            record["path"] = str(path)
                            record["exists"] = path.exists()
                            record["size_bytes"] = path.stat().st_size if path.exists() else 0
                        output_files.append(record)
    return {
        "status": status,
        "output_node_ids": sorted(outputs.keys(), key=lambda value: int(value) if str(value).isdigit() else str(value)),
        "has_outputs": bool(outputs),
        "output_files": output_files,
        "executed_nodes": sorted(executed, key=lambda value: int(value) if value.isdigit() else value),
        "cached_nodes": sorted(cached, key=lambda value: int(value) if value.isdigit() else value),
    }


def branch_slug(output_node_id: str) -> str:
    return f"node-{output_node_id}"


def run_branch(
    row: dict[str, str],
    workspace: Path,
    comfy_root: Path,
    api_url: str,
    timeout_seconds: int,
    smoke_seed: int,
    free_memory_before_branch: bool,
    output_dir_override: Path | None = None,
) -> dict[str, Any]:
    artifact_dir = workspace / "artifacts"
    branch_id = row["output_node_id"]
    slug = branch_slug(branch_id)
    output_dir = artifact_dir / "07-branch-smokes" / slug
    source_prompt = read_json(Path(row["branch_prompt"]))
    smoke_prompt, setting_changes = apply_reduced_settings(source_prompt, slug, smoke_seed)
    prompt_path = output_dir / f"07-{slug}-smoke-prompt.json"
    notes_path = output_dir / f"07-{slug}-smoke-notes.json"
    request_path = output_dir / f"07-{slug}-smoke-request.json"
    response_path = output_dir / f"07-{slug}-smoke-submit-response.json"
    history_path = output_dir / f"07-{slug}-smoke-history.json"
    summary_path = output_dir / f"07-{slug}-smoke-summary.json"
    report_path = output_dir / f"07-{slug}-smoke.md"

    prompt_id = str(uuid.uuid4())
    client_id = str(uuid.uuid4())
    request_payload = {
        "prompt": smoke_prompt,
        "prompt_id": prompt_id,
        "client_id": client_id,
        "partial_execution_targets": [row["submission_output_node_id"]],
    }
    free_memory_response = free_memory(api_url) if free_memory_before_branch else None
    notes = {
        "branch": slug,
        "output_node_id": branch_id,
        "submission_output_node_id": row["submission_output_node_id"],
        "source_branch_prompt": row["branch_prompt"],
        "wrapper": row.get("wrapper", "none"),
        "reduced_setting_changes": setting_changes,
        "queued_execution": True,
        "free_memory_before_branch": free_memory_before_branch,
        "free_memory_response": free_memory_response,
    }
    write_json(prompt_path, smoke_prompt)
    write_json(notes_path, notes)
    write_json(request_path, request_payload)

    started = time.time()
    submit_response = post_json(f"{api_url}/prompt", request_payload)
    write_json(response_path, submit_response)
    if not submit_response["ok"]:
        summary = {
            "branch": slug,
            "status": "failed_validation_or_submit",
            "prompt_id": prompt_id,
            "duration_seconds": round(time.time() - started, 3),
            "submit_response": submit_response,
            "history_summary": None,
            "output_files": [],
            "gap": "submit failed before execution",
        }
        write_json(summary_path, summary)
    else:
        history_result = wait_history(api_url, prompt_id, timeout_seconds, 2.0)
        if history_result["ok"]:
            write_json(history_path, history_result["history"])
            history_summary = summarize_history(history_result["history"], comfy_root, output_dir_override)
            status_obj = history_summary.get("status", {})
            status_str = status_obj.get("status_str") if isinstance(status_obj, dict) else None
            completed = bool(status_obj.get("completed")) if isinstance(status_obj, dict) else False
            output_files = history_summary["output_files"]
            outputs_exist = bool(output_files) and all(item.get("exists") and item.get("size_bytes", 0) > 0 for item in output_files)
            passed = completed and status_str == "success" and history_summary["has_outputs"] and outputs_exist
            cache_assisted = passed and bool(history_summary["cached_nodes"])
            summary = {
                "branch": slug,
                "status": "cache_assisted_pass" if cache_assisted else ("passed" if passed else "failed_runtime"),
                "prompt_id": prompt_id,
                "duration_seconds": round(time.time() - started, 3),
                "submit_response": submit_response,
                "history_summary": history_summary,
                "output_files": history_summary["output_files"],
                "gap": None if passed else "history did not report success with non-empty output files",
            }
        else:
            summary = {
                "branch": slug,
                "status": "timeout",
                "prompt_id": prompt_id,
                "duration_seconds": round(time.time() - started, 3),
                "submit_response": submit_response,
                "history_summary": None,
                "output_files": [],
                "gap": history_result["error"],
            }
        write_json(summary_path, summary)

    report_lines = [
        f"# Step 07 branch smoke: {slug}",
        "",
        f"- Status: `{summary['status']}`",
        f"- Output node: `{branch_id}`",
        f"- Submission output node: `{row['submission_output_node_id']}`",
        f"- Wrapper: `{row.get('wrapper', 'none')}`",
        f"- Prompt: `{prompt_path}`",
        f"- Request: `{request_path}`",
        f"- Response: `{response_path}`",
        f"- History: `{history_path if history_path.exists() else 'not available'}`",
        f"- Summary: `{summary_path}`",
        f"- Output files: `{len(summary.get('output_files', []))}`",
        "",
        "## Reduced settings",
        "",
    ]
    for change in setting_changes:
        report_lines.append(
            f"- Node {change['node_id']} `{change['class_type']}.{change['input_name']}`: "
            f"`{change['old_value']}` -> `{change['new_value']}` ({change['reason']})"
        )
    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")

    summary["artifacts"] = [str(path) for path in [prompt_path, notes_path, request_path, response_path, summary_path, report_path]]
    if history_path.exists():
        summary["artifacts"].append(str(history_path))
    return summary


def completion_decision(branch_summaries: list[dict[str, Any]], total_branches: int) -> dict[str, Any]:
    passing_statuses = {"passed", "cache_assisted_pass"}
    passed = [item for item in branch_summaries if item["status"] in passing_statuses]
    failed = [item for item in branch_summaries if item["status"] not in passing_statuses]
    unattempted_count = max(total_branches - len(branch_summaries), 0)
    status = "complete" if len(passed) == total_branches else "hard_stop"
    return {
        "status": status,
        "success_criteria_checked": {
            "branch_prompts_consumed": True,
            "source_workflow_unmodified": True,
            "branches_attempted": len(branch_summaries),
            "branches_total": total_branches,
            "all_attempted_branches_have_artifacts": all(item.get("artifacts") for item in branch_summaries),
            "all_branches_passed_or_cache_assisted": len(passed) == total_branches,
            "cache_assisted_branches": sum(1 for item in branch_summaries if item["status"] == "cache_assisted_pass"),
            "queued_execution": True,
        },
        "unresolved_gaps": [
            f"{item['branch']}: {item['status']} ({item.get('gap')})" for item in failed
        ]
        + ([f"{unattempted_count} branch(es) not attempted"] if unattempted_count else []),
        "human_gate_prompt": None
        if status == "complete"
        else {
            "problem_summary": "Step 07 branch smoke encountered failed, blocked, or untested branches.",
            "required_human_action": "Review failed branch artifacts and decide whether to repair environment/runtime policy, rerun selected branches, narrow scope, or stop.",
            "safe_reply_template": "Repair/rerun branches: <branch ids>; allowed changes: <dependency/runtime/settings>; delivery scope decision: <include/exclude>.",
            "continuation_edges": {
                "after_repair": "rerun Step 07 for failed branches, then regenerate Step 07 summary",
                "if_scope_narrowed": "record human decision and carry reduced claim boundary to Steps 08-12",
            },
        },
        "next_step_allowed": status == "complete",
        "next_step": "08-full-validation-and-capacity" if status == "complete" else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--comfy-root", type=Path, default=COMFY_ROOT_DEFAULT)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--only", action="append", default=[], help="Only run the named output node id.")
    parser.add_argument("--merge-existing", action="store_true", help="Merge --only results into existing summary.")
    parser.add_argument("--free-memory-before-branch", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--smoke-seed", type=int, default=1)
    parser.add_argument("--output-dir", type=Path, default=None, help="Override output directory (e.g. when --output-directory was used)")
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    branch_csv = artifact_dir / "06-branch-prompts.csv"
    all_rows = read_csv(branch_csv)
    rows = all_rows
    if args.only:
        only = {str(item) for item in args.only}
        rows = [row for row in rows if row["output_node_id"] in only]

    summaries: list[dict[str, Any]] = []
    for row in rows:
        output_dir = args.output_dir.resolve() if args.output_dir else None
        summaries.append(
            run_branch(
                row,
                workspace,
                args.comfy_root.resolve(),
                args.api_url.rstrip("/"),
                args.timeout_seconds,
                args.smoke_seed,
                args.free_memory_before_branch,
                output_dir,
            )
        )
        if summaries[-1]["status"] not in {"passed", "cache_assisted_pass"}:
            break

    summary_path = artifact_dir / "07-branch-smoke-summary.json"
    if args.merge_existing and summary_path.is_file():
        existing = read_json(summary_path)
        by_branch = {item["branch"]: item for item in existing.get("branch_summaries", [])}
        for item in summaries:
            by_branch[item["branch"]] = item
        summaries = [
            by_branch[branch_slug(row["output_node_id"])]
            for row in all_rows
            if branch_slug(row["output_node_id"]) in by_branch
        ]

    total = len(all_rows)
    decision = completion_decision(summaries, total)
    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "api_url": args.api_url.rstrip("/"),
        "branches_total": total,
        "branches_run": len(summaries),
        "smoke_seed": args.smoke_seed,
        "branch_summaries": summaries,
        "completion_decision": decision,
        "step08_context": {
            "workspace": str(workspace),
            "artifact_folder": str(artifact_dir),
            "branch_smoke_summary": str(artifact_dir / "07-branch-smoke-summary.json"),
            "branch_smoke_report": str(artifact_dir / "07-branch-smoke.md"),
        },
    }
    report_path = artifact_dir / "07-branch-smoke.md"
    write_json(summary_path, summary)
    report_lines = [
        "# Step 07 Branch Smoke Validation",
        "",
        f"- Status: `{decision['status']}`",
        f"- Branches run: `{len(summaries)}` / `{total}`",
        f"- Passed: `{sum(1 for item in summaries if item['status'] in {'passed', 'cache_assisted_pass'})}`",
        f"- Cache-assisted: `{sum(1 for item in summaries if item['status'] == 'cache_assisted_pass')}`",
        f"- Failed/blocked: `{sum(1 for item in summaries if item['status'] not in {'passed', 'cache_assisted_pass'})}`",
        "",
        "## Branch results",
        "",
    ]
    for item in summaries:
        report_lines.append(f"- `{item['branch']}`: `{item['status']}` ({item.get('gap') or 'ok'})")
    report_lines.extend(
        [
            "",
            "## Toolization",
            "",
            "- tool_candidate: yes",
            "- candidate_name: step07_branch_smoke",
            "- safe_to_automate_now: yes",
            "- implementation_status: implemented",
            f"- script_or_tool_path: `{Path(__file__).resolve()}`",
            "- limitations: branch smoke uses reduced settings and proves runtime reachability, not full-size quality or capacity.",
            "",
            "## Completion decision",
            "",
            "```json",
            json.dumps(decision, ensure_ascii=False, indent=2),
            "```",
        ]
    )
    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")

    manifest_paths = [summary_path, report_path]
    for item in summaries:
        manifest_paths.extend(Path(path) for path in item.get("artifacts", []))
    manifest = {
        "generated_at": utc_now(),
        "step": "07",
        "status": decision["status"],
        "artifacts": [artifact_record(path) for path in manifest_paths if path.exists()],
        "completion_decision": decision,
        "step08_context": summary["step08_context"],
    }
    manifest_path = artifact_dir / "07-output-manifest.json"
    write_json(manifest_path, manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

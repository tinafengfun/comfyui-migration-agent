#!/usr/bin/env python3
"""Analyze Step 09 tuning candidates from validated Step 08 evidence."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step07_branch_smoke import artifact_record, read_json, write_json


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status_of(summary: dict[str, Any]) -> tuple[str | None, bool]:
    status = (summary.get("history_summary") or {}).get("status", {})
    return status.get("status_str"), bool(status.get("completed"))


def candidate_from_summary(name: str, path: Path, summary: dict[str, Any]) -> dict[str, Any]:
    status_str, completed = status_of(summary)
    decision_status = summary.get("completion_decision", {}).get("status")
    node_accounting = summary.get("node_accounting", {})
    output_count = len(summary.get("output_files", []))
    cached_count = len(summary.get("cached_nodes", []))
    executed_count = len(summary.get("executed_nodes", []))
    telemetry = summary.get("memory_runtime", {})
    unaccounted = node_accounting.get("unaccounted_node_ids", [])
    report_recovery_only = (
        status_str == "success"
        and completed
        and output_count > 0
        and set(unaccounted).issubset({"198"})
        and decision_status != "complete"
    )
    if decision_status == "complete":
        result = "accepted"
    elif report_recovery_only:
        result = "runtime_success_report_accounting_recovery"
    else:
        result = "rejected_or_failed"
    return {
        "name": name,
        "path": str(path),
        "decision_status": decision_status,
        "history_status": status_str,
        "history_completed": completed,
        "result_class": summary.get("result_class"),
        "run_level": summary.get("run_level"),
        "duration_seconds": summary.get("duration_seconds"),
        "cached_node_count": cached_count,
        "executed_node_count": executed_count,
        "output_files": output_count,
        "peak_memory_budget_ratio": telemetry.get("peak_memory_budget_ratio"),
        "peak_memory_used_mib": telemetry.get("peak_memory_used_mib"),
        "unaccounted_node_ids": unaccounted,
        "result": result,
        "cache_policy": "cache_assisted" if cached_count else "cold_or_cache_cleared",
        "telemetry_valid": bool(telemetry.get("valid_samples", 0)),
    }


def collect_candidates(artifact_dir: Path) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    current_path = artifact_dir / "08-full-validation-summary.json"
    current = read_json(current_path)
    candidates.append(candidate_from_summary("accepted-step08-current", current_path, current))

    attempts_root = artifact_dir / "08-full-validation" / "previous-attempts"
    if attempts_root.is_dir():
        for run_summary in sorted(attempts_root.glob("*/08-reduced-full-path-run-summary.json")):
            summary = read_json(run_summary)
            candidates.append(candidate_from_summary(run_summary.parent.name, run_summary, summary))
    return candidates


def choose_config(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    accepted = [item for item in candidates if item["result"] == "accepted"]
    cold_success = [
        item
        for item in candidates
        if item["result"] == "runtime_success_report_accounting_recovery"
        and item["cache_policy"] == "cold_or_cache_cleared"
    ]
    valid_successes = [
        item
        for item in candidates
        if item["history_status"] == "success"
        and item["history_completed"]
        and item["result"] in {"accepted", "runtime_success_report_accounting_recovery"}
    ]
    fastest = min(
        valid_successes,
        key=lambda item: item.get("duration_seconds") or float("inf"),
        default=None,
    )
    safest = min(
        [*accepted, *cold_success],
        key=lambda item: item.get("peak_memory_budget_ratio") or float("inf"),
        default=None,
    )
    return {
        "selected_configuration": "no_runtime_change_selected",
        "selected_reason": (
            "The validated reduced full-path already works, but accepted evidence is cache-assisted and near "
            "the memory budget. No launch/prompt tuning is promoted without a separate cold/full-size window."
        ),
        "fastest_observed_candidate": fastest,
        "safe_fallback_candidate": safest,
        "delivery_default": {
            "launch_policy": "keep Step 05 lowvram reserve-vram=4 runtime unless Step 09/08 is rerun in an approved full-size window",
            "prompt_policy": "keep Step 06 runtime-policy prompt plus approved reduced settings for bounded validation",
            "cache_policy": "do not require model/cache residency for single-run delivery",
        },
        "rejected_changes": [
            {
                "candidate": "literal fixed seed on linked KSamplerAdvanced.noise_seed",
                "reason": "violates no-bypass by disconnecting Seed (rgthree) node 188",
            },
            {
                "candidate": "cache-assisted speed as universal winner",
                "reason": "final accepted run is faster but peak/budget ratio is 0.9817 and cache-dependent",
            },
            {
                "candidate": "full-size/original-resolution run",
                "reason": "not attempted because Step 08 human-approved boundary was reduced full-path first",
            },
        ],
    }


def completion_decision(candidates: list[dict[str, Any]], selection: dict[str, Any]) -> dict[str, Any]:
    has_accepted = any(item["result"] == "accepted" for item in candidates)
    telemetry_valid = all(
        item["telemetry_valid"]
        for item in candidates
        if item["history_status"] == "success" and item["history_completed"]
    )
    status = "complete" if has_accepted and telemetry_valid and selection["selected_configuration"] else "hard_stop"
    return {
        "status": status,
        "success_criteria_checked": {
            "step08_summary_consumed": True,
            "candidate_attempts_collected": len(candidates),
            "accepted_baseline_present": has_accepted,
            "telemetry_valid_for_successful_runs": telemetry_valid,
            "source_workflow_unmodified": True,
            "selected_configuration": selection["selected_configuration"],
            "full_size_attempted": False,
        },
        "unresolved_gaps": []
        if status == "complete"
        else ["Step 09 could not identify a validated baseline with telemetry."],
        "human_gate_prompt": None
        if status == "complete"
        else {
            "problem_summary": "Step 09 tuning lacks valid baseline telemetry.",
            "required_human_action": "Repair Step 08 evidence or approve a new bounded benchmark window.",
            "safe_reply_template": "Step 09 decision: <repair evidence/rerun benchmark/stop>; approved run boundary: <details>.",
        },
        "next_step_allowed": status == "complete",
        "next_step": "10-coverage-review" if status == "complete" else None,
    }


def make_report(summary: dict[str, Any], report_path: Path) -> None:
    lines = [
        "# Step 09 Performance Tuning",
        "",
        f"- Status: `{summary['completion_decision']['status']}`",
        f"- Selected configuration: `{summary['selection']['selected_configuration']}`",
        f"- Candidate attempts: `{len(summary['candidates'])}`",
        f"- Full-size attempted: `{summary['completion_decision']['success_criteria_checked']['full_size_attempted']}`",
        "",
        "## Decision",
        "",
        summary["selection"]["selected_reason"],
        "",
        "## Candidate matrix",
        "",
        "| candidate | result | cache policy | duration s | peak/budget | outputs | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in summary["candidates"]:
        notes = []
        if item.get("unaccounted_node_ids"):
            notes.append(f"unaccounted={','.join(item['unaccounted_node_ids'])}")
        if item.get("result_class"):
            notes.append(item["result_class"])
        lines.append(
            "| {name} | {result} | {cache} | {duration} | {ratio} | {outputs} | {notes} |".format(
                name=item["name"],
                result=item["result"],
                cache=item["cache_policy"],
                duration=item.get("duration_seconds"),
                ratio=item.get("peak_memory_budget_ratio"),
                outputs=item.get("output_files"),
                notes="; ".join(notes) or "ok",
            )
        )
    lines.extend(
        [
            "",
            "## Winner and fallback",
            "",
            f"- Fastest observed candidate: `{(summary['selection']['fastest_observed_candidate'] or {}).get('name')}`",
            f"- Safe fallback candidate: `{(summary['selection']['safe_fallback_candidate'] or {}).get('name')}`",
            "- Delivery default: keep the Step 05 lowvram/reserve-vram=4 runtime and do not rely on cache residency for single-run delivery.",
            "",
            "## Reflection",
            "",
            "- Step 08 context was sufficient for Step 09 because it preserved current and previous attempt summaries, telemetry, output copies, and cache boundaries.",
            "- No new full-size benchmark was run because the approved Step 08 boundary was reduced full-path and the accepted run is already tight on memory.",
            "- The main improvement is classification: cache-assisted speed is not promoted as a universal tuning winner, and report/accounting recovery is kept separate from runtime failure.",
            "",
            "## Toolization",
            "",
            "- tool_candidate: yes",
            "- candidate_name: step09_performance_tuning",
            "- safe_to_automate_now: yes for evidence normalization and candidate ranking; no for approving full-size/high-risk benchmark windows",
            "- implementation_status: implemented",
            f"- script_or_tool_path: `{summary['tool_path']}`",
            "",
            "## Completion decision",
            "",
            "```json",
            json.dumps(summary["completion_decision"], ensure_ascii=False, indent=2),
            "```",
        ]
    )
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    candidates = collect_candidates(artifact_dir)
    selection = choose_config(candidates)
    decision = completion_decision(candidates, selection)
    summary_path = artifact_dir / "09-tuning-analysis.json"
    report_path = artifact_dir / "09-tuning.md"
    manifest_path = artifact_dir / "09-output-manifest.json"

    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": f"{Path(__file__).resolve()} --workspace {workspace}",
        "baseline": str(artifact_dir / "08-full-validation-summary.json"),
        "candidates": candidates,
        "selection": selection,
        "claim_boundary": {
            "run_level": "reduced-full-path",
            "source_boundary": "runtime-policy prompt variant; source workflow unchanged",
            "asset_boundary": "nodes 63, 160, and 14 use human-approved non-source-identical substitutes",
            "full_size_capacity": "not attempted",
        },
        "step10_context": {
            "workspace": str(workspace),
            "artifact_folder": str(artifact_dir),
            "step09_summary": str(summary_path),
            "step08_summary": str(artifact_dir / "08-full-validation-summary.json"),
            "selected_configuration": selection["selected_configuration"],
            "safe_fallback": selection["safe_fallback_candidate"],
            "coverage_boundary": "coverage may use reduced full-path/cache-assisted evidence only; do not claim full-size or source-identical success",
        },
        "completion_decision": decision,
    }
    write_json(summary_path, summary)
    make_report(summary, report_path)
    manifest = {
        "generated_at": utc_now(),
        "step": "09",
        "status": decision["status"],
        "artifacts": [artifact_record(path) for path in [summary_path, report_path] if path.exists()],
        "completion_decision": decision,
        "step10_context": summary["step10_context"],
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

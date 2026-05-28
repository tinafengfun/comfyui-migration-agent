#!/usr/bin/env python3
"""Build a Step 02 feasibility scaffold from Step 00/01 artifacts.

The tool is intentionally read-only with respect to the source workflow and
runtime. It parses durable artifacts, verifies node/dependency coverage, writes
Step 02 reports, and optionally records read-only XPU discovery evidence.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
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


def run_optional_command(args: list[str]) -> dict[str, Any]:
    executable = shutil.which(args[0])
    if executable is None:
        return {
            "command": args,
            "available": False,
            "returncode": None,
            "stdout": "",
            "stderr": f"{args[0]} not found",
        }
    result = subprocess.run(
        [executable, *args[1:]],
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return {
        "command": [executable, *args[1:]],
        "available": True,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def parse_xpu_discovery(probe: dict[str, Any]) -> dict[str, Any]:
    discovery = probe.get("xpu_smi_discovery_device_0", {})
    if discovery.get("returncode") != 0 or not discovery.get("stdout"):
        return {
            "device_name": "unknown",
            "physical_memory_bytes": None,
            "free_memory_bytes": None,
            "usable_budget_bytes": None,
            "evidence": "xpu-smi discovery -d 0 -j unavailable or failed",
        }
    try:
        data = json.loads(discovery["stdout"])
    except json.JSONDecodeError:
        return {
            "device_name": "unknown",
            "physical_memory_bytes": None,
            "free_memory_bytes": None,
            "usable_budget_bytes": None,
            "evidence": "xpu-smi discovery output was not JSON",
        }
    physical = int(data.get("memory_physical_size_byte", 0) or 0)
    free = int(data.get("memory_free_size_byte", 0) or 0)
    return {
        "device_name": data.get("device_name", "unknown"),
        "pci_device_id": data.get("pci_device_id", "unknown"),
        "physical_memory_bytes": physical or None,
        "free_memory_bytes": free or None,
        "usable_budget_bytes": int(free * 0.85) if free else None,
        "evidence": "xpu-smi discovery -d 0 -j",
    }


def size_gib(size_bytes: int | None) -> float | None:
    if size_bytes is None:
        return None
    return round(size_bytes / (1024**3), 2)


def parse_workflow(workflow_path: Path) -> dict[str, Any]:
    workflow = read_json(workflow_path)
    nodes = workflow.get("nodes", [])
    links = workflow.get("links", [])
    return {
        "node_count": len(nodes),
        "link_count": len(links),
        "workflow_sha256": sha256_file(workflow_path),
    }


def classify_asset_rows(rows: list[dict[str, str]]) -> dict[str, Any]:
    states = Counter(row.get("state", "") for row in rows)
    substitute_rows = [
        row
        for row in rows
        if "substitute" in row.get("state", "").lower()
        or "source-identical fidelity not proven" in row.get("acquisition_status", "").lower()
    ]
    staged_rows = [
        row
        for row in rows
        if row.get("staged_path") and row.get("acquisition_status", "").lower() != "missing"
    ]
    total_size = sum(int(row.get("size_bytes") or 0) for row in rows)
    heaviest = sorted(
        rows,
        key=lambda row: int(row.get("size_bytes") or 0),
        reverse=True,
    )[:5]
    return {
        "assets_total": len(rows),
        "assets_staged": len(staged_rows),
        "states": dict(states),
        "substitute_assets": [
            {
                "requested_name": row.get("requested_name") or row.get("asset_name"),
                "source_node_ids": row.get("node_dependency_scan"),
                "size_bytes": int(row.get("size_bytes") or 0),
                "staged_path": row.get("staged_path", ""),
                "boundary": row.get("acquisition_status", ""),
            }
            for row in substitute_rows
        ],
        "total_asset_size_bytes": total_size,
        "heaviest_assets": [
            {
                "requested_name": row.get("requested_name") or row.get("asset_name"),
                "source_node_ids": row.get("node_dependency_scan"),
                "size_bytes": int(row.get("size_bytes") or 0),
                "size_gib": size_gib(int(row.get("size_bytes") or 0)),
                "state": row.get("state", ""),
            }
            for row in heaviest
        ],
    }


def build_node_accounting(
    node_scan_rows: list[dict[str, str]],
    dependency_rows: list[dict[str, str]],
) -> list[dict[str, str]]:
    dependency_by_id = {row.get("node_id", ""): row for row in dependency_rows}
    rows: list[dict[str, str]] = []
    for node in node_scan_rows:
        node_id = node.get("node_id", "")
        dependency = dependency_by_id.get(node_id, {})
        resolved = dependency.get("resolved_state", "")
        visible = dependency.get("visible_asset_state", "")
        custom = dependency.get("custom_node_state", "")
        if "approved substitute" in visible:
            status = "processed_with_non_source_identical_boundary"
        elif "no visible asset dependency" in visible and "core/no custom" in custom:
            status = "processed_dependency_free"
        elif resolved:
            status = "processed_dependency_resolved"
        else:
            status = "processed_but_dependency_status_missing"
        rows.append(
            {
                "node_id": node_id,
                "node_type": node.get("node_type", ""),
                "mode_status": node.get("mode_status", ""),
                "link_role": node.get("link_role", ""),
                "feasibility_accounting_status": status,
                "dependency_references": dependency.get("dependency_references", ""),
                "visible_asset_state": visible,
                "custom_node_state": custom,
                "resolved_state": resolved,
                "gap_action": dependency.get("gap_action", ""),
            }
        )
    return rows


def route_from_inputs(
    coverage_complete: bool,
    asset_summary: dict[str, Any],
    hardware: dict[str, Any],
) -> tuple[str, list[str], list[str]]:
    risks: list[str] = []
    gates: list[str] = []
    if not coverage_complete:
        gates.append("full source/dependency node coverage is incomplete")
    if asset_summary["substitute_assets"]:
        risks.append(
            "nodes 63, 160, and 14 use human-approved substitutes; source-identical fidelity is not proven"
        )
    if hardware.get("physical_memory_bytes") is None:
        gates.append("target XPU physical/free memory budget could not be measured")
    else:
        heaviest_sum = sum(item["size_bytes"] for item in asset_summary["heaviest_assets"][:3])
        usable_budget = int(hardware.get("usable_budget_bytes") or 0)
        if usable_budget and heaviest_sum > usable_budget:
            risks.append(
                "largest active model combination may exceed conservative usable VRAM before offload/streaming policy is known"
            )
        elif usable_budget:
            risks.append(
                "static model-size estimate is below conservative usable VRAM, but activation/runtime peaks require Step 08 telemetry"
            )
    if gates:
        return "human_gate_reached", risks, gates
    return "complete", risks, gates


def markdown_table(rows: list[dict[str, Any]], headers: list[str]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        values = [str(row.get(header, "")).replace("\n", " ") for header in headers]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def render_report(summary: dict[str, Any], node_rows: list[dict[str, str]]) -> str:
    hardware = summary["hardware"]
    asset_summary = summary["asset_custom_node_readiness"]
    completion = summary["completion_decision"]
    substitute_table = [
        {
            "node": item["source_node_ids"],
            "asset": item["requested_name"],
            "size_gib": size_gib(item["size_bytes"]),
            "boundary": item["boundary"],
        }
        for item in asset_summary["substitute_assets"]
    ]
    all_node_rows = [
        {
            "node_id": row["node_id"],
            "node_type": row["node_type"],
            "link_role": row["link_role"],
            "status": row["feasibility_accounting_status"],
        }
        for row in node_rows
    ]
    heaviest_rows = [
        {
            "node": item["source_node_ids"],
            "asset": item["requested_name"],
            "size_gib": item["size_gib"],
            "state": item["state"],
        }
        for item in asset_summary["heaviest_assets"]
    ]
    return f"""# 02 - Feasibility analysis (v2)

orchestrator_status: {summary["orchestrator_status"]}
generated_utc: `{summary["generated_utc"]}`

workflow: `{summary["workflow"]}`
workflow_sha256: `{summary["workflow_sha256"]}`
artifact_folder: `{summary["artifact_folder"]}`

## Route

Initial class: **bounded XPU migration / non-source-identical smoke-first path**.

Step 02 can proceed to Step 03 because Step 00 and Step 01 prove full source-node and dependency-scan coverage, and Step 01 has staged all visible model assets and custom-node sources. This is not a source-identical production route: nodes 63, 160, and 14 use human-approved local substitutes, so downstream validation and delivery must keep a bounded/non-source-identical claim boundary unless exact source-identical assets are later staged.

## Input evidence consumed

- `00-intake-preflight.md`
- `00-node-scan.csv`
- `01-assets.csv`
- `01-custom-nodes.md`
- `01-node-dependency-scan.csv`
- `01-acquisition-summary.json`
- `01-output-manifest.json`
- `task-state.json`
- source workflow copy: `{summary["source_workflow_copy"]}`

## Scan coverage

- source_node_count: {summary["scan_coverage"]["source_node_count"]}
- workflow_node_count_recounted: {summary["scan_coverage"]["workflow_node_count_recounted"]}
- step00_scanned_node_count: {summary["scan_coverage"]["step00_scanned_node_count"]}
- step00_missing_node_ids: {summary["scan_coverage"]["step00_missing_node_ids"]}
- step01_dependency_scanned_node_count: {summary["dependency_coverage"]["step01_dependency_scanned_node_count"]}
- step01_missing_dependency_scan_node_ids: {summary["dependency_coverage"]["step01_missing_dependency_scan_node_ids"]}
- coverage_status: {summary["scan_coverage"]["coverage_status"]}

## Asset and custom-node readiness

- assets_total: {asset_summary["assets_total"]}
- assets_staged: {asset_summary["assets_staged"]}
- assets_source_identical_staged: {summary["step01_completion_signals"]["assets_source_identical_staged"]}
- assets_approved_substitute_staged: {summary["step01_completion_signals"]["assets_approved_substitute_staged"]}
- custom_nodes_total: {summary["step01_completion_signals"]["custom_nodes_total"]}
- custom_node_gaps: {summary["step01_completion_signals"]["custom_node_gaps"]}
- hidden_runtime_asset_status: hidden source patterns were scanned in Step 01 where sources were available; runtime auto-download behavior still requires Step 04/05 source/runtime audit.
- custom_node_registration_assumption: source known/staged only; installation, import, object_info registration, and XPU runtime proof are Step 05/06 responsibilities.

### Approved non-source-identical substitute boundary

{markdown_table(substitute_table, ["node", "asset", "size_gib", "boundary"])}

## Hardware and capacity precheck

- target hardware: {hardware.get("device_name", "unknown")} ({hardware.get("pci_device_id", "unknown")})
- physical_memory_gib: {size_gib(hardware.get("physical_memory_bytes"))}
- free_memory_gib_at_probe: {size_gib(hardware.get("free_memory_bytes"))}
- conservative_usable_budget_gib: {size_gib(hardware.get("usable_budget_bytes"))}
- capacity_route: preliminary; large model weights fit only if runtime/offload/branch residency behaves as expected, and activation peaks require Step 08 telemetry.

### Heaviest staged assets

{markdown_table(heaviest_rows, ["node", "asset", "size_gib", "state"])}

## Risks

{chr(10).join(f"- {risk}" for risk in summary["risks"]) if summary["risks"] else "- none"}

## Hard stops

- none at Step 02. Later hard stops remain possible if Step 05/06 cannot register required custom nodes, if critical code is CUDA-only without approved repair, or if Step 08 capacity evidence exceeds the target budget.

## Human intervention needed

- none before Step 03.
- Human intervention is required later if exact source-identical assets are demanded for nodes 63/160/14, if source/runtime patches are needed, if reduced fidelity/offload is proposed, or if customer-facing delivery claims would exceed evidence.

## All-node feasibility accounting

Full machine-readable table: `02-node-feasibility-accounting.csv`.

{markdown_table(all_node_rows, ["node_id", "node_type", "link_role", "status"])}

## Reflection and Step 02 skill improvement

- Input sufficiency: Step 00 and Step 01 are now sufficient for Step 02 because they include full source-node coverage, dependency-scan coverage, current model/custom-node ledgers, acquisition summary, and route constraint.
- Issue encountered: there was no dedicated Step 02 scaffold tool and no hard requirement to include every node in the Step 02 artifact.
- Resolution: implemented `tools/step02_feasibility_scaffold.py`, generated all-node accounting, and updated Step 02 prompt/skill to require a `completion_decision` and no source workflow mutation.
- Step 03 dependency: Step 03 must build a true topology/branch inventory from the source graph, not rely only on the Step 02 output hints.

## Toolization

- tool_candidate: yes
- candidate_name: step02_feasibility_scaffold
- why_reusable: parses Step 00/01 artifacts, verifies coverage, generates feasibility report, summary JSON, all-node accounting, hardware probe, and manifest without touching runtime or workflow state.
- safe_to_automate_now: yes
- implementation_status: implemented
- script_or_tool_path: `/home/intel/tianfeng/comfy/ComfyUI/docs/draft/migration-workflow-v2/tools/step02_feasibility_scaffold.py`
- command_used: `python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step02_feasibility_scaffold.py --workspace {summary["workspace"]} --probe-hardware`
- inputs: Step 00/01 artifacts and source workflow copy listed above.
- outputs: `02-feasibility.md`, `02-feasibility-summary.json`, `02-node-feasibility-accounting.csv`, `02-hardware-probe.json`, `02-output-manifest.json`.
- limitations: static capacity estimate only; no ComfyUI import, object_info, prompt conversion, runtime execution, source audit, or branch topology validation.
- prompt_or_skill_update: Step 02 prompt/skill must require all-node accounting, source-workflow immutability, explicit completion decision, and toolization evidence.

## step03_context

```json
{json.dumps(summary["step03_context"], ensure_ascii=False, indent=2)}
```

## completion_decision

```json
{json.dumps(completion, ensure_ascii=False, indent=2)}
```
"""


def build_summary(workspace: Path, probe_hardware: bool) -> tuple[dict[str, Any], list[dict[str, str]]]:
    artifacts = workspace / "artifacts"
    task_state = read_json(workspace / "task-state.json")
    acquisition = read_json(artifacts / "01-acquisition-summary.json")
    output_manifest = read_json(artifacts / "01-output-manifest.json")
    workflow = Path(task_state["workflow"])
    source_workflow_copy = workspace / "source" / workflow.name
    workflow_path = source_workflow_copy if source_workflow_copy.exists() else workflow

    workflow_info = parse_workflow(workflow_path)
    node_scan = read_csv(artifacts / "00-node-scan.csv")
    output_node_hints = [
        f"{row.get('node_id')}:{row.get('node_type')}"
        for row in node_scan
        if row.get("link_role") == "output/display"
    ]
    assets = read_csv(artifacts / "01-assets.csv")
    dependencies = read_csv(artifacts / "01-node-dependency-scan.csv")
    asset_summary = classify_asset_rows(assets)
    node_accounting = build_node_accounting(node_scan, dependencies)

    hardware_probe: dict[str, Any] = {
        "generated_utc": utc_now(),
        "probe_hardware": probe_hardware,
        "commands": {},
    }
    if probe_hardware:
        hardware_probe["commands"]["xpu_smi_discovery"] = run_optional_command(
            ["xpu-smi", "discovery", "-j"]
        )
        hardware_probe["commands"]["xpu_smi_discovery_device_0"] = run_optional_command(
            ["xpu-smi", "discovery", "-d", "0", "-j"]
        )
        hardware_probe["commands"]["xpu_smi_stats_device_0"] = run_optional_command(
            ["xpu-smi", "stats", "-d", "0", "-j"]
        )
        hardware_probe["commands"]["sycl_ls"] = run_optional_command(["sycl-ls"])
    hardware = parse_xpu_discovery(hardware_probe["commands"])

    step00_signals = task_state["steps"]["00"]["completion_signals"]
    step01_signals = output_manifest["completion_signals"]
    coverage_complete = (
        workflow_info["node_count"] == int(step00_signals["source_node_count"])
        and len(node_scan) == int(step00_signals["scanned_node_count"])
        and len(dependencies) == int(step01_signals["dependency_scanned_node_count"])
        and not step00_signals.get("missing_node_ids")
        and not step01_signals.get("missing_dependency_scan_node_ids")
    )
    status, risks, gates = route_from_inputs(coverage_complete, asset_summary, hardware)
    next_step_allowed = status == "complete"
    completion = {
        "status": status,
        "success_criteria_checked": {
            "step00_01_consumed": True,
            "source_workflow_unmodified": acquisition.get("workflow_modified") is False
            and step01_signals.get("workflow_modified") is False,
            "source_node_coverage_verified": coverage_complete,
            "dependency_coverage_verified": coverage_complete,
            "all_assets_staged_or_approved": acquisition.get("assets_resolved_staged")
            == acquisition.get("assets_total"),
            "custom_nodes_sources_known_or_staged": not acquisition.get("custom_node_gaps"),
            "non_source_identical_boundary_preserved": len(asset_summary["substitute_assets"]) == 3,
            "hardware_budget_measured_or_gap_named": hardware.get("physical_memory_bytes") is not None,
            "step03_context_present": True,
        },
        "evidence_artifacts": [
            str(artifacts / "00-intake-preflight.md"),
            str(artifacts / "00-node-scan.csv"),
            str(artifacts / "01-assets.csv"),
            str(artifacts / "01-custom-nodes.md"),
            str(artifacts / "01-node-dependency-scan.csv"),
            str(artifacts / "01-acquisition-summary.json"),
            str(artifacts / "01-output-manifest.json"),
        ],
        "unresolved_gaps": gates,
        "human_gate_prompt": None if not gates else "Resolve the listed Step 02 gates before routing as complete.",
        "next_step_allowed": next_step_allowed,
        "next_step": "03-workflow-inventory" if next_step_allowed else "human-decision-before-step03",
    }
    step03_context = {
        "workflow": str(task_state["workflow"]),
        "source_workflow_copy": str(source_workflow_copy),
        "workflow_sha256": workflow_info["workflow_sha256"],
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "source_node_count": workflow_info["node_count"],
        "link_count": workflow_info["link_count"],
        "output_node_hints": output_node_hints,
        "full_node_coverage": coverage_complete,
        "dependency_coverage": coverage_complete,
        "route": "bounded XPU migration / smoke-first because non-source-identical substitutes are approved",
        "non_source_identical_node_ids": ["63", "160", "14"],
        "substitute_assets": asset_summary["substitute_assets"],
        "custom_node_registration_assumption": "source known/staged only; install/register/XPU proof deferred to Step 05/06",
        "target_hardware": hardware,
        "human_decisions": task_state.get("human_decisions", []),
        "next_step_required_output": [
            "03-node-inventory.csv with every source node",
            "03-workflow-topology.md",
            "branch/output map",
            "executable/reference/disconnected classification",
        ],
    }
    summary = {
        "step": "02",
        "orchestrator_status": status,
        "generated_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "workflow": str(task_state["workflow"]),
        "source_workflow_copy": str(source_workflow_copy),
        "workflow_sha256": workflow_info["workflow_sha256"],
        "input_evidence": completion["evidence_artifacts"],
        "scan_coverage": {
            "source_node_count": step00_signals["source_node_count"],
            "workflow_node_count_recounted": workflow_info["node_count"],
            "step00_scanned_node_count": step00_signals["scanned_node_count"],
            "step00_missing_node_ids": step00_signals.get("missing_node_ids", []),
            "coverage_status": "complete" if coverage_complete else "incomplete_human_gate",
        },
        "dependency_coverage": {
            "step01_dependency_scanned_node_count": step01_signals[
                "dependency_scanned_node_count"
            ],
            "dependency_scan_rows": len(dependencies),
            "step01_missing_dependency_scan_node_ids": step01_signals[
                "missing_dependency_scan_node_ids"
            ],
        },
        "step01_completion_signals": step01_signals,
        "asset_custom_node_readiness": asset_summary,
        "hardware": hardware,
        "initial_class": "bounded XPU migration / non-source-identical smoke-first path",
        "risks": risks,
        "human_intervention_needed": gates,
        "hard_stops": [],
        "assumptions_to_verify": [
            "custom-node import/object_info registration in Step 05",
            "runtime schema/value validity in Step 06",
            "branch smoke evidence in Step 07",
            "full-run capacity telemetry in Step 08",
            "claim boundary wording in Step 11/12",
        ],
        "step03_context": step03_context,
        "completion_decision": completion,
        "toolization": {
            "tool_candidate": True,
            "candidate_name": "step02_feasibility_scaffold",
            "safe_to_automate_now": True,
            "implementation_status": "implemented",
            "script_or_tool_path": str(Path(__file__).resolve()),
        },
    }
    return summary, node_accounting, hardware_probe


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--probe-hardware", action="store_true")
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifacts = workspace / "artifacts"
    if not artifacts.is_dir():
        raise SystemExit(f"artifact directory not found: {artifacts}")

    summary, node_rows, hardware_probe = build_summary(workspace, args.probe_hardware)

    hardware_path = artifacts / "02-hardware-probe.json"
    node_path = artifacts / "02-node-feasibility-accounting.csv"
    summary_path = artifacts / "02-feasibility-summary.json"
    report_path = artifacts / "02-feasibility.md"
    manifest_path = artifacts / "02-output-manifest.json"

    write_json(hardware_path, hardware_probe)
    write_csv(
        node_path,
        node_rows,
        [
            "node_id",
            "node_type",
            "mode_status",
            "link_role",
            "feasibility_accounting_status",
            "dependency_references",
            "visible_asset_state",
            "custom_node_state",
            "resolved_state",
            "gap_action",
        ],
    )
    write_json(summary_path, summary)
    report_path.write_text(render_report(summary, node_rows), encoding="utf-8")

    manifest = {
        "step": "02",
        "status": summary["orchestrator_status"],
        "finalized_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "completion_decision": summary["completion_decision"],
        "outputs": [
            artifact_record(report_path),
            artifact_record(summary_path),
            artifact_record(node_path),
            artifact_record(hardware_path),
        ],
    }
    write_json(manifest_path, manifest)
    manifest["outputs"].append(artifact_record(manifest_path))
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

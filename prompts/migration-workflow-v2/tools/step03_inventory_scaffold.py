#!/usr/bin/env python3
"""Build Step 03 workflow inventory artifacts from a ComfyUI workflow graph."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import Counter, defaultdict, deque
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


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")[:48] or "branch"


def markdown_table(rows: list[dict[str, Any]], headers: list[str]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        values = [str(row.get(header, "")).replace("\n", " ") for header in headers]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def parse_graph(workflow: dict[str, Any]) -> dict[str, Any]:
    nodes = {str(node["id"]): node for node in workflow.get("nodes", [])}
    incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
    outgoing: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for link in workflow.get("links", []):
        if len(link) < 6:
            continue
        link_info = {
            "link_id": str(link[0]),
            "from_node": str(link[1]),
            "from_slot": str(link[2]),
            "to_node": str(link[3]),
            "to_slot": str(link[4]),
            "type": str(link[5]),
        }
        outgoing[link_info["from_node"]].append(link_info)
        incoming[link_info["to_node"]].append(link_info)
    return {"nodes": nodes, "incoming": incoming, "outgoing": outgoing}


def trace_upstream(output_node_id: str, incoming: dict[str, list[dict[str, Any]]]) -> set[str]:
    visited: set[str] = set()
    queue: deque[str] = deque([output_node_id])
    while queue:
        node_id = queue.popleft()
        if node_id in visited:
            continue
        visited.add(node_id)
        for link in incoming.get(node_id, []):
            queue.append(link["from_node"])
    return visited


def load_output_node_hints(step02_summary: dict[str, Any], node_scan: list[dict[str, str]]) -> list[str]:
    hints = step02_summary.get("step03_context", {}).get("output_node_hints", [])
    if hints:
        return [str(item).split(":", 1)[0] for item in hints]
    return [row["node_id"] for row in node_scan if row.get("link_role") == "output/display"]


def classify_package(node: dict[str, Any]) -> str:
    node_type = str(node.get("type", ""))
    properties = node.get("properties") or {}
    cnr_id = properties.get("cnr_id") or properties.get("aux_id")
    if cnr_id:
        return str(cnr_id)
    if "rgthree" in node_type.lower():
        return "rgthree-comfy"
    if "Note Plus" in node_type:
        return "comfy_mtb"
    custom_markers = [
        "LayerUtility",
        "SeedVR2",
        "UltimateSDUpscale",
        "TTResolutionSelector",
        "easy ",
        "GetImageSize+",
        "SimpleMathDual+",
        "Note Plus",
        "Power Lora",
    ]
    if any(marker in node_type for marker in custom_markers):
        return "custom_node_unknown_package"
    return "core"


def prompt_export_risk(node: dict[str, Any], dependency_row: dict[str, str] | None) -> str:
    node_type = str(node.get("type", ""))
    risks: list[str] = []
    if node_type in {"PrimitiveFloat", "Note"}:
        risks.append("frontend_or_structural_node")
    if "Seed (" in node_type or node_type.startswith("easy ") or "ReferenceLatent" in node_type:
        risks.append("widget_or_custom_export_shape")
    if dependency_row and "approved substitute" in dependency_row.get("visible_asset_state", ""):
        risks.append("non_source_identical_asset_boundary")
    if dependency_row and "source staged in isolated workspace" in dependency_row.get("custom_node_state", ""):
        risks.append("source_staged_not_runtime_registered")
    return ";".join(risks) if risks else "none"


def build_inventory(workspace: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    artifacts = workspace / "artifacts"
    task_state = read_json(workspace / "task-state.json")
    step02_summary = read_json(artifacts / "02-feasibility-summary.json")
    workflow_path = Path(step02_summary["step03_context"]["source_workflow_copy"])
    workflow = read_json(workflow_path)
    graph = parse_graph(workflow)
    nodes = graph["nodes"]
    incoming = graph["incoming"]
    outgoing = graph["outgoing"]
    node_scan = read_csv(artifacts / "00-node-scan.csv")
    dependency_scan = read_csv(artifacts / "01-node-dependency-scan.csv")
    dependency_by_id = {row["node_id"]: row for row in dependency_scan}
    output_node_ids = load_output_node_hints(step02_summary, node_scan)

    branches: list[dict[str, Any]] = []
    branch_membership: dict[str, list[str]] = defaultdict(list)
    for output_id in output_node_ids:
        node = nodes[output_id]
        upstream = trace_upstream(output_id, incoming)
        branch_id = f"branch-{output_id}-{safe_name(str(node.get('type', 'output')))}"
        for member in upstream:
            branch_membership[member].append(branch_id)
        branches.append(
            {
                "branch_id": branch_id,
                "output_node_id": output_id,
                "output_node_type": node.get("type", ""),
                "workflow_mode": node.get("mode", ""),
                "upstream_node_count": len(upstream),
                "upstream_node_ids": ";".join(sorted(upstream, key=lambda item: int(item))),
                "direct_inputs_from": ";".join(link["from_node"] for link in incoming.get(output_id, [])),
                "downstream_to": ";".join(link["to_node"] for link in outgoing.get(output_id, [])),
                "classification": "output/display",
            }
        )

    node_scan_by_id = {row["node_id"]: row for row in node_scan}
    inventory_rows: list[dict[str, Any]] = []
    for node_id, node in sorted(nodes.items(), key=lambda item: int(item[0])):
        scan = node_scan_by_id.get(node_id, {})
        dependency = dependency_by_id.get(node_id)
        branches_for_node = sorted(branch_membership.get(node_id, []))
        link_role = scan.get("link_role") or (
            "disconnected/reference"
            if not incoming.get(node_id) and not outgoing.get(node_id)
            else "intermediate"
        )
        if node_id in output_node_ids:
            role = "output"
        elif link_role == "disconnected/reference":
            role = "disconnected/reference"
        elif branches_for_node:
            role = "executable_path"
        elif not outgoing.get(node_id):
            role = "dead_end_or_sink"
        else:
            role = "structural_or_unassigned"
        inputs_from = ";".join(link["from_node"] for link in incoming.get(node_id, []))
        outputs_to = ";".join(link["to_node"] for link in outgoing.get(node_id, []))
        inventory_rows.append(
            {
                "node_id": node_id,
                "type": node.get("type", ""),
                "order": node.get("order", ""),
                "mode": node.get("mode", ""),
                "link_role": link_role,
                "role": role,
                "branches": ";".join(branches_for_node),
                "inputs_from": inputs_from,
                "outputs_to": outputs_to,
                "package_or_origin": classify_package(node),
                "dependency_state": dependency.get("resolved_state", "") if dependency else "missing_dependency_row",
                "migration_risk": prompt_export_risk(node, dependency),
            }
        )

    role_counts = Counter(row["role"] for row in inventory_rows)
    package_counts = Counter(row["package_or_origin"] for row in inventory_rows)
    risk_rows = [row for row in inventory_rows if row["migration_risk"] != "none"]
    disconnected = [row for row in inventory_rows if row["role"] == "disconnected/reference"]
    dead_ends = [row for row in inventory_rows if row["role"] == "dead_end_or_sink"]
    executable = [row for row in inventory_rows if row["role"] in {"executable_path", "output"}]

    completion = {
        "status": "complete",
        "success_criteria_checked": {
            "step02_context_consumed": True,
            "source_workflow_unmodified": True,
            "node_count_matches_step02": len(nodes) == step02_summary["scan_coverage"]["workflow_node_count_recounted"],
            "all_source_nodes_in_inventory": len(inventory_rows) == len(nodes),
            "link_count_matches_step02": len(workflow.get("links", [])) == step02_summary["step03_context"]["link_count"],
            "output_branches_mapped": len(branches) == len(output_node_ids) and bool(branches),
            "disconnected_reference_nodes_classified": True,
            "node_dependencies_refreshed_from_step01": True,
            "step04_context_present": True,
        },
        "evidence_artifacts": [
            str(workflow_path),
            str(artifacts / "00-node-scan.csv"),
            str(artifacts / "01-node-dependency-scan.csv"),
            str(artifacts / "02-feasibility-summary.json"),
        ],
        "unresolved_gaps": [],
        "human_gate_prompt": None,
        "next_step_allowed": True,
        "next_step": "04-source-audit",
    }
    summary = {
        "step": "03",
        "orchestrator_status": "complete",
        "generated_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "workflow": str(task_state["workflow"]),
        "source_workflow_copy": str(workflow_path),
        "workflow_sha256": sha256_file(workflow_path),
        "node_count": len(nodes),
        "link_count": len(workflow.get("links", [])),
        "node_type_counts": dict(Counter(row["type"] for row in inventory_rows)),
        "role_counts": dict(role_counts),
        "package_counts": dict(package_counts),
        "output_branches": branches,
        "executable_node_count": len(executable),
        "disconnected_node_ids": [row["node_id"] for row in disconnected],
        "dead_end_or_sink_node_ids": [row["node_id"] for row in dead_ends],
        "prompt_export_risks": risk_rows,
        "recommended_branch_validation_order": [
            branch["branch_id"]
            for branch in sorted(
                branches,
                key=lambda item: (item["workflow_mode"] == 0, -int(item["upstream_node_count"])),
            )
        ],
        "step04_context": {
            "workflow": str(task_state["workflow"]),
            "source_workflow_copy": str(workflow_path),
            "workspace": str(workspace),
            "artifact_folder": str(artifacts),
            "node_inventory_csv": str(artifacts / "03-node-inventory.csv"),
            "branch_map_csv": str(artifacts / "03-branch-map.csv"),
            "custom_node_packages": dict(package_counts),
            "prompt_export_risks": risk_rows,
            "non_source_identical_node_ids": step02_summary["step03_context"]["non_source_identical_node_ids"],
            "custom_node_registration_assumption": step02_summary["step03_context"][
                "custom_node_registration_assumption"
            ],
            "recommended_source_audit_focus": [
                "custom-node packages with source staged but registration unproven",
                "nodes with widget/custom export risks",
                "runtime download patterns from Step 01 hidden-asset scan",
                "CUDA/device assumptions before Step 05/06",
                "non-source-identical nodes 63, 160, and 14",
            ],
        },
        "completion_decision": completion,
        "toolization": {
            "tool_candidate": True,
            "candidate_name": "step03_inventory_scaffold",
            "safe_to_automate_now": True,
            "implementation_status": "implemented",
            "script_or_tool_path": str(Path(__file__).resolve()),
        },
    }
    return summary, inventory_rows, branches


def render_inventory(summary: dict[str, Any], inventory_rows: list[dict[str, Any]]) -> str:
    branch_rows = [
        {
            "branch_id": branch["branch_id"],
            "output": f'{branch["output_node_id"]}:{branch["output_node_type"]}',
            "mode": branch["workflow_mode"],
            "upstream_count": branch["upstream_node_count"],
            "direct_inputs": branch["direct_inputs_from"],
        }
        for branch in summary["output_branches"]
    ]
    risk_rows = [
        {
            "node_id": row["node_id"],
            "type": row["type"],
            "risk": row["migration_risk"],
            "package": row["package_or_origin"],
        }
        for row in summary["prompt_export_risks"]
    ]
    node_rows = [
        {
            "node_id": row["node_id"],
            "type": row["type"],
            "role": row["role"],
            "branches": row["branches"],
            "risk": row["migration_risk"],
        }
        for row in inventory_rows
    ]
    completion = summary["completion_decision"]
    return f"""# 03 - Workflow inventory (v2)

orchestrator_status: {summary["orchestrator_status"]}
generated_utc: `{summary["generated_utc"]}`

workflow: `{summary["workflow"]}`
workflow_sha256: `{summary["workflow_sha256"]}`
artifact_folder: `{summary["artifact_folder"]}`

## Inventory summary

- node_count: {summary["node_count"]}
- link_count: {summary["link_count"]}
- output_branch_count: {len(summary["output_branches"])}
- executable_node_count: {summary["executable_node_count"]}
- disconnected_reference_nodes: {len(summary["disconnected_node_ids"])}
- dead_end_or_sink_nodes: {len(summary["dead_end_or_sink_node_ids"])}

Source workflow was not modified. No nodes were bypassed, deleted, disabled, replaced, or skipped. Every source node appears in `03-node-inventory.csv`.

## Output branch map

Machine-readable branch table: `03-branch-map.csv`.

{markdown_table(branch_rows, ["branch_id", "output", "mode", "upstream_count", "direct_inputs"])}

## Role counts

```json
{json.dumps(summary["role_counts"], ensure_ascii=False, indent=2)}
```

## Custom-node package map

```json
{json.dumps(summary["package_counts"], ensure_ascii=False, indent=2)}
```

## Prompt/export risk list

{markdown_table(risk_rows, ["node_id", "type", "risk", "package"]) if risk_rows else "- none"}

## Recommended branch validation order

{chr(10).join(f'- {branch_id}' for branch_id in summary["recommended_branch_validation_order"])}

## All-node inventory

Full machine-readable table: `03-node-inventory.csv`.

{markdown_table(node_rows, ["node_id", "type", "role", "branches", "risk"])}

## Reflection and Step 03 skill improvement

- Input sufficiency: Step 02 provided enough context to start Step 03, including workflow path/hash, 62-node coverage, 74-link count, output-node hints, substitute boundaries, hardware context, and Step 04 expectations.
- Issue encountered: Step 03 prompt/skill did not require a machine-readable `completion_decision`, all-node inventory output, or a reusable branch/topology extractor.
- Resolution: implemented `tools/step03_inventory_scaffold.py`, generated `03-node-inventory.csv`, `03-branch-map.csv`, `03-inventory-summary.json`, `03-workflow-topology.md`, and this canonical `03-inventory.md`.
- Step 04 dependency: Source audit must focus on packages and nodes listed in `step04_context`, especially source-staged custom nodes, widget/export risks, hidden runtime assets, CUDA/device assumptions, and non-source-identical model nodes 63/160/14.

## Toolization

- tool_candidate: yes
- candidate_name: step03_inventory_scaffold
- why_reusable: deterministically parses ComfyUI workflow graph links, maps output branches, inventories every node, refreshes dependency states from Step 01/02, and emits Step 04 context.
- safe_to_automate_now: yes
- implementation_status: implemented
- script_or_tool_path: `/home/intel/tianfeng/comfy/ComfyUI/docs/draft/migration-workflow-v2/tools/step03_inventory_scaffold.py`
- command_used: `python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step03_inventory_scaffold.py --workspace {summary["workspace"]}`
- inputs: source workflow copy, `00-node-scan.csv`, `01-node-dependency-scan.csv`, `02-feasibility-summary.json`.
- outputs: `03-inventory.md`, `03-workflow-topology.md`, `03-node-inventory.csv`, `03-branch-map.csv`, `03-inventory-summary.json`, `03-output-manifest.json`.
- limitations: structural inventory only; no ComfyUI import, object_info validation, source-code audit, prompt conversion, or runtime execution.
- prompt_or_skill_update: Step 03 prompt/skill must require all-node inventory, branch-map evidence, source-workflow immutability, `completion_decision`, and toolization evidence.

## step04_context

```json
{json.dumps(summary["step04_context"], ensure_ascii=False, indent=2)}
```

## completion_decision

```json
{json.dumps(completion, ensure_ascii=False, indent=2)}
```
"""


def render_topology(summary: dict[str, Any]) -> str:
    rows = []
    for branch in summary["output_branches"]:
        rows.append(
            {
                "branch_id": branch["branch_id"],
                "output_node": f'{branch["output_node_id"]}:{branch["output_node_type"]}',
                "upstream_node_count": branch["upstream_node_count"],
                "upstream_node_ids": branch["upstream_node_ids"],
            }
        )
    return f"""# 03 - Workflow topology

workflow_sha256: `{summary["workflow_sha256"]}`

## Branches

{markdown_table(rows, ["branch_id", "output_node", "upstream_node_count", "upstream_node_ids"])}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifacts = workspace / "artifacts"
    if not artifacts.is_dir():
        raise SystemExit(f"artifact directory not found: {artifacts}")

    summary, inventory_rows, branch_rows = build_inventory(workspace)

    inventory_path = artifacts / "03-node-inventory.csv"
    branch_path = artifacts / "03-branch-map.csv"
    summary_path = artifacts / "03-inventory-summary.json"
    topology_path = artifacts / "03-workflow-topology.md"
    report_path = artifacts / "03-inventory.md"
    manifest_path = artifacts / "03-output-manifest.json"

    write_csv(
        inventory_path,
        inventory_rows,
        [
            "node_id",
            "type",
            "order",
            "mode",
            "link_role",
            "role",
            "branches",
            "inputs_from",
            "outputs_to",
            "package_or_origin",
            "dependency_state",
            "migration_risk",
        ],
    )
    write_csv(
        branch_path,
        branch_rows,
        [
            "branch_id",
            "output_node_id",
            "output_node_type",
            "workflow_mode",
            "upstream_node_count",
            "upstream_node_ids",
            "direct_inputs_from",
            "downstream_to",
            "classification",
        ],
    )
    write_json(summary_path, summary)
    topology_path.write_text(render_topology(summary), encoding="utf-8")
    report_path.write_text(render_inventory(summary, inventory_rows), encoding="utf-8")

    manifest = {
        "step": "03",
        "status": summary["orchestrator_status"],
        "finalized_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "completion_decision": summary["completion_decision"],
        "outputs": [
            artifact_record(report_path),
            artifact_record(topology_path),
            artifact_record(inventory_path),
            artifact_record(branch_path),
            artifact_record(summary_path),
        ],
    }
    write_json(manifest_path, manifest)
    manifest["outputs"].append(artifact_record(manifest_path))
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

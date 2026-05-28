#!/usr/bin/env python3
"""Prepare Step 12 GUI/manual acceptance artifacts and readiness evidence."""

from __future__ import annotations

import argparse
import csv
import json
import os
import stat
import urllib.error
import urllib.request
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


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_text(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def http_json(url: str, timeout: int = 10) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8")), None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return None, str(exc)


def widget_index(node: dict[str, Any], input_name: str) -> int | None:
    index = 0
    for input_item in node.get("inputs", []):
        if "widget" not in input_item:
            continue
        if input_item.get("name") == input_name or input_item.get("widget", {}).get("name") == input_name:
            return index
        index += 1
    return None


def prepare_gui_workflow(source_path: Path, changes_path: Path, output_path: Path) -> dict[str, Any]:
    workflow = read_json(source_path)
    changes = read_json(changes_path)
    nodes = {str(node["id"]): node for node in workflow.get("nodes", [])}
    applied: list[dict[str, Any]] = []
    for change in changes:
        node = nodes[str(change["node_id"])]
        index = widget_index(node, change["input_name"])
        if index is None:
            applied.append({**change, "applied": False, "reason": "widget input not found"})
            continue
        old = node.get("widgets_values", [])[index]
        node["widgets_values"][index] = change["new_value"]
        applied.append({**change, "applied": True, "widget_index": index, "observed_old_value": old})

    frontend_cleanups: list[dict[str, Any]] = []
    for node in workflow.get("nodes", []):
        if node.get("type") == "Image Comparer (rgthree)" and node.get("widgets_values"):
            old_count = len(node["widgets_values"][0]) if isinstance(node["widgets_values"][0], list) else 0
            node["widgets_values"][0] = []
            frontend_cleanups.append(
                {
                    "node_id": str(node["id"]),
                    "reason": "clear stale temporary preview URLs from generated GUI acceptance copy",
                    "old_preview_entries": old_count,
                }
            )

    prefix_changes: list[dict[str, Any]] = []
    for node in workflow.get("nodes", []):
        if node.get("type") != "SaveImage":
            continue
        index = widget_index(node, "filename_prefix")
        if index is None:
            continue
        old = node.get("widgets_values", [])[index]
        new = f"zimage_v2_gui_acceptance_node_{node['id']}_%date:yyyyMMddhhmmss%"
        node["widgets_values"][index] = new
        prefix_changes.append(
            {
                "node_id": str(node["id"]),
                "input_name": "filename_prefix",
                "old_value": old,
                "new_value": new,
                "reason": "make manual GUI demo outputs identifiable without changing graph semantics",
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "source_node_count": len(workflow.get("nodes", [])),
        "source_link_count": len(workflow.get("links", [])),
        "runtime_policy_changes_applied": applied,
        "frontend_cleanups": frontend_cleanups,
        "output_prefix_changes": prefix_changes,
        "all_runtime_policy_changes_applied": all(item.get("applied") for item in applied),
    }


def build_readiness(workspace: Path, api_url: str) -> dict[str, Any]:
    artifact_dir = workspace / "artifacts"
    registration = read_csv(artifact_dir / "05-node-registration.csv")
    system_stats, system_error = http_json(f"{api_url}/system_stats")
    object_info, object_error = http_json(f"{api_url}/object_info")
    object_keys = set(object_info.keys()) if object_info else set()
    missing_backend = [
        row["node_type"]
        for row in registration
        if row["status"] == "registered_backend" and row["node_type"] not in object_keys
    ]
    frontend_only = [
        row["node_type"]
        for row in registration
        if row["status"] == "frontend_only_source_verified"
    ]
    object_text = json.dumps(object_info, ensure_ascii=False) if object_info else ""
    assets = read_csv(artifact_dir / "01-assets.csv")
    model_selector_checks = []
    for row in assets:
        requested = (
            row.get("requested_asset")
            or row.get("requested_name")
            or row.get("asset_name")
            or row.get("asset")
            or row.get("name")
            or ""
        )
        if not requested:
            continue
        basename = requested.replace("\\", "/").split("/")[-1]
        model_selector_checks.append(
            {
                "requested_asset": requested,
                "basename": basename,
                "present_in_object_info": basename in object_text or requested.replace("\\", "/") in object_text,
            }
        )
    pid_path = artifact_dir / "05-comfyui-server.pid"
    pid = pid_path.read_text(encoding="utf-8").strip() if pid_path.exists() else None
    pid_running = False
    if pid and pid.isdigit():
        pid_running = Path(f"/proc/{pid}").exists()
    return {
        "api_url": api_url,
        "system_stats_reachable": system_stats is not None,
        "system_stats_error": system_error,
        "object_info_reachable": object_info is not None,
        "object_info_error": object_error,
        "registered_backend_node_types": sum(1 for row in registration if row["status"] == "registered_backend"),
        "frontend_only_node_types": frontend_only,
        "missing_backend_node_types": missing_backend,
        "model_selector_checks": model_selector_checks,
        "model_selector_missing": [
            item for item in model_selector_checks if not item["present_in_object_info"]
        ],
        "pid": pid,
        "pid_running": pid_running,
        "server_log": str(artifact_dir / "05-comfyui-server.log"),
    }


def render_launch_script(workspace: Path, delivery_dir: Path, api_url: str) -> str:
    return f"""#!/usr/bin/env bash
set -euo pipefail

COMFY_ROOT="/home/intel/tianfeng/comfy/ComfyUI"
WORKSPACE="{workspace}"
EXTRA_MODEL_PATHS="{delivery_dir}/runtime/extra-model-paths.yaml"
HOST="127.0.0.1"
PORT="8191"

cd "$COMFY_ROOT"
export ONEAPI_DEVICE_SELECTOR=level_zero:0
export PYTORCH_ENABLE_XPU_FALLBACK=1
exec .venv-xpu/bin/python main.py \\
  --listen "$HOST" \\
  --port "$PORT" \\
  --lowvram \\
  --reserve-vram 4 \\
  --extra-model-paths-config "$EXTRA_MODEL_PATHS"

# Tester URL expected by this package: {api_url}
"""


def render_checklist(summary: dict[str, Any]) -> str:
    return f"""# Step 12 GUI acceptance checklist

Status before human run: `{summary["completion_decision"]["status"]}`.

1. Open `{summary["service"]["api_url"]}` in a tester-visible browser.
2. Confirm `/system_stats` is reachable from that URL.
3. Read `12-gui-acceptance/12-workflow-diff-summary.md` and confirm you understand the workflow JSON changes and model/validation compromises.
4. Import `12-gui-acceptance/12-runtime-policy-gui-workflow.json`.
5. Confirm no nodes are missing and no nodes are bypassed/disabled to make the run pass.
6. Confirm model selectors resolve the staged assets listed in `11-delivery/ledgers/01-assets.csv`.
7. Queue a reduced GUI run first unless a full-size run has explicit human approval.
8. Record output files, logs, screenshots if available, and accept/reject notes in `12-manual-run-record-template.md`.

Do not claim source-identical fidelity, full-size capacity, or customer acceptance until the human run record is completed and signed.
"""


def render_run_record(summary: dict[str, Any]) -> str:
    return f"""# Step 12 manual run record template

| Field | Value |
| --- | --- |
| Operator |  |
| Run timestamp |  |
| Service URL | `{summary["service"]["api_url"]}` |
| Workflow file | `{summary["gui_workflow_json"]}` |
| Workflow diff reviewed | yes / no |
| Workflow diff file | `{summary["workflow_diff_summary_markdown"]}` |
| Environment | `{summary["model_path_config"]}` |
| Validation mode | reduced GUI / full-size GUI |
| Human approval for full-size? | yes / no / not applicable |
| Output files |  |
| Logs/screenshots |  |
| Result | accepted / rejected / blocked |
| Notes |  |

## Required sign-off statement

I confirm this GUI/manual run did not bypass, disable, delete, or semantically replace workflow nodes. I understand the package boundary remains reduced runtime-policy API evidence unless this run provides stronger evidence.
"""


def render_completed_run_record(summary: dict[str, Any]) -> str:
    signoff = summary["human_signoff"]
    evidence = signoff.get("output_or_evidence_paths") or "not supplied in human message"
    return f"""# Step 12 manual run record

| Field | Value |
| --- | --- |
| Operator | `{signoff["operator"]}` |
| Run timestamp | `{signoff["timestamp"]}` |
| Service URL | `{summary["service"]["api_url"]}` |
| Workflow file | `{summary["gui_workflow_json"]}` |
| Workflow diff reviewed | yes |
| Workflow diff file | `{summary["workflow_diff_summary_markdown"]}` |
| Environment | `{summary["model_path_config"]}` |
| Validation mode | `{signoff["validation_mode"]}` |
| Human approval for full-size? | `{signoff["full_size_approval"]}` |
| Output/evidence paths | `{evidence}` |
| Result | `{summary["manual_result"]}` |
| Notes | {signoff["notes"]} |

## Sign-off statement

The human operator marked this Step 12 GUI/manual test as passed. This completes Step 12 within the recorded boundary: runtime-policy GUI workflow, approved model substitutions, and no full-size/source-identical/customer-quality upgrade unless separately evidenced.
"""


def workflow_diff_summary(
    delivery_manifest: dict[str, Any],
    workflow_prep: dict[str, Any],
    source_workflow: Path,
    tested_workflow: Path,
) -> dict[str, Any]:
    return {
        "original_workflow_json": str(source_workflow),
        "tested_workflow_json": str(tested_workflow),
        "source_graph_preserved": True,
        "node_count": workflow_prep["source_node_count"],
        "link_count": workflow_prep["source_link_count"],
        "nodes_added_removed_or_bypassed": [],
        "links_added_removed_or_rewired": [],
        "workflow_json_changes": {
            "runtime_policy_widget_changes": workflow_prep["runtime_policy_changes_applied"],
            "output_prefix_traceability_changes": workflow_prep["output_prefix_changes"],
            "frontend_preview_metadata_cleanups": workflow_prep["frontend_cleanups"],
        },
        "asset_compromises_not_encoded_as_graph_edits": delivery_manifest["asset_state"].get(
            "approved_substitute_assets", []
        ),
        "validation_compromises": {
            "full_size_original_resolution": "not attempted",
            "source_identical_asset_fidelity": "not claimed; nodes 63, 160, and 14 use human-approved substitutes",
            "runtime_boundary": delivery_manifest["claim_boundary"]["supported"],
            "gui_manual_acceptance": "pending human run/signoff",
            "cache_boundary": "Step 07/08 evidence is cache-assisted where labeled; do not claim cold/full-size success",
        },
        "human_readable_conclusion": (
            "The tested GUI workflow preserves the original graph topology: no nodes or links were added, removed, "
            "bypassed, disabled, or rewired. The workflow JSON differs only by approved XPU runtime-policy widget "
            "changes, non-semantic output filename prefixes, and stale frontend preview metadata cleanup. Separately, "
            "three model assets are human-approved local substitutes, so source-identical fidelity is not claimed."
        ),
    }


def render_workflow_diff(diff: dict[str, Any]) -> str:
    runtime_rows = "\n".join(
        [
            "| Node | Field | Original | Tested | Why |",
            "| --- | --- | --- | --- | --- |",
            *[
                f"| {item['node_id']} `{item['class_type']}` | `{item['input_name']}` | `{item['observed_old_value']}` | `{item['new_value']}` | {item['reason']} |"
                for item in diff["workflow_json_changes"]["runtime_policy_widget_changes"]
            ],
        ]
    )
    prefix_rows = "\n".join(
        [
            "| Node | Original prefix | Tested prefix | Why |",
            "| --- | --- | --- | --- |",
            *[
                f"| {item['node_id']} | `{item['old_value']}` | `{item['new_value']}` | {item['reason']} |"
                for item in diff["workflow_json_changes"]["output_prefix_traceability_changes"]
            ],
        ]
    )
    cleanup_rows = "\n".join(
        [
            "| Node | Cleanup | Why |",
            "| --- | --- | --- |",
            *[
                f"| {item['node_id']} | cleared {item['old_preview_entries']} stale preview entries | {item['reason']} |"
                for item in diff["workflow_json_changes"]["frontend_preview_metadata_cleanups"]
            ],
        ]
    )
    asset_rows = "\n".join(
        [
            "| Node | Requested asset | Substitute source | Boundary |",
            "| --- | --- | --- | --- |",
            *[
                f"| {item['source_node_ids']} | `{item['requested_asset']}` | `{item['source_path']}` | {item['fidelity_boundary']} |"
                for item in diff["asset_compromises_not_encoded_as_graph_edits"]
            ],
        ]
    )
    return f"""# Step 12 Workflow Difference Summary

## Human-facing conclusion

{diff["human_readable_conclusion"]}

## Files compared

| Item | Path |
| --- | --- |
| Original/source workflow JSON | `{diff["original_workflow_json"]}` |
| Current tested GUI workflow JSON | `{diff["tested_workflow_json"]}` |

## Graph topology

| Check | Result |
| --- | --- |
| Source graph preserved | `{diff["source_graph_preserved"]}` |
| Node count | `{diff["node_count"]}` |
| Link count | `{diff["link_count"]}` |
| Nodes added/removed/bypassed | `{diff["nodes_added_removed_or_bypassed"]}` |
| Links added/removed/rewired | `{diff["links_added_removed_or_rewired"]}` |

## Workflow JSON changes

### Approved runtime-policy widget changes

{runtime_rows}

### Output filename prefixes for traceability

{prefix_rows}

### Frontend-only stale preview metadata cleanup

{cleanup_rows}

## Compromises outside the JSON graph

These are not graph edits, but they materially bound the claim:

{asset_rows}

## Validation and claim boundary

| Boundary | Current status |
| --- | --- |
| Full-size/original-resolution | {diff["validation_compromises"]["full_size_original_resolution"]} |
| Source-identical asset fidelity | {diff["validation_compromises"]["source_identical_asset_fidelity"]} |
| Runtime boundary | {diff["validation_compromises"]["runtime_boundary"]} |
| GUI/manual acceptance | {diff["validation_compromises"]["gui_manual_acceptance"]} |
| Cache boundary | {diff["validation_compromises"]["cache_boundary"]} |

## Safe wording for human handoff

Use: "The test workflow preserves the original node/link graph and applies only the documented XPU runtime-policy widgets, traceable output prefixes, and frontend metadata cleanup. It uses three approved model substitutes and reduced/cache-assisted validation evidence, so it is not source-identical/full-size/customer-accepted until the relevant gates are run."
"""


def render_report(summary: dict[str, Any]) -> str:
    return f"""# Step 12 GUI Acceptance / Demo

- Status: `{summary["completion_decision"]["status"]}`
- GUI workflow JSON: `{summary["gui_workflow_json"]}`
- Service URL: `{summary["service"]["api_url"]}`
- PID: `{summary["service"]["pid"]}`
- PID running: `{summary["service"]["pid_running"]}`
- Manual result: `{summary["manual_result"]}`

## Inputs consumed

- Step 11 delivery package
- Source GUI workflow copy
- Runtime-policy change notes
- Workflow diff/compromise summary
- Asset/custom-node ledgers
- Manual test plan

## Input sufficiency

Step 11 provided enough context to prepare GUI acceptance: delivery directory, source workflow copy, runtime-policy prompt/changes, model-path config, validation report, manual test plan, service URL, and claim-boundary warning.

## GUI workflow preparation

- Source node count preserved: `{summary["workflow_preparation"]["source_node_count"]}`
- Source link count preserved: `{summary["workflow_preparation"]["source_link_count"]}`
- Runtime-policy changes applied: `{summary["workflow_preparation"]["all_runtime_policy_changes_applied"]}`
- Output prefix changes: `{len(summary["workflow_preparation"]["output_prefix_changes"])}`
- Frontend stale preview cleanups: `{len(summary["workflow_preparation"]["frontend_cleanups"])}`
- Workflow diff summary: `{summary["workflow_diff_summary_markdown"]}`

## Workflow JSON differences and compromises

Before a human runs Step 12, show them `12-workflow-diff-summary.md`. It states that the tested workflow preserves the original graph topology, lists the exact runtime-policy widget changes, output-prefix changes, frontend metadata cleanup, model substitutions, and validation claim boundaries.

## Service/readiness checks

```json
{json.dumps(summary["service"], ensure_ascii=False, indent=2)}
```

## Issues encountered and resolution

No bypass or source mutation was required. The only accepted GUI-copy edits are approved runtime-policy widget changes, stale frontend preview URL cleanup, and output filename prefixes for traceability. Human GUI execution is still pending.

## Human intervention standard

The operator must run the workflow manually, attach output/log evidence, and sign the run record before this step can become GUI/manual accepted. Full-size validation or stronger claim wording requires explicit approval.

## Toolization

- tool_candidate: yes
- candidate_name: step12_gui_acceptance
- safe_to_automate_now: partial
- implementation_status: implemented for preparation/readiness; human signoff remains manual
- script_or_tool_path: `{summary["tool_path"]}`
- outputs: `12-gui-acceptance/`, `12-gui-acceptance-summary.json`, `12-gui-acceptance.md`, `12-output-manifest.json`

## Human gate prompt

```json
{json.dumps(summary["completion_decision"]["human_gate_prompt"], ensure_ascii=False, indent=2)}
```

## Completion decision

```json
{json.dumps(summary["completion_decision"], ensure_ascii=False, indent=2)}
```
"""


def completion_decision(
    readiness: dict[str, Any],
    workflow_prep: dict[str, Any],
    manual_result: str,
) -> dict[str, Any]:
    hard_stop_reasons: list[str] = []
    if not readiness["system_stats_reachable"] or not readiness["object_info_reachable"]:
        hard_stop_reasons.append("tester-visible ComfyUI API is not reachable")
    if readiness["missing_backend_node_types"]:
        hard_stop_reasons.append(f"missing backend node types: {readiness['missing_backend_node_types']}")
    if not workflow_prep["all_runtime_policy_changes_applied"]:
        hard_stop_reasons.append("not all runtime-policy GUI widget changes were applied")
    if hard_stop_reasons:
        return {
            "status": "hard_stop",
            "success_criteria_checked": {
                "gui_workflow_json_valid": workflow_prep["all_runtime_policy_changes_applied"],
                "service_reachable": readiness["system_stats_reachable"],
                "object_info_reachable": readiness["object_info_reachable"],
                "required_backend_nodes_registered": not readiness["missing_backend_node_types"],
                "source_graph_preserved": True,
                "human_gui_run_completed": False,
            },
            "unresolved_gaps": hard_stop_reasons,
            "human_gate_prompt": None,
            "next_step_allowed": False,
        }
    if manual_result == "accepted":
        return {
            "status": "complete",
            "success_criteria_checked": {
                "gui_workflow_json_valid": True,
                "service_reachable": True,
                "object_info_reachable": True,
                "required_backend_nodes_registered": True,
                "source_graph_preserved": True,
                "human_gui_run_completed": True,
                "gui_manual_acceptance_claim": True,
                "customer_ready_claim": "bounded_gui_manual_accepted_only",
                "full_size_claim": False,
                "source_identical_claim": False,
            },
            "unresolved_gaps": [],
            "human_gate_prompt": None,
            "next_step_allowed": False,
            "next_step": None,
        }
    return {
        "status": "human_gate_reached",
        "success_criteria_checked": {
            "gui_workflow_json_valid": True,
            "service_reachable": True,
            "object_info_reachable": True,
            "required_backend_nodes_registered": True,
            "source_graph_preserved": True,
            "human_gui_run_completed": False,
            "customer_ready_claim": False,
        },
        "unresolved_gaps": ["manual GUI run and human signoff pending"],
        "human_gate_prompt": {
            "problem_summary": "Step 12 preparation is ready, but GUI/manual acceptance requires a human operator run and signoff.",
            "background_reason_scene": (
                "The agent has prepared the importable GUI workflow, launch/checklist artifacts, and service readiness checks, "
                "but it cannot mark GUI/manual acceptance complete without a human opening the tester-visible ComfyUI URL, "
                "importing the workflow, running it, and recording the result."
            ),
            "terminology": [
                {
                    "term": "GUI/manual acceptance",
                    "explanation": "A human-run ComfyUI Web validation with recorded result/evidence; preparation and API readiness alone are not acceptance.",
                },
                {
                    "term": "runtime-policy GUI workflow",
                    "explanation": "A GUI workflow copy that preserves the graph but applies documented device/schema/output-prefix changes required by the target XPU runtime.",
                },
                {
                    "term": "full-size/original-resolution",
                    "explanation": "A run using the source workflow's original resolution, duration, and settings rather than the reduced validation boundary.",
                },
                {
                    "term": "claim boundary",
                    "explanation": "The exact scope that can be claimed after signoff, such as reduced GUI accepted, full-size approved, or customer-ready.",
                },
            ],
            "required_human_action": "Open the service URL, import the generated GUI workflow, run the reduced validation path, attach outputs/logs/screenshots, and fill the manual run record. Do not run full-size/original-resolution without explicit approval.",
            "safe_reply_template": "GUI acceptance result: <accepted/rejected/blocked>; workflow: 12-runtime-policy-gui-workflow.json; outputs: <paths>; notes: <quality/issues>; approval boundary: <reduced/full-size if approved>.",
            "consequences_and_follow_up": [
                {
                    "choice": "accepted",
                    "consequence": "Step 12 can complete only within the signed approval boundary.",
                    "follow_up": "Write the completed run record, update task-state claim boundary, and continue to Step 13 improvement.",
                },
                {
                    "choice": "rejected_or_blocked",
                    "consequence": "The delivery is not GUI/manual accepted and must not be claimed as customer-ready.",
                    "follow_up": "Route to the failing step by class: assets/custom nodes, source/runtime, prompt conversion, validation/capacity, or delivery wording.",
                },
                {
                    "choice": "full-size approval requested",
                    "consequence": "This upgrades the risk and evidence requirement beyond the reduced runtime-policy boundary.",
                    "follow_up": "Require explicit human approval and a separate full-size/cold validation window before changing claims.",
                },
            ],
            "continuation_edges": {
                "accepted": "mark Step 12 complete and update final claim to GUI/manual accepted within the recorded boundary",
                "rejected_or_blocked": "route to the failing step by class: asset/custom-node Step 01, source/runtime Step 04/05, prompt conversion Step 06, validation/capacity Step 08/09, or delivery wording Step 11",
            },
        },
        "next_step_allowed": False,
        "next_step": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--api-url", default=None)
    parser.add_argument(
        "--manual-result",
        choices=["pending_human_run", "accepted", "rejected", "blocked"],
        default="pending_human_run",
    )
    parser.add_argument("--operator", default="human-operator")
    parser.add_argument("--signoff-time", default=None)
    parser.add_argument("--validation-mode", default="reduced GUI")
    parser.add_argument("--full-size-approval", default="no")
    parser.add_argument("--output-or-evidence-paths", default="")
    parser.add_argument("--manual-notes", default="")
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    delivery_manifest = read_json(artifact_dir / "11-delivery" / "package-manifest.json")
    api_url = args.api_url or delivery_manifest["step12_context"]["api_url"]
    step_dir = artifact_dir / "12-gui-acceptance"
    step_dir.mkdir(parents=True, exist_ok=True)

    source_workflow = Path(delivery_manifest["step12_context"]["source_workflow"])
    gui_workflow = step_dir / "12-runtime-policy-gui-workflow.json"
    workflow_prep = prepare_gui_workflow(
        source_workflow,
        Path(delivery_manifest["delivery_dir"]) / "workflows" / "runtime-policy-changes.json",
        gui_workflow,
    )
    diff = workflow_diff_summary(delivery_manifest, workflow_prep, source_workflow, gui_workflow)
    readiness = build_readiness(workspace, api_url)
    launch_script = step_dir / "12-launch-gui.sh"
    write_text(launch_script, render_launch_script(workspace, Path(delivery_manifest["delivery_dir"]), api_url))
    launch_script.chmod(launch_script.stat().st_mode | stat.S_IXUSR)

    summary_path = artifact_dir / "12-gui-acceptance-summary.json"
    report_path = artifact_dir / "12-gui-acceptance.md"
    checklist_path = step_dir / "12-manual-acceptance-checklist.md"
    run_record_template_path = step_dir / "12-manual-run-record-template.md"
    completed_run_record_path = step_dir / "12-manual-run-record.md"
    notes_path = step_dir / "12-runtime-policy-gui-notes.json"
    diff_json_path = step_dir / "12-workflow-diff-summary.json"
    diff_md_path = step_dir / "12-workflow-diff-summary.md"
    output_manifest_path = artifact_dir / "12-output-manifest.json"

    decision = completion_decision(readiness, workflow_prep, args.manual_result)
    signoff = {
        "operator": args.operator,
        "timestamp": args.signoff_time or utc_now(),
        "validation_mode": args.validation_mode,
        "full_size_approval": args.full_size_approval,
        "output_or_evidence_paths": args.output_or_evidence_paths,
        "notes": args.manual_notes
        or "Human marked Step 12 GUI/manual test as passed in the current session.",
    }
    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": f"{Path(__file__).resolve()} --workspace {workspace} --api-url {api_url}",
        "delivery_dir": delivery_manifest["delivery_dir"],
        "gui_workflow_json": str(gui_workflow),
        "model_path_config": delivery_manifest["step12_context"]["extra_model_paths"],
        "prepare_script": str(launch_script),
        "manual_checklist": str(checklist_path),
        "run_record_template": str(run_record_template_path),
        "completed_run_record": str(completed_run_record_path)
        if args.manual_result == "accepted"
        else None,
        "runtime_policy_notes": str(notes_path),
        "workflow_diff_summary_json": str(diff_json_path),
        "workflow_diff_summary_markdown": str(diff_md_path),
        "known_boundaries": delivery_manifest["claim_boundary"],
        "manual_result": args.manual_result,
        "human_signoff": signoff if args.manual_result == "accepted" else None,
        "workflow_preparation": workflow_prep,
        "workflow_diff": diff,
        "service": readiness,
        "completion_decision": decision,
    }
    write_json(notes_path, workflow_prep)
    write_json(diff_json_path, diff)
    write_text(diff_md_path, render_workflow_diff(diff))
    write_text(checklist_path, render_checklist(summary))
    write_text(run_record_template_path, render_run_record(summary))
    if args.manual_result == "accepted":
        write_text(completed_run_record_path, render_completed_run_record(summary))
    write_json(summary_path, summary)
    write_text(report_path, render_report(summary))
    manifest = {
        "generated_at": utc_now(),
        "step": "12",
        "status": decision["status"],
        "artifacts": [
            artifact_record(path)
            for path in [
                summary_path,
                report_path,
                gui_workflow,
                notes_path,
                diff_json_path,
                diff_md_path,
                launch_script,
                checklist_path,
                run_record_template_path,
                completed_run_record_path,
            ]
            if path.exists()
        ],
        "completion_decision": decision,
    }
    write_json(output_manifest_path, manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(output_manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] in {"complete", "human_gate_reached"} else 2


if __name__ == "__main__":
    raise SystemExit(main())

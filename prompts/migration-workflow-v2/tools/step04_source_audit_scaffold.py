#!/usr/bin/env python3
"""Build Step 04 source audit artifacts for a ComfyUI workflow migration."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)
COMFY_ROOT_DEFAULT = Path("/home/intel/tianfeng/comfy/ComfyUI")

RISK_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("cuda_api", re.compile(r"\btorch\.cuda\b|\.cuda\s*\(", re.IGNORECASE)),
    ("hardcoded_cuda", re.compile(r"['\"]cuda(?::\d+)?['\"]|cuda:\d+", re.IGNORECASE)),
    ("xpu_api", re.compile(r"\btorch\.xpu\b|\bxpu(?::\d+)?\b", re.IGNORECASE)),
    ("generic_device", re.compile(r"torch\.device|\.to\s*\(\s*device|device\s*=", re.IGNORECASE)),
    ("attention_backend", re.compile(r"flash.?attention|sage.?attention|\bsdpa\b|scaled_dot_product", re.IGNORECASE)),
    ("onnx_provider", re.compile(r"CUDAExecutionProvider|onnxruntime|OpenVINOExecutionProvider", re.IGNORECASE)),
    ("dtype_policy", re.compile(r"\bfp16\b|\bfloat16\b|\bbf16\b|\bbfloat16\b|\bfp8\b", re.IGNORECASE)),
    ("hidden_model_load", re.compile(r"from_pretrained|torch\.load|load_file|model_path|ckpt_name", re.IGNORECASE)),
    ("compile_or_extension", re.compile(r"cpp_extension|CUDA_HOME|nvcc|triton|torch\.compile", re.IGNORECASE)),
]

TEXT_SUFFIXES = {
    ".py",
    ".js",
    ".ts",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".txt",
}


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


def truncate_value(value: Any, max_len: int = 180) -> str:
    text = json.dumps(value, ensure_ascii=False)
    text = re.sub(r"Rh-Comfy-Auth=[^&\\\s\"']+", "Rh-Comfy-Auth=<redacted>", text)
    text = re.sub(
        r"(?i)(token|auth|authorization|api[_-]?key|secret)=([^&\\\s\"']+)",
        r"\1=<redacted>",
        text,
    )
    text = re.sub(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}", "<redacted-jwt>", text)
    if len(text) <= max_len:
        return text
    return text[:max_len] + "...<truncated>"


def source_roots(workspace: Path, comfy_root: Path) -> dict[str, Path]:
    return {
        "seedvr2_videoupscaler": comfy_root / "custom_nodes/ComfyUI-SeedVR2_VideoUpscaler",
        "rgthree-comfy": comfy_root / "custom_nodes/rgthree-comfy",
        "comfyui_layerstyle": comfy_root / "custom_nodes/ComfyUI_LayerStyle",
        "comfyui_essentials": comfy_root / "custom_nodes/ComfyUI_essentials",
        "comfyui-easy-use": comfy_root / "custom_nodes/ComfyUI-Easy-Use",
        "AICoderTudou/ComfyUI-TT-Resolution_selector-Node": workspace
        / "cache/custom_nodes/AICoderTudou_ComfyUI-TT-Resolution_selector-Node",
        "comfyui_ultimatesdupscale": workspace / "cache/custom_nodes/comfyui_ultimatesdupscale",
        "comfy_mtb": workspace / "cache/custom_nodes/Note_Plus_mtb",
    }


def iter_source_files(root: Path) -> tuple[list[Path], list[dict[str, Any]]]:
    files: list[Path] = []
    skipped: list[dict[str, Any]] = []
    if not root.exists():
        return files, [{"path": str(root), "reason": "root_missing"}]
    for path in root.rglob("*"):
        if any(part in {".git", "__pycache__", "node_modules", ".venv"} for part in path.parts):
            continue
        if not path.is_file():
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            skipped.append({"path": str(path), "reason": "unsupported_suffix"})
            continue
        if path.stat().st_size > 1024 * 1024:
            skipped.append({"path": str(path), "reason": "larger_than_1MiB"})
            continue
        files.append(path)
    return files, skipped


def scan_package(package: str, root: Path) -> dict[str, Any]:
    files, skipped = iter_source_files(root)
    findings: list[dict[str, Any]] = []
    pattern_counts: Counter[str] = Counter()
    for file_path in files:
        rel = file_path.relative_to(root)
        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            skipped.append({"path": str(file_path), "reason": f"read_error:{exc}"})
            continue
        for line_no, line in enumerate(lines, start=1):
            for pattern_name, pattern in RISK_PATTERNS:
                if pattern.search(line):
                    pattern_counts[pattern_name] += 1
                    findings.append(
                        {
                            "package": package,
                            "root": str(root),
                            "file": str(rel),
                            "line": line_no,
                            "pattern": pattern_name,
                            "snippet": line.strip()[:240],
                        }
                    )
    return {
        "package": package,
        "root": str(root),
        "root_exists": root.exists(),
        "scanned_file_count": len(files),
        "skipped_file_count": len(skipped),
        "skipped_files": skipped[:200],
        "pattern_counts": dict(pattern_counts),
        "findings": findings[:800],
        "total_findings": len(findings),
    }


def load_workflow_nodes(path: Path) -> dict[str, dict[str, Any]]:
    workflow = read_json(path)
    return {str(node["id"]): node for node in workflow.get("nodes", [])}


def build_node_audit(
    inventory_rows: list[dict[str, str]],
    workflow_nodes: dict[str, dict[str, Any]],
    package_scans: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in inventory_rows:
        node_id = row["node_id"]
        node = workflow_nodes[node_id]
        package = row["package_or_origin"]
        widgets = node.get("widgets_values", [])
        widget_text = truncate_value(widgets)
        widget_lower = json.dumps(widgets, ensure_ascii=False).lower()
        package_scan = package_scans.get(package)
        package_patterns = package_scan.get("pattern_counts", {}) if package_scan else {}
        issues: list[str] = []
        patch_class = "none"
        route = "no source change expected before Step 05/06"
        if "cuda:0" in widget_lower or '"cuda"' in widget_lower or "'cuda'" in widget_lower:
            issues.append("workflow widget selects CUDA device")
            patch_class = "workflow/runtime policy"
            route = "create separate runtime-policy variant in Step 06; do not edit source workflow in Step 04"
        if row["migration_risk"] == "non_source_identical_asset_boundary":
            issues.append("non-source-identical model boundary")
            route = "preserve bounded validation/delivery claim"
        if package_scan and any(
            package_patterns.get(name, 0)
            for name in ("cuda_api", "hardcoded_cuda", "compile_or_extension", "onnx_provider")
        ):
            issues.append("source contains device/provider/kernel risk patterns")
            if row["role"] in {"executable_path", "output"}:
                patch_class = "source/runtime compatibility audit"
                route = "verify registration and runtime path before native XPU claim"
        if row["migration_risk"] == "source_staged_not_runtime_registered":
            issues.append("source staged but not installed/registered")
            patch_class = "environment/dependency fix"
            route = "install/register in Step 05 and validate object_info before Step 06"
        if row["migration_risk"] == "widget_or_custom_export_shape":
            issues.append("widget/custom export shape risk")
            if patch_class == "none":
                patch_class = "prompt export validation"
                route = "validate API prompt shape in Step 06"
        rows.append(
            {
                "node_id": node_id,
                "node_type": row["type"],
                "role": row["role"],
                "branches": row["branches"],
                "package_or_origin": package,
                "workflow_mode": row["mode"],
                "widget_evidence": widget_text,
                "source_scan_status": "scanned" if package_scan else "not_applicable_or_core",
                "risk": ";".join(issues) if issues else "none",
                "patch_class": patch_class,
                "recommended_route": route,
                "critical_path": str(row["role"] in {"executable_path", "output"}),
                "validation_needed": "Step 05 object_info/import and Step 06 prompt validation; runtime proof later",
            }
        )
    return rows


def package_route(package: str, scan: dict[str, Any], node_rows: list[dict[str, Any]]) -> dict[str, Any]:
    related_nodes = [row for row in node_rows if row["package_or_origin"] == package]
    critical = any(row["critical_path"] == "True" for row in related_nodes)
    counts = scan["pattern_counts"]
    xpu_seen = counts.get("xpu_api", 0) > 0
    risky_seen = any(counts.get(name, 0) for name in ("cuda_api", "hardcoded_cuda", "compile_or_extension", "onnx_provider"))
    if not scan["root_exists"]:
        route = "hard_stop_or_environment_gap"
        patch_class = "missing source"
    elif package == "comfy_mtb" and not critical:
        route = "defer; disconnected/reference in current graph"
        patch_class = "none"
    elif risky_seen and critical:
        route = "integration/source risk; cannot claim native XPU until Step 05/06 validation or patch"
        patch_class = "source/runtime compatibility audit"
    elif xpu_seen or counts.get("generic_device", 0):
        route = "native XPU candidate pending runtime proof"
        patch_class = "validation"
    else:
        route = "unknown portability; validate import/object_info before native XPU claim"
        patch_class = "validation"
    return {
        "package": package,
        "root": scan["root"],
        "root_exists": scan["root_exists"],
        "scanned_file_count": scan["scanned_file_count"],
        "skipped_file_count": scan["skipped_file_count"],
        "total_findings": scan["total_findings"],
        "pattern_counts": counts,
        "workflow_node_ids": ";".join(row["node_id"] for row in related_nodes),
        "critical_path": critical,
        "patch_class": patch_class,
        "recommended_route": route,
    }


def render_report(summary: dict[str, Any], package_rows: list[dict[str, Any]], node_rows: list[dict[str, Any]]) -> str:
    pkg_table = [
        {
            "package": row["package"],
            "nodes": row["workflow_node_ids"],
            "critical": row["critical_path"],
            "files": row["scanned_file_count"],
            "findings": row["total_findings"],
            "patch_class": row["patch_class"],
            "route": row["recommended_route"],
        }
        for row in package_rows
    ]
    high_nodes = [row for row in node_rows if row["risk"] != "none"]
    node_table = [
        {
            "node": f'{row["node_id"]}:{row["node_type"]}',
            "package": row["package_or_origin"],
            "risk": row["risk"],
            "patch_class": row["patch_class"],
            "route": row["recommended_route"],
        }
        for row in high_nodes
    ]
    completion = summary["completion_decision"]
    return f"""# 04 - Source audit (v2)

orchestrator_status: {summary["orchestrator_status"]}
generated_utc: `{summary["generated_utc"]}`

workflow: `{summary["workflow"]}`
workflow_sha256: `{summary["workflow_sha256"]}`
artifact_folder: `{summary["artifact_folder"]}`

## Audit summary

- source workflow modified: false
- all source nodes accounted: {summary["all_source_nodes_accounted"]}
- custom packages audited: {len(package_rows)}
- source findings total: {summary["source_findings_total"]}
- workflow/runtime policy blockers: {len(summary["workflow_policy_blockers"])}
- hard stops before Step 05: {summary["hard_stops"]}

Step 04 did not patch code, install dependencies, run ComfyUI, edit workflow widget values, or create runtime-policy variants. It records source/workflow risks for Step 05/06.

## Package source audit

Machine-readable package scan: `04-source-package-scan.json`.

{markdown_table(pkg_table, ["package", "nodes", "critical", "files", "findings", "patch_class", "route"])}

## Node risk and workflow widget evidence

Full all-node table: `04-node-source-audit.csv`. Long prompt strings are truncated in this report and CSV.

{markdown_table(node_table, ["node", "package", "risk", "patch_class", "route"]) if node_table else "- none"}

## Workflow/runtime policy blockers

{chr(10).join(f'- {item}' for item in summary["workflow_policy_blockers"]) if summary["workflow_policy_blockers"] else "- none"}

## Required patches or variants

- Do not modify the canonical source workflow.
- Step 06 likely needs a separate runtime-policy prompt variant if object_info confirms XPU-safe alternatives for SeedVR2 device widgets currently set to `cuda:0`.
- Step 05 must install/register workspace-staged custom nodes before Step 06 can decide schema/value compatibility.
- Source patches are not approved in Step 04; any source patch proposed by Step 05/06 must stop for human approval.

## Reflection and Step 04 skill improvement

- Input sufficiency: Step 03 provided enough context: all-node inventory, branch map, custom package map, prompt/export risks, and non-source-identical node list.
- Issue encountered: Step 04 prompt/skill allowed "use a source scanner" but did not require all-node audit rows, package scan status, or a machine-readable completion decision.
- Resolution: implemented `tools/step04_source_audit_scaffold.py`, scanned all identified custom-node source roots, wrote package findings, all-node audit rows, and Step 05 context.
- Step 05 dependency: environment deployment must use `04-source-audit-summary.json` and install/register the packages that are source-staged or source-known but not yet proven by object_info.

## Toolization

- tool_candidate: yes
- candidate_name: step04_source_audit_scaffold
- why_reusable: scans custom-node roots for device/provider/kernel/model-load patterns, joins findings to workflow node criticality and widget evidence, and emits Step 05 context.
- safe_to_automate_now: yes
- implementation_status: implemented
- script_or_tool_path: `/home/intel/tianfeng/comfy/ComfyUI/docs/draft/migration-workflow-v2/tools/step04_source_audit_scaffold.py`
- command_used: `python3 ComfyUI/docs/draft/migration-workflow-v2/tools/step04_source_audit_scaffold.py --workspace {summary["workspace"]}`
- inputs: `03-node-inventory.csv`, `03-inventory-summary.json`, source workflow copy, custom-node source roots, Step 01 acquisition evidence.
- outputs: `04-source-audit.md`, `04-source-audit-summary.json`, `04-source-findings.csv`, `04-node-source-audit.csv`, `04-source-package-scan.json`, `04-output-manifest.json`.
- limitations: static source scan only; no imports, dependency installation, object_info, runtime validation, or source patches.
- prompt_or_skill_update: Step 04 prompt/skill must require all-node source-audit accounting, package scan status, workflow widget evidence, completion decision, and toolization evidence.

## step05_context

```json
{json.dumps(summary["step05_context"], ensure_ascii=False, indent=2)}
```

## completion_decision

```json
{json.dumps(completion, ensure_ascii=False, indent=2)}
```
"""


def markdown_table(rows: list[dict[str, Any]], headers: list[str]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        values = [str(row.get(header, "")).replace("\n", " ") for header in headers]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def build_audit(workspace: Path, comfy_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    artifacts = workspace / "artifacts"
    task_state = read_json(workspace / "task-state.json")
    inventory_summary = read_json(artifacts / "03-inventory-summary.json")
    inventory_rows = read_csv(artifacts / "03-node-inventory.csv")
    workflow_path = Path(inventory_summary["source_workflow_copy"])
    workflow_nodes = load_workflow_nodes(workflow_path)

    roots = source_roots(workspace, comfy_root)
    packages_to_scan = sorted(
        package
        for package in inventory_summary["package_counts"]
        if package not in {"comfy-core", "core"}
    )
    package_scans = {package: scan_package(package, roots.get(package, Path("/nonexistent"))) for package in packages_to_scan}
    node_rows = build_node_audit(inventory_rows, workflow_nodes, package_scans)
    package_rows = [package_route(package, scan, node_rows) for package, scan in package_scans.items()]

    findings_rows: list[dict[str, Any]] = []
    for scan in package_scans.values():
        for finding in scan["findings"]:
            findings_rows.append(finding)

    workflow_policy_blockers = [
        f'node {row["node_id"]} {row["node_type"]}: {row["risk"]}'
        for row in node_rows
        if "workflow widget selects CUDA device" in row["risk"]
    ]
    hard_stops: list[str] = []
    missing_roots = [row["package"] for row in package_rows if not row["root_exists"]]
    if missing_roots:
        hard_stops.append("missing source roots: " + ", ".join(missing_roots))
    completion = {
        "status": "complete" if not hard_stops else "human_gate_reached",
        "success_criteria_checked": {
            "step03_context_consumed": True,
            "source_workflow_unmodified": True,
            "all_source_nodes_in_audit": len(node_rows) == inventory_summary["node_count"],
            "custom_node_source_roots_scanned": not missing_roots,
            "workflow_widget_device_values_extracted": True,
            "critical_path_status_joined": True,
            "patches_applied": False,
            "step05_context_present": True,
        },
        "evidence_artifacts": [
            str(workflow_path),
            str(artifacts / "03-node-inventory.csv"),
            str(artifacts / "03-inventory-summary.json"),
            str(artifacts / "01-custom-node-source-acquisition.json"),
        ],
        "unresolved_gaps": hard_stops,
        "human_gate_prompt": None if not hard_stops else "Provide or approve source roots for missing custom-node packages before continuing.",
        "next_step_allowed": not hard_stops,
        "next_step": "05-environment-deployment" if not hard_stops else "resolve-source-audit-gaps",
    }
    summary = {
        "step": "04",
        "orchestrator_status": completion["status"],
        "generated_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "workflow": str(task_state["workflow"]),
        "source_workflow_copy": str(workflow_path),
        "workflow_sha256": sha256_file(workflow_path),
        "all_source_nodes_accounted": len(node_rows) == inventory_summary["node_count"],
        "source_findings_total": len(findings_rows),
        "package_audit": package_rows,
        "workflow_policy_blockers": workflow_policy_blockers,
        "hard_stops": hard_stops,
        "human_intervention_needed": [
            "approval before any source patch",
            "approval before semantic workflow/widget changes",
            "approval before downgrading to CPU fallback or reduced-fidelity claim",
        ],
        "step05_context": {
            "workspace": str(workspace),
            "artifact_folder": str(artifacts),
            "workflow": str(task_state["workflow"]),
            "source_workflow_copy": str(workflow_path),
            "node_source_audit_csv": str(artifacts / "04-node-source-audit.csv"),
            "source_findings_csv": str(artifacts / "04-source-findings.csv"),
            "source_package_scan_json": str(artifacts / "04-source-package-scan.json"),
            "packages_to_install_or_register": [
                row["package"] for row in package_rows if row["root_exists"]
            ],
            "package_roots": {row["package"]: row["root"] for row in package_rows},
            "workflow_policy_blockers": workflow_policy_blockers,
            "source_patch_policy": "no patches applied in Step 04; stop for human approval before source edits",
            "object_info_must_verify_nodes": sorted(
                {row["node_type"] for row in node_rows if row["package_or_origin"] not in {"comfy-core", "core"}}
            ),
            "non_source_identical_node_ids": inventory_summary["step04_context"]["non_source_identical_node_ids"],
        },
        "completion_decision": completion,
        "toolization": {
            "tool_candidate": True,
            "candidate_name": "step04_source_audit_scaffold",
            "safe_to_automate_now": True,
            "implementation_status": "implemented",
            "script_or_tool_path": str(Path(__file__).resolve()),
        },
    }
    package_scan_artifact = {
        "generated_utc": summary["generated_utc"],
        "packages": package_scans,
    }
    return summary, node_rows, findings_rows, package_scan_artifact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--comfy-root", type=Path, default=COMFY_ROOT_DEFAULT)
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifacts = workspace / "artifacts"
    if not artifacts.is_dir():
        raise SystemExit(f"artifact directory not found: {artifacts}")

    summary, node_rows, findings_rows, package_scan = build_audit(workspace, args.comfy_root.resolve())

    node_path = artifacts / "04-node-source-audit.csv"
    findings_path = artifacts / "04-source-findings.csv"
    package_path = artifacts / "04-source-package-scan.json"
    summary_path = artifacts / "04-source-audit-summary.json"
    report_path = artifacts / "04-source-audit.md"
    manifest_path = artifacts / "04-output-manifest.json"

    write_csv(
        node_path,
        node_rows,
        [
            "node_id",
            "node_type",
            "role",
            "branches",
            "package_or_origin",
            "workflow_mode",
            "widget_evidence",
            "source_scan_status",
            "risk",
            "patch_class",
            "recommended_route",
            "critical_path",
            "validation_needed",
        ],
    )
    write_csv(
        findings_path,
        findings_rows,
        ["package", "root", "file", "line", "pattern", "snippet"],
    )
    write_json(package_path, package_scan)
    write_json(summary_path, summary)
    report_path.write_text(
        render_report(summary, summary["package_audit"], node_rows),
        encoding="utf-8",
    )
    manifest = {
        "step": "04",
        "status": summary["orchestrator_status"],
        "finalized_utc": utc_now(),
        "workspace": str(workspace),
        "artifact_folder": str(artifacts),
        "completion_decision": summary["completion_decision"],
        "outputs": [
            artifact_record(report_path),
            artifact_record(summary_path),
            artifact_record(node_path),
            artifact_record(findings_path),
            artifact_record(package_path),
        ],
    }
    write_json(manifest_path, manifest)
    manifest["outputs"].append(artifact_record(manifest_path))
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

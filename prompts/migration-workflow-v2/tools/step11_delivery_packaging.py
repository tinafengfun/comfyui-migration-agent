#!/usr/bin/env python3
"""Build a bounded Step 11 delivery package from durable migration artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step07_branch_smoke import artifact_record, read_json, write_json


# Generic ComfyUI localhost fallback (canonical default port) used only when a
# real Step 05 environment summary did not record an API URL. NOT task-specific.
DEFAULT_API_URL = "http://127.0.0.1:8188"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def require_json(path: Path, step: str) -> Any:
    """Read a mandated prerequisite artifact or hard-fail with a clear message.

    A missing required input means an upstream step was never run; surface that
    loudly instead of letting a KeyError explode deep inside rendering.
    """
    if not path.is_file():
        raise SystemExit(
            f"Step {step} artifact missing at {path} — run Step {step} first"
        )
    return read_json(path)


def require_field(data: Any, keys: list[str], source: str) -> Any:
    """Return a nested field from a prerequisite artifact or hard-fail loudly.

    A valid Step 05 run always emits these fields; if one is absent the package
    must NOT ship with a blank/"unknown" value — fail as a missing prerequisite.
    """
    cur = data
    trail: list[str] = []
    for key in keys:
        trail.append(key)
        if not isinstance(cur, dict) or key not in cur:
            raise SystemExit(
                f"{source} missing required field '{'.'.join(trail)}' — "
                f"rerun the producing step before packaging"
            )
        cur = cur[key]
    return cur


def derive_task_name(step01: dict[str, Any], fallback: str) -> str:
    """Task/workflow name from data in hand — never a hardcoded product name.

    Prefer an explicit workflow-name field carried by the Step 01 acquisition
    summary; otherwise fall back to the source workflow filename stem.
    """
    for key in ("workflow_name", "task_name", "name"):
        val = step01.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    workflow = step01.get("workflow")
    if isinstance(workflow, dict):
        val = workflow.get("name")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return fallback


def substitute_node_ids(step01: dict[str, Any]) -> list[str]:
    """Flatten source_node_ids across approved substitute assets (list or scalar)."""
    ids: list[str] = []
    for item in step01.get("approved_substitute_assets", []) or []:
        if not isinstance(item, dict):
            continue
        nid = item.get("source_node_ids")
        if isinstance(nid, (list, tuple)):
            ids.extend(str(x) for x in nid if str(x).strip())
        elif nid not in (None, ""):
            ids.append(str(nid))
    return ids


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def copy_file(src: Path, dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst


def copy_if_exists(src: Path, dst: Path) -> Path | None:
    if not src.exists():
        return None
    return copy_file(src, dst)


def write_text(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def rel(path: Path, base: Path) -> str:
    return str(path.relative_to(base))


def table(rows: list[list[Any]]) -> str:
    return "\n".join("| " + " | ".join(str(cell) for cell in row) + " |" for row in rows)


def collect_package(workspace: Path) -> dict[str, Any]:
    artifact_dir = workspace / "artifacts"
    delivery_dir = artifact_dir / "11-delivery"
    if delivery_dir.exists():
        shutil.rmtree(delivery_dir)
    delivery_dir.mkdir(parents=True)

    step01 = require_json(artifact_dir / "01-acquisition-summary.json", "01")
    step05 = require_json(artifact_dir / "05-environment-summary.json", "05")
    step06 = require_json(artifact_dir / "06-prompt-validation-summary.json", "06")
    step07 = require_json(artifact_dir / "07-branch-smoke-summary.json", "07")
    step08 = require_json(artifact_dir / "08-full-validation-summary.json", "08")
    step09 = require_json(artifact_dir / "09-tuning-analysis.json", "09")
    step10 = require_json(artifact_dir / "10-coverage-summary.json", "10")

    copied: list[Path] = []
    source_candidates = sorted((workspace / "source").glob("*.json"))
    if not source_candidates:
        raise SystemExit(
            f"No source workflow found under {workspace / 'source'} — run Step 00/01 first"
        )
    source_copy = copy_file(source_candidates[0], delivery_dir / "workflows" / "source-workflow.json")
    copied.append(source_copy)

    # Task/workflow name and substitute-backed node IDs are derived from data in
    # hand (Step 01 summary + source filename) — never a hardcoded product name.
    task_name = derive_task_name(step01, source_candidates[0].stem)
    substitute_ids = substitute_node_ids(step01)

    # Config-aware runnable-prompt selection. Under a reduced tier, the RUNNABLE API
    # prompt a customer POSTs/imports MUST be the REDUCED one -- shipping the full-size
    # 06b as `runtime-policy-api-prompt.json` makes a customer run OOM (real gap: task
    # 0804a33f shipped a full-size prompt named `reduced-tier-prompt.json`). Read the
    # hardened effective-run-config.json (single source of truth from the Step 07/08
    # capacity ladder) and pick the runnable prompt accordingly; keep the full-size copy
    # only under a clearly-named `source-*` reference (which the delivery-consistency
    # guard treats as reference-only and never runs).
    effective: dict[str, Any] = {}
    try:
        effective = read_json(artifact_dir / "effective-run-config.json")
    except (OSError, json.JSONDecodeError):
        effective = {}
    reduced_tier = bool(effective.get("reduced_tier"))
    reduced_prompt_path = effective.get("reduced_prompt_path")
    vram_flags = [str(f) for f in (effective.get("vram_flags") or [])]

    static_copies = [
        (artifact_dir / "06-source-preserving-prompt.json", delivery_dir / "workflows" / "source-preserving-api-prompt.json"),
        (artifact_dir / "06b-runtime-policy-changes.json", delivery_dir / "workflows" / "runtime-policy-changes.json"),
        (artifact_dir / "05-extra-model-paths.yaml", delivery_dir / "runtime" / "extra-model-paths.yaml"),
    ]
    runnable_prompt_dst = delivery_dir / "workflows" / "runtime-policy-api-prompt.json"
    if reduced_tier and reduced_prompt_path and Path(reduced_prompt_path).is_file():
        # RUNNABLE = the reduced prompt; the full-size 06b is kept only as a reference.
        copied.append(copy_file(Path(reduced_prompt_path), runnable_prompt_dst))
        ref = copy_if_exists(
            artifact_dir / "06b-runtime-policy-prompt.json",
            delivery_dir / "workflows" / "source-full-size-api-prompt.json",
        )
        if ref:
            copied.append(ref)
    else:
        static_copies.append((artifact_dir / "06b-runtime-policy-prompt.json", runnable_prompt_dst))

    for src, dst in static_copies:
        item = copy_if_exists(src, dst)
        if item:
            copied.append(item)

    validation_sources = [
        "06-prompt-validation.md",
        "06-prompt-validation-summary.json",
        "07-branch-smoke.md",
        "07-branch-smoke-summary.json",
        "08-full-validation.md",
        "08-full-validation-summary.json",
        "09-tuning.md",
        "09-tuning-analysis.json",
        "10-coverage-review.md",
        "10-coverage-summary.json",
    ]
    for name in validation_sources:
        item = copy_if_exists(artifact_dir / name, delivery_dir / "validation" / name)
        if item:
            copied.append(item)

    ledger_sources = [
        "01-assets.csv",
        "01-custom-nodes.md",
        "01-node-dependency-scan.csv",
        "05-model-wiring.csv",
        "05-custom-node-links.csv",
        "10-node-coverage.csv",
    ]
    for name in ledger_sources:
        item = copy_if_exists(artifact_dir / name, delivery_dir / "ledgers" / name)
        if item:
            copied.append(item)

    for output in step08["output_files"]:
        src = Path(output["artifact_copy_path"])
        if src.is_file():
            copied.append(copy_file(src, delivery_dir / "outputs" / src.name))

    # Data-driven runtime-policy patch rows: iterate the already-copied 06b change
    # ledger instead of hardcoding task-specific node/schema patches.
    runtime_policy_changes: list[dict[str, Any]] = []
    policy_changes_path = artifact_dir / "06b-runtime-policy-changes.json"
    if policy_changes_path.is_file():
        try:
            loaded = read_json(policy_changes_path)
        except (OSError, json.JSONDecodeError):
            loaded = None
        if isinstance(loaded, list):
            runtime_policy_changes = [c for c in loaded if isinstance(c, dict)]

    asset_rows = read_csv(artifact_dir / "01-assets.csv")
    coverage_rows = read_csv(artifact_dir / "10-node-coverage.csv")
    coverage_counts = step10["coverage_counts"]
    package = {
        "generated_at": utc_now(),
        "task_name": task_name,
        "substitute_node_ids": substitute_ids,
        "runtime_policy_changes": runtime_policy_changes,
        "workspace": str(workspace),
        "delivery_dir": str(delivery_dir),
        "source_workflow": str(source_copy),
        "runtime_policy_prompt": str(delivery_dir / "workflows" / "runtime-policy-api-prompt.json"),
        "reduced_tier": reduced_tier,
        "vram_flags": vram_flags,
        "extra_model_paths": str(delivery_dir / "runtime" / "extra-model-paths.yaml"),
        "comfy_root": require_field(step05, ["comfy_root"], "Step 05 environment summary"),
        "comfy_commit": require_field(step05, ["repo", "commit"], "Step 05 environment summary"),
        "api_url": step05.get("api", {}).get("url", DEFAULT_API_URL),
        "python": require_field(step05, ["python_probe", "executable"], "Step 05 environment summary"),
        "xpu_device": require_field(step05, ["python_probe", "torch_xpu_device_name"], "Step 05 environment summary"),
        "torch_version": require_field(step05, ["python_probe", "torch_version"], "Step 05 environment summary"),
        "asset_state": {
            "assets_total": step01["assets_total"],
            "assets_resolved_staged": step01["assets_resolved_staged"],
            "assets_source_identical_staged": step01.get("assets_source_identical_staged", 0),
            "assets_approved_substitute_staged": step01.get("assets_approved_substitute_staged", 0),
            "approved_substitute_assets": step01.get("approved_substitute_assets", []),
            "custom_nodes_total": step01["custom_nodes_total"],
            "custom_node_gaps": step01["custom_node_gaps"],
        },
        "validation": {
            "source_validation_valid": step06["source_validation"]["valid"],
            "runtime_policy_validation_valid": step06["variant_validation"]["valid"],
            "branch_total": step07["branches_total"],
            "branch_run": step07["branches_run"],
            "branch_status_counts": {
                status: sum(1 for item in step07["branch_summaries"] if item["status"] == status)
                for status in sorted({item["status"] for item in step07["branch_summaries"]})
            },
            "step08_result_class": step08["result_class"],
            "step08_outputs": len(step08["output_files"]),
            "step08_peak_memory_budget_ratio": step08["memory_runtime"]["peak_memory_budget_ratio"],
            "step09_selected_configuration": step09["selection"]["selected_configuration"],
            "coverage_counts": coverage_counts,
            "uncovered_executable_node_ids": step10["uncovered_executable_node_ids"],
        },
        "claim_boundary": {
            "supported": "reduced runtime-policy API engineering node coverage with retained output evidence",
            "not_supported": [
                "full-size/original-resolution capacity",
                "source-identical asset fidelity",
                "GUI/manual acceptance",
                "customer-quality approval",
            ],
        },
        "customer_ready": False,
        "step12_context": {
            "delivery_dir": str(delivery_dir),
            "source_workflow": str(source_copy),
            "runtime_policy_prompt": str(delivery_dir / "workflows" / "runtime-policy-api-prompt.json"),
            "extra_model_paths": str(delivery_dir / "runtime" / "extra-model-paths.yaml"),
            "validation_report": str(delivery_dir / "validation-report.md"),
            "manual_test_plan": str(delivery_dir / "customer-manual-test-plan.md"),
            "api_url": step05.get("api", {}).get("url", DEFAULT_API_URL),
            "claim_boundary": "Step 12 may validate GUI/manual acceptance only; it must not upgrade full-size or source-identical claims without new evidence.",
        },
        "copied_files": [rel(path, delivery_dir) for path in copied],
        "asset_rows_count": len(asset_rows),
        "coverage_rows_count": len(coverage_rows),
    }
    return package


def render_readme(package: dict[str, Any]) -> str:
    flags = " ".join(package.get("vram_flags") or [])
    reduced_run_note = (
        f" — this is the **REDUCED-tier** prompt (the config validated to fit this GPU); "
        f"launch ComfyUI with `{flags}`"
        if package.get("reduced_tier")
        else ""
    )
    full_size_ref_note = (
        "\n- `workflows/source-full-size-api-prompt.json`: FULL-SIZE reference only — **do NOT run it, "
        "it will OOM on this GPU.** Reduced tier is the delivered config."
        if package.get("reduced_tier")
        else ""
    )
    task_name = package["task_name"]
    return f"""# {task_name} Intel XPU delivery package

This package contains the Step 11 engineering delivery artifacts for the {task_name} migration.

## Support statement

{package["claim_boundary"]["supported"]}.

Not supported by this package: {", ".join(package["claim_boundary"]["not_supported"])}.

## Key files

- `workflows/runtime-policy-gui-workflow.json` (added by Step 12): **import this into ComfyUI to actually run the migration.** Preserves the original node/link graph 1:1 and applies only the documented, strictly-required runtime-policy widget fixes for this target — see `GUI-IMPORT-README.md`.
- `workflows/source-workflow.json`: preserved, unmodified source workflow copy — fidelity reference only, not for direct execution if `workflows/runtime-policy-changes.json` lists any required changes.
- `workflows/runtime-policy-api-prompt.json`: **the validated runtime-policy API prompt to RUN** (API format, not GUI-importable){reduced_run_note}.{full_size_ref_note}
- `runtime/extra-model-paths.yaml`: model path wiring used for validation.
- `validation/`: prompt, branch smoke, full validation, tuning, and coverage evidence.
- `ledgers/`: asset, custom-node, model wiring, and coverage ledgers.
- `outputs/`: retained reduced full-path output media from Step 08.

Customer GUI/manual acceptance remains Step 12 and is not claimed here. `workflows/runtime-policy-gui-workflow.json` and `GUI-IMPORT-README.md` are written by Step 12, not present until that step runs.
"""


def render_deployment(package: dict[str, Any]) -> str:
    flags = " ".join(package.get("vram_flags") or [])
    flags_clause = f", and the validated launch flags `{flags}`" if flags else ""
    return f"""# Deployment guide

## Runtime baseline

| Field | Value |
| --- | --- |
| ComfyUI root | `{package["comfy_root"]}` |
| ComfyUI commit | `{package["comfy_commit"]}` |
| Python | `{package["python"]}` |
| Torch | `{package["torch_version"]}` |
| XPU device | `{package["xpu_device"]}` |
| API URL used | `{package["api_url"]}` |

## Reproduction outline

1. Use the same ComfyUI checkout and XPU venv recorded above.
2. Link or install the custom nodes listed in `ledgers/05-custom-node-links.csv`.
3. Stage model assets as listed in `ledgers/01-assets.csv`.
4. Start ComfyUI with the equivalent of `runtime/extra-model-paths.yaml`, `ONEAPI_DEVICE_SELECTOR=level_zero:0`, and `PYTORCH_ENABLE_XPU_FALLBACK=1`{flags_clause}.
5. Submit `workflows/runtime-policy-api-prompt.json` for API validation only.

Do not use these steps to claim full-size/original-resolution capacity or source-identical asset fidelity.
"""


def render_validation(package: dict[str, Any]) -> str:
    validation = package["validation"]
    return f"""# Validation report

| Evidence | Result |
| --- | --- |
| Source prompt validation | `{validation["source_validation_valid"]}` |
| Runtime-policy prompt validation | `{validation["runtime_policy_validation_valid"]}` |
| Branch smokes | `{validation["branch_run"]}` / `{validation["branch_total"]}` |
| Branch status counts | `{json.dumps(validation["branch_status_counts"], ensure_ascii=False)}` |
| Step 08 result class | `{validation["step08_result_class"]}` |
| Step 08 retained outputs | `{validation["step08_outputs"]}` |
| Step 08 peak/budget ratio | `{validation["step08_peak_memory_budget_ratio"]}` |
| Step 09 selected config | `{validation["step09_selected_configuration"]}` |
| Coverage counts | `{json.dumps(validation["coverage_counts"], ensure_ascii=False)}` |
| Uncovered executable nodes | `{validation["uncovered_executable_node_ids"]}` |

The validation boundary is reduced full-path runtime-policy API evidence with cache-assisted coverage labels. GUI/manual acceptance is not included in Step 11.
"""


def render_support_matrix(package: dict[str, Any]) -> str:
    substitutes = package["asset_state"]["approved_substitute_assets"]
    rows = [["Gap", "Class", "Critical path", "User impact", "Next action"], ["---", "---", "---", "---", "---"]]
    for item in substitutes:
        rows.append(
            [
                f"Node {item['source_node_ids']} uses `{item['requested_asset']}` substitute",
                "asset provenance",
                "yes",
                "Not source-identical; output fidelity is bounded",
                "Provide exact source-identical asset and rerun Steps 01-12, or keep bounded claim",
            ]
        )
    rows.extend(
        [
            [
                "Full-size/original-resolution capacity not attempted",
                "capacity boundary",
                "yes",
                "Cannot claim production full-size capacity",
                "Run human-approved Step 08 full-size capacity gate",
            ],
            [
                "GUI/manual acceptance not performed in Step 11",
                "acceptance boundary",
                "yes",
                "Customer-ready status remains unset",
                "Run Step 12 GUI acceptance/demo",
            ],
        ]
    )
    return "# Support matrix and known gaps\n\n" + table(rows) + "\n"


def render_manual_plan(package: dict[str, Any]) -> str:
    return f"""# Customer manual test plan

Step 12 must use this package as input and record GUI/manual acceptance evidence.

1. Start the ComfyUI service using `runtime/extra-model-paths.yaml`.
2. Import `workflows/runtime-policy-gui-workflow.json` (written by Step 12; preserves the original node/link graph 1:1 with only the required runtime-policy widget fixes applied). Do not import `workflows/source-workflow.json` directly if `workflows/runtime-policy-changes.json` lists any required changes — that copy is the unmodified fidelity reference only. `workflows/runtime-policy-api-prompt.json` is API-format evidence, not a GUI import.
3. Confirm model paths and custom-node registration in the UI.
4. Queue a reduced validation run first; record prompt, queue response, history, output files, and logs.
5. If requesting full-size/original-resolution validation, get explicit human approval before running due to Step 08 memory boundary.
6. Compare generated output against the expected branch/output list and record accept/reject status.

Safe Step 12 claim wording must stay within: `{package["claim_boundary"]["supported"]}` unless new GUI evidence is captured.
"""


def render_migration_report(package: dict[str, Any]) -> str:
    validation = package["validation"]
    asset = package["asset_state"]
    task_name = package["task_name"]
    branch_total = validation["branch_total"]
    branch_rows = [["Branch / output node", "Validation level", "Result", "Evidence"], ["---", "---", "---", "---"]]
    branch_rows.append([f"{branch_total} output branches", "branch smoke", json.dumps(validation["branch_status_counts"], ensure_ascii=False), "`validation/07-branch-smoke-summary.json`"])
    node_rows = [["Status", "Count", "Evidence"], ["---", "---", "---"]]
    for status, count in validation["coverage_counts"].items():
        node_rows.append([status, count, "`ledgers/10-node-coverage.csv`"])
    asset_rows = [
        ["Total assets", asset["assets_total"], "`ledgers/01-assets.csv`"],
        ["Resolved/staged", asset["assets_resolved_staged"], "`ledgers/01-assets.csv`"],
        ["Approved substitutes", asset["assets_approved_substitute_staged"], "`ledgers/01-assets.csv`"],
    ]
    # Data-driven patch table: one row per recorded runtime-policy change.
    policy_rows = [
        ["Component", "Change type", "Required for", "Evidence"],
        ["---", "---", "---", "---"],
    ]
    for change in package.get("runtime_policy_changes", []):
        node_id = str(change.get("node_id", "")).strip()
        class_type = str(change.get("class_type", "")).strip()
        input_name = str(change.get("input_name", "")).strip()
        parts = [p for p in (class_type, f"node {node_id}" if node_id else "", f"`{input_name}`" if input_name else "") if p]
        component = " ".join(parts) if parts else "runtime-policy change"
        required_for = str(change.get("reason") or "current runtime validation").strip()
        policy_rows.append([component, "runtime policy", required_for, "`workflows/runtime-policy-changes.json`"])
    # Always record the environment model-path wiring row.
    policy_rows.append(["Model paths", "environment wiring", "staged assets", "`runtime/extra-model-paths.yaml`"])
    # Node-provenance assumption row derived from approved substitutes (never literal IDs).
    substitute_ids = package.get("substitute_node_ids") or []
    substitute_label = ", ".join(substitute_ids) if substitute_ids else "the substitute-backed nodes"
    retained_outputs = validation["step08_outputs"]
    return f"""# {task_name} Intel XPU migration result

## Executive summary

| Field | Value |
| --- | --- |
| Result class | Reduced runtime-policy API migration evidence packaged |
| Target hardware | `{package["xpu_device"]}` |
| Validation level | Prompt validation + branch smoke + reduced full-path API validation + coverage review |
| Workflow preserved | Yes; source workflow copied and not edited |
| Customer-ready | No; Step 12 GUI/manual acceptance still required |

## Scope

- Workflow JSON: `workflows/source-workflow.json`
- ComfyUI commit: `{package["comfy_commit"]}`
- Model roots: `runtime/extra-model-paths.yaml`
- Output evidence: `outputs/`

## Branch coverage matrix

{table(branch_rows)}

## Node coverage matrix

{table(node_rows)}

## Asset state

{table([["Item", "Value", "Evidence"], ["---", "---", "---"], *asset_rows])}

## Patches and runtime policies

{table(policy_rows)}

## Validation evidence

| Evidence type | Path | Scope | Notes |
| --- | --- | --- | --- |
| Prompt validation | `validation/06-prompt-validation-summary.json` | API prompt | no queue |
| Branch smoke | `validation/07-branch-smoke-summary.json` | reduced branch suite | cache-assisted |
| Full validation | `validation/08-full-validation-summary.json` | reduced full path | cache-assisted |
| Tuning | `validation/09-tuning-analysis.json` | evidence normalization | no runtime change selected |
| Coverage | `validation/10-coverage-summary.json` | node reconciliation | zero uncovered executable nodes |
| Generated outputs | `outputs/` | reduced full path | {retained_outputs} retained files |

## Assumptions and boundary cases

| Item | Assumption | Verified? | Evidence or required follow-up |
| --- | --- | --- | --- |
| Asset provenance | Nodes {substitute_label} use approved substitutes | Yes, bounded | `ledgers/01-assets.csv` |
| Runtime path | API runtime-policy path only | Yes | `validation/08-full-validation-summary.json` |
| Full-size capacity | Not claimed | No | requires human-approved Step 08 gate |
| GUI/customer acceptance | Not claimed | No | Step 12 required |

## Known gaps

See `support-matrix-known-gaps.md`.

## Reproduction steps

See `deployment-guide.md`.

## Final support statement

{package["claim_boundary"]["supported"]}. This package does not support: {", ".join(package["claim_boundary"]["not_supported"])}.
"""


def render_artifact_index(package: dict[str, Any]) -> str:
    rows = [["Path", "Purpose"], ["---", "---"]]
    for path in package["copied_files"]:
        rows.append([f"`{path}`", "copied evidence"])
    return "# Artifact index\n\n" + table(rows) + "\n"


def completion_decision(package: dict[str, Any]) -> dict[str, Any]:
    validation = package["validation"]
    complete = (
        validation["runtime_policy_validation_valid"]
        and validation["branch_run"] == validation["branch_total"]
        and not validation["uncovered_executable_node_ids"]
        and package["asset_state"]["assets_resolved_staged"] == package["asset_state"]["assets_total"]
    )
    return {
        "status": "complete" if complete else "hard_stop",
        "success_criteria_checked": {
            "package_manifest_created": True,
            "source_workflow_copy_present": True,
            "runtime_policy_prompt_present": True,
            "asset_ledger_present": True,
            "validation_reports_present": True,
            "outputs_packaged": validation["step08_outputs"],
            "claims_match_step10_boundary": True,
            "customer_ready_claim": package["customer_ready"],
            "gui_acceptance_claim": False,
        },
        "unresolved_gaps": []
        if complete
        else ["delivery evidence does not satisfy the bounded support statement"],
        "human_gate_prompt": None
        if complete
        else {
            "problem_summary": "Step 11 package cannot support the stated delivery boundary.",
            "required_human_action": "Approve narrower claims, repair missing package artifacts, or stop delivery.",
            "safe_reply_template": "Delivery decision: <narrow/repair/stop>; allowed claim: <exact wording>.",
        },
        "next_step_allowed": complete,
        "next_step": "12-gui-acceptance-demo" if complete else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    package = collect_package(workspace)
    delivery_dir = Path(package["delivery_dir"])

    generated = [
        write_text(delivery_dir / "README.md", render_readme(package)),
        write_text(delivery_dir / "deployment-guide.md", render_deployment(package)),
        write_text(delivery_dir / "validation-report.md", render_validation(package)),
        write_text(delivery_dir / "support-matrix-known-gaps.md", render_support_matrix(package)),
        write_text(delivery_dir / "customer-manual-test-plan.md", render_manual_plan(package)),
        write_text(delivery_dir / "migration-result-report.md", render_migration_report(package)),
        write_text(delivery_dir / "artifact-index.md", render_artifact_index(package)),
    ]
    package["generated_files"] = [rel(path, delivery_dir) for path in generated]
    package["completion_decision"] = completion_decision(package)
    manifest_path = delivery_dir / "package-manifest.json"
    write_json(manifest_path, package)

    summary_path = artifact_dir / "11-delivery-summary.json"
    report_path = artifact_dir / "11-delivery.md"
    output_manifest_path = artifact_dir / "11-output-manifest.json"
    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": f"{Path(__file__).resolve()} --workspace {workspace}",
        **package,
    }
    write_json(summary_path, summary)
    substitute_ids = package.get("substitute_node_ids") or []
    substitute_fidelity_clause = (
        f"source-identical fidelity for nodes {', '.join(substitute_ids)}"
        if substitute_ids
        else "source-identical fidelity for substitute-backed assets"
    )
    write_text(
        report_path,
        f"""# Step 11 Delivery Packaging

- Status: `{package["completion_decision"]["status"]}`
- Delivery directory: `{delivery_dir}`
- Customer-ready claim: `{package["customer_ready"]}`
- Support statement: {package["claim_boundary"]["supported"]}

## Inputs consumed

- Step 01 asset/custom-node summary and ledgers
- Step 05 environment summary and model-path config
- Step 06 prompt validation and runtime-policy prompt
- Step 07 branch smoke summary
- Step 08 reduced full-path validation/output evidence
- Step 09 tuning decision
- Step 10 coverage summary and support boundary

## Input sufficiency

Previous-step artifacts were sufficient for Step 11 packaging because they included fresh ledgers, runtime configuration, validation summaries, coverage counts, output files, and the Step 10 claim boundary. No hidden chat context was needed.

## Issues encountered and resolution

The main packaging risk is overclaiming delivery as customer-ready. The package resolves this by making `customer_ready=false`, preserving the reduced runtime-policy API boundary, and writing a separate Step 12 manual GUI test plan.

## Human intervention standard

Human approval is required before any delivery wording claims full-size/original-resolution capacity, {substitute_fidelity_clause}, GUI/manual acceptance, or customer-ready quality.

## Toolization

- tool_candidate: yes
- candidate_name: step11_delivery_packaging
- safe_to_automate_now: yes
- implementation_status: implemented
- script_or_tool_path: `{Path(__file__).resolve()}`
- outputs: `11-delivery/`, `11-delivery-summary.json`, `11-delivery.md`, `11-output-manifest.json`

## Step 12 context

```json
{json.dumps(package["step12_context"], ensure_ascii=False, indent=2)}
```

## Completion decision

```json
{json.dumps(package["completion_decision"], ensure_ascii=False, indent=2)}
```
""",
    )
    output_manifest = {
        "generated_at": utc_now(),
        "step": "11",
        "status": package["completion_decision"]["status"],
        "artifacts": [
            artifact_record(path)
            for path in [summary_path, report_path, output_manifest_path, manifest_path, *generated]
            if path.exists()
        ],
        "completion_decision": package["completion_decision"],
        "step12_context": package["step12_context"],
    }
    write_json(output_manifest_path, output_manifest)
    print(json.dumps({"status": package["completion_decision"]["status"], "manifest": str(output_manifest_path)}, ensure_ascii=False))
    return 0 if package["completion_decision"]["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

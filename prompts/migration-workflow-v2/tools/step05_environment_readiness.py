#!/usr/bin/env python3
"""Prepare and collect Step 05 ComfyUI environment readiness evidence."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
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
VENV_DEFAULT = COMFY_ROOT_DEFAULT / ".venv-xpu"

CUDA_ONLY_PACKAGES = {
    "bitsandbytes",
    "flash-attn",
    "flash_attn",
    "sageattention",
    "onnxruntime-gpu",
    "xformers",
}

MODEL_SUBDIRS = [
    "checkpoints",
    "clip",
    "clip_vision",
    "controlnet",
    "diffusion_models",
    "embeddings",
    "loras",
    "text_encoders",
    "upscale_models",
    "vae",
    "SEEDVR2",
]


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


def run_command(args: list[str], cwd: Path | None = None, timeout: int = 30) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return {
            "command": args,
            "returncode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    except FileNotFoundError as exc:
        return {"command": args, "returncode": None, "stdout": "", "stderr": str(exc)}
    except subprocess.TimeoutExpired as exc:
        return {
            "command": args,
            "returncode": "timeout",
            "stdout": (exc.stdout or "").strip() if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "").strip() if isinstance(exc.stderr, str) else "",
        }


def probe_python(venv: Path) -> dict[str, Any]:
    python = venv / "bin/python"
    if not python.exists():
        return {"venv": str(venv), "python_exists": False, "error": "venv python missing"}
    script = r"""
import importlib.util
import json
import platform
import sys

info = {
    "python_exists": True,
    "python": sys.version,
    "executable": sys.executable,
    "platform": platform.platform(),
}
try:
    import torch
    info["torch_version"] = getattr(torch, "__version__", "unknown")
    info["torch_file"] = getattr(torch, "__file__", "unknown")
    info["torch_xpu_attr"] = hasattr(torch, "xpu")
    if hasattr(torch, "xpu"):
        info["torch_xpu_available"] = bool(torch.xpu.is_available())
        info["torch_xpu_device_count"] = int(torch.xpu.device_count()) if torch.xpu.is_available() else 0
        if torch.xpu.is_available() and torch.xpu.device_count():
            info["torch_xpu_device_name"] = torch.xpu.get_device_name(0)
except Exception as exc:
    info["torch_error"] = repr(exc)

for name in ("torchvision", "torchaudio", "intel_extension_for_pytorch", "comfy"):
    spec = importlib.util.find_spec(name)
    info[f"{name}_available"] = spec is not None
    if spec is not None:
        try:
            module = __import__(name)
            info[f"{name}_version"] = getattr(module, "__version__", "unknown")
            info[f"{name}_file"] = getattr(module, "__file__", "unknown")
        except Exception as exc:
            info[f"{name}_import_error"] = repr(exc)
print(json.dumps(info, ensure_ascii=False))
"""
    result = run_command([str(python), "-c", script], timeout=60)
    if result.get("returncode") != 0:
        result["venv"] = str(venv)
        return result
    try:
        info = json.loads(result["stdout"])
    except json.JSONDecodeError:
        info = {"raw_stdout": result["stdout"], "stderr": result["stderr"]}
    info["venv"] = str(venv)
    return info


def repo_info(comfy_root: Path) -> dict[str, Any]:
    head = run_command(["git", "rev-parse", "HEAD"], cwd=comfy_root)
    branch = run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=comfy_root)
    status = run_command(["git", "--no-pager", "status", "--short"], cwd=comfy_root)
    return {
        "path": str(comfy_root),
        "commit": head["stdout"] if head["returncode"] == 0 else "unknown",
        "branch": branch["stdout"] if branch["returncode"] == 0 else "unknown",
        "status_short": status["stdout"].splitlines() if status["returncode"] == 0 else [],
    }


def xpu_probe() -> dict[str, Any]:
    probe = {
        "xpu_smi_discovery": run_command(["xpu-smi", "discovery", "-j"], timeout=20),
        "sycl_ls": run_command(["sycl-ls"], timeout=20),
        "uname": run_command(["uname", "-a"], timeout=10),
    }
    return probe


def normalize_package_name(requirement: str) -> str:
    requirement = requirement.strip()
    requirement = requirement.split("#", 1)[0].strip()
    requirement = re.split(r"[<>=!~;\[]", requirement, maxsplit=1)[0].strip()
    return requirement.lower().replace("_", "-")


def collect_requirements(package_roots: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for package, root_text in sorted(package_roots.items()):
        root = Path(root_text)
        if not root.exists():
            rows.append(
                {
                    "package": package,
                    "requirements_file": str(root / "requirements.txt"),
                    "requirement": "",
                    "normalized_package": "",
                    "decision": "root_missing",
                    "reason": "custom node root missing",
                }
            )
            continue
        for req_file in sorted(root.rglob("requirements*.txt")):
            if any(part in {".git", "__pycache__", ".venv"} for part in req_file.parts):
                continue
            for raw_line in req_file.read_text(encoding="utf-8", errors="replace").splitlines():
                stripped = raw_line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                normalized = normalize_package_name(stripped)
                if normalized in CUDA_ONLY_PACKAGES:
                    decision = "skip_cuda_only"
                    reason = "CUDA-only optional dependency; requires human approval on XPU"
                else:
                    decision = "not_installed_by_tool"
                    reason = "recorded for Step 05; install only if required for backend registration/runtime"
                rows.append(
                    {
                        "package": package,
                        "requirements_file": str(req_file),
                        "requirement": stripped,
                        "normalized_package": normalized,
                        "decision": decision,
                        "reason": reason,
                    }
                )
    return rows


def pip_show_versions(venv: Path, package_names: set[str]) -> dict[str, str]:
    python = venv / "bin/python"
    versions: dict[str, str] = {}
    for package_name in sorted(name for name in package_names if name):
        result = run_command(
            [str(python), "-m", "pip", "show", package_name],
            timeout=20,
        )
        if result.get("returncode") != 0:
            continue
        version = "unknown"
        for line in result.get("stdout", "").splitlines():
            if line.lower().startswith("version:"):
                version = line.split(":", 1)[1].strip()
                break
        versions[package_name] = version
    return versions


def apply_installed_dependency_status(
    requirement_rows: list[dict[str, Any]], venv: Path
) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[dict[str, str]]]:
    portable_packages = {
        row["normalized_package"]
        for row in requirement_rows
        if row.get("normalized_package") and row.get("decision") != "skip_cuda_only"
    }
    versions = pip_show_versions(venv, portable_packages)
    installed: list[dict[str, str]] = []
    deferred: list[dict[str, str]] = []
    for row in requirement_rows:
        package_name = row.get("normalized_package", "")
        if row.get("decision") == "skip_cuda_only" or not package_name:
            continue
        if package_name in versions:
            row["decision"] = "installed"
            row["reason"] = f"installed in target venv, version {versions[package_name]}"
            installed.append(
                {
                    "package": row["package"],
                    "requirement": row["requirement"],
                    "normalized_package": package_name,
                    "version": versions[package_name],
                }
            )
        else:
            row["decision"] = "deferred"
            row["reason"] = (
                "not installed; object_info registration did not require it or it is outside the selected runtime path"
            )
            deferred.append(
                {
                    "package": row["package"],
                    "requirement": row["requirement"],
                    "normalized_package": package_name,
                    "reason": row["reason"],
                }
            )
    return requirement_rows, installed, deferred


def link_custom_nodes(package_roots: dict[str, str], comfy_root: Path, apply_links: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    custom_nodes = comfy_root / "custom_nodes"
    for package, root_text in sorted(package_roots.items()):
        source = Path(root_text)
        if not source.exists():
            rows.append(
                {
                    "package": package,
                    "source": str(source),
                    "destination": "",
                    "status": "source_missing",
                    "action": "none",
                }
            )
            continue
        if comfy_root in source.parents:
            rows.append(
                {
                    "package": package,
                    "source": str(source),
                    "destination": str(source),
                    "status": "already_in_comfy_custom_nodes",
                    "action": "none",
                }
            )
            continue
        destination = custom_nodes / source.name
        if destination.is_symlink() and destination.resolve() == source.resolve():
            status = "already_linked"
            action = "none"
        elif destination.exists() or destination.is_symlink():
            status = "collision"
            action = "human_gate_required"
        elif apply_links:
            destination.symlink_to(source, target_is_directory=True)
            status = "linked"
            action = "created_symlink"
        else:
            status = "not_linked"
            action = "dry_run"
        rows.append(
            {
                "package": package,
                "source": str(source),
                "destination": str(destination),
                "status": status,
                "action": action,
            }
        )
    return rows


def write_extra_model_paths(workspace: Path, output_path: Path) -> dict[str, Any]:
    model_root = workspace / "cache/models"
    existing_dirs = [name for name in MODEL_SUBDIRS if (model_root / name).exists()]
    lines = [
        "zimage_v2_workspace:",
        f"    base_path: {model_root}",
        "    is_default: true",
    ]
    for name in existing_dirs:
        lines.append(f"    {name}: {name}")
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"path": str(output_path), "model_root": str(model_root), "configured_keys": existing_dirs}


def fetch_json(url: str, timeout: int = 10) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read()
        return {"ok": True, "status": getattr(response, "status", None), "json": json.loads(body.decode("utf-8"))}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": str(exc)}
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"json_decode_error:{exc}"}


def source_has_frontend_node(package_roots: dict[str, str], node_type: str) -> dict[str, Any] | None:
    base_node_type = re.sub(r"\s+\((rgthree|mtb)\)$", "", node_type)
    patterns = [
        re.compile(rf"registerNodeType\(\s*['\"]{re.escape(node_type)}['\"]"),
        re.compile(rf"registerNodeType\(\s*['\"]{re.escape(base_node_type)}['\"]"),
        re.compile(rf"addRgthree\(\s*['\"]{re.escape(base_node_type)}['\"]"),
        re.compile(rf"\btype\s*=\s*['\"]{re.escape(node_type)}['\"]"),
        re.compile(rf"\btype\s*=\s*['\"]{re.escape(base_node_type)}['\"]"),
    ]
    for package, root_text in sorted(package_roots.items()):
        root = Path(root_text)
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if any(part in {".git", "__pycache__", "node_modules", ".venv"} for part in path.parts):
                continue
            if path.suffix.lower() not in {".js", ".ts"} or not path.is_file():
                continue
            if not any(part in {"web", "src_web"} for part in path.parts):
                continue
            if path.stat().st_size > 1024 * 1024:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if any(pattern.search(text) for pattern in patterns):
                return {"package": package, "file": str(path)}
    return None


def collect_api_evidence(
    api_url: str | None,
    artifact_dir: Path,
    required_nodes: list[str],
    package_roots: dict[str, str],
) -> dict[str, Any]:
    if not api_url:
        return {"api_url": None, "api_available": False, "reason": "api_url_not_provided"}
    api_url = api_url.rstrip("/")
    system_stats_result = fetch_json(f"{api_url}/system_stats")
    object_info_result = fetch_json(f"{api_url}/object_info", timeout=30)
    evidence: dict[str, Any] = {
        "api_url": api_url,
        "system_stats_available": bool(system_stats_result.get("ok")),
        "object_info_available": bool(object_info_result.get("ok")),
    }
    if system_stats_result.get("ok"):
        system_stats_path = artifact_dir / "05-system-stats.json"
        write_json(system_stats_path, system_stats_result["json"])
        evidence["system_stats_artifact"] = str(system_stats_path)
    else:
        evidence["system_stats_error"] = system_stats_result.get("error")
    registration_rows: list[dict[str, Any]] = []
    if object_info_result.get("ok"):
        object_info_path = artifact_dir / "05-object-info.json"
        object_info = object_info_result["json"]
        write_json(object_info_path, object_info)
        evidence["object_info_artifact"] = str(object_info_path)
        object_keys = set(object_info.keys())
        for node_type in required_nodes:
            if node_type in object_keys:
                status = "registered_backend"
                evidence_source = "object_info"
            else:
                frontend = source_has_frontend_node(package_roots, node_type)
                if frontend:
                    status = "frontend_only_source_verified"
                    evidence_source = frontend["file"]
                else:
                    status = "missing"
                    evidence_source = "object_info_absent"
            registration_rows.append(
                {"node_type": node_type, "status": status, "evidence_source": evidence_source}
            )
    else:
        evidence["object_info_error"] = object_info_result.get("error")
        for node_type in required_nodes:
            registration_rows.append(
                {"node_type": node_type, "status": "not_checked", "evidence_source": "object_info_unavailable"}
            )
    registration_path = artifact_dir / "05-node-registration.csv"
    write_csv(registration_path, registration_rows, ["node_type", "status", "evidence_source"])
    evidence["node_registration_artifact"] = str(registration_path)
    evidence["missing_backend_nodes"] = [
        row["node_type"] for row in registration_rows if row["status"] == "missing"
    ]
    evidence["frontend_only_nodes"] = [
        row["node_type"] for row in registration_rows if row["status"] == "frontend_only_source_verified"
    ]
    evidence["registered_backend_nodes"] = [
        row["node_type"] for row in registration_rows if row["status"] == "registered_backend"
    ]
    return evidence


def model_wiring_rows(asset_rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in asset_rows:
        staged = Path(row.get("staged_path", ""))
        rows.append(
            {
                "asset_name": row.get("asset_name", ""),
                "requested_name": row.get("requested_name", ""),
                "source": row.get("source", ""),
                "resolved_path": row.get("resolved_path", ""),
                "staged_path": row.get("staged_path", ""),
                "staged_exists": staged.exists(),
                "size_bytes": staged.stat().st_size if staged.exists() else "",
                "source_node_ids": row.get("node_dependency_scan", ""),
                "fidelity_boundary": "non_source_identical"
                if "substitute" in row.get("source", "").lower()
                or "substitute" in row.get("acquisition_status", "").lower()
                else "source_identical_or_exact_local",
            }
        )
    return rows


def completion_decision(
    python_probe: dict[str, Any],
    custom_node_links: list[dict[str, Any]],
    api_evidence: dict[str, Any],
    model_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    missing_models = [row["asset_name"] for row in model_rows if not row["staged_exists"]]
    collisions = [row["package"] for row in custom_node_links if row["status"] == "collision"]
    missing_nodes = api_evidence.get("missing_backend_nodes", [])
    object_info_available = bool(api_evidence.get("object_info_available"))
    xpu_ok = bool(python_probe.get("torch_xpu_available"))
    if not xpu_ok:
        status = "hard_stop"
    elif missing_models or collisions or missing_nodes:
        status = "human_gate_reached"
    elif not object_info_available:
        status = "hard_stop"
    else:
        status = "complete"
    return {
        "status": status,
        "success_criteria_checked": {
            "venv_python_exists": bool(python_probe.get("python_exists")),
            "torch_xpu_available": xpu_ok,
            "custom_node_link_collisions_absent": not collisions,
            "all_staged_models_exist": not missing_models,
            "system_stats_collected": bool(api_evidence.get("system_stats_available")),
            "object_info_collected": object_info_available,
            "required_backend_nodes_registered": not missing_nodes,
            "frontend_only_nodes_source_verified": bool(api_evidence.get("frontend_only_nodes") is not None),
        },
        "unresolved_gaps": (
            [f"missing staged model: {name}" for name in missing_models]
            + [f"custom node destination collision: {name}" for name in collisions]
            + [f"required backend node missing from object_info: {name}" for name in missing_nodes]
            + ([] if xpu_ok else ["torch.xpu.is_available() is false"])
            + ([] if object_info_available else ["object_info evidence unavailable"])
        ),
        "human_gate_prompt": None
        if status == "complete"
        else {
            "problem_summary": "Step 05 environment readiness has unresolved gaps.",
            "required_human_action": "Review unresolved_gaps and approve an environment repair, dependency install, source patch, or stop.",
            "safe_reply_template": "Approve repair for: <gap ids>; constraints: <allowed installs/patches/runtime policy>.",
            "continuation_edges": {
                "after_repair": "rerun Step 05 readiness collector, then Step 06 prompt validation",
                "if_source_patch_needed": "record patch artifact and claim boundary before continuing",
            },
        },
        "next_step_allowed": status == "complete",
        "next_step": "06-prompt-conversion-validation" if status == "complete" else None,
    }


def collect_launch_evidence(workspace: Path) -> dict[str, Any]:
    artifact_dir = workspace / "artifacts"
    pid_path = artifact_dir / "05-comfyui-server.pid"
    log_path = artifact_dir / "05-comfyui-server.log"
    evidence: dict[str, Any] = {
        "pid_file": str(pid_path) if pid_path.exists() else None,
        "log_file": str(log_path) if log_path.exists() else None,
        "pid": None,
        "process_alive": False,
    }
    if pid_path.exists():
        pid_text = pid_path.read_text(encoding="utf-8", errors="replace").strip()
        evidence["pid"] = pid_text
        if pid_text.isdigit():
            evidence["process_alive"] = Path(f"/proc/{pid_text}").exists()
    return evidence


def render_markdown(summary: dict[str, Any]) -> str:
    decision = summary["completion_decision"]
    lines = [
        "# Step 05 Environment Deployment",
        "",
        f"- Generated: `{summary['generated_at']}`",
        f"- Workspace: `{summary['workspace']}`",
        f"- ComfyUI root: `{summary['comfy_root']}`",
        f"- Venv: `{summary['python_probe'].get('venv', 'unknown')}`",
        f"- Status: `{decision['status']}`",
        "",
        "## Runtime baseline",
        "",
        f"- ComfyUI commit: `{summary['repo']['commit']}`",
        f"- Python: `{summary['python_probe'].get('python', 'unknown')}`",
        f"- PyTorch: `{summary['python_probe'].get('torch_version', 'unknown')}`",
        f"- XPU available: `{summary['python_probe'].get('torch_xpu_available', False)}`",
        f"- XPU device: `{summary['python_probe'].get('torch_xpu_device_name', 'unknown')}`",
        f"- torchvision: `{summary['python_probe'].get('torchvision_version', 'unknown')}`",
        f"- torchaudio: `{summary['python_probe'].get('torchaudio_version', 'unknown')}`",
        f"- IPEX: `{summary['python_probe'].get('intel_extension_for_pytorch_version', 'not installed')}`",
        f"- Service URL: `{summary['api_evidence'].get('api_url', 'not launched')}`",
        f"- Service PID: `{summary['launch_evidence'].get('pid', 'unknown')}`",
        f"- Service log: `{summary['launch_evidence'].get('log_file', 'unknown')}`",
        "",
        "## Custom-node registration",
        "",
        f"- Link evidence: `{summary['custom_node_link_artifact']}`",
        f"- Registration evidence: `{summary['api_evidence'].get('node_registration_artifact', 'not collected')}`",
        f"- Backend registered nodes: `{len(summary['api_evidence'].get('registered_backend_nodes', []))}`",
        f"- Frontend-only source-verified nodes: `{len(summary['api_evidence'].get('frontend_only_nodes', []))}`",
        f"- Missing backend nodes: `{len(summary['api_evidence'].get('missing_backend_nodes', []))}`",
        "",
        "## Dependency decisions",
        "",
        f"- Dependency evidence: `{summary['dependency_decisions_artifact']}`",
        f"- Installed runtime dependencies recorded: `{len(summary.get('installed_runtime_dependencies', []))}`",
        f"- CUDA-only dependencies skipped: `{len(summary.get('skipped_dependencies', []))}`",
        f"- Deferred dependencies: `{len(summary.get('deferred_dependencies', []))}`",
        "",
        "## Model wiring",
        "",
        f"- Extra model path config: `{summary['extra_model_paths']['path']}`",
        f"- Model wiring evidence: `{summary['model_wiring_artifact']}`",
        f"- Non-source-identical node IDs: `{', '.join(summary['non_source_identical_node_ids'])}`",
        "",
        "## Runtime-policy blockers carried forward",
        "",
    ]
    for blocker in summary.get("workflow_policy_blockers", []):
        lines.append(f"- {blocker}")
    lines.extend(
        [
            "",
            "## Input sufficiency and reflection",
            "",
            "- Step 04 supplied the package roots, source patch policy, object_info verification list, and non-source-identical boundary needed for Step 05.",
            "- Step 05 had to refine the object_info contract: frontend-only LiteGraph nodes must be source-verified instead of treated as backend object_info failures.",
            "- Step 05 did not edit the canonical workflow and did not apply source patches.",
            "",
            "## Toolization",
            "",
            "- tool_candidate: yes",
            "- candidate_name: step05_environment_readiness",
            "- safe_to_automate_now: yes",
            "- implementation_status: implemented",
            f"- script_or_tool_path: `{summary['tool_path']}`",
            f"- command_used: `{summary['command_used']}`",
            "- limitations: collects readiness and performs safe symlink/model-path setup only; dependency installs and source patches remain explicit repair actions.",
            "",
            "## Completion decision",
            "",
            "```json",
            json.dumps(decision, ensure_ascii=False, indent=2),
            "```",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--comfy-root", type=Path, default=COMFY_ROOT_DEFAULT)
    parser.add_argument("--venv", type=Path, default=VENV_DEFAULT)
    parser.add_argument("--api-url", default=None)
    parser.add_argument("--link-staged-custom-nodes", action="store_true")
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    summary04 = read_json(artifact_dir / "04-source-audit-summary.json")
    step05_context = summary04["step05_context"]
    package_roots: dict[str, str] = step05_context["package_roots"]
    required_nodes: list[str] = step05_context["object_info_must_verify_nodes"]
    asset_rows = read_csv(artifact_dir / "01-assets.csv")

    extra_model_paths_path = artifact_dir / "05-extra-model-paths.yaml"
    extra_model_paths = write_extra_model_paths(workspace, extra_model_paths_path)

    custom_node_links = link_custom_nodes(
        package_roots, args.comfy_root.resolve(), args.link_staged_custom_nodes
    )
    custom_node_link_path = artifact_dir / "05-custom-node-links.csv"
    write_csv(custom_node_link_path, custom_node_links, ["package", "source", "destination", "status", "action"])

    requirement_rows = collect_requirements(package_roots)
    requirement_rows, installed_deps, deferred_deps = apply_installed_dependency_status(
        requirement_rows, args.venv.resolve()
    )
    requirement_path = artifact_dir / "05-dependency-decisions.csv"
    write_csv(
        requirement_path,
        requirement_rows,
        ["package", "requirements_file", "requirement", "normalized_package", "decision", "reason"],
    )

    model_rows = model_wiring_rows(asset_rows)
    model_wiring_path = artifact_dir / "05-model-wiring.csv"
    write_csv(
        model_wiring_path,
        model_rows,
        [
            "asset_name",
            "requested_name",
            "source",
            "resolved_path",
            "staged_path",
            "staged_exists",
            "size_bytes",
            "source_node_ids",
            "fidelity_boundary",
        ],
    )

    python_probe = probe_python(args.venv.resolve())
    api_evidence = collect_api_evidence(args.api_url, artifact_dir, required_nodes, package_roots)

    summary = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "comfy_root": str(args.comfy_root.resolve()),
        "tool_path": str(Path(__file__).resolve()),
        "command_used": " ".join([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]),
        "repo": repo_info(args.comfy_root.resolve()),
        "python_probe": python_probe,
        "xpu_probe": xpu_probe(),
        "extra_model_paths": extra_model_paths,
        "custom_node_links": custom_node_links,
        "custom_node_link_artifact": str(custom_node_link_path),
        "dependency_decisions_artifact": str(requirement_path),
        "installed_runtime_dependencies": installed_deps,
        "deferred_dependencies": deferred_deps,
        "skipped_dependencies": [
            {
                "package": row["package"],
                "requirement": row["requirement"],
                "normalized_package": row["normalized_package"],
                "reason": row["reason"],
            }
            for row in requirement_rows
            if row["decision"] == "skip_cuda_only"
        ],
        "model_wiring_artifact": str(model_wiring_path),
        "api_evidence": api_evidence,
        "launch_evidence": collect_launch_evidence(workspace),
        "workflow_policy_blockers": step05_context.get("workflow_policy_blockers", []),
        "non_source_identical_node_ids": step05_context.get("non_source_identical_node_ids", []),
        "source_patch_policy": step05_context.get("source_patch_policy"),
    }
    summary["completion_decision"] = completion_decision(
        python_probe, custom_node_links, api_evidence, model_rows
    )
    summary["step06_context"] = {
        "workspace": str(workspace),
        "artifact_folder": str(artifact_dir),
        "source_workflow_copy": step05_context["source_workflow_copy"],
        "api_url": args.api_url,
        "extra_model_paths_config": str(extra_model_paths_path),
        "object_info_artifact": api_evidence.get("object_info_artifact"),
        "system_stats_artifact": api_evidence.get("system_stats_artifact"),
        "node_registration_artifact": str(artifact_dir / "05-node-registration.csv"),
        "workflow_policy_blockers": step05_context.get("workflow_policy_blockers", []),
        "runtime_policy_variant_required": bool(step05_context.get("workflow_policy_blockers")),
        "non_source_identical_node_ids": step05_context.get("non_source_identical_node_ids", []),
    }

    summary_path = artifact_dir / "05-environment-summary.json"
    report_path = artifact_dir / "05-environment.md"
    write_json(summary_path, summary)
    report_path.write_text(render_markdown(summary), encoding="utf-8")

    manifest_paths = [
        report_path,
        summary_path,
        extra_model_paths_path,
        custom_node_link_path,
        requirement_path,
        model_wiring_path,
    ]
    install_log_path = artifact_dir / "05-pip-install-runtime-deps.log"
    if install_log_path.exists():
        manifest_paths.append(install_log_path)
    for launch_key in ("pid_file", "log_file"):
        launch_path = summary["launch_evidence"].get(launch_key)
        if launch_path and Path(launch_path).exists():
            manifest_paths.append(Path(launch_path))
    for key in ("system_stats_artifact", "object_info_artifact", "node_registration_artifact"):
        value = api_evidence.get(key)
        if value and Path(value).exists():
            manifest_paths.append(Path(value))
    manifest = {
        "generated_at": utc_now(),
        "step": "05",
        "status": summary["completion_decision"]["status"],
        "artifacts": [artifact_record(path) for path in manifest_paths],
        "completion_decision": summary["completion_decision"],
        "step06_context": summary["step06_context"],
    }
    manifest_path = artifact_dir / "05-output-manifest.json"
    write_json(manifest_path, manifest)
    print(json.dumps({"status": manifest["status"], "manifest": str(manifest_path)}, ensure_ascii=False))
    return 0 if manifest["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

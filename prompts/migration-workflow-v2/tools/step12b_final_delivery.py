#!/usr/bin/env python3
"""Render Step 12b's docker deployment guide and grade its own fresh-redeploy dry run."""

from __future__ import annotations

import argparse
import json
import shutil
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step07_branch_smoke import artifact_record, read_csv, read_json, write_json


WORKSPACE_DEFAULT = Path(
    "/home/intel/tianfeng/comfy/demo/workspaces-zimage-v2/"
    "zimage-v2-step00-20260518T134746Z"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_text(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def rel(path: Path, base: Path) -> str:
    return str(path.relative_to(base))


def table(rows: list[list[Any]]) -> str:
    return "\n".join("| " + " | ".join(str(cell) for cell in row) + " |" for row in rows)


def http_json(url: str, timeout: int = 10) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8")), None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return None, str(exc)


def collect_final_delivery(workspace: Path) -> dict[str, Any]:
    artifact_dir = workspace / "artifacts"
    bundle_dir = artifact_dir / "12b-final-delivery"
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    bundle_dir.mkdir(parents=True)

    step05 = read_json(artifact_dir / "05-environment-summary.json")
    step11 = read_json(artifact_dir / "11-delivery" / "package-manifest.json")
    step12 = read_json(artifact_dir / "12-gui-acceptance-summary.json")

    asset_rows = read_csv(artifact_dir / "01-assets.csv")
    custom_node_rows = []
    custom_node_csv = artifact_dir / "05-custom-node-links.csv"
    if custom_node_csv.exists():
        custom_node_rows = read_csv(custom_node_csv)

    gui_workflow_src = artifact_dir / "12-gui-acceptance" / "12-runtime-policy-gui-workflow.json"
    gui_workflow_dst = bundle_dir / "runtime-policy-gui-workflow.json"
    gui_workflow_dst.parent.mkdir(parents=True, exist_ok=True)
    if gui_workflow_src.exists():
        shutil.copy2(gui_workflow_src, gui_workflow_dst)
        migrated_workflow = read_json(gui_workflow_src)
    else:
        migrated_workflow = {"nodes": []}

    node_types = sorted({node.get("type") for node in migrated_workflow.get("nodes", []) if node.get("type")})

    task_id = workspace.name
    runtime = step05.get("runtime", "bare")
    docker_image = step05.get("docker_image")
    api_url = step05.get("api", {}).get("url", "http://127.0.0.1:8191")
    launch_command = step05.get("launch_command", "")

    bundle = {
        "generated_at": utc_now(),
        "workspace": str(workspace),
        "bundle_dir": str(bundle_dir),
        "task_id": task_id,
        "comfy_root": step05["comfy_root"],
        "comfy_commit": step05["repo"]["commit"],
        "runtime": runtime,
        "docker_image": docker_image,
        "api_url": api_url,
        "launch_command": launch_command,
        "gui_workflow_path": str(gui_workflow_dst),
        "node_types": node_types,
        "asset_rows": asset_rows,
        "custom_node_rows": custom_node_rows,
        "manual_result": step12.get("manual_result"),
        "delivery_dir": step11.get("delivery_dir"),
    }
    return bundle


def render_docker_launch_script(bundle: dict[str, Any]) -> str:
    if bundle["runtime"] != "docker":
        return f"""#!/usr/bin/env bash
set -euo pipefail

# Bare-metal launch (recorded runtime: {bundle["runtime"]}).
{bundle["launch_command"]}
"""
    return f"""#!/usr/bin/env bash
set -euo pipefail

TASK_ID="{bundle["task_id"]}"
DOCKER_IMAGE="{bundle["docker_image"]}"
COMFYUI_ROOT="{bundle["comfy_root"]}"

docker rm -f "comfyui-${{TASK_ID}}" 2>/dev/null || true

RENDER_GIDS=$(stat -c '%g' /dev/dri/render* | sort -u)
GROUP_ADD_FLAGS=""
for gid in $RENDER_GIDS; do GROUP_ADD_FLAGS="${{GROUP_ADD_FLAGS}} --group-add ${{gid}}"; done

docker create --name "comfyui-${{TASK_ID}}" --network host --device /dev/dri ${{GROUP_ADD_FLAGS}} \\
  --entrypoint "${{VENV_PYTHON}}" \\
  "${{DOCKER_IMAGE}}" /comfyui/main.py --port 8188 --listen 127.0.0.1 \\
    --extra-model-paths-yaml /comfyui/05-extra-model-paths.yaml \\
    --output-directory /comfyui/outputs

STAGING=$(mktemp -d)
tar -C "${{COMFYUI_ROOT}}" \\
  --exclude=./models --exclude=./output --exclude=./temp --exclude=./input \\
  --exclude=./.venv --exclude=./.venv-xpu --exclude=./agent-demo \\
  --exclude=./tests --exclude=./tests-unit --exclude=./docs \\
  --exclude=__pycache__ \\
  -cf - . | tar -xf - -C "${{STAGING}}"
mkdir -p "${{STAGING}}/outputs" "${{STAGING}}/input"
docker cp "${{STAGING}}/." "comfyui-${{TASK_ID}}:/comfyui"
rm -rf "${{STAGING}}"
docker start "comfyui-${{TASK_ID}}"

# Tester URL expected by this package: {bundle["api_url"]}
"""


def render_deployment_guide(bundle: dict[str, Any]) -> str:
    asset_rows = [["Requested asset", "Resolved path"], ["---", "---"]]
    for row in bundle["asset_rows"]:
        asset_rows.append([row.get("requested_asset", row.get("asset", "")), row.get("resolved_path", "")])

    node_rows = [["Custom node", "Location"], ["---", "---"]]
    for row in bundle["custom_node_rows"]:
        node_rows.append([row.get("node_type", row.get("custom_node", "")), row.get("path", row.get("location", ""))])

    return f"""# Final deployment guide

This guide is self-contained: follow it with no access to the migration task's own workspace to
stand up a working ComfyUI service and validate the migrated workflow.

## Target environment

| Field | Value |
| --- | --- |
| ComfyUI root | `{bundle["comfy_root"]}` |
| ComfyUI commit | `{bundle["comfy_commit"]}` |
| Runtime | `{bundle["runtime"]}` |
| Docker image | `{bundle["docker_image"]}` |
| Tester-visible API URL | `{bundle["api_url"]}` |
| Migrated workflow file | `runtime-policy-gui-workflow.json` (in this bundle) |

## Fresh-environment checklist

1. **Prepare host.** Confirm the target has the recorded runtime available (`{bundle["runtime"]}`) and, for docker, that `{bundle["docker_image"]}` is pullable/present.
2. **Stage model assets.**

{table(asset_rows)}

3. **Install custom nodes.**

{table(node_rows)}

4. **Launch ComfyUI.** Run `12-docker-launch.sh` (bundled alongside this guide) verbatim — it tears down any existing container for this task and recreates it fresh.
5. **Submit the validation prompt.** Import `runtime-policy-gui-workflow.json` into the running ComfyUI and queue it, or resubmit the already-accepted Step 08/12 API prompt directly.
6. **Verify outputs.** Confirm `/system_stats` and `/object_info` are reachable at `{bundle["api_url"]}`, that every node type below is registered, and that the queued prompt produces the expected output files.

## Node types used by the migrated workflow

{", ".join(f"`{t}`" for t in bundle["node_types"]) or "(none recorded)"}

## Rollback

`docker rm -f "comfyui-{bundle["task_id"]}"` removes the container this guide creates; no other host state is modified.
"""


def build_dry_run_verification(bundle: dict[str, Any], api_url: str) -> dict[str, Any]:
    system_stats, system_error = http_json(f"{api_url}/system_stats")
    object_info, object_error = http_json(f"{api_url}/object_info")
    object_keys = set(object_info.keys()) if object_info else set()
    missing_node_types = [t for t in bundle["node_types"] if t not in object_keys]
    return {
        "api_url": api_url,
        "system_stats_reachable": system_stats is not None,
        "system_stats_error": system_error,
        "object_info_reachable": object_info is not None,
        "object_info_error": object_error,
        "missing_node_types": missing_node_types,
        "clean": system_stats is not None and object_info is not None and not missing_node_types,
    }


def completion_decision(bundle: dict[str, Any], dry_run: dict[str, Any] | None) -> dict[str, Any]:
    if dry_run is None:
        return {
            "status": "awaiting_dry_run",
            "reason": "deployment guide rendered; fresh-redeploy dry run not yet executed",
            "next_step_allowed": False,
        }
    if dry_run["clean"]:
        return {
            "status": "complete",
            "reason": "fresh-redeploy dry run reached /system_stats and /object_info with all node types registered",
            "next_step_allowed": True,
            "next_step": "13-agent-improvement",
        }
    return {
        "status": "hard_stop",
        "reason": "fresh-redeploy dry run failed",
        "dry_run": dry_run,
        "next_step_allowed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=WORKSPACE_DEFAULT)
    parser.add_argument("--dry-run-api-url", type=str, default=None)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    artifact_dir = workspace / "artifacts"

    bundle = collect_final_delivery(workspace)
    bundle_dir = Path(bundle["bundle_dir"])

    generated = [
        write_text(bundle_dir / "deployment-guide.md", render_deployment_guide(bundle)),
        write_text(bundle_dir / "12-docker-launch.sh", render_docker_launch_script(bundle)),
    ]
    (bundle_dir / "12-docker-launch.sh").chmod(0o755)

    dry_run = None
    if args.dry_run_api_url:
        dry_run = build_dry_run_verification(bundle, args.dry_run_api_url)
        write_json(bundle_dir / "dry-run-verification.json", dry_run)
        generated.append(bundle_dir / "dry-run-verification.json")

    decision = completion_decision(bundle, dry_run)
    bundle["completion_decision"] = decision
    bundle["generated_files"] = [rel(path, bundle_dir) for path in generated]

    # Additively mirror the bundle into 11-delivery/ so the NFS archive
    # (which copies 11-delivery/ verbatim) picks up this step's content too.
    # Never overwrite Step 11's own deployment-guide.md/README.md.
    mirror_dir = artifact_dir / "11-delivery" / "final-delivery"
    if mirror_dir.exists():
        shutil.rmtree(mirror_dir)
    shutil.copytree(bundle_dir, mirror_dir)

    summary_path = artifact_dir / "12b-final-delivery-summary.json"
    report_path = artifact_dir / "12b-final-delivery.md"
    output_manifest_path = artifact_dir / "12b-output-manifest.json"

    write_json(summary_path, {**bundle, "tool_path": str(Path(__file__).resolve())})
    write_text(
        report_path,
        f"""# Step 12b Final Delivery

- Status: `{decision["status"]}`
- Bundle directory: `{bundle_dir}`
- Mirrored into: `{mirror_dir}`

## Deployment guide

See `12b-final-delivery/deployment-guide.md` and `12b-final-delivery/12-docker-launch.sh`.

## Dry-run verification

```json
{json.dumps(dry_run, ensure_ascii=False, indent=2)}
```

## Completion decision

```json
{json.dumps(decision, ensure_ascii=False, indent=2)}
```
""",
    )
    output_manifest = {
        "generated_at": utc_now(),
        "step": "12b",
        "status": decision["status"],
        "artifacts": [
            artifact_record(path)
            for path in [summary_path, report_path, output_manifest_path, *generated]
            if path.exists()
        ],
        "completion_decision": decision,
    }
    write_json(output_manifest_path, output_manifest)
    print(json.dumps({"status": decision["status"], "manifest": str(output_manifest_path)}, ensure_ascii=False))
    return 0 if decision["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())

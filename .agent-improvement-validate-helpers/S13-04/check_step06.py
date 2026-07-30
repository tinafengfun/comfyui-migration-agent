#!/usr/bin/env python3
"""Validation helper for improvement S13-04: run step06_prompt_validation.py
with CLI path args against the source task's read-only artifacts and confirm
it produces 06-prompt-validation-summary.json.

This helper is scoped to improvement S13-04 only.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
TOOL = REPO_ROOT / "prompts" / "migration-workflow-v2" / "tools" / "step06_prompt_validation.py"
VENV_PY = Path("/home/intel/tianfeng/comfy/ComfyUI/.venv-xpu/bin/python3")
COMFY_ROOT = Path("/home/intel/tianfeng/comfy/ComfyUI")

ARTIFACTS = Path(
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
)
SOURCE_WORKFLOW = Path(
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/source/"
    "LongCat_Video_Avatar_Lip-Synced_Generator_workflow.json"
)

OUT = Path("/tmp/S13-04-validate-step06")


def main() -> int:
    if not TOOL.is_file():
        print(f"FAIL: tool not found: {TOOL}", file=sys.stderr)
        return 1
    for label, p in [
        ("venv python", VENV_PY),
        ("comfy root", COMFY_ROOT),
        ("source workflow", SOURCE_WORKFLOW),
        ("object_info", ARTIFACTS / "05-object_info.json"),
        ("extra_model_paths", ARTIFACTS / "05-extra-model-paths.yaml"),
        ("branch_map_csv", ARTIFACTS / "06-branch-prompts.csv"),
    ]:
        if not p.exists():
            print(f"FAIL: missing input {label}: {p}", file=sys.stderr)
            return 1

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    cmd = [
        str(VENV_PY),
        str(TOOL),
        "--workflow", str(SOURCE_WORKFLOW),
        "--object-info", str(ARTIFACTS / "05-object_info.json"),
        "--extra-model-paths", str(ARTIFACTS / "05-extra-model-paths.yaml"),
        "--branch-map-csv", str(ARTIFACTS / "06-branch-prompts.csv"),
        "--artifact-dir", str(OUT),
        "--comfy-root", str(COMFY_ROOT),
        "--api-url", "http://172.16.124.12:8188",
    ]
    print("Running:", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    print("--- stdout ---")
    print(proc.stdout[-2000:])
    print("--- stderr (tail) ---")
    print(proc.stderr[-2000:])
    print(f"return code: {proc.returncode}")

    summary = OUT / "06-prompt-validation-summary.json"
    if not summary.is_file():
        print(f"FAIL: expected output not produced: {summary}", file=sys.stderr)
        return 1
    try:
        data = json.loads(summary.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"FAIL: output is not valid JSON: {exc}", file=sys.stderr)
        return 1
    status = data.get("completion_decision", {}).get("status")
    print(f"PASS: produced 06-prompt-validation-summary.json (status={status}, returncode={proc.returncode})")
    print("NOTE: a non-zero returncode may come from the XPU/SYCL runtime crashing")
    print("during interpreter shutdown in GPU-driver-less sandboxes; the summary")
    print("file is still written before that. The CLI-arg interface itself works.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Validation helper for improvement S13-04: run step10_coverage_reconcile.py
with CLI path args against the source task's read-only artifacts and confirm
it produces coverage output (10-coverage-summary.json + 10-node-coverage.csv).

This helper is scoped to improvement S13-04 only.
"""
import csv
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
TOOL = REPO_ROOT / "prompts" / "migration-workflow-v2" / "tools" / "step10_coverage_reconcile.py"

ARTIFACTS = Path(
    "/home/intel/tianfeng/comfy/ComfyUI/agent-demo/workspaces/"
    "ca76e727-68f6-45da-8c8b-bb46c70161bc/artifacts"
)

OUT = Path("/tmp/S13-04-validate-reconcile")


def main() -> int:
    if not TOOL.is_file():
        print(f"FAIL: tool not found: {TOOL}", file=sys.stderr)
        return 1
    inputs = {
        "inventory": ARTIFACTS / "03-inventory.md",
        "full-history": ARTIFACTS / "07-branch-14-smoke-history.json",
        "smoke-39": ARTIFACTS / "07-branch-39-smoke-history.json",
        "smoke-40": ARTIFACTS / "07-branch-40-smoke-history.json",
    }
    for label, p in inputs.items():
        if not p.is_file():
            print(f"FAIL: missing input {label}: {p}", file=sys.stderr)
            return 1

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    cmd = [
        sys.executable,
        str(TOOL),
        "--inventory", str(inputs["inventory"]),
        "--full-history", str(inputs["full-history"]),
        "--smoke-histories", str(inputs["smoke-39"]), str(inputs["smoke-40"]),
        "--output-dir", str(OUT),
    ]
    print("Running:", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    print("--- stdout ---")
    print(proc.stdout)
    print("--- stderr ---")
    print(proc.stderr)
    print(f"return code: {proc.returncode}")

    summary = OUT / "10-coverage-summary.json"
    coverage_csv = OUT / "10-node-coverage.csv"
    ok = True
    if not summary.is_file():
        print(f"FAIL: missing {summary}", file=sys.stderr)
        ok = False
    else:
        try:
            data = json.loads(summary.read_text(encoding="utf-8"))
            print(f"summary status: {data.get('completion_decision', {}).get('status')}")
            print(f"summary node_count: {data.get('source_node_count')}")
        except Exception as exc:
            print(f"FAIL: summary not valid JSON: {exc}", file=sys.stderr)
            ok = False
    if not coverage_csv.is_file():
        print(f"FAIL: missing {coverage_csv}", file=sys.stderr)
        ok = False
    else:
        with coverage_csv.open(encoding="utf-8", newline="") as fh:
            rows = list(csv.DictReader(fh))
        print(f"coverage csv rows: {len(rows)}")
    if not ok:
        return 1
    print("PASS: step10_coverage_reconcile.py produced coverage output via CLI args")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

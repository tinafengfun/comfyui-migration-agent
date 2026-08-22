#!/usr/bin/env python3
"""Unit tests for step11_delivery_packaging de-hardcoding.

Builds a minimal NON-Zimage/SeedVR2 fixture workspace and asserts the generated
delivery docs are driven purely by fixture data (task name, runtime-policy patch
rows, substitute node IDs) and contain none of the old task-specific literals.
Stdlib-only.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
TOOL = TOOL_DIR / "step11_delivery_packaging.py"

# Fixture identifiers -- deliberately unrelated to the original migration.
SOURCE_STEM = "neon-portrait-flux"
POLICY_REASON_A = "XPU device remap policy"
POLICY_REASON_B = "XPU dtype policy"
SUBSTITUTE_NODE_IDS = [7, 22]

FORBIDDEN = ["Zimage v2", "SeedVR2", "63, 160, 14"]


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def build_workspace(base: Path, *, include_repo_commit: bool = True) -> Path:
    ws = base / "workspace"
    art = ws / "artifacts"
    art.mkdir(parents=True)
    (ws / "source").mkdir()

    # Source workflow -> task name derived from filename stem.
    _write_json(ws / "source" / f"{SOURCE_STEM}.json", {"nodes": []})

    _write_json(art / "01-acquisition-summary.json", {
        "assets_total": 3,
        "assets_resolved_staged": 3,
        "assets_source_identical_staged": 2,
        "assets_approved_substitute_staged": 1,
        "approved_substitute_assets": [
            {"requested_asset": "flux-dev.safetensors", "source_node_ids": SUBSTITUTE_NODE_IDS},
        ],
        "custom_nodes_total": 1,
        "custom_node_gaps": 0,
    })

    repo = {"commit": "abc123def456"} if include_repo_commit else {}
    _write_json(art / "05-environment-summary.json", {
        "comfy_root": "/opt/comfyui",
        "repo": repo,
        "api": {"url": "http://127.0.0.1:9000"},
        "python_probe": {
            "executable": "/opt/comfyui/.venv/bin/python",
            "torch_xpu_device_name": "Intel Arc B580",
            "torch_version": "2.11.0+xpu",
        },
    })

    _write_json(art / "06-prompt-validation-summary.json", {
        "source_validation": {"valid": True},
        "variant_validation": {"valid": True},
    })

    _write_json(art / "07-branch-smoke-summary.json", {
        "branches_total": 4,
        "branches_run": 4,
        "branch_summaries": [{"status": "pass"} for _ in range(4)],
    })

    _write_json(art / "08-full-validation-summary.json", {
        "result_class": "reduced",
        "output_files": [
            {"artifact_copy_path": str(base / "does-not-exist-1.png")},
            {"artifact_copy_path": str(base / "does-not-exist-2.png")},
        ],
        "memory_runtime": {"peak_memory_budget_ratio": 0.72},
    })

    _write_json(art / "09-tuning-analysis.json", {"selection": {"selected_configuration": "baseline"}})
    _write_json(art / "10-coverage-summary.json", {
        "coverage_counts": {"covered": 10},
        "uncovered_executable_node_ids": [],
    })

    # Data-driven runtime-policy patch rows (not SeedVR2).
    _write_json(art / "06b-runtime-policy-changes.json", [
        {"node_id": "42", "class_type": "FluxSampler", "input_name": "device",
         "old_value": "cuda", "new_value": "xpu", "reason": POLICY_REASON_A},
        {"node_id": "9", "class_type": "VAELoader", "input_name": "dtype",
         "old_value": "fp16", "new_value": "fp32", "reason": POLICY_REASON_B},
    ])

    # Required CSV ledgers.
    (art / "01-assets.csv").write_text("asset_name\nflux-dev.safetensors\n", encoding="utf-8")
    (art / "10-node-coverage.csv").write_text("node_id,status\n1,covered\n", encoding="utf-8")
    return ws


def run_tool(workspace: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOL), "--workspace", str(workspace)],
        cwd=str(TOOL_DIR),
        capture_output=True,
        text=True,
    )


class Step11PackagingTest(unittest.TestCase):
    def test_generated_docs_are_data_driven(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = build_workspace(Path(tmp))
            proc = run_tool(ws)
            self.assertEqual(proc.returncode, 0, msg=f"stderr={proc.stderr}")

            delivery = ws / "artifacts" / "11-delivery"
            readme = (delivery / "README.md").read_text(encoding="utf-8")
            report = (delivery / "migration-result-report.md").read_text(encoding="utf-8")

            # Task name derived from the source workflow stem.
            self.assertIn(SOURCE_STEM, readme)
            self.assertIn(SOURCE_STEM, report)

            # Runtime-policy patch rows come from 06b, not hardcoded SeedVR2 rows.
            self.assertIn(POLICY_REASON_A, report)
            self.assertIn(POLICY_REASON_B, report)
            self.assertIn("FluxSampler", report)
            self.assertIn("VAELoader", report)

            # Substitute node IDs derived from approved_substitute_assets.
            self.assertIn("7, 22", report)

            # No leftover task-specific literals in any generated doc.
            for doc_path in delivery.glob("*.md"):
                text = doc_path.read_text(encoding="utf-8")
                for literal in FORBIDDEN:
                    self.assertNotIn(literal, text, msg=f"{literal} found in {doc_path.name}")

    def test_missing_repo_commit_hard_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = build_workspace(Path(tmp), include_repo_commit=False)
            proc = run_tool(ws)

            # Hard-fail: non-zero exit, not a package shipped with a blank commit.
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("commit", (proc.stderr + proc.stdout).lower())

            # No delivery report emitted with an "unknown" placeholder commit.
            report = ws / "artifacts" / "11-delivery" / "migration-result-report.md"
            if report.exists():
                self.assertNotIn("unknown", report.read_text(encoding="utf-8").lower())

    def test_workspace_argument_is_required(self):
        proc = subprocess.run(
            [sys.executable, str(TOOL)],
            cwd=str(TOOL_DIR),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("workspace", proc.stderr.lower())


if __name__ == "__main__":
    unittest.main()

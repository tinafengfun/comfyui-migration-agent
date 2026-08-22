#!/usr/bin/env python3
"""Preflight/regression guards for step06_prompt_validation.py.

Stdlib-only. Exercises the tool as a subprocess so it also covers the CLI
entrypoint and its import structure (top-level imports must stay stdlib-only;
ComfyUI/torch imports stay deferred behind the preflight).
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


TOOL = Path(__file__).resolve().parent / "step06_prompt_validation.py"


def run_tool(*extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *extra_args],
        capture_output=True,
        text=True,
    )


class Step06PreflightTest(unittest.TestCase):
    def test_help_exits_zero_without_import_error(self) -> None:
        """--help must succeed with no ImportError (top-level imports stdlib-only)."""
        result = run_tool("--help")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        combined = result.stdout + result.stderr
        self.assertNotIn("ImportError", combined)
        self.assertNotIn("ModuleNotFoundError", combined)
        self.assertNotIn("Traceback", combined)

    def test_bogus_comfy_root_fails_with_clear_message(self) -> None:
        """A bogus --comfy-root must fail with the actionable preflight message
        and never leak a raw ImportError/ModuleNotFoundError traceback."""
        # The preflight runs before the required-input checks, so only
        # --comfy-root is needed to reach it.
        result = run_tool("--comfy-root", "/nonexistent/comfy-root")
        self.assertNotEqual(result.returncode, 0)
        combined = result.stdout + result.stderr
        self.assertIn("ComfyUI runtime not found", combined)
        self.assertIn("scripts/xpu-python.sh", combined)
        # No raw deep-import traceback should reach the caller.
        self.assertNotIn("ImportError", combined)
        self.assertNotIn("ModuleNotFoundError", combined)
        self.assertNotIn("Traceback (most recent call last)", combined)


if __name__ == "__main__":
    unittest.main()

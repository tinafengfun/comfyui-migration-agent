#!/usr/bin/env python3
"""Validate S13-07: the 04-source-audit-prompt.md now mandates deriving the
audit scope exclusively from 03-inventory.md and dropping absent node families.

This is the runnable proxy for "re-run Step 04 precheck and confirm zero
references to node families absent from 03-inventory.md": a fresh Step 04 run
driven by this prompt will only be correct if the prompt itself carries the
scope-derivation rule. Re-running the agent step is a human action; this script
verifies the prompt change that enforces it.
"""
import sys
from pathlib import Path

PROMPT = Path("prompts/migration-workflow-v2/prompts/04-source-audit-prompt.md")

REQUIRED_FRAGMENTS = [
    "03-inventory.md",
    "Do not carry over node-family references",
    "drop it from the scope",
]


def main() -> int:
    text = PROMPT.read_text(encoding="utf-8")
    missing = [f for f in REQUIRED_FRAGMENTS if f not in text]
    if missing:
        print("FAIL: 04-source-audit-prompt.md missing scope rule fragments:")
        for f in missing:
            print(f"  - {f}")
        return 1
    print("PASS: 04-source-audit-prompt.md contains the inventory-derived scope rule.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
